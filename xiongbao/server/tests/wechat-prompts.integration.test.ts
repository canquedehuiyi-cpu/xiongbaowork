import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { approvalPhrase } from "../../shared/tool-name";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  type ApprovalPolicyOutcome,
  type ApprovalRecord,
  ApprovalRefusedError,
  afterChinese,
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
  intelligenceChannelMappings,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import { approvalRequests } from "../src/db/schema/approvals";
import type { WechatAccount } from "../src/db/schema/wechat";
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
import { createWechatInbound } from "../src/delivery/wechat/inbound";
import { createWechatStore } from "../src/delivery/wechat/store";
import { readLaterTime } from "../src/delivery/wechat/when";
import type { PeopleStore } from "../src/people/store";
import type { CardTurns } from "../src/tasks/card-turns";
import { createDelivery } from "../src/tasks/delivery";
import { listTaskEvents } from "../src/tasks/events";
import type { NudgeRuns } from "../src/tasks/nudge-run";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 微信里文字拍板与交付闭环命令（计划 2026-11-16-im-channels-wechat Task 7）：真的库、真的审批服务、真的交付闭环
 * 写入（验收 / 退回 / 延期 / 取消）、真的入站分流；假的只有员工那一轮、卡片对话里的说话（`CardTurns`）、
 * 服务器自己的催办和换人那一轮（`NudgeRuns`）和发回微信的发送器。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `wxp-${randomUUID().slice(0, 8)}`;
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const deliveryStore = createDeliveryStore(database);
const wechatStore = createWechatStore(database);
const approvalStore = createApprovalStore(database);
const approvalService = createApprovalService(approvalStore);
const delivery = createDelivery(database);
const people: string[] = [];
const madeAgents: string[] = [];
const approvalIds: string[] = [];
const ZONE = "Asia/Shanghai";
const APP = "https://xiongbao.example.test";

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

type Turn = { ownerUserId: string; agentId: string; text: string };
const turnLog: Turn[] = [];
/** 员工那一轮：默认回「收到」；测试可以换成停下来等审批。 */
let runTurn: (input: { text: string }) => Promise<{ replyText: string }> =
  async (input) => ({ replyText: `收到：${input.text}` });
const router = createDeliveryRouter({
  store: deliveryStore,
  queue: createWorkQueue(database),
  owner: `${prefix}-router`,
  authoriseScope: scopes.authorise,
  scopeFor: scopes.scopeFor,
  providers: {},
  runTurn: async (input) => {
    turnLog.push({
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      text: input.text,
    });
    return runTurn(input);
  },
});

/** 卡片对话里说的话（退回的原因、延期的答复）和停下的那一轮。 */
const said: { tenantId: string; threadId: string; text: string }[] = [];
const stopped: { threadId: string; runId: string | null }[] = [];
const notices: { threadId: string; text: string }[] = [];
const turns: CardTurns = {
  sendAsUser: async (tenantId, to, text) => {
    said.push({ tenantId, threadId: to.threadId, text });
    return { runId: `run-${randomUUID()}`, groupMessageId: null };
  },
  stopRound: async (_tenantId, round) => {
    stopped.push({ threadId: round.threadId, runId: round.runId });
  },
  say: async (_tenantId, where, _event, groupText) => {
    notices.push({ threadId: where.threadId, text: groupText });
  },
};
const nudges: { tenantId: string; taskId: string }[] = [];
const reassigns: { tenantId: string; taskId: string; agentId: string }[] = [];
const rounds: Pick<NudgeRuns, "nudgeNow" | "reassignTask"> = {
  nudgeNow: async (tenantId, taskId) => {
    nudges.push({ tenantId, taskId });
    return { ok: true, nudges: 1 };
  },
  reassignTask: async (tenantId, taskId, agentId) => {
    reassigns.push({ tenantId, taskId, agentId });
    return { ok: true, threadRef: `thread-${agentId}`, started: true };
  },
};

/** 测试的「现在」：2026-11-16（周一）14:00 上海时间。 */
const NOW = new Date("2026-11-16T06:00:00.000Z");
const decisions = createWechatDecisions({
  database,
  wechat: wechatStore,
  approvals: approvalService,
  deliveries: deliveryStore,
  delivery,
  turns,
  rounds,
  bots: profileStore,
  actorFor,
  timeZone: () => ZONE,
  appUrl: APP,
  now: () => NOW,
});

type Sent = { userId: string; text: string };
const sent: Sent[] = [];
/** 入站分流的时钟（选人提示、审批提示过期）；过期测试把它往后拨。 */
let clock = () => new Date();
const inbound = createWechatInbound({
  wechat: wechatStore,
  deliveries: deliveryStore,
  router,
  channels: channelStore,
  bots: profileStore,
  actorFor,
  scopeFor: scopes.scopeFor,
  send: async (account, input) => {
    sent.push({ userId: account.userId, text: input.text });
  },
  prompts: decisions.handlers,
  approvalPrompts: decisions.openApprovalPrompts,
  now: () => clock(),
});

