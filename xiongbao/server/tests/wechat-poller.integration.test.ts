import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createCredentialStore, sealCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, users } from "../src/db/schema/core";
import { wechatAccounts } from "../src/db/schema/wechat";
import { DeliveryProviderError } from "../src/delivery/types";
import {
  type IlinkClient,
  type IlinkMessage,
  IlinkPausedError,
  IlinkUnauthorizedError,
} from "../src/delivery/wechat/ilink";
import {
  createWechatPoller,
  WECHAT_CLAIM_LIMIT,
  WECHAT_SHUTDOWN_GRACE_MS,
} from "../src/delivery/wechat/poller";
import { createWechatStore } from "../src/delivery/wechat/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 微信长轮询器（计划 2026-11-16-im-channels-wechat Task 5），走真的库和真的租约；iLink 用脚本化的假客户端。
 * 令牌封在真的凭据里，轮询器按账号的 `credential_id` 取出来给假客户端，测试据此认出是哪个账号在拉。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const prefix = `wxpoll-${randomUUID().slice(0, 8)}`;
const store = createWechatStore(database);
const credentialStore = createCredentialStore(database);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
const people: string[] = [];

type Step = { messages?: IlinkMessage[]; cursor?: string | null } | Error;
/** 假 iLink：每个令牌一串脚本，用完回空；记下谁、带着什么游标来拉过。 */
function fakeIlink(delayMs = 0) {
  const scripts = new Map<string, Step[]>();
  const calls: { token: string; cursor: string }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let gate: Promise<void> | null = null;
  const client: IlinkClient = {
    async getBotQrcode() {
      throw new Error("not used");
    },
    async getQrcodeStatus() {
      throw new Error("not used");
    },
    async sendText() {
      throw new Error("not used");
    },
    async getUpdates(session, cursor, _timeoutMs, signal) {
      calls.push({ token: session.botToken, cursor });
      signals.push(signal);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (gate) await gate;
      const step = scripts.get(session.botToken)?.shift();
      if (step instanceof Error) throw step;
      return {
        messages: step?.messages ?? [],
        cursor: step?.cursor ?? null,
        timeoutMs: 35_000,
      };
    },
  };
  return {
    client,
    calls,
    signals,
    /** 之后的 getUpdates 都挂住，直到调用返回的函数。 */
    hold() {
      let open: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    script(token: string, ...steps: Step[]) {
      scripts.set(token, steps);
    },
    pulls: (token: string) => calls.filter((c) => c.token === token).length,
  };
}

const message = (id: string, text = "hi", contextToken = `ctx-${id}`) =>
  ({
    id,
    fromUserId: "someone@im.wechat",
    text,
    contextToken,
    groupId: null,
  }) satisfies IlinkMessage;

/** 一个新用户、一份封好令牌的凭据、一个已绑定的账号。 */
async function bindPerson(name: string) {
  const userId = `${prefix}-${name}`;
  const token = `${prefix}-token-${name}`;
  people.push(userId);
  await runAsTenant(userId, () =>
    database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test` }),
  );
  const accountRow = await runAsTenant(userId, async () => {
    const credential = await credentialStore.create({
      kind: "chat",
      provider: "wechat",
      keyId: userId,
      metadata: { ownerUserId: userId },
      seal: (binding) => sealCredential(KEY, binding, token),
    });
    return store.saveAccount({
      userId,
      ilinkBotId: `${prefix}-bot-${name}`,
      ilinkUserId: `${prefix}-wx-${name}@im.wechat`,
      baseUrl: "https://ilinkai.weixin.qq.com",
      credentialId: credential.id,
    });
  });
  return { userId, token, id: accountRow.id };
}
const accountOf = (userId: string) =>
  runAsTenant(userId, () => store.account(userId));

function pollerWith(
  ilink: ReturnType<typeof fakeIlink>,
  inbound: Parameters<typeof createWechatPoller>[0]["inbound"],
  options: {
    owner?: string;
    now?: () => Date;
    leaseMs?: number;
    maxInFlight?: number;
  } = {},
) {
  return createWechatPoller({
    database,
    wechat: store,
    ilink: ilink.client,
    credentials: credentialStore,
    keyEncryptionKey: KEY,
    inbound,
    owner: options.owner ?? `${prefix}-poller-${randomUUID().slice(0, 4)}`,
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...(options.maxInFlight ? { maxInFlight: options.maxInFlight } : {}),
  });
}

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(users).where(inArray(users.id, people));
    await database
      .delete(credentials)
      .where(inArray(credentials.tenantId, people));
  });
  await database.$client.close();
});

test("收到两条消息：inbound 调两次、在本人的帧里，时间、上下文、游标都存下，租约还掉", async () => {
  const a = await bindPerson("a");
  const ilink = fakeIlink();
  ilink.script(
    a.token,
    { messages: [message("101"), message("102")], cursor: "cur-1" },
    { messages: [], cursor: "" },
  );
  const seen: { id: string; tenant: string | undefined }[] = [];
  const at = new Date("2026-11-16T08:00:00Z");
  const poller = pollerWith(
    ilink,
    async (account, m) => {
      seen.push({ id: m.id, tenant: account.tenantId });
    },
    { now: () => at },
  );
  await poller.tick();
  await poller.drain();
  expect(seen).toEqual([
    { id: "101", tenant: a.userId },
    { id: "102", tenant: a.userId },
  ]);
  const row = await accountOf(a.userId);
  expect(row?.cursor).toBe("cur-1");
  expect(row?.contextToken).toBe("ctx-102");
  expect(row?.lastInboundAt?.toISOString()).toBe(at.toISOString());
  expect(row?.leaseOwner).toBeNull();
  expect(ilink.calls[0]).toEqual({ token: a.token, cursor: "" });

  // 租约已还：下一轮立刻再拉，带着存下的游标；返回空游标不覆盖。
  await poller.tick();
  await poller.drain();
  expect(ilink.calls[1]).toEqual({ token: a.token, cursor: "cur-1" });
  expect((await accountOf(a.userId))?.cursor).toBe("cur-1");
  await runAsTenant(a.userId, () => store.unbind(a.userId));
});

test("同一个消息 ID 再次返回：inbound 不再调用", async () => {
  const b = await bindPerson("b");
  const ilink = fakeIlink();
  ilink.script(
    b.token,
    { messages: [message("201")], cursor: "c1" },
    { messages: [message("201"), message("202")], cursor: "c2" },
  );
  const seen: string[] = [];
  const poller = pollerWith(ilink, async (_a, m) => {
    seen.push(m.id);
  });
  await poller.tick();
  await poller.drain();
  await poller.tick();
  await poller.drain();
  expect(seen).toEqual(["201", "202"]);
  await runAsTenant(b.userId, () => store.unbind(b.userId));
});

test("inbound 抛错：不存游标，下一轮重来，已处理的不重复", async () => {
  const c = await bindPerson("c");
  const ilink = fakeIlink();
  const batch = [message("301"), message("302")];
  ilink.script(
    c.token,
    { messages: batch, cursor: "c1" },
    { messages: batch, cursor: "c1" },
  );
  const seen: string[] = [];
  let failOnce = true;
  const poller = pollerWith(ilink, async (_a, m) => {
    if (m.id === "302" && failOnce) {
      failOnce = false;
      throw new Error("boom");
    }
    seen.push(m.id);
  });
  await poller.tick();
  await poller.drain();
  expect((await accountOf(c.userId))?.cursor).toBeNull();
  expect((await accountOf(c.userId))?.leaseOwner).toBeNull();
  await poller.tick();
  await poller.drain();
  expect(seen).toEqual(["301", "302"]);
  expect((await accountOf(c.userId))?.cursor).toBe("c1");
  await runAsTenant(c.userId, () => store.unbind(c.userId));
});

test("IlinkPausedError：账号暂停一小时，期间不再拉", async () => {
  const d = await bindPerson("d");
  const ilink = fakeIlink();
  ilink.script(d.token, new IlinkPausedError());
  const at = new Date("2026-11-16T08:00:00Z");
  const poller = pollerWith(ilink, async () => {}, { now: () => at });
  await poller.tick();
  await poller.drain();
  const row = await accountOf(d.userId);
  expect(row?.status).toBe("paused");
  expect(row?.pausedUntil?.toISOString()).toBe("2026-11-16T09:00:00.000Z");
  expect(row?.leaseOwner).toBeNull();
  await poller.tick();
  await poller.drain();
  expect(ilink.pulls(d.token)).toBe(1);
  await runAsTenant(d.userId, () => store.unbind(d.userId));
});

test("IlinkUnauthorizedError：账号标成已断开，不再拉，这个微信号不再被占着", async () => {
  const e = await bindPerson("e");
  const ilink = fakeIlink();
  ilink.script(e.token, new IlinkUnauthorizedError());
  const poller = pollerWith(ilink, async () => {});
  await poller.tick();
  await poller.drain();
  const row = await accountOf(e.userId);
  expect(row?.status).toBe("disconnected");
  expect(row?.leaseOwner).toBeNull();
  await poller.tick();
  await poller.drain();
  expect(ilink.pulls(e.token)).toBe(1);
  expect(await store.accountByIlinkUser(row?.ilinkUserId ?? "")).toBeNull();
  // 已断开的行续不了租；重新绑定（覆盖这一行）后回到 bound。
  expect(await store.renewLease(e.id, "anyone", 1000)).toBe(false);
  const rebound = await runAsTenant(e.userId, () =>
    store.saveAccount({
      userId: e.userId,
      ilinkBotId: row?.ilinkBotId ?? "",
      ilinkUserId: row?.ilinkUserId ?? "",
      baseUrl: row?.baseUrl ?? "",
      credentialId: row?.credentialId ?? null,
    }),
  );
  expect(rebound.status).toBe("bound");
  await runAsTenant(e.userId, () => store.unbind(e.userId));
});

test("两个轮询器同时 tick：同一个账号只被拉一次", async () => {
  const f = await bindPerson("f");
  const ilink = fakeIlink(150);
  ilink.script(f.token, { messages: [message("401")], cursor: "c1" });
  const seen: string[] = [];
  const inbound = async (_a: unknown, m: IlinkMessage) => {
    seen.push(m.id);
  };
  const one = pollerWith(ilink, inbound);
  const two = pollerWith(ilink, inbound);
  await Promise.all([one.tick(), two.tick()]);
  await Promise.all([one.drain(), two.drain()]);
  expect(ilink.pulls(f.token)).toBe(1);
  expect(seen).toEqual(["401"]);
  await runAsTenant(f.userId, () => store.unbind(f.userId));
});

test("令牌不进日志：别的错误只记名字，账号释放租约、不改状态", async () => {
  const g = await bindPerson("g");
  const ilink = fakeIlink();
  ilink.script(g.token, new Error(`network down ${g.token}`));
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const quiet = pollerWith(ilink, async () => {});
    await quiet.tick();
    await quiet.drain();
  } finally {
    console.error = original;
  }
  const row = await accountOf(g.userId);
  expect(row?.status).toBe("bound");
  expect(row?.leaseOwner).toBeNull();
  expect(logged.join("\n")).not.toContain(g.token);
  expect(logged.length).toBeGreaterThan(0);
  await runAsTenant(g.userId, () => store.unbind(g.userId));
});

test("续租只对 bound 账号生效", async () => {
  const h = await bindPerson("h");
  const claimed = await store.claimForPolling(`${prefix}-own`, 60_000, 100);
  expect(claimed.some((row) => row.id === h.id)).toBe(true);
  expect(await store.renewLease(h.id, `${prefix}-own`, 60_000)).toBe(true);
  await runAsTenant(h.userId, () =>
    store.pause(h.id, new Date(Date.now() + 3600_000)),
  );
  expect(await store.renewLease(h.id, `${prefix}-own`, 60_000)).toBe(false);
  await asPlatform(() =>
    database.delete(wechatAccounts).where(eq(wechatAccounts.id, h.id)),
  );
});

test("账号多过一批：连续 tick，本测试的每个账号都被拉到过", async () => {
  const ilink = fakeIlink();
  const crowd = [];
  for (let i = 0; i <= WECHAT_CLAIM_LIMIT; i += 1)
    crowd.push(await bindPerson(`crowd${i}`));
  const poller = pollerWith(ilink, async () => {});
  // 库里若有别的 bound 账号会占名额；多 tick 几轮，设上限次数，不依赖库是空的。
  for (let round = 0; round < 10; round += 1) {
    await poller.tick();
    await poller.drain();
    if (crowd.every((person) => ilink.pulls(person.token) > 0)) break;
  }
  for (const person of crowd)
    expect(ilink.pulls(person.token)).toBeGreaterThan(0);
  for (const person of crowd)
    await runAsTenant(person.userId, () => store.unbind(person.userId));
});

test("同一条消息让 inbound 连续失败三次：跳过它，只记消息 ID 和错误类名，游标照样前进", async () => {
  const p = await bindPerson("poison");
  const ilink = fakeIlink();
  const batch = [message("501"), message("502")];
  ilink.script(
    p.token,
    { messages: batch, cursor: "c1" },
    { messages: batch, cursor: "c1" },
    { messages: batch, cursor: "c1" },
  );
  const seen: string[] = [];
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const poller = pollerWith(ilink, async (_a, m) => {
      if (m.id === "501") throw new Error(`secret ${p.token}`);
      seen.push(m.id);
    });
    for (let i = 0; i < 2; i += 1) {
      await poller.tick();
      await poller.drain();
      expect((await accountOf(p.userId))?.cursor).toBeNull();
    }
    expect(seen).toEqual([]);
    await poller.tick();
    await poller.drain();
  } finally {
    console.error = original;
  }
  expect(seen).toEqual(["502"]);
  expect((await accountOf(p.userId))?.cursor).toBe("c1");
  const skipped = logged.filter((line) =>
    line.includes("wechat-inbound-skipped"),
  );
  expect(skipped).toHaveLength(1);
  expect(JSON.parse(skipped[0] ?? "{}")).toMatchObject({
    messageId: "501",
    error: "Error",
  });
  expect(logged.join("\n")).not.toContain(p.token);
  await runAsTenant(p.userId, () => store.unbind(p.userId));
});

test("网络错误之后这个账号 30 秒内不再被认领", async () => {
  const q = await bindPerson("backoff");
  const ilink = fakeIlink();
  ilink.script(
    q.token,
    new DeliveryProviderError("wechat", "network_error", true),
  );
  const original = console.error;
  console.error = () => {};
  try {
    const poller = pollerWith(ilink, async () => {});
    await poller.tick();
    await poller.drain();
    await poller.tick();
    await poller.drain();
    expect(ilink.pulls(q.token)).toBe(1);
    // 退避到期后恢复。
    await asPlatform(() =>
      database
        .update(wechatAccounts)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(eq(wechatAccounts.id, q.id)),
    );
    await poller.tick();
    await poller.drain();
    expect(ilink.pulls(q.token)).toBe(2);
  } finally {
    console.error = original;
  }
  await runAsTenant(q.userId, () => store.unbind(q.userId));
});

test("tick 不等长轮询结束；drain 等", async () => {
  const r = await bindPerson("slow");
  const ilink = fakeIlink();
  const release = ilink.hold();
  const poller = pollerWith(ilink, async () => {});
  await poller.tick();
  // 假 getUpdates 还挂在手动控制的 promise 上，tick 已经返回。
  let finished = false;
  const waiting = poller.drain().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  release();
  await waiting;
  expect(ilink.pulls(r.token)).toBe(1);
  await runAsTenant(r.userId, () => store.unbind(r.userId));
});

test("在途上限：到了上限就不再认领", async () => {
  const one = await bindPerson("cap1");
  const two = await bindPerson("cap2");
  const ilink = fakeIlink();
  const release = ilink.hold();
  const poller = pollerWith(ilink, async () => {}, { maxInFlight: 1 });
  await poller.tick();
  await poller.tick();
  await poller.tick();
  const mine = [one.token, two.token];
  const polled = () => ilink.calls.filter((c) => mine.includes(c.token)).length;
  // 上限 1：库里只有一个在途的，后面两次 tick 没认领任何账号。
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ilink.calls.length).toBe(1);
  release();
  await poller.drain();
  await poller.tick();
  await poller.drain();
  expect(polled()).toBe(2);
  await runAsTenant(one.userId, () => store.unbind(one.userId));
  await runAsTenant(two.userId, () => store.unbind(two.userId));
});

test("inbound 比租约慢：同一条消息只处理一次，游标不回退，不会被再认领", async () => {
  const w = await bindPerson("wslow");
  const ilink = fakeIlink();
  ilink.script(
    w.token,
    { messages: [message("601")], cursor: "c1" },
    { messages: [message("601")], cursor: "c0-old" },
  );
  let calls = 0;
  const poller = pollerWith(
    ilink,
    async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    },
    { leaseMs: 300 },
  );
  await poller.tick();
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await poller.tick(); // 租约本该过期了，但心跳续着、账号也在处理集合里
  }
  await poller.drain();
  expect(calls).toBe(1);
  expect(ilink.pulls(w.token)).toBe(1);
  expect((await accountOf(w.userId))?.cursor).toBe("c1");
  await runAsTenant(w.userId, () => store.unbind(w.userId));
});

test("租约被别人拿走：停手，不写游标，不还别人的租约", async () => {
  const y = await bindPerson("stolen");
  const ilink = fakeIlink();
  ilink.script(y.token, { messages: [message("701")], cursor: "c1" });
  const poller = pollerWith(
    ilink,
    async () => {
      await asPlatform(() =>
        database
          .update(wechatAccounts)
          .set({
            leaseOwner: "thief",
            leaseUntil: sql`now() + interval '60 seconds'`,
          })
          .where(eq(wechatAccounts.id, y.id)),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
    { leaseMs: 300 },
  );
  await poller.tick();
  await poller.drain();
  const row = await accountOf(y.userId);
  expect(row?.cursor).toBeNull();
  expect(row?.leaseOwner).toBe("thief");
  await runAsTenant(y.userId, () => store.unbind(y.userId));
});

/** 等到假 iLink 被这个令牌拉过（`getUpdates` 已经进去了）。 */
async function untilPulled(ilink: ReturnType<typeof fakeIlink>, token: string) {
  for (let i = 0; i < 200 && ilink.pulls(token) === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ilink.pulls(token)).toBeGreaterThan(0);
}

test("默认租约 = 这个账号的长轮询时长 + 30 秒", async () => {
  const z = await bindPerson("lease");
  const ilink = fakeIlink();
  ilink.script(z.token, { messages: [], cursor: "" });
  const open = ilink.hold();
  const poller = pollerWith(ilink, async () => {});
  await poller.tick();
  await untilPulled(ilink, z.token);
  const [row] = await asPlatform(() =>
    database.execute<{ seconds: number | string }>(
      sql`select extract(epoch from ("lease_until" - now())) as "seconds" from "wechat_accounts" where "id" = ${z.id}`,
    ),
  );
  open();
  await poller.drain();
  // 第一次拉还不知道服务器给的时长，用默认 35 秒：35 + 30 = 65 秒。
  const seconds = Number(row?.seconds);
  expect(seconds).toBeGreaterThan(60);
  expect(seconds).toBeLessThanOrEqual(65);
  await runAsTenant(z.userId, () => store.unbind(z.userId));
});

test("拉取期间租约被别人拿走：不写游标", async () => {
  const x = await bindPerson("cursor-stolen");
  const ilink = fakeIlink();
  ilink.script(x.token, { messages: [], cursor: "c-late" });
  const open = ilink.hold();
  const poller = pollerWith(ilink, async () => {});
  await poller.tick();
  await untilPulled(ilink, x.token);
  await asPlatform(() =>
    database
      .update(wechatAccounts)
      .set({
        leaseOwner: "thief",
        leaseUntil: sql`now() + interval '60 seconds'`,
      })
      .where(eq(wechatAccounts.id, x.id)),
  );
  open();
  await poller.drain();
  const row = await accountOf(x.userId);
  expect(row?.cursor).toBeNull();
  expect(row?.leaseOwner).toBe("thief");
  await runAsTenant(x.userId, () => store.unbind(x.userId));
});

test("stop：先中止在途的长轮询，之后不再认领；drain 等它收尾", async () => {
  const s = await bindPerson("stop");
  const ilink = fakeIlink();
  ilink.script(
    s.token,
    { messages: [], cursor: "" },
    { messages: [], cursor: "" },
  );
  const open = ilink.hold();
  const poller = pollerWith(ilink, async () => {});
  await poller.tick();
  await untilPulled(ilink, s.token);
  const signal = ilink.signals.at(-1);
  expect(signal?.aborted).toBe(false);
  poller.stop();
  expect(signal?.aborted).toBe(true);
  open();
  await poller.drain();
  await poller.tick();
  await poller.drain();
  expect(ilink.pulls(s.token)).toBe(1);
  await runAsTenant(s.userId, () => store.unbind(s.userId));
});

test("inbound 拿到轮询器的中止信号；stop 后同一批剩下的消息不再处理、不存游标", async () => {
  const t = await bindPerson("stop-batch");
  const ilink = fakeIlink();
  ilink.script(t.token, {
    messages: [message("801"), message("802")],
    cursor: "c-batch",
  });
  const got: { id: string; signal: AbortSignal | undefined }[] = [];
  let poller: ReturnType<typeof pollerWith> | undefined;
  poller = pollerWith(ilink, async (_account, m, signal) => {
    got.push({ id: m.id, signal });
    poller?.stop();
  });
  await poller.tick();
  await poller.drain();
  expect(got.map((g) => g.id)).toEqual(["801"]);
  expect(got[0]?.signal?.aborted).toBe(true);
  expect((await accountOf(t.userId))?.cursor).toBeNull();
  await runAsTenant(t.userId, () => store.unbind(t.userId));
});

test("shutdown：一开始就中止正在 long-poll 的请求；关停后拉到的批次不处理、游标不存", async () => {
  const s = await bindPerson("grace-poll");
  const ilink = fakeIlink();
  ilink.script(s.token, {
    messages: [message("901"), message("902")],
    cursor: "c-after-stop",
  });
  const open = ilink.hold();
  const got: string[] = [];
  const poller = pollerWith(ilink, async (_account, m) => {
    got.push(m.id);
  });
  await poller.tick();
  await untilPulled(ilink, s.token);
  const signal = ilink.signals.at(-1);
  expect(signal?.aborted).toBe(false);
  const done = poller.shutdown(5_000);
  // 不等宽限期：关停一开始长轮询就被中止。
  expect(signal?.aborted).toBe(true);
  // 假 iLink 不看信号：被中止的请求这时才返回，还带着一批消息。
  open();
  const started = Date.now();
  await done;
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(got).toEqual([]);
  expect((await accountOf(s.userId))?.cursor).toBeNull();
  // 关停后不再认领。
  await poller.tick();
  await poller.drain();
  expect(ilink.pulls(s.token)).toBe(1);
  await runAsTenant(s.userId, () => store.unbind(s.userId));
});

test("shutdown：在跑的 inbound 宽限期内跑完就不中止它；同一批剩下的不处理", async () => {
  const s = await bindPerson("grace-ok");
  const ilink = fakeIlink();
  ilink.script(s.token, {
    messages: [message("911"), message("912")],
    cursor: "c-grace",
  });
  let release: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const got: { id: string; signal: AbortSignal | undefined }[] = [];
  const poller = pollerWith(ilink, async (_account, m, signal) => {
    got.push({ id: m.id, signal });
    entered = true;
    await running;
  });
  await poller.tick();
  for (let i = 0; i < 200 && !entered; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  setTimeout(release, 50);
  await poller.shutdown(2_000);
  expect(got.map((g) => g.id)).toEqual(["911"]);
  expect(got[0]?.signal?.aborted).toBe(false);
  expect((await accountOf(s.userId))?.cursor).toBeNull();
  await runAsTenant(s.userId, () => store.unbind(s.userId));
});

test("shutdown：宽限期到了 inbound 还在跑，就中止它再等它收尾", async () => {
  const s = await bindPerson("grace-late");
  const ilink = fakeIlink();
  ilink.script(s.token, { messages: [message("921")], cursor: "c-late" });
  let entered = false;
  let inboundSignal: AbortSignal | undefined;
  const poller = pollerWith(ilink, async (_account, _m, signal) => {
    entered = true;
    inboundSignal = signal;
    // 员工那一轮：被中止才收尾。
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve()),
    );
  });
  await poller.tick();
  for (let i = 0; i < 200 && !entered; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await poller.shutdown(100);
  expect(inboundSignal?.aborted).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  expect(WECHAT_SHUTDOWN_GRACE_MS).toBe(7_000);
  expect((await accountOf(s.userId))?.cursor).toBeNull();
  await runAsTenant(s.userId, () => store.unbind(s.userId));
});
