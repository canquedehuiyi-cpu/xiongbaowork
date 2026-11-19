/** 每个单位多少毫秒。 */
const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
};

const PART = /(\d+)(h|m|s|ms)/g;

/** 把 `1h30m`、`90s`、`1m500ms` 这样的时长解析成毫秒数。 */
export function parseDuration(input: string): number {
  const text = input.trim();
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(PART)) {
    total += Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? 0);
    consumed += match[0].length;
  }
  if (consumed === 0) throw new Error(`无法解析时长：${input}`);
  return total;
}
