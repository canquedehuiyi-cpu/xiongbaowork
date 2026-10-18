# 开发环境笔记（历史记录）

以下保留原文，包含本机共享栈和共享库的历史操作命令。它们不是交付部署指令；并行工作一律使用独立容器/库，禁止执行旧文中的共享栈写入、重启或共享库迁移。

当前部署请读 [部署手册](deployment-qoderwake.md)。Windows 宿主不能直接 bun 起 server；镜像或 Linux/WSL 是交付路径。

---

# 部署与本地起服（QoderWake 复刻，全部落 D 盘）

面向"在这台 Windows 机器上把它跑起来并测一遍"的人。上游 `openbot/README.md` 与 `openbot/docs/deployment.md` 讲的是通用自托管；这一份只讲本仓库改完之后的实际形状，命令都是本会话真跑过的。

## 0. 一条硬约束

代码、数据卷、依赖、构建产物一律留在 D 盘仓库内。Windows 侧不执行 `bun`/`node` 的编译产物之外的事：**跑测试和任何会 `import @ai-sdk/*` / `@copilotkit/*` 的脚本必须进容器**（原生 Windows Bun 在导入链上无输出挂死，见 §5）。仓库里的 `tools/bun/bun.exe` 只用于不碰这些链的脚本（drizzle-kit、代码小工具）。

## 1. 数据库（PostgreSQL，宿主端口 5433）

```
docker start openbot-postgres-1        # 已存在则直接起；别新建
```

两个连接串，**用途不同，别混**：

| 用途 | 连接串 |
| --- | --- |
| 运行期（服务端、测试用） | `postgres://openbot_app:openbot@127.0.0.1:5433/openbot` |
| 迁移/清库（需要 owner 权限） | `postgres://openbot:openbot@127.0.0.1:5433/openbot` |

`openbot_app` 能读写数据、能在 `public` schema 里建表（迁移 `0054` 给了 `CREATE`），但**不能 `TRUNCATE`**——清库脚本因此必须用 owner 串跑。RLS 对所有带 `tenant_id` 的表开启 `FORCE`，并且**读和写各自一条策略**（迁移 `0072`）：`FOR SELECT` 允许"本租户 / `system` / `platform`"，所以平台内置目录人人可读；`FOR INSERT`/`UPDATE`/`DELETE` 只认"本租户，或当前处于 `platform` 作用域"，所以拿着别人的 id 也改不动、删不掉平台行。应用层仍然比对 `currentTenant()`（`src/waker-groups/store.ts` 是范例），但那是副防线而不是唯一的防线。

> **两个坑（本仓库当前实况）**：① 角色决定主防线是否存在——`openbot` 是超级用户，**RLS 不约束超级用户**（`FORCE` 只管表 owner），照 owner 串起服务端就只剩应用层一道，且静默。`.env.example` 现已默认 `openbot_app`；`docker-compose.yml` 里只有一次性的 `migrate` 服务用 owner 串（建角色必须它）。服务端启动时会查 `pg_roles`，发现自己是超级用户或 `BYPASSRLS` 就 `console.error` 一条 `rls-not-enforced`，设 `OPENBOT_RLS_ENFORCE=refuse` 则直接拒绝启动（判定函数与绊线测试在 `src/db/rls-role.ts` / `tests/rls-role.test.ts`）。② `deployment_packages` 被豁免于 FORCE 策略（`0062`：部署包目录是平台发给所有租户的内容，不是租户数据）。

集成测试用**另一个库** `openbot_test`：跑测试时 `DATABASE_URL` 与 `TEST_DATABASE_URL` 都指它。`openbot` 是开发库，不要拿它当测试库。

## 2. 迁移

```bash
cd openbot/server
# 生成（非交互：真正挡住交互提示的是 `< /dev/null`；`--name` 只是给文件起名）
DATABASE_URL="postgres://openbot:openbot@127.0.0.1:5433/openbot" \
  ../../tools/bun/bun.exe x drizzle-kit generate --name <slug> < /dev/null
# 应用：两个库各一次
for DB in openbot openbot_test; do
  DATABASE_URL="postgres://openbot:openbot@127.0.0.1:5433/$DB" \
    ../../tools/bun/bun.exe x drizzle-kit migrate < /dev/null
done
```

