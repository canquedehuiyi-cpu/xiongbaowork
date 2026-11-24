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

/**
 * 把阶段内生效的条目合成一个带 `g` 的正则：`text` 先按长度降序转义，再接 `pattern`，
 * 交替里靠前的先匹配，所以更长的精确串优先于更短的。没有生效条目时给 /$^/g（不匹配非空文本）。
 */
export function buildProtect(
  entries: readonly ProtectEntry[],
  phase: Phase,
): RegExp {
  const active = entries.filter((entry) => isActive(entry, phase));
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

export function loadProtect(phase: Phase): RegExp {
  return buildProtect(readProtectEntries(), phase);
}

const NUL = String.fromCharCode(0);
const PLACEHOLDER = new RegExp(`${NUL}(\\d+)${NUL}`, "g");

/**
 * 先把受保护的片段换成占位符，按 VARIANTS 顺序替换，再还原占位符。
 * 保护正则的零长度命中忽略；同一个正则对象可被反复使用（每次从头匹配）。
 */
export function renameText(text: string, protect: RegExp): string {
  const kept: string[] = [];
  protect.lastIndex = 0;
  let out = text.replace(protect, (match) => {
    if (match === "") return match;
    kept.push(match);
    return `${NUL}${kept.length - 1}${NUL}`;
  });
  for (const [from, to] of VARIANTS) out = out.replaceAll(from, to);
  return kept.length === 0
    ? out
    : out.replace(PLACEHOLDER, (_, index: string) => kept[Number(index)] ?? "");
}

/** 对路径的每一段套变体。路径不受保护清单影响：文件名里没有需要保护的持久化名。 */
export function renamePath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      VARIANTS.reduce((acc, [from, to]) => acc.replaceAll(from, to), segment),
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

export function isSkipped(path: string): boolean {
  const normalized = normalize(path);
  const segments = normalized.split("/");
  return skipMatchers.some((match) => match(normalized, segments));
}
