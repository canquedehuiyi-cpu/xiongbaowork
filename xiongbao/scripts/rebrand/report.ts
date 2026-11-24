import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_PATH } from "./apply";
import {
  buildProtect,
  isBinary,
  isGuardPath,
  isSkipped,
  type Phase,
  readProtectEntries,
  scopedFiles,
} from "./rename-map";

/*
 * 剩余旧词报告：数仓库里还有多少旧品牌词，哪些受保护清单保护、哪些还没改。
 *
 *   bun xiongbao/scripts/rebrand/report.ts --phase <R1..R4> [--scope <路径>]...
 *     [--families openbot|copilotkit|openbot,copilotkit] [--fail-on-unprotected] [--fail-on-any]
 *
 * 路径一律相对仓库根（`git rev-parse --show-toplevel`），与当前目录无关。
 * 搜索词分两族：openbot 族（openbot|open-bot|open_bot|open.bot）与 copilotkit 族，不分大小写。
 */

export type Family = "openbot" | "copilotkit";
export type Leftover = {
  file: string;
  line: number;
  word: string;
  family: Family;
  protected: boolean;
};

const FAMILIES: readonly Family[] = ["openbot", "copilotkit"];
const PHASES: readonly Phase[] = ["R1", "R2", "R3", "R4"];

const WORDS: Readonly<Record<Family, RegExp>> = {
  openbot: /openbot|open-bot|open_bot|open\.bot/gi,
  copilotkit: /copilotkit/gi,
};

const ANY_WORD = /openbot|open-bot|open_bot|open\.bot|copilotkit/i;

const USAGE =
  "用法: bun xiongbao/scripts/rebrand/report.ts --phase <R1|R2|R3|R4> [--scope <路径>]... [--families <openbot|copilotkit|openbot,copilotkit>] [--fail-on-unprotected] [--fail-on-any]";

type Span = [number, number];

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const OVERRIDE_SECTIONS = ["overrides", "resolutions"];

/** package.json 里 dependencies 系与 overrides/resolutions 里的 `@copilotkit/…` 键名。 */
function copilotkitDependencyNames(text: string): Set<string> {
  const names = new Set<string>();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return names;
  }
  if (typeof json !== "object" || json === null) return names;
  const manifest = json as Record<string, unknown>;
  const collect = (value: unknown, nested: boolean) => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key.startsWith("@copilotkit/")) names.add(key);
      if (nested) collect(inner, true);
    }
  };
  for (const section of DEPENDENCY_SECTIONS) collect(manifest[section], false);
  for (const section of OVERRIDE_SECTIONS) collect(manifest[section], true);
  return names;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** `@copilotkit/…` 路径字符串及其前面的写法；前面是导入/导出/动态导入/require/模块替身时才放行。 */