新生成的迁移只有 DDL。**租户隔离要手工补，形状照 `0072`（不是 `0067`）**：`0067` 及之前那批循环建的是**一条 `FOR ALL` 策略**，读写共用一个表达式——那正是"任何租户可写平台内置行"的来源，别再抄它。`0072` 的循环对每张有 `tenant_id` 的表建**四条**：`FOR SELECT`（本租户 / `system` / `platform`）、`FOR INSERT`（WITH CHECK：本租户或 platform 作用域）、`FOR UPDATE`（USING 与 WITH CHECK 都用写作用域）、`FOR DELETE`（USING 用写作用域）。**没有 `tenant_id` 的子表**（例如 `waker_group_members` 以组为键）循环看不见，必须单独写 `EXISTS (SELECT 1 FROM 父表 …)` 策略并同样分四条，否则它整个在 RLS 之外。末尾给 `openbot_app` 授权。

补完要登记三件套，否则 `drizzle-kit generate` 与 `tests/migration-journal.test.ts` 会一起骗人：`meta/_journal.json` 条目的 **`tag` 必须带四位数字前缀**（`0072_rls_command_scopes`，只写后半段会同时红"每个迁移有对应条目"和"条目按自己的 idx 命名"两条断言），`meta/0072_snapshot.json` 必须存在——纯策略迁移不动表/列/索引，所以正解是**复制上一号快照、只换 `id` 并把 `prevId` 接到上一号的 `id`**（`.scratch/qoderwake-replica/seed-snapshots.mjs` 与 `register-0072.mjs` 就是这个做法），`when` 用真实当前时间且必须晚于上一条。

## 3. 服务端

```bash
cd openbot
cp .env.example .env            # 然后按下表改
docker compose up -d postgres   # 或复用已存在的 openbot-postgres-1
```

本分支新增/改动的关键变量：

| 变量 | 取值 | 作用 |
| --- | --- | --- |
| `DATABASE_URL` | 见 §1 运行期串 | 服务端与 RLS 的租户注入都走它 |
| `TENANT_RUNTIME` | `cloud` \| `device` | `device` 时动作下发到租户自己的设备（runner），无可达设备就**拒绝**而不是悄悄在云端做；`cloud` 走部署自带的 agent-computer，也是不设这个键时的默认。已登记进 `.env.example`（2026-10-08 之前只在 `src/config.ts` 里读、示例文件没有它，现已补上） |
| `TENANT_PACKAGE_DIR` | 例 `examples/qoderwake` | 品牌包（品牌/员工/技能/渠道/主题），启动时按 checksum 同步 |
| `OPENBOT_SINGLE_USER` | `true` 仅限本机单用户 | 关掉才走真实登录与租户隔离 |

多租户口径：**个人用户即租户**，注册即 `provisionTenant`（Free 订阅 + 一个"分身"），分身不计入座位配额。套餐与配额在写入路径拦截（`src/quota/limits.ts`），**不做支付**：`/plans` 页的动词是"切换"。

## 4. 设备端（runner）

打包形态：**Bun CLI runner 现在做，Tauri 托盘外壳后做，协议不变**（出站 WSS + 动作 RPC + 心跳）。

```bash
openbot/tools/bun/bun.exe openbot/runner/src/index.ts \
  --server wss://<host>:<port> --name "工作室台式机" --pair <一次性配对码>
```

（bun 在**仓库根**的 `tools/bun/bun.exe`——上面这条从仓库根目录执行，所以路径带着 `openbot/` 前缀是给脚本的，不是给 bun 的。）

要点：配对码一次一用（原子 `UPDATE … WHERE used_at IS NULL AND expires_at > now()`）；设备令牌只存 sha256；离线时配额不足返回 402 **且不吃掉配对码**；状态不存列，由 `last_seen_at` 与 60 秒阈值派生；离线动作进 `work_items` 队列，按 `runner.action/<tenant>/<device>` 一条通道排队。

## 5. 测试与检查（都在容器里）

```bash
B=<repo>/openbot
MSYS_NO_PATHCONV=1 docker run --rm \
  -e DATABASE_URL="postgres://openbot_app:openbot@host.docker.internal:5433/openbot_test" \
  -e TEST_DATABASE_URL="postgres://openbot_app:openbot@host.docker.internal:5433/openbot_test" \
  -v $B/server/src:/app/server/src -v $B/server/tests:/app/server/tests \
  -v $B/server/drizzle:/app/server/drizzle -v $B/server/scripts:/app/server/scripts \
  -v $B/shared:/app/shared -v $B/examples:/app/examples -v $B/.env:/app/.env \
  openbot-dev \
  bash -lc "cd /app/server && bunx tsc --noEmit && bun test tests/<file>.test.ts"
```

