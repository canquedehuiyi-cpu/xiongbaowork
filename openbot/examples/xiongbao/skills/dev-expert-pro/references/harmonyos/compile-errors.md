# ArkTS / ArkUI 编译错误定位

用于真实构建中的 ArkTS 类型、ArkUI 编译转换、资源和 SDK 签名错误。先按[鸿蒙工作流](../harmonyos.md)确认工程实际编译 SDK、兼容版本、模块和状态管理代际；表中错误文本是搜索线索，不保证每个 SDK 使用同一编号或措辞。

## 先固定证据

1. 保存首次失败的构建任务、第一条有源码位置的错误及其上下文。后续几十条报错可能由同一个缺失类型或错误导入引起。
2. 跳到出错符号的实际声明：优先工程正在使用的 `.d.ts` / `.d.ets`、依赖版本和附近可工作的代码，再查对应版本官方文档。不要拿最新网页给旧 SDK 强行改名。
3. 区分解析错误、ArkTS 限制、ArkUI DSL 限制、接口类型不符和资源缺失。一次修一个根因，再运行原失败任务。
4. 不靠 `any` / `unknown`、无依据断言、禁用检查或伪造系统数据消音。`as T` 本身并非一律禁用，但它不能证明外部数据正确、上下文存在或 API 兼容。

## 错误 → 定位 → 修复查找表

| 错误文本或症状 | 先定位 | 修复方向 | 必须核对的边界 |
|---|---|---|---|
| `arkts-no-any-unknown` | 参数、回调、JSON 边界是否漏了领域类型 | 用 SDK 回调类型、具名模型或有约束泛型；解析外部输入后验证字段 | `.ets` 与 `.ts` 的规则不同；把类型换成 `Object` 不会自动恢复成员访问能力 |
| `arkts-no-untyped-obj-literals` / `Object literal must correspond...` | 赋值、数组项、返回值、嵌套对象的类型上下文 | 声明具名 interface/class，并在变量、参数或返回类型建立上下文；有行为的类优先构造器 | 有方法、访问控制或构造约束的类型不一定能由字面量构造；不要只在最外层断言 |
| `arkts-no-obj-literals-as-types` | 参数或返回值中的 `{ x: number }` | 提取具名接口；嵌套字段也提取接口 | 把同一个内联结构挪到 `type X = { ... }` 未必解决 ArkTS 限制 |
| `Possibly null/undefined` / `T \| undefined is not assignable` | 真正可空来源及检查后的异步边界 | 先复制到局部变量再判空；在缺失分支返回、等待或显示错误状态 | 默认值须有业务含义；不能用 `!` 抹掉未就绪窗口或已销毁组件 |
| `arkts-no-types-in-catch` / `Catch clause variable type annotation...` | 区分 `catch (err)` 与 Promise `.catch(callback)` | 语句的 catch 变量省略类型标注；仅在接口契约支持时读取业务错误字段 | `.catch((err: BusinessError) => ...)` 是回调参数，不能机械套用语句规则 |
| `arkts-no-utility-types` | 具体失败的是哪一个工具类型 | 不支持的 `Parameters` / `ReturnType` 等改为显式契约，保留需要的泛型关联 | 官方规则支持 `Partial`、`Required`、`Readonly`、`Record`；不能宣布全部工具类型禁用，也不必退化为 `Function` / `Object[]` |
| `arkts-no-spread` / 展开对象报错 | 是对象展开还是数组展开 | 对象用具名类型逐字段构造；复制时保留可选字段和业务含义 | 数组展开有支持场景，不做全局替换；不要用 `Object.assign` 绕过同类限制 |
| `@State` 只能用于组件 / 状态装饰器不兼容 | 当前声明是普通 class、V1 struct 还是 V2 struct | 普通类用合适的数据模型；V1 保持 `@State/@Prop/@Link`，V2 保持 `@Local/@Param/@Event` | 不为一个报错迁移整个状态体系；同一组件和跨代组件传值的约束不同 |
| `@StorageLink ... default value` / `AppStorage.get` 推断失败 | 存储键、真实数据类型、缺值语义 | 给绑定提供相容初值；读接口补 `get<T>` 并处理 `undefined` | `get` 是读、`setOrCreate` 是写，不能互换；不要每次进入页面重置已有值；null/undefined 支持取决于 API 版本 |
| `string[] ... not assignable to IDataSource` | 当前使用 `ForEach` 还是 `LazyForEach` | 小列表可按需求用 `ForEach`；懒加载实现数据源契约、订阅管理和变更通知 | 空壳 `IDataSource` 或把数组强转不会实现刷新；key 稳定性和滚动容器另需核对 |
| `Implementation not allowed` / `Duplicate entry` | 首个语法位置、UI DSL 所在作用域、页面入口 | UI 放在合法 `build` / Builder 等上下文；重复入口按页面职责拆分或去掉多余 `@Entry` | 该消息不只有一个成因；不能给每个 helper 都添加 `@Entry` 或让 `build()` 返回 JSX |
| `fontColor does not exist on ColumnAttribute` / `Color.X does not exist` | 链式属性所属组件及枚举导入 | 文本属性放在支持它的组件上；颜色优先项目资源或已验证枚举值 | 不猜系统资源名；主题警告与编译失败分开处理，不用硬编码覆盖产品主题 |
| `Context \| undefined` / 独立函数访问 `this` | UIContext、Ability Context、普通函数是否混淆 | 从正确组件/窗口取得 UIContext；判空后传递需要的 Context；纯函数显式接收依赖 | 判空不等于确认 `UIAbilityContext` 子类型；需要子类型时从对应 Ability 传入 |
| `void & Promise<Window>` / Window 重载不匹配 | 导入来源、Context 类型、传参数量和本地重载 | 选实际存在的 Promise 或 callback 重载，处理错误与生命周期 | `getLastWindow` 存在两类重载；不能认定 `await` 一律不支持，更不能给它套虚假的 Promise |
| `Rect.x` / `WindowProperties.size` 不存在 | `window.Rect`、`Size`、`TitleButtonRect`、`WindowProperties` 是否混用 | 按真实声明取字段，例如 `getWindowProperties().windowRect.width` | Rect 常用 `left/top`；TitleButtonRect 是独立类型，不能假设只有宽高或随意补坐标；尺寸单位也要核对 |
| `AvoidArea` 缺字段 / 避让区回调不匹配 | 是系统返回值、自建 UI 模型，还是 `AvoidAreaOptions` 事件包装 | 读取 API 返回的区域；事件先取区域和类型；只需高度时用业务数值状态 | `visible` 在部分声明中必填，但官方标注无实际意义；不把它当可见性判断，不为真实系统状态补假值 |
| `Resource` 不能赋给 `string/number` | 目标属性接受资源引用还是已解析值 | UI 签名支持 Resource 则直接传；需要实际值则用对应 ResourceManager 接口 | 断言和 `.toString()` 不会解析资源；核对资源种类、API 重载、同步/异步、语言与主题变化 |
| notification / display / breakpoint 类型不匹配 | 枚举、请求对象、回调是否来自同一个模块和版本 | 统一公开类型来源，按事件声明保留准确签名与同一个回调实例 | 不把枚举 `as number`；`on()` 返回值通常不是订阅 ID，`off()` 参数按该事件声明；不猜模块级与实例级事件归属 |

