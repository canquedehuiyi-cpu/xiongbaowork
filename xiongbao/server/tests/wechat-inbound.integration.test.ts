import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createCredentialStore, sealCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  credentials,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { deliveryBindings, deliveryInbox } from "../src/db/schema/delivery";
import {
  type WechatAccount,
  type WechatPrompt,
  wechatAccounts,
} from "../src/db/schema/wechat";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryScopes } from "../src/delivery/scope";
import { createDeliveryStore } from "../src/delivery/store";
import type { DeliveryScope } from "../src/delivery/types";
import type { IlinkMessage } from "../src/delivery/wechat/ilink";
import { IlinkWindowClosedError } from "../src/delivery/wechat/ilink";
import {
  createWechatInbound,
  createWechatSender,
  splitWechatText,
  WECHAT_TEXT_LIMIT,
  WechatReplyUnavailableError,
} from "../src/delivery/wechat/inbound";
import { matchPromptReply } from "../src/delivery/wechat/prompts";
import { createWechatStore } from "../src/delivery/wechat/store";
import type { PeopleStore } from "../src/people/store";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 微信入站分流（计划 2026-11-16-im-channels-wechat Task 6）：真的库、真的员工和单聊、真的投递路由和收件箱，
 * 只有两处是假的：员工那一轮（`runTurn`，记下在哪段对话里、说了什么）和发回微信的发送器（收集文本）。
 * 每条消息都在本人的帧里交给 `inbound`，和轮询器一样。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `wxin-${randomUUID().slice(0, 8)}`;
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const deliveryStore = createDeliveryStore(database);
const wechatStore = createWechatStore(database);
const people: string[] = [];
const madeAgents: string[] = [];

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

type Turn = DeliveryScope & { text: string; source: string; tenantId: string };
const turns: Turn[] = [];
/** 每一轮拿到的中止信号（和 `turns` 同序）。 */
const signals: AbortSignal[] = [];
/** `inbound` 的时钟；过期测试把它往后拨。 */
let clock = () => new Date();
/** 员工的回复；测试可以换成很长的一段。 */
let answer = (text: string) => `收到：${text}`;
const router = createDeliveryRouter({
  store: deliveryStore,
  queue: createWorkQueue(database),
  owner: `${prefix}-router`,
  authoriseScope: scopes.authorise,
  scopeFor: scopes.scopeFor,
  providers: {},
  runTurn: async (input) => {
    turns.push({
      ownerUserId: input.ownerUserId,
      channelId: input.channelId,
      agentId: input.agentId,
      threadId: input.threadId,
      text: input.text,
      source: input.source,
      tenantId: input.tenantId,
    });
    signals.push(input.signal);
    return { replyText: answer(input.text) };
  },
});

type Sent = { userId: string; text: string; contextToken: string | null };
const sent: Sent[] = [];
let sendFails: Error | null = null;
const inbound = createWechatInbound({
  wechat: wechatStore,
  deliveries: deliveryStore,
  router,
  channels: channelStore,
  bots: profileStore,
  actorFor,
  scopeFor: scopes.scopeFor,
  send: async (account, input) => {
    if (sendFails) throw sendFails;
    sent.push({ userId: account.userId, ...input });
  },
  now: () => clock(),
});

