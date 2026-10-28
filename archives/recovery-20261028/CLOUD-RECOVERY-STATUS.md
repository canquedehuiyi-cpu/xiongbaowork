# 云端恢复与验证状态（2026-10-28）

目标仓库：[canquedehuiyi-cpu/xiongbaowork](https://github.com/canquedehuiyi-cpu/xiongbaowork)。
完整交付范围仍为 **77 故事、18 包、7 门**；当前尚未完成商业交付。

## 当前已采用源码

- 已恢复 V57 全部 **195 项修复（25 修改、170 新增、0 删除）**，原修复载荷 **15,019,196 字节**。原始清单与 V57 的独立差异恰为这195项，大小、SHA256与Git blob全核合。
- 原 V57 **2045文件、48,435,806字节**已在Linux云端完整核验，原清单保持不变。
- 票 **AP-INPUT-BUN-20261028** 的三文件候选已取得非作者 **SOURCE_APPROVED_ONLY**；Root按精确文件身份采用到恢复分支。
- 采用提交 [6be5e1d72d18e8c2a46d4a221292a5c82f553274](https://github.com/canquedehuiyi-cpu/xiongbaowork/commit/6be5e1d72d18e8c2a46d4a221292a5c82f553274) 的完整 **2045文件、48,438,057字节**，已按原V57清单加批准overlay重新核验通过；同提交输入组件 **64 pass / 0 fail / 848 expects**。
- 源码清单身份、权限、无符号链接、单链接及打开句柄/路径稳定性均核合。批准overlay为 `AP-INPUT-BUN-ADOPTED.json`，独审为 `AP-INPUT-BUN-INDEPENDENT-REVIEW.json`，运行回执为 `AP-INPUT-BUN-INTEGRATED-64.json`。
- 原 Gitee README已保存在 `GITEE-ROOT-README-0089682.md`，V57原README按归档精确恢复。
- 恢复分支：[`codex/cloud-repairs-recovery-20261028`](https://github.com/canquedehuiyi-cpu/xiongbaowork/tree/codex/cloud-repairs-recovery-20261028)。默认分支保留原Gitee导入基线。

## 云端运行证据

以下是不同提交、不同范围的证据，不合并冒称同一提交完整CI：

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| JSON codec/header/wire/crypto四组件 | 105 pass / 0 fail / 1224 expects | [40647799132](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40647799132) |
| 已独审采用的HTTP输入与JSON materializer，同提交集成后重验 | 64 pass / 0 fail / 848 expects | [40654934850](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40654934850) |
| 续执行协调器，模拟持久化接口 | 22 pass / 0 fail / 101 expects，网络调用0 | [40651075475](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40651075475) |
| AP2/AP4/执行域原始定义测试 | 43 pass / 9 fail / 1101 expects | [40651549206](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40651549206) |
| AP-SCHEMA-RUNTIME候选五文件，未采用 | 54 pass / 0 fail / 1126 expects | [40656168267](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40656168267) |

## 下一源码包

[AP-SCHEMA-RUNTIME候选分支](https://github.com/canquedehuiyi-cpu/xiongbaowork/tree/codex/ap-schema-runtime-fix-20261028) 仅五项主体文件变化：两个定义文件和三个测试文件。
修正四个索引调用的ONLY标记差异；在严格验证已批准AP4全部增量后再逆向验证原AP2；JSON参数保持仓库Bun SQL直通对象设计；快照仍完整验证所有顶层字段、所有旧表字段及全部139个RLS变异。
快照用例在原5秒上限内为 **253.14ms**，未抬上限、未减少变异、未修改原SQL/snapshot/journal字节。
原始9项失败及候选r1的2项失败均保留，未抹为历史通过。

人类已授权后续每个≤8文件包复用同一名只读独审员。当前五文件独审正在进行；只有非作者独审通过、Root精确采用及集成验证通过后才进入后续源码包。

## 保留的边界

- 本轮项目源码、patch、archive、JSON、依赖及测试仅在云端；Windows无项目源码写入或项目执行，仅保存获准无源码UI PNG。
- 免费标准Linux Actions，项目及后代总内存上限512MiB，数据/下载/复制子任务64MiB，swap0；无hardlink、共享可写依赖或付费provider探测。
- Bun固定1.3.14+0d9b296af；单枚schema依赖为原lockfile的Drizzle0.45.2，SRI核合，不冒完整workspace安装。
- 原preload全套、完整CI、原生PG17、生产接线、镜像、真实UI、计费和客户交付，仍需各自真实证据。
- PG_PENDING、AP_DISABLED、NOT_SERVICE_WIRED、migration NOT_WIRED、ROOT_RELEASE=null、ready=false保留。
- V58仍未采用，历史审计事件/缺证未被清除。
- 专用Codespace最后可见为重连；最新完整物理验证来自Linux Actions，不冒持久Codespace已更新。
