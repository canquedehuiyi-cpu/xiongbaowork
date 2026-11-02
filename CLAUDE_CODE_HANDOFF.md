# Claude Code 开发交接入口

更新：2026-11-02。证据截点：2026-11-02 07:20:49 UTC。

> 用户已停止原 Codex 开发链，要求由 Claude Code 接手后续开发与修复；本 Root 会话改为独立验证、跟踪缺陷和验收。本文是交接，不是商业发布证明，也没有启动 Claude Code。
>
> 默认分支目前仍是旧基线。先读下面的版本表，禁止直接按旧 README 的启动、安装或部署示例开跑。

## 1. 先确认接手的代码

| 用途 | 分支/提交 | 应怎样理解 |
| --- | --- | --- |
| 仓库默认分支 | `codex/cloud-dev-baseline-20261018`，本次文档提交前为 `0089682e785d03fa67e8463bf862d2b94447392c` | 2026-10-18 的历史代码；本次只在此加交接文档，产品代码不升级 |
| 已采用修复的正式 Source28 | `668dd2238ff112bcff38ad2d0456dccd116874ed` | 既有实现不是零；2065 文件、50175181B、28 项修复。不能把 28 项修复当作原 18 个交付包完成 |
| 当前行政/证据主线 | `codex/cloud-repairs-recovery-20261028` → `3fda773c5a9743eb74e0f4a2e3a75039322f99b4` | 含行政发布记录；记录 D06 已保存不等于采用或实跑 |
| D09 配额契约候选 | `codex/d09-quota-contract-reviewed-20261101` → `4b367e3c0580128bc28c31ca9030f018db18cb06` | 父为 Source28；已全文独审、已保存 GitHub，未运行 |
| D06 自主工作候选 | `codex/d06-autonomous-summary-reviewed-20261101` → `2aacf0f19fdaaeeb4414d4ee4c09cef1f2fc7634` | 父为 D09，所以已包含 D09；已全文独审、已保存 GitHub，未运行、未整体采用 |

D06 提交的 Git tree 是 `ea48fde7a70474c5d51ad567e6cc6f9ffb063fb5`。若继续配额→D06验证，应先在获准云端检出并核对这个提交，列出与 Source28 的差异。不要同时盲目 cherry-pick D09 和其子提交 D06；不要因为分支名含 reviewed 就认定测试通过。

上述分支头在交接时已实读。后续 Claude 必须重新读实际 HEAD、工作区脏文件和并行写入者，建立自己的合法 owner/expected-head；旧 lease、epoch 和 GO 均不能继承使用。原云端唯一 writer 的旧绑定属于旧执行链，不是给新执行者冒用的身份。

## 2. 完整目标没有缩小

交付范围仍为 **77 个故事、18 个原交付包、7 道最终门**，全部必须在实际最终组合版本上验收。

