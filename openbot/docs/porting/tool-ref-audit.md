# 工具引用审计报告（tool-ref-audit）

> 生成方式：`tools/port-capabilities` 的审计器（规则表与 `capability-manifest.yaml` 头部指纹一致）。
> 本表是「到底移植成功了百分之几」的唯一可信答案，不用文件数汇报。
> 审计规则指纹：`9cbb849349cc794713c7434e3e05d1d4a28b216aff22b39c431eb62219e6426e`（与 manifest 头部一致即规则同源）。

## 汇总

| 类型 | full | degraded | blocked | 合计 |
|---|---|---|---|---|
| skill | 72 | 2 | 35 | 109 |
| agent | 27 | 0 | 1 | 28 |

- `full`：正文没有引用本环境不可执行的工具形态，声明即可用。
- `degraded`：引用了 file-tool 类工具（`Read(` 等）。P3 改写层（`rewrite-toolrefs.ts`）已把它们
  映射到 `computer_read_file` / `computer_write_file` 或在正文首部插入环境事实段——agent 侧除外
  （system_prompt 有 1000 字符上限合同，降级说明由 persona 技能承载）。
- `blocked`：正文真调用 shell / 引用可执行 scripts。openbot 员工没有 shell，**不 shim**，改写层
  只插入降级说明、原样保留调用证据。

## blocked / degraded 逐条

