# A7 契约呈现验收（tasks-workbench-a7-contracts）

## 1. 这一包只解决两个归属问题

1.1 屏幕上那个 `role=alert` 是**哪一种失败**说的：写侧（一次归档／查收回不来）还是读侧（列表根本没读到）。
1.2 一次成功的写之后，**哪一条读**被重跑了：看板读还是统计读。

两问都不是"有没有发生"，而是"是谁发生的"。前一版的 45 支用例答的是前者，所以这两问一直是空的。

## 2. 事实来源（本轮实际读到的，不引印象）

| 物 | 身份 | 出处 |
| --- | --- | --- |
| 作者 route 叶正文 | 41220 B／LF1031／sha256 `9785c8f8…`（摘取口径＝围栏内文本＋1 个尾 LF；整条评论 51247 B） | 51667649 |
| 中央 v40 绑定 route | 41233 B／sha256 `da756f88…`／blob `2ca328ff…` | Root 51674738・51675674（Root 实核，我不复算中央件） |
| `query-error.tsx` | 690 B／sha256 `28155e7c…` | 51675674 包内（包体 16062 B／`0fb7157a…`／blob `1c9b839b…`） |
| `button.tsx` | 4611 B／`d19d1a50…` | 同上 |
| `page-shell.tsx` | 8542 B／`147fd228…` | 同上 |
| 旧 45 例 | nav 51663072・consist 51664950・states 51665626・kbd 51666031・mut 51666258・gate 51671185 | 板上 |

行号只作定位。验收抓手一律是实际 symbol 与可观察行为（Root 51674738 定）。

## 3. 已证・待验・UNKNOWN 三格分开

| 陈述 | 依据 | 状态 |
| --- | --- | --- |
| 写侧区域自有的抓手是块内按钮文字 `刷新任务`；读侧区域自有的抓手是 `重试`／`正在重试…` | route 作者叶 L806-817 与 `query-error.tsx` L15-24 的源构造式 | 源可证・静态 |
| 两类失败同现时 `[role=alert]` 计数为 2，且用 `服务端`／`结果未确认` 的宽文本匹配会同时命中两块 | 两块各由自己的条件分支渲染、读侧句子可含同词 | 构造式可推・需 C1 第 3 支实跑见证 |
| 归档成功后的 invalidate 只命中 `["tasks"]` 前缀，不动 `["tasks-summary", …]` | route L713 与两条 key 的字面（作者叶 L663・L682）＋ v5 前缀匹配语义 | 静态推理・需实跑；我不把它写成已证 |
| 按钮禁用后焦点的去向、以及 `disabled` 是否落成原生属性 | `button.tsx` 只 `{...props}` 转交 BaseUI（L68-74）；BaseUI 真实 DOM 未实测 | **UNKNOWN**（不以 wrapper 转交冒充实跑事实） |
| 整页是否有 landmark | `page-shell.tsx` 自身 `<header` 1／`<h1` 1／`<main` 0／`role=` 0；父级布局未读到 | **UNKNOWN**（只能说 PageShell 自身无 main/role） |

## 4. 五支用例的判据（5 defs／0 run）

| # | 用例名（与代码逐字一致） | 抓手 | 它变红意味着什么 |
| --- | --- | --- | --- |
| 1 | a held archive keeps the unconfirmed region off the screen while the write is in the air | held POST=1・该卡每按钮 `aria-busy=true` 且文案 `归档中…`・写侧块=0・读 GET 条数不动 | 写还在空中就提前宣判结果，或闸没让画面知道自己忙 |
| 2 | settling that held write with a non-JSON 500 puts one unconfirmed region on screen, and only one | 写侧块=1・文本含 `结果未确认，请刷新任务后核对`＋`服务端返回 500`・不含 `稍后重试`・不含夹具私串・busy 解除・POST 仍 1 | 未确认被写成拒绝或写成可重试；夹具内部串外泄；或失败被当成已确认 |
| 3 | a read refusal and a write refusal sit on screen as two regions, each told by its own button | 两块各含自己的按钮・各自只念自己的句子・宽词匹配命中 2 作为反证 witness・两条 POST 各 1 | 公告面互相串台，或裸计数／宽文本断言根本无法归因 |
| 4 | with both reads on one identical URL, the archive refetch belongs to the tasks key alone | 两条读的行逐字相同・先等两 key success/idle・按 key 订阅 fetchStatus 边沿计数・看板 1 次起止、统计 0 次・读行 2→3 | 写成功后没刷列表，或把统计读也拖下水（两读在日志里同样，只有 per-key 能揭） |
| 5 | the counters follow the key that was refetched, which is what makes the case above load-bearing | `refetchQueries(exact)` 分别打两条 key，只有对应计数器动 | 计数器本身不可信——那第 4 支就是假证据，先否定工具再谈结论 |

第 5 支是给第 4 支做**仪器校验**的：如果计数器分不清 key，第 4 支的"统计 0 次"就没有意义。

## 5. 旧 45 例为什么盖不住（缺口账）

- 公告面：mut 51666258 的 `alertCount`／`alertText`（L211-212）与 gate 51671185 的 L235／L364／L401／L416 **全是裸计数**，没有一处按块内按钮区分读侧与写侧。
- 在途：mut 第 5／6 支的桩**立即回应**，没有"写还在空中"这一格；gate 第 1 支断 busy 与写次数，但不看公告面。
- 归属：mut 第 1 支靠夹具注入的 `q=card` 才能分桶（L137-141），`/tasks?period=all` 这种两读同 URL 的情形没有任何例子；consist 第 7 支读的是 `options.refetchInterval` 的配置值（其注释自陈 not an observed refire）。
- 精度：没有任何一支依赖 `dataUpdatedAt` 变大——同毫秒两次重读可以相等，本包也不引入这种依赖。

## 6. 交付与验证口径

- 本包＝两 NEW 路径：`openbot/app/tests/tasks-workbench-a7-contracts.test.tsx` 与本文档；0 生产逻辑改动、0 新依赖、不改 route／components／旧 45 例／现有 helper 公共导出。
- test 件身份与创建补丁见 51679193 叶内身份块：after 19580 B／LF478／sha256 `62be007b…`／blob `801bbd55…`；creation 20152 B／blob `5668c146…`；本侧正逆重组逐字成立，`git apply` 的二次应用负控归 Root 云端。
- **5 defs／0 run**：本文件不声称任何测试通过，也不声称 tsc／Biome 通过；实跑（容器内 bun 为唯一执行器）、中央集成与商业验收都还是空的。
- C2（焦点去向）按票面留在 UNKNOWN，等真实浏览器或 BaseUI 渲染层证据；要补它得另开口子，不在本包内伪造。
