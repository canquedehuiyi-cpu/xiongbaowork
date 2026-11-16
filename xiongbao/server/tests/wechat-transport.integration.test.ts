import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { routeAllows } from "../src/agents/lifecycle";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  type ApprovalPolicyOutcome,
  type ApprovalRecord,
  approvalAction,
} from "../src/approvals/types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  deliveryBindings,
  deliveryInbox,
  deliveryOutbox,
  intelligenceChannelMappings,
  pushDevices,
  taskBriefings,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import { approvalRequests } from "../src/db/schema/approvals";
import {
  type WechatAccount,
  wechatAccounts,
  wechatPrompts,
} from "../src/db/schema/wechat";
import { createExpoPushTransport } from "../src/delivery/push";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryScopes } from "../src/delivery/scope";
import { createDeliveryStore } from "../src/delivery/store";
import {
  approvalText,
  createWechatDecisions,
  handinText,
  overdueText,
} from "../src/delivery/wechat/decisions";
import type { IlinkMessage } from "../src/delivery/wechat/ilink";
import { IlinkWindowClosedError } from "../src/delivery/wechat/ilink";
import { createWechatInbound } from "../src/delivery/wechat/inbound";
import { createWechatStore } from "../src/delivery/wechat/store";
import {
  createWechatTransport,
  createWechatWindow,
  WECHAT_PUSH_WINDOW_MS,
} from "../src/delivery/wechat/transport";
import type { PeopleStore } from "../src/people/store";
import {
  createBriefings,
  createTaskNotices,
  notifyOnHandIn,
  WECHAT_KEEP_OPEN_HINT,
} from "../src/tasks/briefing";
import type { CardTurns } from "../src/tasks/card-turns";
import { createDelivery } from "../src/tasks/delivery";
import { savedWorkHours } from "../src/tasks/delivery-checker";
import type { NudgeRuns } from "../src/tasks/nudge-run";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 微信出站（计划 2026-11-16-im-channels-wechat Task 8）：发件箱 transport、主动推送时间窗、漏发补一句。
 * 真的库、真的投递路由和发件箱、真的 Task 7 编号提示、真的通知出口（`createTaskNotices`）和开工清点；
 * 假的只有 iLink 的发送（`WechatSend`）、手机推送的网络和员工那一轮。时钟一律是注入的。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `wxo-${randomUUID().slice(0, 8)}`;
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const deliveryStore = createDeliveryStore(database);
const wechatStore = createWechatStore(database);
const approvalStore = createApprovalStore(database);
const approvalService = createApprovalService(approvalStore);
const delivery = createDelivery(database);
const people: string[] = [];
const madeAgents: string[] = [];
const approvalIds: string[] = [];
const APP = "https://xiongbao.example.test";
const HOUR = 60 * 60_000;

const actorFor = async (userId: string): Promise<AgentActor> => ({
  id: userId,
  role: "user",
});
const scopes = createDeliveryScopes({
  database,
  people: {
    find: async (id: string) =>
      people.includes(id) ? ({ id, revoked: false } as never) : undefined,
  } as Pick<PeopleStore, "find">,
  actorFor,
  channels: channelStore,
  bots: profileStore,
});

/** 周一 14:00 上海时间：在作息里。 */
const MONDAY_14 = new Date("2026-11-16T06:00:00.000Z");
/** 周一 09:00 上海时间：开工清点的时段。 */
const MONDAY_9 = new Date("2026-11-16T01:00:00.000Z");
/** 周六 23:00 上海时间：作息外。 */
const SATURDAY_23 = new Date("2026-11-21T15:00:00.000Z");
let clock = MONDAY_14;

/** iLink 的发送：记下发出的字；`failWith` 设了就抛它。 */
type Sent = { userId: string; text: string; contextToken: string | null };
const sent: Sent[] = [];
let failWith: Error | null = null;
const send = async (
  account: WechatAccount,
  input: { text: string; contextToken: string | null },
) => {
  if (failWith) throw failWith;
  sent.push({
    userId: account.userId,
    text: input.text,
    contextToken: input.contextToken,
  });
};

const pushSends: { to: string; title: string; body: string }[] = [];
const push = createExpoPushTransport({
  fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.to) pushSends.push(body);
    return Response.json({
      data: { status: "ok", id: `ticket-${pushSends.length}` },
    });
  },
});

let decisions: ReturnType<typeof createWechatDecisions>;
const turns: CardTurns = {
  sendAsUser: async () => ({
    runId: `run-${randomUUID()}`,
    groupMessageId: null,
  }),
  stopRound: async () => {},
  say: async () => {},
};
const rounds: Pick<NudgeRuns, "nudgeNow" | "reassignTask"> = {
  nudgeNow: async () => ({ ok: true, nudges: 1 }),
  reassignTask: async () => ({ ok: true, threadRef: "t", started: true }),
};
decisions = createWechatDecisions({
  database,
  wechat: wechatStore,
  approvals: approvalService,
  deliveries: deliveryStore,
  delivery,
  turns,
  rounds,
  bots: profileStore,
  actorFor,
  timeZone: () => "Asia/Shanghai",
  appUrl: APP,
  now: () => clock,
});

