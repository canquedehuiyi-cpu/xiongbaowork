# UIContext 与多实例

Stage 多窗口或异步执行时，全局 UI 接口可能无法确定期望实例。已有有效 UIContext 时优先用它；不要在服务代码凭空访问 `this.getUIContext()`，应由组件/窗口提供对应上下文并管理生命周期。

| 操作 | 实例入口（逐项检查最低 API 版本） |
|---|---|
| AlertDialog / ActionSheet | `uiContext.showAlertDialog()` / `showActionSheet()` |
| Router | `uiContext.getRouter()` |
| Toast / 自定义弹窗 | `uiContext.getPromptAction()` |
| 像素转换 | `uiContext.vp2px()` / `px2vp()` 等 |
| 动画 | `uiContext.animateTo()` / `keyframeAnimateTo()` |
| MediaQuery / Font / 测量 | `getMediaQuery()` / `getFont()` / `getMeasureUtil()` |
| Observer / 截图 / 焦点 | `getUIObserver()` / `getComponentSnapshot()` / `getFocusController()` |
| 宿主 Context | `getHostContext()`，结果可能为空，且不是所有宿主都是 UIAbilityContext |

组件内可取 `this.getUIContext()`；窗口侧可取 `window.getUIContext()`，获取时机按实例生命周期检查。没有实例方法的 API，只有官方注明支持作用域绑定时才用 `runScopedTask`。

全局接口仍兼容的旧工程可局部保留。遇废弃提示，核对具体 API 的替代入口和版本，不能将“建议实例化调用”写成所有版本均编译失败。
