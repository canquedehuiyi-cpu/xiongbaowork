/** 每个单位多少毫秒，按从大到小的顺序。 */
const UNITS: [string, number][] = [
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
  ["ms", 1],
];
const UNIT_MS = new Map(UNITS);

/** `ms` 放在 `m` 前面，不然 `250ms` 会先被读成 250 分钟。整串必须完全由这些段组成。 */
const WHOLE = /^(?:\d+(?:ms|h|m|s))+$/;
const PART = /(\d+)(ms|h|m|s)/g;

/** 把 `1h30m`、`90s`、`1m500ms` 这样的时长解析成毫秒数。 */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (!WHOLE.test(text)) throw new Error(`无法解析时长：${input}`);
  let total = 0;
  for (const match of text.matchAll(PART))
    total += Number(match[1]) * (UNIT_MS.get(match[2] ?? "") ?? 0);
  return total;
}

/** 把毫秒数写成 `1h30m` 这样的时长；0 写成 `0ms`。 */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0)
    throw new Error(`时长必须是非负整数：${ms}`);
  if (ms === 0) return "0ms";
  let rest = ms;
  let out = "";
  for (const [unit, size] of UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) out += `${count}${unit}`;
  }
  return out;
}
