# Task 2 报告：iLink 协议客户端

状态：DONE_WITH_CONCERNS

## TDD 证据
- 失败运行：`cd openbot/server && bun test tests/wechat-ilink.test.ts` → `Cannot find module '../src/delivery/wechat/ilink'`，0 pass / 1 fail。（首次因未安装依赖报 eventsource 缺失，执行 `bun install` 后得到上述预期失败。）
- 通过运行：6 pass / 0 fail / 24 expect。
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit -p .`（先 `bun run generate:app-config`）：无错误。
- `bunx biome check`（两个新文件）：通过（先 --write 格式化一次）。
- `bun scripts/ci/server-shards.mjs --write`（在 openbot/ 下执行）：已登记，909 个测试文件。

## 文件
- openbot/server/src/delivery/wechat/ilink.ts
- openbot/server/tests/wechat-ilink.test.ts
- openbot/scripts/ci/server-tests.list.txt

## 说明 / 顾虑
- 消息 id：message_id → seq → client_id；缺 id 或缺 from_user_id 的消息被跳过；message_type 2（自己发的）被跳过。
- groupId 读 `group_id`，协议文档里未证实该字段名，待实测。
- -14 → IlinkPausedError；sendmessage 其余非零 ret/errcode → IlinkWindowClosedError；HTTP 401/403 → IlinkUnauthorizedError。「鉴权类 errcode」未知，暂未实现，只认 HTTP 状态码。
- getUpdates 的请求超时固定 35s+10s，不随上一次响应的 longpolling_timeout_ms 变化（接口签名只带 cursor）；服务端若返回更长超时，会按网络错误处理，Task 5 轮询器可视情况调整。
- 二维码接口固定走默认基础地址 ILINK_DEFAULT_BASE_URL（redirect_host 由调用方处理，当前接口未提供改地址入口）。
- 默认版本常量 ILINK_DEFAULT_CLIENT_VERSION = "2.4.10"，待实测确认。

## Fix round 1
- getUpdates 新增可选第三参 timeoutMs，请求超时取 (timeoutMs ?? 35000)+10000；长轮询客户端超时返回空结果（messages 空、cursor null、timeoutMs 照旧）；其他请求超时仍为 network_error。去掉 timeoutHint。
- createIlinkClient 里校验 session.baseUrl：只接受 https 且主机为 weixin.qq.com 或其子域，否则 DeliveryProviderError("wechat","bad_base_url")，不发请求。
- 新增 4 个测试（超时参数被采用、超时为空轮询、非法 baseUrl 被拒且错误不含 token、sendText -14）。测试里的假地址改为 weixin.qq.com 子域。
- 运行：`cd openbot/server && bun test tests/wechat-ilink.test.ts` → 10 pass / 0 fail；tsc 无错误；biome 通过。
