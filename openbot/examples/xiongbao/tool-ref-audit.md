# 工具引用审计

audit_rules_sha256: 9cbb849349cc794713c7434e3e05d1d4a28b216aff22b39c431eb62219e6426e

本文件由 `bun run port:capabilities` 按 `mapping.ts` 的规则表静态扫描生成。

档位：`full` 可执行 / `degraded` 需改写后才能跑 / `blocked` 本环境不可执行。

## 技能（skills.yaml 的 instructions）

合计 60 条：full 26 / degraded 0 / blocked 34。

| slug | runnable | margin | 命中的引用 | 原因 |
| --- | --- | --- | --- | --- |
| agent-team-orchestration | full | — | — | 无命中 |
| awesome-design-md | full | — | — | 无命中 |
| baseline-regression-triage | blocked | — | shell-command-prose:"git log --oneline -8 # 找到任务起点"（共 11 处）; executable-scripts:"scripts/*`）。" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| canvasflow-ppt | full | — | — | 无命中 |
| code | full | — | — | 无命中 |
| code-error-fixer | blocked | — | shell-command-prose:"npx tsc --version"（共 5 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| code-review-and-quality | full | — | — | 无命中 |
| cursor-memory-backup | blocked | — | shell-command-prose:"python scripts/cursor-memory-backup.py backup # 默认：D:\Curso…"（共 4 处）; executable-scripts:"scripts/cursor-memory-backup.py`，只用标准库（Python 3.8+）。" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| darwin-skill | blocked | — | shell-command-prose:"git revert HEAD（创建新commit回滚，不用reset --hard）"（共 6 处）; executable-scripts:"scripts/screenshot.mjs 截图（2x 高清，只截 .card 元素，自动 open 图片）："; references-without-assets:"references/scripts/assets引用正确、路径可达 /" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 正文引用 references/ 下的附件，而该技能没有随包附上 references/。 |
| design-token-forensics | full | — | — | 无命中 |
| dev-expert--indiv-weishui | blocked | `incidental` | executable-scripts:"scripts/init_deploy.py`（dry-run → `--apply`：写前 `.bak`、幂等合并、…" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| dev-expert--skillhub | blocked | `incidental` | executable-scripts:"scripts/init_deploy.py`（dry-run→`--apply`：写前 `.bak`、幂等合并、只追…" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| dev-expert--user-814dbe54 | blocked | `incidental` | executable-scripts:"scripts/init_deploy.py`（dry-run→`--apply`：写前 `.bak`、幂等合并、只追…" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| dev-expert-pro | blocked | — | shell-command-prose:"python3 "<本技能目录>/scripts/skill_lookup.py" @harmonyos"; executable-scripts:"scripts/project_probe.py) /" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| dev-god | blocked | — | shell-command-prose:"python3 <本技能目录>/scripts/project_probe.py <目标工程目录>"; executable-scripts:"scripts/project_probe.py)：" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| engineering-workflow | full | — | — | 无命中 |
| fore-vip-pc-clear | blocked | — | shell-command-prose:"python3 scripts/gen_clean_script.py --platform macos --titl…"; executable-scripts:"scripts/gen_clean_script.py`，把本次全部步骤生成为一键清理脚本放到**桌面**：" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| frontend-artifact-contract-drift-triage | blocked | — | shell-command-prose:"ssh -i key.pem ubuntu@host 'sudo env NODE_PATH=<release>/no…"（共 3 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| frontend-build-verification | blocked | — | shell-command-prose:"npx tsc --noEmit # 类型"（共 3 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| frontend-developer--brand-guidelines | full | — | — | 无命中 |
| frontend-developer--browser-use | blocked | `incidental` | shell-tool-call:"Bash(browser-use:*)**: 使用 Bash(browser-use:*) 工具" | 正文调用 Bash/Shell/Terminal(...)；openbot 员工没有本地 shell。 |
| frontend-developer--frontend-dev | blocked | `incidental` | executable-scripts:"scripts/ # Asset generation scripts" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| frontend-developer--fullstack-dev | blocked | — | shell-command-prose:"npx prisma migrate dev alembic revision --autogenerate migr…"（共 2 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| frontend-developer--github | full | — | — | 无命中 |
| frontend-developer--impeccable | full | — | — | 无命中 |
| fullstack-dev | blocked | — | shell-command-prose:"npx prisma migrate dev alembic revision --autogenerate migr…"（共 2 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| github | full | — | — | 无命中 |
| graphify | blocked | — | shell-command-prose:"python run.py --selftest"（共 2 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| grill-me | full | — | — | 无命中 |
| gstack--design-html | full | — | — | 无命中 |
| gstack--qa | full | — | — | 无命中 |
| gstack--review | full | — | — | 无命中 |
| hash-bound-review-loop | blocked | `incidental` | shell-command-prose:"git --shortstat` 数字照抄，被审查判为 blocker。"（共 3 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| hostile-git-repo-recovery | blocked | — | shell-command-prose:"git init -q t && cd t && git commit -q --allow-empty -m x"（共 14 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| humanize-ppt-team--frontend-slides | blocked | — | shell-command-prose:"bash scripts/deploy.sh <path-to-presentation>"（共 4 处）; executable-scripts:"scripts/extract-pptx.py <input.pptx> <output_dir>` (install…" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| humanize-ppt-team--guizang-ppt-skill | blocked | `incidental` | shell-command-prose:"node --check`。" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| humanize-ppt-team--html-ppt | blocked | `incidental` | executable-scripts:"scripts/"; shell-command-prose:"sh templates/theme-showcase.html # one shot"（共 5 处） | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| humanize-ppt-team--humanize-ppt | blocked | — | executable-scripts:"scripts/humanize_ppt_v1.py \"; shell-command-prose:"python3 scripts/humanize_ppt_v1.py \" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| mutation-driver-engineering | blocked | — | shell-command-prose:"python -c ""（共 3 处）; executable-scripts:"scripts/`）" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| postgres-real-verification | blocked | — | shell-command-prose:"node node_modules/vitest/vitest.mjs run --no-file-paralleli…"（共 2 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| ppt-craft-master | blocked | — | shell-command-prose:"npm install -g pptxgenjs"（共 3 处）; executable-scripts:"scripts/generate.js`。" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| ppt-designer | full | — | — | 无命中 |
| ppt-generator | full | — | — | 无命中 |
| ppt-logic-organizer | full | — | — | 无命中 |
| project-expert-orchestration | blocked | `incidental` | unknown-mcp-server:"mcp__wb-issues__automation_list_experts" | 正文引用 mcp__<server>__<tool>，而该 server 不在 connectors.yaml 里。 |
| prompt-engineering-expert | full | — | — | 无命中 |
| qqbrowser-skill | full | — | — | 无命中 |
| remotion-video-toolkit | blocked | — | shell-command-prose:"npx remotion render src/index.ts MyComposition out/video.mp4" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| reverse-engineering-fusion | blocked | `incidental` | executable-scripts:"scripts/test-nes.ts` - 集成测试脚本" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| senior-developer--frontend-dev | blocked | `incidental` | executable-scripts:"scripts/ # AI 资产生成脚本" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| senior-developer--fullstack-dev | full | — | — | 无命中 |
| senior-developer--skillhub | full | — | — | 无命中 |
| super-all-around-ppt-master | full | — | — | 无命中 |
| superpowers | full | — | — | 无命中 |
| token-efficient-dev | full | — | — | 无命中 |
| video-content-forensics | blocked | `incidental` | shell-command-prose:"npm i playwright && npx playwright install chromium" | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| windows-pc-tuneup | blocked | `incidental` | executable-scripts:"scripts/check_bat.py`（静态检查）+ `scripts/test_bat_ps.py`（内嵌命令实…" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| wiring-and-coverage-audit | blocked | — | shell-command-prose:"npx tsc --noEmit --listFiles > /tmp/before.txt # 记录基线"（共 2 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |
| workbuddy-market-export | full | — | — | 无命中 |
| workbuddy-safe-delete-guard | blocked | — | shell-command-prose:"python - <<'EOF'"（共 2 处） | 正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 |

