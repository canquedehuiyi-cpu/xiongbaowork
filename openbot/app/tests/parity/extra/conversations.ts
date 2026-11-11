import type { GroupConversation } from "@/lib/groups";
import type { SignInRequest } from "@/lib/passwords/queries";
import type { VoiceSessionPage } from "../../../../shared/voice-session";
import { type FixtureRoute, list, ok } from "../fixture-kit";

/**
 * Extra parity fixtures for the conversations area (see tests/parity/fixture-kit.ts): the stored
 * history of the 经营周报 and 客户咨询 channels, a saved voice call, the attachments they show, and
 * the 双十一筹备 group conversation — so `/channel/channel-analyst`, `/channel/channel-support` and
 * `/group/channel-team` draw a real transcript (bubbles, execution lines, a pending approval,
 * attachment tiles) instead of an empty pane.
 */

/** Same clock as fixtures.ts: `at(h)` = 2026-11-01T09:00Z + h hours; the capture freezes at h=137. */
const BASE = Date.parse("2026-11-01T09:00:00.000Z");
const at = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();

/*
 * The CopilotKit connect stream in fixtures.ts replays `message-01`/`message-02` for every thread, and
 * the channel merges what the history store holds after the turns it shares with that replay. So the
 * analyst's stored thread starts with the same two turns and carries the conversation on from there.
 */
const ANALYST_THREAD = [
  {
    id: "message-01",
    role: "user",
    content: "帮我看一下上周的销售额和前一周比怎么样？",
  },
  {
    id: "message-02",
    role: "assistant",
    content:
      "上周销售额为 128.4 万元，环比增长 6.2%。增长主要来自秋季新品，线上渠道贡献了约七成。需要我把明细整理成表格吗？",
  },
  {
    id: "analyst-03",
    role: "user",
    content: [
      {
        type: "image",
        source: {
          type: "url",
          value: "/api/attachments/att-chart",
          mimeType: "image/png",
        },
        metadata: { attachmentId: "att-chart", filename: "渠道趋势.png" },
      },
      {
        type: "document",
        source: {
          type: "url",
          value: "/api/attachments/att-sheet",
          mimeType: "text/csv",
        },
        metadata: { attachmentId: "att-sheet", filename: "十月门店销售.csv" },
      },
      {
        type: "text",
        text: "要的，按渠道拆开，再对照一下这张趋势图和门店明细。",
      },
    ],
  },
  {
    id: "analyst-04",
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call-analyst-read",
        name: "mcp__feishu__read_doc",
        args: { docId: "weekly-sales" },
      },
    ],
  },
  {
    id: "analyst-05",
    role: "tool",
    toolCallId: "call-analyst-read",
    content: "已读取《十月第五周经营数据》：共 4 个渠道、32 家门店。",
  },
  {
    id: "analyst-06",
    role: "assistant",
    content: [
      "按渠道拆开如下：",
      "",
      "| 渠道 | 上周（万元） | 前一周（万元） | 环比 |",
      "| --- | ---: | ---: | ---: |",
      "| 线上商城 | 61.2 | 56.8 | +7.7% |",
      "| 小程序 | 28.9 | 27.1 | +6.6% |",
      "| 门店 | 32.5 | 31.6 | +2.8% |",
      "| 团购 | 5.8 | 5.4 | +7.4% |",
      "",
      "门店明细里有 **3 家** 环比下滑超过 10%，都集中在华东区，建议本周重点跟进。",
    ].join("\n"),
  },
];

/** 客户咨询: the support coworker looked the order up, then stopped at a refund that needs approval. */
const SUPPORT_THREAD = [
  {
    id: "support-01",
    role: "user",
    content: "客户说订单 SO-20261106-0042 少发了一件，帮我处理一下退款。",
  },
  {
    id: "support-02",
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call-support-find",
        name: "mcp__crm__find_order",
        args: { orderId: "SO-20261106-0042" },
      },
    ],
  },
  {
    id: "support-03",
    role: "tool",
    toolCallId: "call-support-find",
    content: "订单 SO-20261106-0042：共 3 件，已签收 2 件，实付 150.00 元。",
  },
  {
    id: "support-04",
    role: "assistant",
    content:
      "查到了：这单共 3 件，客户签收了 2 件，少发的那件价值 **50.00 元**。我去后台发起部分退款。",
  },
  {
    id: "support-05",
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call-support-open",
        name: "computer_navigate",
        args: { url: "https://crm.example.com/orders/SO-20261106-0042" },
      },
      {
        // The pending approval in fixtures.ts (approval-01) holds this call.
        id: "call-01",
        name: "computer_click",
        args: { target: "部分退款" },
      },
    ],
  },
  {
    id: "support-06",
    role: "tool",
    toolCallId: "call-support-open",
    content: JSON.stringify({
      ok: true,
      url: "https://crm.example.com/orders/SO-20261106-0042",
      title: "订单详情 · SO-20261106-0042",
    }),
  },
];

const THREADS: Record<string, unknown[]> = {
  "thread-analyst": ANALYST_THREAD,
  "thread-support": SUPPORT_THREAD,
};

const VOICE: VoiceSessionPage["sessions"] = [
  {
    id: "voice-01",
    channelId: "channel-analyst",
    anchorMessageId: "message-02",
    startedAt: at(136.55),
    endedAt: at(136.6),
    durationSeconds: 184,
    transcript: [
      { id: "voice-01-1", role: "user", text: "线上增长主要是哪几个品类？" },
      {
        id: "voice-01-2",
        role: "assistant",
        text: "秋季外套和针织衫两类合计贡献了线上增量的六成。",
      },
    ],
    summary: "语音确认：线上增量主要来自秋季外套和针织衫。",
    summaryStatus: "ready",
  },
];