- 权威范围：[完整原路线图](https://github.com/canquedehuiyi-cpu/xiongbaowork/blob/6bcabe68a8b2671859eaa0772bd38456ff3eb0c5/archives/recovery-20261028/COMMERCIAL-DELIVERY-FULL77-ROADMAP-20261030.json)，104593B，SHA256 `0fc19e00fc565257ca400b6e3c29d8ab41f906c289c6bb200158187b1e0b0e8b`，Git blob `a3685d5011b85d7daab14805baf813c22a9fb734`。
- 原始逐项要求、历史证据和门说明保存在该路线图列出的 `DELIVERY-SCOPE-77-18-7.json`、`CURRENT-GATE-SUMMARY.json`、测试证据 ledger 和 Source manifest 中。使用固定提交链接，不能从默认旧分支同名文件推定是最新版。
- [本次范围与状态快照](docs/handoff/2026-11-02-SCOPE-AND-STATE.json)逐字保留 77 条原需求、18 包映射和 7 门要求，并加入本次状态；它不替代原验收标准。
- [验证交付合同](docs/handoff/2026-11-02-VALIDATION.md)规定 Claude 交付什么、本 Root 怎样独立验证。
- Source 静态通过、测试定义数、局部测试、真实 PG、镜像、设备、真实模型/计费、商业验收是不同层。历史绿灯不能跨层继承。

| 原包 | 故事 | 附带门 | 当前口径 |
| --- | --- | --- | --- |
| D01 | 基础设施包，不能删除 | 3 | 待逐包最终验收 |
| D02 | 基础设施包，不能删除 | 1 | 待逐包最终验收 |
| D03 | J2, J3, J4 | 2 | 待逐包最终验收 |
| D04 | J1, J5, J6, G2 | — | 待逐包最终验收 |
| D05 | A1, A2, A3, A4, A5, A6, A7, A8, A9, B1, B2, B3, B4, I1, I2, I3, I4, I5, I6 | — | 待逐包最终验收 |
| D06 | C1, C2, C3, C4, AUT1, AUT2, AUT3, AUT4 | — | 待逐包最终验收 |
| D07 | D1, D2, D3, D4, D5, D6, D7, ROLE1 | — | 待逐包最终验收 |
| D08 | E1, E2, E3, E4, RES1, RES2 | — | 待逐包最终验收 |
| D09 | H1, H2, H3, H4, H5, H6, K1, K2, K3, K4 | — | 待逐包最终验收 |
| D10 | WF1, WF2, WF3, WF4, WF5, WF6, WF7, WF8, WF9 | 4 | 待逐包最终验收 |
| D11 | F1, F2, F3, F4, F5, F6, SEC1, DEV1 | 5 | 待逐包最终验收 |
| D12 | G1 | — | 待逐包最终验收 |
| D13 | 基础设施包，不能删除 | 3 | 待逐包最终验收 |
| D14 | 基础设施包，不能删除 | 3 | 待逐包最终验收 |
| D15 | 基础设施包，不能删除 | 3 | 待逐包最终验收 |
| D16 | WIN1 | 3 | 待逐包最终验收 |
| D17 | 基础设施包，不能删除 | 6 | 待逐包最终验收 |
| D18 | 基础设施包，不能删除 | 7 | 待逐包最终验收 |

| 最终门 | 原要求 | 当前口径 |
| --- | --- | --- |
| 1 | 同一最终SHA正式镜像8 GET 200且未知API404 | 未最终证成 |
| 2 | 未登录拒绝、跨租户私有资源404、无越权或拒绝后的上游调用 | 未最终证成 |
| 3 | 前后端全套测试无fail和Unhandled error，锁文件安装环境通过严格CI | 未最终证成 |
| 4 | WakerFlow实际生成-编辑-保存-执行-中止-查收及重启恢复 | 未最终证成 |
| 5 | 用户设备浏览器真实动作及离线重连、授权审批闭环 | 未最终证成 |
| 6 | 真实模型最小授权运行与正确计费 | 未最终证成 |
| 7 | Windows/Linux干净客户部署证据 | 未最终证成 |

## 3. 停工时已经做到了哪里

### 已推送且可直接在 GitHub 取到

D09 和 D06 两个候选如版本表所示已保存。D09 包含受限配额错误详情、兼容原两参数 RequestError、固定内部 `/plans` 导航，以及 app/server 回归定义；合法 0 与未知/非法值分开，不能把未知补成 0。D06 包含自主工作摘要/页面及回归修复，原 owner/channel、15 分钟下限、20 条启用上限等护栏保留。这些提交的状态都是 **SOURCE_REVIEWED_NOT_RUN**。

行政主线 `3fda773...` 保存 D06 发布说明，不是把 D06 合进正式 Source28。两份完整行政文件公开已经得到用户明确批准；这项批准不是部署、PG、测试或收费批准。

### 仅已审私有候选，不能当作仓库里已经存在

| 候选 | 停工时证据 | 未完成部分 |
| --- | --- | --- |
| H4 R3 | 8 件/419146B，Root+原不同作者全文静态通过；manifest SHA `df6aa4d9c1bb1b663d64f31f86923b833e7c754e6560f7804bd785e72d76ccc5` | 未实际执行、未 Git 采用；装配前必须核全件与当前 before |
| K2 用量观察 R3 | 4 件/66405B，85 个定义、0 执行；manifest `733a59964af6d0683aa16b2630659edbf29982e0e78a96739ac10488b56b3125`；双审静态通过 | 真实依赖/dist/传输/装配/运行和账本均未验证 |
| 员工创建配额提示 | 3 件/34428B、22 定义，manifest `13cd0308a4f46a151b9d1eff7a9c7aa48ffc95cd781f606893c7a2e4579a8269`，双审静态通过 | D05 11 叶最终装配 before/manifest 仍未闭合 |
| 模型接入配额提示 | 2 件/31140B、29 定义，manifest `cf097bfd4f9676436233ca3184452008526aa51e56005be28dc9db88901dbd47`，双审静态通过 | 未运行、未装配采用 |
| 流水线配额提示 | 2 件/36122B、30 定义，manifest `787b2fc16d4d9b183ffa5c65297be695361a416ae7c1e7141bef73db40d846bd`，双审静态通过 | 未运行、未装配采用 |
| DeepSeek classic/native 后续 | classic 96731B 候选交付字节已核；早期转换清理 P2 仍开放；native 暂停检查点另有已证风险 | cleanup 新测试尚未生成；不能把上游 6992B fixture 当项目验收 |

这些私有候选曾保存在会话 RAM/公开消息片中，**本次没有把其完整 Source 上传到仓库**。工具上下文切换后，Root 原 RAM 变量已无法读取；原 writer 的停工回执只证明当时保留，不能保证后续仍可取。Claude 必须先取得完整原件、规则、manifest 和真实 before 并自算；取不到时标记 unavailable，由 Claude 在已知 Git 基线上重新制备最小候选，再由 Root重新验收，不能套用旧 PASS 或旧哈希。不要花无限轮次重建缺失会话环境。

K2 只是默认关闭的 Claude SDK **receive-response-window** 观察旁路：只允许白名单数字、实际 thread/run 绑定、正常完成后最多一次；GPT 不调用 observer，7 项 UNKNOWN_USAGE 仍保持 undefined。它不是本 prompt 的 token 因果归属、CLI EOF、可聚合账本、估价或收费实现；禁止以任务数、字符数或 0 伪造 token。

### 已明确没有完成

当前没有本轮 Bun 身份验证、离线依赖安装、35 项配额/D06 CPU测试、D06 服务端 PG测试、完整 CI、正式镜像/设备/真实模型/计费商业验收。历史文件中的其他时点测试只能按原范围引用。

`ROOT_RELEASE=null`、`ready=false`、`AP_DISABLED`、`NOT_SERVICE_WIRED`、`migrationNOT_WIRED`、`PG_PENDING` 仍保留，不因交接解除。

## 4. 真实运行阻塞与已经关闭的支路

原 writer 的历史聊天可读、后来多轮 gpt-6.1-sol 开发可运行，但原两条 cloud child 的运行绑定及原工作区卷没有恢复成功。原路径 `/workspace/scratch/7cb3b5961ffa` 不是恢复句柄。已知目录/PID/socket/附件/旧 resume/服务归属等支路已经做过有界核查；不能重复扫描、造同名目录、改注册/历史/数据库、换账号或杀未知进程来宣称恢复。

用户另批准过一次有界替代实测：在原 writer 当前云端、固定 D06 提交建立隔离副本 `/root/xiongbaowork-d06-2aacf0f-isolated-test-copy`。它不是原卷/两 child 已恢复的证据，也不是 Claude 可无条件复用的运行授权。

停工前 R8 的实测已由 Root 与原独审直接核对两份完整安全原生输出：

| 操作 | 结果 |
| --- | --- |
| owned-control CAS 更新 | exit 0；1360… → runtime SHA `9040a8cbabd8332ead820f0467a87367d9e53bd595bd87a13abd239de0a7e610`；四件 Source pin、owner-last/fsync/readback、同 root/control 身份、锁、FD、cleanup/signals/pending 均符 |
| 固定 artifact 流程 | exit 5；`HTTP_STATUS_STOP_NO_RETRY` / HTTP403 / `TREE_DOWNLOAD`；只请求 tree，未到 Source archive/Bun/native stages |
| 输出凭证 | CAS 3244B/`d6073095ec62acde4fc0623dcf982a9a0177a0a05cf1d0db35542c67af95ee05`；artifact 4897B/`6f17d087ff326f2068001ae2ffe30bf26302cc8a9a89a08a480fdd8fe82bd801`；均未截断 |
| 额度/后续 | R8 本 GO **2/2 已耗尽**；不能重放。403 来源/原因未知，不猜成限流、权限或凭据问题。将来如确有真实恢复证据且 Source不变，只能另审 current9040 上的新 artifact-only GO，不重做已采用 CAS |

更早 R7 曾到达 `unpack_source`，但具体归档拒绝原因没有记录，永久保持 UNKNOWN。此次 R8 的 403 没有证明 R7 是哪一种 tar/mode 错误。不能依据猜想放宽解析、路径、模式、完整性或网络门。

隔离控制源码 R8 仅是私有测试基础设施，未发布到 GitHub。它的参数载荷当时含 NUL 131007B，距 131072B 上限只余65B；任何后续扩展都必须重新计量与审查，不准试长、压缩/编码/minify、换运输或偷偷删安全条件。

## 5. 安装资料 B 与测试调用 C 的确切停点

B 是“Bun/依赖准备”的资料和实现阶段，C 是“具体测试调用与断言”的阶段，不是新的商业故事编号。

停工前五份 Bun 固定版本实现原文已由原 writer 从可靠 RAM 重建再读 MATCH，Root及独审对照了完整 bytes/SHA/Git blob。最后的项目锁文件共有38片，仅第1–5片有实际 MATCH，第6片未通过校验而未收，第7–38未收。**B完整资料5/6，B实现候选与C调用候选都未完成，不能安装或运行。**

这些聊天分片不是 Claude 必须继续使用的运输方式：锁文件已在 D06 Git提交中，Claude 可在合法环境直接检出并重新核其453991B/SHA `c5b3f3c17b2159e033c7cf8911780b98d0ebeba93756e175e32064b15849e670` / Git blob `3482ff729f744a05ecd986478f34e0cb46dc6730`。不要继续向已经停工的 writer 投递剩余片。五份官方 Bun 源码位于 `oven-sh/bun@0d9b296af33f2b851fcbf4df3e9ec89751734ba4`，完整定位和指纹见状态 JSON；这不等于实际 Bun binary/dist 已装载。

## 6. 百度搭子报告已如何采用

报告名《熊宝数字员工_深度代码审计与商用交付差距报告》，SHA256 `e0d9d8082a37c79a43a41a08b2eebcf2eb87422495f6bdc84a4a72e2e29abd39`。其主要代码基线是旧 `0089682...`；“62%”是作者的 Python 风格质量评估，不是77故事商业进度。90条列项未全量重新验证。本次只对下列优先项做了固定2aacf源码核对和范围修正：

| 项 | 当前证据与 Claude 下一步 |
| --- | --- |
| G01 无人值守租户上下文 | Source缺口成立；8文件合同已准备、尚未实施：handoff-runner/wake-up/proactive engine+store/channel summary及3既有测试。可信tenant来自DB原记录，覆盖整个成功/失败/审计/通知/清理异步链，禁止payload猜tenant或默认回退；保50个既有测试定义和H3/H4门。CPU与PG分开 |
| G02 管理员自动提升 | Source缺口成立；配置邮箱匹配不能代替可信的已验证邮箱所有权。七文件最小合同见状态JSON；保普通SSO和人工角色，不把登录成功、provider存在或profile字段并集当组织权威；补注册成功审计时序/session检查/SCIM实际角色口径。尚未实施 |
| G03 目录/行ID/vault/broker/OAuth | Source缺口成立；逻辑key与物理ID/DTO须分立，custom物理ID也租户化；先收紧可信tenant caller/vault，再建tenant live唯一，最后撤旧global唯一。OAuth seal在真实认证框架内绑定受信tenant，callback核封装/TTL/用户仍有权后显式重入。全局broker退役默认不可达，旧suffix与远端成功本地回滚必须覆盖。未制作新迁移/未实跑PG |
| G04 外连/凭据 | 已确认有wrong-kind/provider/revoked和带凭据URL变更拒绝门，不能声称当前已泄露；DNS/redirect/SDK真实装载仍需受控验证。rowID与logical key误接统一并入G03，不造重复修包 |
| G05 渲染安全 | 实际Source有raw→sanitize→harden默认链；未证实stored XSS。真实dist/DOM/streaming/history回归仍缺，不盲目加第二层正则或把同名包文档当装载证明 |

J4最后两份补件已由原 Qoder 真正领取并完成，确认普通 guard 建用户tenant框架、sessionless callback不显式重入，且非broker seal的serverId已被目录校验为logical key；此前“已把任意physical ID当provider存token”的担忧已撤回。PG下功能断链/写归属仍为条件结论，未宣泄露实测。

**不要全局把 currentTenant() 的 system 缺省一刀改成抛错。** 先核合法平台/后台caller并显式建立受信scope，再让受保护凭据路径对缺框架failclosed；目录可读system不等于可读system secret。当前正式决策D12是用户与tenant一对一；未来team注释不是现有组织成员接口已实现的证据，不得夹带新增成员表/服务/授权架构。

## 7. Claude 接手后的顺序

1. 先回报实际 repo/branch/HEAD、工作区脏文件、可用资料和当前执行承载；与本交接的commit/pins对照。先静态读，不安装、不运行、不部署。
2. 选择明确的基线：正式Source28，或已审但未跑的D09→D06候选链。列出选择、差异和未合入私有候选，不能把Source28/2aacf/行政主线说成一棵树。
3. 处理真实执行前置，形成B依赖准备的完整可审Source/配置/精确调用，再形成C调用+断言候选；Root独审通过后才申请/使用适用的运行门。原环境缺口无需无限重扫，新的检出不能冒原环境恢复。
4. 在获准条件真实成立后，顺序：**quota app → quota server → D06 app → 独立真实PG门通过后D06 server**。详细命令与停止条件见验证合同。
5. 与上述测试解阻独立的Source修复可按G01/G02/J4最小包推进；每包≤8件，前包独审结束才下包。缺私有原件就明确重新制备新候选，不伪继承旧PASS。
6. 对完整77/18/7逐条补验收证据，修复后及时推送合法分支的确切commit/manifest。禁止把测试定义数累加成故事完成数。
7. 每个交付包把证据交回Root验证；Root发现的问题回给Claude同包修复，Root不同时成为该包代码作者。

## 8. 一直保留的边界

- 项目Source、依赖、测试和产物保持cloud-only；Root Windows仅文档/协调/证据核对。交给Claude不自动批准Windows宿主开发或执行。
- 不读取/回显真secret，不把DEEPSEEK_API_KEY当KEY_ENCRYPTION_KEY，不调用models/balance/testconnection或模型provider来探测；不消费赠额、不收费、不部署生产。
- 旧常规512MiB/swap0、DATA64MiB及具名例外各有范围；旧共享8GiB例外是指定原writer/隔离副本的一次有界方案，不可转成任意新进程/机器预算。其swap无硬上限，样本0不能说硬swap0，full sumRSS尚未满足。
- 特定平台metadata试验3/3已耗，禁止第四次/rerun/变体/新epoch变名重置；这与普通只读Git元数据查询不同。Codex订阅一次重置已记录使用，本交接不授第二次。
- 原GO、lease、released epoch不可复用；不reset/clean/删除其他工作、卷、资料或历史；不force push，不盲目重放未知结局的旧写操作。
- 原生Goal最后由用户清除，不重建，不宣商业完成。旧xiongbaowork自动任务在当前应用更新时返回不存在，未重建；停工命令已发给原writer/独审和原协调板。若其他旧调度仍投递开发指令，应以用户停工/本交接为准，不恢复开发链。
- 旧房间清理/长任务行政完成不等于代码实现或商业验收。唯一协调室仍为“xiongbaowork｜77故事18包7门｜云端协作”；WorkBuddy/Qoder沟通只走板，不发应用私聊。

## 9. Root今后的验收职责

Claude每次交付应给：精确commit/parent及diff、≤8文件清单与哈希、实际运行环境和依赖、原始测试退出码/失败名/Unhandled、PG/安全门、仍开放项、回滚点。Root独立取Git内容核对并在适用门内复验，给出PASS/CHANGES_REQUIRED/BLOCKED及范围。未授权或未满足门的项标NOT_RUN，不能用stub、关闭preload、重建实例绕缺陷、安装脚本或改断言数量造通过。

本次文档只完成角色与状态交接，不代替Claude开发完成，也不代替最终商业验收。