/** true：默认路由（微信不在「全部」里）；false：本人打开了微信。 */
let defaultRoute = false;
/** 员工的通知级别：false 是「什么都别通知」。 */
let botNotify = true;
/** 员工那一轮：默认回「收到」；测试可以换成停下来等审批。 */
let runTurn: () => Promise<{ replyText: string }> = async () => ({
  replyText: "收到",
});
const router = createDeliveryRouter({
  store: deliveryStore,
  queue: createWorkQueue(database),
  owner: `${prefix}-router`,
  authoriseScope: scopes.authorise,
  scopeFor: scopes.scopeFor,
  routeFor: async () => ({
    kind: "progress",
    notify: botNotify,
    allows: (transport) =>
      botNotify && (defaultRoute ? routeAllows("all", transport) : true),
  }),
  providers: {
    push,
    wechat: createWechatTransport({
      wechat: wechatStore,
      send,
      prompts: () => decisions,
    }),
  },
  wechatWindow: createWechatWindow({ wechat: wechatStore, now: () => clock }),
  runTurn: async () => runTurn(),
});

const notices = createTaskNotices({
  database,
  router,
  scopeFor: scopes.scopeFor,
  workHours: savedWorkHours(database),
  agentName: async (tenantId, agentId) =>
    (await profileStore.get(await actorFor(tenantId), agentId))?.name ?? null,
});

const inbound = createWechatInbound({
  wechat: wechatStore,
  deliveries: deliveryStore,
  router,
  channels: channelStore,
  bots: profileStore,
  actorFor,
  scopeFor: scopes.scopeFor,
  send,
  appUrl: APP,
  prompts: decisions.handlers,
  approvalPrompts: (userId, ids) =>
    decisions.openApprovalPrompts(userId, ids, { onlyCreated: true }),
  now: () => clock,
});

type Person = {
  userId: string;
  ilinkUserId: string;
  account: WechatAccount;
  botId: string;
  botName: string;
  scope: Awaited<ReturnType<typeof scopes.scopeFor>> & object;
};
const asPerson = <T>(who: { userId: string }, work: () => Promise<T>) =>
  runAsTenant(who.userId, work);

/**
 * 一个人：绑了微信、有一位员工和他们的单聊、一部手机，微信里最近一次来信在 `inboundAgoMs` 之前
 * （注入时钟算）。微信绑定接在这个单聊上，和入站分流建的一样。
 */
async function person(
  name: string,
  inboundAgoMs: number | null = HOUR,
): Promise<Person> {
  const userId = `${prefix}-${name}`;
  people.push(userId);
  await runAsTenant(userId, () =>
    database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test` }),
  );
  const ilinkUserId = `${prefix}-wx-${name}@im.wechat`;
  const account = await asPerson({ userId }, () =>
    wechatStore.saveAccount({
      userId,
      ilinkBotId: `${prefix}-bot-${name}@im.bot`,
      ilinkUserId,
      baseUrl: "https://ilinkai.weixin.qq.com",
      credentialId: null,
    }),
  );
  if (inboundAgoMs !== null)
    await asPerson({ userId }, () =>
      wechatStore.markInbound(account.id, {
        at: new Date(clock.getTime() - inboundAgoMs),
        contextToken: `ctx-${name}`,
      }),
    );
  const botName = `代码熊${name}`;
  const profile = await asPerson({ userId }, () =>
    profileStore.create(
      { id: userId, role: "user" },
      {
        name: botName,
        title: "工程师",
        roleDescription: "简短回答。",
        visibility: "private",
      },
    ),
  );
  madeAgents.push(profile.id);
  const actor = await actorFor(userId);
  const channel = await asPerson({ userId }, () =>
    channelStore.direct(actor, profile.id),
  );
  const scope = await asPerson({ userId }, () =>
    scopes.scopeFor(userId, channel.id, profile.id),
  );
  if (!scope) throw new Error("no scope");
  await asPerson({ userId }, () =>
    deliveryStore.bind({
      ...scope,
      transport: "wechat",
      realm: `${prefix}-bot-${name}@im.bot`,
      identity: `${ilinkUserId}#${profile.id}`,
      address: ilinkUserId,
    }),
  );
  await asPerson({ userId }, () =>
    deliveryStore.registerDevice({
      id: `${prefix}-phone-${name}`,
      ownerUserId: userId,
      token: `ExponentPushToken[${prefix}-${name}]`,
      projectId: randomUUID(),
      platform: "ios",
    }),
  );
  const fresh = await asPerson({ userId }, () => wechatStore.account(userId));
  return {
    userId,
    ilinkUserId,
    account: fresh ?? account,
    botId: profile.id,
    botName,
    scope,
  };
}

