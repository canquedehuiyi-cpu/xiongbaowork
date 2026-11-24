/**
 * 熊宝现有抓取（web_fetch 用的那几个模块函数）与 Firecrawl Local 的抓取质量对比。
 *
 * 只抓本机 127.0.0.1 上自己起的测试页，不碰互联网。用法见 README.md：
 *   bun scripts/research/firecrawl-compare/compare.ts run [--runs 5] [--firecrawl <二进制路径>]
 *   bun scripts/research/firecrawl-compare/compare.ts rescore      # 只用已存的输出重算分数
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractReadable } from "../../../server/src/web/extract";
import {
  decodeBody,
  fetchPublicPage,
  pageKind,
} from "../../../server/src/web/fetch-page";
import { listInterfaces, onlyLoopback } from "./isolation";
import { buildPages, type TestPage } from "./pages";
import { median, type PageScore, scoreOutput } from "./score";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
const outputsDir = join(resultsDir, "outputs");

type ToolId = "xiongbao-web-fetch" | "firecrawl-local";

type ToolRun = {
  status: "ok" | "failed" | "not-returned";
  /** 失败或没返回内容的原因，原样记录。 */
  note?: string;
  score: PageScore;
  /** 每次运行的耗时（毫秒）。 */
  timingsMs: number[];
  medianMs: number;
};

type Results = {
  generatedAt: string;
  runs: number;
  firecrawl: {
    available: boolean;
    version?: string;
    sha256?: string;
    reason?: string;
  };
  pages: Record<
    string,
    { label: string; tools: Partial<Record<ToolId, ToolRun>> }
  >;
};

/** 测试页的本机服务器。端口由系统分配，只监听 127.0.0.1。 */
function serve(pages: TestPage[], files: Map<string, Uint8Array<ArrayBuffer>>) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const page = pages.find((item) => item.path === path);
      const body = files.get(path);
      if (!page || !body) return new Response("not found", { status: 404 });
      return new Response(body, {
        headers: { "content-type": page.contentType },
      });
    },
  });
}

/** HTML 页直接是字节；PDF 页用本机 LibreOffice 从 HTML 源生成。 */
function renderFiles(pages: TestPage[], workdir: string) {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const encoder = new TextEncoder();
  for (const page of pages) {
    if (!page.asPdf) {
      files.set(page.path, encoder.encode(page.html));
      continue;
    }
    const source = join(workdir, `${page.id}.html`);
    writeFileSync(source, page.html);
    const converted = spawnSync(
      "soffice",
      [
        "--headless",
        `-env:UserInstallation=file://${join(workdir, "lo-profile")}`,
        "--convert-to",
        "pdf:writer_web_pdf_Export",
        "--outdir",
        workdir,
        source,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    const pdf = join(workdir, `${page.id}.pdf`);
    if (!existsSync(pdf))
      throw new Error(`PDF 没生成：${converted.stderr || converted.stdout}`);
    files.set(page.path, new Uint8Array(readFileSync(pdf)));
  }
  return files;
}

const PUBLIC_LOOKUP = async () => [
  { address: "93.184.216.34", family: 4 as const },
];

/**
 * 熊宝现有读网页的链路：fetchPublicPage 取回 -> pageKind 判断 -> decodeBody 解码 -> extractReadable 抽正文。
 * 这四步就是 tools.ts 里 web_fetch 的 describePage 做的事（该函数没导出，所以这里按同样顺序调用导出的部分，
 * 不带最后的字数截断）。
 *
 * fetchPublicPage 会拒绝 127.0.0.1（SSRF 防护，没有放行开关），所以用测试里一贯的办法：地址写成
 * pilot.test、解析器注入一个公网地址，再注入 fetchImpl 把请求改道到本机服务器。校验、重定向、字节上限、
 * 头部都是真实代码在走；唯一的差别是「连的是本机端口」。
 */
async function runWebFetch(
  port: number,
  page: TestPage,
): Promise<{ status: ToolRun["status"]; text: string; note?: string }> {
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    url.hostname = "127.0.0.1";
    return fetch(url, init);
  }) as typeof fetch;
  const fetched = await fetchPublicPage(
    `http://pilot.test:${port}${page.path}`,
    {
      lookup: PUBLIC_LOOKUP,
      viaProxy: () => false,
      fetchImpl,
    },
  );
  const kind = pageKind(fetched.contentType, fetched.body);
  if (kind === "binary")
    return {
      status: "not-returned",
      text: "",
      note: `web_fetch 对二进制内容（${fetched.contentType}）只描述、不返回正文。`,
    };
  const decoded = decodeBody(
    fetched.body,
    fetched.contentType,
    kind === "html",
  );
  const text =
    kind === "html"
      ? (() => {
          const { title, markdown } = extractReadable(decoded, fetched.url);
          return `${title}\n\n${markdown}`;
        })()
      : decoded;
  return { status: "ok", text };
}

/**
 * Firecrawl Local 以外部二进制调用：scrape <url> --markdown。环境变量只给最小集合，并且强制
 * FIRECRAWL_CLOUD=off、不带任何 key，数据不会离开本机。
 */