**挂载少一条，就会多出一批看起来像回归的红灯**（2026-10-07 实测，每条都对应一次真误判）：
`server/drizzle` 少了 ⇒ `migration-journal` 读镜像里的旧迁移清单，报本分支新增迁移"缺快照"；
`examples` 少了 ⇒ `qoderwake-package.test.ts` 在装载期 ENOENT（`TENANT_PACKAGE_DIR` 默认相对 cwd 指 `../examples`），产出**一条没有名字的失败**——这就是全量里 `(unnamed)` 的一种形状；补上后同一文件 4 pass / 0 fail；
`.env` 少了 ⇒ `local-threads.test.ts` 的 `applicationDatabaseUrl()` 读 `/app/.env` ENOENT；
`server/scripts` 只在跑清库脚本时要，但一次挂齐比事后猜缺哪条便宜。
app 侧对应 `-v $B/app/src:/app/app/src -v $B/app/tests:/app/app/tests`（凡 import `../../server/src/...` 的测试再加 `$B/server/src`），cwd 换成 `/app/app`。

三条铁律，都是踩过才写下的：

1. **容器里的代码在 `/app`，不是 `/workspace`。** 把仓库挂到 `/workspace` 会同时遮掉镜像的 `node_modules` 并让测试读到镜像里的旧副本——产出的红灯是假的。逐目录挂到 `/app/...`。
2. **判回归比"失败名字多重集"，不比总数。** 有一族参数化用例每次超时条数会漂（同一批名字，总数 45↔58）。做法：`git worktree add ../tmp-head-check <基线提交>`，两棵树各跑一次，`(fail)` 行 `sed 's/ \[.*//' | sort | uniq -c` 后 `diff`。用完 `git worktree remove ../tmp-head-check --force`。
3. **清库要两道确认**（库名 + `CONFIRM_TEST_RESET=yes`），它会 TRUNCATE 12 张表及其级联依赖。**它不是真正的"全部清空"**：`users`/`sessions`/`accounts`/`channels`/`work_items`/`registered_devices`/`device_pair_codes` 等被测试写过的表没有外键指向清单里的表，因此留得下来。跨套件复用一个 `openbot_test` 时，把这句话当作前提而不是瑕疵。

```bash
docker run --rm -v $B/server/scripts:/app/server/scripts -v $B/server/src:/app/server/src \
  -v $B/shared:/app/shared \
  -e DATABASE_URL="postgres://openbot:openbot@host.docker.internal:5433/openbot_test" \
  openbot-dev bash -lc "cd /app/server && CONFIRM_TEST_RESET=yes bun scripts/reset-test-database.ts"
```

全量套件约 7–8 分钟；期间**别再开第二个碰同一个库的容器**，也别跑吃 CPU 的任务——那族参数化用例会被拖慢，制造出并不存在的"回归"。

`bunx biome check --write` 只对改动文件跑：全仓跑会顺手重排无关文件，把提交变成噪声。

## 6. 已知端口冲突

这台机器上 **3000 端口不是 OpenBot**（是"熊宝音乐工作室"SPA）。要在浏览器里验收，把 dev server 起在别的端口并确认 `/api` 代理目标跟着改；`docker-compose.yml` 的映射同理会随宿主占用变化。

## 7. 还没有的部分（别按"部署完成"理解这份文档）

- 卡片回收器（无人值守 run 崩溃后留下的 `running` 卡）有方法、有测试，**但还没接回扫描器**：它一度挂在 `index.ts` 的模块级定时器上，会在几十个测试文件 import 时全局改 `tasks` 表，已撤；正确落点是 `routines/sweep.ts`，且要先看账本行再动卡。
- 侧边栏/登录页/看板等界面的中文文案（见 `tickets/024`）；组团任务流水线整票未开工（见 `tickets/021` 的 A/B 决定）；managed Intelligence 死代码收缩与 README/CONTEXT 的上游化整理（见 `tickets/025`）。

## 5b. 全量测试怎么跑才算数（2026-10-07 实测）

**不要直接 `bun test` 跑整树。** 这套测试每个文件自己建连接池、跑完不关，而容器里 PostgreSQL 是 `max_connections=100`；文件数到 300 以后，撞上限只是时间问题——`--max-concurrency` 改不了这件事（cap 到 8 实测 111 fail，不 cap 112，同一次运行里 `53300 remaining connection slots` 出现 80 次）。撞上的时候红的是**单独跑完全绿**的文件，于是总数不再描述代码。

可信的做法是**分片**：把文件列表切成几段，每段一个进程，段与段之间池子自然释放。