| 类型 | slug | 档位 | 规则 | 决定性命中（原文 + 行号 + 位置性质） | 命中数 |
|---|---|---|---|---|---|
| skill | `bot-creator` | blocked | `unknown-mcp-server` | L1（行内代码）：`先用 mcp__staffing__list_staff 看一眼现有的员工、群和能用的技能，别招重复的人。 一次问一个问题，把模糊的说法逼成能验收的边界：这个员工负责什么、明确不负责什么、越界时怎么回` | 4 |
| skill | `baseline-regression-triage` | blocked | `shell-command-prose` | L24（代码块内命令）：`git log --oneline -8                      # 找到任务起点` | 12 |
| skill | `code-error-fixer` | blocked | `shell-command-prose` | L170（代码块内命令）：`node --version && npx tsc --version` | 5 |
| skill | `cursor-memory-backup` | blocked | `shell-command-prose` | L120（代码块内命令）：`python scripts/cursor-memory-backup.py backup                    # 默认：D:\CursorMemoryBackup（Win）或 ~/` | 5 |
| skill | `darwin-skill` | blocked | `shell-command-prose` | L164（代码块内命令）：`git revert HEAD（创建新commit回滚，不用reset --hard）` | 8 |
| skill | `dev-expert--indiv-weishui` | blocked | `executable-scripts` | L12（散文提及）：`**幂等跳过**：hooks 已注册且图谱已建 → 免本步（仅首次 / 换机 / 环境变更时执行）。**前置检测（Python ≥3.8，须先做；由 Agent 用 Bash 在 Python 之外实` | 1 |
| skill | `dev-expert--skillhub` | blocked | `executable-scripts` | L10（散文提及）：`**幂等跳过**：hooks 已注册且图谱已建→免（仅首次/换机/环境变更执行）。**前置检测（Python≥3.8，Bash 实跑）**：Windows `py -3`→`python`→`pyth` | 1 |
| skill | `dev-expert--user-814dbe54` | blocked | `executable-scripts` | L10（散文提及）：`**幂等跳过**：hooks 已注册且图谱已建→免（仅首次/换机/环境变更执行）。**前置检测（Python≥3.8，Bash 实跑）**：Windows `py -3`→`python`→`pyth` | 1 |
| skill | `dev-expert-pro` | blocked | `shell-command-prose` | L43（代码块内命令）：`python3 "<本技能目录>/scripts/skill_lookup.py" @harmonyos` | 2 |
| skill | `dev-god` | blocked | `shell-command-prose` | L18（代码块内命令）：`python3 <本技能目录>/scripts/project_probe.py <目标工程目录>` | 2 |
| skill | `fore-vip-pc-clear` | blocked | `shell-command-prose` | L63（代码块内命令）：`python3 scripts/gen_clean_script.py --platform macos --title "PC清理" --steps steps.json` | 2 |
| skill | `frontend-artifact-contract-drift-triage` | blocked | `shell-command-prose` | L61（代码块内命令）：`ssh -i key.pem ubuntu@host 'sudo env NODE_PATH=<release>/node_modules /usr/bin/node /tmp/probe.js'` | 3 |
| skill | `frontend-build-verification` | blocked | `shell-command-prose` | L17（代码块内命令）：`npx tsc --noEmit          # 类型` | 3 |
| skill | `frontend-developer--browser-use` | blocked | `shell-tool-call` | L234（散文提及）：`- **Bash(browser-use:*)**: 使用 Bash(browser-use:*) 工具` | 1 |
| skill | `frontend-developer--frontend-dev` | blocked | `executable-scripts` | L18（散文提及）：`├── scripts/                      # Asset generation scripts` | 1 |
| skill | `frontend-developer--fullstack-dev` | blocked | `shell-command-prose` | L351（代码块内命令）：`npx prisma migrate dev          alembic revision --autogenerate  migrate -source file://migrations` | 2 |
| skill | `fullstack-dev` | blocked | `shell-command-prose` | L351（代码块内命令）：`npx prisma migrate dev          alembic revision --autogenerate  migrate -source file://migrations` | 2 |
| skill | `graphify` | blocked | `shell-command-prose` | L408（代码块内命令）：`python run.py --selftest` | 2 |
| skill | `hash-bound-review-loop` | blocked | `shell-command-prose` | L9（行内代码）：`3. **不复述工具输出**。任何数字（diff、计数、时间）必须在**产出该字节的那个 worktree 里真跑该工具**。曾因把旧记录里的 `git --shortstat` 数字照抄，被审查判为` | 3 |
| skill | `hostile-git-repo-recovery` | blocked | `shell-command-prose` | L28（代码块内命令）：`git init -q t && cd t && git commit -q --allow-empty -m x` | 41 |
| skill | `humanize-ppt-team--frontend-slides` | blocked | `shell-command-prose` | L246（行首命令）：`bash scripts/deploy.sh <path-to-presentation>` | 5 |
| skill | `humanize-ppt-team--guizang-ppt-skill` | blocked | `shell-command-prose` | L234（行内代码）：`- JS 检查：把非 module inline script 抽出后跑 `node --check`。` | 1 |
| skill | `humanize-ppt-team--html-ppt` | blocked | `executable-scripts` | L94（散文提及）：`./scripts/new-deck.sh my-talk` | 6 |
| skill | `humanize-ppt-team--humanize-ppt` | blocked | `executable-scripts` | L78（代码块内命令）：`python3 scripts/humanize_ppt_v1.py \` | 2 |
| skill | `mutation-driver-engineering` | blocked | `shell-command-prose` | L197（代码块内命令）：`python -c "` | 4 |
| skill | `postgres-real-verification` | blocked | `shell-command-prose` | L42（代码块内命令）：`node node_modules/vitest/vitest.mjs run --no-file-parallelism <文件…>` | 2 |
| skill | `ppt-craft-master` | blocked | `executable-scripts` | L336（行内代码）：`- **路径 B（脚本）**：先产结构化大纲 JSON（每页 type/title/要点/数据/版式/金句），喂给 `scripts/generate.js`。` | 1 |
| skill | `project-expert-orchestration` | blocked | `unknown-mcp-server` | L8（行内代码）：`4. 列出项目可用专家：`mcp__wb-issues__automation_list_experts`（返回 `expert_id` / `display_name_zh` / `professi` | 1 |
| skill | `remotion-video-toolkit` | blocked | `shell-command-prose` | L130（代码块内命令）：`npx remotion render src/index.ts MyComposition out/video.mp4` | 1 |
| skill | `reverse-engineering-fusion` | blocked | `executable-scripts` | L186（行内代码）：`- `scripts/test-nes.ts` - 集成测试脚本` | 1 |
| skill | `senior-developer--frontend-dev` | blocked | `executable-scripts` | L10（散文提及）：`├── scripts/                      # AI 资产生成脚本` | 1 |
| skill | `video-content-forensics` | blocked | `shell-command-prose` | L35（散文提及）：`# 首次：cd /c/Users/<user>/.workbuddy/binaries/node/workspace && npm i playwright && npx playwright ins` | 1 |
| skill | `windows-pc-tuneup` | blocked | `executable-scripts` | L10（行内代码）：`4. **出建议或交付 bat**：建议逐条过 references 清单 §5 自检门禁后再输出；bat 以 `templates/tuneup-template.bat` 为骨架填充，交付前必跑 ` | 1 |
| skill | `wiring-and-coverage-audit` | blocked | `shell-command-prose` | L42（代码块内命令）：`npx tsc --noEmit --listFiles > /tmp/before.txt     # 记录基线` | 2 |
| skill | `workbuddy-safe-delete-guard` | blocked | `shell-command-prose` | L40（代码块内命令）：`python - <<'EOF'` | 2 |
| skill | `persona-gstack-qa-lead` | degraded | `references-without-assets` | L32（行内代码）：`3. **Collect issues** — Classify using `references/issue-taxonomy.md` (from qa skill)` | 1 |
| skill | `persona-xtgxiso-windows-pc-care` | degraded | `references-without-assets` | L112（行内代码）：`> **脚本模板见 `references/script-templates.md`，需要时再读取**，不要把模板常驻在每一次回答里。` | 1 |
| agent | `frontend-slides-renderer` | blocked | `executable-scripts` | L9（行内代码）：`3. 如果需要部署或 PDF 导出，优先使用 Skill 内置 `scripts/deploy.sh` 与 `scripts/export-pdf.sh` 的规则。` | 1 |