type Person = { userId: string; account: WechatAccount; ilinkUserId: string };
async function person(name: string): Promise<Person> {
  const userId = `${prefix}-${name}`;
  people.push(userId);
  await runAsTenant(userId, () =>
    database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test` }),
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

async function bot(owner: Person, name: string, title = "工程师") {
  const profile = await runAsTenant(owner.userId, () =>
    profileStore.create(
      { id: owner.userId, role: "user" },
      { name, title, roleDescription: "简短回答。", visibility: "private" },
    ),
  );
  madeAgents.push(profile.id);
  return profile.id;
}

let seq = 0;
const nextId = () => `75279687568141${String(10000 + ++seq)}`;
function message(
  who: Person,
  text: string | null,
  id = nextId(),
): IlinkMessage {
  return {
    id,
    fromUserId: who.ilinkUserId,
    text,
    contextToken: `ctx-${id}`,
    groupId: null,
  };
}
/** 像轮询器那样：在本人的帧里，先记入站（存 context_token），再交给 `inbound`。 */
async function deliver(who: Person, m: IlinkMessage) {
  await runAsTenant(who.userId, async () => {
    await wechatStore.markInbound(who.account.id, {
      at: new Date(),
      contextToken: m.contextToken,
    });
    await inbound(who.account, m);
  });
}
const sentTo = (who: Person) => sent.filter((s) => s.userId === who.userId);
const turnsOf = (who: Person) =>
  turns.filter((t) => t.ownerUserId === who.userId);
const accountOf = (who: Person) =>
  runAsTenant(who.userId, () => wechatStore.account(who.userId));
const openPrompts = (who: Person) =>
  runAsTenant(who.userId, () => wechatStore.openPrompts(who.userId));
const directOf = (who: Person, agentId: string) =>
  runAsTenant(who.userId, async () =>
    channelStore.direct(await actorFor(who.userId), agentId),
  );

afterAll(async () => {
  await runAsTenant("platform", async () => {
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
    await database.delete(users).where(inArray(users.id, people));
    await database
      .delete(credentials)
      .where(inArray(credentials.tenantId, people));
  });
  await database.$client.close();
});

describe("splitWechatText", () => {
  test("短的原样一段", () => {
    expect(splitWechatText("你好")).toEqual(["你好"]);
  });

  test("按 2000 字切段，拼回去和原文一样，每段不超过上限", () => {
    const text = "熊".repeat(4500);
    const parts = splitWechatText(text);
    expect(WECHAT_TEXT_LIMIT).toBe(2000);
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe(text);
    for (const part of parts)
      expect(Array.from(part).length).toBeLessThanOrEqual(2000);
  });

  test("按字（码点）数，不把表情切成两半", () => {
    const text = "😀".repeat(2001);
    const parts = splitWechatText(text);
    expect(parts.map((p) => Array.from(p).length)).toEqual([2000, 1]);
    expect(parts.join("")).toBe(text);
  });

  test("段内有换行时尽量在换行处断开", () => {
    const text = `${"甲".repeat(1500)}\n${"乙".repeat(1000)}`;
    const parts = splitWechatText(text);
    expect(parts).toEqual([`${"甲".repeat(1500)}\n`, "乙".repeat(1000)]);
  });
});

describe("matchPromptReply", () => {
  const prompt = (code: string, kind: WechatPrompt["kind"]): WechatPrompt => ({
    id: code,
    tenantId: "t",
    userId: "u",
    code,
    kind,
    refId: "{}",
    state: "open",
    createdAt: new Date(),
  });
  const digits = { pick_agent: (answer: string) => /^\d+$/.test(answer) };

  test("没有开着的提示，或者谁都不认：null", () => {
    expect(matchPromptReply("1", [], digits)).toBeNull();
    expect(
      matchPromptReply("你好", [prompt("A1", "pick_agent")], digits),
    ).toBeNull();
  });

  test("只有一条开着：直接对它生效", () => {
    const a1 = prompt("A1", "pick_agent");
    expect(matchPromptReply(" 2 ", [a1], digits)).toEqual({
      kind: "answer",
      prompt: a1,
      answer: "2",
    });
  });

  test("不止一条：只回数字要求带编号；带编号就是那一条", () => {
    const a1 = prompt("A1", "pick_agent");
    const a2 = prompt("A2", "pick_agent");
    expect(matchPromptReply("1", [a1, a2], digits)).toEqual({
      kind: "ambiguous",
      open: [a1, a2],
    });
    expect(matchPromptReply("a2 1", [a1, a2], digits)).toEqual({
      kind: "answer",
      prompt: a2,
      answer: "1",
    });
    // 编号不在开着的提示里：不算回提示。
    expect(matchPromptReply("A9 1", [a1, a2], digits)).toBeNull();
  });

  test("带编号前缀、但那一条不认这个回答：不算回提示，当普通话往后走", () => {
    const a1 = prompt("A1", "pick_agent");
    expect(matchPromptReply("a1 是什么型号", [a1], digits)).toBeNull();
  });

  test("全角数字和全角编号先规范化：「１」就是「1」", () => {
    const a1 = prompt("A1", "pick_agent");
    const a2 = prompt("A2", "pick_agent");
    expect(matchPromptReply("１", [a1], digits)).toEqual({
      kind: "answer",
      prompt: a1,
      answer: "1",
    });
    expect(matchPromptReply("Ａ２　２", [a1, a2], digits)).toEqual({
      kind: "answer",
      prompt: a2,
      answer: "2",
    });
  });
});

describe("入站分流", () => {
  test("「@代码熊 看下报错」：代码熊的单聊开一轮，回复以【代码熊】开头，带这条消息的 context_token", async () => {
    const a = await person("a");
    const coder = await bot(a, "代码熊");
    await bot(a, "写作熊");
    const m = message(a, "@代码熊 看下报错");
    await deliver(a, m);

    const direct = await directOf(a, coder);
    expect(turnsOf(a)).toEqual([
      {
        ownerUserId: a.userId,
        channelId: direct.id,
        agentId: coder,
        threadId: direct.threadId,
        text: "看下报错",
        source: "wechat",
        tenantId: a.userId,
      },
    ]);
    expect(sentTo(a)).toEqual([
      {
        userId: a.userId,
        text: "【代码熊】收到：看下报错",
        contextToken: m.contextToken,
      },
    ]);
    // 熊宝这边：这条用户消息记在代码熊那段对话的收件箱里，绑定指向同一段对话。
    const inbox = await runAsTenant(a.userId, () =>
      database
        .select()
        .from(deliveryInbox)
        .where(
          and(
            eq(deliveryInbox.source, "wechat"),
            eq(deliveryInbox.externalId, m.id),
          ),
        ),
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      ownerUserId: a.userId,
      channelId: direct.id,
      agentId: coder,
      threadId: direct.threadId,
      realm: a.account.ilinkBotId,
      text: "看下报错",
    });
    const [binding] = await runAsTenant(a.userId, () =>
      database
        .select()
        .from(deliveryBindings)
        .where(eq(deliveryBindings.ownerUserId, a.userId)),
    );
    expect(binding).toMatchObject({
      transport: "wechat",
      realm: a.account.ilinkBotId,
      identity: `${a.ilinkUserId}#${coder}`,
      address: a.ilinkUserId,
      channelId: direct.id,
      agentId: coder,
      enabled: true,
    });
    expect((await accountOf(a))?.lastAgentId).toBe(coder);

    // 不带 @：交给上次的员工。
    await deliver(a, message(a, "再看看日志"));
    expect(turnsOf(a).map((t) => [t.agentId, t.text])).toEqual([
      [coder, "看下报错"],
      [coder, "再看看日志"],
    ]);
    expect(sentTo(a).at(-1)?.text).toBe("【代码熊】收到：再看看日志");
  });

  test("@ 后面不空格也认得出名字；只写「@员工名」就换人，不开一轮", async () => {
    const b = await person("b");
    const coder = await bot(b, "代码熊");
    const writer = await bot(b, "写作熊");
    await deliver(b, message(b, "@代码熊帮我看下"));
    expect(turnsOf(b).map((t) => [t.agentId, t.text])).toEqual([
      [coder, "帮我看下"],
    ]);
    await deliver(b, message(b, "@写作熊"));
    expect(turnsOf(b)).toHaveLength(1);
    expect(sentTo(b).at(-1)?.text).toContain("写作熊");
    expect((await accountOf(b))?.lastAgentId).toBe(writer);
    await deliver(b, message(b, "写个周报"));
    expect(turnsOf(b).at(-1)).toMatchObject({
      agentId: writer,
      text: "写个周报",
    });
  });

  test("第一次用、没写 @：回编号名单「回复数字选员工」，回数字后处理刚才那条", async () => {
    const c = await person("c");
    const first = await bot(c, "甲熊");
    const second = await bot(c, "乙熊");
    await deliver(c, message(c, "帮我订个会议室"));
    expect(turnsOf(c)).toHaveLength(0);
    const list = sentTo(c).at(-1)?.text ?? "";
    expect(list).toContain("回复数字选员工");
    expect(list).toContain("1. ");
    expect(list).toContain("2. ");
    expect(list).toContain("甲熊");
    expect(list).toContain("乙熊");
    const prompts = await openPrompts(c);
    expect(prompts.map((p) => p.kind)).toEqual(["pick_agent"]);

    // 名单的顺序就是编号：回「2」选第二位。
    const lines = list.split("\n");
    const secondName = lines.find((l) => l.startsWith("2. "))?.slice(3);
    const chosen = secondName === "乙熊" ? second : first;
    await deliver(c, message(c, "2"));
    expect(turnsOf(c)).toHaveLength(1);
    expect(turnsOf(c)[0]).toMatchObject({
      agentId: chosen,
      text: "帮我订个会议室",
    });
    expect(sentTo(c).at(-1)?.text).toBe(
      `【${secondName}】收到：帮我订个会议室`,
    );
    expect(await openPrompts(c)).toEqual([]);
    expect((await accountOf(c))?.lastAgentId).toBe(chosen);

    // 没有待处理的提示时回「1」：当普通消息交给上次的员工（Review Focus 3）。
    await deliver(c, message(c, "1"));
    expect(turnsOf(c).at(-1)).toMatchObject({ agentId: chosen, text: "1" });
  });

  test("两个同名员工：开选人提示列编号候选，回数字选中", async () => {
    const d = await person("d");
    const one = await bot(d, "小助手", "工程师");
    const two = await bot(d, "小助手", "研究员");
    await deliver(d, message(d, "@小助手 你好"));
    expect(turnsOf(d)).toHaveLength(0);
    const list = sentTo(d).at(-1)?.text ?? "";
    expect(list).toContain("1. 小助手");
    expect(list).toContain("2. 小助手");
    expect(list).toContain("工程师");
    expect(list).toContain("研究员");
    expect((await openPrompts(d)).map((p) => p.kind)).toEqual(["pick_agent"]);

    const firstLine = list.split("\n").find((l) => l.startsWith("1. ")) ?? "";
    const expected = firstLine.includes("工程师") ? one : two;
    await deliver(d, message(d, "1"));
    expect(turnsOf(d)).toEqual([
      expect.objectContaining({ agentId: expected, text: "你好" }),
    ]);
    expect(sentTo(d).at(-1)?.text).toBe("【小助手】收到：你好");
  });

  test("选人提示开着时回了范围外的数字：提示重选，不开一轮", async () => {
    const e = await person("e");
    await bot(e, "甲熊");
    await bot(e, "乙熊");
    await deliver(e, message(e, "在吗"));
    await deliver(e, message(e, "9"));
    expect(turnsOf(e)).toHaveLength(0);
    expect(sentTo(e).at(-1)?.text).toContain("1");
    expect((await openPrompts(e)).length).toBe(1);
  });

  test("图片、文件：回「目前只认文字」，不开一轮", async () => {
    const f = await person("f");
    await bot(f, "代码熊");
    await deliver(f, message(f, null));
    expect(turnsOf(f)).toHaveLength(0);
    expect(sentTo(f).map((s) => s.text)).toEqual([
      "目前只认文字，图片和文件请在熊宝里发",
    ]);
  });

  test("@ 一个不存在的名字：回「没找到叫 X 的员工」", async () => {
    const g = await person("g");
    await bot(g, "代码熊");
    await deliver(g, message(g, "@不存在 帮个忙"));
    expect(turnsOf(g)).toHaveLength(0);
    expect(sentTo(g).at(-1)?.text).toBe("没找到叫 不存在 的员工");
  });

  test("看不到别人的员工：@ 别人员工的名字也是没找到", async () => {
    const h = await person("h");
    const other = await person("h2");
    await bot(other, "秘密熊");
    await bot(h, "代码熊");
    await deliver(h, message(h, "@秘密熊 你好"));
    expect(turnsOf(h)).toHaveLength(0);
    expect(sentTo(h).at(-1)?.text).toBe("没找到叫 秘密熊 的员工");
  });

  test("两个人各自的消息只进各自的单聊", async () => {
    const p = await person("p");
    const q = await person("q");
    const pBot = await bot(p, "代码熊");
    const qBot = await bot(q, "代码熊");
    const mp = message(p, "@代码熊 我是 p");
    const mq = message(q, "@代码熊 我是 q");
    await deliver(p, mp);
    await deliver(q, mq);
    const pDirect = await directOf(p, pBot);
    const qDirect = await directOf(q, qBot);
    expect(pDirect.id).not.toBe(qDirect.id);
    expect(turnsOf(p)).toEqual([
      expect.objectContaining({
        channelId: pDirect.id,
        agentId: pBot,
        text: "我是 p",
        tenantId: p.userId,
      }),
    ]);
    expect(turnsOf(q)).toEqual([
      expect.objectContaining({
        channelId: qDirect.id,
        agentId: qBot,
        text: "我是 q",
        tenantId: q.userId,
      }),
    ]);
    expect(sentTo(p).map((s) => s.contextToken)).toEqual([mp.contextToken]);
    expect(sentTo(q).map((s) => s.contextToken)).toEqual([mq.contextToken]);
  });

  test("不是本人发的、群里的消息：不理", async () => {
    const r = await person("r");
    await bot(r, "代码熊");
    await deliver(r, {
      ...message(r, "@代码熊 帮我删库"),
      fromUserId: "stranger@im.wechat",
    });
    await deliver(r, { ...message(r, "@代码熊 群里"), groupId: "g1" });
    expect(turnsOf(r)).toHaveLength(0);
    expect(sentTo(r)).toHaveLength(0);
  });
});