```bash
cd "$B/server"
find tests -name '*.test.ts' | sort > /tmp/all.txt   # 用 find，不要用 tests/[a-c]*：
split -n l/6 /tmp/all.txt /tmp/shard.                # shell 的 * 不跨目录，会漏掉 tests/support/ 等
for f in /tmp/shard.*; do
  echo "### $f"; bun test $(cat "$f" | tr '\n' ' ') 2>&1 | grep -aE '^ [0-9]+ (pass|fail|skip|error)$'
done
```

两条读日志的规矩：① **一律 `grep -a`**（失败行带 ANSI 前缀，`grep -c '^(fail)'` 会给你假的 0）；② 任何总数先 `grep -ac "remaining connection slots" 日志`，非 0 就作废，别拿去和基线比、更别据此 revert 修改。回归判据仍然是**同一条命令取出来的失败名字多重集**（现存：`failures-2026-10-07.txt`、`failures-app-2026-10-07.txt`）。

## 8. G2（单用户全栈）在本机的实测状态（2026-10-07，容器路线）
**结论：全栈起得来，走查还没走通。** 已证实的事实（不是"应该能跑"）：
- server 容器起来并打印 `OpenBot server listening on http://127.0.0.1:3001`；app 容器 `VITE ready`，`http://localhost:3010/` 回 **200**，`/src/main.tsx` 与 `/src/routes/__root.tsx` 都 **200**（模块图能编译，不是 500 白屏）。
- `.env` 里 `OPENBOT_SINGLE_USER=true` 已开、`OPENBOT_ORGANIZATION_AUTHORITY` 是注释掉的（按 `auth/dev-actor.ts` 的口径，此时访客即管理员）。
- **但**：`curl http://localhost:3001/api/tasks` 回 **401**，而浏览器里 `/tasks` 的 DOM 只有空的 `RootWebArea`（React 没挂载完）。所以 **G2 的"跑通"这件事目前没有证据**，卡点在这两条之一：单用户 actor 需要先拿到 dev session cookie，或前端 boot 依赖某个请求没回来。**下一步就从这条查起**，别看别的。
- 三个必须踩的坑（每个都对应我这次真实撞上的现象）：
  1. **app 容器也要挂 `examples`**。只给 server 挂 ⇒ app 的 `predev`（`scripts/generate-app-config.ts` → `loadTenantPackage`）在 `/app/examples/qoderwake/channels.yaml` 上 ENOENT，报的是镜像里的旧副本缺文件，不是仓库缺文件（仓库里 `examples/qoderwake/channels.yaml` 确实在）。
  2. **`loadTenantPackage` 需要的六个文件是硬读**（`server/src/tenant-package.ts:727`：brand/agents/channels/model/knowledge + theme.css，前五个**没有 `.catch`**）。品牌包少任何一个文件就不是"这块内容没有"，是**整个装载抛错**。
  3. **挂进来的 `app/src` 会让 TanStack 路由树生成器 EXDEV 失败**（`.tanstack/tmp/… -> /app/app/src/routeTree.gen.ts` 跨设备 rename）。本次**没有损坏工作区**（`git status` 空、文件 1206 行完好），Vite 也照样起来了，但 `routeTree.gen.ts` 从此**不会被 dev server 更新**——这正好对上本项目"新路由手工登记 routeTree"的既有约定。
- 起法（`docker compose up --build` 那条路**我没走**，因为它会重建你机器上正在用的 `openbot-postgres-1`）：
  ```bash
  B="D:/AI编程库/项目库/进行中的项目/xiongbaoshuziyuangong/openbot"
  MSYS_NO_PATHCONV=1 docker run -d --name openbot-g2-server \
    -e DATABASE_URL="postgres://openbot_app:openbot@host.docker.internal:5433/openbot" \
    -e BETTER_AUTH_SECRET=<openssl rand -base64 32> -e BETTER_AUTH_URL=http://localhost:3001 \
    -e KEY_ENCRYPTION_KEY=<openssl rand -base64 32> -e INITIAL_ADMIN_EMAILS=admin@example.test \
    -e OPENBOT_PUBLIC_URL=http://localhost:3001 -e OPENBOT_SINGLE_USER=true -e INTELLIGENCE_MODE=local \
    -p 3001:3001 -p 3010:3010 \
    -v $B/server/src:/app/server/src -v $B/server/drizzle:/app/server/drizzle \
    -v $B/server/scripts:/app/server/scripts -v $B/shared:/app/shared \
    -v $B/examples:/app/examples -v $B/.env:/app/.env \
    openbot-dev bash -lc "cd /app/server && bun --env-file=../.env src/index.ts"
  # app 必须与 server 共享网络命名空间：vite 的代理目标是字面量 http://localhost:${SERVER_PORT}
  MSYS_NO_PATHCONV=1 docker run -d --name openbot-g2-app --network container:openbot-g2-server \
    -e SERVER_PORT=3001 -e APP_PORT=3010 \
    -v $B/app/src:/app/app/src -v $B/app/tests:/app/app/tests -v $B/shared:/app/shared \
    -v $B/server/src:/app/server/src -v $B/examples:/app/examples -v $B/scripts:/app/scripts -v $B/.env:/app/.env \
    openbot-dev bash -lc "cd /app/app && bun run dev --host 0.0.0.0 --port 3010 --strictPort"
  docker rm -f openbot-g2-app openbot-g2-server   # 收摊
  ```