const ASK: ApprovalPolicyOutcome = {
  behaviour: "ask",
  source: "default",
} as ApprovalPolicyOutcome;
/** 一条等这个人批的请求：员工想删 ~/build。`at` 是发起它的对话（默认和员工的单聊）。 */
async function approval(
  who: Person,
  at: { botId: string; threadId: string } = {
    botId: who.botId,
    threadId: who.scope.threadId,
  },
): Promise<ApprovalRecord> {
  const args = { path: "~/build" };
  const candidate: ApprovalCandidate = {
    actorId: who.userId,
    botId: at.botId,
    toolRef: "files/delete",
    effect: "write",
    scope: "~/build",
    args,
    continuation: {
      runId: randomUUID(),
      threadId: at.threadId,
      toolCallId: randomUUID(),
      toolName: "files__delete",
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
  const record = await asPerson(who, () =>
    approvalStore.open({ ...approvalAction(candidate), policy: ASK }),
  );
  approvalIds.push(record.id);
  return record;
}

/** 一件在跟的活，员工已接下，一小时前就该交。 */
async function card(
  who: Person,
  input: Partial<typeof tasks.$inferInsert> = {},
) {
  const due = new Date(clock.getTime() - HOUR);
  const [row] = await asPerson(who, () =>
    database
      .insert(tasks)
      .values({
        title: "核对本周发票",
        executorAgentId: who.botId,
        source: "chat",
        status: "running",
        tracked: true,
        threadRef: who.scope.threadId,
        channelRef: who.scope.channelId,
        acceptedAt: new Date(clock.getTime() - 3 * HOUR),
        dueAt: due,
        originalDueAt: due,
        dueReported: true,
        ...input,
      })
      .returning({ id: tasks.id }),
  );
  if (!row) throw new Error("no card");
  return row.id;
}

const outbox = (who: Person) =>
  asPerson(who, () =>
    database
      .select()
      .from(deliveryOutbox)
      .where(eq(deliveryOutbox.ownerUserId, who.userId)),
  );
/** 把这个人排着的发件箱都发出去。 */
async function sweep(who: Person) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await outbox(who)).some((row) => row.state === "queued")) return;
    await router.sweep("delivery.outbound");
  }
  throw new Error("outbox did not drain");
}
const wechatRows = async (who: Person) =>
  (await outbox(who)).filter((row) => row.transport === "wechat");
const sentTo = (who: Person) =>
  sent.filter((s) => s.userId === who.userId).map((s) => s.text);
const pushedTo = (who: Person) =>
  pushSends.filter((p) => p.to.includes(who.userId));
const accountOf = (who: Person) =>
  asPerson(who, () => wechatStore.account(who.userId));
const openPrompts = (who: Person) =>
  asPerson(who, () => wechatStore.openPrompts(who.userId));

let seq = 0;
async function deliverText(who: Person, text: string) {
  const id = `86279687568150${String(10000 + ++seq)}`;
  const message: IlinkMessage = {
    id,
    fromUserId: who.ilinkUserId,
    text,
    contextToken: `ctx-${id}`,
    groupId: null,
  };
  await asPerson(who, async () => {
    const account = await wechatStore.account(who.userId);
    await wechatStore.markInbound(who.account.id, {
      at: clock,
      contextToken: message.contextToken,
    });
    await inbound(account ?? who.account, message);
  });
}

afterAll(async () => {
  await runAsTenant("platform", async () => {
    if (people.length) {
      await database
        .delete(deliveryOutbox)
        .where(inArray(deliveryOutbox.ownerUserId, people));
      await database
        .delete(deliveryInbox)
        .where(inArray(deliveryInbox.ownerUserId, people));
      await database
        .delete(deliveryBindings)
        .where(inArray(deliveryBindings.ownerUserId, people));
      await database
        .delete(pushDevices)
        .where(inArray(pushDevices.ownerUserId, people));
      await database
        .delete(workItems)
        .where(inArray(workItems.tenantId, people));
      await database
        .delete(taskBriefings)
        .where(inArray(taskBriefings.tenantId, people));
      await database
        .delete(wechatPrompts)
        .where(inArray(wechatPrompts.userId, people));
      await database
        .delete(wechatAccounts)
        .where(inArray(wechatAccounts.userId, people));
    }
    if (approvalIds.length) {
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, approvalIds),
          ),
        );
      await database
        .delete(approvalConversationGrants)
        .where(inArray(approvalConversationGrants.approvalId, approvalIds));
      await database
        .delete(approvalRequests)
        .where(inArray(approvalRequests.id, approvalIds));
    }
    if (people.length)
      await database.delete(tasks).where(inArray(tasks.tenantId, people));
    const owned = madeAgents.length
      ? await database
          .select({ id: channelAgents.channelId })
          .from(channelAgents)
          .where(inArray(channelAgents.agentId, madeAgents))
      : [];
    for (const { id } of owned) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    if (madeAgents.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, madeAgents));
      await database.delete(agents).where(inArray(agents.id, madeAgents));
    }
    if (people.length)
      await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

const setup = () => {
  clock = MONDAY_14;
  failWith = null;
  defaultRoute = false;
  botNotify = true;
  runTurn = async () => ({ replyText: "收到" });
};

