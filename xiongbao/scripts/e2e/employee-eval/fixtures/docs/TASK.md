# 写文档：为 tiny-text 库补 API 文档

本目录是一个很小的 TypeScript 文本工具库 `tiny-text`（源码在 `src/`，入口 `src/index.ts`）。
`README.md` 里的 API 文档还没写。

## 要求

在 `README.md` 里补上「API」部分：

1. `src/index.ts` 导出的**每一个**符号（函数、常量、类型）都要有一小节，写清用途、参数、返回值；
2. 每个函数至少给一个 ```ts 代码块示例。示例要能直接编译：从包名导入，例如
   `import { slugify } from "tiny-text";`，只用库里真实存在的导出和参数；
3. Markdown 格式正确（标题 `#` 后有空格、代码块成对闭合、表格每行列数一致）。

只改 `README.md`，不要改 `src/` 和其他文件。