- **`INTELLIGENCE_MODE` 现在是"会被读、会被拒"而不是"必须给"**：给 `local` 或不给都行；给 `managed` 会在启动时报 `INTELLIGENCE_MODE must be "local" or unset: this deployment keeps its threads in its own PostgreSQL…` 并拒绝起来。**旧的"不给平台三件套就拒启"（`CopilotKit Intelligence is required and is not configured`）随 034 一起删掉了**——会话存的本机 `threads`/`thread_runs`/`thread_run_events`，`INTELLIGENCE_API_URL`/`_GATEWAY_WS_URL`/`_API_KEY` 与 `COPILOTKIT_LICENSE_TOKEN` **根本不被读**，留着只是让 `.env` 说假话。上面配方里的 `-e INTELLIGENCE_MODE=local` 因此可以删（保留也无害，只是把模式说明写在命令行上）。
- **改了 `server/src` 要用 `docker rm -f` 重建，不能 `docker restart`**。`openbot-g2-app`/`openbot-echo-bot`/`openbot-g2-computer` 都以 `--network container:openbot-g2-server` 寄生在 server 的网络命名空间里，而**重启会换一个命名空间**：2026-10-07 实测 `docker restart openbot-g2-server` 之后 —— app 的 vite 代理 `ECONNREFUSED`（`/api/...` 全 000）、`/api/computers/<id>/control` 一律 503、server 日志刷 `egress-policy-push-on-wake-failed`、`computer` 容器尽管显示 healthy 其实挂在**已死的旧沙箱**上（`docker inspect -f '{{.HostConfig.NetworkMode}}'` 里那串 container id 与当前 server 的 `{{.Id}}` 不一致就是这个病）。三个寄生容器必须按上面的命令**逐个重建**。诊断口令：`docker inspect -f '{{.HostConfig.NetworkMode}}' openbot-g2-computer` 对比 `docker inspect -f '{{.Id}}' openbot-g2-server`。
- 本机浏览器工具**没有可见 surface**（`take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，`visibilityState=hidden`），`take_snapshot` 可用。走查记录只能靠结构快照，不能靠截图。

## 9. **G2 单用户已经真跑通了**（2026-10-07，附可复现证据）
上一条记的"起得来但走查不通"已解决，**根因是我自己配错**：
- `config.ts:1407` 的 `singleUser = !organizationAuthUrl && singleUserAllowed(environment, auth !== undefined)`，而 `hasProvider` 就是 **`auth !== undefined`**；只要给了 `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`，better-auth 实例就存在 ⇒ **单用户被判定为"有登录方式"而关闭**，`/api/tasks` 回 401、SPA 停在空壳。`.env.example` 里那四行"选哪种 provider 都要填"的键是**给 provider 模式用的**，单用户模式**一个都别给**。
- 正确起法：`OPENBOT_SINGLE_USER=true` + `KEY_ENCRYPTION_KEY` + `OPENBOT_PUBLIC_URL=http://localhost:3001`（loopback；`singleUserAllowed` 遇到公网地址会**拒绝启动**，这是设计），**不传 BETTER_AUTH_\*、不传 INITIAL_ADMIN_EMAILS**；`INTELLIGENCE_MODE=local` 可给可不给（见 §上一条）。
- 证据（不是推断）：启动日志 `No identity provider is configured, so every request is treated as dev@openbot.local (administrator)`；`GET /api/me` 回 `{"user":{"id":"dev-local-user","email":"dev@openbot.local","role":"admin",…}}`；`GET /api/capabilities` 回 `{"mode":"local","authProviders":[],"emailPassword":false,"selfHostBanner":false,…}`；`/api/tasks` 经 vite 代理回 **200** 与 `{"tasks":[]}`。
- **首屏有一道真实门禁**：`onboarding.completedAt === null` 会把 `/tasks` 弹回 `/onboarding`（`app/src/lib/auth/queries.ts:27`）。浏览器里点 Continue 没生效，走产品自己的端点才过：`POST /api/me/onboarding {"completed":true}` ⇒ `completedAt` 落值（`{"step":99,"completedAt":"2026-10-07T04:22:29.580Z"}`）。**走查任何页面之前先过这道**，否则每条都只会看到 onboarding。
- **A1 实测通过**（结构快照，本机浏览器没有可见 surface，截不了图）：`/tasks` 渲染出 `heading "任务看板"`、副标题「从工作本身出发：员工做了什么、什么需要你、什么等你查收。」、筛选「全部/进行中/需要操作/查收结果/已完成/失败」、`region "需要关注"` 里两个计数页签「需要操作 (0)」「查收结果 (0)」与 A7 的原句「暂无需要操作的任务——需要你确认、回答或补充信息的任务会显示在这里」、空态「看板上还没有任务——和员工说句话，工作就会出现在这里。」、设备筛选出现「studio-pc · 休眠」，URL 带 `?machineId=&crew=`（与 CONTEXT.md 记的两轴口径一致）。
- **A1 与 spec 字面有一处差异要认**：spec 写的是"统计条：任务总数/进行中/需要操作/已结束"，实屏是**筛选页签 + 需要关注区的双计数**，没有并列的四个总数。0 任务时也不见周期选择器（一周/一月/全部）。**这是渲染分支还是缺功能，下一轮要用有数据的库验**，别现在写成已符合。
- **白标的一处真缺陷（已定位、属配置不属代码）**：跑起来后页面顶部挂着上游推广条「Self-host OpenBot for your organization. → https://copilotkit.ai/talk-to-an-engineer?ref=openbot_app」。它是**能力位控制的**（`self-host-banner.tsx:30` 读 `capabilities.selfHostBanner`），开关是 `OPENBOT_SELF_HOST_BANNER=false`，`.env.example:54` 的注释正好写着"为自己组织跑 OpenBot 的 fork 可以给所有人关掉"。**本部署现已带上这个开关**，`/api/capabilities` 回 `selfHostBanner:false`。
- 另一处品牌残留（**未修**）：`app/index.html:6` 的 `<title>OpenBot</title>` 是硬编码，浏览器标签与 `RootWebArea "OpenBot"` 都是它；而 `appConfig.brand.productName`（生成物 `src/lib/generated/application-config.ts` 里已是「熊宝数字员工」）已经被侧栏、登录页、onboarding 用了三处。走查时页面标题仍是 OpenBot，属 024 未完项。