## 抽样复核（G3：blocked 数与人工抽样一致）

从 blocked 中抽 5 条（首、次、中、次尾、尾各一），用**独立于审计规则表**的朴素正则人工复核：

- **bot-creator**（skill）：朴素正则复核 → mcp__staffing__* 引用但 connectors.yaml 无此 server。✅ 一致
- **baseline-regression-triage**（skill）：朴素正则复核 → 命令词 + 管道/重定向/heredoc 特征；行首命令词 + flag/路径实参。✅ 一致
- **hash-bound-review-loop**（skill）：朴素正则复核 → 行内代码 命令词 + flag。✅ 一致
- **workbuddy-safe-delete-guard**（skill）：朴素正则复核 → 命令词 + 管道/重定向/heredoc 特征；行首命令词 + flag/路径实参。✅ 一致
- **frontend-slides-renderer**（agent）：朴素正则复核 → 引用 scripts/ 可执行文件。✅ 一致

## 已知限制（假阳性 / 假阴性两边都要写）

| 方向 | 例子 | 取舍 |
|---|---|---|
| 已接受**假阳性** | `Bash (shell)`（半角括号 + 空格）判为 blocked | 接受。放宽会连带丢掉 `Bash(npm install)` 这个真调用；中文散文用全角括号天然不命中 |
| 已接受**假阴性** | 单竖线散文 `cat f \| grep x` 不命中 | 接受。单 `|` 在 Markdown 表格里远比 shell 管道常见；`||`、`&&`、$(: `()、`>` 仍匹配，括号形态由规则 A 兜底 |

两条都有单测钉住（`audit-toolrefs.test.ts`），没有测试的"已接受"只是还没被人推翻的临时状态。

## 改写层（P3）与本表的关系

- 本表档位 = **落位管线最终口径**：改写层对 blocked/degraded 技能正文插入环境事实段并做
  file-tool 映射，改写后重审计，档位以改写后正文计（blocked 不许变好，管线内有断言）。
- agent 的 `system_prompt` 不经改写层（1000 字符上限合同），其档位即原始审计结果。
