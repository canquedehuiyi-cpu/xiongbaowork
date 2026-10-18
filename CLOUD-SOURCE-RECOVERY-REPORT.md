# 云端修复记录源码恢复盘点（2026-10-18）

## 当前结论

本报告是在 Gitee 网页在线编辑器中创建的恢复盘点。它不包含 288 个版本的源码正文，不表示完整 C88 已恢复，也不表示这些修复已接入当前应用源码。

用户要求继续线上开发，本地不落代码。本轮没有向本地写入源码、补丁、克隆目录或恢复包，没有本地安装、构建或测试。完整源码正文仍保留在原始云端会话记录中；本轮在内存中提取和校验。云端终端目前启动失败，批量正文归档、完整基线恢复和运行验证尚未执行。

本轮开始时，Gitee 默认恢复分支为 codex/recovered-source-20261018，基线 commit 为 8395eb468cb3a35a63458b0d3d48037b29f8c203，2079 个文件。该基线主要来自 2026-10-10 至 10-11 的旧源码与先前恢复材料。

## 已完整读取的额外云端会话

以下六条均已分页读至 hasMore=false，共 536 个可见回合。没有把仅有提交号、测试结论、替换配方或未拼完整的代码块计为完整源文件。

| 会话 | durable 会话 ID | 回合数 |
| --- | --- | ---: |
| 熊宝云端 S4：Windows vctip 阻断修复 | 01a143c7-6dad-74ed-bc6c-ab231eced0a5 | 153 |
| 熊宝云端 S3：WakerFlow 原生动作修复 | 01a143b6-171f-70c3-87bc-01fef353c0b9 | 136 |
| 熊宝云端 S5：SourceOS 61项失败与模型夹具修复 | 01a1444e-5ee2-7649-948a-ba17eb88c0bf | 126 |
| 模型 observer/resolver 修复记录（原界面为编号） | 01a1486e-4919-7124-a06d-60fa5e76c0a5 | 65 |
| 原生 launcher/session 桥修复记录（原界面为编号） | 01a148d0-2161-7241-a970-2168749e0090 | 46 |
| 迁移与镜像诊断修复记录（原界面为编号） | 01a148b2-3ad0-721b-bb14-7c7dfcb0709d | 10 |

已识别并核对 288 个完整文件版本，覆盖 164 个逻辑路径，合计 14,127,313 个 UTF-8 字节。同一路径可有多个历史版本或未发布候选，因此不能把 288 当成当前应用文件数量。

- 200 个版本：来自历史 create_blob 的完整 content 参数，重新计算 Git blob 后与记录中的 tree/CAS 身份相符。
- 85 个版本：完整源码围栏的字节数和 Git blob 与其声明相符；同时记录重新计算的 SHA256。
- 3 个版本：SOURCE_BEGIN/END 分块按字符偏移完整拼回，字节数、Git blob 和声明的 SHA256 均相符。

哈希核对只证明恢复文本与记录身份一致，不证明该版本已发布、依赖完整、运行正确或达到交付标准。

覆盖范围包括审批服务、插件和 WakerFlow 存储、runner 执行/权限/HTTP、设备安全、工具链 producer/锁/测试、原生启动器、数据库迁移、镜像诊断与测试源码。初步内存模式扫描未发现私钥头、GitHub token、sk- 类 key 或 AWS access-key 模式；发现任何疑似秘密时仍须在实际推送源码前复核。此处没有上传原始聊天全文、配置包、数据库或凭据。

## 三个分块文件的精确校验身份

### openbot/agent-computer/src/shell.ts

- UTF-8 bytes: 29126
- Git blob: b29bafb4985e3f5d93c67b54d701aea65188de14
- SHA256: 3b76512c30ff9703e91c7e4a5cb8d6a9a36e87e706d03f4b1cab78c4fdfcfb5f

### openbot/server/tests/runner-security.test.ts

- UTF-8 bytes: 48586
- Git blob: 0c7ba9f30a9ebed6e42717b659e13213d46752ca
- SHA256: e9eefc98499541a542f98c840db5e64a59fe55c91ebf634ca9225344d3d38ec9

