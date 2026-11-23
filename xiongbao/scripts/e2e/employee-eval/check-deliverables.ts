/**
 * 判分：交付题组（七种交付物各一道）。员工把产物写在题目目录下约定的文件名里，这里只在本机判「文件对不对」：
 *
 * - `deliv-pptx`：`deck.pptx` 能被 python-pptx 打开，页数不少于 5；
 * - `deliv-docx`：`report.docx` 能被 python-docx 打开，标题样式的段落含指定的三个标题；
 * - `deliv-xlsx`：`budget.xlsx` 表头对、金额列是公式、公式缓存值（`data_only=True`）等于金标；
 * - `deliv-web`：`site/index.html` 在，页面引用的相对路径资源都在；
 * - `deliv-app`：`app/` 下服务脚本和 `index.html` 在，交付里有带端口的 `app` 项（交付清单由调用方传入，
 *   首页能不能打开、增删能不能用由服务器侧另判）；
 * - `deliv-image`：`cover.png` 魔数是 PNG，宽高都大于 0；
 * - `deliv-video`：`intro.mp4` 用 ffprobe 读到 1–30 秒且有视频流。
 *
 * Office 三题靠 python（`python3 -I`，免得目录里的同名文件被当成模块），图片在 TS 里直接读文件头，视频靠 ffprobe。
 * 缺依赖时对应的检查项不通过并写明缺什么，不会抛错。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type Check, check, readText, result, runCheckCli } from "./lib";

export const PPTX_FILE = "deck.pptx";
export const PPTX_MIN_SLIDES = 5;
export const DOCX_FILE = "report.docx";
export const DOCX_HEADINGS = ["项目周报", "本周进展", "下周计划"] as const;
export const XLSX_FILE = "budget.xlsx";
export const XLSX_HEADER = ["项目", "单价", "数量", "金额"] as const;
/** 金标：金额列 D2–D5 公式算出来的值（三项各自的金额和合计）。 */
export const XLSX_GOLD = { D2: 300, D3: 200, D4: 1600, D5: 2100 } as const;
export const WEB_INDEX = "site/index.html";
export const APP_DIR = "app";
export const APP_SERVER_NAMES = [
  "server.js",
  "server.ts",
  "server.mjs",
  "server.py",
] as const;
export const IMAGE_FILE = "cover.png";
export const VIDEO_FILE = "intro.mp4";
export const VIDEO_SECONDS = { min: 1, max: 30 } as const;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Probe = { ok: boolean; detail: string; data?: Record<string, unknown> };

