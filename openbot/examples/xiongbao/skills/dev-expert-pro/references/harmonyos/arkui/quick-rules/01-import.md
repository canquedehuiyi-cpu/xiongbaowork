# 模块导入

新增调用先查目标 SDK 的 Kit 导出与声明。目标 SDK 支持且项目采用 Kit 时优先 `@kit.*`；既有 `@ohos.*` 导入并非全体失效，不因为修一个组件强制批量改包路径。

| 能力 | 常用 Kit / 符号线索 |
|---|---|
| UI 上下文、节点、曲线 | `@kit.ArkUI`：UIContext、BuilderNode、FrameNode、NodeController、ComponentContent、curves、LengthMetrics |
| Ability、Want、Context | `@kit.AbilityKit`：UIAbility、Want、common |
| 系统异常 | `@kit.BasicServicesKit`：BusinessError |
| 图片 | `@kit.ImageKit`：image |
| 文件 | `@kit.CoreFileKit`：fileIo |
| 日志 | `@kit.PerformanceAnalysisKit`：hilog |
| 音频 / 多媒体 | `@kit.AudioKit` 的 audio 与 `@kit.MediaKit` 的 media 区分 |

表为定位线索，不保证每个版本均导出同一符号。按需导入，避免把整张表复制进文件。

- Column、Text、Button 等声明式组件，以及目标 SDK 的全局组件类型通常无需 import。NavPathStack、Resource、AttributeModifier 的归属查当前声明，别把所有名字都塞进 `@kit.ArkUI`。
- `Curve` 枚举与 `curves` 命名空间不同，曲线工厂如 `curves.cubicBezierCurve` 需要导入命名空间。
- `promptAction` 命名空间与 `PromptAction` 实例类型不同，不能只改大小写就当作等价替换。组件操作可从 `UIContext.getPromptAction()` 获取实例。
- 同理区分 `mediaquery` 命名空间和 `MediaQuery` 类型，按调用语义选导出。
- 类型存在但无法导入时，先查全局声明、准确 Kit 和版本，不猜路径。

[UIContext](02-uicontext.md) · [语法](00-arkts-syntax.md)
