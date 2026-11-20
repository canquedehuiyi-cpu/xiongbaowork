/** 分转元，保留两位小数，例如 1999 -> "19.99"。 */
export function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}
