import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 去品牌改名表。改名工具（apply.ts）与后续按目录改名的任务都从这里取：
 * 变体表、跳过路径、保护清单（protect.json）以及对文本与路径的改名函数。
 * 路径一律相对仓库根（含 xiongbao/、docs/、archives/ 的那一层）。
 */

export type Phase = "R1" | "R2" | "R3" | "R4";

/**
 * 保护清单的一条：`text` 按字面匹配，`pattern` 是正则源码（二选一）。
 * `until` 是负责改掉它的阶段：当前阶段早于 `until` 时保护，到了 `until` 就不再保护；
 * `forever` 永远保护。
 */
export type ProtectEntry = {
  text?: string;
  pattern?: string;
  /**
   * 作用域：仓库根相对路径。带 `file` 的条目只在该文件里生效（文件被改名后按新路径也认），
   * 取自品牌白名单的 `file` 字段，避免一个短字符串冻结全仓同样的子串。不带则全仓生效。
   */
  file?: string;
  until: Phase | "forever";
  reason: string;
};

/** 子串替换，区分大小写，按此顺序：包作用域最先，然后大写、混合写法，最后全小写。 */
export const VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["@openbot/", "@xiongbao/"],
  ["OPENBOT", "XIONGBAO"],
  ["OpenBot", "XiongBao"],
  ["Openbot", "Xiongbao"],
  ["openBot", "xiongBao"],
  ["openbot", "xiongbao"],
];

/**
 * 任何阶段都不改内容和文件名的路径（相对仓库根）。以 `/` 结尾的是目录；`**` 跨任意层；
 * 不含 `/` 的条目（`node_modules/`、`bun.lock`）在任意层级按路径段匹配。
 */
export const SKIP_PATHS: readonly string[] = [
  "archives/",
  "xiongbao/server/drizzle/",
  "xiongbao/server/recovery/**/sql/",
  "xiongbao/server/recovery/**/meta/",
  "node_modules/",
  "bun.lock",
];

/**
 * 品牌护栏自己的代码、数据与夹具（相对仓库根，按前缀匹配）：护栏要认出旧名，这些文件里故意写着旧名，
 * 规则名、白名单条目、产物词表与测试夹具一改就全挂。改名工具、剩余旧词报告与护栏同步在任何阶段都
 * 像跳过工具目录一样跳过它们；到 R4 重写护栏时一起处理。`xiongbao/app/tests/brand-` 覆盖
 * brand-*.test.ts、brand-*.json 与 brand-artifacts/ 目录。
 */
export const GUARD_PATHS: readonly string[] = [
  "xiongbao/scripts/brand/",
  "xiongbao/app/tests/brand-",
  "xiongbao/app/tests/product-name-allowlist.json",
];

