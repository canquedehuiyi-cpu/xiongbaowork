# open-code-review 预审（只出报告）

用 [open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0，下称 OCR）对一段提交范围做预审，产出一份 JSON 报告。
**只出报告**：不在 PR 上评论、不批准、不打标签、不碰合并按钮；失败也不影响 PR 的检查（`continue-on-error`，脚本里能预见的失败都走「跳过」、退出 0）。**不要把 OCR 预审设为必需检查**。

固定版本：`@alibaba-group/open-code-review@1.14.2`（写在 `run-review.sh` 的 `OCR_VERSION`，要升级就改这一处，不用 latest）。需要 Git 2.41 或更新。

## 目录

| 文件 | 作用 |
|---|---|
| `run-review.sh` | CI 与本地共用的运行脚本：装固定版本（安装时不带 key）、配模型、跑 `ocr review --from <base> --to <head> --format json`、写报告；缺 key、没设 `OCR_PROVIDER`、`ocr` 起不来或配置失败时跳过并写原因 |
| `rules/xiongbao-review.rule.json` | 熊宝规则模板：越权/RLS/租户帧、注入、路径穿越与符号链接、审批绕过、密钥外泄、并发与收尾、品牌词、改既有断言、工作流供应链 |
| `delegate-pack.ts`、`delegate-report.ts`、`delegate-lib.ts` | 没有模型 key 时的 delegation 模式辅助：打包评审材料、把宿主智能体的评论装成结构化报告并核对覆盖 |
| `benchmark/` | 金标评测集、打分脚本、已跑出的结果；见下面「评测」 |
| `../../../../.github/workflows/ocr-review.yml` | CI 工作流（仓库根的 `.github/`） |
| `../../../server/tests/ocr-review-workflow.test.ts` | 工作流结构测试 |

## 在 CI 里开

只有**手动触发**，并且只能从 `main` 触发（工作流的 job 条件是 `workflow_dispatch` 且 `github.ref == 'refs/heads/main'`，写法同 `model-e2e.yml`）。没有 `pull_request`、标签或定时触发，也没有 `pull_request_target`。原因：带 key 的那一步运行的工作流文件、脚本和规则文件都来自 main 的检出，PR 分支里改过的脚本拿不到 key；被审的范围只作为 git 对象被 `ocr review --from --to` 读取，工作流不检出、不构建、不运行其中任何东西（`ocr` 自己读取这些 git 对象时的行为，没有逐项核实）。

1. 在仓库设置里新建 GitHub Environment，名字 **`ocr-review`**，并给它设**必需审阅者（开通前提，必须设；不设不要加 secret）**。key 会连同被审的代码一起发给模型提供方，每次运行由审阅者批准，才算「敏感动作进审批」。审阅者批准前看一眼要审的范围和 main 上的脚本有没有变。同一个 Environment 的「部署分支」也限定为 `main`：工作流本身只在 main 上跑，再加这一层，别的分支上的工作流引用这个 Environment 也拿不到 key。
2. 在这个 Environment 里加（密钥只放在这里，不放仓库级或组织级）：

   | 名字 | 类型 | 默认 | 说明 |
   |---|---|---|---|
   | `OCR_API_KEY` | secret | 无 | 模型 key；缺或为空时本次运行跳过，报告里写明原因 |
   | `OCR_PROVIDER` | variable | **无，必须设** | 代码发给哪个提供方（`ocr llm providers` 列出内置的）。没设就跳过并写原因：外发对象要由开通的人明确选，不替人选 |
   | `OCR_MODEL` | variable | `deepseek-v4-flash` | 模型名 |
   | `OCR_TOKEN_BUDGET` | variable | `1500000` | 一次评审的 token 上限（输入加输出） |

3. 触发：Actions → 「OCR 预审（只出报告）」→ Run workflow，**分支选 `main`**，填 `base`（默认 `origin/main`）和 `head`（默认 `HEAD`，要审一个 PR 就填它的分支名或提交；两个都必须在本仓库里。fork 来的 PR 不在，审不了）。
4. 结果：运行页的 Summary 里有摘要；artifact `ocr-review-report` 里有 `ocr-report.json`、`summary.md`、`ocr-review.log`（跳过时是 `skipped.json` 与 `SKIPPED.txt`）。保留 14 天。
5. CI 里设了 `OCR_INCLUDE_TESTS=1`：测试文件也会被读，规则里「改既有断言」那一条才会生效（OCR 内置会排除测试，规则模板里写了 `include`）。脚本本身默认仍排除测试，评测时这样做是为了控制工作量，见下面「评测」。

不用 `pull_request_target`；token 只有 `contents: read`；所有 action 钉了完整 commit SHA（与 `ci.yml` 同一版本）；OCR 用 `--ignore-scripts` 装，平台二进制来自包自带的可选依赖。

## 在本地跑

有模型 key（native 模式）：

```bash
OCR_API_KEY=... OCR_PROVIDER=<提供方> OCR_BASE=origin/main OCR_HEAD=HEAD OCR_OUT_DIR=/tmp/ocr-report \
  bash xiongbao/scripts/review/ocr/run-review.sh
```

脚本会用一个临时 HOME，key 只写在那里，跑完即删；`npm install` 那一步不带 key；报告目录里若出现 key 原文，那个文件会被删掉并在 `summary.md` 里写明。已知的残留：key 是经命令行参数交给 `ocr config set` 的，运行期间在进程列表里可见（GitHub 托管 runner 是单租户虚拟机，实际风险低）；`ocr` 的二进制里有 `OCR_LLM_TOKEN` 等环境变量名，能否改用环境变量传 key 没有核实。脚本显式设了 `OCR_ENABLE_TELEMETRY=0`：它的语义和默认值没核实，显式关闭以防默认开。**本地**默认不读测试文件（`**/tests/**`、`**/*.test.*`），要读就加 `OCR_INCLUDE_TESTS=1`；`OCR_PROVIDER` 必须设。

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

匹配规则：一条评论要**能**匹配一条金标，三条都满足：文件相同；评论的行区间向两边各放宽 10 行后与金标行区间有重叠（没写行号的评论按文件级评论，对该文件任意金标位置都过这一关）；评论文字里至少含该条金标的一个关键词（不分大小写）。然后做**一对一分配**：每条评论最多记给一条金标，每条金标最多被一条评论认领。候选对按「评论自己的行区间盖住金标行区间的行数」从多到少、再按命中的关键词个数、再按严重度（Critical/Important 在 Minor 前）、再按 gold.json 和报告里的顺序依次认领。这是确定性的贪心，不是最优分配，但不会让同一句话给两条金标记功。金标的关键词只放能区分机制的词（不放纯数字，不放 `sweep` 这类泛词）。

- 召回 = 命中的 Critical/Important 条数 ÷ Critical/Important 总数；另给「只算在 diff 里的」召回，和 Minor 的召回（单列）。
- 精度 = 命中任何一条金标（含 Minor）的评论数 ÷ 评论总数；另给严格精度（只算命中 Critical/Important 的评论）。
- 列出漏报（没被命中的 Critical/Important）和未命中的评论（可能是误报，也可能是金标里没有的真问题，需要人看）。
- 打分是关键词加行号的**机械匹配**，会偏高也会偏低：命中不等于说的是同一个问题，没命中也可能是换了说法。报告里的数字要和人工逐条核对的结论一起看（见 `docs/reports/2026-11-24-top8-pilot.md` 的评测节）。

`benchmark/results/` 里是盲审结果（delegation 模式，评审者没读过金标，**但规则模板是读过金标之后写的**，所以是「规则受污染的盲审」，数字当上限看）。按一对一打分：Critical/Important 召回 2/9，精度 6/18；人工逐条核对后真命中的 C/I 是 2/9，算上部分命中与存疑最多 4/9。`benchmark/results/upper-bound/` 是评审者读过金标后的一轮，数字偏高、作废，只留作对照。要得到 native 模式的数字：在配了 `OCR_API_KEY` 的 Environment 里，对三个 PR 的范围手动触发（`base`/`head` 见 `gold.json` 的 `range`），把 artifact 里的 `ocr-report.json` 交给 `score.ts`。`score.ts` 能读 delegation 报告，也读 native 报告里的 `comments` 数组（字段别名 `file/path`、`line/start_line`、`message/content` 都认）；native 报告的评论字段本机没有 key 跑不出来，没核实过。评测时用 `--exclude` 排除测试文件，是为了控制盲审的工作量；CI 里不排除。

跑测试：`bun test scripts/review/ocr`（在 `xiongbao/` 下）和 `bun test server/tests/ocr-review-workflow.test.ts`。
