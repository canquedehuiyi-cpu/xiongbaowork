import { formatMoney } from "./money";
import { type LineItem, lineTotal } from "./price";

export type Cart = { items: LineItem[] };

/** 放进购物车；同一个 SKU 的数量累加，不另起一行。返回新购物车，不改原来的。 */
export function addItem(cart: Cart, item: LineItem): Cart {
  const existing = cart.items.find((line) => line.sku === item.sku);
  if (!existing) return { items: [...cart.items, { ...item }] };
  return {
    items: cart.items.map((line) =>
      line.sku === item.sku
        ? { ...line, quantity: line.quantity + item.quantity }
        : line,
    ),
  };
}

/** 购物车里一共几件。 */
export function countPieces(cart: Cart): number {
  return cart.items.reduce((total, line) => total + line.quantity, 0);
}

/** 商品小计（分）。 */
export function cartSubtotal(cart: Cart): number {
  return cart.items.reduce((total, line) => total + lineTotal(line), 0);
}

/** 一行一件商品的文字清单，例如 `pen x3 = 4.50`。 */
export function describeCart(cart: Cart): string {
  return cart.items
    .map(
      (line) =>
        `${line.sku} x${line.quantity} = ${formatMoney(lineTotal(line))}`,
    )
    .join("\n");
}