/** 跑一小段 python，脚本最后一行打印 JSON。`-I` 不读当前目录和环境变量里的模块路径。 */
function runPython(script: string, args: string[]): Probe {
  let run: ReturnType<typeof Bun.spawnSync>;
  try {
    run = Bun.spawnSync(["python3", "-I", "-c", script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
  } catch {
    return { ok: false, detail: "本机没有 python3，没法判分" };
  }
  const out = (run.stdout ?? "").toString().trim();
  try {
    const data = JSON.parse(out.split("\n").pop() ?? "") as Record<
      string,
      unknown
    >;
    return {
      ok: data.error === undefined,
      detail: typeof data.error === "string" ? data.error : "",
      data,
    };
  } catch {
    const err = (run.stderr ?? "").toString().trim().split("\n").pop() ?? "";
    return { ok: false, detail: `python 没跑通：${err || "没有输出"}` };
  }
}

// 每段脚本都把「缺依赖」「打不开」翻成 error 字段，调用方只管读 JSON。
const PY_PREAMBLE = `
import json, sys
def fail(msg):
    print(json.dumps({"error": msg}, ensure_ascii=False)); sys.exit(0)
`;

const PPTX_SCRIPT = `${PY_PREAMBLE}
try:
    from pptx import Presentation
except ImportError:
    fail("本机没装 python-pptx")
try:
    prs = Presentation(sys.argv[1])
except Exception as e:
    fail("python-pptx 打不开：%s" % e)
print(json.dumps({"slides": len(prs.slides)}))
`;

const DOCX_SCRIPT = `${PY_PREAMBLE}
try:
    import docx
except ImportError:
    fail("本机没装 python-docx")
try:
    doc = docx.Document(sys.argv[1])
except Exception as e:
    fail("python-docx 打不开：%s" % e)
heads = []
for p in doc.paragraphs:
    name = (p.style.name if p.style is not None else "") or ""
    if name.startswith("Heading") or name == "Title" or name.startswith("标题"):
        heads.append(p.text.strip())
print(json.dumps({"headings": heads}, ensure_ascii=False))
`;

const XLSX_SCRIPT = `${PY_PREAMBLE}
try:
    import openpyxl
except ImportError:
    fail("本机没装 openpyxl")
try:
    formulas = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
    values = openpyxl.load_workbook(sys.argv[1], data_only=True).worksheets[0]
except Exception as e:
    fail("openpyxl 打不开：%s" % e)
cells = ["D2", "D3", "D4", "D5"]
print(json.dumps({
    "header": [str(c.value) if c.value is not None else "" for c in formulas[1][:4]],
    "formulas": {c: (formulas[c].value if isinstance(formulas[c].value, str) and formulas[c].value.startswith("=") else None) for c in cells},
    "cached": {c: values[c].value for c in cells},
}, ensure_ascii=False))
`;

function fileExists(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

function presence(dir: string, name: string): Check {
  const ok = fileExists(dir, name);
  return check(`${name} 存在`, ok, ok ? "" : `没有 ${name}`);
}

export function checkDelivPptx(dir: string) {
  const present = presence(dir, PPTX_FILE);
  const checks: Check[] = [present];
  const probe = present.ok
    ? runPython(PPTX_SCRIPT, [join(dir, PPTX_FILE)])
    : null;
  checks.push(
    check(
      "python-pptx 能打开",
      probe?.ok === true,
      probe ? probe.detail : "没有文件",
    ),
  );
  const slides = Number(probe?.data?.slides ?? 0);
  checks.push(
    check(
      `页数不少于 ${PPTX_MIN_SLIDES} 页`,
      probe?.ok === true && slides >= PPTX_MIN_SLIDES,
      probe?.ok ? `实际 ${slides} 页` : "",
    ),
  );
  return result("deliv-pptx", checks);
}

export function checkDelivDocx(dir: string) {
  const present = presence(dir, DOCX_FILE);
  const checks: Check[] = [present];
  const probe = present.ok
    ? runPython(DOCX_SCRIPT, [join(dir, DOCX_FILE)])
    : null;
  checks.push(
    check(
      "python-docx 能打开",
      probe?.ok === true,
      probe ? probe.detail : "没有文件",
    ),
  );
  const headings = (probe?.data?.headings as string[] | undefined) ?? [];
  const missing = DOCX_HEADINGS.filter((title) => !headings.includes(title));
  checks.push(
    check(
      `含标题 ${DOCX_HEADINGS.join("、")}`,
      probe?.ok === true && missing.length === 0,
      probe?.ok
        ? missing.length
          ? `缺：${missing.join("、")}（现有标题：${headings.join("、") || "无"}）`
          : ""
        : "",
    ),
  );
  return result("deliv-docx", checks);
}

export function checkDelivXlsx(dir: string) {
  const present = presence(dir, XLSX_FILE);
  const checks: Check[] = [present];
  const probe = present.ok
    ? runPython(XLSX_SCRIPT, [join(dir, XLSX_FILE)])
    : null;
  checks.push(
    check(
      "openpyxl 能打开",
      probe?.ok === true,
      probe ? probe.detail : "没有文件",
    ),
  );
  const data = probe?.ok ? probe.data : undefined;
  const header = (data?.header as string[] | undefined) ?? [];
  checks.push(
    check(
      `表头是 ${XLSX_HEADER.join(",")}`,
      JSON.stringify(header) === JSON.stringify(XLSX_HEADER),
      data ? `表头：${header.join(",") || "（空）"}` : "",
    ),
  );
  const formulas = (data?.formulas as Record<string, string | null>) ?? {};
  const cells = Object.keys(XLSX_GOLD) as (keyof typeof XLSX_GOLD)[];
  const notFormula = cells.filter((cell) => !formulas[cell]);
  checks.push(
    check(
      "金额列（D2–D5）是公式",
      data !== undefined && notFormula.length === 0,
      data && notFormula.length ? `不是公式：${notFormula.join("、")}` : "",
    ),
  );
  const cached = (data?.cached as Record<string, unknown>) ?? {};
  const wrong = cells.filter(
    (cell) =>
      typeof cached[cell] !== "number" ||
      Math.abs((cached[cell] as number) - XLSX_GOLD[cell]) > 1e-9,
  );
  checks.push(
    check(
      "公式缓存值等于金标",
      data !== undefined && wrong.length === 0,
      data && wrong.length
        ? wrong
            .map(
              (cell) =>
                `${cell} 缓存值 ${JSON.stringify(cached[cell] ?? null)}，应为 ${XLSX_GOLD[cell]}`,
            )
            .join("；")
        : "",
    ),
  );
  return result("deliv-xlsx", checks);
}

/**
 * HTML 里 src/href 引用的本地路径：先去掉注释和 script/style 的内容（内联 JS 里的 `img.src = url` 不是引用），
 * 再只在标签里取属性（属性名前要是空白，`data-src`、`xlink:href` 不算）；跳过网址、data:、mailto:、javascript:、
 * 锚点，去掉查询串和片段，百分号编码先解开（解不开用原样）。
 */
export function localRefs(html: string): string[] {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (whole) =>
      whole.slice(0, whole.indexOf(">") + 1),
    );
  const refs = new Set<string>();
  for (const tag of stripped.matchAll(/<[a-z][^>]*>/gi)) {
    for (const match of tag[0].matchAll(
      /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!raw || raw.startsWith("#")) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
      const path = raw.split(/[?#]/)[0];
      if (!path) continue;
      try {
        refs.add(decodeURIComponent(path));
      } catch {
        refs.add(path);
      }
    }
  }
  return [...refs];
}

export function checkDelivWeb(dir: string) {
  const html = readText(join(dir, WEB_INDEX));
  const checks: Check[] = [
    check(
      `${WEB_INDEX} 存在`,
      html !== null,
      html === null ? `没有 ${WEB_INDEX}` : "",
    ),
  ];
  const visible = (html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
  checks.push(check("页面有可见文字", visible.length > 0));
  const root = resolve(dir, dirname(WEB_INDEX));
  const missing = localRefs(html ?? "").filter((ref) => {
    // 以 / 开头的路径在静态站里指站点根，也按 site/ 内找；跳出 site/ 的不算数。
    const target = resolve(root, ref.replace(/^\/+/, ""));
    return !(
      (target === root || target.startsWith(root + sep)) &&
      existsSync(target)
    );
  });
  checks.push(
    check(
      "引用的相对资源都在",
      html !== null && missing.length === 0,
      missing.length ? `找不到：${missing.slice(0, 5).join("、")}` : "",
    ),
  );
  return result("deliv-web", checks);
}

/** 交付清单里的一项（只看判分用得到的字段）。 */
export type DelivItem = { kind: string; port?: number };

export function checkDelivApp(dir: string, deliveries?: readonly DelivItem[]) {
  const appDir = join(dir, APP_DIR);
  const names = existsSync(appDir) ? readdirSync(appDir) : [];
  const server = APP_SERVER_NAMES.find((name) => names.includes(name));
  const checks: Check[] = [
    check(
      "服务脚本在",
      server !== undefined,
      server ? server : `${APP_DIR}/ 下没有 ${APP_SERVER_NAMES.join("、")}`,
    ),
    presence(dir, `${APP_DIR}/index.html`),
  ];
  const app = deliveries?.find((item) => item.kind === "app");
  const port = app?.port;
  checks.push(
    check(
      "交付里有 app 项且写了端口",
      Number.isInteger(port) &&
        (port as number) > 0 &&
        (port as number) < 65536,
      deliveries === undefined
        ? "没有拿到交付清单"
        : app
          ? `端口：${port ?? "未写"}`
          : "交付里没有 app 项",
    ),
  );
  return result("deliv-app", checks);
}

/** PNG 文件头：8 字节魔数、IHDR 块里的宽高（大端 4 字节）。读不出返回 null。 */
export function pngSize(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function checkDelivImage(dir: string) {
  const present = presence(dir, IMAGE_FILE);
  const checks: Check[] = [present];
  const bytes = present.ok ? readFileSync(join(dir, IMAGE_FILE)) : null;
  const isPng = bytes?.subarray(0, 8).equals(PNG_MAGIC) === true;
  checks.push(
    check(
      "文件头是 PNG 魔数",
      isPng,
      bytes && !isPng
        ? `文件头：${bytes.subarray(0, 8).toString("hex") || "（空文件）"}`
        : "",
    ),
  );
  const size = bytes ? pngSize(bytes) : null;
  checks.push(
    check(
      "宽高都大于 0",
      size !== null && size.width > 0 && size.height > 0,
      size ? `${size.width}×${size.height}` : isPng ? "读不出宽高" : "",
    ),
  );
  return result("deliv-image", checks);
}

export function checkDelivVideo(dir: string) {
  const present = presence(dir, VIDEO_FILE);
  const checks: Check[] = [present];
  let probe: { duration: number | null; video: boolean } | null = null;
  let problem = present.ok ? "" : "没有文件";
  if (present.ok) {
    try {
      const run = Bun.spawnSync(
        [
          "ffprobe",
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type",
          "-of",
          "json",
          join(dir, VIDEO_FILE),
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      if (run.exitCode !== 0)
        problem = `ffprobe 读不了：${run.stderr.toString().trim().split("\n")[0] ?? ""}`;
      else {
        const info = JSON.parse(run.stdout.toString()) as {
          format?: { duration?: string };
          streams?: { codec_type?: string }[];
        };
        const seconds = Number.parseFloat(info.format?.duration ?? "");
        probe = {
          duration: Number.isFinite(seconds) ? seconds : null,
          video: (info.streams ?? []).some((s) => s.codec_type === "video"),
        };
      }
    } catch {
      problem = "本机没有 ffprobe，没法判分";
    }
  }
  checks.push(check("ffprobe 能读", probe !== null, problem));
  const seconds = probe?.duration ?? null;
  checks.push(
    check(
      `时长 ${VIDEO_SECONDS.min}–${VIDEO_SECONDS.max} 秒`,
      seconds !== null &&
        seconds >= VIDEO_SECONDS.min &&
        seconds <= VIDEO_SECONDS.max,
      probe
        ? `实际 ${seconds === null ? "未知" : `${seconds.toFixed(2)} 秒`}`
        : "",
    ),
  );
  checks.push(check("有视频流", probe?.video === true));
  return result("deliv-video", checks);
}

if (import.meta.main) {
  const which = process.argv[2];
  const run = {
    pptx: checkDelivPptx,
    docx: checkDelivDocx,
    xlsx: checkDelivXlsx,
    web: checkDelivWeb,
    app: (dir: string) => checkDelivApp(dir),
    image: checkDelivImage,
    video: checkDelivVideo,
  }[which ?? ""];
  if (!run) {
    console.error(
      "用法：bun check-deliverables.ts <pptx|docx|xlsx|web|app|image|video> <做完后的目录>",
    );
    process.exit(2);
  }
  process.argv.splice(2, 1);
  await runCheckCli(`deliv-${which}`, run);
}
