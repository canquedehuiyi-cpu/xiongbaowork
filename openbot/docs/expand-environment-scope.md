# expandEnvironment 的作用域冲突（立项）

> 状态：已立项，未开工。2026-11-14 由用户裁定立项并排期。
> 结论先行：**模板求值与正文共用一个命名空间**，导致技能正文随部署环境的 `env` 变化、且已在包内发生两次静默改写。建议改成「按字段白名单展开」，而不是给正文加转义约定。

## 1. 现在的行为

`server/src/tenant-package.ts:510` 的 `expandEnvironment(value, filename, environment)` 是一次**纯文本正则替换**：

```
/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
```

命中就把 `${NAME}` 换成环境变量值；`${NAME:-fallback}` 换成 fallback；两者都没有就 **抛错，整个包加载失败**。

它被套在**整份文件文本**上，调用点在 `loadTenantPackage` 与 `readAgentFiles`：

| 文件 | 是否整文件展开 |
|---|---|
| `brand.yaml`、`channels.yaml`、`model.yaml`、`knowledge.yaml` | 是 |
| `agents.yaml` 与 `agents/*.yaml` | 是 |
| `skills.yaml` | 是 |
| `connectors.yaml`、`teams.yaml` | 是 |

也就是说 `skills[].instructions`、`agents[].system_prompt`、`knowledge` 的描述文字**全部参与模板求值**——它们是给人（和模型）读的正文，不是部署参数。

## 2. 冲突面清单

| 问题 | 事实 |
|---|---|
| 谁在展开 | `loadTenantPackage`（6 个文件）+ `readAgentFiles`（`agents/*.yaml`），都是整文件字符串，不看 YAML 结构 |
| 谁依赖展开结果 | 真正需要环境化的只有地址类字段：`connectors`/`agents` 的 endpoint、`model` 与 `knowledge` 的连接串 |
| 有无转义通道 | **没有**。想写一个字面量 `${...}` 没有任何写法 |
| 失败方向 | 双向：无默认值 → 整包拒绝加载；有默认值 → **静默改写正文** |

## 3. 取证（examples/xiongbao，2026-11-14 实测）

包内 `skills.yaml` 共 **52 行**含 `${`，其中只有 **2 行**是展开器认得的合法占位符形态，**这 2 行都在技能正文里，且都已被静默改写**：

| 技能 | 文件里的正文 | 加载后交给 UI 的正文 |
|---|---|---|
| `baseline-regression-triage` | `"$P/${lbl:-}_raw.txt"` | `"$P/_raw.txt"` |
| `workbuddy-safe-delete-guard` | `echo "threshold=${CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD:-20(内置默认)}"` | `echo "threshold=50"` |

第二条尤其能说明问题：**同一份包在不同机器上渲染出不同正文**——本机恰好在环境里设了 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=50`，于是给用户看的示例从「20（内置默认）」变成了「50」。第一条更糟：示例脚本被改写成 `"$P/_raw.txt"`，照着跑会覆盖上一份输出。

剩下 50 行**没被命中纯属侥幸**——它们的形态差一个字符就会命中：

```
export API_KEY="${API_KEY:?请设置环境变量}"     ← 靠 ":?" 躲过（正则只认 ":-"）
console.log(`${c.label} => ${ r }`);            ← 靠空格躲过
const res = await fetch(`${ BASE_URL }${ path }` ← 靠空格躲过
```

任何一次技能升级把 `${BASE_URL}` 写成紧凑形式，整个包立刻加载失败（unset 且无 fallback → throw）。

## 4. 两个候选方案

### 方案 A：按字段白名单展开（推荐）

解析 YAML 之后，**只对声明过的字段路径**做展开；正文类字段（`instructions`、`system_prompt`、`description`、`summary`、`title`）一律按字面量。

- 根因消除：正文不再参与求值，不需要转义，也不需要用户记住任何约定；
- 同一份包在任何机器上正文一致（这是「用户看得见的文字只由包决定」的既有原则）；
- 代价：要维护一张可展开字段清单（`connectors[].endpoint`、`agents[].endpoint`、`model.*`、`knowledge.*` 等），漏字段的表现是「占位符原样留在字符串里」而不是报错——**必须有测试逐字段钉住**；
- 改动面：`loadTenantPackage` 的 6 个读取点从「先展开再解析」改为「先解析再按路径展开」，`expandEnvironment` 保留为叶子函数。

### 方案 B：命名空间 + 转义（不推荐）

保留全文展开，但把语法收窄成 `${env:NAME}`，并用 `$${...}` 表示字面量。

- 优点：改动小；`${env:...}` 与 JS 模板字面量天然不冲突，50 行近似形态一次性安全；
- 代价：**正文仍在求值通道里**，只是把默认误伤改成「需要转义约定」；既有包与文档里的 `${NAME}` 写法要么全量迁移、要么接受兼容破坏；`$${` / `$$${` 的边界本身就是新的一类 bug。

推荐 A 的理由：B 保住了「同包跨环境」的能力，但真正跨环境的只有地址；让正文继续留在求值通道里，等于把一个已经发生的事实（正文被改写）降级成「以后注意转义」。

## 5. 排期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| S1 | 列出可展开字段清单，写 `expandEnvironment` 的字段级版本的测试（先红） | 正文含 `${...}` 的包加载后与文件**逐字节一致** |
| S2 | 改 `loadTenantPackage` / `readAgentFiles`：先解析后按路径展开 | 现有 178 例 tenant-package 测试全绿；两个真实被改写的正文行恢复原样 |
| S3 | 迁移 `examples/xiongbao` 里 2 处正文（无需修改，S2 后自然恢复）+ 文档说明「哪些字段可环境化」 | `--verify-only` 通过；`grep -c '\${'` 与加载结果不再有差异 |
| S4 | 回归守卫：一条测试断言「包内任何 instructions 加载后不得与文件不同」 | 以后再出现同类改写，测试直接红 |

预计改动 1 个文件（`server/src/tenant-package.ts`）+ 1 个测试文件，S1-S2 是主体。

## 6. 开放问题

1. `teams.yaml`、`channels.yaml` 里有没有真正需要环境化的字段？如果没有，这两个文件应整体退出展开范围。
2. `model.yaml` 的 API key 是否走环境变量？若走，需要单独确认「密钥不落盘」与「正文不可展开」两条规则不冲突。
3. 现有部署文档（`docs/deployment*.md`）里示例的 `${...}` 写法是否要同步收窄。

## 7. 与交付验收的关系

这条不影响 L4 当前四项验收（品牌清洗、R18 数据链、资源页、回归基线），因为它只在**包内含 `${...}` 正文**时才显形；`examples/xiongbao` 已经有两处坏样本，属于"已发生、可静默扩散"的一类，建议排在技术债 #25（`index.ts` 拆分）之前。