describe("时间窗开着：微信收到带编号的文字，手机推送照常", () => {
  test("员工请求许可：微信收到审批请求文字，手机也收到", async () => {
    setup();
    const who = await person("a");
    const record = await approval(who);
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "【代码熊】想要 删除 ~/build",
      }),
    );
    await sweep(who);
    const prompts = await openPrompts(who);
    expect(prompts.map((p) => [p.kind, p.refId])).toEqual([
      ["approval", record.id],
    ]);
    const [text] = sentTo(who);
    expect(text).toBe(
      approvalText({ code: prompts[0]?.code ?? "" }, record, who.botName, {
        link: `${APP}/approvals?id=${record.id}`,
      }),
    );
    expect(text).toContain("回复 1 批准一次");
    expect(text).toContain(`【${who.botName}】`);
    expect(sent[0]?.contextToken).toBe("ctx-a");
    expect(pushedTo(who).length).toBe(1);
    const row = (await wechatRows(who))[0];
    expect(row?.state).toBe("sent");
  });

  test("逾期：微信收到「回复 再催 / 延期 … / 换人 / 取消」，手机也收到", async () => {
    setup();
    const who = await person("b");
    const taskId = await card(who);
    const result = await asPerson(who, () =>
      notices.notify(
        who.userId,
        { kind: "overdue", taskId, text: "代码熊b 的『核对本周发票』逾期了" },
        clock,
      ),
    );
    expect(result).toBe("sent");
    await sweep(who);
    const [text] = sentTo(who);
    const prompts = await openPrompts(who);
    expect(prompts.map((p) => [p.kind, p.refId])).toEqual([
      ["overdue", taskId],
    ]);
    expect(text).toContain("回复 再催 / 延期 明早10点 / 换人 / 取消");
    // 结构化标记（不是看标题文字）；微信行不走手机深链，所以 request_id 可以带它。
    expect((await wechatRows(who))[0]?.requestId).toBe(
      `wechat-prompt:overdue:${taskId}`,
    );
    expect(text).toContain(`【${who.botName}】的「核对本周发票」逾期了`);
    expect(text).toBe(
      overdueText(
        { code: prompts[0]?.code ?? "" },
        {
          id: taskId,
          title: "核对本周发票",
          dueAt: new Date(clock.getTime() - HOUR),
        },
        who.botName,
        {
          link: `${APP}/tasks/${taskId}`,
          now: clock,
          timeZone: "Asia/Shanghai",
        },
      ),
    );
    expect(pushedTo(who).length).toBe(1);
  });

  test("「还没接下」按原文发，不开提示", async () => {
    setup();
    const who = await person("c");
    const taskId = await card(who);
    await asPerson(who, () =>
      notices.notify(
        who.userId,
        {
          kind: "pending_accept",
          taskId,
          text: "代码熊c还没接下『核对本周发票』",
        },
        clock,
      ),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual(["还没接下\n代码熊c还没接下『核对本周发票』"]);
    expect((await wechatRows(who))[0]?.requestId).toBe(taskId);
    expect(await openPrompts(who)).toEqual([]);
  });

  test("作息外主动提醒照旧被拦（沿用 createTaskNotices），审批作息外照常推", async () => {
    setup();
    const who = await person("d");
    clock = SATURDAY_23;
    await asPerson(who, () =>
      wechatStore.markInbound(who.account.id, {
        at: new Date(clock.getTime() - HOUR),
        contextToken: "ctx-d2",
      }),
    );
    const taskId = await card(who);
    const held = await asPerson(who, () =>
      notices.notify(
        who.userId,
        { kind: "overdue", taskId, text: "逾期" },
        clock,
      ),
    );
    expect(held).toBe("deferred");
    expect(await outbox(who)).toEqual([]);
    const record = await approval(who);
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(sentTo(who).length).toBe(1);
  });

  test("开工清点：时间窗开着末尾带「回复任意内容…」，收工清点不带", async () => {
    setup();
    clock = MONDAY_9;
    const who = await person("e");
    await card(who);
    const briefings = createBriefings({
      database,
      workHours: savedWorkHours(database),
      agentName: async () => who.botName,
      send: (tenantId, k, briefing, now) =>
        notices.sendBriefing(tenantId, k, briefing, now),
      onlyTenants: [who.userId],
    });
    const built = await briefings.buildBriefing(who.userId, "start", clock);
    expect(built).not.toBeNull();
    const reached = await asPerson(who, () =>
      notices.sendBriefing(who.userId, "start", built as never, clock),
    );
    expect(reached).toBeGreaterThan(0);
    await sweep(who);
    const [text] = sentTo(who);
    expect(text?.startsWith("开工清点")).toBe(true);
    expect(text?.endsWith(`\n${WECHAT_KEEP_OPEN_HINT}`)).toBe(true);
    expect(WECHAT_KEEP_OPEN_HINT).toBe(
      "回复任意内容，今天的提醒就能继续发到这里",
    );

    sent.length = 0;
    await asPerson(who, () =>
      notices.sendBriefing(who.userId, "end", built as never, clock),
    );
    await sweep(who);
    expect(sentTo(who).length).toBe(1);
    expect(sentTo(who)[0]).not.toContain(WECHAT_KEEP_OPEN_HINT);
  });
});

describe("时间窗关了：不往微信发，手机照发，下次入站补一句", () => {
  test("11 小时前来的信：逾期不发微信、漏发加一；入站先补「有 1 条提醒在熊宝里」", async () => {
    setup();
    const who = await person("f", 11 * HOUR);
    expect(WECHAT_PUSH_WINDOW_MS).toBe(10 * HOUR);
    const taskId = await card(who);
    const result = await asPerson(who, () =>
      notices.notify(
        who.userId,
        { kind: "overdue", taskId, text: "逾期" },
        clock,
      ),
    );
    // 手机推送到了，所以算「发出去了」。
    expect(result).toBe("sent");
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect(sentTo(who)).toEqual([]);
    expect(pushedTo(who).length).toBe(1);
    expect((await accountOf(who))?.missedCount).toBe(1);

    await deliverText(who, `@${who.botName} 你好`);
    const texts = sentTo(who);
    expect(texts[0]).toBe(`有 1 条提醒在熊宝里：${APP}/briefing`);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.at(-1)).toContain("收到");
    expect((await accountOf(who))?.missedCount).toBe(0);

    sent.length = 0;
    await deliverText(who, "再来一句");
    expect(sentTo(who).some((t) => t.includes("条提醒"))).toBe(false);
  });

  test("从没来过信（没有 context_token）：同样当作时间窗已关", async () => {
    setup();
    const who = await person("g", null);
    const record = await approval(who);
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect(pushedTo(who).length).toBe(1);
    expect((await accountOf(who))?.missedCount).toBe(1);
  });
});

