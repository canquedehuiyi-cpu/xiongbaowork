# 终端：装依赖、修构建、让测试变绿

本目录是命令行小工具 `report-cli`：读一个 CSV，打印成对齐的文本表。源码在 `src/`，测试在 `tests/`，
随仓库带的第三方库 `textkit` 在 `vendor/textkit/`。

现在的状况：**装不上依赖、构建不过、测试也是红的**。请在终端里把它们逐个修好，直到：

1. `bun install` 成功（只用本目录里的东西，不需要联网）；
2. `bun run build` 成功，产出 `dist/cli.js`；
3. `bun test` 全部通过；
4. `bun src/cli.ts data/sample.csv` 打印出整齐的表（表头也对齐）。

## 规矩

- 不要改 `vendor/` 下的任何文件（那是第三方库）；
- 不要改 `tests/` 里已有的测试，也不要删它们；问题在 `package.json` 和 `src/` 里；
- 不要把依赖换成别的库，也不要把 `textkit` 的代码抄进 `src/`；
- 改完把上面四条都实际跑一遍确认。