## 10. D1（数字员工页）实测 + 走查工具的本机限制（2026-10-07）
- **白标那条推广条确实没了**：带上 `OPENBOT_SELF_HOST_BANNER=false` 重启后，`/wakers` 的结构快照里不再有 `complementary "Self-host OpenBot"`，`/api/capabilities` 也回 `selfHostBanner:false`。**配置生效，不需要改代码**。
- **D1 成立**：`heading "数字员工"` + 双页签「员工 / 小组」（小组 = D3 的入口已存在）+ 状态筛选带计数「全部 (16) / 运行中 (0) / 待命 (16) / 已停用 (0)」，卡片「打开」链到 `/agents?agent=<id>`（D5 的入口）。
- **品牌包真的同步进来了**：16 位员工里有 `后端工程师/Backend Engineer`、`代码审核员/Code Reviewer`、`运营助手/Operations`、`测试工程师/QA Engineer`、`我的分身/个人分身`（CONTEXT.md 里 `avatar-<tenant>` 那位）。
- ⚠️ **024 的实证缺口（新found，具体到名字）**：这 16 位里**只有 5 位是中文显示名**，其余 11 位仍是上游英文名与英文角色标签——`Expense Review / Finance Operations`、`Feedback Digest / Product Research`、`Interview Notes / Recruiting`、`Knowledge / Company Knowledge`、`Meeting Follow-ups / Meetings`、`Onboarding Buddy / People Operations`、`On-call Handover / Reliability`、`Release Notes / Release Communications`、`Research Desk / Briefings`、`Ticket Triage / Support Operations`、`Vendor Review / Procurement`。**下一刀就是这些**：改 `examples/qoderwake/agents.yaml` 的显示名/角色（品牌包路径，不是改界面文案），因为界面是从包读的名字。
- **走查工具在本机的形状**（省下一轮时间）：`navigate_page` 对 vite dev server **经常 30s 超时**（HMR 长连让 load 事件不结），**但页面其实没导航成功与否要看重试**——原样再调一次通常立刻成功；`take_screenshot` 不可用（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，`visibilityState=hidden`），`list_network_requests` 恒返回 `No requests found`，所以**只能靠 `take_snapshot` 的结构树当证据**。SPA 全客户端渲染，`curl` 只能拿到空壳，替代不了浏览器。

