# 鸿蒙 / ArkTS / ArkUI

修改鸿蒙应用、排查编译或进行设备验证时读取。此页是工作指引，执行记录才是具体项目的通过证据。

## 内置知识按问题读取

| 本次任务 | 读取内容 |
| --- | --- |
| 编写/修改 ArkUI 页面、组件、状态、布局和导航 | [ArkUI 知识索引](harmonyos/arkui/index.md)，再定位相关 API 卡片和编码规则 |
| 编译失败、类型不匹配、对象/组件/窗口等错误 | [编译错误定位与修复](harmonyos/compile-errors.md)，以编译器实际诊断和目标 SDK 声明核对 |
| 启动/点击后闪退、白屏、jscrash、异常栈、OOM | [运行时诊断索引](harmonyos/runtime/index.md)，先取得本次错误证据，再读匹配的模式 |

这些资料已经包含在本技能中，不依赖另一套 Skill 的本机安装目录。它们是按主题整理的知识参考，不能替代目标 SDK 的类型声明或实际验证；来源与适配说明见[资料说明](harmonyos/sources.md)。普通页面改动只读相关卡片，不加载全部鸿蒙知识；编译错误与运行时错误分开处理，白屏也不能仅凭症状判定 jscrash。

## 工程与 API

- 从 `build-profile.json5`、`oh-package.json5`、`hvigorfile.*`、应用及模块配置定位 product、module、target、构建模式和包名。确认 HarmonyOS/OpenHarmony、Stage/FA、ArkTS 版本、目标与兼容 SDK；只按该工程实际存在的字段判断，不把所有版本的配置格式混用。
- 读取现有页面、导航、组件与状态管理写法，再修改 ArkUI。区分状态管理 V1/V2，检查生命周期、订阅释放和异步任务回到页面时的状态；不以普通 TypeScript 或浏览器 DOM 规则代替 ArkTS/ArkUI 限制。
- 新增 API 先查安装 SDK 的声明与对应官方文档，确认起始版本、系统能力、设备类型、权限及回调错误。宿主有华为官方知识工具时用它检索；没有时查华为文档。不要为了让单个 API 编译而擅自抬高整个工程的最低兼容版本。

## 构建与设备

使用项目已有脚本、CI、匹配版本的 Hvigor/ohpm、DevEco Studio 或宿主现有工具；本技能不要求安装额外的 CLI 包装器。确认依赖、SDK 路径和目标配置，避免只调用机器上的任意全局版本。签名检查只读必要的非秘密元数据及本地路径；安装前确认构建产物、签名适用设备和已授权目标一致。

先发现可用的 hdc/IDE 与连接设备，再选择明确目标。安装或启动失败时按构建、签名、兼容版本、连接状态、启动入口逐层定位；不能靠清空用户数据或换成无关页面制造成功。

## 分层验收

| 层次 | 应保留的证据与边界 |
| --- | --- |
| 静态/构建 | 实际目标、命令、退出状态、HAP 等产物；产包不代表安装成功 |
| 安装/启动 | 对应设备、应用标识、安装结果、启动入口及相关日志 |
| 页面布局 | 导航到本次目标页，取得截图；可用时结合布局树，布局树不代替视觉核对 |
| 交互/运行时 | 执行涉及的点击、输入、返回、前后台等操作，核对状态和错误日志 |

Debug 与 Release、模拟器与真机分别标注。UI 改动须到目标页面验证；网络、媒体、权限、系统集成需走相关实际路径。只有截图不能证明交互通过；只有启动不能证明功能通过。缺少签名或设备时完成其余工作，交接明确缺哪一层和如何复验。

官方依据：[工程配置](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor-build-profile-app)、[命令行构建](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-command-line-building-app)、[Stage 工程与真机运行](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/start-with-ets-stage)、[UI 测试](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uitest-guidelines)。实现时重新核对与项目版本相关的章节。
