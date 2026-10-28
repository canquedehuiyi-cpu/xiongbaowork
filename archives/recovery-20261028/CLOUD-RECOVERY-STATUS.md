# 云端恢复与验证状态（2026-10-28）

目标仓库：[canquedehuiyi-cpu/xiongbaowork](https://github.com/canquedehuiyi-cpu/xiongbaowork)。

完整交付范围仍为 **77 故事、18 包、7 门**；当前尚未完成商业交付。

## 已恢复并同步

- 已恢复 V57 的全部 **195 项修复（25 修改、170 新增、0 删除）**，载荷 **15,019,196 字节**。
- 原始清单与 V57 的独立差异恰好为这 195 项，全部字节大小、SHA256 与 Git blob 均核合。
- 旧 Gitee README 保存在 `GITEE-ROOT-README-0089682.md`，原 V57 README 已按原始归档精确恢复。
- Linux 云端已按原 V57 清单逐文件验证 **2045 文件、48,435,806 字节**，大小、SHA256、权限、无符号链接、单链接及打开句柄/路径稳定性均通过。
- V57 清单 SHA256：`81de447073617989a55883fbc9d07d02ac0f6de2f806c98f5702dd5bcdf7a920`。
- 恢复分支：[`codex/cloud-repairs-recovery-20261028`](https://github.com/canquedehuiyi-cpu/xiongbaowork/tree/codex/cloud-repairs-recovery-20261028)。默认分支仍保留原 Gitee 导入基线。

## 已取得的云端运行证据

这些是不同提交上的独立范围，不合并冒称同一提交完整 CI：

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| JSON codec/header/wire/crypto 四组件 | 105 pass / 0 fail / 1224 expects | [run 40647799132](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40647799132) |
| HTTP 输入与 JSON materializer 候选修复 | 64 pass / 0 fail / 848 expects | [run 40650647131](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40650647131) |
| 续执行协调器（模拟持久化接口） | 22 pass / 0 fail / 101 expects，网络调用 0 | [run 40651075475](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40651075475) |
| AP2/AP4/执行域定义 | 43 pass / 9 fail / 1101 expects | [run 40651549206](https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/40651549206) |

候选修复位于 [`codex/approval-input-bun-fix-20261028`](https://github.com/canquedehuiyi-cpu/xiongbaowork/tree/codex/approval-input-bun-fix-20261028)，仅三项源码/测试变化，已通过运行核验，**非作者独审待完成、未正式采用**。

定义测试的 9 项失败已保存，未放宽 5 秒限制。已定位到索引 `.using("btree", ...)` 的 ONLY 元数据差异、旧 AP2 父版本逆向预期、JSON 参数测试与 Bun SQL 直通设计不符、快照校验超时，以及执行域 SQL 空格和 journal 前缀测试过时。后续修复须保留完整闭合矩阵、旧前缀和拒绝测试。

原合同要求“每中央包≤8source/test，上包审后下一包”。当前下一源码包等待本包非作者独审，不跳过此门。

## 继续保留的边界

- 本轮源码、补丁、归档、JSON、依赖及测试运行均在云端；Windows 未写项目源码或执行项目。只保存获准的无源码 UI PNG。
- 使用免费标准 Linux GitHub Actions，项目及后代总内存上限 **512 MiB**，数据/下载/复制子任务硬上限 **64 MiB**，swap 0；无 hardlink、共享可写依赖或付费 provider 探测。
- Bun 固定 **1.3.14+0d9b296af**，下载与二进制摘要均核合；定义测试仅使用锁文件固定的 Drizzle **0.45.2**，不是完整 workspace 安装。
- 原 preload 全套、完整 CI、原生 PG17、生产接线、镜像、真实 UI、计费和客户交付均未被这些组件证据替代。
- **PG_PENDING、AP_DISABLED、NOT_SERVICE_WIRED、migration NOT_WIRED、ROOT_RELEASE=null、ready=false** 保留。
- V58 仍未采用。历史审计事件和缺证未被清除。
- 专用 Codespace 最后可见为重连状态；最新完整物理源码验证来自 Linux Actions，不声称持久 Codespace 已快进到最新分支。
