## 8. 状态管理 API 入口

> 来源：新版 `hmos-arkui-develop-skill`；集成与版本范围见 [知识库入口](../index.md)。

先按 [状态规则](../quick-rules/05-state.md) 确认同步方向，保留项目使用的 V1/V2。

### V1

| API | 作用 |
|---|---|
| @State / @Prop / @Link | 本地状态、单向副本、双向同步 |
| @Observed / @ObjectLink | 类观察与对象关联 |
| @Provide / @Consume | 跨组件层级传递 |
| @Watch | 附加在被观察状态上的变化回调 |
| AppStorage / LocalStorage | 应用级或指定作用域状态；检查 setOrCreate/get/set/has 等实际签名 |
| @StorageLink / @StorageProp | 与 AppStorage 建立双向或单向关系 |
| @LocalStorageLink / @LocalStorageProp | 与指定 LocalStorage 建立关系 |
| PersistentStorage | 持久化选定键，检查默认值类型、失败与清理 |

### V2

| API | 作用 |
|---|---|
| @Local / @Param / @Event | 本地状态、外部输入、回调更新 |
| @Provider / @Consumer | 跨层传递 |
| @ObservedV2 / @Trace | 类属性观察 |
| @Once / @Monitor / @Computed | 一次接收、监听、派生值 |
| AppStorageV2 / PersistenceV2 | 基于类型和工厂连接状态；按各自 connect 重载调用 |
| UIUtils | makeObserved、兼容桥接等能力须按目标版本逐项查询 |

API 24 的 AppStorageV2.connect 常见形态为 `connect<T>(type, keyOrDefaultCreator?, defaultCreator?)`，结果可能为 undefined；不是 `connect(this, 'key', type)`。PersistenceV2 需另外核对持久化序列化和构造器约束，不能凭同名推断完整签名。V2 存储 API 不限于组件方法内部使用。

### UI 复用与样式

Builder/LocalBuilder/BuilderParam 的作用域和依赖更新不同；按具体用法核对。[Builder 参数规则](../quick-rules/05-state.md) 与 [样式规则](../quick-rules/10-style.md) 分开处理。

多态样式是 `.stateStyles(...)` 属性方法，不写 `@StateStyles`。较新的 SyncMonitor、ReusableV2、Binding 等需要各自版本支持，不能因“V2 从 API 12 可用”就假定所有后续 API 都存在于 API 12。