## 四个容易修错的例子

以下为修复模式，不是独立应用。放回目标工程后按实际 SDK 构建；没有构建证据时只能说明已核对规则或签名。

### 具名对象与泛型保留真实契约

```ts
interface Bounds {
  width: number;
  height: number;
}

function createBounds(width: number, height: number): Bounds {
  return { width: width, height: height };
}

function firstOrMissing<T>(items: T[]): T | undefined {
  return items.length === 0 ? undefined : items[0];
}

const bounds: Bounds = createBounds(120, 80);
const first: Bounds | undefined = firstOrMissing<Bounds>([bounds]);
if (first !== undefined) {
  console.info(`width=${first.width}`);
}
```

对象有明确上下文；泛型输出仍与输入关联。模板字符串是合法常用语法，不因旧资料声称“不支持”而批量改写。

### 空安全不能依赖稍后仍成立的检查

先将可空成员保存成局部引用并判空，再使用它；跨 `await` 还需检查任务是否过期、组件是否仍存活。局部判空只解决类型和引用稳定性，不能保证底层窗口仍有效。

```ts
function formatTitle(title: string | undefined): string {
  if (title === undefined) {
    return '未命名'; // 仅用于业务允许的展示默认值。
  }
  return title.trim();
}
```

对于支付结果、文件内容或系统能力缺失，通常应返回明确失败，不能套用空字符串/零值掩盖问题。

### AppStorage 读取不应改成初始化写入

```ts
// V1 AppStorage 场景；确认工程 SDK 支持该拼写。
const savedCount: number | undefined = AppStorage.get<number>('counter');
const countForDisplay: number = savedCount === undefined ? 0 : savedCount;
```

这里只读。需要响应式绑定时再按组件设计使用 `@StorageLink/@StorageProp`；需要创建键时才选择写 API。页面生命周期里无条件 `setOrCreate('counter', 0)` 会覆盖用户现有状态。不要复制旧资料中错误的写 API 返回类型。

### Window 直接使用声明中的返回类型

```ts
import { window } from '@kit.ArkUI';

function readWidth(win: window.Window): number {
  const rect: window.Rect = win.getWindowProperties().windowRect;
  return rect.width;
}

function readSystemTopInset(win: window.Window): number {
  const area: window.AvoidArea =
    win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
  return area.topRect.height;
}
```

调用方负责有效窗口、API 可用性和异常处理；此处返回的是窗口接口约定的尺寸单位，接到 UI 的 vp 布局前需按当前 UIContext 转换。不要把固定零矩形伪装成已读取的避让区，也不要把 TitleButtonRect 强转 Rect。

## 修完后验证

- 重跑原失败模块/构建变体，确认首条错误消失且没有新的类型/资源错误；只声称实际完成的构建层次。
- 改到响应式状态、异步窗口、监听器或资源解析时，补相应运行验证：进入目标页面、触发变更、退出重进；检查订阅解绑、已有状态保留、主题/语言/窗口尺寸变化。
- 若涉及不存在的 API，核对兼容版本与能力条件，选择等价实现或明确缺口；不能靠静默 catch、假成功或改方法名交付。

## 核对资料

本页按旧错误案例重新整理，并在 2026-10-08 对照官方资料及本机 API 24 声明校准；目标工程版本仍优先。

- [TypeScript 到 ArkTS 适配规则](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/typescript-to-arkts-migration-guide)：类型、catch、对象字面量与工具类型限制。
- [窗口接口类型](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-i)：Rect、AvoidArea、TitleButtonRect 等。
- [窗口模块函数](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-f)：上下文参数和重载。
- [应用级状态管理 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-state-management)：AppStorage 读取、写入及版本差异。
