# 抓取质量对比：熊宝现有 web_fetch 与 Firecrawl Local

只出报告的调研脚本，不进产品：不改 `package.json`、`Dockerfile`，不在任何产品代码里引用。报告见
`docs/reports/2026-11-24-firecrawl-compare.md`。

## 它做什么

1. `pages.ts`：确定生成 6 个测试页（静态文章、脚本渲染页、80 行长表格、带导航广告的页、全是 div 的噪声页、
   PDF），每页附标准答案（正文段落、关键事实、表格单元格、噪声词），答案先于任何工具的输出写下。
2. `compare.ts run`：在 127.0.0.1 起一个本机服务器，PDF 用本机 LibreOffice 从 HTML 生成；两边各抓每页一次
   预热加 N 次计时：
   - 熊宝：直接调 `server/src/web/` 的导出函数 `fetchPublicPage` -> `pageKind` -> `decodeBody` ->
     `extractReadable`（`web_fetch` 的 `describePage` 没导出，按它的顺序重做这四步，不含最后的字数截断）。
     不经模型、不经员工工具调用。
   - Firecrawl Local：外部二进制 `firecrawl-local scrape <url> --markdown`，环境只给最小集合并强制
     `FIRECRAWL_CLOUD=off`，不带任何 key，脚本里拒绝非 127.0.0.1 的地址。
3. `score.ts`：纯函数评分（正文召回、关键事实、噪声词出现率、表格单元格召回、表格行保真、脚本页是否拿到
   正文）。`score.test.ts` 是离线、确定、毫秒级的单测，根目录 `bun test` 会扫到。
4. `results/results.json`：分数与耗时；`results/outputs/<工具>.<页>.md`：两边的原始输出。
   `compare.ts rescore` 只用已存的输出按当前标准答案重算分数，不抓任何东西，结果可复算。

## 复现

```sh
# 1. 装 Firecrawl Local（AGPL-3.0，只作外部二进制，装到临时目录，不进仓库）
CARGO_TARGET_DIR=/tmp/fc-target cargo install firecrawl-local --version 0.1.1 --locked --root /tmp/fc-root

# 2. 在只有回环网卡的网络命名空间里跑（外网不通，Chrome 渲染脚本页时的后台联网也出不去）
cd xiongbao
scripts/research/firecrawl-compare/isolated.sh \
  bun scripts/research/firecrawl-compare/compare.ts run --runs 5 --firecrawl /tmp/fc-root/bin/firecrawl-local

# 3. 只重算分数
bun scripts/research/firecrawl-compare/compare.ts rescore

# 4. 评分单测
bun test scripts/research/firecrawl-compare
```

不给 `--firecrawl` 时只跑熊宝一侧，结果里记下 Firecrawl 不可用的原因，不会用别的工具顶替。

## 注意

- 熊宝的 `fetchPublicPage` 有 SSRF 防护并且没有放行回环地址的开关，所以请求写成
  `http://pilot.test:<端口>/...`，解析器注入一个公网地址，再注入 `fetchImpl` 把请求改道到本机端口，与
  `server/tests/web-tools.test.ts` 的做法相同。校验、重定向、字节上限、请求头都是真实代码；差别只是连的是本机。
- 熊宝的脚本渲染要走 Crawl4AI 服务（`crawl4ai.ts`），本机没有这个服务，所以脚本页只能测「不渲染」的路径。
- 耗时：熊宝是进程内调用，Firecrawl 每次是一次完整的进程启动，两者不是同口径，只作量级参考。
- 要抓真实互联网页面属于对外动作，需要先过审批；这个脚本不做。