### openbot/scripts/ci/windows-native-test.ps1

- UTF-8 bytes: 109540
- Git blob: cd3e5a3bc0dbd8dfd8c3f52814d5ee6c1c071b86
- SHA256: cff57e8a2a03e5386386dae84ce90526ba6541d5852fe52f01eaa2ae397db3c3

以上三个版本的来源均为 S4 会话 01a143c7-6dad-74ed-bc6c-ab231eced0a5 的回合 01a14c7d-87ff-77ee-b6db-67572f6985ae。Windows 脚本两个分块的字符偏移为 [0,55000) 和 [55000,109531)，没有将边界新增换行混入源码。

## 完整恢复索引的云端留存

288 个版本的完整索引已发送到现有云端恢复会话《设置 xiongbao-Wake-》，ID 为 01a1390b-52ef-738e-a35d-9ecb53d62081，hostId=durable。每条记录含路径、bytes、Git blob、SHA256，以及来源 thread/turn/item。索引不含源码正文。

索引 JSON 原件身份：

- UTF-8 bytes: 127541
- Git blob: fb11ed99006be92b07e456d221a25ca3cb547a92
- SHA256: 1dbb4c3db5e7b8c345040bd240ae20d8d8434bd6a4988944ccd98429e27d5c95

恢复索引的状态为 RECOVERED_TEXT_ONLY_NOT_C88_BASELINE。原始源码正文可按索引回到上述六条已确认会话提取；不得将此索引当成源码包。

## 云端执行环境的当前阻塞

用户已明确授权向《设置 xiongbao-Wake-》发送恢复任务。该会话调用环境工具后报告：Environment provisioning failed during authorization，Cause: connector_failed。没有确认可用的云端终端，也没有运行旧句柄。

只读诊断报告 observations_current=true、desired_phase=running、observed_phase=pending、connectivity=offline、网络当前状态 unknown。错误未明确归因于 GitHub，具体连接器和根因仍未知。配置草稿 revision 3 与实例所用 spec revision 2 不同，不能混为已生效配置。

草稿仍绑定旧 GitHub main，安装脚本依赖旧 /workspace/.xiongbao-cloud。当前可读写草稿的工具不能重新授权或重启实例。schema 支持空 repositories 和空 install_script，但仓库列表更新要求先完成真实文件系统检查；失败环境无法满足此前提，所以没有保存未经核验的空仓库声明。

待用户在环境设置中审阅的最小方案：解除旧 GitHub 自动取仓，清空旧安装脚本，在保留现有配置的前提下添加 gitee.com 网络域名，然后处理连接器授权错误并重试启动。此方案未保存、未发布、未生效。域名列表缺项不等于已经实测 Gitee DNS/TLS/认证失败。

参考官方环境设置说明：https://learn.chatgpt.com/docs/environments/cloud-environments

## 后续执行顺序与验收边界

1. 先恢复云端终端，实际检查旧工作区和只读 Git 对象/完整源码，不把路径记录当成现存文件证明。
2. 在云端正常认证 Gitee；不得从本机提取或转移 Git Credential Manager、浏览器令牌或 SSH 私钥。
3. 将本轮 288 个完整版本、来源索引和哈希清单作为恢复档案推入 Gitee；正文未归档前保持明确待办。
4. 找到完整基线并按树、blob、SHA256 核对依赖后，再建恢复分支接入修复。不能把不兼容候选直接覆盖到 10 月 10-11 日的旧源码。
5. 云端执行安装、构建、基本启动与必要测试；随后再重新验证 77 项需求和 7 个最终门禁。

历史最新 C88 标识为 commit b374644f38c5338b825d317da5a08bb1b96f8166 / tree 6cf9f2ab4dc70bdc8e848161a4aef000492a458b / 2794 blobs，目前仍未确认完整源码恢复。未发布 C89 的拟树不能冒称实际提交。

本报告没有应用产品修复，没有执行构建、测试、CI、付费模型调用或生产部署；没有把历史测试结果计为本轮通过。