describe("持久去重", () => {
  test("同一条消息交给 inbound 两次：只开一轮、只回一次话", async () => {
    const s = await person("s");
    await bot(s, "代码熊");
    const m = message(s, "@代码熊 看下报错");
    await deliver(s, m);
    await deliver(s, m);
    expect(turnsOf(s)).toHaveLength(1);
    expect(sentTo(s)).toHaveLength(1);
  });

  test("图片、没找到、选人提示、选人回复：重复投递都不再回话、不再开提示", async () => {
    const t = await person("t");
    await bot(t, "甲熊");
    await bot(t, "乙熊");
    const image = message(t, null);
    await deliver(t, image);
    await deliver(t, image);
    expect(sentTo(t)).toHaveLength(1);

    const missing = message(t, "@没有 你好");
    await deliver(t, missing);
    await deliver(t, missing);
    expect(sentTo(t)).toHaveLength(2);

    const ask = message(t, "开个会");
    await deliver(t, ask);
    await deliver(t, ask);
    expect(sentTo(t)).toHaveLength(3);
    expect(await openPrompts(t)).toHaveLength(1);

    const pick = message(t, "1");
    await deliver(t, pick);
    await deliver(t, pick);
    // 原消息重复投递（提示已关、已有上次的员工）也不再开一轮。
    await deliver(t, ask);
    expect(turnsOf(t)).toEqual([expect.objectContaining({ text: "开个会" })]);
    expect(sentTo(t)).toHaveLength(4);
  });

  test("处理中途出错：这条不算处理过，轮询器重试时照常处理", async () => {
    const u = await person("u");
    await bot(u, "代码熊");
    const m = message(u, "@代码熊 再试一次");
    const failing = createWechatInbound({
      wechat: wechatStore,
      deliveries: deliveryStore,
      router,
      channels: {
        ...channelStore,
        direct: async () => {
          throw new Error("database blinked");
        },
      },
      bots: profileStore,
      actorFor,
      scopeFor: scopes.scopeFor,
      send: async () => {},
    });
    await expect(
      runAsTenant(u.userId, () => failing(u.account, m)),
    ).rejects.toThrow("database blinked");
    await deliver(u, m);
    expect(turnsOf(u)).toEqual([expect.objectContaining({ text: "再试一次" })]);
  });
});