async function runFirecrawl(
  binary: string,
  url: string,
  home: string,
): Promise<{ status: ToolRun["status"]; text: string; note?: string }> {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1") throw new Error(`只允许抓 127.0.0.1，拒绝 ${url}`);
  // 异步起进程：测试页服务器和本脚本在同一个进程里，同步等待会把服务器一起堵死。
  const child = Bun.spawn([binary, "scrape", url, "--markdown"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      FIRECRAWL_LOCAL_HOME: home,
      FIRECRAWL_CLOUD: "off",
      ...(process.env.FIRECRAWL_CHROME_PATH
        ? { FIRECRAWL_CHROME_PATH: process.env.FIRECRAWL_CHROME_PATH }
        : {}),
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    return {
      status: "failed",
      text: stdout,
      note: `退出码 ${code}：${stderr.trim().slice(0, 400)}`,
    };
  const note = stderr.trim();
  return {
    status: "ok",
    text: stdout,
    ...(note ? { note: note.slice(0, 400) } : {}),
  };
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runAll() {
  const runs = Number(readFlag("--runs") ?? 5);
  const binary = readFlag("--firecrawl") ?? process.env.FIRECRAWL_BIN;
  if (binary && !onlyLoopback(listInterfaces())) {
    console.error(
      "拒绝运行：当前网络里除回环网卡外还有别的网卡。Firecrawl 渲染脚本页时拉起的 Chrome 会自己联网，请改用 isolated.sh：\n  scripts/research/firecrawl-compare/isolated.sh bun scripts/research/firecrawl-compare/compare.ts run --firecrawl <二进制>",
    );
    process.exit(3);
  }
  const pages = buildPages();
  const workdir = mkdtempSync(join(tmpdir(), "firecrawl-compare-"));
  mkdirSync(outputsDir, { recursive: true });
  const results: Results = {
    generatedAt: new Date().toISOString(),
    runs,
    firecrawl:
      binary && existsSync(binary)
        ? { available: true }
        : {
            available: false,
            reason:
              "没有给出可执行的 firecrawl-local 二进制（--firecrawl 或 FIRECRAWL_BIN）。",
          },
    pages: {},
  };
  if (binary && existsSync(binary)) {
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
    results.firecrawl.version = version.stdout.trim();
    results.firecrawl.sha256 = new Bun.CryptoHasher("sha256")
      .update(readFileSync(binary))
      .digest("hex");
  }
  const server = serve(pages, renderFiles(pages, workdir));
  const port = server.port as number;
  try {
    for (const page of pages) {
      const entry: Results["pages"][string] = { label: page.label, tools: {} };
      results.pages[page.id] = entry;
      const tools: ToolId[] = ["xiongbao-web-fetch"];
      if (results.firecrawl.available) tools.push("firecrawl-local");
      for (const tool of tools) {
        const timings: number[] = [];
        let last:
          | { status: ToolRun["status"]; text: string; note?: string }
          | undefined;
        // 第一次运行不计时：给两边都留出一次冷启动（Chrome、模块加载）。
        for (let i = 0; i <= runs; i++) {
          const started = performance.now();
          try {
            last =
              tool === "xiongbao-web-fetch"
                ? await runWebFetch(port, page)
                : await runFirecrawl(
                    binary as string,
                    `http://127.0.0.1:${port}${page.path}`,
                    join(workdir, "fc-home"),
                  );
          } catch (error) {
            last = {
              status: "failed",
              text: "",
              note: String((error as Error).message),
            };
          }
          if (i > 0) timings.push(Math.round(performance.now() - started));
        }
        const final = last as NonNullable<typeof last>;
        writeFileSync(join(outputsDir, `${tool}.${page.id}.md`), final.text);
        entry.tools[tool] = {
          status: final.status,
          ...(final.note ? { note: final.note } : {}),
          score: scoreOutput(final.text, page.truth),
          timingsMs: timings,
          medianMs: median(timings),
        };
      }
    }
  } finally {
    server.stop(true);
    rmSync(workdir, { recursive: true, force: true });
  }
  writeFileSync(
    join(resultsDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(`写入 ${join(resultsDir, "results.json")}`);
}

/** 只用已存的输出文件重新打分，不抓任何东西。 */
function rescore() {
  const path = join(resultsDir, "results.json");
  const results = JSON.parse(readFileSync(path, "utf8")) as Results;
  const pages = buildPages();
  for (const page of pages) {
    const entry = results.pages[page.id];
    if (!entry) continue;
    for (const [tool, run] of Object.entries(entry.tools) as [
      ToolId,
      ToolRun,
    ][]) {
      const text = readFileSync(
        join(outputsDir, `${tool}.${page.id}.md`),
        "utf8",
      );
      run.score = scoreOutput(text, page.truth);
    }
  }
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  console.log("已按存下的输出重算分数");
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "run") await runAll();
  else if (command === "rescore") rescore();
  else {
    console.error(
      "用法：compare.ts run [--runs 5] [--firecrawl <路径>] | rescore",
    );
    process.exit(2);
  }
}
