# 状态管理、Builder 与迁移

沿用当前组件的 V1/V2 模式。V1 和 V2 组件可在受支持的边界组合；同一个 struct 不混用不兼容的状态装饰器。不要为一次 bug 修复迁移整个项目。

| 体系 | 常用装饰器/语义 |
|---|---|
| V1 `@Component` | `@State` 本地状态；`@Prop` 单向副本；`@Link` 双向；`@ObjectLink` 关联可观察对象；`@Provide/@Consume` 跨层传递 |
| V2 `@ComponentV2` | `@Local` 内部初始化；`@Param` 外部单向输入；`@Event` 回调；`@Provider/@Consumer` 跨层；`@Monitor/@Computed` 监听与派生 |
| 类观察 | V1 `@Observed` 与 V2 `@ObservedV2/@Trace` 是不同机制，类装饰器不是直接贴在组件成员上的状态装饰器 |

V1 注意：
- `@State` 可按规则被父组件初始化，不代表父值持续双向同步；`@Prop` 可有默认值。
- `@Link` 和 `@ObjectLink` 由外部初始化，不在本地给初值；`@ObjectLink` 不能自行整体替换输入引用。`@Link` 的可接受父状态来源和 `$`/`this.` 绑定语法核对当前版本与官方示例，不一概禁止旧语法。
- `@State` 深层变化不一定可观察。可根据组件边界选 `@Observed/@ObjectLink`、不可变地替换上层对象，或显式派生更新；不要把所有数组改成 `class extends Array`。
- null/undefined、Map/Set、联合类型支持随 API 版本演进，不一概宣称 `@State` 禁止所有空值。
- `@Watch` 与 `@State` 组合合法；避免回调无条件写回自己的监听字段而循环。

V2 注意：
- `@Local` 由内部初始化；对外输入用 `@Param`。`@Param` 本地重新赋值、`@Once` 的例外及对象属性变更语义按当前版本核对；优先用事件更新所有者，避免隐式改父状态。
- `@Computed` 追踪可观察依赖，不局限于“仅 @Trace”。
- AppStorageV2/PersistenceV2 的 connect 使用类构造器、键/工厂等重载；不是 `.connect(this, 'key', type)`，也不是只能在组件内部调用。
- 仅对需要跨体系保持观察能力的对象使用对应兼容桥接；基本值或不需要响应式的输入不强制调用 UIUtils。兼容 API 需核对最低版本和重复代理问题。

状态不刷新依次检查：UI 是否读取依赖 → 值和引用是否变化 → 实际修改是否处于观察范围 → 父子同步方向 → 列表 key/数据通知是否正确。不要靠 `setTimeout` 掩盖渲染期间写状态。

Builder：
- 普通按值参数与按引用参数的更新行为不同。需要引用跟踪时按目标版本使用单参数对象、`$$` 或支持的 binding API；类型用具名 interface/class。
- 不在渲染中修改输入。需要用户操作回写时，传事件或适用的 setter，不把所有输入对象复制成不响应的普通字段。
- `wrapBuilder` 的参数类型是元组，如 `WrappedBuilder<[CardData]>`；按声明检查实际参数。
- 不在 `@Watch` 中执行 Builder 来强制刷新；不要求 Builder 源码必须出现在 build() 前。

[状态 API 卡](../quick-apis/08-state-decorators.md) · [渲染](06-rendering.md)
