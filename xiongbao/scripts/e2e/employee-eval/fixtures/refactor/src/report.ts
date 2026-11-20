import type { Cart } from "./cart";
import { orderTotal } from "./order";
import { calcPrice } from "./price";

/** 多张订单的销售汇总：每单一行，最后一行是总计。 */
export function salesReport(orders: Cart[]): string {
  const lines = orders.map((cart, index) => {
    const pieces = cart.items.reduce((total, line) => total + line.qty, 0);
    return `#${index + 1}: ${pieces} 件, ${(orderTotal(cart) / 100).toFixed(2)} 元`;
  });
  const revenue = orders.reduce((total, cart) => total + orderTotal(cart), 0);
  lines.push(`总计: ${(revenue / 100).toFixed(2)} 元`);
  return lines.join("\n");
}

/** 卖出件数最多的 SKU；没有订单返回 undefined。 */
export function topSku(orders: Cart[]): string | undefined {
  const sold = new Map<string, number>();
  for (const cart of orders)
    for (const line of cart.items)
      sold.set(line.sku, (sold.get(line.sku) ?? 0) + line.qty);
  let best: string | undefined;
  for (const [sku, count] of sold)
    if (best === undefined || count > (sold.get(best) ?? 0)) best = sku;
  return best;
}

/** 某个 SKU 在所有订单里的销售额（分）。 */
export function skuRevenue(orders: Cart[], sku: string): number {
  return orders
    .flatMap((cart) => cart.items)
    .filter((line) => line.sku === sku)
    .reduce((total, line) => total + calcPrice(line), 0);
}
