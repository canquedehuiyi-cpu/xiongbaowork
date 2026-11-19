# 改代码：修 parseDuration 的 bug，并加 formatDuration

本目录是小库 `duration-kit`，源码在 `src/duration.ts`，测试在 `tests/`（用 `bun test` 运行）。

## 1. Bug

用户报告：`parseDuration("250ms")` 返回了 `15000000`，应该是 `250`；`parseDuration("1m500ms")` 也算错了。
请修好。`parseDuration` 的约定：

- 输入是一个或多个「整数 + 单位」首尾相连，单位只有 `h`、`m`、`s`、`ms`，例如 `1h30m`、`90s`、`1m500ms`；
- 首尾空白忽略；
- 返回毫秒数（整数）；
- 只要有任何一段不符合上面的格式（包括空串、`abc`、`5x`、`1h30`），就抛出 `Error`。

## 2. 小需求

在 `src/duration.ts` 里新增并导出 `formatDuration(ms: number): string`，把毫秒数格式化成上面的写法：

- 依次输出 `h`、`m`、`s`、`ms` 中**不为 0** 的部分，例如 `5400000 → "1h30m"`、`61000 → "1m1s"`、`250 → "250ms"`；
- `0 → "0ms"`；
- 负数或非整数抛出 `Error`；
- 对任何合法输入，`parseDuration(formatDuration(x)) === x`。

## 规矩

- 只改 `src/` 下的文件；**不要修改 `tests/` 里已有的测试**，也不要改 `package.json`。
- 改完运行 `bun test` 确认全部通过。
