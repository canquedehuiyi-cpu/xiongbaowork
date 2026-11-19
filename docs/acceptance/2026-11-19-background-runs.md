# 期九·六 验收：员工后台长跑

规格：`docs/specs/2026-11-19-employee-background-runs.md`（§5 期九·六、§6 验收标准）。

部署开关：`XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS`（`on` / `off`，当前默认 `off`）。本文件只记录验收，**不改默认值**。

状态：骨架。「待跑」的行在对应评测或手动验收跑完后填写。

## 1. 验收标准（规格 §6）

| 标准 | 怎么验 | 结果 |
|---|---|---|
| 能力冒烟 `disconnect`「中途断开网页仍完成」：HTTP 客户端发起单聊轮，收到第一个工具调用后断开，之后只轮询线程和产物；产物齐全且正确，线程里有完整的工具调用和结果，没有「没有执行」，这一轮以完成结束 | 模拟模型版：CI 作业 G8 的场景 A（`xiongbao/scripts/e2e/background-chat.ts`）。真实模型版：场景 `disconnect`（`xiongbao/scripts/e2e/employee-eval/smoke.ts`，题面、夹具和校验脚本在 `smoke-background.ts`：写词频统计小程序、加测试并跑通、生成报告文件，要 8 次以上工具调用，预计 3～5 分钟；校验脚本退出码 0 才算产物对）。触发：手动运行 `model-e2e.yml`，`suite` 选 `capability-smoke`（或 `all`），`scenarios` 填 `background`（也可填 `disconnect`）。判分：校验脚本退出 0；线程里每个工具调用都有结果、没有一条写着「没有执行」、断开之后又有工具调用；这一轮以完成结束（`thread_run_liveness` 为 `finished`、事件里有 `RUN_FINISHED`、没出错没触顶）。断开后只轮询线程，上限 12 分钟 | 模拟模型版见 §2；真实模型版待跑 |
| 九·五之后，`disconnect` 还要求记录了一条完成通知 | 已在 `disconnect` 的判分里：线程所属人有一条完成通知记录，即 `delivery_outbox` 里去重键为 `reply:turn-end:<运行号>:…` 的 `reply` 行（只有本人有推送设备或绑定的聊天平台时才会记；评测账号什么都没有，所以脚本先给本人记一个假令牌的推送设备，只写这一行，不配推送服务、不往外发） | 待跑 |
| 能力冒烟 `reconnect`「断开后重连续上流」：同一任务，断开 30 秒后重新连接，收到后续事件直到运行结束，且和落库的事件一致 | 模拟模型版：G8 场景 B（断开后等 3 秒重连，对比重连拿到的流和结束后回放的流）。真实模型版：场景 `reconnect`（同一份题面和校验脚本），收到第一个工具调用后断开，等 30 秒，用 `/agent/:id/connect` 重连。触发同 `disconnect`（`scenarios` 填 `background` 或 `reconnect`）。判分：重连时这一轮还在跑；重连后收到后续事件（调用数比断开时见过的多）直到运行结束；重连拿到的流里的调用、结果、回答，和这一轮结束后再回放一次的结果一致；校验脚本退出 0 | 模拟模型版见 §2；真实模型版待跑 |
| 对标评测：`run-xiongbao.ts` 加执行路径选项（如 `EVAL_PATH=chat`），五道题走单聊接口再跑一遍；完成率不低于看板路径那一遍，墙钟、步数、token 同量级；两遍结果并排写进本目录 | 脚本：`xiongbao/scripts/e2e/employee-eval/run-xiongbao.ts`，`EVAL_PATH=board\|chat`（默认 `board`，行为不变）。触发：手动运行 `model-e2e.yml`，`suite` 选 `employee-eval`，`paths` 选 `board,chat`（依次跑两遍）。见 §3 | 待跑 |
| 底线回归：现有审批、权限、SEC1、只读目录、设备模式的测试全绿 | CI 的 `server-test`（全量） | 待跑 |
| 底线回归：服务器执行时，写操作出审批卡，批准后服务器执行并续跑，拒绝后员工收到拒绝 | 服务器测试（期九·一、九·三已有用例），CI 全绿 | 待跑 |
| 底线回归：关掉的工具不提供给模型 | 服务器测试（`chat-server-tools.integration.test.ts`），CI 全绿 | 待跑 |
| 底线回归：接管期间员工动作被拒 | 服务器测试（`computer-waits.integration.test.ts`），CI 全绿 | 待跑 |
| 底线回归：新旧前端各跑一次，同一个工具调用只执行一次 | 服务器测试：不带声明的运行仍交给浏览器；带声明的运行由服务器执行（`chat-server-tools.integration.test.ts`），CI 全绿 | 待跑 |
| 真机手动验收（界面期截图给用户）：网页发一个约 15 分钟的任务，关掉标签页，手机锁屏，收到推送，打开对话，能看到每一步（命令输出、页面截图、计划清单） | 手动，依赖九·四、九·五 | 待跑 |
| 全部 CI 绿，main 上已有的断言不改 | 本分支的 CI 运行 | 待跑 |

## 2. 冒烟 A、B、C（模拟模型，HTTP，不开浏览器）

脚本：`xiongbao/scripts/e2e/background-chat.ts`；CI 作业：`G8 background chat (HTTP, mocked model)`（作业 id `e2e-background-chat`）。

