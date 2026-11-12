## 4. 选择器

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

构造字段与链式属性分开，以下为 API 24 核对后的常用入口摘要。

### DatePicker

`DatePicker(options?: DatePickerOptions)` 的常用 Options 为 start/end/selected（Date）。农历使用 `.lunar(boolean)`；组件用 `.onDateChange(callback)`。`onDateAccept` 是 DatePickerDialog 的确认回调字段，不是同名组件链式方法。

### TimePicker

`TimePicker(options?: TimePickerOptions)` 的常用字段为 selected（Date）与 format。组件的 24 小时制使用 `.useMilitaryTime(boolean)`，而 TimePickerDialogOptions 可包含同名字段。

### TextPicker

`TextPicker(options?: TextPickerOptions)` 需按实际数据选择 range 类型。range 可为字符串列表、多列列表、资源或对应内容数组；selected 可为 number 或 number[]，value 类型也随选择模式变化。`.onChange` 回调不要将联合类型自行缩窄成单值。

### PatternLock

`PatternLock(controller?: PatternLockController)` 直接传控制器。sideLength、circleRadius、regularColor、selectedColor、activeColor、pathColor 等是组件属性，不能当成不存在的 PatternLockOptions 构造字段。按 `.onPatternComplete` 的 number[] 结果处理图案。

具体默认值、回调的可选性和新重载以目标 SDK 为准。