type Person = { userId: string; account: WechatAccount; ilinkUserId: string };
async function person(name: string, displayName?: string): Promise<Person> {
  const userId = `${prefix}-${name}`;
  people.push(userId);
  await runAsTenant(userId, () =>
    database.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      ...(displayName ? { name: displayName } : {}),
    }),
  );
  const ilinkUserId = `${prefix}-wx-${name}@im.wechat`;
  const account = await runAsTenant(userId, () =>
    wechatStore.saveAccount({
      userId,
      ilinkBotId: `${prefix}-bot-${name}@im.bot`,
      ilinkUserId,
      baseUrl: "https://ilinkai.weixin.qq.com",
      credentialId: null,
    }),
  );
  return { userId, account, ilinkUserId };
}

async function bot(owner: Person, name: string) {
  const profile = await runAsTenant(owner.userId, () =>
    profileStore.create(
      { id: owner.userId, role: "user" },
      {
        name,
        title: "工程师",
        roleDescription: "简短回答。",
        visibility: "private",
      },
    ),
  );
  madeAgents.push(profile.id);
  return profile.id;
}

const ASK: ApprovalPolicyOutcome = {
  behaviour: "ask",
  source: "default",
} as ApprovalPolicyOutcome;
/** 删除类底线：只给「批准一次 / 拒绝」。 */
const FLOOR: ApprovalPolicyOutcome = {
  behaviour: "ask",
  source: "destructive_tool",
} as ApprovalPolicyOutcome;

/** 一条等这个人批的请求：员工 `botId` 想删 ~/build。 */
async function approval(
  who: Person,
  botId: string,
  policy: ApprovalPolicyOutcome = ASK,
  threadId = `${prefix}-thread-${randomUUID()}`,
): Promise<ApprovalRecord> {
  const args = { path: "~/build" };
  const candidate: ApprovalCandidate = {
    actorId: who.userId,
    botId,
    toolRef: "files/delete",
    effect: "write",
    scope: "~/build",
    args,
    continuation: {
      runId: randomUUID(),
      threadId,
      toolCallId: randomUUID(),
      toolName: "files__delete",
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
  const record = await runAsTenant(who.userId, () =>
    approvalStore.open({ ...approvalAction(candidate), policy }),
  );
  approvalIds.push(record.id);
  return record;
}

const approvalOf = (who: Person, id: string) =>
  runAsTenant(who.userId, () => approvalStore.get(who.userId, id));

type CardInput = Partial<typeof tasks.$inferInsert>;
/** 一件在跟的活，`agentId` 已接下，一小时前就该交。 */
async function card(who: Person, agentId: string, input: CardInput = {}) {
  const threadRef = `${prefix}-card-${randomUUID()}`;
  const due = new Date(NOW.getTime() - 60 * 60_000);
  const [row] = await runAsTenant(who.userId, () =>
    database
      .insert(tasks)
      .values({
        title: "核对本周发票",
        executorAgentId: agentId,
        source: "chat",
        status: "running",
        tracked: true,
        threadRef,
        channelRef: threadRef,
        acceptedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
        dueAt: due,
        originalDueAt: due,
        dueReported: true,
        ...input,
      })
      .returning({ id: tasks.id }),
  );
  if (!row) throw new Error("no card");
  return { taskId: row.id, threadRef };
}
const cardRow = (who: Person, taskId: string) =>
  runAsTenant(who.userId, async () => {
    const [found] = await database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, who.userId), eq(tasks.id, taskId)));
    return found;
  });
const history = (who: Person, taskId: string) =>
  runAsTenant(who.userId, () =>
    listTaskEvents(database, { tenantId: who.userId, taskId }),
  );

let seq = 0;
const nextId = () => `86279687568141${String(10000 + ++seq)}`;
function message(who: Person, text: string): IlinkMessage {
  const id = nextId();
  return {
    id,
    fromUserId: who.ilinkUserId,
    text,
    contextToken: `ctx-${id}`,
    groupId: null,
  };
}
async function deliver(who: Person, text: string) {
  await runAsTenant(who.userId, async () => {
    const m = message(who, text);
    await wechatStore.markInbound(who.account.id, {
      at: new Date(),
      contextToken: m.contextToken,
    });
    await inbound(who.account, m);
  });
}
const lastSent = (who: Person) =>
  sent.filter((s) => s.userId === who.userId).at(-1)?.text ?? "";
const sentTo = (who: Person) =>
  sent.filter((s) => s.userId === who.userId).map((s) => s.text);
const openPrompts = (who: Person) =>
  runAsTenant(who.userId, () => wechatStore.openPrompts(who.userId));
const asPerson = <T>(who: Person, work: () => Promise<T>) =>
  runAsTenant(who.userId, work);

