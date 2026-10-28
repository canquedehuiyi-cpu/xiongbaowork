# 云端恢复与验证状态（2026-10-28）

目标仓库：[canquedehuiyi-cpu/xiongbaowork](https://github.com/canquedehuiyi-cpu/xiongbaowork)。
完整交付目标仍为 **77 故事、18 包、7 门**，商业交付尚未完成。

## 当前恢复与已采用修复

- V57全部195项修复（25修改/170新增/0删除，原载荷15,019,196字节）已恢复，原清单419227字节/SHA256 `81de447073617989a55883fbc9d07d02ac0f6de2f806c98f5702dd5bcdf7a920` 保持不变。
- 原V57的2045清单文件、48,435,806字节已完整物理核验。
- 其后8个恢复/兼容修复包均经同一名非作者独审及Root精确采用，共27个不同主体文件：前五个兼容包、K106六文件、Ptx两文件，以及0107剩余三表六文件显式快照重建包。前6包及第8包有组件/结构测试；Ptx仅SourceOnly采用，15项PG17定义未运行。0107是按冻结完整对象新重建，不冒原ORM/SQL找回；8个修复包不等于18个交付包完成。
- 当前受清单覆盖的 **2054文件、50,007,029字节**，已按原V57清单加8个明确批准overlay在Linux云端核验：完整大小/SHA256、文件权限、无符号链接、单链接、FD与路径稳定性均通过。
- 最新完成该核验的主体提交：[78c2b4328481a7234bb36f7a7f178f0efa07b71d](https://github.com/canquedehuiyi-cpu/xiongbaowork/commit/78c2b4328481a7234bb36f7a7f178f0efa07b71d)。
- `CURRENT-SOURCE-EXPECTED-MANIFEST.json` 给出当前完整预期记录，430544字节/SHA256 `8c991de3ff7f91e1d37c0a0b943e631d7825b1a1cd11a862caf25bce9ca41433`。这是基于原清单及8个批准overlay的派生清单，原V57身份不被改写。
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

原始预加载子集实际通过：[40674048676/job122767800762](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40674048676/job/122767800762)，35文件全部完成，**621 pass / 0 fail / 9151 expects**，没有Unhandled error。原bunfig及server/app两个预加载脚本保持，完整冻结依赖安装PASS。原自动日志安装peak512.5M、测试peak466.6M逐字保留；验证的是实际配置的512MiB聚合门/swap0，不冒历史从未出现瞬时超门。全套preload及完整CI仍NOT_RUN。

七个任务看板文件已实际通过：[40675320033/job122772122184](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40675320033/job/122772122184)，**58 pass / 0 fail / 596 expects**。范围为原app预加载、Happy DOM、真实路由/查询/组件配合受控fetch夹具；不代真实浏览器/设备、后端写入或A故事完整验收。

同作业原server tsconfig由TypeScript5.9.3在Bun承载执行，120秒到时exit124，CPU223.916秒/peak509.2M，未输出编译诊断；不是类型通过，也没有已确认类型错误。下一次仅改用原tsc shebang对应的stock云端Node运行方式，300秒时限，Node oldspace384MiB为额外堆控制，真实project及后代512MiB cgroup门/swap0保持，不用堆限制冒整体门。其他阶段资源门及具名安装例外不变，源码0修改。

服务器Node检查：[40676314709/job122775533054](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40676314709/job/122775533054)。实际Node24.22.1 + TypeScript5.9.3在辅助oldspace384MiB处V8 heap OOM/SIGABRT6（controller return-6、步骤exit250），不是kernel cgroup OOM，peak466.6M；类型未完成，无编译诊断。旧RESULT错误保留Bun host标签，START/真实command/stack均Node；新控制器已更正标签，旧日志不改。将去除自设heap限制，仅在原512MiB聚合硬门内作一次原Node默认堆检查，不再提高项目资源。

同一独审员已完整审冻结b0bc8b51…的578行36722B控制器，CONTROL_REVIEW_OK，Source五overlay/实际cgroup/具名安装例外/禁脚本/私有链接审计/步骤顺序/环境白名单无阻断；不计新主体包采用，也不覆盖后续Node差异。

K106六历史after已通过Pages正常连接器按原ref取回、严格base64/gzip/CRC/ISIZE/raw SHA/Git blob/LFCR核验，原样归档在[历史未采用目录](https://github.com/canquedehuiyi-cpu/xiongbaowork/tree/codex/cloud-repairs-recovery-20261028/archives/recovery-20261028/K106-HISTORICAL-NOT-ADOPTED)，归档提交6970f22792c221bbdc825bfca95586aa477cfa89。4NEW在当前manifest/Git树ABSENT，2MOD完整before SHA/blob吻合，snapshot去新增2表和idprev后逐字还原旧150表及未知tops，journal0..105与全部tops、barrel唯一新增行inverse全核。上述是历史归档阶段；原六leaf历史字节保持归档，当前父修订候选及独审采用另列，不追认旧V58，不清旧FD/cache/机制红。

Node 默认堆检查已实际停止：[40678526201/job122782977940](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40678526201/job/122782977940)。实际 host Node v24.21.0、TypeScript5.9.3，未设置NODE_OPTIONS或额外oldspace限制；仍在512MiB project及后代cgroup/swap0内发生V8 heap limit/SIGABRT6，Python child return-6、Actions步骤250，测试阶段peak356.5M。不是类型通过或类型诊断；同一作业的冻结依赖安装PASS，自动peak513.5M原样保留。更早一次384MiB检查host v24.22.1与其错误RESULT标签、Bun timeout全部保留。保持资源门，不重复相同编译尝试。

K106当前父候选已完成：原历史六leaf基线fbf07b62…在全2049文件字节核验后真实12pass/7fail/518expects；R2候选541bd1c7…为22pass/0fail/625expects，全2049文件/49,207,256字节SHA/权限/FD稳定通过。R2保留原19定义与214 artifact保护，索引两个using→on，真实FK精确owner/name→唯一native id/uuid与六身份负例，literal callback保护SQL dollar文本；对两项已批准知识/资源测试仅允许固定当前SHA并精确literal inverse还原旧整件SHA，未知字节及追加均拒绝。候选原文及两次运行在仓库归档；同一名非作者独审SOURCE_APPROVED_ONLY/findings=[]后，Root在新父上精确采用六Subject+overlay+workflow共8文件。采用提交325d99abb42beb8de8dd8952f239efd71d8de2e2的[运行40681795546/job122794075624](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40681795546/job/122794075624)完整核2049/49207256；四个知识/资源/plugin定义测试独立进程顺序完成，80pass/0fail/2996expects、exit0，测试peak223.2M。仅定义/组件范围，不是native PG17、完整CI或商业过门。

Ptx两个历史leaf已完成当前父SourceOnly恢复及独审采用。store15478B/03d4193517cf84ea21f1ff38209eefd9e6dfa38d52a191dc87c828aaa0c4bb21与PG集成测试21306B/61cfeb0089b748ce9fbf8155cca140802e4cba74f71b8fccdfd6ece7c1c6e8d0原字节核合；store四hunks正反offset0/fuzz0逐字等两端，新446行creation完整等测试，read(binding)至EOF完全不变。非作者完整读两Source及原DB/tenant/ABI，SOURCE_APPROVED_ONLY/findings=[]。采用提交85074c589b9d18a129a746386217db69aa73f077的[40684567801/job122803503606](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40684567801/job/122803503606)按七overlay全核2050/49231004，无项目执行。新15项测试只定义、PG_PENDING；不导入为CPU测试。prepare仅每invocation至多一次，非跨并发全局一次；callback仅受信任同tx数据库写可回滚，外部副作用不保护；after_ack定义模拟成功后包装层抛错，不冒真实网络COMMIT ACK丢失。producer/native/RLS/类型/fullCI未验，旧V58/V59不追认。

下一步用完整锁文件依赖、原两preload顺序运行37个明确文件：原35加K106及proactive受控模型/工具夹具。该具名子集不包含Ptx PG集成测试；继续保持安装512MiB具名例外、DATA64MiB、项目聚合512MiB/swap0、禁全部生命周期脚本及免费云端。

## 持续边界与待验项

- 本轮项目源码、patch、archive、JSON、依赖和项目执行均云端；Windows无项目源码写入/执行，仅保存获准无源码UI PNG。
- 免费标准Linux Actions；项目与后代总内存512MiB，DATA/下载/复制64MiB，swap0；无hardlink、共享可写依赖或付费provider探测。
- Bun1.3.14+0d9b296af；schema测试仅用原lockfile固定Drizzle0.45.2并验证SRI，不冒完整workspace安装。
- 原preload全套、类型编译、完整CI、原生PG17、生产接线、镜像、真实UI、真实计费和客户交付分别待真实验证。
- PG_PENDING、AP_DISABLED、NOT_SERVICE_WIRED、migration NOT_WIRED、ROOT_RELEASE=null、ready=false保留。
- 旧V58仍未采用，原V57历史46/51余5记录不改；本次另有独立原0121 oracle和当前物理Source证据恢复其中两表定义，三表原ORM/SQL仍缺失；0107另行明确重建三表完整结构，并保全152父表，不能将155总表当原whole或nativePG验收。历史审计事件与缺证保留。
- 专用Codespace最后可见为重连；当前完整物理验证来自Linux Actions，不声称持久Codespace已快进。

37文件子集已在提交ef8f38ad08b66442f4a95609d1522c6293a93e6b实际完成：[40684891942/job122804593792](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40684891942/job/122804593792)，651pass/0fail/9810expects、37/37、exit0；2050/49231004全部字节核验；原两preload未改，完整冻结依赖PASS/hardlink0/外链0/禁全部生命周期脚本。安装peak510.2M、测试peak478.7M保留，PG17新15体未导入。该同一提交具名子集不等完整CI。

最后三个原目标的完整对象已从独立封存7065B capsule三层核合取回，与104854B派生矩阵fullStructure逐字相同，见REMAINING3-SNAPSHOT-INPUT目录。原whole583049/c382dcdb…是历史来源身份，未新取whole；93276原raw缺口和派生分层保持，原ORM/SQLbody仍SOURCE_BODY_MISSING。下一包仅明确按快照重建，不以取到输入等同完成表或运行。

0107显式重建已采用：[78c2b4328481a7234bb36f7a7f178f0efa07b71d](https://github.com/canquedehuiyi-cpu/xiongbaowork/commit/78c2b4328481a7234bb36f7a7f178f0efa07b71d)，[40689165318/job122819239449](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40689165318/job/122819239449)在实际采用提交上全核2054/50007029，22pass/0fail/994expects、exit0、测试peak196.9M。六Source经全文独审SOURCE_APPROVED_ONLY/findings=[]，三完整对象逐字等冻结oracle，152旧表和全部tops/order逆向精确回604775父；journal107完整逆回16159，barrel一export。216历史+7 Source全部223身份保持。当前51/51仅名称及分层结构恢复证据，旧V57历史46/51不倒改，原whole未新取/93276raw缺口/原ORM_SQL_BODY_MISSING保持；PG谓词、真实driver/DTO/NULL、producer和商业门未验。

下一步同一新Source提交保留原两preload和冻结依赖，明确38文件（原37加0107定义测试），不包含Ptx的15项PG集成测试。项目总512MiB/swap0、DATA64MiB和仅完整依赖安装512MiB具名例外不变。

最新同一提交38文件结果：[56faabeec733e9dd8e62c6fda517d22c69c78f91](https://github.com/canquedehuiyi-cpu/xiongbaowork/commit/56faabeec733e9dd8e62c6fda517d22c69c78f91)，[40689788558/job122821353836](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40689788558/job/122821353836)：673pass/0fail/10804expects、38/38完成、exit0、Unhandled0。2054/50007029完整SHA/权限/FD核验通过；原两preload未改，完整冻结安装PASS/普通文件127738/符号链接3869/hardlink0/外部链接0/禁全部生命周期脚本；自动peak安装510.3M、测试475M、swap0。Ptx15项原生PG定义未导入，完整CI及server类型仍未通过。八个修复包及本次51名称/分层结构重建不等77/18/7完整验收。

后续完整server类型检查受原512MiB聚合门/V8 heap OOM阻塞；仅完整依赖安装的512MiB例外已获准，不覆盖放宽编译项目总门。正在准备只对完整server编译步骤临时2GiB/swap0的可审方案，当前未获该例外、未执行或触发；其余阶段仍原资源门。PG_PENDING按人类要求保留，不重复索要PG环境。

2026-10-28 新人类授权：仅完整server类型检查阶段，项目与全部后代聚合上限临时2GiB、swap0、300秒时限，结束恢复512MiB。明确回答“允许，仅完整类型检查阶段使用2GiB”；原安装512MiB例外保留，其余DATA64MiB/其他项目阶段512MiB、免费、私有缓存/copyfile/禁生命周期脚本及源码不落Windows均不变。按已审具体提案6018fc1e95c5c4b56373872b148cea2287ade042启动一次，结果另证；该授权不是类型通过、PG17或完整77/18/7过门。

2GiB获准首次运行40697501862/job122848086646：Source2054/50007029及冻结依赖安装通过；Node24.22.1/TS5.9.3在自设1408MiB V8堆处SIGABRT6，31.412秒/CPU57.263秒/peak1.6G，未触发kernel聚合OOM、无编译诊断。退出trap已实际输出PROJECT_LIMIT_RESTORED=512MiB/swap0。原tsconfig strict=true/skipLibCheck=true/includes未改。下一次仅把辅助heap改1792MiB，实际聚合上限仍为已获准2GiB/swap0/300秒，其他阶段门不改；不以辅助heap冒聚合门，也不继续提高实际资源上限。
