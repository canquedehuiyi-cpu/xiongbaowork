# 云端恢复与验证状态（2026-10-28）

目标仓库：[canquedehuiyi-cpu/xiongbaowork](https://github.com/canquedehuiyi-cpu/xiongbaowork)。
完整交付目标仍为 **77 故事、18 包、7 门**，商业交付尚未完成。

## 当前恢复与已采用修复

- V57全部195项修复（25修改/170新增/0删除，原载荷15,019,196字节）已恢复，原清单419227字节/SHA256 `81de447073617989a55883fbc9d07d02ac0f6de2f806c98f5702dd5bcdf7a920` 保持不变。
- 原V57的2045清单文件、48,435,806字节已完整物理核验。
- 其后5个包均经同一名非作者独审、Root精确采用及采用提交上的重新验证：AP-INPUT-BUN三文件、AP-SCHEMA-RUNTIME五文件、KNOWLEDGE-RESOURCE-RUNTIME五文件、AUTOMATION-FK单测试文件、SECURITY-FK单测试文件，共15项主体文件修复。
- 当前受清单覆盖的 **2045文件、48,463,600字节**，已按原V57清单加5个明确批准overlay在Linux云端核验：完整大小/SHA256、文件权限、无符号链接、单链接、FD与路径稳定性均通过。
- 最新完成该核验的主体提交：[e7bc10395277baf9133690e6d3d852c3cfcac25b](https://github.com/canquedehuiyi-cpu/xiongbaowork/commit/e7bc10395277baf9133690e6d3d852c3cfcac25b)。
- `CURRENT-SOURCE-EXPECTED-MANIFEST.json` 给出当前完整预期记录，424212字节/SHA256 `79edba3a1a8c1ad7421ce8fc5eb42ab2c048ac967c5ca71bc9102f8e5902ae61`。这是基于原清单及5个批准overlay的派生清单，原V57身份不被改写。
- 恢复分支：[`codex/cloud-repairs-recovery-20261028`](https://github.com/canquedehuiyi-cpu/xiongbaowork/tree/codex/cloud-repairs-recovery-20261028)。默认分支仍保留原Gitee导入基线；旧Gitee README单独保留。

## 运行与审查证据

不同提交与范围分列，不合并冒称同一提交完整CI：

| 范围 | 结果 | 云端运行 |
| --- | --- | --- |
| JSON codec/header/wire/crypto四组件 | 105 pass / 0 fail / 1224 expects | [40647799132](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40647799132) |
| AP输入三文件，独审采用后同提交重验 | 64 pass / 0 fail / 848 expects | [40654934850](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40654934850) |
| 续执行协调器，模拟持久化接口 | 22 pass / 0 fail / 101 expects，网络0 | [40651075475](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40651075475) |
| AP2/AP4/执行域五文件，独审采用后重验 | 54 pass / 0 fail / 1126 expects | [40659665549](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40659665549) |
| 知识/资源五文件R2，独审采用后重验 | 58 pass / 0 fail / 2371 expects | [40665619882](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40665619882) |

每包的独审、批准overlay、候选与集成运行回执分别保存。AP-SCHEMA原9fail及r1的2fail保留；知识/资源原20fail、R1 FIX_REQUIRED、两次120秒停止及15秒FK诊断停止均保留。
Root新增测试曾误调用pinned Drizzle ExtraConfigColumn自递归的getSQLType，R2已改为唯一原生列身份映射并通过复审；该历史不清除。

## 同一提交组件重验与当前继续工作

五包批准后，在主体提交 `e7bc10395277baf9133690e6d3d852c3cfcac25b` 上统一重跑33个明确测试文件（独立Bun进程、无原repo preload），实际 **576 pass / 0 fail / 8919 expects**，33文件全部完成、exit0：[运行40670272087](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40670272087)。
此为同一提交组件范围通过，不等于完整CI、原preload、PG17、生产接线或77/18/7交付。

- 自动化/Flow8文件：109/0；原107/1保留。安全/Flow源8文件：97/0；原95/1保留。身份/谱系4文件：67/0。上述分组均包含于同一33文件集成运行。
- 本地FK ExtraConfigColumn与原生列比较问题分别在两个单测试包修复，完整生产schema、SQL、RLS、旧oracle/hash、snapshot/journal与安全负例保持；同一独审员分别完整全文读审通过。
- 最初Source64MiB OOM运行40664999884、分批无阶段输出十分钟停止40666293935均保留。显式从目标Git树取对象ID，按32文件/2MiB预取并fsync后，74批完成且同一64MiB硬门通过。
- 完整原锁文件workspace安装已实际尝试一次：[40670946955/job122757246700](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40670946955/job/122757246700)。私有缓存/copyfile/网络并发1/忽略全部生命周期脚本；64MiB安装门下10.333秒后systemd `oom-kill`、main SIGKILL9，Actions步骤exit1。自动日志peak64.4M保留，不冒始终低于门；项目512MiB/swap0未放宽。安装后包/锁完整性与依赖审计未到达，原preload、类型、完整CI均NOT_RUN。此前576/0同提交组件结果独立保留。该64MiB失败历史完整保留。人类随后明确批准仅完整依赖安装阶段512MiB；本次按该具名例外继续，其他DATA仍64MiB，项目及后代512MiB/swap0、免费、私有缓存/copyfile/禁全部生命周期脚本不变。
- 原严格CI冻结基线03df9efa29cc51b64bd4a7b695dcb977ac0869f6在已导入历史中未取得；不会用当前分支或0089682冒替。原CI工作流还含不受原项目总门约束的并行/容器任务，未直接触发。

完整依赖安装随后成功：[40672999809/job122764245052](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40672999809/job/122764245052)。原锁文件和6个包文件前后哈希相同；普通文件127738、符号链接3870，hardlink0、私有路径之外链接0；copyfile/私有缓存/全部生命周期脚本未运行。安装阶段按人类具名例外512MiB（实际peak511.8M）、其他DATA仍64MiB，项目总512MiB/swap0。原64MiB OOM与首次512MiB240秒timeout保留；进度日志/并发4/480秒时限后的实际耗时160.775秒。缓存及依赖位于该临时Linux作业，不冒持久Codespace已有该环境。

下一步保留原bunfig中的server/app两预加载脚本，用完整依赖跑35个明确命名文件（已有33组件加2个启动/受限写入生命周期CPU注入用例）。这不是全套preload、类型、完整CI或PG17验收；均另证。

原始预加载子集实际通过：[40674048676/job122767800762](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40674048676/job/122767800762)，35文件全部完成，**621 pass / 0 fail / 9151 expects**，没有Unhandled error。原bunfig及server/app两个预加载脚本保持，完整冻结依赖安装PASS。原自动日志安装peak512.5M、测试peak466.6M逐字保留；验证的是实际配置的512MiB聚合门/swap0，不冒历史从未出现瞬时超门。全套preload及完整CI仍NOT_RUN。

下一步7个任务看板文件使用受控fetch夹具和原app预加载，并单独检查原server TypeScript配置（原配置不包含tests，不修改其include来伪装覆盖）。源码不改，测试120秒/单例5000ms、类型120秒、项目及后代512MiB/swap0，完整依赖安装仍只使用人类具名512MiB例外；Source/下载/其他复制64MiB保持。

七个任务看板文件已实际通过：[40675320033/job122772122184](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40675320033/job/122772122184)，**58 pass / 0 fail / 596 expects**。范围为原app预加载、Happy DOM、真实路由/查询/组件配合受控fetch夹具；不代真实浏览器/设备、后端写入或A故事完整验收。

同作业原server tsconfig由TypeScript5.9.3在Bun承载执行，120秒到时exit124，CPU223.916秒/peak509.2M，未输出编译诊断；不是类型通过，也没有已确认类型错误。下一次仅改用原tsc shebang对应的stock云端Node运行方式，300秒时限，Node oldspace384MiB为额外堆控制，真实project及后代512MiB cgroup门/swap0保持，不用堆限制冒整体门。其他阶段资源门及具名安装例外不变，源码0修改。

## 持续边界与待验项

- 本轮项目源码、patch、archive、JSON、依赖和项目执行均云端；Windows无项目源码写入/执行，仅保存获准无源码UI PNG。
- 免费标准Linux Actions；项目与后代总内存512MiB，DATA/下载/复制64MiB，swap0；无hardlink、共享可写依赖或付费provider探测。
- Bun1.3.14+0d9b296af；schema测试仅用原lockfile固定Drizzle0.45.2并验证SRI，不冒完整workspace安装。
- 原preload全套、类型编译、完整CI、原生PG17、生产接线、镜像、真实UI、真实计费和客户交付分别待真实验证。
- PG_PENDING、AP_DISABLED、NOT_SERVICE_WIRED、migration NOT_WIRED、ROOT_RELEASE=null、ready=false保留。
- V58仍未采用，原51表恢复46/51的余5不能由新增协议表替代；历史审计事件与缺证保留。
- 专用Codespace最后可见为重连；当前完整物理验证来自Linux Actions，不声称持久Codespace已快进。
