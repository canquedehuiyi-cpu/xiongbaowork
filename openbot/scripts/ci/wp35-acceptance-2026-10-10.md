# WP-3.5 独立复跑与补修（2026-10-10）

基线为合并后的 `b27abda7b85ed79970cfebe8043679b1715fb396`，分支为
`codex/a-suite-load-isolation`。功能与测试修复提交为 `2a2fab6`、`35091ce`、`293c374`。
验收使用 Bun 1.3.14、独立 Docker 网络、新建 PostgreSQL 测试容器及测试库；测试连接使用
`openbot_app`，实查 `rolsuper=false`、`rolbypassrls=false`。没有使用原有开发库或客户数据。

## 修复及证据边界

1. `local-threads.test.ts` 改用已有的 `testDatabaseUrl()` 缓存辅助函数和 `TEST_POOL`，移除
   `DATABASE_URL` / 应用 `.env` 回退，并在清理后关闭连接池。修复前，删掉 `DATABASE_URL`
   再装载该文件得到 `13 pass / 1 fail / 1 error`，线程文件无法注册测试。
   新增子进程 preload 真正打开一次数据库连接，让 `createDatabase()` 删除该变量，再运行线程文件，
   断言 **5 pass / 0 fail / 1 file**。当前文件实际有 5 项测试，而非交接文字所说的 4 项。
   另有全目录检查，防止集成测试重新直接读取可变的数据库环境变量。
2. `server-tests.list.txt` 固定 309 个文件，`server-shards.mjs` 按连续行号分为六片。
   每次执行先核对清单与当前 head 文件树；新增、删除、重复或乱序均明确拒绝。
   head 与冻结 baseline 使用同一 head 清单，baseline 仅跳过当时尚不存在的文件。
   每个日志旁同时输出 `.log.files.txt`，记录实际交给 Bun 的文件。
   原 CI 的 `test-report.test.mjs` 入口已接入五项分片辅助测试；共 **8 pass / 0 fail**。
3. 清扫测试的临时收窄与清扫事务明确使用平台作用域，并始终回滚。
   新用例在另一个租户作用域中运行，混入该租户的一条陈旧附件：旧框架清扫得到 0 行，
   修正后得到 3 行、4 条删除语句；回滚后该外部行及本用例的三行均仍存在。
   原报告的“4 批变 3 批”在本次初始独立库中没有重现，不能将它直接定性为这一作用域缺口。
   本次证明的是夹具收窄与恢复不依赖调用者租户，以及最终套件在同一库上的稳定性。
4. 两轮验收额外发现 `device-queue.test.ts` 的发送与落库竞态：第三帧已发送时，最后一条
   `queue.finish()` 可能尚未提交，断言 `pending=0` 实得 1。现在轮询同时等待三帧和数据库积压清零，
   原顺序、空队列断言保留。单文件在同一库连续三次均为 **4 pass / 0 fail**。
5. 独立镜像验收发现首帧 HTML 标题仅为“数字员工”，与交付门禁要求不符。
   此项独立于 WP-3.5，单独提交初始标题“熊宝数字员工”；运行后的标题仍由品牌包提供。
   修正后重新构建并执行原镜像验收脚本，未放宽品牌断言。

## 最终验收

新库 `openbot_wp35_acceptance` 上六片顺序执行两轮，中间未重置数据库。
两轮各为 **4245 pass / 0 fail / 16 skip / 4261 tests / 309 files**；每片 N/M、pass/skip/fail 和
实际文件清单均逐项相同，装载错误与连接槽错误为 0。`acceptance/summary.json` 保存各日志 SHA-256
及机器断言结果 `identicalShardCounts=true`。

| 分片 | pass（两轮一致） | skip | Ran N tests | across M files |
| --- | ---: | ---: | ---: | ---: |
| 1 | 776 | 0 | 776 | 51 |
| 2 | 1329 | 5 | 1334 | 52 |
| 3 | 508 | 0 | 508 | 51 |
| 4 | 708 | 0 | 708 | 52 |
| 5 | 536 | 11 | 547 | 51 |
| 6 | 388 | 0 | 388 | 52 |

