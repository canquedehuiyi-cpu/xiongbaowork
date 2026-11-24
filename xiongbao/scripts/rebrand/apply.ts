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
  isBinary,
  isGuardPath,
  isSkipped,
  loadProtect,
  type Phase,
  renamePath,
  renameText,
  scopedFiles,
  VARIANTS,
} from "./rename-map";

/*
 * 改名工具：对仓库根下指定路径里 `git ls-files` 的文件改内容并 `git mv` 改名。
 *
 *   bun xiongbao/scripts/rebrand/apply.ts --phase <R1..R4> [--dry-run] [--review-out <文件>] [--only <变体源串>]... <路径...>
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
  "用法: bun xiongbao/scripts/rebrand/apply.ts --phase <R1|R2|R3|R4> [--dry-run] [--review-out <文件>] [--only <变体源串>]... <路径...>";

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

/** 新品牌词本身（及其后接下划线的片段）到处都有，列出来没有信息量。 */
const BRAND_WORD = /^(?:xiongbao|XIONGBAO|XiongBao|Xiongbao|xiongBao)_*$/;

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
  const only: string[] = [];
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
    } else if (arg === "--only") {
      const value = argv[++i];
      if (!value || !VARIANTS.some(([from]) => from === value))
        fail(
          `--only 要变体源串之一：${VARIANTS.map(([from]) => from).join(" ")}\n${USAGE}`,
        );
      only.push(value);
    } else if (arg.startsWith("--")) fail(`不认识的参数 ${arg}\n${USAGE}`);
    else paths.push(arg);
  }
  if (!phase) fail(`缺 --phase\n${USAGE}`);
  if (paths.length === 0) fail(`缺路径\n${USAGE}`);
  return { phase: phase as Phase, dryRun, reviewOut, only, paths };
}

/** 中途失败：说明已做到哪一步和怎么恢复，退出 1（工作区开跑前是干净的）。 */
function reportFailure(
  error: unknown,
  done: string[],
  pathspecs: string[],
): never {
  const scope = pathspecs.join(" ");
  process.stderr.write(
    [
      `改名中途失败：${(error as Error).message}`,
      `已完成 ${done.length} 步${done.length ? `，最后一步：${done[done.length - 1]}` : ""}。`,
      "开跑前范围内是干净的，恢复到开跑前：",
      `  git restore --source=HEAD --staged --worktree -- ${scope}`,
      `  git clean -fd -- ${scope}`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function main() {
  const { phase, dryRun, reviewOut, only, paths } = parseArgs(
    process.argv.slice(2),
  );
  // 默认全部变体；--only 只应用列出的，顺序仍按 VARIANTS。
  const variants =
    only.length === 0
      ? VARIANTS
      : VARIANTS.filter(([from]) => only.includes(from));

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

  // 带作用域的保护条目只在各自的文件里生效，其余文件共用一个正则。
  const baseProtect = loadProtect(phase);
  const scoped = scopedFiles();
  const protectFor = (path: string) =>
    scoped.has(path) ? loadProtect(phase, path) : baseProtect;
  const report: Report = {
    files: 0,
    lines: 0,
    moved: 0,
    collisions: [],
    review: 0,
    skippedBinary: 0,
    errors: [],
  };

  // 真跑之前，范围内的工作区必须干净：改名是整批操作，混着别人的改动就没法回头。
  if (!dryRun) {
    const dirty = git(root, [
      "status",
      "--porcelain",
      "--",
      ...pathspecs,
    ]).trim();
    if (dirty) {
      report.errors.push(
        `范围内的工作区不干净（未跟踪文件也算，恢复时的 git clean 会删掉它们），先提交或暂存清理再跑（git status --porcelain -- ${pathspecs.join(" ")}）：\n${dirty}`,
      );
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exit(1);
    }
  }

  // 范围内的文件：已被跳过路径、工具目录与品牌护栏排除，磁盘上不存在的（已删未提交）也不算。
  const inScope = listed.filter(
    (path) =>
      !isSkipped(path) &&
      !path.startsWith(TOOL_PATH) &&
      !isGuardPath(path) &&
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
    if (isBinary(buffer)) {
      report.skippedBinary++;
      continue;
    }
    const text = buffer.toString("utf8");
    const oldLines = text.split("\n");
    for (const line of oldLines)
      for (const id of identifiers(line)) before.add(id);
    const renamed = renameText(text, protectFor(path), variants);
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
  report.collisions = [...produced]
    .filter((id) => before.has(id) && !BRAND_WORD.test(id))
    .sort();

  // 改名：全部先查，有目标已存在（磁盘上，或另一个文件也改到这里）就一个都不动。
  const moves: Array<[string, string]> = [];
  const targets = new Set<string>();
  for (const path of inScope) {
    const target = renamePath(path, variants);
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
    const done: string[] = [];
    try {
      for (const [path, content] of writes) {
        writeFileSync(join(root, path), content);
        done.push(`写 ${path}`);
      }
    } catch (error) {
      reportFailure(error, done, pathspecs);
    }
    for (const [path, target] of moves) {
      try {
        mkdirSync(dirname(join(root, target)), { recursive: true });
        git(root, ["mv", "--", path, target]);
        done.push(`移 ${path} -> ${target}`);
      } catch (error) {
        reportFailure(error, done, pathspecs);
      }
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