const GROUP_TEAM: GroupConversation = {
  bots: [
    { id: "agent-analyst", name: "数据分析员" },
    { id: "agent-writer", name: "文案助理" },
    { id: "agent-support", name: "客服小熊" },
  ],
  people: [
    {
      userId: "user-demo",
      email: "demo@example.com",
      name: "演示用户",
      creator: true,
    },
    {
      userId: "user-li",
      email: "li@example.com",
      name: "李运营",
      creator: false,
    },
  ],
  messages: [
    {
      id: "group-01",
      channelId: "channel-team",
      ownerUserId: "user-demo",
      agentId: null,
      text: "双十一的活动节奏大家对一下：预热、正式、返场三段，各自要准备什么？",
      status: "completed",
      createdAt: at(133.5),
    },
    {
      id: "group-02",
      channelId: "channel-team",
      ownerUserId: "user-demo",
      agentId: "agent-analyst",
      text: "去年同期的数据：预热期流量占 **35%**，正式期成交占 **58%**。建议预热期把加购提醒提前到 11 月 4 日。",
      status: "completed",
      createdAt: at(133.6),
    },
    {
      id: "group-03",
      channelId: "channel-team",
      ownerUserId: "user-li",
      agentId: null,
      text: "加购提醒的短信模板我这边来审。",
      status: "completed",
      createdAt: at(133.7),
    },
    {
      id: "group-04",
      channelId: "channel-team",
      ownerUserId: "user-demo",
      agentId: "agent-writer",
      text: "三段推文已经写好初稿：\n\n1. 预热：「好物提前看，加购享双倍积分」\n2. 正式：「零点开抢，前 1 小时满 300 减 50」\n3. 返场：「错过不再等，最后 24 小时」\n\n推文发布时间需要你确认一下。",
      status: "completed",
      createdAt: at(133.9),
    },
    {
      id: "group-05",
      channelId: "channel-team",
      ownerUserId: "user-demo",
      agentId: "agent-support",
      text: "",
      status: "waiting",
      reason: "要给 1,200 位老客户群发活动通知，等你批准。",
      createdAt: at(134),
    },
  ],
};

/** A small chart standing in for the screenshot somebody attached. */
const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#1c1c1e"/><g stroke="#3a3a3d" stroke-width="1"><line x1="24" y1="200" x2="236" y2="200"/><line x1="24" y1="150" x2="236" y2="150"/><line x1="24" y1="100" x2="236" y2="100"/><line x1="24" y1="50" x2="236" y2="50"/></g><polyline fill="none" stroke="#f6f6f6" stroke-width="4" stroke-linejoin="round" points="24,180 70,160 116,170 162,120 208,96 236,70"/><polyline fill="none" stroke="#fb5257" stroke-width="3" stroke-dasharray="6 6" points="24,190 70,184 116,176 162,160 208,150 236,140"/></svg>`;

/** The support coworker asking somebody to sign it in to the CRM (`/sign-in/signin-crm`). */
const SIGN_IN_REQUEST: SignInRequest = {
  id: "signin-crm",
  botId: "agent-support",
  toolCallId: "call-signin-crm",
  origin: "https://crm.example.com",
  reason:
    "客服小熊要登录客户管理系统，才能查到订单 SO-20261106-0042 的发货记录。",
  status: "pending",
  method: null,
  outcome: null,
  controlRequestId: null,
  createdAt: at(136.8),
  expiresAt: at(137.3),
  resolvedAt: null,
  passwordManager: true,
  savedLogins: [{ id: "login-01", username: "support@example.com" }],
};

export const EXTRA: FixtureRoute[] = [
  [
    "GET",
    /^\/api\/sign-in-requests\/([^/]+)$/,
    (c) =>
      c.data && decodeURIComponent(c.match[1]!) === SIGN_IN_REQUEST.id
        ? ok(SIGN_IN_REQUEST)
        : { status: 404, body: { error: "这个登录请求已经不在了。" } },
  ],
  [
    "GET",
    /^\/api\/copilotkit\/threads\/([^/]+)\/messages$/,
    (c) =>
      ok({
        messages: list(c, THREADS[decodeURIComponent(c.match[1]!)] ?? []),
      }),
  ],
  [
    "GET",
    /^\/api\/voice\/sessions$/,
    (c) =>
      ok({
        sessions: list(
          c,
          VOICE.filter(
            (session) => session.channelId === c.params.get("channelId"),
          ),
        ),
        nextCursor: null,
      } satisfies VoiceSessionPage),
  ],
  ["PUT", /^\/api\/channels\/([^/]+)\/read$/, () => ok({ ok: true })],
  [
    "GET",
    /^\/api\/attachments\/att-chart$/,
    () => ({ status: 200, contentType: "image/svg+xml", body: CHART_SVG }),
  ],
  ["HEAD", /^\/api\/attachments\/([^/]+)$/, () => ok({})],
  [
    "GET",
    /^\/api\/groups\/([^/]+)$/,
    (c) =>
      decodeURIComponent(c.match[1]!) === "channel-team"
        ? ok(
            c.data
              ? GROUP_TEAM
              : ({
                  ...GROUP_TEAM,
                  people: GROUP_TEAM.people.slice(0, 1),
                  messages: [],
                } satisfies GroupConversation),
          )
        : { status: 404, body: { error: "找不到这个群聊。" } },
  ],
];
