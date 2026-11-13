# Error：框架 API 与应用异常

改编自上游同名知识文件；先遵循[证据与来源约定](index.md)。所有 API 与数字错误码都需用实际模块、调用方法和 SDK 核对。

| 线索 | 候选与确认 | 最小修复 | 复验 |
| --- | --- | --- | --- |
| 自定义 `ApiError` 等 | 业务主动抛错或包装了下层错误 | 沿 cause/调用链找原始失败，在负责该业务的边界转成明确恢复状态 | 原错误、正常路径及异步拒绝 |
| `Invalid parameter/argument` | 实参不符合当前 API 合约 | 核对类型、范围、必填与重载 | 边界实参，不随意改数据 |
| `No such file or directory` / `Invalid relative path` | 路径、沙箱、文件生命周期或调用时序不符 | 修正实际路径与所有权，按业务处理缺失；保留权限等其他错误 | 文件存在/缺失、重启后路径 |
| `WebviewController must be associated ...`（示例 `17100001`） | 当前 controller 与目标 Web 组件的关联/生命周期未满足 | 核对实例和附着时机，按当前 SDK 的关联回调后使用；拒绝任意延迟 | 首次加载、页面返回、销毁重建 |
| `Invalid url`（示例 `17100002`） | 该 Web/API 方法不接受 URL 的形式或值 | 查具体方法的 URL 限制和输入来源 | 空值、编码、协议和实际边界 |
| `ForEach id` / `id generator` | 默认生成方式不能处理数据，或标识策略不合适 | 给出稳定且按业务唯一的 key；勿用每次生成的随机值，勿静默丢条目 | 插入、删除、排序后状态归属 |
| `SQLite: Generic error`（示例 `14800021`） | SQL、schema、绑定、事务等都有可能 | 读取具体 SQL 错误与事务上下文再改 | 对应 schema 与失败事务，检查回滚 |
| `Column out of bounds`（示例 `14800013`） | ResultSet 列索引/名称、查询投影或当前位置不符 | 核对查询结果与访问 API，勿猜列序 | 空结果、缺列与正常结果 |
| `Already closed`（示例 `14800014`） | 已关闭 ResultSet/store 被继续访问 | 修复对象拥有者与关闭顺序；只在业务要求时重开，避免循环重试 | 并发查询、退出页面、重复关闭 |
| `Invalid resource ID` | 当前包/资源配置或跨包查找上下文不符 | 核对资源产物、ID、包类型、混淆和 ResourceManager；按 API 修正查找 | 相关构建变体与设备语言/配置 |
| `UI execution context not found`（示例 `100001`） | 当前调用未关联有效 UI 上下文或发生于其销毁后 | 沿项目现有架构使用当前有效上下文；核对 `UIContext` API 可用性 | 多窗口、页面退出后回调、重新进入 |
| `Session not config` | 实际会话尚未配置或配置失败后仍继续 | 确认所属 API 的配置状态机和异步完成，再执行操作 | 配置成功、失败及重新初始化 |
| `window state is abnormal` | 窗口尚未有效或已失效，也可能不满足其他状态条件 | 核对创建、显示、隐藏、销毁的实际 API 顺序 | 冷启动、多窗口与销毁后回调 |
| `Service exception` / `invalid N-API status` | 服务或 Native 边界失败；不能仅凭片段认定为某传感器接口 | 从混合栈确定模块，核对参数、线程与订阅/释放配对 | 重复订阅、取消、前后台与服务不可用 |

资源 ID 错误不等于应统一改用名称查找；UI 上下文错误不等于需要重写为另一套路由。先修已确认的局部契约。ArrayBuffer、Map 构造等见[故障模式总表](fault-mode-library.md)。
