# 鸿蒙运行时问题：按证据诊断

用于编译已通过但发生崩溃、闪退、白屏、未捕获异常或交互失败。只读本索引和命中的专题；编译错误转回鸿蒙主指南。错误字符串用于缩小候选，不能单独证明根因。

## 先取得最少的有效证据

1. 已有日志、栈或明确失败页面时先使用这些证据，不重复采集整机日志。记录异常时间、触发动作、安装包/构建版本和 OS/SDK；只提取相关时间窗，隐去账号、令牌及业务数据。
2. 需要设备证据时，沿用项目或宿主现有设备工具、`hdc` 和日志能力，不要求额外包装 CLI 或 Node 解析器。设备目标优先继承用户已指定的设备；存在多个且无法从上下文确定时再询问，不能随意选第一台。
3. 包名从工程实际应用配置（通常为 `AppScope/app.json5`）和当前安装产物核对，不能用 vendor、模块名或示例包名猜测。采集命令、权限和 faultlog 路径以当前工具帮助与设备为准，不硬编码用户机器路径。
4. 对齐目标进程/包名、时间、版本，再提取 `Reason`、错误类型、完整 message、code（若有）、应用栈、线程与必要上下文。混淆或发布栈需对应构建的符号/SourceMap；错误构建的映射不能作证据。
5. 没有异常日志不代表没有问题。对白屏/卡顿沿用户给出的页面、生命周期、渲染、网络、线程或最近变更做局部检查；不把非崩溃强行套进 JSError，也不因采集工具缺失停止全部分析。

## 按需入口

| 线索 | 读取 |
| --- | --- |
| 未分类、混合栈、ArrayBuffer、Map、AggregateError、TerminationError | [故障模式总表](fault-mode-library.md) |
| 引用、初始化、Provide/Consume | [ReferenceError](referenceerror_patterns.md) |
| 空值、不可调用、循环序列化、N-API 对象 | [TypeError](typeerror_patterns.md) |
| UI 上下文、Web、窗口、数据库、资源等 API 异常 | [Error / 框架 API](error_patterns.md) |
| 参数、权限、状态、URL/XML 等业务接口错误 | [BusinessError](businesserror_patterns.md) |
| JSON 或动态解析输入 | [SyntaxError](syntaxerror_patterns.md) |
| 数组长度、递归栈 | [RangeError](rangeerror_patterns.md) |
| 分配失败、内存增长 | [OutOfMemoryError](outofmemoryerror_patterns.md) |
| URI 编解码 | [URIError](urierror_patterns.md) |

## 证据 → 候选 → 最小修复 → 复验

- 将“日志确实显示什么”与“推测由什么造成”分开。应用栈是读取代码的起点；框架顶帧、相同数字错误码或词条命中都不能独立定责。
- 检查最接近故障的调用、值来源、异步顺序与对象生命周期，列出能区分候选的一个检查。SDK 专有 API、错误码和装饰器行为按项目版本查对应官方文档与声明；本库不是封闭根因清单。
- 在拥有该数据或生命周期的边界修复。不能靠全局吞异常、任意延迟、无界重试、静默改数据或随意换路由框架掩盖故障。捕获应产生明确恢复状态，并保留必要诊断。
- 复验原步骤和相邻边界：同一页面/动作、前后台或销毁重入、重复操作等。区分代码修改、编译通过、安装成功和设备复现结果；没有设备只报告已完成层级。
- 证据较强：同一构建的完整日志、应用调用和值/生命周期能互相印证，并能复现；中等：模式吻合但关键值或映射缺失；较弱：只有片段/症状。任何强度都不能在未复验时声称“修复已验证”。

简洁交付：`触发条件 → 关键证据 → 根因候选与确认方式 → 改动 → 实际复验及剩余缺口`。复用仍适用于当前代码/设备的有效证据。

## 来源与边界

2026-10-08 依据用户本机 `hmos-runtime-fix-skill/reference/` 的九份知识文件整理，并对照旧 `arkts-runtime-fix` 的证据优先流程。保留源文件名便于追溯；未带入其入口、采集/解析脚本、评测数据或工具安装指令。

上游入口记录的知识来源为 [HarmonyOS_Skills / hmos-jscrash-analysis](https://gitcode.com/HarmonyOS_Skills/harmonyos-agent-skills/tree/main/03-solutions/quality/stability/hmos-jscrash-analysis)。此次使用用户提供的本地资料，整合来源与适配边界见[资料说明](../sources.md)。

这些文档是诊断指南，不是已在所有 HarmonyOS 版本、设备和 API 上验证的修复方案。