## 11. 更正上一条的最后一节：那 11 个英文名**不是 024 的活**（我写错了，实测为证）
上一条说"16 位里 11 位是上游英文名，下一刀改 `examples/qoderwake/agents.yaml`"。**错了，而且错的方向是危险的**：把一个数据库残留当成了产品缺陷。实测：
- `grep -rl "Ticket Triage"` 全仓只命中 **`examples/fintech/agents/ticket-triage.yaml`** —— 另一个示例包。
- `select name, tenant_id, package_id from agents where name in ('Ticket Triage','Vendor Review','Expense Review')` ⇒ 三行都是 `tenant_id='system'`、同一个 `package_id=90f73a05-…`（fintech 包那次同步留下的）。`select tenant_id, count(*) from agents group by 1` ⇒ **16 行全在 `system`**。
- 所以 qoderwake 品牌包**自己**只声明 5 位（`general-assistant / backend-engineer / code-reviewer / qa-engineer / ops-assistant`，见 `examples/qoderwake/agents.yaml`），这 5 位显示名**都是中文**；它们的 `title` 是英文（`Backend Engineer` 等）是**包里就这么写的**，不是漏翻。
- 界面上多出来的 11 位是**本机 dev 库的历史行**（早先用 fintech 包跑过一次），走查时会被误读成"本产品有 16 位员工"。**判 D1 之前先清这张库**，或按 `package_id` 过滤再看。
- **仍然成立的部分**：D1 的骨架证据不受影响（双页签「员工/小组」、带计数的状态筛选、卡片「打开」→ `/agents?agent=<id>`），白标开关生效也不受影响。
- **教训（写死）**：从**渲染出来的列表**倒推"产品内容"，等于把测试残留当成需求。要看 `tenant_id`/`package_id`/来源文件三样对齐了再下结论——这次我只做了第一样就写了工单级结论。

## 12. 再更正上一条的定性：这**不是本机脏数据，是产品缺陷**（见工单 029，提交 `889eb34`）
上一条把 11 位英文员工说成"本机 dev 库的历史残留"。**定性错了，方向反过来才成立**：`deployment_packages` 全库只有 1 行、`source_path` 已经是 `../examples/qoderwake`，而那 11 位员工与 2 个频道**就带着这个 qoderwake 的 `package_id`**。也就是说换包时包行被改写、旧包写下的内容行**没有任何回收路径**（`tenant-package.ts` 的 `omittedAgentIds` 只管"本包内留空 id"，注释里写的是从频道里过滤掉、每次同步禁用再启用，**不删行**）。
- **谁能碰到**：任何换过品牌包的租户都会，不是我本机的偶然。
- **不只是难看**：座位配额按行数算（`assertCapacity(tenant,"wakers")`），**11 个幽灵白占 11 席**，Free 档会被顶满并在租户真要建员工时回 402——拒得"看起来合理"，这才是它危险的地方。`/wakers`、@ 派活候选（B1）、装配页（015）读同一批行，三处一起错。
- 本轮为走查**手工清了本机 dev 库**（`DELETE 11` / profiles `DELETE 11` / channels `DELETE 2`，`docker exec -i` 才收 stdin——第一次不带 `-i` 整段事务**根本没执行**，别踩）。清完 D1 实屏变成「全部 (5) / 待命 (5)」，五位中文名字。
- **手工清理不等于修好了**：只要不再换包它就不复发，一换包就再来一次。修法与需要先拍的那一件事（人改过的包内员工是"回收"还是"删除"，我建议沿用已有的软删 `agent_profiles.deleted_at`，保住授权/审计外键）都在 **`.scratch/qoderwake-replica/tickets/029-品牌包切换不删除旧内容.md`**。

## 13. 走查记录（2026-10-07，清完幽灵之后的干净数据）
| spec 项 | 屏幕 | 结果 |
| --- | --- | --- |
| A1/A7 | `/tasks` | ✅ 见第 9 节（`需要关注` 双计数页签 + A7 原句空态） |
| D1/D4 | `/wakers` | ✅ 「员工/小组」双页签、「全部 (5) / 运行中 (0) / 待命 (5) / 已停用 (0)」、卡片「打开」→ `/agents?agent=<id>` |
| C1 | `/autonomous` | ✅ 每员工一个页签（5 位）+「定时任务/长期职责/主动巡检」三段中文空态 + 「这位员工还没有无人值守地工作过」+ 服务端暂停规则说明 |
| K2/022 | `/plans` | ✅ 渲染出 Free/Pro 两档与 `切换` 按钮；「这个工作空间还没有订阅，所以什么都不限。」 |
| H1/H2 | `/resources` | ✅ 模型区在，且这句产品主张真的出现在界面上：「每一位员工用它自己的一份模型回答…让开发用一个模型、审核用另一个模型」（英文原文见下） |
| B2/B3 | 频道 @ 派活 | ❌ **没验**：`INTELLIGENCE_MODE=local` 下没接任何模型，发消息必失败。**这是 H1 的前置**——先在模型库接一个能用的端点，再走 B 组 |
| A3-A6/A8/A9 | 有任务时的看板 | ❌ 没验：库里 0 条任务 |
| D3 | `/wakers` 小组页签 | ❌ 没点开验（页签存在） |