describe("发送失败", () => {
  test("iLink 拒绝（时间窗已关）：发件箱 failed、漏发加一、不重试", async () => {
    setup();
    const who = await person("h");
    const record = await approval(who);
    failWith = new IlinkWindowClosedError();
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    const [row] = await wechatRows(who);
    expect(row?.state).toBe("failed");
    expect(row?.error).toContain("window_closed");
    expect((await accountOf(who))?.missedCount).toBe(1);
    // 用户从没见过的编号不留下。
    expect(await openPrompts(who)).toEqual([]);
    failWith = null;
    await router.sweep("delivery.outbound");
    await router.sweep("delivery.outbound");
    expect(sentTo(who)).toEqual([]);
    expect((await wechatRows(who))[0]?.state).toBe("failed");
    // 手机那一行照常发出。
    expect(pushedTo(who).length).toBe(1);
  });

  test("别的失败也记 failed，不重试", async () => {
    setup();
    const who = await person("i");
    const taskId = await card(who);
    failWith = new Error("boom");
    await asPerson(who, () =>
      notices.notify(
        who.userId,
        { kind: "overdue", taskId, text: "逾期" },
        clock,
      ),
    );
    await sweep(who);
    expect((await wechatRows(who))[0]?.state).toBe("failed");
    expect((await accountOf(who))?.missedCount).toBe(0);
    expect(await openPrompts(who)).toEqual([]);
  });

  test("回复发不出去（时间窗关了）不算漏发的提醒", async () => {
    setup();
    const who = await person("m");
    const record = await approval(who);
    runTurn = async () => {
      const error = new Error("suspended");
      error.name = "HeadlessToolSuspension";
      Object.assign(error, {
        waiting: { kind: "approval", approvalId: record.id },
      });
      throw error;
    };
    await deliverText(who, `@${who.botName} 删掉 build`);
    failWith = new IlinkWindowClosedError();
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "resume-reply-m",
        kind: "reply",
        text: "好了",
      }),
    );
    await sweep(who);
    expect((await wechatRows(who))[0]?.state).toBe("failed");
    expect((await accountOf(who))?.missedCount).toBe(0);
  });
});

describe("路由门和回复", () => {
  test("默认路由（本人没打开微信）：什么都不发微信，也不算漏发", async () => {
    setup();
    defaultRoute = true;
    const who = await person("j");
    const record = await approval(who);
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect(pushedTo(who).length).toBe(1);
    expect((await accountOf(who))?.missedCount).toBe(0);
  });

  test("网页里发起的普通回复不推到微信；微信里停下等审批的那一轮，之后的回复回到微信", async () => {
    setup();
    const who = await person("k");
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "web-reply-1",
        kind: "reply",
        text: "网页上的回复",
      }),
    );
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect((await accountOf(who))?.missedCount).toBe(0);
    expect(pushedTo(who).length).toBe(1);

    // 微信里开的一轮停下来等审批。
    const record = await approval(who);
    runTurn = async () => {
      const error = new Error("suspended");
      error.name = "HeadlessToolSuspension";
      Object.assign(error, {
        waiting: { kind: "approval", approvalId: record.id },
      });
      throw error;
    };
    await deliverText(who, `@${who.botName} 删掉 build`);
    sent.length = 0;
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "resume-reply-1",
        kind: "reply",
        text: "已经删好了",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([`【${who.botName}】已经删好了`]);
    // 那一轮的回复交出去后它就结束了：之后网页里发起的回复不再进微信。
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "web-reply-2",
        kind: "reply",
        text: "网页上又一条",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([`【${who.botName}】已经删好了`]);
    expect((await wechatRows(who)).length).toBe(1);
    const rounds = await asPerson(who, () =>
      database
        .select({ state: deliveryInbox.state })
        .from(deliveryInbox)
        .where(eq(deliveryInbox.ownerUserId, who.userId)),
    );
    expect(rounds.map((r) => r.state)).toEqual(["sent"]);
  });
});

describe("按 (kind, ref) 去重", () => {
  test("微信里那一轮已随回复发过带编号的审批请求：发件箱不再发第二次", async () => {
    setup();
    const who = await person("l");
    const record = await approval(who);
    runTurn = async () => {
      const error = new Error("suspended");
      error.name = "HeadlessToolSuspension";
      Object.assign(error, {
        waiting: { kind: "approval", approvalId: record.id },
      });
      throw error;
    };
    await deliverText(who, `@${who.botName} 删掉 build`);
    const asked = sentTo(who).filter((t) => t.includes("批准一次"));
    expect(asked.length).toBe(1);
    const before = sentTo(who).length;
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(sentTo(who).length).toBe(before);
    const [row] = await wechatRows(who);
    expect(row?.state).toBe("sent");
    // 没发就不能让人以为发了：error 里说明。
    expect(row?.error).toBe("已在微信里发过这条审批，没有重复发送。");
    // 只有一条开着的提示。
    expect((await openPrompts(who)).length).toBe(1);
    // 手机照常推。
    expect(pushedTo(who).length).toBe(1);
  });
});

