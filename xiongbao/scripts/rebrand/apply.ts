import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  isSkipped,
  loadProtect,
  type Phase,
  renamePath,
  renameText,
} from "./rename-map";

/*
 * 改名工具：对仓库根下指定路径里 `git ls-files` 的文件改内容并 `git mv` 改名。
 *
 *   bun xiongbao/scripts/rebrand/apply.ts --phase <R1..R4> [--dry-run] [--review-out <文件>] <路径...>
 *
 * 路径一律相对仓库根（`git rev-parse --show-toplevel`），与当前目录无关。标准输出一行 JSON：
 * { files, lines, moved, collisions, review, skippedBinary, errors }。
 * 有任何错误（改名目标已存在）时什么都不改、退出 1。
 */

const PHASES: readonly Phase[] = ["R1", "R2", "R3", "R4"];

/** 工具自己的目录：清单与测试里故意写着旧名，任何阶段都不改。 */
export const TOOL_PATH = "xiongbao/scripts/rebrand/";

export type Report = {
  files: number;
  lines: number;
  moved: number;
  collisions: string[];
  review: number;
  skippedBinary: number;
  errors: string[];
};

const USAGE =
  "用法: bun xiongbao/scripts/rebrand/apply.ts --phase <R1|R2|R3|R4> [--dry-run] [--review-out <文件>] <路径...>";

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

const IDENTIFIER = /(?<![\w$])[A-Za-z_$][\w$]*/g;
const identifiers = (line: string) => new Set(line.match(IDENTIFIER) ?? []);

/** 单独成行的纯字词里出现这些词，说明是代码而不是句子。 */
const CODE_WORD =
  /\b(?:instanceof|typeof|return|import|export|const|let|var|function|new|await|async|class|extends|implements|case|throw|else|in|of)\b/;

/** 一行里的字符串字面量（引号之间的内容）；没闭合的引号不算字面量。 */
function literalSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < line.length; i++) {
    const quote = line[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let j = i + 1;
    for (; j < line.length && line[j] !== quote; j++) if (line[j] === "\\") j++;
    if (j >= line.length) continue;
    spans.push([i + 1, j]);
    i = j;
  }
  return spans;
}

/**
 * `OpenBot` 是否出现在「含空格的字符串字面量」或「JSX 文本」里，也就是界面句子里：
 * 这种地方不该机械改成 XiongBao，而要改走品牌出口，由人工处理。
 */