app 全量为 **1142 pass / 0 fail / 153 文件**；全项目 lint 检查 1339 文件通过，四个 workspace
的 typecheck 均通过。最终改动文件的 Biome 检查及 shell 语法检查通过。

镜像 `openbot:codex-wp35-022d` 的摘要为
`sha256:e9891fc9aa6ca0674cfe3396e1e2a3bb2e0138473233b24b8dfe06a87a56941c`。
17 秒内健康，品牌 HTML / 主 JS、普通运行角色、600 口令文件、崩溃重建后的数据与口令保留、
旧卷新增应用角色口令及 owner 角色启动拒绝均通过；**IMAGE failed command checks=0**。
九条租户隔离与免费档配额 HTTP 断言通过，**provider calls=0**。
Windows 主机没有 Bun，镜像 smoke 脚本中纯 JavaScript 断言由 Node 24 执行；应用和测试仍运行
镜像内的固定 Bun 1.3.14。镜像内 `server/src`、`shared`、`examples` 的 331 个文件与工作树 SHA-256
逐一一致。

## 复跑方法

在 `openbot/`，显式设置指向独立库的 `TEST_DATABASE_URL`，使用 owner 连接完成迁移后切回
`openbot_app` 测试连接。测试进程不要挂载或读取真实应用 `.env`。
本地与 CI 都以 `scripts/ci/run-tests.sh` 为验收入口；旧 `.scratch/` 中动态 `split` 的脚本不用于签署。

```bash
# 新增或删除测试后，更新并提交清单；正常复跑不会自动改写清单。
bun scripts/ci/server-shards.mjs --write
bun test scripts/ci/test-report.test.mjs

# 两轮使用同一数据库；中间不重置、不删库。
for round in 1 2; do
  for shard in 1 2 3 4 5 6; do
    DATABASE_URL="$TEST_DATABASE_URL" \
      bash scripts/ci/run-tests.sh "$PWD" server \
      "$PWD/verify-wp35/round-$round-shard-$shard.log" "$shard" "$PWD"
  done
done
```

Docker 挂载需覆盖当前源码和配置，保留镜像内依赖：`server/src`、`server/tests`、`server/scripts`、
`server/drizzle`、`server/bunfig.toml`、`shared`、`examples`、根 `scripts` 与 `bunfig.toml`；server
预加载还需要 `app/tests`。app 全量挂载 `app/src`、`app/tests`、`app/package.json`、**`app/bunfig.toml`**，
以及上述共享源码。漏挂 bunfig 会使测试实际加载的预处理与当前工作树不同。

每片的 `Ran N tests across M files` 两轮必须一致，M 还必须等于 `.log.files.txt` 的行数；
日志要有完成摘要、0 fail，且没有装载错误或连接槽错误。失败日志不覆盖，重新验收使用新的证据目录。

## 记录位置与仍未签署的门禁

本机原始记录保存在 `C:\Users\canqu\.codex\tmp\wp35-022d\`：
`before-focused.log`、`sweep-isolation-before.log` / `sweep-isolation-after.log`、
`device-focused-{1,2,3}.log`、`app-final.log`、`lint.log`、`typecheck.log`、
`image-build-final.log`、`image-smoke-final.log`、`image-final/` 和最终 `acceptance/`。
初轮并行构建时附件下载时延断言实测 43ms（门限 40ms），以及后续设备队列竞态的失败记录，
分别保留在初始根目录和 `final/`，不计入最终接受结果。

远端 `main` 的 `b27abda` 最近一次运行
[38038629959](https://github.com/xiongpinji/xiongbao-Wake-/actions/runs/38038629959)
的唯一失败 job 是 image；日志明确为首帧 HTML 缺品牌名，与本次独立镜像复跑一致。
本记录证明本地验收；**DoD-1 仍须 main 上的 CI 验收**。工作流的阶段性 job 级
`continue-on-error` 尚在，main 也未启用保护，这属于 WP-3.4，不能把成功的 job 标签作为全绿签署。
实际模型、客户环境和平台端验收仍属于各自的后续门禁。
