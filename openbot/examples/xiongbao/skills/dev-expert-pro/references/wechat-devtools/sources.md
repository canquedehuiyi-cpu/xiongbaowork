# 微信工具资料来源与适配版本

本模块在 2026-10-08 根据用户提供并说明为微信官方的 `wechatide-skill` 本地包整合。原入口及 `skill.yaml` 均标记 **0.3.11**；[工具注册表](tools.yaml)保持原始字节，用于按需核对工具名、参数和 action。编程大神自身版本与该协议版本独立，不能把编程大神版本传给 `check_wechatide_status --skill-version`。

| 来源 | 本模块位置与处理 |
| --- | --- |
| 根入口、environment-readiness、installer 说明和四个安装辅助脚本 | [环境与版本](environment.md)：静态核对兼容条件，没有复制或运行安装脚本 |
| initializer、project-manager、compiler、previewer、create-project-guide、错误指南 | [项目与交付](project-workflows.md)：区分创建/导入/开窗、编译/刷新、预览/上传 |
| automator、debugger | [自动化与调试](automation-debugging.md)：按页面/画布、截图坐标和实际副作用使用 |
| project-config、project-config-fields | [项目配置](project-config.md)：本地共享/private 配置优先级和验证边界 |
| cloudbase-operator、消息推送参考 | [CloudBase](cloudbase.md)：工具与环境绑定、读写区分及未知结果恢复 |
| tools.yaml、tool-index | [工具索引](tool-index.md)和原注册表：49 个定义，含两个废弃配置工具 |
| approval-policy、async-task-polling | [总入口](index.md)：保留工具自身交互与 taskId 规则，继承用户既有授权；凭据由宿主/本地文件隔离，不照搬让模型索取或记住 Token 的条款 |

用户提供的较早门槛是 **Nightly Electron Build 2.02.2607032**；本地 0.3.11 安装辅助代码的兼容常量为 **2.02.2607152**，检测已安装版本时允许等于，筛选新下载包时要求严格大于。来源包内部的这一差异被明确保留说明，没有把旧提示当成当前充分条件。官方下载入口为[微信开发者工具更新日志/Nightly](https://developers.weixin.qq.com/miniprogram/dev/devtools/log#nightly)，安装前核对真实平台、渠道和文件来源。

这是本地提供包的整合快照，不声称与微信线上最新版本永远同步。新安装的 IDE 若报告适配资料落后，更新这一微信模块的资料并重新核对，不能把整个编程大神目录或开发者工具安装目录直接覆盖为上游 Skill。

工具 schema 是能力目录，不是授权，不保证本机工具或云账户已就绪；本模块没有附带 IDE、云服务账号、上传私钥、登录态或工具安装器。知识文档和 schema 不代表已经成功登录、编译、预览或上传。来源中未附独立许可证文件；保留来源与协议版本，不据此将第三方内容改标为本产品原创或 MIT。
