import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createCredentialStore, sealCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, users } from "../src/db/schema/core";
import { wechatAccounts } from "../src/db/schema/wechat";
import {
  type IlinkClient,
  type IlinkMessage,
  IlinkPausedError,
  IlinkUnauthorizedError,
} from "../src/delivery/wechat/ilink";
import { createWechatPoller } from "../src/delivery/wechat/poller";
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
    async getUpdates(session, cursor) {
      calls.push({ token: session.botToken, cursor });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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
  options: { owner?: string; now?: () => Date } = {},
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
  await poller.tick();
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
  expect((await accountOf(c.userId))?.cursor).toBeNull();
  expect((await accountOf(c.userId))?.leaseOwner).toBeNull();
  await poller.tick();
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
  const row = await accountOf(d.userId);
  expect(row?.status).toBe("paused");
  expect(row?.pausedUntil?.toISOString()).toBe("2026-11-16T09:00:00.000Z");
  expect(row?.leaseOwner).toBeNull();
  await poller.tick();
  expect(ilink.pulls(d.token)).toBe(1);
  await runAsTenant(d.userId, () => store.unbind(d.userId));
});

test("IlinkUnauthorizedError：账号标成已断开，不再拉，这个微信号不再被占着", async () => {
  const e = await bindPerson("e");
  const ilink = fakeIlink();
  ilink.script(e.token, new IlinkUnauthorizedError());
  const poller = pollerWith(ilink, async () => {});
  await poller.tick();
  const row = await accountOf(e.userId);
  expect(row?.status).toBe("disconnected");
  expect(row?.leaseOwner).toBeNull();
  await poller.tick();
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
    await pollerWith(ilink, async () => {}).tick();
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
