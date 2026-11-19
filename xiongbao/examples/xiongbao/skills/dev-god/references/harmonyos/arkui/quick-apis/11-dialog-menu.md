## 11. 弹窗/菜单/模态

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。


> **组件索引**：`弹窗 API`、`菜单`、`Popup`、`模态`

### 弹窗 API

| API | 签名 | 核心参数 |
|-----|------|---------|
| **AlertDialog** | `AlertDialog.show(options)` | `{title?, message, alignment?, primaryButton?, secondaryButton?, buttons?[]}` |
| **ActionSheet** | `ActionSheet.show(options)` | `{title, message?, confirm, cancel?, sheets: SheetInfo[]}` |
| **CustomDialog** | `new CustomDialogController(options)` | `{builder, alignment?, autoCancel?, customStyle?}`；调用 `.open()` `.close()` |
| **Toast** | `promptAction.showToast({message, duration?, bottom?})` | `{message, duration?, bottom?, showMode?}` |
| **DatePickerDialog** | `DatePickerDialog.show(options)` | `{start?, end?, selected?, lunar?, onDateAccept?: (value: Date) => void, onDateChange?: (value: Date) => void}` |
| **TimePickerDialog** | `TimePickerDialog.show(options)` | `{selected?, useMilitaryTime?, onAccept?: (value: TimePickerResult) => void}` |
| **TextPickerDialog** | `TextPickerDialog.show(options)` | `{range, selected?, onAccept?: (value: TextPickerResult) => void}` |
| **CalendarPickerDialog** | `CalendarPickerDialog.show(options)` | `{selected?, onAccept?: (value: Date) => void, onCancel?, onChange?: (value: Date) => void}` |

**AlertDialog 按钮结构：**

> **按钮结构**：`{ value: string, action?: () => void, enabled?: boolean, defaultFocus?: boolean, style?: DialogButtonStyle }`
> ⚠️ 用 `value` 不用 `text`（AI 常误写为 text）

- AlertDialog 的 primaryButton/secondaryButton 和 buttons 数组中每个元素用 **`value`** 不是 `text`：`{ value: '确定', action: () => {} }`
- ActionSheet 的选项列表用 **`sheets`** 不是 `buttons`，每个选项用 **`title`** 不是 `text`：`{ title: '选项', icon?, action }`
- confirm 字段也是 `{ value, action }` 格式

### CustomDialogController 使用模式（两步）

步骤 1：用 @CustomDialog 装饰器定义弹窗组件
```typescript
@CustomDialog
struct MyDialog {
  controller: CustomDialogController
  
  build() {
    Column() {
      Text('对话框内容')
      Button('关闭')
        .onClick(() => { this.controller.close() })
    }
  }
}
```

步骤 2：在父组件中创建控制器并调用
```typescript
@Component
struct Parent {
  dialogController: CustomDialogController = new CustomDialogController({
    builder: MyDialog(),
    alignment: DialogAlignment.Center,
    autoCancel: true,
    customStyle: false
  })
  
  build() {
    Button('打开弹窗')
      .onClick(() => { this.dialogController.open() })
  }
}
```

> 此例展示 V1 Controller 模式；控制器与弹窗的所有权及 V2 兼容方式以目标版本为准。新需求可评估 PromptAction/ComponentContent，不要求整体替换既有实现。

### 菜单

| 组件/方法 | 签名 | 核心参数 |
|-----------|------|---------|
| **MenuItem** | `MenuItem(options)` | `{content, startIcon?, endIcon?, ...}`；selected/onChange 等按组件属性分别查询 |
| **MenuItemGroup** | `MenuItemGroup(options)` | `{header?, footer?}` |
| **.bindMenu** | `.bindMenu(content: MenuElement[] \| CustomBuilder)` | 绑定菜单 |
| **.bindContextMenu** | `.bindContextMenu(content, responseType)` | 右键/长按菜单，responseType：`ResponseType.LongPress` / `ResponseType.RightClick` |

### Popup

| 方法 | 签名 | 核心参数 |
|------|------|---------|
| **.bindPopup** | `.bindPopup(show: boolean, options)` | `{message, placement?, offset?, showInSubWindow?, mask?, onStateChange?}` |

> **bindPopup 回调注意：** `onStateChange` 回调参数是 `{ isVisible: boolean }` **对象**，不是原始 boolean。正确写法：`onStateChange: (event: PopupStateEvent) => { this.show = event.isVisible }`

### 模态

| 方法 | 签名 | 核心参数 |
|------|------|---------|
| **.bindSheet** | `.bindSheet($$isShow, builder, options?)` | options: `{detents?, height?, preferType?, dragBar?, backgroundColor?, blurStyle?, title?, showInSubWindow?, enableOutsideInteractive?, onWillDismiss?, onWillAppear?, onAppear?, onWillDisappear?, onDisappear?}`。注意：没有 `sheetSize` 字段，用 `detents` 或 `height` |
| **.bindContentCover** | `.bindContentCover(isShow, builder, options?)` | `{modalTransition?}` |

> `$$this.showXxx` 是支持时可选的双向绑定语法；API 24 的 bindSheet 也声明 boolean 参数。若手动管理状态，正确回写框架关闭事件，避免状态与面板显示不同步。

---
