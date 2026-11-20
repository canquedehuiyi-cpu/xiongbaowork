import { calcPrice, type LineItem } from "./price";

export type Cart = { items: LineItem[] };

/** 放进购物车；同一个 SKU 的数量累加，不另起一行。返回新购物车，不改原来的。 */
export function addItem(cart: Cart, item: LineItem): Cart {
  const existing = cart.items.find((line) => line.sku === item.sku);
  if (!existing) return { items: [...cart.items, { ...item }] };
  return {
    items: cart.items.map((line) =>
      line.sku === item.sku ? { ...line, qty: line.qty + item.qty } : line,
    ),
  };
}

/** 商品小计（分）。 */
export function cartSubtotal(cart: Cart): number {
  return cart.items.reduce((total, line) => total + calcPrice(line), 0);
}

/** 一行一件商品的文字清单，例如 `pen x3 = 4.50`。 */
export function describeCart(cart: Cart): string {
  return cart.items
    .map(
      (line) =>
        `${line.sku} x${line.qty} = ${(calcPrice(line) / 100).toFixed(2)}`,
    )
    .join("\n");
}
