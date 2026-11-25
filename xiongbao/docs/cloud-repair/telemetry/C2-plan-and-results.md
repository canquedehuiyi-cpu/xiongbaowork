# C2 遥测 CPU 回归准备与结果

状态：SOURCE_ONLY + wiring/unit 6 PASS / 0 FAIL；真实 SDK 生命周期及全仓类型检查未执行。仅新增一个焦点测试文件，无业务源码、package 或锁改动。复制到本线候选的 otel.ts 与 scrub.ts 保持冻结原件字节。

## 实际执行
Bun 1.3.14，退出码 0；6 pass / 0 fail / 12 expect() calls（子进程另外使用 node:assert）。
argv: env -i HOME=/nonexistent-c2-no-user-config TZ=UTC /workspace/scratch/3d93691fe5e9/source-reconstruction-20261018/tools/bun --no-env-file --config=/dev/null test ./otel-exporter-compat.test.ts
cwd: /workspace/scratch/4b8a6451bca5/telemetry-c2/openbot/server/tests

每个 case 在独立子进程注册全部 OpenTelemetry module mock 后才动态导入真实 otel.ts；env 只允许 HOME/TZ，显式 --no-env-file、--config=/dev/null，不继承凭据、代理、NODE_OPTIONS、BUN_OPTIONS 或真实遥测配置。fetch、Bun.connect/listen/serve 及 http/https/net/tls/dns 常见入口被禁止；无真实 SDK 或 provider 导入、无监听服务。此为本测试已知调用面的阻断，不宣称 OS 级网络隔离。必须单独运行本文件，不能把 mock 当成全套集成测试环境。父测试同样以空环境启动。

覆盖：off/空配置不构造 SDK；启用时 endpoint/header/resource/processor 接线；通用 endpoint /v1/logs 回退；emit 脱敏、severity、同步异常捕获；shutdown 委托及拒绝传播、无独立 forceFlush；构造失败和 header URI 解码失败传播。全部只是 mock 接线单元结果，不能证明 SDK 发包、重试、flush 或 shutdown 正确。

## 源码准确行为与启动风险
冻结源码引用（行号均为冻结基线）：
- server/src/telemetry/otel.ts:22–28：SDK 顶层静态导入。因此 off/无配置不构造对象，但不能绕过缺 SDK 包造成的模块加载失败；文件头“nothing is loaded”不能作为懒加载事实。
- otel.ts:130–143：off 忽略大小写和首尾空白；无非空 logs/general endpoint 时返回 undefined；不会调用 SDK 构造函数。
- otel.ts:150–168：logs endpoint 优先；general endpoint 去掉最后一个斜线后附 /v1/logs；logs headers 用 ?? 回退（空串不会回退）；10 秒超时；service.name 默认 openbot。parseHeaders:117–127 的 decodeURIComponent 可抛 URIError，构造函数也在 emit 的 try/catch 之外。
- otel.ts:173–203：仅同步 emit/载荷处理错误被记录为 otel-export-failed；不保证捕获 SDK 后台异步导出错误。205：shutdown 直接返回 provider.shutdown()，拒绝向调用方传播；EventExporter:43–46 没有 flush 接口。
- server/src/admin/controls.ts:45 静态导入 otel；256–262 使用 deps.env 或 process.env；286–288 调用构造并条件安装 audit tap，329 对 action.recorded 用 optional emit。629 用 Promise.allSettled 收束 exporter.shutdown 拒绝。未启动该模块（包含数据库路径）。
- server/src/index.ts:13–18 导入 controls；3087–3096 在顶层 await installEnterpriseControls，未就此调用包裹遥测专用 try/catch。缺模块可影响启动，即使遥测关闭；启用配置的构造/header 错误也可能使该安装调用拒绝。风险仅记录，不在本包扩大修改接口或启动流程。

## SDK 静态生命周期证据
现有 sdk-logs 0.221.0 的 LoggerProvider.d.ts 声明 forceFlush 和 shutdown。LoggerProvider.js:63–70 委托 activeProcessor.forceFlush；77–86 用一次性 shutdown 委托 activeProcessor.shutdown。BatchLogRecordProcessorBase.js:141–148 的 shutdown 执行 onShutdown、await _flushAll、metrics.shutdown、await exporter.shutdown；_flushAll 中也有 exporter.forceFlush 调用（174/193）。这是源码/声明观察，未执行真实 SDK。

## C1 结果核对清单
最小已证实缺失：otlp-exporter-base 0.221.0、otlp-transformer 0.221.0；不是完整传递依赖缺失清单。锁中二者均固定该版本，core 固定 2.10.0；transformer 还依赖 sdk-metrics/sdk-trace 2.10.0 等，须完整锁树验证，不能只补两个声明文件。
必须取得 otlp-exporter-base/package.json 的 types 指向的真实 index.d.ts 及其 OTLPExporterBase 声明，证明 export/shutdown/forceFlush 从该基类继承；再从 exporter 实际 containingFile 解析其 sdk-logs 与基类，确认模块和版本。现有声明路径与 SHA 详见 sdk-evidence.json。禁止创建 ambient shim 或修改 package/lock 消除错误。

## 完整依赖送达后的执行计划
1. 独占完整候选用原 argv：在 openbot/server 下 bun ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json；保存退出码与全部原始诊断，与七条基线逐项比较。本条应消失，另六条由其他线处理；不能将其整体称为通过。
2. 本文件仍单独执行为 wiring/unit。真实 SDK 测试另起无 .env、无继承凭据的干净进程，所有外网在执行器隔离层禁止；不要把本文件的 SDK mocks 带进去。
3. 首先在无 endpoint/off 配置下真实 import 并确认无 exporter 构造/网络尝试。用真实 sdk-logs LoggerProvider + BatchLogRecordProcessor 和纯内存、实现真实 LogRecordExporter 接口的记录型 exporter，观察队列日志经 forceFlush/shutdown 到达、关闭顺序、错误返回、重复关闭；清理定时器。不连接 OTLP HTTP，也不启动 collector。
4. 实际 OTLPLogExporter 仅验证声明结构和安全离线构造/关闭（无 emit、无 endpoint 请求）是否可行；依赖初始化存在网络行为则保持未执行，不以 mock 替代。生产包装层不暴露 provider.forceFlush，不扩接口。既有 otel-export-scrubbing.test.ts 使用 Bun.serve 本地 HTTP，不属于本包无服务范围，未运行。

未运行：完整 tsc、真实 SDK import/生命周期、HTTP/collector、数据库、主服务启动、生产/付费 provider。未安装依赖、未写共享 node_modules、未联系其他会话、未提交推送部署。
