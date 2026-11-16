# 契约：`GET /api/tasks` 每张卡的 `open` 字段

- 归属：A 线写并实现（`server/src/tasks/routes.ts` 的 `openTargetsFor`），C 线只读并按此渲染
- 日期：2026-10-09　工作包：WP-1.1（审计 N1）　测试：`server/tests/tasks-open-target.integration.test.ts`（8 pass）
- 背景：`tasks.channel_ref` 从来不是单一含义——例行与群聊写**频道 id**、对话 runner 与交接写**线程 id**、组团两张卡什么都不写。
  看板把它一律拼成 `/channel/$ref`，于是审计实测的 15 张卡全 404。本字段把这个判断收到服务端，**读时解析，不改写入**，
  所以历史卡片不必迁移就能一起修好。

## 字段形状

`GET /api/tasks` 的响应里，`tasks[]` 每一项多一个字段：

```ts
open: { kind: "channel" | "group" | "pipeline"; id: string } | null
```

- 一次请求整页解析（最多 200 张卡），服务端只发有限几条批量查询，C 线**不要**逐张再请求任何东西。
- `open` 一定存在（不是可选字段）；解析不出来时它的值是 `null`，不是缺省。

## 三种 kind 与它们该渲染成什么

| kind | 落点 | 说明 |
| --- | --- | --- |
| `channel` | `/channel/$channelId`，`params = { channelId: open.id }` | 只有**一位**员工的会话 |
| `group` | `/group/$channelId`，`params = { channelId: open.id }` | **两位及以上**员工的群聊。判据与侧栏完全同源（`app-sidebar/channel.tsx`：参与员工数 > 1），所以同一个会话在看板和侧栏只会落到同一个屏 |
| `pipeline` | `/pipelines?run=<open.id>` | 组团流程。`open.id` 是 `group_task_runs.id`（**父卡与步骤卡都给同一个 run id**） |

`pipeline` 那一支需要 C 线补深链：`pipelines.tsx` 目前把选中的运行放在组件 state，请在该路由加
`validateSearch({ run?: string })` 并用它打开那次运行的面板。**这一半在 C 名下，A 不碰。**

## `null` 的语义与渲染要求

`null` 表示"这张卡没有可去的落点"，具体是四种情况之一：

1. 卡片记的线程已经不再映射到任何会话（会话被删、或那一轮跑在草稿线程里，例如交接的 scratch thread）；
2. 引用属于**别人的**工作区（跨租户的线程 id 一律 `null`，见下）；
3. 组团流程的 run 行已经不在了；
4. `channel_ref` 与 `run_ref` 本来就是空的。

渲染要求：**`null` 时不要渲染"打开"链接**，改为同行一句灰字"对话已不在"。
不要退化成 `/channel/${row.channelRef}` 或任何"先跳过去再说"的写法——那正是审计里点进去显示
"Could not load this channel." 的那个形状。

## 五种来源现在各自解析成什么（给 C 的心智模型，不需要在界面里区分）

| 来源（`tasks.source`） | 写入的 `channel_ref` | `open` 结果 |
| --- | --- | --- |
| `routine` 例行 | 频道 id | `{channel\|group}`，按该频道员工数 |
| `chat` 对话（含群聊里每位员工的回答卡） | 群聊写频道 id；1:1 与 runner 的卡写线程 id | 两者都解析回那个频道 ⇒ `{channel\|group}` |
| `handoff` 交接 | 线程 id（被交接方自己的线程） | 若在 `group_bot_threads` 里 ⇒ `{group}`；若是 scratch 线程 ⇒ `null` |
| `responsibility` 职责 | 频道 id | 同 `routine` |
| `group_run` 组团（父卡与步骤卡） | 不写 | `{pipeline, id: run id}`；步骤卡沿 `parent_task_id` 找到父卡的 run |

## 跨租户

解析时**每一步都按"这是谁的"过滤**：`channel_memberships.user_id`、`intelligence_channel_mappings.user_id`、
`group_bot_threads.owner_user_id`、`group_task_runs.tenant_id`。
所以别的租户的线程 id 不会解析成他的频道——它回 `null`，与"根本没有这条映射"给出同一个答案（spec D15：
不可见就是不存在，不用 403 确认它存在过）。C 线**不需要**为跨租户做任何特殊渲染。

## A 线不做什么

- 不改四个写入点的 `channel_ref` 语义（历史数据因此一起被修好，也不需要迁移）；
- 不在响应里附带频道名、员工名等界面材料——那些仍走各自现有的读接口；
- 不新增第二个读接口：看板列表与统计仍只有 `GET /api/tasks` 这一份答案。