describe("回复", () => {
  test("员工的长回复按 2000 字切段依次发，【员工名】只加在第一段", async () => {
    const v = await person("v");
    await bot(v, "代码熊");
    const long = "长".repeat(4500);
    answer = () => long;
    try {
      await deliver(v, message(v, "@代码熊 写长一点"));
    } finally {
      answer = (text) => `收到：${text}`;
    }
    const parts = sentTo(v).map((s) => s.text);
    expect(parts.length).toBe(3);
    expect(parts[0]?.startsWith("【代码熊】")).toBe(true);
    expect(parts.slice(1).some((p) => p.includes("【代码熊】"))).toBe(false);
    expect(parts.join("")).toBe(`【代码熊】${long}`);
    for (const part of parts)
      expect(Array.from(part).length).toBeLessThanOrEqual(2000);
  });

  test("发回微信失败（时间窗已关等）：inbound 不抛错，员工的那一轮照样记在熊宝里，日志里没有 context_token", async () => {
    const w = await person("w");
    await bot(w, "代码熊");
    const m = message(w, "@代码熊 发不出去也没关系");
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    sendFails = new IlinkWindowClosedError();
    try {
      await deliver(w, m);
    } finally {
      sendFails = null;
      console.error = original;
    }
    expect(turnsOf(w)).toHaveLength(1);
    expect(logged.join("\n")).toContain("wechat-reply-failed");
    expect(logged.join("\n")).not.toContain(m.contextToken ?? "never");
  });
});

