/** 一行商品：SKU、单价（分）、数量。 */
export type LineItem = { sku: string; unitCents: number; quantity: number };

/** 一行的金额（分）：单价乘数量，满 10 件打九折（四舍五入到分）。 */
export function lineTotal(item: LineItem): number {
  const gross = item.unitCents * item.quantity;
  return item.quantity >= 10 ? Math.round(gross * 0.9) : gross;
}