afterAll(async () => {
  await runAsTenant("platform", async () => {
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

describe("readLaterTime：延期的时间按这个人的时区读", () => {
  const at = (text: string, zone = ZONE) => readLaterTime(text, NOW, zone).at;

  test("常用说法", () => {
    expect(at("明早10点")?.toISOString()).toBe("2026-11-17T02:00:00.000Z");
    expect(at("明天下午3点")?.toISOString()).toBe("2026-11-17T07:00:00.000Z");
    expect(at("今晚8点")?.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(at("2小时后")?.toISOString()).toBe("2026-11-16T08:00:00.000Z");
    expect(at("到明早10点")?.toISOString()).toBe("2026-11-17T02:00:00.000Z");
  });

  test("星期几：没说几点按当天 18:00；今天已过的点算下周", () => {
    expect(at("周五")?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(at("星期五上午10点")?.toISOString()).toBe(
      "2026-11-20T02:00:00.000Z",
    );
    expect(at("下周一")?.toISOString()).toBe("2026-11-23T10:00:00.000Z");
    // 今天就是周一，18:00 还没到。
    expect(at("周一")?.toISOString()).toBe("2026-11-16T10:00:00.000Z");
    // 今天上午 9 点已过：下周一。
    expect(at("周一上午9点")?.toISOString()).toBe("2026-11-23T01:00:00.000Z");
    expect(at("周日")?.toISOString()).toBe("2026-11-22T10:00:00.000Z");
  });

  test("星期几只写了几点：1–7 点按下午；没说几点用本人的收工时间", () => {
    expect(at("周五3点")?.toISOString()).toBe("2026-11-20T07:00:00.000Z");
    expect(at("周五3点半")?.toISOString()).toBe("2026-11-20T07:30:00.000Z");
    expect(at("周五9点")?.toISOString()).toBe("2026-11-20T01:00:00.000Z");
    expect(at("周五上午3点")?.toISOString()).toBe("2026-11-19T19:00:00.000Z");
    expect(
      readLaterTime("周五", NOW, ZONE, {
        endOfDay: "17:30",
      }).at?.toISOString(),
    ).toBe("2026-11-20T09:30:00.000Z");
  });

  test("按这个人的时区", () => {
    expect(at("明早10点", "America/New_York")?.toISOString()).toBe(
      "2026-11-17T15:00:00.000Z",
    );
  });

  test("读不出、已经过了：不给时间", () => {
    expect(readLaterTime("看情况", NOW, ZONE)).toEqual({
      at: null,
      why: "unreadable",
    });
    expect(readLaterTime("", NOW, ZONE).at).toBeNull();
    expect(readLaterTime("本周日上午", NOW, ZONE).at).toBeNull();
    expect(readLaterTime("今天上午9点", NOW, ZONE)).toEqual({
      at: null,
      why: "past",
    });
  });
});

describe("提示文字", () => {
  const record = {
    id: "ap-1",
    action: {
      toolRef: "files/delete",
      scope: "~/build",
      effect: "write",
      policy: ASK,
    },
  } as unknown as ApprovalRecord;
  const phrase = approvalPhrase(record.action);

  test("审批：三个选项、会话名、详情链接", () => {
    expect(
      approvalText({ code: "A1" }, record, "代码熊", {
        conversation: "修复构建",
        link: `${APP}/approvals?id=ap-1`,
      }),
    ).toBe(
      `【代码熊】想要 ${phrase}（在「修复构建」里）。回复 1 批准一次，2 拒绝，3 这次对话里都允许；详情：${APP}/approvals?id=ap-1`,
    );
  });

  test("底线类不出现「3」；多条待处理时带编号", () => {
    const floor = {
      ...record,
      action: { ...record.action, policy: FLOOR },
    } as ApprovalRecord;
    const text = approvalText({ code: "A2" }, floor, "代码熊", {
      numbered: true,
    });
    expect(text).toBe(
      `A2 【代码熊】想要 ${phrase}。回复 A2 1 批准一次，A2 2 拒绝`,
    );
    expect(text).not.toContain("3");
  });

  test("交付待验收、逾期", () => {
    const work = {
      id: "t-1",
      title: "核对本周发票",
      dueAt: new Date("2026-11-16T05:00:00.000Z"),
    };
    expect(
      handinText({ code: "A3" }, work, "代码熊", { link: `${APP}/tasks/t-1` }),
    ).toBe(
      `【代码熊】交了「核对本周发票」，等你验收。回复 验收，或 退回 原因；详情：${APP}/tasks/t-1`,
    );
    expect(
      overdueText({ code: "A4" }, work, "代码熊", {
        numbered: true,
        now: NOW,
        timeZone: ZONE,
      }),
    ).toBe(
      "A4 【代码熊】的「核对本周发票」逾期了（原定 13:00）。回复 A4 再催 / A4 延期 明早10点 / A4 换人 / A4 取消",
    );
  });
});

describe("审批：回数字拍板", () => {
  test("只有一条待处理：回「1」批准一次，提示关闭，不交给员工", async () => {
    const a = await person("a1");
    const coder = await bot(a, "代码熊");
    const request = await approval(a, coder);
    const opened = await asPerson(a, () =>
      decisions.openApprovalPrompt(a.userId, request.id),
    );
    expect(opened?.text).toContain("【代码熊】想要");
    expect(opened?.text).toContain(
      "回复 1 批准一次，2 拒绝，3 这次对话里都允许",
    );
    expect(opened?.text).toContain(`详情：${APP}/approvals?id=${request.id}`);
    expect((await openPrompts(a)).map((p) => p.kind)).toEqual(["approval"]);

    await deliver(a, "1");
    const after = await approvalOf(a, request.id);
    expect(after.status).toBe("approved");
    expect(after.decision).toBe("allow_once");
    expect(lastSent(a)).toBe("已批准这一次，【代码熊】会继续。");
    expect(await openPrompts(a)).toEqual([]);
    expect(turnLog.filter((t) => t.ownerUserId === a.userId)).toEqual([]);
  });

  test("同一条审批再开一次：不重复开提示", async () => {
    const a = await person("a2");
    const coder = await bot(a, "代码熊");
    const request = await approval(a, coder);
    const first = await asPerson(a, () =>
      decisions.openApprovalPrompt(a.userId, request.id),
    );
    const again = await asPerson(a, () =>
      decisions.openApprovalPrompt(a.userId, request.id),
    );
    expect(again?.code).toBe(first?.code as string);
    expect((await openPrompts(a)).length).toBe(1);
  });

  test("回「3」：这次对话里都允许", async () => {
    const a = await person("a3");
    const coder = await bot(a, "代码熊");
    const request = await approval(a, coder);
    await asPerson(a, () => decisions.openApprovalPrompt(a.userId, request.id));
    await deliver(a, "3");
    expect((await approvalOf(a, request.id)).decision).toBe(
      "allow_conversation",
    );
    expect(lastSent(a)).toBe("已在这次对话里都允许，【代码熊】会继续。");
  });

  test("两条待处理：回「A2 2」只拒第二条；第二条的文字带编号", async () => {
    const b = await person("b1");
    const coder = await bot(b, "代码熊");
    const one = await approval(b, coder);
    const two = await approval(b, coder);
    const texts = await asPerson(b, () =>
      decisions.openApprovalPrompts(b.userId, [one.id, two.id]),
    );
    const [p1, p2] = await openPrompts(b);
    expect(texts[1]?.startsWith(`${p2?.code} 【代码熊】`)).toBe(true);
    expect(texts[1]).toContain(`回复 ${p2?.code} 1 批准一次`);

    await deliver(b, `${p2?.code} 2`);
    expect((await approvalOf(b, two.id)).status).toBe("denied");
    expect((await approvalOf(b, one.id)).status).toBe("pending");
    expect(lastSent(b)).toBe(
      `已拒绝。【代码熊】不会${afterChinese(approvalPhrase(two.action))}。`,
    );
    expect((await openPrompts(b)).map((p) => p.code)).toEqual([
      p1?.code as string,
    ]);
  });

  test("两条待处理只回「1」：要求带编号并列出各条，什么都不批", async () => {
    const c = await person("c1");
    const coder = await bot(c, "代码熊");
    const one = await approval(c, coder);
    const two = await approval(c, coder);
    await asPerson(c, () =>
      decisions.openApprovalPrompts(c.userId, [one.id, two.id]),
    );
    const [p1, p2] = await openPrompts(c);
    await deliver(c, "1");
    const reply = lastSent(c);
    expect(reply.startsWith("有几条待处理，请带编号回复，例如 ")).toBe(true);
    expect(reply).toContain(`${p1?.code} 审批：【代码熊】想要`);
    expect(reply).toContain(`${p2?.code} 审批：【代码熊】想要`);
    expect((await approvalOf(c, one.id)).status).toBe("pending");
    expect((await approvalOf(c, two.id)).status).toBe("pending");
  });

  test("没有待处理时回「1」：原样交给员工", async () => {
    const d = await person("d1");
    const coder = await bot(d, "代码熊");
    await asPerson(d, () => wechatStore.setLastAgent(d.account.id, coder));
    await deliver(d, "1");
    expect(turnLog.filter((t) => t.ownerUserId === d.userId)).toEqual([
      { ownerUserId: d.userId, agentId: coder, text: "1" },
    ]);
    expect(lastSent(d)).toBe("【代码熊】收到：1");
  });

  test("底线类回「3」：不放行，说明只能批准一次或拒绝，提示还开着", async () => {
    const e = await person("e1");
    const coder = await bot(e, "代码熊");
    const request = await approval(e, coder, FLOOR);
    const opened = await asPerson(e, () =>
      decisions.openApprovalPrompt(e.userId, request.id),
    );
    expect(opened?.text).toContain("回复 1 批准一次，2 拒绝");
    expect(opened?.text).not.toContain("3 这次对话里都允许");
    await deliver(e, "3");
    expect(lastSent(e)).toContain("这条只能批准一次或拒绝");
    expect((await approvalOf(e, request.id)).status).toBe("pending");
    expect((await openPrompts(e)).length).toBe(1);
    await deliver(e, "1");
    expect((await approvalOf(e, request.id)).decision).toBe("allow_once");
  });

  test("网页上先拒绝了，再回「1」：答已由某某在网页处理，不改状态", async () => {
    const f = await person("f1", "小熊");
    const coder = await bot(f, "代码熊");
    const request = await approval(f, coder);
    await asPerson(f, () => decisions.openApprovalPrompt(f.userId, request.id));
    await asPerson(f, () =>
      approvalService.decide(f.userId, request.id, "deny", "wechat"),
    );
    await deliver(f, "1");
    expect(lastSent(f)).toBe("这条已由 小熊 在 网页 处理");
    expect((await approvalOf(f, request.id)).status).toBe("denied");
    expect(await openPrompts(f)).toEqual([]);
  });

  test("网页先批了、提示还开着，只有这一条时回「1」：答已处理，提示关掉，不交给员工", async () => {
    const f = await person("f2");
    const coder = await bot(f, "代码熊");
    await asPerson(f, () => wechatStore.setLastAgent(f.account.id, coder));
    const request = await approval(f, coder);
    await asPerson(f, () => decisions.openApprovalPrompt(f.userId, request.id));
    await asPerson(f, () =>
      approvalService.decide(f.userId, request.id, "allow_once", "wechat"),
    );
    const before = sentTo(f).length;
    await deliver(f, "1");
    expect(turnLog.filter((t) => t.ownerUserId === f.userId)).toEqual([]);
    expect(sentTo(f).slice(before)).toEqual(["这条已由 你 在 网页 处理"]);
    expect((await approvalOf(f, request.id)).decision).toBe("allow_once");
    expect(await openPrompts(f)).toEqual([]);
    // 提示关了以后再回「1」：交给员工。
    await deliver(f, "1");
    expect(turnLog.filter((t) => t.ownerUserId === f.userId)).toEqual([
      { ownerUserId: f.userId, agentId: coder, text: "1" },
    ]);
  });

  test("网页先批了、带编号回「A? 1」：同样答已处理", async () => {
    const f = await person("f2b", "小熊");
    const coder = await bot(f, "代码熊");
    const request = await approval(f, coder);
    const opened = await asPerson(f, () =>
      decisions.openApprovalPrompt(f.userId, request.id),
    );
    await asPerson(f, () =>
      approvalService.decide(f.userId, request.id, "deny", "wechat"),
    );
    await deliver(f, `${opened?.code} 1`);
    expect(lastSent(f)).toBe("这条已由 小熊 在 网页 处理");
    expect(await openPrompts(f)).toEqual([]);
  });

  test("带编号回一条开过 24 小时、审批仍在等的：答已过期，提示关掉，不交给员工", async () => {
    const f = await person("f2c");
    const coder = await bot(f, "代码熊");
    await asPerson(f, () => wechatStore.setLastAgent(f.account.id, coder));
    const request = await approval(f, coder);
    const opened = await asPerson(f, () =>
      decisions.openApprovalPrompt(f.userId, request.id),
    );
    clock = () => new Date(Date.now() + 25 * 60 * 60_000);
    try {
      await deliver(f, `${opened?.code} 1`);
    } finally {
      clock = () => new Date();
    }
    expect(lastSent(f)).toBe("这条已过期，请到熊宝里处理");
    expect(turnLog.filter((t) => t.ownerUserId === f.userId)).toEqual([]);
    expect((await approvalOf(f, request.id)).status).toBe("pending");
    expect(await openPrompts(f)).toEqual([]);
  });

  test("两条中一条已在网页处理，回「1」：直接对剩下那条生效，不要求带编号", async () => {
    const f = await person("f3");
    const coder = await bot(f, "代码熊");
    const one = await approval(f, coder);
    const two = await approval(f, coder);
    await asPerson(f, () =>
      decisions.openApprovalPrompts(f.userId, [one.id, two.id]),
    );
    await asPerson(f, () => approvalService.decide(f.userId, one.id, "deny", "wechat"));
    await deliver(f, "1");
    expect((await approvalOf(f, two.id)).decision).toBe("allow_once");
    expect(lastSent(f)).toBe("已批准这一次，【代码熊】会继续。");
    expect(await openPrompts(f)).toEqual([]);
  });

  test("审批提示开着超过 24 小时，回「1」：交给员工，提示关掉，审批不动", async () => {
    const f = await person("f4");
    const coder = await bot(f, "代码熊");
    await asPerson(f, () => wechatStore.setLastAgent(f.account.id, coder));
    const request = await approval(f, coder);
    await asPerson(f, () => decisions.openApprovalPrompt(f.userId, request.id));
    clock = () => new Date(Date.now() + 25 * 60 * 60_000);
    try {
      await deliver(f, "1");
    } finally {
      clock = () => new Date();
    }
    expect(turnLog.filter((t) => t.ownerUserId === f.userId)).toEqual([
      { ownerUserId: f.userId, agentId: coder, text: "1" },
    ]);
    expect((await approvalOf(f, request.id)).status).toBe("pending");
    expect(await openPrompts(f)).toEqual([]);
  });

  test("开新提示前先对账：已在网页处理的那条关掉，新请求不带编号", async () => {
    const f = await person("f5");
    const coder = await bot(f, "代码熊");
    const one = await approval(f, coder);
    await asPerson(f, () => decisions.openApprovalPrompt(f.userId, one.id));
    await asPerson(f, () => approvalService.decide(f.userId, one.id, "deny", "wechat"));
    const two = await approval(f, coder);
    const opened = await asPerson(f, () =>
      decisions.openApprovalPrompt(f.userId, two.id),
    );
    expect(opened?.text.startsWith("【代码熊】想要")).toBe(true);
    expect((await openPrompts(f)).map((p) => p.refId)).toEqual([two.id]);
  });

  test("同一条审批同时开两次：只开出一条提示", async () => {
    const f = await person("f6");
    const coder = await bot(f, "代码熊");
    const request = await approval(f, coder);
    const [x, y] = await Promise.all([
      asPerson(f, () => decisions.openApprovalPrompt(f.userId, request.id)),
      asPerson(f, () => decisions.openApprovalPrompt(f.userId, request.id)),
    ]);
    expect(x?.code).toBe(y?.code as string);
    expect((await openPrompts(f)).length).toBe(1);
    const again = await asPerson(f, () =>
      wechatStore.openPrompt(f.userId, "approval", request.id),
    );
    expect(again.code).toBe(x?.code as string);
  });

  test("审批服务不让、原因没有中文：用中文兜底", async () => {
    const f = await person("f7");
    const coder = await bot(f, "代码熊");
    const request = await approval(f, coder);
    const refusing = createWechatDecisions({
      database,
      wechat: wechatStore,
      approvals: {
        store: approvalStore,
        decide: async () => {
          throw new ApprovalRefusedError("Choose allow once or deny.");
        },
      },
      deliveries: deliveryStore,
      delivery,
      bots: profileStore,
      actorFor,
    });
    const opened = await asPerson(f, () =>
      refusing.openApprovalPrompt(f.userId, request.id),
    );
    const [prompt] = await openPrompts(f);
    const replies: string[] = [];
    await asPerson(f, () =>
      refusing.handlers.approval.handle(
        {
          account: f.account,
          message: message(f, "1"),
          actor: { id: f.userId, role: "user" },
          open: prompt ? [prompt] : [],
          reply: async (text) => {
            replies.push(text);
          },
          turn: async () => {},
        },
        prompt as NonNullable<typeof prompt>,
        "1",
      ),
    );
    expect(opened).not.toBeNull();
    expect(replies).toEqual(["没有办成，请到熊宝里看看"]);
    expect((await approvalOf(f, request.id)).status).toBe("pending");
  });

  test("会话有名字：文字里说在哪段对话", async () => {
    const g = await person("g1");
    const coder = await bot(g, "代码熊");
    const direct = await asPerson(g, async () =>
      channelStore.direct(await actorFor(g.userId), coder),
    );
    await asPerson(g, () =>
      database
        .update(channels)
        .set({ title: "修复构建" })
        .where(eq(channels.id, direct.id)),
    );
    const request = await approval(g, coder, ASK, direct.threadId);
    const opened = await asPerson(g, () =>
      decisions.openApprovalPrompt(g.userId, request.id),
    );
    expect(opened?.text).toContain("（在「修复构建」里）");
  });

  test("微信里开的那一轮停下来等审批：回复后跟一条带数字的请求，回「1」批准", async () => {
    const h = await person("h1");
    const coder = await bot(h, "代码熊");
    const request = await approval(h, coder);
    runTurn = async () => {
      throw Object.assign(new Error("waiting"), {
        name: "HeadlessToolSuspension",
        waiting: { kind: "approval", approvalId: request.id },
      });
    };
    try {
      await deliver(h, "@代码熊 清一下构建目录");
    } finally {
      runTurn = async (input) => ({ replyText: `收到：${input.text}` });
    }
    const replies = sentTo(h);
    expect(replies.at(-1)).toContain("【代码熊】想要");
    expect(replies.at(-1)).toContain("回复 1 批准一次");
    expect(replies.join("\n")).not.toContain("请到熊宝里处理");
    expect((await openPrompts(h)).map((p) => p.kind)).toEqual(["approval"]);
    await deliver(h, "1");
    expect((await approvalOf(h, request.id)).status).toBe("approved");
  });
});

describe("交付闭环：验收、退回、再催、延期、换人、取消", () => {
  test("交付卡回「退回 缺 C 家发票」：卡片回到进行中，流水有退回，原因在卡片对话里说出", async () => {
    const p = await person("p1");
    const coder = await bot(p, "代码熊");
    const { taskId, threadRef } = await card(p, coder, {
      status: "awaiting_review",
    });
    const opened = await asPerson(p, () =>
      decisions.openHandinPrompt(p.userId, taskId),
    );
    expect(opened?.text).toContain("回复 验收，或 退回 原因");
    expect(opened?.text).toContain(`${APP}/tasks/${taskId}`);

    await deliver(p, "退回 缺 C 家发票");
    const after = await cardRow(p, taskId);
    expect(after?.status).toBe("running");
    expect(after?.returns).toBe(1);
    expect((await history(p, taskId)).map((e) => e.kind)).toContain("returned");
    expect(said.filter((s) => s.threadId === threadRef)).toEqual([
      { tenantId: p.userId, threadId: threadRef, text: "退回：缺 C 家发票" },
    ]);
    expect(lastSent(p)).toBe("已退回给【代码熊】：缺 C 家发票");
    expect(await openPrompts(p)).toEqual([]);
  });

  test("「退回」不写原因：请写原因，卡片不动", async () => {
    const p = await person("p2");
    const coder = await bot(p, "代码熊");
    const { taskId } = await card(p, coder, { status: "awaiting_review" });
    await asPerson(p, () => decisions.openHandinPrompt(p.userId, taskId));
    await deliver(p, "退回");
    expect(lastSent(p)).toContain("退回要写原因");
    expect((await cardRow(p, taskId))?.status).toBe("awaiting_review");
    expect((await openPrompts(p)).length).toBe(1);
  });

  test("交付卡回「验收」：卡片完成", async () => {
    const p = await person("p3");
    const coder = await bot(p, "代码熊");
    const { taskId } = await card(p, coder, { status: "awaiting_review" });
    await asPerson(p, () => decisions.openHandinPrompt(p.userId, taskId));
    await deliver(p, "验收");
    expect((await cardRow(p, taskId))?.status).toBe("done");
    expect(lastSent(p)).toBe("已验收「核对本周发票」。");
    expect(await openPrompts(p)).toEqual([]);
  });

  test("逾期卡回「延期 明早10点」：预计时间改成明早 10 点（按这个人的时区），流水记一条", async () => {
    const q = await person("q1");
    const coder = await bot(q, "代码熊");
    const { taskId } = await card(q, coder);
    const opened = await asPerson(q, () =>
      decisions.openOverduePrompt(q.userId, taskId),
    );
    expect(opened?.text).toContain("回复 再催 / 延期 明早10点 / 换人 / 取消");
    const before = (await history(q, taskId)).length;
    await deliver(q, "延期 明早10点");
    const after = await cardRow(q, taskId);
    expect(after?.dueAt?.toISOString()).toBe("2026-11-17T02:00:00.000Z");
    expect((await history(q, taskId)).length).toBe(before + 1);
    expect(lastSent(q)).toBe("好的，「核对本周发票」延期到 11月17日 10:00。");
    expect(await openPrompts(q)).toEqual([]);
  });

  test("有待答复的延期申请时回「延期 明早10点」：准许那条申请，流水记 extension_granted，卡片对话里说一声", async () => {
    const q = await person("q3");
    const coder = await bot(q, "代码熊");
    const { taskId, threadRef } = await card(q, coder);
    await asPerson(q, () =>
      delivery.requestExtension(q.userId, taskId, {
        dueAt: new Date(NOW.getTime() + 3 * 60 * 60_000),
        reason: "供应商还没回",
      }),
    );
    await asPerson(q, () => decisions.openOverduePrompt(q.userId, taskId));
    await deliver(q, "延期 明早10点");
    expect((await cardRow(q, taskId))?.dueAt?.toISOString()).toBe(
      "2026-11-17T02:00:00.000Z",
    );
    const kinds = (await history(q, taskId)).map((e) => e.kind);
    expect(kinds).toContain("extension_granted");
    expect(kinds).not.toContain("edited");
    expect(notices.filter((n) => n.threadId === threadRef)).toEqual([
      { threadId: threadRef, text: "准许延期到 11月17日 10:00" },
    ]);
    expect(await openPrompts(q)).toEqual([]);
  });

  test("逾期卡的预计时间已在网页上改到以后：回「再催」答已处理，不催", async () => {
    const q = await person("q4");
    const coder = await bot(q, "代码熊");
    const { taskId } = await card(q, coder);
    await asPerson(q, () => decisions.openOverduePrompt(q.userId, taskId));
    await asPerson(q, () =>
      database
        .update(tasks)
        .set({ dueAt: new Date(Date.now() + 24 * 60 * 60_000) })
        .where(eq(tasks.id, taskId)),
    );
    await deliver(q, "再催");
    expect(lastSent(q)).toBe("这条已由 你 在 网页 处理");
    expect(nudges.filter((n) => n.tenantId === q.userId)).toEqual([]);
    expect(await openPrompts(q)).toEqual([]);
  });

  test("「延期」的时间读不出：给示例，不改任何东西", async () => {
    const q = await person("q2");
    const coder = await bot(q, "代码熊");
    const { taskId } = await card(q, coder);
    const due = (await cardRow(q, taskId))?.dueAt?.toISOString();
    await asPerson(q, () => decisions.openOverduePrompt(q.userId, taskId));
    await deliver(q, "延期 看情况");
    expect(lastSent(q)).toContain("延期 明早10点");
    expect((await cardRow(q, taskId))?.dueAt?.toISOString()).toBe(
      due as string,
    );
    expect((await openPrompts(q)).length).toBe(1);
  });

  test("逾期卡回「再催」：催员工一次", async () => {
    const r = await person("r1");
    const coder = await bot(r, "代码熊");
    const { taskId } = await card(r, coder);
    await asPerson(r, () => decisions.openOverduePrompt(r.userId, taskId));
    await deliver(r, "再催");
    expect(nudges).toContainEqual({ tenantId: r.userId, taskId });
    expect(lastSent(r)).toBe("已催【代码熊】。");
    expect(await openPrompts(r)).toEqual([]);
  });

  test("逾期卡回「换人」：先问换给谁；「换人 写作熊」换给写作熊", async () => {
    const s = await person("s1");
    const coder = await bot(s, "代码熊");
    const writer = await bot(s, "写作熊");
    const { taskId } = await card(s, coder);
    await asPerson(s, () => decisions.openOverduePrompt(s.userId, taskId));
    await deliver(s, "换人");
    expect(lastSent(s)).toContain("换人 员工名");
    expect(lastSent(s)).toContain("写作熊");
    expect(lastSent(s)).not.toContain("代码熊");
    expect(reassigns.filter((x) => x.tenantId === s.userId)).toEqual([]);

    await deliver(s, "换人 写作熊");
    expect(reassigns.filter((x) => x.tenantId === s.userId)).toEqual([
      { tenantId: s.userId, taskId, agentId: writer },
    ]);
    expect(lastSent(s)).toBe("已换给【写作熊】，等它接下。");
    expect(await openPrompts(s)).toEqual([]);
  });

  test("逾期卡回「取消」：卡片取消", async () => {
    const t = await person("t1");
    const coder = await bot(t, "代码熊");
    const { taskId } = await card(t, coder);
    await asPerson(t, () => decisions.openOverduePrompt(t.userId, taskId));
    await deliver(t, "取消");
    expect((await cardRow(t, taskId))?.status).toBe("cancelled");
    expect((await history(t, taskId)).map((e) => e.kind)).toContain(
      "cancelled",
    );
    expect(lastSent(t)).toBe("已取消「核对本周发票」。");
    expect(await openPrompts(t)).toEqual([]);
  });

  test("交付卡和逾期卡同时开着：「验收」要带编号，带了就只对那一张", async () => {
    const u = await person("u1");
    const coder = await bot(u, "代码熊");
    const handed = await card(u, coder, { status: "awaiting_review" });
    const late = await card(u, coder);
    const h = await asPerson(u, () =>
      decisions.openHandinPrompt(u.userId, handed.taskId),
    );
    const o = await asPerson(u, () =>
      decisions.openOverduePrompt(u.userId, late.taskId),
    );
    expect(o?.text.startsWith(`${o?.code} `)).toBe(true);
    await deliver(u, "验收");
    expect(lastSent(u)).toContain("请带编号回复");
    expect((await cardRow(u, handed.taskId))?.status).toBe("awaiting_review");
    await deliver(u, `${h?.code} 验收`);
    expect((await cardRow(u, handed.taskId))?.status).toBe("done");
    expect((await cardRow(u, late.taskId))?.status).toBe("running");
  });
});

describe("选人提示带编号", () => {
  test("名单里显示提示编号「A?：回复数字选员工」", async () => {
    const v = await person("v1");
    await bot(v, "甲熊");
    await bot(v, "乙熊");
    await deliver(v, "帮我订个会议室");
    const [pick] = await openPrompts(v);
    expect(pick?.kind).toBe("pick_agent");
    expect(lastSent(v)).toContain(`${pick?.code}：回复数字选员工`);
  });
});

describe("审批记下在哪决定的（Task 11）", () => {
  test("在微信里回「1」批准：审批记 decided_via = wechat", async () => {
    const w = await person("w11a");
    const coder = await bot(w, "代码熊");
    const request = await approval(w, coder);
    await asPerson(w, () => decisions.openApprovalPrompt(w.userId, request.id));
    await deliver(w, "1");
    expect(await approvalOf(w, request.id)).toMatchObject({
      decision: "allow_once",
      decidedVia: "wechat",
    });
  });

  test("在 Slack 上先批了，再在微信回「1」：答「这条已由 某某 在 Slack 处理」", async () => {
    const w = await person("w11b", "小熊");
    const coder = await bot(w, "代码熊");
    const request = await approval(w, coder);
    await asPerson(w, () => decisions.openApprovalPrompt(w.userId, request.id));
    await asPerson(w, () =>
      approvalService.decide(w.userId, request.id, "allow_once", "slack"),
    );
    await deliver(w, "1");
    expect(lastSent(w)).toBe("这条已由 小熊 在 Slack 处理");
    expect((await approvalOf(w, request.id)).decidedVia).toBe("slack");
    expect(await openPrompts(w)).toEqual([]);
  });

  test("带编号回一条在 Teams 上拒绝了的：答「在 Teams 处理」", async () => {
    const w = await person("w11c", "小熊");
    const coder = await bot(w, "代码熊");
    const request = await approval(w, coder);
    const opened = await asPerson(w, () =>
      decisions.openApprovalPrompt(w.userId, request.id),
    );
    await asPerson(w, () =>
      approvalService.decide(w.userId, request.id, "deny", "teams"),
    );
    await deliver(w, `${opened?.code} 1`);
    expect(lastSent(w)).toBe("这条已由 小熊 在 Teams 处理");
  });

  test("审批服务刚好在同一时刻被别处决定（处理器里读到已不在等）：照实说那个渠道", async () => {
    const w = await person("w11d", "小熊");
    const coder = await bot(w, "代码熊");
    const request = await approval(w, coder);
    const opened = await asPerson(w, () =>
      decisions.openApprovalPrompt(w.userId, request.id),
    );
    const prompt = (await openPrompts(w))[0];
    if (!opened || !prompt) throw new Error("no prompt");
    await asPerson(w, () =>
      approvalService.decide(w.userId, request.id, "deny", "wechat"),
    );
    const replies: string[] = [];
    await asPerson(w, () =>
      decisions.handlers.approval.handle(
        {
          account: w.account,
          open: [prompt],
          reply: async (text: string) => {
            replies.push(text);
          },
        } as never,
        prompt,
        "1",
      ),
    );
    expect(replies).toEqual(["这条已由 小熊 在 微信 处理"]);
  });

  test("旧数据没记渠道（null）、网页上决定的：都答「在 网页 处理」", async () => {
    const w = await person("w11e", "小熊");
    const coder = await bot(w, "代码熊");
    const old = await approval(w, coder);
    await asPerson(w, () => decisions.openApprovalPrompt(w.userId, old.id));
    await asPerson(w, () =>
      approvalService.decide(w.userId, old.id, "deny", "slack"),
    );
    await asPerson(w, async () => {
      await database.execute(
        sql`update ${approvalRequests} set "decided_via" = null where ${approvalRequests.id} = ${old.id}`,
      );
    });
    await deliver(w, "1");
    expect(lastSent(w)).toBe("这条已由 小熊 在 网页 处理");

    const web = await approval(w, coder);
    await asPerson(w, () => decisions.openApprovalPrompt(w.userId, web.id));
    await asPerson(w, () =>
      approvalService.decide(w.userId, web.id, "deny", "web"),
    );
    await deliver(w, "1");
    expect(lastSent(w)).toBe("这条已由 小熊 在 网页 处理");
  });
});