describe("谁开出提示谁发", () => {
  test("同一审批开两次：先开的 created，后开的不是；onlyCreated 给后开的 null", async () => {
    setup();
    const who = await person("n");
    const record = await approval(who);
    const first = await asPerson(who, () =>
      decisions.openApprovalPrompt(who.userId, record.id),
    );
    const second = await asPerson(who, () =>
      decisions.openApprovalPrompt(who.userId, record.id),
    );
    expect([first?.created, second?.created]).toEqual([true, false]);
    expect(second?.code).toBe(first?.code as string);
    expect(
      await asPerson(who, () =>
        decisions.openApprovalPrompts(who.userId, [record.id], {
          onlyCreated: true,
        }),
      ),
    ).toEqual([null]);
  });

  test("发件箱先开出提示并发出去：入站随后不再发第二次，也不说「有 N 个审批在等你」", async () => {
    setup();
    const who = await person("o");
    const record = await approval(who);
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(sentTo(who).length).toBe(1);
    runTurn = async () => {
      const error = new Error("suspended");
      error.name = "HeadlessToolSuspension";
      Object.assign(error, {
        waiting: { kind: "approval", approvalId: record.id },
      });
      throw error;
    };
    sent.length = 0;
    await deliverText(who, `@${who.botName} 删掉 build`);
    expect(sentTo(who).filter((t) => t.includes("批准一次"))).toEqual([]);
    expect(sentTo(who).some((t) => t.includes("个审批在等你"))).toBe(false);
    expect((await openPrompts(who)).length).toBe(1);
  });
});

/** 员工那一轮停下来等这条审批（抛出 headless 挂起）。 */
const suspendOn = (record: ApprovalRecord) => async () => {
  const error = new Error("suspended");
  error.name = "HeadlessToolSuspension";
  Object.assign(error, {
    waiting: { kind: "approval", approvalId: record.id },
  });
  throw error;
};
const inboxStates = (who: Person) =>
  asPerson(who, async () =>
    (
      await database
        .select({ state: deliveryInbox.state })
        .from(deliveryInbox)
        .where(eq(deliveryInbox.ownerUserId, who.userId))
    ).map((r) => r.state),
  );

describe("默认路由（本人没打开微信）下，微信里发起的那一轮的回复回到微信", () => {
  test("微信里停下等审批 → 微信里批准 → 恢复后的回复回到微信；之后网页发起的回复不进微信", async () => {
    setup();
    defaultRoute = true;
    const who = await person("p1");
    const record = await approval(who);
    runTurn = suspendOn(record);
    await deliverText(who, `@${who.botName} 删掉 build`);
    expect(sentTo(who).some((t) => t.includes("批准一次"))).toBe(true);
    runTurn = async () => ({ replyText: "收到" });
    await deliverText(who, "1");
    expect(
      (await asPerson(who, () => approvalStore.get(who.userId, record.id)))
        ?.status,
    ).not.toBe("pending");
    sent.length = 0;
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "resume-reply-p1",
        kind: "reply",
        text: "已经删好了",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([`【${who.botName}】已经删好了`]);
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "web-reply-p1",
        kind: "reply",
        text: "网页上的回复",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([`【${who.botName}】已经删好了`]);
    expect((await wechatRows(who)).length).toBe(1);
  });

  test("网页里批准，恢复后的回复同样回到微信", async () => {
    setup();
    defaultRoute = true;
    const who = await person("p2");
    const record = await approval(who);
    runTurn = suspendOn(record);
    await deliverText(who, `@${who.botName} 删掉 build`);
    await asPerson(who, () =>
      approvalService.decide(who.userId, record.id, "allow_once", "web"),
    );
    sent.length = 0;
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "resume-reply-p2",
        kind: "reply",
        text: "删好了",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([`【${who.botName}】删好了`]);
    expect(await inboxStates(who)).toEqual(["sent"]);
  });

  test("员工设成「什么都别通知」：回复不进微信，那一轮也收尾", async () => {
    setup();
    defaultRoute = true;
    const who = await person("p3");
    const record = await approval(who);
    runTurn = suspendOn(record);
    await deliverText(who, `@${who.botName} 删掉 build`);
    botNotify = false;
    sent.length = 0;
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "resume-reply-p3",
        kind: "reply",
        text: "删好了",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([]);
    expect(await wechatRows(who)).toEqual([]);
    expect(await inboxStates(who)).not.toContain("accepted");
  });

  test("时间窗关了：回复发不出去，那一轮也置终态，之后网页回复不会被推到微信", async () => {
    setup();
    defaultRoute = true;
    const who = await person("p4");
    const record = await approval(who);
    runTurn = suspendOn(record);
    await deliverText(who, `@${who.botName} 删掉 build`);
    // 过了 11 个小时才恢复。
    clock = new Date(clock.getTime() + 11 * HOUR);
    sent.length = 0;
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "resume-reply-p4",
        kind: "reply",
        text: "删好了",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([]);
    expect(await inboxStates(who)).not.toContain("accepted");
    // 回复不算漏发的提醒。
    expect((await accountOf(who))?.missedCount).toBe(0);
    // 窗口又开了（来过一句别的），网页上的回复也不会被当成那一轮的。
    await asPerson(who, () =>
      wechatStore.markInbound(who.account.id, {
        at: clock,
        contextToken: "ctx-p4-2",
      }),
    );
    await asPerson(who, () =>
      router.notify(who.scope, {
        id: "web-reply-p4",
        kind: "reply",
        text: "网页上的回复",
      }),
    );
    await sweep(who);
    expect(sentTo(who)).toEqual([]);
  });
});

