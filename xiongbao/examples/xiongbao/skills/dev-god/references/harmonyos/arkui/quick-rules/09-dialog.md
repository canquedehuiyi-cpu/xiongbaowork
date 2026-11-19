# 弹窗、菜单与 Sheet

优先使用与当前 UI 实例关联的弹窗入口；核对 API 版本、窗口类型和关闭生命周期。保留项目合法的 CustomDialogController 用法，不因“推荐新接口”把它当作编译错误。

- AlertDialog 按钮字段是 `value` 和 action 等，不是 text；primaryButton/secondaryButton 与 buttons 数组分别按具体重载填写。
- ActionSheet 条目列表是 sheets，条目标题是 title；不要照搬 AlertDialog 的 buttons。
- Sheet 高度使用 height/detents。SheetSize 在 API 24 中有 MEDIUM、LARGE、FIT_CONTENT，不仅两个枚举值；没有通用 HALF 枚举。
- `$$this.isShow` 是受支持时方便同步关闭状态的方式，**并非所有 bindSheet 重载都只接受 $$**。手动管理时正确处理框架关闭后的状态回写，避免 UI 已关而模型仍为 true。
- 声明 onWillDismiss 拦截关闭后，按理由决定允许并调用所需 dismiss，不无条件阻止返回/遮罩/下滑关闭。
- 多弹窗验证堆叠、焦点、返回键和关闭后的资源释放；订阅/计时器不要留在关闭内容上。
- 自定义 Builder 或 ComponentContent 弹窗的创建、update、dispose/close 方式按对应版本文档，不混用两套所有权模型。

[弹窗 API](../quick-apis/11-dialog-menu.md) · [UIContext](02-uicontext.md)