describe("真的发送器", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const credentialStore = createCredentialStore(database);

  test("解封本人的令牌，带着 context_token 发给本人的微信；缺 context_token 时不发、错误里没有令牌", async () => {
    const x = await person("sender");
    const token = `${prefix}-bot-token-secret`;
    const account = await runAsTenant(x.userId, async () => {
      const credential = await credentialStore.create({
        kind: "chat",
        provider: "wechat",
        keyId: x.userId,
        metadata: { ownerUserId: x.userId },
        seal: (binding) => sealCredential(KEY, binding, token),
      });
      return wechatStore.saveAccount({
        userId: x.userId,
        ilinkBotId: x.account.ilinkBotId,
        ilinkUserId: x.ilinkUserId,
        baseUrl: "https://ilinkai.weixin.qq.com",
        credentialId: credential.id,
      });
    });
    const calls: unknown[] = [];
    const send = createWechatSender({
      ilink: {
        async sendText(session, input) {
          calls.push({ session, input });
        },
      },
      credentials: credentialStore,
      keyEncryptionKey: KEY,
    });
    await runAsTenant(x.userId, () =>
      send(account, { text: "【代码熊】好", contextToken: "ctx-1" }),
    );
    expect(calls).toEqual([
      {
        session: { baseUrl: "https://ilinkai.weixin.qq.com", botToken: token },
        input: {
          toUserId: x.ilinkUserId,
          contextToken: "ctx-1",
          text: "【代码熊】好",
        },
      },
    ]);
    const refused = await runAsTenant(x.userId, () =>
      send(account, { text: "好", contextToken: null }).catch((e) => e),
    );
    expect(refused).toBeInstanceOf(WechatReplyUnavailableError);
    expect(String(refused?.message)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });
});

