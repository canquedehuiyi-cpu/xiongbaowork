# ArkTS 语法与类型

主要针对现有 ArkUI `.ets` 工程常见的 ArkTS 1.x 约束。较新 ArkTS 模式可能不同，以当前编译器诊断和官方迁移文档为准，不能把本表当所有版本的语法禁令。

| 常见诊断/场景 | 处理 |
|---|---|
| `arkts-no-any-unknown` | 为业务数据定义具体类型或可判别联合；不要用 `as unknown as T` 绕过检查 |
| `arkts-no-untyped-obj-literals` | 给对象提供具名 interface/class 或适用的 Record 上下文；上下文已能确定类型的调用实参可合法使用对象字面量 |
| `arkts-no-obj-literals-as-types` | 将内联对象类型提为具名 interface/class |
| `arkts-no-destruct-*` | 对当前不支持的解构改用显式字段访问或临时变量 |
| `arkts-no-structural-typing` | 使用符合声明关系的类型、extends/implements；不要依靠不兼容类型的形状巧合 |
| `arkts-no-decl-merging` | 检查同一作用域中的重复声明、脚本全局污染、导入重名；独立模块中的同名不是自动冲突 |
| `arkts-no-func-expressions` / `arkts-no-nested-funcs` | 用箭头函数作回调，或提取为类方法/模块函数 |
| `arkts-no-ctor-prop-decls` | 类体声明字段，构造函数显式赋值 |
| `arkts-no-props-by-index` / `arkts-no-indexed-signatures` | 固定字段用点访问；字典用目标版本支持的 Record/Map |
| `arkts-no-spread` | 区分对象展开与数组展开，不能一概禁止 `...` |
| `arkts-no-inferred-generic-params` | 在确实无法推断的调用处补类型参数；不要要求每个可推断的泛型调用都显式写类型 |
| `arkts-no-implicit-return-types` | 为要求显式声明的函数补返回类型；对 UI 编译器特殊语法分别处理 |

`Text(this.ready ? '完成' : '处理中')` 这样的参数表达式、模板字符串、箭头函数、`as`、数组展开等不能因模糊禁令被机械改写。`as` 只帮助静态类型，不做运行时校验。

```ets
interface TaskRaw { id?: number; title?: string }
// 从网络/JSON来的数据还要检查字段实际类型和业务范围。
// 仅 `JSON.parse(text) as TaskRaw` 或使用 ?? 默认值不构成验证。
```

- 对 `Map.get`、`find`、可选参数和异步结果判空；不要把缺失关键数据默认为 0 或空串来掩盖错误。
- 不自动把所有 `null` 改成 `undefined`；维持接口契约。
- 回调上下文能正确推断时可保留推断；公开接口或推断不足处显式声明类型。
- 数组/对象语义改写要保持行为。`obj.k !== undefined` 不等价于判断属性存在；去掉副作用 import 前确认初始化副作用已由显式入口承担。
- 跨模块类型使用正确的 export/import；不要把所有类和接口都改为全局。

[错误码入口](../quick-apis/18-error-code.md) · [组件命名](03-component.md) · [构建语法](04-build.md)
