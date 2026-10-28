# 云端恢复与验证状态（2026-10-28）

目标仓库：[canquedehuiyi-cpu/xiongbaowork](https://github.com/canquedehuiyi-cpu/xiongbaowork)。
完整交付目标仍为 **77 故事、18 包、7 门**，商业交付尚未完成。

## 当前恢复与已采用修复

- V57全部195项修复（25修改/170新增/0删除，原载荷15,019,196字节）已恢复，原清单419227字节/SHA256 `81de447073617989a55883fbc9d07d02ac0f6de2f806c98f5702dd5bcdf7a920` 保持不变。
- 原V57的2045清单文件、48,435,806字节已完整物理核验。
- 其后3个包均经同一名非作者独审、Root精确采用及采用提交上的重新验证：AP-INPUT-BUN三文件、AP-SCHEMA-RUNTIME五文件、KNOWLEDGE-RESOURCE-RUNTIME五文件，共13项主体文件修复。
- 当前受清单覆盖的 **2045文件、48,459,984字节**，已按原V57清单加3个明确批准overlay在Linux云端核验：完整大小/SHA256、文件权限、无符号链接、单链接、FD与路径稳定性均通过。
- 最新完成该核验的主体提交：[13e38d05cd0138949df5d92f23412ae600a7c083](https://github.com/canquedehuiyi-cpu/xiongbaowork/commit/13e38d05cd0138949df5d92f23412ae600a7c083)。
- `CURRENT-SOURCE-EXPECTED-MANIFEST.json` 给出当前完整预期记录，422990字节/SHA256 `9b5040641711ca7b9d98158d0e1f2194cfd154aa73716c1fe574525bf21f7db1`。这是基于原清单及批准overlay的派生清单，原V57身份不被改写。
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

## 当前继续工作

已转入8个已有自动化/Flow基础定义用例的验证。第一次在Source取回阶段触及64MiB硬门并OOM，测试尚未启动；未当作测试失败或成功。
现改为每批不超过32文件/2MiB，分批取回并fsync各自文件，Git delta cache收窄到1MiB。64MiB上限、项目512MiB、swap0不提高；后续实际结果另证。
同一名只读独审员已获人类持续授权，可审后续每个≤8文件包；继续遵守“上包审后下一包”，不重复索取该项授权。

## 持续边界与待验项

- 本轮项目源码、patch、archive、JSON、依赖和项目执行均云端；Windows无项目源码写入/执行，仅保存获准无源码UI PNG。
- 免费标准Linux Actions；项目与后代总内存512MiB，DATA/下载/复制64MiB，swap0；无hardlink、共享可写依赖或付费provider探测。
- Bun1.3.14+0d9b296af；schema测试仅用原lockfile固定Drizzle0.45.2并验证SRI，不冒完整workspace安装。
- 原preload全套、类型编译、完整CI、原生PG17、生产接线、镜像、真实UI、真实计费和客户交付分别待真实验证。
- PG_PENDING、AP_DISABLED、NOT_SERVICE_WIRED、migration NOT_WIRED、ROOT_RELEASE=null、ready=false保留。
- V58仍未采用，原51表恢复46/51的余5不能由新增协议表替代；历史审计事件与缺证保留。
- 专用Codespace最后可见为重连；当前完整物理验证来自Linux Actions，不声称持久Codespace已快进。