describe("修复轮 1：选人提示不截走后面的数字", () => {
  test("开了选人提示后改用「@员工名」开一轮：提示关掉，再回「1」当普通消息交给这位员工", async () => {
    const a = await person("fix-a");
    const coder = await bot(a, "甲熊");
    await bot(a, "乙熊");
    await deliver(a, message(a, "开个会"));
    expect((await openPrompts(a)).length).toBe(1);
    await deliver(a, message(a, "@甲熊 看下报错"));
    expect(await openPrompts(a)).toEqual([]);
    await deliver(a, message(a, "1"));
    expect(turnsOf(a).map((t) => [t.agentId, t.text])).toEqual([
      [coder, "看下报错"],
      [coder, "1"],
    ]);
    expect((await accountOf(a))?.lastAgentId).toBe(coder);
  });

  test("只写「@员工名」换人、或交给上次的员工：也关掉开着的选人提示", async () => {
    const b = await person("fix-b");
    const one = await bot(b, "同名熊", "工程师");
    await bot(b, "同名熊", "研究员");
    const writer = await bot(b, "写作熊");
    await deliver(b, message(b, "@同名熊 你好"));
    expect((await openPrompts(b)).length).toBe(1);
    await deliver(b, message(b, "@写作熊"));
    expect(await openPrompts(b)).toEqual([]);

    await deliver(b, message(b, "@同名熊 再来"));
    expect((await openPrompts(b)).length).toBe(1);
    await deliver(b, message(b, "写个周报"));
    expect(await openPrompts(b)).toEqual([]);
    expect(turnsOf(b).map((t) => [t.agentId, t.text])).toEqual([
      [writer, "写个周报"],
    ]);
    expect(turnsOf(b).some((t) => t.agentId === one)).toBe(false);
  });

  test("选人提示超过 10 分钟：不再算待处理，回「1」当普通消息交给上次的员工", async () => {
    const c = await person("fix-c");
    const coder = await bot(c, "代码熊");
    await bot(c, "同名熊", "工程师");
    await bot(c, "同名熊", "研究员");
    await deliver(c, message(c, "@代码熊 你好"));
    await deliver(c, message(c, "@同名熊 帮个忙"));
    expect((await openPrompts(c)).length).toBe(1);
    clock = () => new Date(Date.now() + 11 * 60 * 1000);
    try {
      await deliver(c, message(c, "1"));
    } finally {
      clock = () => new Date();
    }
    expect(turnsOf(c).map((t) => [t.agentId, t.text])).toEqual([
      [coder, "你好"],
      [coder, "1"],
    ]);
    expect(await openPrompts(c)).toEqual([]);
  });

  test("10 分钟内照常：全角「１」也选得中", async () => {
    const d = await person("fix-d");
    await bot(d, "甲熊");
    await bot(d, "乙熊");
    await deliver(d, message(d, "订会议室"));
    await deliver(d, message(d, "１"));
    expect(turnsOf(d).map((t) => t.text)).toEqual(["订会议室"]);
    expect(await openPrompts(d)).toEqual([]);
  });

  test("拉丁字母结尾的名字要有边界：「@Bobby hi」不命中 Bob；中文名照旧不要空格", async () => {
    const e = await person("fix-e");
    const bob = await bot(e, "Bob");
    await deliver(e, message(e, "@Bobby hi"));
    expect(turnsOf(e)).toHaveLength(0);
    expect(sentTo(e).at(-1)?.text).toBe("没找到叫 Bobby 的员工");
    await deliver(e, message(e, "@bob, hi"));
    expect(turnsOf(e).map((t) => [t.agentId, t.text])).toEqual([[bob, "hi"]]);
    const bobby = await bot(e, "Bobby");
    await deliver(e, message(e, "@Bobby hi again"));
    expect(turnsOf(e).at(-1)).toMatchObject({
      agentId: bobby,
      text: "hi again",
    });
    const r2 = await bot(e, "R2");
    await deliver(e, message(e, "@R2D2 hi"));
    expect(turnsOf(e).at(-1)?.agentId).not.toBe(r2);
    expect(sentTo(e).at(-1)?.text).toBe("没找到叫 R2D2 的员工");
  });

  test("拿掉去重记录自己也失败：只记日志，抛出的仍是原来的错误", async () => {
    const f = await person("fix-f");
    await bot(f, "代码熊");
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    const failing = createWechatInbound({
      wechat: {
        ...wechatStore,
        releaseMessage: async () => {
          throw new Error("release failed too");
        },
      },
      deliveries: deliveryStore,
      router,
      channels: {
        ...channelStore,
        direct: async () => {
          throw new Error("database blinked");
        },
      },
      bots: profileStore,
      actorFor,
      scopeFor: scopes.scopeFor,
      send: async () => {},
    });
    try {
      await expect(
        runAsTenant(f.userId, () =>
          failing(f.account, message(f, "@代码熊 试试")),
        ),
      ).rejects.toThrow("database blinked");
    } finally {
      console.error = original;
    }
    expect(logged.join("\n")).toContain("wechat-release-failed");
  });

  test("轮询器给的中止信号一路传到员工那一轮", async () => {
    const g = await person("fix-g");
    await bot(g, "代码熊");
    const controller = new AbortController();
    await runAsTenant(g.userId, () =>
      inbound(g.account, message(g, "@代码熊 带信号"), controller.signal),
    );
    expect(turnsOf(g)).toHaveLength(1);
    expect(signals.at(-1)).toBe(controller.signal);
  });
});

