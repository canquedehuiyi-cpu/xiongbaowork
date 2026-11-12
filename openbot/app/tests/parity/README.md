# 视觉对照（parity）截图工具

这是一套不依赖后端的截图与测量工具，用来把本地前端和 QoderWake CN 线上实例逐页对照。

- `fixtures.ts`：合成数据集。浏览器发出的每一个 `/api/**` 请求都由它作答，返回体按应用自己的类型（`@/lib/...`）标注，所以 `typecheck` 能发现数据形状与界面读取的字段不一致。数据有两个场景：
  - `data`（默认）：6 位员工（在线、休息、暂停、已隐藏、远程端点、他人共享）、2 个群组、12 条任务（进行中 / 需要操作 / 待查收 / 已结束，来源覆盖对话、例行、职责、交接、群组运行、自动任务）、例行任务与自动任务、插件、技能、知识库、模型、会话与设备。
  - `empty`：所有列表为空，但 `/api/me` 仍然是已登录状态。
  - 所有名称、邮箱、设备名都是虚构的；时间戳以 `2026-11-01T09:00:00Z` 为基准固定偏移，id 固定，保证每次截图像素一致。
  - 未覆盖的接口：`resolveFixture` 返回 `undefined`，截图脚本记录为 “unmatched”，并返回 404 `{ "error": "parity fixture missing" }`。
- `capture.ts`：逐个路由 × 视口 × 主题 × 场景截图，并输出测量数据。
- `diff.ts`：把参考截图与本地截图逐像素比较。

文件名刻意不使用 `*.test.ts`，不会被 `bun test` 收进单元测试。

## 1. 启动 Vite 开发服务器

在 `openbot/app` 目录下执行（必须带 `--host 127.0.0.1`，此环境下 IPv6 `::` 监听会失败）：

```sh
cd openbot/app
APP_PORT=3910 SERVER_PORT=3911 bun --bun node_modules/vite/bin/vite.js --host 127.0.0.1
```

无需启动 API 服务器。Vite 的 `/api` 代理指向一个不存在的端口，所有 `/api/**` 请求都会在浏览器里被拦截并由 `fixtures.ts` 作答。对 `ws://127.0.0.1:3911` 的 WebSocket 连接失败是预期现象，测量结果里单独列为 `websocketErrors`。

## 2. 截图

```sh
cd openbot/app
bun tests/parity/capture.ts \
  [--base http://127.0.0.1:3910] \
  [--out <目录>] \
  [--scenario data|empty|all]   # 默认 all
  [--theme dark|light|all]      # 默认 dark
  [--only <路由子串>]           # 例如 --only wakers
  [--viewport 1440x900]         # 默认四个视口：1696x783、1440x900、1280x800、1024x768
  [--concurrency 3]
```

默认输出目录：`/tmp/claude-0/-home-user-xiongbaowork/87ff88c2-019b-516c-a0cd-6b2b65a63f7a/scratchpad/parity-shots`。

截图前会：

- 用 `addInitScript` 写入 `localStorage["xiongbao-theme"]`（`dark` 或 `light`）；
- 把页面时钟固定在 `2026-11-07T10:00:00+08:00`（`page.clock.setFixedTime`），时区 `Asia/Shanghai`，语言 `zh-CN`；
- 注入 CSS 关闭动画、过渡与光标闪烁，并隐藏 CopilotKit 在开发模式下挂出的 `<cpk-web-inspector>` 浮层（生产构建没有它）；
- 拦截所有对外部域名的请求（例如 CopilotKit 的公告源），本地返回 `{}`，记录在 `externalRequests`；
- 等待网络空闲、`document.fonts.ready`，再等 500ms；`deviceScaleFactor` 为 1，只截视口范围。

输出结构：

```
<out>/
  summary.md                              # 每个路由 × 视口：错误数、未覆盖接口、横向溢出
  <scenario>/<theme>/<WxH>/<route-slug>.png
  <scenario>/<theme>/<WxH>/<route-slug>.json
```

每个 `.json` 包含：`pageErrors`（页面异常）、`consoleErrors`、`websocketErrors`、`unmatchedRequests`、`externalRequests`、`horizontalOverflow`（`scrollWidth > innerWidth`），以及以下锚点的包围盒（x、y、w、h，取整）和计算后的 `font-size`、`color`、`background-color`：

- `[data-sidebar="sidebar"]`（侧边栏容器）
- `main`
- 第一个 `h1`
- 前 12 个 `[data-sidebar="menu-button"]`
- `main` 内前 12 个 `button`
- `main` 内所有 `input`

路由清单在 `capture.ts` 的 `ROUTES` 中维护。`/wakers` 的“员工 / 群组”切换是组件内部状态而不是 URL 参数，所以 `wakers-groups` 这张图是打开 `/wakers` 后点击“群组”按钮得到的。

## 3. 放置参考截图

从 QoderWake CN 实例截取的参考图放在：

```
<out>/reference/<theme>/<WxH>/<route-slug>.png
```

例如 `<out>/reference/dark/1440x900/tasks.png`。`route-slug` 与本地截图文件名一致（`/tasks` → `tasks`，`/wakers/agent-analyst` → `wakers-agent-analyst`，群组页签 `/wakers?tab=groups` → `wakers-groups`）。参考图请使用相同视口、设备像素比 1、仅视口范围（不是整页长图）。

同一页面的测量：在参考站开发者工具控制台粘贴运行 `reference-measure.js` 的全部内容，它把与我方 `.json` 同结构的锚点盒模型、字号、颜色复制到剪贴板，另存为同路径的 `<route-slug>.json`。分享前检查 `text` 字段，去掉账号名、机器名等标识。

参考路径与我方路径对照：`/work-management` → `tasks`，`/at-waker` → `reachability`，`/autonomous-work` → `autonomous`，`/management` → `wakers`，`/management?tab=groups` → `wakers-groups`，`/resources/plugins` → `resources`。

## 4. 对比

```sh
cd openbot/app
bun tests/parity/diff.ts [--out <目录>] [--scenario data] [--theme dark] [--threshold 8]
```

对每一张参考图，找到同名的本地截图，按每个通道 8/255 的阈值统计不同像素的百分比，并输出：

- `<out>/diff/<scenario>/<theme>/<WxH>/<route-slug>.png`：本地截图淡化为灰色，不同的像素标红；
- `<out>/diff/report.md` 与 `report.json`：每张图的尺寸、不同像素数与百分比，以及没有对应本地截图的参考图。

仓库里没有安装 PNG 解码库，所以解码与比较都在 Chromium 中用 canvas 完成。两张图尺寸不同时，按较大的尺寸比较，超出任一图范围的像素计为不同。

## 5. 校验

```sh
cd openbot
bun run --cwd app typecheck          # fixtures 的形状与应用类型一致
bunx biome lint app/tests/parity
bunx biome format app/tests/parity
```

新页面请求了 `fixtures.ts` 还没有的接口时，`summary.md` 的 “Unmatched API requests” 会列出来；在 `fixtures.ts` 的 `routes` 表里补上对应的处理函数，并用 `@/lib/...` 中的类型标注返回体。
