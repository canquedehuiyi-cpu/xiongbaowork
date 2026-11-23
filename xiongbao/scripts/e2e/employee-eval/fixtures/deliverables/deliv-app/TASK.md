# 交付：本机运行的程序

请做一个在这台电脑上运行的待办小程序，代码放在本目录的 `app/` 下。

功能：

- 新增一条待办（输入文字，点按钮添加）；
- 列出所有待办；
- 删除某一条待办。

接口约定（判分程序按这个调用，请严格照做；数据放内存里即可）：

- `GET /api/todos`：返回 JSON 数组，每项 `{ "id": <数字或字符串>, "text": "<待办文字>" }`；
- `POST /api/todos`：请求体 JSON `{ "text": "<待办文字>" }`，新增一条，返回 2xx 和新增的那一项 `{ "id": ..., "text": ... }`；
- `DELETE /api/todos/<id>`：删除这一条，返回 2xx；之后 `GET /api/todos` 里不能再有它；
- `GET /`：返回 `app/index.html`，页面用上面的接口增删列。

文件要求：

- 服务脚本：`app/server.js`、`app/server.ts`、`app/server.mjs` 或 `app/server.py` 之一（用 node、bun 或 python3 运行，不要装需要联网下载的依赖）；
- 页面文件：`app/index.html`，由服务脚本提供。

交付方式：

- 先把程序在本机真的跑起来，自己用浏览器或 curl 打开首页确认能用；
- 用 `deliver_task` 交付时，在 `items` 里加一项 `app`：写明程序监听的端口（`port`），
  路径默认 `/`，`title` 写「待办小程序」。服务器会请求一次首页；
- 程序要一直运行到被验收。

## 判分标准

1. `app/` 下有服务脚本（见上）和 `app/index.html`；
2. 交付里有 `app` 项，并写了端口；
3. （服务器侧另外检查：首页能打开；按上面的接口新增一条后 `GET /api/todos` 读得到，`DELETE` 之后读不到。）