const PHASE_ORDER: Readonly<Record<Phase, number>> = {
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

const PROTECT_FILE = join(import.meta.dir, "protect.json");

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

const normalize = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");

export function readProtectEntries(): ProtectEntry[] {
  return JSON.parse(readFileSync(PROTECT_FILE, "utf8")) as ProtectEntry[];
}

const isActive = (entry: ProtectEntry, phase: Phase) =>
  entry.until === "forever" || PHASE_ORDER[phase] < PHASE_ORDER[entry.until];

const appliesTo = (entry: ProtectEntry, file?: string) =>
  entry.file === undefined ||
  (file !== undefined &&
    (normalize(file) === entry.file ||
      normalize(file) === renamePath(entry.file)));

/**
 * 把阶段内生效的条目合成一个带 `g` 的正则：`text` 先按长度降序转义，再接 `pattern`，
 * 交替里靠前的先匹配，所以更长的精确串优先于更短的。没有生效条目时给 /$^/g（不匹配非空文本）。
 */
export function buildProtect(
  entries: readonly ProtectEntry[],
  phase: Phase,
  file?: string,
): RegExp {
  const active = entries.filter(
    (entry) => isActive(entry, phase) && appliesTo(entry, file),
  );
  const texts = active
    .flatMap((entry) => (entry.text ? [entry.text] : []))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const patterns = active.flatMap((entry) =>
    entry.pattern ? [`(?:${entry.pattern})`] : [],
  );
  const parts = [...texts, ...patterns];
  return parts.length === 0 ? /$^/g : new RegExp(parts.join("|"), "g");
}

/** 不传 `file` 时只含不带作用域的条目；传了则再加上作用域是该文件的条目。 */
export function loadProtect(phase: Phase, file?: string): RegExp {
  return buildProtect(readProtectEntries(), phase, file);
}

/** 带作用域条目所在的文件（旧路径与改名后的路径），apply.ts 只为这些文件另建保护正则。 */
export function scopedFiles(): Set<string> {
  const files = new Set<string>();
  for (const entry of readProtectEntries()) {
    if (!entry.file) continue;
    files.add(entry.file);
    files.add(renamePath(entry.file));
  }
  return files;
}

const NUL = String.fromCharCode(0);
const PLACEHOLDER = new RegExp(`${NUL}(\\d+)${NUL}`, "g");

/**
 * 先把受保护的片段换成占位符，按 VARIANTS 顺序替换，再还原占位符。
 * 保护正则的零长度命中忽略；同一个正则对象可被反复使用（每次从头匹配）。
 */
export function renameText(
  text: string,
  protect: RegExp,
  variants: ReadonlyArray<readonly [string, string]> = VARIANTS,
): string {
  if (text.includes(NUL)) {
    throw new Error(
      "renameText: 输入含 NUL 字符，会与占位符冲突（二进制文件应在调用前跳过）",
    );
  }
  const kept: string[] = [];
  protect.lastIndex = 0;
  let out = text.replace(protect, (match) => {
    if (match === "") return match;
    kept.push(match);
    return `${NUL}${kept.length - 1}${NUL}`;
  });
  for (const [from, to] of variants) out = out.replaceAll(from, to);
  return kept.length === 0
    ? out
    : out.replace(PLACEHOLDER, (_, index: string) => kept[Number(index)] ?? "");
}

/** 对路径的每一段套变体。路径不受保护清单影响：文件名里没有需要保护的持久化名。 */
export function renamePath(
  path: string,
  variants: ReadonlyArray<readonly [string, string]> = VARIANTS,
): string {
  return path
    .split("/")
    .map((segment) =>
      variants.reduce((acc, [from, to]) => acc.replaceAll(from, to), segment),
    )
    .join("/");
}

const skipMatchers: Array<(path: string, segments: string[]) => boolean> =
  SKIP_PATHS.map((entry) => {
    const directory = entry.endsWith("/");
    const body = directory ? entry.slice(0, -1) : entry;
    if (!body.includes("/")) {
      // 单段：任意层级的同名目录或文件。
      return (_path, segments) => segments.includes(body);
    }
    const source = body
      .split("/")
      .map((part) => (part === "**" ? "(?:[^/]+/)*[^/]+" : escapeRegExp(part)))
      .join("/");
    const pattern = new RegExp(`^${source}(?:/|$)`);
    return (path) => pattern.test(path);
  });

export function isGuardPath(path: string): boolean {
  const normalized = normalize(path);
  return GUARD_PATHS.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 含 NUL 的是二进制；不是合法 UTF-8 的（解码再编码对不上）改了会毁字节，也当二进制。
 * 改名工具据此不动内容，剩余旧词报告据此不计入，两边口径一致。
 */
export function isBinary(buffer: Buffer): boolean {
  return (
    buffer.includes(0) ||
    !Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer)
  );
}

export function isSkipped(path: string): boolean {
  const normalized = normalize(path);
  const segments = normalized.split("/");
  return skipMatchers.some((match) => match(normalized, segments));
}
