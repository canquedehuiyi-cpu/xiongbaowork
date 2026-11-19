# 平台识别与运行环境

在跨端、新平台、构建或设备任务中读取本页。平台清单用于寻找入口，不是能力白名单；没有专篇时，仍按项目配置、现有工具和官方文档完成任务。

## 先找真正运行的项目

结合清单、源码、锁文件、构建脚本与 CI 判断，不能凭一个扩展名决定技术栈。多包仓库先定位目标子项目；区分源码目录、生成目录、发布产物。查看现有命令和帮助，再选实际可用的工具；不因为存在配置文件就声称 SDK、模拟器、账号或设备已就绪。

| 项目信号 | 路由与重点 |
| --- | --- |
| `package.json`、页面入口、浏览器构建配置 | Web：确认客户端/服务端渲染、启动入口与目标浏览器 |
| `build-profile.json5`、`oh-package.json5`、`.ets` | [鸿蒙](harmonyos.md)：确认运行系统、SDK、模块与设备 |
| `project.config.json`、`app.json`、WXML/WXSS，或跨端框架配置 | [小程序](miniprogram.md)：确认平台、源码和编译输出 |
| Gradle、`AndroidManifest.xml`、Kotlin/Java | Android：确认模块、构建变体、SDK 与设备/模拟器 |
| Xcode 工程/工作区、Swift、`Package.swift` | Apple 平台：区分应用与库，确认 scheme、destination、签名 |
| `pubspec.yaml`、Dart；或 React Native 配置 | 跨端：确认本次目标端及原生插件，不以某一端通过代替其他端 |
| 桌面、游戏、嵌入式或其他清单 | 查项目说明与工具链，先跑最小可验证目标，再扩展 |

## 避免跨端误判

- 确认交付是网页、WebView、原生应用、小程序还是多端共享逻辑。保持现有形态；“先生成网页”不能替代原生验收。
- 只在共享逻辑上复用结论；权限、导航返回、前后台切换、文件路径、网络限制和原生插件需在目标端核实。修改生成产物前先定位其源码。
- UI 验证记录目标尺寸、输入方式和实际入口；移动端按改动涉及程度检查安全区、键盘、手势和系统权限。没有设备时继续代码、构建及可用模拟器验证，并具体列出待验证行为。
- 新平台先确认版本与最小启动方式；用本地类型声明、编译诊断、官方 API 文档交叉检查。资料不可达时标明依据和不确定点，不套用相似平台的接口。

## 官方入口

按项目实际版本阅读，不默认升级工具链：[Android 构建](https://developer.android.com/build)、[Xcode](https://developer.apple.com/documentation/xcode)、[Flutter 文档](https://docs.flutter.dev/)、[React Native 环境](https://reactnative.dev/docs/set-up-your-environment)。这些是查阅入口，不表示已在对应环境完成运行测试。