其中 13 条标 `incidental`：判定成立，但决定性命中落在“散文里夹带的命令”或“纯描述性提及”，删掉那句话判定就会翻。

## 专家（agents.yaml 的 system_prompt）

合计 23 条：full 21 / degraded 1 / blocked 1。

| slug | runnable | margin | 命中的引用 | 原因 |
| --- | --- | --- | --- | --- |
| code-architect-expert | full | — | — | 无命中 |
| engineering-workflow-coach | full | — | — | 无命中 |
| frontend-developer | full | — | — | 无命中 |
| frontend-slides-renderer | blocked | `incidental` | executable-scripts:"scripts/deploy.sh` 与 `scripts/export-pdf.sh` 的规则。" | 正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。 |
| gstack-designer | full | — | — | 无命中 |
| gstack-investigator | full | — | — | 无命中 |
| gstack-lead | full | — | — | 无命中 |
| gstack-product-reviewer | full | — | — | 无命中 |
| gstack-qa-lead | degraded | — | references-without-assets:"references/issue-taxonomy.md` (from qa skill)" | 正文引用 references/ 下的附件，而该技能没有随包附上 references/。 |
| gstack-security-officer | full | — | — | 无命中 |
| guizang-renderer | full | — | — | 无命中 |
| html-ppt-presenter | full | — | — | 无命中 |
| humanize-ppt-team-lead | full | — | — | 无命中 |
| outline-director | full | — | — | 无命中 |
| qa | full | — | — | 无命中 |
| senior-developer | full | — | — | 无命中 |
| software-architect | full | — | — | 无命中 |
| software-engineer | full | — | — | 无命中 |
| software-product-manager | full | — | — | 无命中 |
| software-qa-engineer | full | — | — | 无命中 |
| software-team-lead | full | — | — | 无命中 |
| video-motion-agent | full | — | — | 无命中 |
| xtgxiso-windows-pc-care | full | — | — | 无命中 |