const COPILOTKIT_PATH = /(["'`])(@copilotkit\/[^"'`]*)\1/g;
const IMPORT_PREFIX =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b(?:vi|jest)\.(?:mock|doMock|importActual)\s*\(\s*|\bmock\.module\s*\(\s*)$/;
const NOTICE_COPYRIGHT = /Copyright \(c\) 2026 CopilotKit/;
/** 许可证文件：构建产物 THIRD-PARTY-NOTICES.md（任意目录）与随仓库提交的 xiongbao/LICENSE、xiongbao/NOTICE。 */
const NOTICE_FILE =
  /(?:^|\/)THIRD-PARTY-NOTICES\.md$|^xiongbao\/(?:LICENSE|NOTICE)$/;
/** MIT 原文的最后一行：放行段到此为止。 */
const LICENSE_END = /^SOFTWARE\.\s*$/;

/** copilotkit 族里放行的片段（只对 copilotkit 族生效）。 */
function exemptSpans(
  file: string,
  line: string,
  inLicense: boolean,
  dependencyNames: Set<string>,
): Span[] {
  if (inLicense) return [[0, line.length]];
  const spans: Span[] = [];
  if (file.endsWith("package.json")) {
    const key = /^\s*"(@copilotkit\/[^"]*)"\s*:/.exec(line);
    if (key && dependencyNames.has(key[1] as string))
      spans.push([0, key[0].length]);
  }
  if (SOURCE_FILE.test(file)) {
    for (const match of line.matchAll(COPILOTKIT_PATH)) {
      const at = match.index ?? 0;
      if (IMPORT_PREFIX.test(line.slice(0, at)))
        spans.push([at, at + match[0].length]);
    }
  }
  return spans;
}

const within = (inner: Span, spans: Span[]) =>
  spans.some(([s, e]) => inner[0] >= s && inner[1] <= e);

function spansOf(pattern: RegExp, line: string): Span[] {
  const spans: Span[] = [];
  for (const match of line.matchAll(
    new RegExp(pattern.source, pattern.flags),
  )) {
    if (match[0] === "") continue;
    const at = match.index ?? 0;
    spans.push([at, at + match[0].length]);
  }
  return spans;
}

export function gitRoot(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

/**
 * 按验收搜索词扫文件，返回每一处命中。`files` 是相对仓库根的路径；跳过路径、工具目录、品牌护栏
 * （GUARD_PATHS）、不存在的、符号链接与二进制文件（与 apply 同一个 isBinary）不计入。依赖声明（package.json 的依赖与 overrides 键）、
 * 源码导入路径里的 `@copilotkit/`、许可证文件里版权行到 MIT 原文结尾（`SOFTWARE.` 行）的一段只对 copilotkit 族放行。
 * 命中是否受保护按命中所在文件取保护正则，且要整处落在保护片段里。
 */
export function findLeftovers(
  files: string[],
  phase: Phase,
  root: string = gitRoot(),
): Leftover[] {
  const entries = readProtectEntries();
  const baseProtect = buildProtect(entries, phase);
  const scoped = scopedFiles();
  // 保护正则只按文件建一次：重复读 protect.json 会让全仓扫描慢到几十秒。
  const perFile = new Map<string, RegExp>();
  const protectFor = (file: string) => {
    if (!scoped.has(file)) return baseProtect;
    let regex = perFile.get(file);
    if (!regex) {
      regex = buildProtect(entries, phase, file);
      perFile.set(file, regex);
    }
    return regex;
  };
  const found: Leftover[] = [];
  for (const file of files) {
    if (isSkipped(file) || file.startsWith(TOOL_PATH) || isGuardPath(file))
      continue;
    const full = join(root, file);
    if (!existsSync(full) || lstatSync(full).isSymbolicLink()) continue;
    const buffer = readFileSync(full);
    if (isBinary(buffer)) continue;
    const text = buffer.toString("utf8");
    const protect = protectFor(file);
    const dependencyNames = file.endsWith("package.json")
      ? copilotkitDependencyNames(text)
      : new Set<string>();
    const isNotice = NOTICE_FILE.test(file);
    let inLicense = false;
    text.split("\n").forEach((line, index) => {
      if (isNotice && NOTICE_COPYRIGHT.test(line)) inLicense = true;
      const licenseLine = inLicense;
      if (inLicense && LICENSE_END.test(line)) inLicense = false;
      // 绝大多数行没有任何旧词：先一次判断，省掉逐行的正则构造。
      if (!ANY_WORD.test(line)) return;
      const kept = spansOf(protect, line);
      const exempt = exemptSpans(file, line, licenseLine, dependencyNames);
      for (const family of FAMILIES) {
        for (const match of line.matchAll(WORDS[family])) {
          const at = match.index ?? 0;
          const span: Span = [at, at + match[0].length];
          if (family === "copilotkit" && within(span, exempt)) continue;
          found.push({
            file,
            line: index + 1,
            word: match[0],
            family,
            protected: within(span, kept),
          });
        }
      }
    });
  }
  return found;
}

/** 汇总用的分组：xiongbao/ 下按第二段，其余按第一段；根上的单个文件各归一组。 */
export function groupOf(file: string): string {
  const parts = file.split("/");
  if (parts.length === 1) return "(仓库根文件)";
  if (parts[0] === "xiongbao")
    return parts.length === 2 ? "xiongbao/(根文件)" : `xiongbao/${parts[1]}`;
  return parts[0] as string;
}

export function summarize(found: Leftover[]) {
  const rows = new Map<string, { open: number; kept: number }>();
  for (const hit of found) {
    const row = rows.get(groupOf(hit.file)) ?? { open: 0, kept: 0 };
    if (hit.protected) row.kept++;
    else row.open++;
    rows.set(groupOf(hit.file), row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, counts]) => ({ group, ...counts }));
}

export function formatTable(found: Leftover[]): string {
  const rows = summarize(found);
  const total = rows.reduce(
    (sum, row) => ({ open: sum.open + row.open, kept: sum.kept + row.kept }),
    { open: 0, kept: 0 },
  );
  const width = Math.max(4, ...rows.map((row) => row.group.length));
  const line = (name: string, open: number | string, kept: number | string) =>
    `${name.padEnd(width)} | ${String(open).padStart(7)} | ${String(kept).padStart(7)}`;
  return [
    line("目录", "未保护", "已保护"),
    `${"-".repeat(width)}-+-${"-".repeat(7)}-+-${"-".repeat(7)}`,
    ...rows.map((row) => line(row.group, row.open, row.kept)),
    `${"-".repeat(width)}-+-${"-".repeat(7)}-+-${"-".repeat(7)}`,
    line("合计", total.open, total.kept),
  ].join("\n");
}

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  let phase: Phase | undefined;
  let families: Family[] = [...FAMILIES];
  const scopes: string[] = [];
  let failOnUnprotected = false;
  let failOnAny = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--phase") {
      const value = argv[++i];
      if (!PHASES.includes(value as Phase))
        fail(`--phase 要 ${PHASES.join("|")}\n${USAGE}`);
      phase = value as Phase;
    } else if (arg === "--families") {
      const value = (argv[++i] ?? "").split(",");
      if (value.some((name) => !FAMILIES.includes(name as Family)))
        fail(`--families 要 openbot、copilotkit 或二者以逗号相连\n${USAGE}`);
      families = value as Family[];
    } else if (arg === "--scope") {
      const value = argv[++i];
      if (!value) fail(`--scope 缺路径\n${USAGE}`);
      scopes.push(value as string);
    } else if (arg === "--fail-on-unprotected") failOnUnprotected = true;
    else if (arg === "--fail-on-any") failOnAny = true;
    else fail(`不认识的参数 ${arg}\n${USAGE}`);
  }
  if (!phase) fail(`缺 --phase\n${USAGE}`);
  return {
    phase: phase as Phase,
    families,
    scopes,
    failOnUnprotected,
    failOnAny,
  };
}

