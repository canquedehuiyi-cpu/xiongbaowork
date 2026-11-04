# 需要人工完成的步骤

这些步骤要用仓库管理员身份在 GitHub 网页上操作，或要用真机和密钥。自动化流程不能代做：没有对应权限，也按约束不创建 environment、secret 和 tag。按下面的顺序做，前一步是后一步的前提。

仓库：`canquedehuiyi-cpu/xiongbaowork`。`main` 已包含集成分支的全部工作，最近一次合并是 canquedehuiyi-cpu/xiongbaowork#180。

## 1. 把 `main` 设为默认分支

Settings → General → Default branch，切到 `main`。

- 为什么：`model-e2e.yml` 只在 `github.ref == 'refs/heads/main'` 时运行；`release.yml` 要求打 tag 的提交已在 `origin/main` 上。
- 怎么确认：仓库首页默认显示 `main`，新开 PR 的默认 base 是 `main`。

## 2. 给 `main` 加分支保护

Settings → Rules → Rulesets（或 Branches → Add rule），目标分支选 `main`：

- 合并前必须通过 PR；
- 必须通过的状态检查：`熊宝交付 CI` 的全部 job。最少要有 `static`、`app-test`、`server-test (1)`–`(6)`、`image`、各 `workspace tests (…)`、`desktop tests (windows-latest)`、`chart`、WakerFlow 生命周期 E2E；
- 禁止 force push 和删除分支；
- 合并方式只开 "Create a merge commit"，与目前的做法一致。

怎么确认：直接往 `main` 推送会被拒绝，未通过 CI 的 PR 不能合并。

## 3. 创建 GitHub Environment `model-e2e`

Settings → Environments → New environment，名称填 `model-e2e`：

- Deployment branches and tags：只允许 `main`；
- Environment secrets：新增 `DEEPSEEK_API_KEY`，值是 DeepSeek 的 key。**这个 key 只放在这里**，不要放进仓库级 secret、`.env` 或任何文件；
- 建议勾选 Required reviewers（填你自己），每次运行都要你批准，因为它会真实调用模型并产生少量费用。

## 4. 创建 GitHub Environment `release`

同一处新建 `release`：

- Deployment branches and tags：只允许 tag `v*.*.*` 和 `v*.*.*-rc.*`；
- 建议勾选 Required reviewers；
- 不需要额外 secret：推送 GHCR 用的是工作流自带的 `GITHUB_TOKEN`（`packages: write`）。

## 5. 归档并删除 `codex/*` 分支

一共 146 个，都是 Codex 早期产出、已被前移或替代的分支。

- 删除前先确认它们都不在任何未关闭的 PR 上（目前开着的只有 #54）。
- 想留档的话，先把分支名和 head SHA 导出成列表，再删除。

## 6. G6：从 `main` 手动跑一次 model-e2e

Actions → 「模型 E2E 计量对账」→ Run workflow，分支选 `main`，如果第 3 步开了 Required reviewers，还要在运行页批准。

- 会用真实 key 调用 DeepSeek，产生少量费用。
- 通过标准：计量对账 job 成功；平台用量页和 token 面板里出现这次运行的记录，数字与供应商返回的一致。

## 7. 准备首个发布

1. 定版本号，例如 `0.2.0-rc.1`。
2. 改 `openbot/package.json` 的 `version`，填**不带** `-rc` 的基础版本（如 `0.2.0`）。
3. 在 `openbot/CHANGELOG.md` 里把 `## Unreleased` 改名为 `## 0.2.0`（与基础版本一致），内容不能为空。需要写进去的升级提醒：
   - **`TENANT_RUNTIME` 生产默认改为 `device`（F6）。** Helm 升级后会切到 `device`；要保留原行为，设 `config.tenantRuntime=cloud`。
   - **新增迁移 0130（`avatar_sources`）和 0131（`agent_security_settings`，规则多了 `deny`）。**
   - **员工所有者设的收紧类规则现在对其他使用者也生效（SEC1 D9）。**
4. 通过 PR 把这两处改动合进 `main`，等 CI 全绿。

## 8. 打 tag 发布

在 `main` 上已合并的那个提交打 tag 并推送：

```bash
git fetch origin main
```

```bash
git tag v0.2.0-rc.1 origin/main
```

```bash
git push origin v0.2.0-rc.1
```

- 推送后 `熊宝发布` 自动运行。它会依次：检查 tag 格式、版本号、CHANGELOG 和祖先关系 → 在 tag 上重跑完整 CI → 构建镜像 → 推送 GHCR（`release` environment）。
- tag 一旦推送就不要移动：工作流会拒绝 tag 与提交对不上的运行。

## 9. 把 GHCR 包设为公开

首次发布推送镜像后：GitHub 个人或组织页 → Packages → 对应的包 → Package settings → Change visibility → Public。

- 不公开的话，客户和 G7 的匿名 `docker pull` 会失败。`clean-deploy.yml` 会在这一步失败，这是预期的。

## 10. G7：干净机器部署

- **Linux**：包公开后，Actions → 「熊宝干净部署（G7 Linux）」→ Run workflow，`tag` 填刚发布的版本。内置数据库和外部数据库两个 job 都要通过。
- **Windows**：找一台从没装过的 Windows 机器，按 `docs/deployment-qoderwake.md` 安装并启动，登录后创建一个员工跑一次任务。把截图和日志归档进 release 说明。

## 11. G5：真机设备验证

在一台真实电脑上验证设备端和权限：

1. 在「我的设备」里生成配对码，在那台电脑上运行 runner 完成配对（F2 阶段 1 合入后改用桌面安装包），页面显示设备在线。
2. 让员工在设备上执行一个普通命令，能成功。
3. 让员工执行 `rm -rf` 一类危险命令，必须先出现审批；拒绝后什么都不执行，批准后只执行一次（SEC1）。
4. 读 `.env` 一类敏感文件也要先审批。
5. 断开设备再发任务：任务进入等待；设备回线后继续执行（F4）。
6. 分身详情页添加一个信息来源，再问分身相关问题，回答里能体现这条来源（F1）。

每一步记录结果，有失败就开 issue，写清复现步骤。
