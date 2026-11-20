import { type Cart, cartSubtotal } from "./cart";
import { calcPrice, type LineItem } from "./price";

/** 满 99 元（9900 分）免运费，否则 8 元。 */
export function shippingCents(subtotal: number): number {
  return subtotal >= 9900 ? 0 : 800;
}

/** 订单总额（分）：商品小计加运费。 */
export function orderTotal(cart: Cart): number {
  const subtotal = cartSubtotal(cart);
  return subtotal + shippingCents(subtotal);
}

/** 金额最大的一行；空购物车返回 undefined。并列时取靠前的。 */
export function biggestLine(cart: Cart): LineItem | undefined {
  let best: LineItem | undefined;
  for (const line of cart.items)
    if (!best || calcPrice(line) > calcPrice(best)) best = line;
  return best;
}

/** 一句话的订单摘要，例如 `3 件，合计 54.50 元`。 */
export function orderSummary(cart: Cart): string {
  const pieces = cart.items.reduce((total, line) => total + line.qty, 0);
  return `${pieces} 件，合计 ${(orderTotal(cart) / 100).toFixed(2)} 元`;
}