其中 1 条标 `incidental`：判定成立，但决定性命中落在“散文里夹带的命令”或“纯描述性提及”，删掉那句话判定就会翻。

## 已知限制（成对列出，单写一边等于没写）

| 方向 | 例子 | 取舍 |
| --- | --- | --- |
| 已接受的**假阳性** | `Bash (shell)`（半角括号 + 空格）判 blocked | 接受。半角括号形态一律当调用处理；放宽它会连带丢掉 `Bash(npm install)` 这个真调用。中文正文用全角 `（`，天然不命中。**单测已钉住，别放宽** |
| 已接受的**假阴性** | ``` `cat f \| grep x` ``` 这类散文里的单竖线管道不命中 | 接受。单 `\|` 在 Markdown 表格里远比 shell 管道常见，放行会让几乎每张表都变成 blocked；`\|\|`、`$(` 与括号形态仍覆盖真实场景 |
| 有意保留的**债** | 只依赖 `git`/`docker`/`kubectl`/`ssh` 且不含现词表命令的技能会被判 full | `git status` 既可能是“去跑它”，也可能是“看它的输出做诊断”，词表分不出祈使与描述。收进词表会把第二种批量误判成 blocked，比现在的假阴性更坏。这是有意保留，不是遗漏 |
| 无否定语境护栏（已撤） | `不要用 \`ssh host 'node -e "…"'\` 做关键判定` 单独成段时判 blocked | 有意接受。护栏在全语料实测 0 例假阳性、却产出可复现的假阴性（禁止句后半句的真依赖被一起豁免），故整套撤掉；禁止句误报靠引文质量排序兜底。重建条件见 `audit-toolrefs.ts` 内的裁定注释 |

