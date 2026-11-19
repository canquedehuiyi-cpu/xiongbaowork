/**
 * 判分：写文档题。读 `<目录>/README.md`：
 *
 * - `src/index.ts` 导出的每个符号（函数、常量、类型）都在文档里出现；
 * - 文档里的 ts/js 代码块至少一个，逐个抽出来，以真实包名 `tiny-text` 指向夹具里的库，用 `bun build`
 *   编译，全部成功（导入了不存在的导出会编译失败）；
 * - Markdown 没有格式错误。仓库里没有现成的 Markdown lint，这里做基本检查：代码围栏成对、
 *   `#` 标题后有空格、同一张表每行列数一致、没有空链接；
 * - `src/` 和 `package.json` 与夹具一致（题目只让改 README）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Check,
  check,
  fixtureFiles,
  readText,
  result,
  runCheckCli,
  sha256,
} from "./lib";

const PACKAGE = "tiny-text";

/** 一个模块导出的名字（含类型），跟着 `export ... from` 和 `export *` 往下读。 */
export function exportedSymbols(srcDir: string, file = "index.ts"): string[] {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const code = readText(path) ?? readText(`${path}.ts`) ?? "";
    for (const match of code.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
    ))
      names.add(match[1] as string);
    for (const match of code.matchAll(/export\s*(type\s*)?\{([^}]*)\}/g))
      for (const part of (match[2] ?? "").split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name);
      }
    for (const match of code.matchAll(
      /export\s*\*\s*from\s*["'](\.[^"']+)["']/g,
    ))
      visit(join(dirname(path), (match[1] as string).replace(/\.ts$/, "")));
  };
  visit(join(srcDir, file));
  return [...names].sort();
}

export function codeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(
    /^```(ts|typescript|tsx|js|javascript|mjs)\s*\n([\s\S]*?)^```\s*$/gm,
  ))
    blocks.push(match[2] ?? "");
  return blocks;
}

/** 基本的 Markdown 格式问题，一条一句。 */
export function markdownProblems(markdown: string): string[] {
  const problems: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let fence: string | null = null;
  let table: number | null = null;
  lines.forEach((line, index) => {
    const at = `第 ${index + 1} 行`;
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      const mark = opener[1] as string;
      if (fence === null) fence = mark;
      else if (mark.startsWith(fence) && line.trim() === mark) fence = null;
      return;
    }
    if (fence !== null) return;
    if (/^#{1,6}[^#\s]/.test(line)) problems.push(`${at}：标题 # 后没有空格`);
    if (/\[\]\(|\]\(\s*\)/.test(line)) problems.push(`${at}：空链接`);
    if (line.trim().startsWith("|")) {
      const columns = line
        .trim()
        .replace(/\\\|/g, "")
        .replace(/^\||\|$/g, "")
        .split("|").length;
      if (table === null) table = columns;
      else if (columns !== table)
        problems.push(`${at}：表格列数 ${columns}，表头是 ${table}`);
    } else table = null;
  });
  if (fence !== null) problems.push("代码围栏没有闭合");
  return problems;
}

async function compiles(
  blocks: string[],
): Promise<{ ok: boolean; detail: string }> {
  const sandbox = mkdtempSync(join(tmpdir(), "docs-check-"));
  try {
    const library = join(sandbox, "node_modules", PACKAGE);
    mkdirSync(library, { recursive: true });
    // 以夹具里的库为准：示例要对得上真实的库，而不是做题时改过的库。
    for (const [path, contents] of fixtureFiles("docs"))
      if (path === "package.json" || path.startsWith("src/")) {
        mkdirSync(dirname(join(library, path)), { recursive: true });
        writeFileSync(join(library, path), contents);
      }
    const failures: string[] = [];
    for (const [index, block] of blocks.entries()) {
      const entry = join(sandbox, `block-${index + 1}.ts`);
      writeFileSync(entry, block);
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          entry,
          "--target=bun",
          `--outdir=${join(sandbox, "out", String(index + 1))}`,
        ],
        { cwd: sandbox, stdout: "pipe", stderr: "pipe" },
      );
      if (build.exitCode !== 0)
        failures.push(
          `代码块 ${index + 1}：${build.stderr.toString().trim().split("\n").slice(0, 3).join(" ")}`,
        );
    }
    return {
      ok: failures.length === 0,
      detail:
        failures.join("；") || `${blocks.length} 个代码块都能用 bun build 编译`,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export async function checkDocs(dir: string) {
  const readme = readText(join(dir, "README.md"));
  const checks: Check[] = [
    check(
      "README.md 存在",
      readme !== null,
      readme === null ? "没有 README.md" : "",
    ),
  ];
  const markdown = readme ?? "";

  const original = fixtureFiles("docs");
  const changed = [...original.keys()]
    .filter((path) => path === "package.json" || path.startsWith("src/"))
    .filter(
      (path) =>
        sha256(readText(join(dir, path)) ?? "") !==
        sha256(original.get(path) ?? ""),
    );
  checks.push(
    check(
      "src/ 和 package.json 没被改",
      changed.length === 0,
      changed.length ? `改了：${changed.join("、")}` : "",
    ),
  );

  // 以夹具里的源码为准列导出，做题的人改了 src 也骗不过这一条。
  const exportsDir = mkdtempSync(join(tmpdir(), "docs-exports-"));
  let symbols: string[] = [];
  try {
    for (const [path, contents] of original)
      if (path.startsWith("src/")) {
        mkdirSync(dirname(join(exportsDir, path)), { recursive: true });
        writeFileSync(join(exportsDir, path), contents);
      }
    symbols = exportedSymbols(join(exportsDir, "src"));
  } finally {
    rmSync(exportsDir, { recursive: true, force: true });
  }
  const prose = markdown;
  const missing = symbols.filter(
    (name) =>
      !new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(
        prose,
      ),
  );
  checks.push(
    check(
      "每个导出的符号都在文档里出现",
      symbols.length > 0 && missing.length === 0,
      missing.length
        ? `缺：${missing.join("、")}`
        : `${symbols.length} 个导出：${symbols.join("、")}`,
    ),
  );

  const blocks = codeBlocks(markdown);
  if (blocks.length === 0)
    checks.push(
      check("代码块能用 bun build 编译", false, "文档里没有 ts/js 代码块"),
    );
  else {
    const built = await compiles(blocks);
    checks.push(check("代码块能用 bun build 编译", built.ok, built.detail));
  }

  const problems = markdownProblems(markdown);
  checks.push(
    check(
      "Markdown 没有格式错误",
      readme !== null && problems.length === 0,
      problems.slice(0, 5).join("；"),
    ),
  );
  return result("docs", checks);
}

if (import.meta.main) await runCheckCli("docs", checkDocs);
