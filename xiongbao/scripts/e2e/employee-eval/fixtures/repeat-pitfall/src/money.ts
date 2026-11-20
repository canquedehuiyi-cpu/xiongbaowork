/** 把对账单里的金额文本读成币种的最小单位（分）；读不出来返回 null。`decimal` 是小数点用的字符。 */
export function parseAmountMinor(text: string, decimal: string): number | null {
  const escaped = decimal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^(\\d+)(?:${escaped}(\\d{1,2}))?$`).exec(
    text.trim(),
  );
  if (!found) return null;
  const major = Number(found[1]);
  const minor = Number((found[2] ?? "").padEnd(2, "0"));
  return major * 100 + minor;
}

/** 按汇率（每 1 单位折成多少百万分之一欧元）折成欧元分，四舍五入。 */
export function convertMinor(minor: number, perUnitMicro: number): number {
  return Math.floor((minor * perUnitMicro + 500_000) / 1_000_000);
}