function inSentence(line: string): boolean {
  // 注释不是界面文案；它们的撇号还会把散文误当成字符串字面量。
  if (/^\s*(?:\/\/|\/\*|\*|#)/.test(line)) return false;
  // 测试名也不是界面文案。
  if (/^\s*(?:test|it|describe)(?:\.\w+)*\(/.test(line)) return false;
  const spans = literalSpans(line);
  for (const match of line.matchAll(/OpenBot/g)) {
    const at = match.index ?? 0;
    if (
      spans.some(([s, e]) => at >= s && at < e && /\s/.test(line.slice(s, e)))
    )
      return true;
    // JSX 文本：同一行里 `>` 与 `<` 之间。
    const before = line.lastIndexOf(">", at);
    const after = line.indexOf("<", at);
    if (before !== -1 && after !== -1) {
      const between = line.slice(before + 1, after);
      if (!/[<>{}]/.test(between) && /\s/.test(between)) return true;
    }
    // 多行 JSX 文本里单独成行的句子：只有字词与标点，没有代码符号。
    if (
      /^\s*[\p{L}\p{N}'’,.:;!?\- ]+$/u.test(line) &&
      /\s\S/.test(line.trim()) &&
      !CODE_WORD.test(line)
    )
      return true;
  }
  return false;
}

function parseArgs(argv: string[]) {
  let phase: Phase | undefined;
  let dryRun = false;
  let reviewOut: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--phase") {
      const value = argv[++i];
      if (!PHASES.includes(value as Phase))
        fail(`--phase 要 ${PHASES.join("|")}\n${USAGE}`);
      phase = value as Phase;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--review-out") {
      reviewOut = argv[++i];
      if (!reviewOut) fail(`--review-out 缺文件名\n${USAGE}`);
    } else if (arg.startsWith("--")) fail(`不认识的参数 ${arg}\n${USAGE}`);
    else paths.push(arg);
  }
  if (!phase) fail(`缺 --phase\n${USAGE}`);
  if (paths.length === 0) fail(`缺路径\n${USAGE}`);
  return { phase: phase as Phase, dryRun, reviewOut, paths };
}

function main() {
  const { phase, dryRun, reviewOut, paths } = parseArgs(process.argv.slice(2));

  let root: string;
  try {
    root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"])
      .stdout.toString()
      .trim();
  } catch {
    root = "";
  }
  if (!root) fail("不在 git 仓库里", 2);

  const pathspecs = paths.map((path) => {
    if (!isAbsolute(path)) return path;
    const inside = relative(root, path);
    if (inside.startsWith("..")) fail(`路径在仓库外：${path}`);
    return inside || ".";
  });
  const listed = git(root, ["ls-files", "-z", "--", ...pathspecs])
    .split("\0")
    .filter(Boolean);

  const protect = loadProtect(phase);
  const report: Report = {
    files: 0,
    lines: 0,
    moved: 0,
    collisions: [],
    review: 0,
    skippedBinary: 0,
    errors: [],
  };

  // 范围内的文件：已被跳过路径与工具目录排除，磁盘上不存在的（已删未提交）也不算。
  const inScope = listed.filter(
    (path) =>
      !isSkipped(path) &&
      !path.startsWith(TOOL_PATH) &&
      existsSync(join(root, path)),
  );

  const before = new Set<string>();
  const produced = new Set<string>();
  const reviewLines: string[] = [];
  const writes: Array<[string, string]> = [];

  for (const path of inScope) {
    const full = join(root, path);
    if (lstatSync(full).isSymbolicLink()) continue;
    const buffer = readFileSync(full);
    const text = buffer.toString("utf8");
    // 含 NUL 的是二进制；不是合法 UTF-8 的（解码再编码对不上）改了会毁字节，也一律不动内容。
    if (buffer.includes(0) || !Buffer.from(text, "utf8").equals(buffer)) {
      report.skippedBinary++;
      continue;
    }
    const oldLines = text.split("\n");
    for (const line of oldLines)
      for (const id of identifiers(line)) before.add(id);
    const renamed = renameText(text, protect);
    if (renamed === text) continue;
    const newLines = renamed.split("\n");
    let changed = 0;
    newLines.forEach((line, index) => {
      const old = oldLines[index] ?? "";
      if (line === old) return;
      changed++;
      const oldIds = identifiers(old);
      for (const id of identifiers(line)) if (!oldIds.has(id)) produced.add(id);
      const replacedBrand =
        (old.match(/OpenBot/g)?.length ?? 0) >
        (line.match(/OpenBot/g)?.length ?? 0);
      if (replacedBrand && inSentence(old)) {
        reviewLines.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    });
    report.files++;
    report.lines += changed;
    writes.push([path, renamed]);
  }
  report.review = reviewLines.length;
  report.collisions = [...produced].filter((id) => before.has(id)).sort();

  // 改名：全部先查，有目标已存在（磁盘上，或另一个文件也改到这里）就一个都不动。
  const moves: Array<[string, string]> = [];
  const targets = new Set<string>();
  for (const path of inScope) {
    const target = renamePath(path);
    if (target === path) continue;
    if (existsSync(join(root, target)) || targets.has(target)) {
      report.errors.push(`${path} -> ${target}: 目标已存在`);
      continue;
    }
    targets.add(target);
    moves.push([path, target]);
  }
  report.moved = moves.length;

  if (reviewOut) {
    writeFileSync(reviewOut, reviewLines.map((line) => `${line}\n`).join(""));
  }

  if (report.errors.length === 0 && !dryRun) {
    for (const [path, content] of writes)
      writeFileSync(join(root, path), content);
    for (const [path, target] of moves) {
      mkdirSync(dirname(join(root, target)), { recursive: true });
      git(root, ["mv", "--", path, target]);
      // 目录里最后一个文件搬走后，git 不会清掉留下的空目录。
      for (
        let dir = dirname(path);
        dir !== "." && dir !== "";
        dir = dirname(dir)
      ) {
        const full = join(root, dir);
        if (!existsSync(full) || readdirSync(full).length > 0) break;
        rmdirSync(full);
      }
    }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.errors.length === 0 ? 0 : 1);
}

if (import.meta.main) main();
