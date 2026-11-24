# 交付物验收记录（2026-11-23）

本记录验收「交付即可用」：员工交出来的演示文稿、文档、表格、网页、本机程序、图片、视频，拿到手能直接打开使用。
七道题（`deliv-pptx`、`deliv-docx`、`deliv-xlsx`、`deliv-web`、`deliv-app`、`deliv-image`、`deliv-video`）
各走单聊和群聊两条路径，共 14 格。判分是本地检查加服务器侧检查，不看模型自述；不为让题通过而放宽判分。

## 1. 怎么跑

在 Actions 手动触发 `model-e2e`：`suite=employee-eval`、`tasks=deliverables`、`paths=chat,group`，
`rerun_failed=1`（默认）。没过的题用新员工、新夹具重跑至多 1 次，记录里 `reruns` 写 1，格里取重跑那一次的结果；
重跑后仍没过就是没过。报告里「交付题验收」一节给出 7×2 表和判定。

首次验收按路径分两次手动触发（`paths=chat`、`paths=group`），以免单次作业超时；两次的结果都记进下面的表。分两次触发时，每次的报告只有 7 格（另一条路径的 7 格没有结果），判定会显示「未达成」，以第 2 节人工合并两次结果后的主表为准。

每格记：结果（通过 / 失败）、重跑次数（0 或 1）、运行链接。

## 已知局限

重跑时，首次运行留在电脑上的后台程序无法结束。若重跑的新程序没绑上端口、而旧程序仍占着同一端口，
程序题（`deliv-app`）可能误判通过。因此程序题凡「重跑」为 1 的格，回填时需人工看运行日志，确认端口由新一轮的程序监听，
并在该格的「人工核对」处标记（已核对 / 未核对）；未核对的格不算通过。三张表的程序题行都留有这一标记位。

## 2. 主表：DeepSeek（计入达成判定）

模型：`deepseek-v4-flash`（提供方 `deepseek`）。运行链接：单聊 https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 ；群聊 https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 。
两次运行都在 main `5c4f62f5` 上，2026-11-23。程序题（`deliv-app`）重跑为 0，没有重跑就没有「旧程序占着端口」的风险，人工核对栏写「无需（未重跑）」。

| 题目 | 单聊 结果 | 单聊 重跑 | 单聊 运行链接 | 群聊 结果 | 群聊 重跑 | 群聊 运行链接 | 人工核对（仅程序题） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 演示文稿（deliv-pptx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | — |
| Word 文档（deliv-docx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | — |
| Excel 表格（deliv-xlsx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | — |
| 静态网页（deliv-web） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | — |
| 本机运行的程序（deliv-app） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | 无需（未重跑） |
| 图片（deliv-image） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | — |
| 视频（deliv-video） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254142771 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45254149805 | — |

通过：14 / 14（单聊 7 / 7，群聊 7 / 7，重跑 0）。

## 3. 对照：gemini-4-argon（不计入达成判定）

模型：`gemini-4-argon`，经 AIHUB 中转（提供方 `aihub`，令牌分组 gemini-anti-ultra）。运行链接：单聊 https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 （main `5c4f62f5`，2026-11-23）；群聊 https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 （main `d3996663`，2026-11-24）。

群聊第一次在 main `5c4f62f5` 上跑是 0 / 7：群聊轮没给时限，用默认 5 分钟硬停，停下的轮以 RUN_ERROR 收尾，产物清单只在 RUN_FINISHED 上比对，文件在电脑上、对话里却没有下载清单。#812 修复后（群聊带电脑员工的时限对齐 25 分钟；出错、被停的轮也出清单）在 `d3996663` 上重跑，下表群聊列是重跑这次的结果。

| 题目 | 单聊 结果 | 单聊 重跑 | 单聊 运行链接 | 群聊 结果 | 群聊 重跑 | 群聊 运行链接 | 人工核对（仅程序题） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 演示文稿（deliv-pptx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | — |
| Word 文档（deliv-docx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | — |
| Excel 表格（deliv-xlsx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | — |
| 静态网页（deliv-web） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | — |
| 本机运行的程序（deliv-app） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | 无需（未重跑） |
| 图片（deliv-image） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | — |
| 视频（deliv-video） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45264759326 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45313661358 | — |

通过：14 / 14（单聊 7 / 7，群聊 7 / 7，重跑 0）。本表是对照，不计入达成判定。

## 4. 对照：gemini-4-hydrogen（不计入达成判定）

模型：`gemini-4-hydrogen`，经 AIHUB 中转（提供方 `aihub`，令牌分组 gemini-anti-ultra）。运行链接：单聊 https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 ；群聊 https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 。两次都在 main `5c4f62f5` 上，2026-11-24。

| 题目 | 单聊 结果 | 单聊 重跑 | 单聊 运行链接 | 群聊 结果 | 群聊 重跑 | 群聊 运行链接 | 人工核对（仅程序题） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 演示文稿（deliv-pptx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 1 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | — |
| Word 文档（deliv-docx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | — |
| Excel 表格（deliv-xlsx） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | — |
| 静态网页（deliv-web） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | — |
| 本机运行的程序（deliv-app） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | 无需（未重跑） |
| 图片（deliv-image） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 1 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | — |
| 视频（deliv-video） | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302479620 | 通过 | 0 | https://github.com/canquedehuiyi-cpu/xiongbaowork/actions/runs/45302484200 | — |

通过：14 / 14（单聊 7 / 7，群聊 7 / 7；群聊演示文稿、图片各重跑 1 次后通过）。程序题未重跑，人工核对写「无需（未重跑）」。本表是对照，不计入达成判定。

## 5. 判定

14 项全部通过（含重跑）才算达成。只看第 2 节主表（DeepSeek）；对照表不计入。

判定：达成（14/14，均首跑通过，2026-11-23，main 5c4f62f5）。