describe("修复轮 2：选人顺序、中止", () => {
  /** 和全局 `inbound` 一样，只是换掉路由（或其中的 `converse`）。 */
  const inboundWith = (converse: typeof router.converse) =>
    createWechatInbound({
      wechat: wechatStore,
      deliveries: deliveryStore,
      router: { converse },
      channels: channelStore,
      bots: profileStore,
      actorFor,
      scopeFor: scopes.scopeFor,
      send: async (account, input) => {
        sent.push({ userId: account.userId, ...input });
      },
    });
  const inboxOf = (who: Person, externalId: string) =>
    runAsTenant(who.userId, () =>
      database
        .select()
        .from(deliveryInbox)
        .where(
          and(
            eq(deliveryInbox.source, "wechat"),
            eq(deliveryInbox.externalId, externalId),
          ),
        ),
    );

  test("选人回复时 converse 在记收件箱前抛错：提示还开着，重试仍按搁置的原文开一轮，之后提示关闭", async () => {
    const a = await person("r2-a");
    await bot(a, "甲熊");
    await bot(a, "乙熊");
    await deliver(a, message(a, "订个会议室"));
    expect((await openPrompts(a)).length).toBe(1);
    let blink = true;
    const flaky = inboundWith(async (input) => {
      if (blink) {
        blink = false;
        throw new Error("database blinked");
      }
      return router.converse(input);
    });
    const pick = message(a, "1");
    await expect(
      runAsTenant(a.userId, () => flaky(a.account, pick)),
    ).rejects.toThrow("database blinked");
    expect((await openPrompts(a)).length).toBe(1);
    expect(turnsOf(a)).toHaveLength(0);

    await runAsTenant(a.userId, () => flaky(a.account, pick));
    expect(turnsOf(a).map((t) => t.text)).toEqual(["订个会议室"]);
    expect(await openPrompts(a)).toEqual([]);
  });

  test("还没进 converse 信号就已中止：inbound 抛错、去重记录拿掉、没写收件箱、没回话", async () => {
    const b = await person("r2-b");
    await bot(b, "代码熊");
    const controller = new AbortController();
    controller.abort();
    const m = message(b, "@代码熊 关停中");
    await expect(
      runAsTenant(b.userId, () => inbound(b.account, m, controller.signal)),
    ).rejects.toThrow();
    expect(turnsOf(b)).toHaveLength(0);
    expect(sentTo(b)).toHaveLength(0);
    expect(await inboxOf(b, m.id)).toEqual([]);
    expect((await accountOf(b))?.recentMessageIds).not.toContain(m.id);
  });

  test("员工那一轮被中止：收件箱 failed、回「服务正在更新」、inbound 不抛错、同一 ID 重投被挡住", async () => {
    const c = await person("r2-c");
    await bot(c, "代码熊");
    const controller = new AbortController();
    let runs = 0;
    const aborting = createDeliveryRouter({
      store: deliveryStore,
      queue: createWorkQueue(database),
      owner: `${prefix}-router-abort`,
      authoriseScope: scopes.authorise,
      scopeFor: scopes.scopeFor,
      providers: {},
      runTurn: async (input) => {
        runs += 1;
        controller.abort();
        input.signal.throwIfAborted();
        return { replyText: "不该到这里" };
      },
    });
    const viaAborting = inboundWith(aborting.converse);
    const m = message(c, "@代码熊 长活");
    await runAsTenant(c.userId, () =>
      viaAborting(c.account, m, controller.signal),
    );
    expect(runs).toBe(1);
    const [row] = await inboxOf(c, m.id);
    expect(row?.state).toBe("failed");
    expect(sentTo(c).map((s) => s.text)).toEqual([
      "【代码熊】服务正在更新，这一轮被打断了，请稍后再发一次，或到熊宝里查看。",
    ]);
    await runAsTenant(c.userId, () =>
      viaAborting(c.account, m, new AbortController().signal),
    );
    expect(runs).toBe(1);
    expect(sentTo(c)).toHaveLength(1);
  });
});

