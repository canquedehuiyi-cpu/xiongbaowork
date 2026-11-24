# open-code-review 预审（只出报告）

用 [open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0，下称 OCR）对一段提交范围做预审，产出一份 JSON 报告。
**只出报告**：不在 PR 上评论、不批准、不打标签、不碰合并按钮；失败也不影响 PR 的检查（`continue-on-error`）。

固定版本：`@alibaba-group/open-code-review@1.14.2`（写在 `run-review.sh` 的 `OCR_VERSION`，要升级就改这一处，不用 latest）。需要 Git 2.41 或更新。

## 目录

| 文件 | 作用 |
|---|---|
| `run-review.sh` | CI 与本地共用的运行脚本：装固定版本、配模型、跑 `ocr review --from <base> --to <head> --format json`、写报告；缺 key 时跳过并写原因 |
| `rules/xiongbao-review.rule.json` | 熊宝规则模板：越权/RLS/租户帧、注入、路径穿越与符号链接、审批绕过、密钥外泄、并发与收尾、品牌词、改既有断言、工作流供应链 |
| `delegate-pack.ts`、`delegate-report.ts`、`delegate-lib.ts` | 没有模型 key 时的 delegation 模式辅助：打包评审材料、把宿主智能体的评论装成结构化报告并核对覆盖 |
| `benchmark/` | 金标评测集、打分脚本、已跑出的结果；见下面「评测」 |
| `../../../../.github/workflows/ocr-review.yml` | CI 工作流（仓库根的 `.github/`） |
| `../../../server/tests/ocr-review-workflow.test.ts` | 工作流结构测试 |

## 在 CI 里开

1. 在仓库设置里新建 GitHub Environment，名字 **`ocr-review`**。建议给它设「必需审阅者」：带标签的 PR 会运行它自己的合并提交里的脚本，审阅者批准之前先看一眼该 PR 有没有改 `.github/` 和 `xiongbao/scripts/review/`。
2. 在这个 Environment 里加（密钥只放在这里，不放仓库级或组织级）：

   | 名字 | 类型 | 默认 | 说明 |
   |---|---|---|---|
   | `OCR_API_KEY` | secret | 无 | 模型 key；缺或为空时本次运行跳过，报告里写明原因 |
   | `OCR_PROVIDER` | variable | `deepseek` | `ocr llm providers` 列出内置的提供方 |
   | `OCR_MODEL` | variable | `deepseek-v4-flash` | 模型名 |
   | `OCR_TOKEN_BUDGET` | variable | `1500000` | 一次评审的 token 上限（输入加输出） |

3. 触发方式（只有这两种）：
   - 手动：Actions → 「OCR 预审（只出报告）」→ Run workflow，填 `base`（默认 `origin/main`）和 `head`（默认 `HEAD`）。
   - 给**本仓库**里的 PR 打标签 **`ocr-review`**（之后每次推送、重开也会再跑；fork 来的 PR 一律不跑）。
4. 结果：运行页的 Summary 里有摘要；artifact `ocr-review-report` 里有 `ocr-report.json`、`summary.md`、`ocr-review.log`（缺 key 时是 `skipped.json` 与 `SKIPPED.txt`）。保留 14 天。

不用 `pull_request_target`；token 只有 `contents: read`；所有 action 钉了完整 commit SHA（与 `ci.yml` 同一版本）；OCR 用 `--ignore-scripts` 装，平台二进制来自包自带的可选依赖。

## 在本地跑

有模型 key（native 模式）：

```bash
OCR_API_KEY=... OCR_BASE=origin/main OCR_HEAD=HEAD OCR_OUT_DIR=/tmp/ocr-report \
  bash xiongbao/scripts/review/ocr/run-review.sh
```

脚本会用一个临时 HOME，key 只写在那里，跑完即删；报告目录里若出现 key 原文，那个文件会被删掉并在 `summary.md` 里写明。默认不读测试文件（`**/tests/**`、`**/*.test.*`），要读就加 `OCR_INCLUDE_TESTS=1`。

没有 key（delegation 模式，由你自己或编码智能体做评审）：

```bash
export OCR_BIN=$(npm root)/.bin/ocr      # 或 PATH 上的 ocr
RULE=xiongbao/scripts/review/ocr/rules/xiongbao-review.rule.json
bun xiongbao/scripts/review/ocr/delegate-pack.ts --from <base> --to <head> --out /tmp/pack \
  --rule $RULE --exclude '**/tests/**,**/*.test.*'
# /tmp/pack/preview.json（OCR 选出的文件）、rules.json（每个文件适用的规则）、diffs/（带新文件行号的 diff）
# 评审者逐文件读 diff、按 rules.json 对照，把评论写成 comments.json：
#   { "comments": [{path, content, start_line, end_line, severity, category}], "skipped": [{path, reason}], "notes": [] }
bun xiongbao/scripts/review/ocr/delegate-report.ts --preview /tmp/pack/preview.json \
  --comments comments.json --out report.json
```

`delegate-report.ts` 会拒绝：评论在 OCR 没选中的文件上（除非标 `outside_diff: true`）、未知严重度、行号倒置、没写原因的跳过；并算出覆盖率（`reviewed_files / total_files`）。

## 评测

`benchmark/gold.json` 是控制方对三个 PR（#807 第 5 期、#810、#812）的审查报告里已确认、**之后被修掉**的问题：严重度、文件、行区间（被审查那个版本里的行）、一句话、主题关键词，以及是否在 diff 里（`inDiff`）。

```bash
bun xiongbao/scripts/review/ocr/benchmark/score.ts \
  --report benchmark/results/pr-807.report.json --pr pr-807 \
  --report benchmark/results/pr-810.report.json --pr pr-810 \
  --report benchmark/results/pr-812.report.json --pr pr-812
```

匹配规则（三条都满足才算命中）：文件相同；评论的行区间向两边各放宽 10 行后与金标行区间有重叠（没写行号的评论按文件级评论，对该文件任意金标位置都过这一关）；评论文字里至少含该条金标的一个关键词（不分大小写）。

- 召回 = 命中的 Critical/Important 条数 ÷ Critical/Important 总数；另给「只算在 diff 里的」召回，和 Minor 的召回（单列）。
- 精度 = 命中任何一条金标（含 Minor）的评论数 ÷ 评论总数；另给严格精度（只算命中 Critical/Important 的评论）。
- 列出漏报（没被命中的 Critical/Important）和未命中的评论（可能是误报，也可能是金标里没有的真问题，需要人看）。

`benchmark/results/` 里是盲审结果（delegation 模式，评审者没读过金标）：Critical/Important 召回 5/9，精度 9/18。`benchmark/results/upper-bound/` 是评审者读过金标后的一轮，数字偏高、作废，只留作对照。要得到 native 模式的数字：在配了 `OCR_API_KEY` 的 Environment 里，对三个 PR 的范围手动触发（`base`/`head` 见 `gold.json` 的 `range`），把 artifact 里的 `ocr-report.json` 交给 `score.ts`。`score.ts` 能读 delegation 报告，也读 native 报告里的 `comments` 数组（字段别名 `file/path`、`line/start_line`、`message/content` 都认）；native 报告的评论字段本机没有 key 跑不出来，没核实过。

跑测试：`bun test scripts/review/ocr`（在 `xiongbao/` 下）和 `bun test server/tests/ocr-review-workflow.test.ts`。
