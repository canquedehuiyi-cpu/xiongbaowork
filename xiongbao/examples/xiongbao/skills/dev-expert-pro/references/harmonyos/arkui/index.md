# ArkTS / ArkUI 按需知识库

来源是用户提供的新版 `hmos-arkui-develop-skill` 的 API 卡片与编码规则；本次按项目兼容性和本机 API 24 类型声明校准部分冲突。它是编程大神的参考资料，不是另一份独立 Skill 入口，也不要求额外 CLI。

先确认工程的 `compileSdkVersion`、`compatibleSdkVersion`、ArkTS 版本、Stage/FA 模型、状态管理和导航方式。**保留项目正在使用且兼容的架构**；修一个页面不要求迁移全项目到 V2、Navigation 或 `@kit`。

- 查构造参数、组件属性、事件、枚举、资源名：先看 [API 索引](quick-apis/_index.md)，再按组件名读取相关卡片。
- 写状态、列表、导航、弹窗，或处理编译错误：看 [规则索引](quick-rules/_index.md)，只读取匹配主题。
- API 卡片是定位线索，含省略重载的摘要；不是可原样粘贴的完整 `.d.ts`。新增调用的精确签名、可用版本和设备能力由**目标工程 SDK 声明和对应版本官方文档**核对。源码 `.d.ts` 里的 `unknown` 等声明不表示应用 `.ets` 可以照抄此类型。
- 本轮校准覆盖发现的实质冲突，未逐一编译验证所有卡片和资源名。优先复用当前项目已通过的调用，并用本次修改相关的构建/运行证据验收。

| 当前工作 | API | 规则 |
|---|---|---|
| TS 转 ArkTS、类型或导入错误 | 按报错查 API | [语法](quick-rules/00-arkts-syntax.md)、[导入](quick-rules/01-import.md) |
| Text / Button / Image / 输入控件 | [基础组件](quick-apis/02-basic-components.md) | [属性参数](quick-rules/07-attribute-params.md)、[UI 上下文](quick-rules/02-uicontext.md) |
| List / Grid / Scroll / Tabs | [布局](quick-apis/01-layout.md)、[渲染](quick-apis/13-rendering.md) | [布局](quick-rules/12-layout.md)、[渲染](quick-rules/06-rendering.md) |
| 状态更新、Builder、父子通信 | [状态 API](quick-apis/08-state-decorators.md) | [状态与混用](quick-rules/05-state.md) |
| 页面导航、返回、路由参数 | [导航](quick-apis/12-navigation.md) | [导航规则](quick-rules/08-navigation.md) |
| 弹窗、Sheet、菜单 | [弹窗](quick-apis/11-dialog-menu.md) | [弹窗规则](quick-rules/09-dialog.md) |
| 动画、样式、手势 | [动画](quick-apis/09-animation.md)、[手势](quick-apis/10-gesture.md) | [样式](quick-rules/10-style.md)、[扩展](quick-rules/11-extension.md) |
| 卡顿、列表复用、可见性 | 按组件查 API | [性能](quick-rules/13-performance.md) |

原参考文件未标注独立许可证或作者署名；保留其 Skill 名称与来源线索，不宣称这些资料采用 MIT 或其他许可证。原始快照与逐文件来源映射由工作区维护记录保存。