describe("CI 修复：选人名单的顺序", () => {
  test("库里另有团队共享的员工：名单里先出现本人的员工", async () => {
    const admin = await person("ci-admin");
    const shared: string[] = [];
    for (let n = 1; n <= 6; n += 1) {
      const profile = await runAsTenant(admin.userId, () =>
        profileStore.create(
          { id: admin.userId, role: "admin" },
          {
            name: `阿团队熊${n}`,
            title: "共享",
            roleDescription: "简短回答。",
            visibility: "public",
          },
        ),
      );
      madeAgents.push(profile.id);
      shared.push(profile.id);
    }
    const h = await person("ci-h");
    const visible = await runAsTenant(h.userId, () =>
      profileStore.list({ id: h.userId, role: "user" }),
    );
    // 前提：这个人看得到团队共享的员工。
    expect(visible.filter((p) => shared.includes(p.id))).toHaveLength(6);
    await bot(h, "自己的甲熊");
    await bot(h, "自己的乙熊");
    await deliver(h, message(h, "帮我订个会议室"));
    const lines = (sentTo(h).at(-1)?.text ?? "")
      .split("\n")
      .filter((line) => /^\d+\. /.test(line));
    expect(lines).toHaveLength(5);
    expect(
      lines
        .slice(0, 2)
        .map((l) => l.replace(/^\d+\. /, ""))
        .sort(),
    ).toEqual(["自己的乙熊", "自己的甲熊"].sort());
  });

  test("最近单聊过的员工排最前，按最近一次对话时间", async () => {
    const k = await person("ci-k");
    const first = await bot(k, "先聊熊");
    const second = await bot(k, "后聊熊");
    await bot(k, "没聊熊");
    await deliver(k, message(k, "@先聊熊 早"));
    await deliver(k, message(k, "@后聊熊 午"));
    // 假的那一轮不写对话动态；照真的那样记下：先聊熊早一些，后聊熊晚一些（插入顺序反过来，排序只看时间）。
    const said = async (agentId: string, at: Date) => {
      const direct = await directOf(k, agentId);
      await runAsTenant(k.userId, () =>
        channelStore.recordActivity({ id: k.userId, role: "user" }, direct.id, {
          text: "聊过",
          agentId: null,
          at,
        }),
      );
    };
    await said(second, new Date(Date.now() - 60_000));
    await said(first, new Date(Date.now() - 120_000));
    // 回到没有上次员工的状态，看名单的顺序。
    await runAsTenant(k.userId, () =>
      database
        .update(wechatAccounts)
        .set({ lastAgentId: null })
        .where(eq(wechatAccounts.id, k.account.id)),
    );
    await deliver(k, message(k, "再说一件事"));
    const lines = (sentTo(k).at(-1)?.text ?? "")
      .split("\n")
      .filter((line) => /^\d+\. /.test(line))
      .map((l) => l.replace(/^\d+\. /, ""));
    expect(lines.slice(0, 2)).toEqual(["后聊熊", "先聊熊"]);
    expect(lines[2]).toBe("没聊熊");
  });
});