**`/resources` 是 024 剩下最大的一块，精确到串**（这一屏的**框架文案整片是英文**，而品牌包灌进去的技能是中文——两种语言并排出现在同一屏上）：
- 屏名与分区：`Capabilities & resources`、`Models`、`Skills`、`Connectors`、`Knowledge sources`、`Components`；按钮 `Connect`/`Write`/`Manage`；状态词 `not granted`/`granted to 1`/`published`。
- 技能区里 **6 条上游英文技能**（`Check a claim against a source`、`Find a document`、`Find a Notion page`、`Research the public web`、`What changed recently`、`Who owns this`）与 **5 条品牌包中文技能**（代码审阅 / 在我电脑上跑 / 派活 / 造员工 / 造技能）并存 ⇒ **品牌包确实把技能同步进去了**（这是 024/003 的正向证据），但上游默认技能目录没有跟着本地化。
- 组件区 11 个 `published` 条目全英文名（Activity report、Checklist、Data table、Headline figures、Notice、Quotation、Record、Area/Bar/Donut/Line chart）——同一条纹：目录是平台的，`examples/qoderwake` 没覆盖它。
- `/plans` 的额度行也是英文拼出来的：`coworkers · tasks a month · machines · the deployment's models only`，而这一屏的标题/说明/按钮已是中文。
- `app/index.html:6` 的 `<title>OpenBot</title>` 依旧（每个页面的 RootWebArea 名字都是 `OpenBot`）。

## 14. 「点回声测试员没反应」的结论：**不是缺陷**，是旧标签页（附实测证据链）
排查顺序与结果（都在跑着的栈上实测，不是读代码猜）：
1. `agent-card.tsx:58` 用的是 `<Button render={<Link to="/agents" search={{agent}} />} />`；本仓 `ui/button.tsx:47` 确实实现 `render`（还有 `nativeButton` 的修正注释），所以不是"render 没生效变成裸 button"。
2. 页面里实测该节点的**真实 DOM**：`tag=A`、`href=/agents?agent=agent_a5fd297f-…`、`role=button`；`elementFromPoint` 在卡片名行/中部都命中这个 `A`（`::after` 覆盖层 `absolute/0px` 生效）⇒ **链接挂着、可命中、地址正确**。
3. `anchor.click()` 程序化触发后：URL 变 `…?agent=agent_a5fd297f-…`，`[role=dialog]` 数量 1，弹窗标题就是「回声测试员」。**导航与弹窗都是好的。**
⇒ 所以"点了没反应"的原因在我这边造成的环境状态：这一轮我把 `openbot-g2-server`/`openbot-g2-app` **重建过三次**，旧标签页的 vite HMR socket 与懒加载 chunk 指向已死的服务端，路由切换会**静默失败**。**刷新一次即正常**（Ctrl+R，或直连 http://localhost:3010/agents）。
- **教训（对本机走查通用）**：容器重启之后，先让用户/自己刷新页面再判"界面坏了"。不然会把环境状态报成产品缺陷——我这次差一点就这么写进工单了。

### 顺带拿到的验收证据：这一个弹窗覆盖 D5/D6/H2/C4/授权
`[role=dialog]` 内实测到的分区与文案（英文框架文案照旧是 024 未翻部分）：
- 分区块：**General / Persona / Access / Connection / Handoff / Routines / Manage** ⇒ 一个界面里同时给到了 **D5 员工详情**、**D6 人设**（Persona）、**H2 每员工模型绑定**（General 里的 "Assemble — Its mo…"）、**C4 routine**（Routines）、**授权**（Access）、**外部托管端点**（Connection，H6 的远程员工形态）。
- 内容实测：`Name 回声测试员` / `Title 派活路由验证` / `Role 不接模型，只用于验证 @ 派活是否把消息送到员工端点。` / `Visibility: Only you can see it and start channels with it. · Private`。
