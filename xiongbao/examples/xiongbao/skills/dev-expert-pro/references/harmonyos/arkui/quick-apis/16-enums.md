## 16. 枚举类型速查

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

本表保留常用名称，省略未经逐项复核的数字值。API 列是原参考的分类版本线索，不代表每一行所有成员在该版本均存在；新增枚举成员查目标声明。


> **组件索引**：`布局`、`组件`、`手势`、`动画`、`效果`

### 布局

| 枚举 | 值 | API |
|------|----|----|
| Alignment | TopStart, Top, TopEnd, Start, Center, End, BottomStart, Bottom, BottomEnd | 7 |
| FlexAlign | Start, Center, End, SpaceBetween, SpaceAround, SpaceEvenly | 7 |
| FlexDirection | Row, RowReverse, Column, ColumnReverse | 7 |
| FlexWrap | NoWrap, Wrap, WrapReverse | 7 |
| ItemAlign | Auto, Start, Center, End, Stretch, Baseline | 7 |
| VerticalAlign | Top, Center, Bottom | 7 |
| HorizontalAlign | Start, Center, End | 7 |
| Axis | Vertical, Horizontal | 7 |
| Direction | Ltr, Rtl, Auto | 7 |
| ScrollDirection | Vertical, Horizontal, None, FREE | 7 |
| EdgeEffect | Spring, Fade, None | 7 |
| BarState | Off, Auto, On | 7 |

### 组件

| 枚举 | 值 | API |
|------|----|----|
| ButtonType | Capsule, Circle, Normal, ROUNDED_RECTANGLE | 7/15 |
| ImageFit | Contain, Cover, Auto, Fill, ScaleDown, None | 7 |
| **ImageRenderMode** | **Original, Template** | 7 |
| InputType | Normal, Number, PhoneNumber, Email, Password, NUMBER_PASSWORD, USER_NAME, NEW_PASSWORD, NUMBER_DECIMAL, URL | 7 |
| SliderStyle | OutSet, InSet | 7 |
| ToggleType | Checkbox, Switch, Button | 7 |
| ProgressType | Linear, Ring, Eclipse, ScaleRing, Capsule | 7 |
| **DataPanelType** | **Circle, Line** | 7 |
| TextAlign | Start, Center, End, Justify | 7 |
| TextOverflow | None, Clip, Ellipsis, Marquee | 7 |
| FontWeight | Lighter, Normal, Regular, Medium, Bold, Bolder | 7 |
| FontStyle | Normal, Italic | 7 |
| TextDecorationType | None, Underline, Overline, LineThrough | 7 |
| LineCapStyle | Butt, Round, Square | 7 |
| Visibility | Visible, Hidden, None | 7 |
| CopyOptions | None, InApp, LocalDevice, CrossDevice | 9 |
| EnterKeyType | Go, Search, Send, Next, Done, PREVIOUS, NEW_LINE | 7 |
| PanelType | Minibar, Foldable, Temporary | 7 |
| BarMode | Scrollable, Fixed | 7 |
| BarPosition | Start, End | 7 |
| NavigationMode | Stack, Split, Auto | 9 |
| EllipsisMode | HEAD, CENTER, TAIL | 11 |
| WordBreak | NORMAL, BREAK_ALL, BREAK_WORD | 11 |

> **枚举名易错提示：**
> - 属性名是 `.renderMode()`，枚举是 `ImageRenderMode`（不是 ImageRenderingMode）
> - DataPanelType 是 `Circle/Line`（不是 Close/Ring）
> - `Sticky.Normal`（不是 StickyStyle.Normal，StickyStyle 枚举不存在）
> - `TextInputStyle` 无 `Normal` 值，不要使用 `.style(TextInputStyle.Normal)`
> - `GradientDirection` 的右下方向在 API 24 为 `RightBottom`，左下为 `LeftBottom`；不要与 Placement 的 BottomRight/BottomLeft 混淆

### 手势

| 枚举 | 值 | API |
|------|----|----|
| GestureMode | Sequence, Parallel, Exclusive | 7 |
| PanDirection | All, Horizontal, Vertical, Left, Right, Up, Down | 7 |
| SwipeDirection | All, Horizontal, Vertical | 7 |
| TouchType | Down, Up, Move, Cancel | 7 |

### 动画

| 枚举 | 值 | API |
|------|----|----|
| AnimationStatus | Initial, Running, Paused, Stopped | 7 |
| PlayMode | Normal, Reverse, Alternate, AlternateReverse | 7 |
| FillMode | None, Forwards, Backwards, Both | 7 |
| Curve | Linear, Ease, EaseIn, EaseOut, EaseInOut, FastOutSlowIn, LinearOutSlowIn, FastOutLinearIn, ExtremeDeceleration, Sharp, Rhythm, Smooth, Friction | 7 |

### 效果

| 枚举 | 值 | API |
|------|----|----|
| BlurStyle | Thin, Regular, Thick, BACKGROUND_THIN, BACKGROUND_REGULAR, BACKGROUND_THICK | 9 |
| ImageRepeat | NoRepeat, X, Y, XY | 7 |
| HoverEffect | Auto, Scale, Highlight, None | 8 |
| HitTestMode | Default, Block, Transparent, None | 9 |
| RenderFit | TOP_LEFT, TOP, TOP_RIGHT, LEFT, CENTER, RIGHT, BOTTOM_LEFT, BOTTOM, BOTTOM_RIGHT | 10 |
| BorderStyle | Dotted, Dashed, Solid | 7 |
| SafeAreaType | SYSTEM, CUTOUT, KEYBOARD | 10 |
| KeyboardAvoidMode | OFFSET, RESIZE, RESIZE_ONLY | 11 |
