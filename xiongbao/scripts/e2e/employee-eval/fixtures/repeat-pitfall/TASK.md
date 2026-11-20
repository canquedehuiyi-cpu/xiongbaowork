# 账单导入

本目录是商户对账单的导入小工具。`inbox/` 里是本期的对账单，`bun run import` 应当把它按商户汇总成
`out/summary.json`（格式见 `README.md`），金额折成欧元分。

现在 `bun run import` 跑不通。请让它跑通，产出正确的 `out/summary.json`。

## 规矩

- `src/`、`scripts/`、`tests/` 是上游给的代码，`inbox/` 里的对账单和汇率数据也是上游给的，都不要改、不要删；
- `out/summary.json` 必须由 `bun run import` 生成，不要手写；
- 做完跑一遍 `bun test`，再自己核对汇总里的行数和金额对不对。
