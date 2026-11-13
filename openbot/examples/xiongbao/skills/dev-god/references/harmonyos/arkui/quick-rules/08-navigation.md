# 导航与路由

新多页面项目可优先评估 Navigation + NavDestination；既有 Router 工程按当前架构维护，除非需求明确涉及迁移。不要把每个页面的 `@Entry` 都删掉。

Navigation 流程重点：
- 路由栈由明确的宿主管理，目标页读取所属栈；`onReady` 的 NavDestinationContext 可提供 pathStack/pathInfo。`queryNavigationInfo()` 可能在未挂载时取不到结果，不能假设任意时机必有栈。
- `.navDestination(builder)` 配置单个映射入口；多次设置不是注册多个路由。
- 使用系统路由表时，在当前 SDK 支持的 schema 中配置 name、pageSourceFile、**buildFunction** 等字段，并正确导出对应 Builder。原资料写的 buildMethod 不应照抄。
- 自定义 builder 映射对小项目仍是合法选择，不强制每个多页面项目都改为 router_map。
- 传参有明确业务类型并在目标页验证。NavPathInfo 的 param 类型较宽，内联嵌套对象缺类型上下文时，先定义 interface 和变量。
- 使用返回 Promise 的 pushDestination 重载时处理失败；已有合法 pushPath 不需要统一替换。
- hideNavBar 隐藏的是导航栏/导航页区域，栈空时可能导致空白；只藏标题用 hideTitleBar。fullScreenOverlay 等 API 的用途与版本要查，不当作所有全屏需求的通用替代。
- 转场完成用相应生命周期/回调，不把业务完成写死为延时若干毫秒；手动与系统转场组合要验证返回和取消。

Router 的页面上限、NavDestination 事件、titleMode 和转场 API 都可能随版本变化；不要只凭旧卡片断言属性永远不存在。

系统路由 schema 对照：[OpenHarmony 路由迁移文档](https://gitee.com/openharmony/docs/blob/master/zh-cn/application-dev/ui/arkts-router-to-navigation.md)。

[导航 API](../quick-apis/12-navigation.md) · [版本迁移](14-deprecated.md)
