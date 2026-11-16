# 契约：`POST /api/routines`（自主工作页页内新建）

- 归属：A 线实现服务端（`server/src/routines/routes.ts`），C 线实现表单（`app/src/routes/_authed/_app/autonomous.tsx`）
- 日期：2026-10-09　工作包：WP-2.2（spec C4、审计 N9）　测试：`server/tests/routine-create.integration.test.ts`（5 pass）
- 现状：路由已挂载可用。C 线此前不需要做任何事即可调用；本页**没有**编辑端点，改时间＝先关再建。

## 请求

```
POST /api/routines
content-type: application/json

{
  "agentId":     string,   // 必填：执行员工
  "instruction": string,   // 必填：执行内容（原样存，上限 2000 码点，空或全空格会被拒）
  "cron":        string,   // 必填：五位 cron 表达式
  "timezone":    string,   // 可选，默认 "UTC"
  "channelId":   string    // 可选：这段工作落在哪个会话
}
```

`channelId` 省略时由服务端按"你和这位员工共有的会话"解析：**恰好一个**就用它，**多于一个**回 400 并把候选名字写进
错误句里（这句话本来就为对话路径设计，可以直接显示给人），**一个都没有**回 400。表单如果要避开这一问，就让人自己选会话。

## 响应

`201`：

```json
{ "routine": { "id": "routine_…", "agentId": "…", "schedule": "Every day at 09:00",
  "timezone": "UTC", "instruction": "…", "channel": { "id": "…", "name": "…", "gone": false },
  "enabled": true, "nextRunAt": "2026-10-10T01:00:00.000Z", "lastRun": null } }
```

这个 `routine` 与 `GET /api/routines` 列表里的一项是**同一个 DTO**（服务端新建后回读列表，没有第二套形状），
所以拿到 201 之后不必再刷新一次列表也能渲染；`schedule` 是给人看的散文，**永远不要解析它**，下一次要跑的时间只读 `nextRunAt`。

## 失败形状与状态码

统一 `{ "error": "给人看的一句话" }`，句子是服务端的原话（英文，属 WP-2.5 的清扫对象），C 线**原样显示**，不要自己再编一句。

| 状态 | 含义 | 表单该怎么答 |
| --- | --- | --- |
| `400` | 三者缺一（员工/内容/时间）、内容超上限、cron 看不懂、时区不认、低于 15 分钟下限、会话多选或没有 | 把句子显示在出错的字段旁 |
| `404` | `agentId` 不是这个工作区的员工 | 提示"没有这位员工"，不要显示成"会话不对" |
| `409` | 已开着的例行已满 20 条 | 提示"先关掉一条"，**不要**把字段标红——人发的东西没错 |

`409` 与 `400` 的分别是本次新加的：服务端的拒绝句两种都是同一套（`store.ts` 原话），只有状态码能告诉界面该让人改表单还是该让人关一条。
同一条限额也适用于"把一条关着的例行打开"（`PUT /:id/enabled`），那里现在也回 `409`。

## 护栏在哪，不要在这里再写一遍

- **15 分钟下限**：`server/src/routines/schedule.ts` 的 `MINIMUM_INTERVAL_MS`，由 `store.create` 经 `nextOccurrence` 触发；
- **20 条上限**：`server/src/routines/store.ts` 的 `MAX_ENABLED_ROUTINES`，在属主的封顶锁里数并插入（两条同时到 19 也只会有一个人过）。

界面的"频率"预设（每天几点 / 每周几几点 / 每 N 小时）应当**生成的 cron 天然满足**这两条；每 N 小时的预设里
`N=1` 是唯一必须挡住的取值，请让它在选择器里就出不来，而不是等人提交后被 400 打回。
