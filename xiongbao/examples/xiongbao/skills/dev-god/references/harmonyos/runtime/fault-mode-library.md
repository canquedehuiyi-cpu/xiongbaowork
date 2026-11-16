# JSError 故障模式总表

改编自上游同名知识文件，见[来源及通用诊断流程](index.md)。分类用于组织证据，不把分类层级称为已确认的三级根因。

## 匹配顺序

先核对目标进程、构建和时间，以 `Reason` / error name 确定异常类别，再关联完整 message、可选 code、应用栈与业务步骤。出现新类型或未收录字符串时保留原文、读取故障附近代码并查询对应 API；不强行匹配最近的词条。

| 日志线索 | 需要确认的候选 | 最小修复方向 | 复验 |
| --- | --- | --- | --- |
| `super before use 'this'` | 子类构造路径在父类初始化前访问实例 | 核对全部构造分支，保持正确初始化次序 | 覆盖每个构造分支 |
| `super() forbidden re-bind 'this'` | 同一路径重复初始化父类 | 消除该路径重复调用，勿删除必需初始化 | 覆盖有/无条件分支 |
| `<name> is not defined` | 声明、作用域、导入或产物不匹配 | 沿应用栈查符号实际来源，修正边界 | 原入口和发布产物 |
| `ArrayBuffer is null or detached` | 跨线程转移、Native 释放或继续使用已失效缓冲区 | 明确唯一所有者与使用结束点；仅按业务需要复制数据 | 转移前后、重复访问与关闭路径 |
| `ArkTS Map's constructor cannot be directly invoked` | 实际导入的集合构造函数调用方式不合约定 | 核对具体 Map 类型、导入和 SDK 的初始化方式 | 空集合、初始数据及调用路径 |
| `OutOfMemory ... <size> ... <heap-type>` | 当前分配失败；泄漏、大分配或峰值并发均可能 | 转[内存专题](outofmemoryerror_patterns.md)，分配失败栈不等于泄漏源 | 同一负载/设备多轮趋势 |
| `Terminate execution!` | 执行被终止，触发者尚不明确 | 对齐系统事件、应用栈/混合栈及终止前状态，确认触发来源再处理 | 重放触发流程，检查系统事件 |
| `AggregateError` | 多个异常被聚合，可能来自 `Promise.any()`，也可能由业务构造 | 读取受支持的聚合错误明细及调用点，逐个处理真实失败 | 全失败、部分成功与空输入 |

`Promise.any()` 在输入全部拒绝时以聚合错误拒绝；空输入也会拒绝。**不能**从 `None` 或 `AggregateError` 一词断定调用了该方法，也不能推断一定会/不会生成 FaultLog；日志产出取决于宿主和异常处理路径。语言语义参见 [ECMAScript Promise.any](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.any)，具体 ArkTS 可用性以目标 SDK 为准。

其他类型按[索引](index.md)只读对应文件。报告格式：`异常类别 / 命中线索 / 原始证据 / 待确认候选 / 排除或复现结果`。
