# 重构：改名 + 抽函数（不改行为）

本目录是小库 `shop-kit`（购物车和订单），源码在 `src/`，测试在 `tests/`（用 `bun test` 运行）。
功能没有问题，要做的是一次纯重构，**对外行为一点都不能变**。

## 1. 改名

- 函数 `calcPrice` 改名为 `lineTotal`；
- 商品行 `LineItem` 的字段 `qty` 改名为 `quantity`。

两处改名要改全：`src/` 里不能再留旧名字（包括类型、导出、调用处和注释以外的任何引用），`src/index.ts`
对外导出的名字跟着换。

## 2. 抽函数

- 把几处重复的「分转元、保留两位小数」`(x / 100).toFixed(2)` 抽成 `src/money.ts` 里的
  `formatMoney(cents: number): string`（例如 `1999 → "19.99"`、`5 → "0.05"`、`0 → "0.00"`），
  `src/` 里除了 `money.ts` 不再直接写 `toFixed(2)`；
- 把重复的「购物车里一共几件」抽成 `src/cart.ts` 里导出的 `countPieces(cart: Cart): number`，
  `order.ts` 和 `report.ts` 里的重复写法都改成调它。

`src/index.ts` 也要导出 `lineTotal`、`formatMoney` 和 `countPieces`。

## 规矩

- `tests/` 里已有的测试要跟着改名一起更新，改完它们必须全部通过（不要删测试、不要改它们要验证的结果）；
- 不要改 `package.json`；
- 改完运行 `bun test` 确认全部通过。