起一个开着 `XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS=on` 的真服务器和自己的 PostgreSQL，模型是 aimock，电脑是脚本里的一个固定替身（CI 机器上没有电脑）。每一轮都带 `forwardedProps.computerTools="server"`。客户端是 `fetch`：发运行请求、读事件流、按场景挂断。

| 场景 | 做什么 | 检查什么 | 本机结果 | CI 结果 |
|---|---|---|---|---|
| A 关页也跑完 | 模型先调两次 `computer_run_command` 再回答；客户端在第一个工具调用后、命令还在执行时挂断，之后只读线程 | 线程里两个工具结果都已落库；没有「没有执行」；回答已存下；两条命令各只执行一次；模型只被问了三次；之后不再有新执行 | 通过（2026-11-19，约 3 秒） | 待跑 |
| B 重连接上直播 | 同一轮，挂断后等 3 秒，用 `/agent/:id/connect` 重新连上 | 重连先回放断开前已有的工具调用，且此时命令仍在执行；之后的第一个工具结果、第二个工具调用、回答全部作为直播收到，流以运行结束收尾；重连拿到的流和运行结束后再回放一次的流，调用、结果、回答一致；重连没有触发任何重复执行 | 通过（2026-11-19，约 4 秒） | 待跑 |
| C 重启标记中断 | 命令执行到一半时 SIGKILL 服务器，再启动 | 这一轮在 `thread_run_liveness` 里是 `interrupted`；线程里有中文说明（「服务重启了，这一轮在中途被打断…请回复「继续」」），正在执行的调用被答复为「系统没有重新执行它」，回放里有 `turn-interrupted` 事件；重启后电脑没有再收到任何命令，模型没有再被问，没有编造回答 | 通过（2026-11-19，约 46 秒，其中约 35 秒是等真实的恢复扫描） | 待跑 |

说明：
- 规格里 `reconnect` 写的是断开 30 秒，模拟模型版缩成 3 秒以缩短作业时间，走的是同一条代码路径；真实模型版按 30 秒跑。
- 场景 C 不改任何数据来等恢复，等的是产品自己的扫描（心跳过期 30 秒、每 15 秒扫一次）。
- 电脑替身只证明「服务器这一侧」：运行接口、工具清单、执行工具的中间件、网关和审批门、落库、重启恢复。真实电脑上命令本身的行为不在这里验。

## 3. DeepSeek 对标评测

状态：待跑。评测跑完后在本节填表。

做法：`xiongbao/scripts/e2e/employee-eval/run-xiongbao.ts` 用 `EVAL_PATH=chat` 让同样的五道题走单聊接口，和 `EVAL_PATH=board`（默认，原来的看板派活）那一遍并排，模型用 DeepSeek。基线是首轮 run `44461106077`（Codex，DeepSeek，`wire_api="responses"`）。

单聊路径怎么跑：服务器带 `XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS=on` 起；每道题给同一个新员工开一段单聊（`POST /api/channels`），客户端用 HTTP 发运行请求（运行接口 `POST …/agent/:id/run`，`forwardedProps.computerTools="server"`，和页面发的一样），把事件流读到这一轮结束，不开浏览器，电脑工具由服务器执行。没做完时以本人身份在同一段对话里发「继续」，规则和看板路径一样，最多 3 次，记在 `nudges`。每题墙钟上限不变（`EVAL_TASK_MINUTES`，默认 20 分钟）。拷产物、判分、算指标和看板路径是同一套代码；办公题里「任务卡进入等验收」只在看板路径查，单聊路径没有这张卡，标为不适用，不算失败。

怎么触发：GitHub 上手动运行 `model-e2e.yml`（只能在 main 上），`suite` 选 `employee-eval`，`paths` 选 `board,chat`（只跑单聊选 `chat`），`tasks` 默认 `all`（五道题）。两遍的结果在同一个结果目录：看板 `xiongbao.json`、单聊 `xiongbao-chat.json`（产物分别在 `xiongbao/`、`xiongbao-chat/`），记录里有 `path` 字段；`employee-eval-report` 作业出并排表（`report.md`），表里有「单聊路径 vs 看板路径」一节，列出下面这张表要的数字，Codex 基线列照旧。本机命令（假模型，只验流程）：`EVAL_LOCAL_MOCK=1 MODEL_E2E=1 EVAL_PATH=chat E2E_DATABASE_URL=… E2E_ROLE_WRITER_DATABASE_URL=… bun scripts/e2e/employee-eval/run-xiongbao.ts`。

每道题、每条路径各填以下数字：

| 项 | 看板路径 | 单聊路径（`EVAL_PATH=chat`） | 基线 run 44461106077 | 备注 |
|---|---|---|---|---|
| 通过率（通过题数 / 5） | | | | 要求：单聊路径不低于看板路径 |
| token（输入 / 输出 / 缓存命中） | | | | 要求：同量级 |
| 步数（模型调用数） | | | | 要求：同量级 |
| 墙钟（每题 / 合计） | | | | 要求：同量级 |
| 是否中途停（到 25 分钟或段数上限停下的题数，和停在哪一步） | | | | |
| 计划的使用（是否建了计划、更新了几次） | | | | |
| 子代理的使用（是否派了子代理、派了几个） | | | | |

要求：评测记录里的每个数字都能在评测输出目录里找到对应的记录。和基线 run 的差别要写明原因（路径、模型版本、题目是否一致）。

## 4. 结论与下一步

结论：待 §1 的每一行都有结果后填写。

用户确认后再把 `XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS` 改成默认开。