function main() {
  const { phase, families, scopes, failOnUnprotected, failOnAny } = parseArgs(
    process.argv.slice(2),
  );
  const root = gitRoot();
  if (!root) fail("不在 git 仓库里");
  for (const scope of scopes) {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--", scope], {
      cwd: root,
    }).stdout.toString();
    if (!tracked.includes("\0"))
      fail(
        `--scope ${scope} 在仓库根 ${root} 下没有匹配到被跟踪的文件（路径一律相对仓库根，如 xiongbao/shared）`,
      );
  }
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...scopes], {
    cwd: root,
  })
    .stdout.toString()
    .split("\0")
    .filter(Boolean);
  const found = findLeftovers(listed, phase, root).filter((hit) =>
    families.includes(hit.family),
  );
  process.stdout.write(
    `阶段 ${phase}，词族 ${families.join(",")}${scopes.length ? `，范围 ${scopes.join(" ")}` : ""}\n${formatTable(found)}\n`,
  );
  const open = found.filter((hit) => !hit.protected);
  if (failOnUnprotected && open.length > 0) {
    const shown = open.slice(0, 50);
    process.stderr.write(
      `${open.length} 处未保护的旧词：\n${shown
        .map((hit) => `${hit.file}:${hit.line}: ${hit.word}`)
        .join(
          "\n",
        )}\n${open.length > shown.length ? `…另有 ${open.length - shown.length} 处\n` : ""}`,
    );
    process.exit(1);
  }
  if (failOnAny && found.length > 0) {
    process.stderr.write(`仍有 ${found.length} 处旧词（含已保护的）\n`);
    process.exit(1);
  }
}

if (import.meta.main) main();