describe("「等你确认」没有对口的微信绑定时回落到最近用过的那个", () => {
  /** 这个人的另一位员工（没在微信里找过它），和它的单聊。 */
  async function otherBot(who: Person, name: string) {
    const actor = await actorFor(who.userId);
    const profile = await asPerson(who, () =>
      profileStore.create(actor, {
        name,
        title: "会计",
        roleDescription: "简短回答。",
        visibility: "private",
      }),
    );
    madeAgents.push(profile.id);
    const channel = await asPerson(who, () =>
      channelStore.direct(actor, profile.id),
    );
    const scope = await asPerson(who, () =>
      scopes.scopeFor(who.userId, channel.id, profile.id),
    );
    if (!scope) throw new Error("no scope");
    return { botId: profile.id, scope };
  }

  test("没在微信里聊过的员工发起的审批：发到最近用过的微信绑定，文字带它的名字", async () => {
    setup();
    const who = await person("q1");
    const other = await otherBot(who, "账房熊q1");
    const record = await approval(who, {
      botId: other.botId,
      threadId: other.scope.threadId,
    });
    await asPerson(who, () =>
      router.notify(other.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    const [text] = sentTo(who);
    expect(text).toContain("【账房熊q1】");
    expect(text).toContain("回复 1 批准一次");
    expect((await wechatRows(who))[0]?.state).toBe("sent");
    expect((await openPrompts(who)).map((p) => [p.kind, p.refId])).toEqual([
      ["approval", record.id],
    ]);
    // 回数字照常生效。
    await deliverText(who, "1");
    expect(
      (await asPerson(who, () => approvalStore.get(who.userId, record.id)))
        ?.status,
    ).not.toBe("pending");
    expect(pushedTo(who).length).toBe(1);
  });

  test("任务卡片那段对话里的审批：同样发到微信，带对话名", async () => {
    setup();
    const who = await person("q2");
    const actor = await actorFor(who.userId);
    const channel = await asPerson(who, () =>
      channelStore.create(actor, [who.botId]),
    );
    await asPerson(who, () =>
      channelStore.rename(actor, channel.id, "核对本周发票"),
    );
    const cardScope = await asPerson(who, () =>
      scopes.scopeFor(who.userId, channel.id, who.botId),
    );
    if (!cardScope) throw new Error("no scope");
    const record = await approval(who, {
      botId: who.botId,
      threadId: cardScope.threadId,
    });
    await asPerson(who, () =>
      router.notify(cardScope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    const [text] = sentTo(who);
    expect(text).toContain(`【${who.botName}】`);
    expect(text).toContain("核对本周发票");
    expect(text).toContain("回复 1 批准一次");
  });

  test("本人没打开微信：不回落，什么都不发微信", async () => {
    setup();
    defaultRoute = true;
    const who = await person("q3");
    const other = await otherBot(who, "账房熊q3");
    const record = await approval(who, {
      botId: other.botId,
      threadId: other.scope.threadId,
    });
    await asPerson(who, () =>
      router.notify(other.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect(pushedTo(who).length).toBe(1);
    expect((await accountOf(who))?.missedCount).toBe(0);
  });

  test("时间窗关了：不回落发微信，漏发加一", async () => {
    setup();
    const who = await person("q4", 11 * HOUR);
    const other = await otherBot(who, "账房熊q4");
    const record = await approval(who, {
      botId: other.botId,
      threadId: other.scope.threadId,
    });
    await asPerson(who, () =>
      router.notify(other.scope, {
        id: `approval:${record.id}`,
        kind: "approval",
        requestId: record.id,
        text: "请求",
      }),
    );
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect((await accountOf(who))?.missedCount).toBe(1);
  });

  test("进度回复不回落：没在微信里聊过的员工的回复不进微信", async () => {
    setup();
    const who = await person("q5");
    const other = await otherBot(who, "账房熊q5");
    await asPerson(who, () =>
      router.notify(other.scope, {
        id: "reply-q5",
        kind: "reply",
        text: "好了",
      }),
    );
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
  });
});

describe("交付待验收：推送和微信两路", () => {
  /** 一件员工刚交上来、等验收的活。 */
  const handedIn = (
    who: Person,
    input: Partial<typeof tasks.$inferInsert> = {},
  ) => card(who, { status: "awaiting_review", ...input });

  test("时间窗开着：微信收到「回复 验收，或 退回 原因」，手机也收到并点开那张卡；回「验收」生效", async () => {
    setup();
    const who = await person("r1");
    const taskId = await handedIn(who);
    const result = await asPerson(who, () =>
      notices.handin(who.userId, taskId, clock),
    );
    expect(result).toBe("sent");
    await sweep(who);
    const prompts = await openPrompts(who);
    expect(prompts.map((p) => [p.kind, p.refId])).toEqual([["handin", taskId]]);
    const [text] = sentTo(who);
    expect(text).toBe(
      handinText(
        { code: prompts[0]?.code ?? "" },
        { id: taskId, title: "核对本周发票", dueAt: null },
        who.botName,
        { link: `${APP}/tasks/${taskId}` },
      ),
    );
    expect(text).toContain("回复 验收，或 退回 原因");
    expect((await wechatRows(who))[0]?.requestId).toBe(
      `wechat-prompt:handin:${taskId}`,
    );
    const [pushed] = pushedTo(who) as unknown as {
      title: string;
      body: string;
      data: { taskId?: string };
    }[];
    expect(pushed?.title).toBe("交付待验收");
    expect(pushed?.body).toContain("核对本周发票");
    expect(pushed?.data.taskId).toBe(taskId);
    // 这件活今天的三次算上一次。
    const [row] = await asPerson(who, () =>
      database
        .select({ count: tasks.notifiedCount })
        .from(tasks)
        .where(eq(tasks.id, taskId)),
    );
    expect(row?.count).toBe(1);

    await deliverText(who, "验收");
    const [after] = await asPerson(who, () =>
      database
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId)),
    );
    expect(after?.status).toBe("done");
  });

  test("同一件活今天已经提醒过三次：不再发", async () => {
    setup();
    const who = await person("r2");
    const taskId = await handedIn(who, {
      notifiedOn: "2026-11-16",
      notifiedCount: 3,
    });
    const result = await asPerson(who, () =>
      notices.handin(who.userId, taskId, clock),
    );
    expect(result).toBe("capped");
    expect(await outbox(who)).toEqual([]);
  });

  test("作息外：不发，留给开工清点（它列着等验收的活）", async () => {
    setup();
    const who = await person("r3");
    clock = SATURDAY_23;
    const taskId = await handedIn(who);
    const result = await asPerson(who, () =>
      notices.handin(who.userId, taskId, clock),
    );
    expect(result).toBe("deferred");
    expect(await outbox(who)).toEqual([]);
  });

  test("时间窗关了：不发微信、漏发加一，手机照发", async () => {
    setup();
    const who = await person("r4", 11 * HOUR);
    const taskId = await handedIn(who);
    const result = await asPerson(who, () =>
      notices.handin(who.userId, taskId, clock),
    );
    expect(result).toBe("sent");
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect(pushedTo(who).length).toBe(1);
    expect((await accountOf(who))?.missedCount).toBe(1);
    expect(await openPrompts(who)).toEqual([]);
  });

  test("微信发送失败：本次新开的提示关掉", async () => {
    setup();
    const who = await person("r5");
    const taskId = await handedIn(who);
    failWith = new IlinkWindowClosedError();
    await asPerson(who, () => notices.handin(who.userId, taskId, clock));
    await sweep(who);
    expect((await wechatRows(who))[0]?.state).toBe("failed");
    expect(await openPrompts(who)).toEqual([]);
    expect((await accountOf(who))?.missedCount).toBe(1);
  });

  test("本人没打开微信：只推手机", async () => {
    setup();
    defaultRoute = true;
    const who = await person("r6");
    const taskId = await handedIn(who);
    await asPerson(who, () => notices.handin(who.userId, taskId, clock));
    await sweep(who);
    expect(await wechatRows(who)).toEqual([]);
    expect(pushedTo(who).length).toBe(1);
  });

  test("员工交付（delivered）时自动发「交付待验收」", async () => {
    setup();
    const who = await person("r7");
    const runId = `run-${randomUUID()}`;
    const taskId = await card(who, { activeRunRef: runId });
    const told: string[] = [];
    const wrapped = notifyOnHandIn(delivery, async (tenantId, id) => {
      told.push(`${tenantId}:${id}`);
      return notices.handin(tenantId, id, clock);
    });
    const merged = await wrapped.delivered(who.userId, taskId, {
      runId,
      agentId: who.botId,
      actor: `agent:${who.botId}`,
      deliverable: { kind: "deliverable", notes: ["对完了"] },
    });
    expect(merged).not.toBeNull();
    expect(told).toEqual([`${who.userId}:${taskId}`]);
    await sweep(who);
    expect(sentTo(who).some((t) => t.includes("等你验收"))).toBe(true);
    expect(pushedTo(who).length).toBe(1);

    // 没交成（不是这一轮）：不通知。
    told.length = 0;
    const refused = await wrapped.delivered(who.userId, taskId, {
      runId: "another-run",
      agentId: who.botId,
      actor: `agent:${who.botId}`,
      deliverable: { kind: "deliverable", notes: ["又一版"] },
    });
    expect(refused).toBeNull();
    expect(told).toEqual([]);

    // 通知出错不影响交付本身。
    const failing = notifyOnHandIn(delivery, async () => {
      throw new Error("boom");
    });
    const again = await failing.delivered(who.userId, taskId, {
      runId,
      agentId: who.botId,
      actor: `agent:${who.botId}`,
      deliverable: { kind: "deliverable", notes: ["补一版"] },
    });
    expect(again).not.toBeNull();
  });
});
