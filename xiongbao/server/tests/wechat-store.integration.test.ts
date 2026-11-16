import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { credentials, users } from "../src/db/schema/core";
import { wechatAccounts, wechatPrompts } from "../src/db/schema/wechat";
import { createWechatStore } from "../src/delivery/wechat/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 微信 ClawBot 的三张表（迁移 0223、0224）和 `delivery/wechat/store.ts`。
 *
 * 帧和生产一致：本人的绑定、提示在本人帧里读写；按 iLink 用户找账号、轮询器认领和续租在 platform 帧，
 * 由 store 自己开帧，调用方在谁的帧里都一样。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createWechatStore(database);
const prefix = `wechat-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const carol = `${prefix}-carol`;
const people = [alice, bob, carol];
const asAlice = <T>(work: () => T): T => runAsTenant(alice, work);
const asBob = <T>(work: () => T): T => runAsTenant(bob, work);
const asCarol = <T>(work: () => T): T => runAsTenant(carol, work);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
const account = (userId: string, ilinkUserId: string) => ({
  userId,
  ilinkBotId: `${prefix}-bot-${userId}`,
  ilinkUserId,
  baseUrl: "https://ilinkai.weixin.qq.com",
  credentialId: null,
});

beforeAll(async () => {
  for (const id of people)
    await runAsTenant(id, () =>
      database.insert(users).values({ id, email: `${id}@example.test` }),
    );
});

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

test("一个人的账号和提示在别人的帧里读不到，按 iLink 用户找账号走 platform 帧", async () => {
  const ilinkUser = `${prefix}-ilink-a`;
  const saved = await asAlice(() =>
    store.saveAccount(account(alice, ilinkUser)),
  );
  expect(saved.status).toBe("bound");
  expect(saved.tenantId).toBe(alice);
  await asAlice(() => store.openPrompt(alice, "approval", "ref-a"));

  expect((await asAlice(() => store.account(alice)))?.id).toBe(saved.id);
  expect(await asBob(() => store.account(alice))).toBeNull();
  expect(await asBob(() => store.openPrompts(alice))).toEqual([]);
  expect(
    await asBob(() =>
      database
        .select({ id: wechatAccounts.id })
        .from(wechatAccounts)
        .where(eq(wechatAccounts.userId, alice)),
    ),
  ).toEqual([]);
  // 第二个人绑定时要看得见第一个人的行，才能说「这个微信已经绑了别人」。
  expect((await asBob(() => store.accountByIlinkUser(ilinkUser)))?.userId).toBe(
    alice,
  );
  // 在别人的帧里写本人的行，什么都改不到。
  await asBob(() => store.pause(saved.id, new Date(Date.now() + 60_000)));
  expect((await asAlice(() => store.account(alice)))?.status).toBe("bound");
});

test("同一个 iLink 用户只能有一个未解绑的账号，解绑后别人可以再绑", async () => {
  const ilinkUser = `${prefix}-ilink-shared`;
  await asBob(() => store.saveAccount(account(bob, ilinkUser)));
  await expect(
    asCarol(() => store.saveAccount(account(carol, ilinkUser))),
  ).rejects.toThrow();
  expect(await asCarol(() => store.account(carol))).toBeNull();

  const released = await asBob(() => store.unbind(bob));
  expect(released?.status).toBe("unbound");
  expect(await asBob(() => store.accountByIlinkUser(ilinkUser))).toBeNull();

  const rebound = await asCarol(() =>
    store.saveAccount(account(carol, ilinkUser)),
  );
  expect(rebound.status).toBe("bound");
  expect((await asBob(() => store.accountByIlinkUser(ilinkUser)))?.userId).toBe(
    carol,
  );
});

test("一个人只有一个账号，重新绑定改写原行并清掉旧游标和上下文", async () => {
  const first = await asAlice(() => store.account(alice));
  if (!first) throw new Error("alice 的账号应已存在");
  await asAlice(() => store.setCursor(first.id, "cursor-1"));
  await asAlice(() => store.setCursor(first.id, ""));
  const at = new Date("2026-11-16T08:00:00.000Z");
  await asAlice(() =>
    store.markInbound(first.id, { at, contextToken: "ctx-1" }),
  );
  const marked = await asAlice(() => store.account(alice));
  expect(marked?.cursor).toBe("cursor-1");
  expect(marked?.contextToken).toBe("ctx-1");
  expect(marked?.lastInboundAt?.toISOString()).toBe(at.toISOString());

  const again = await asAlice(() =>
    store.saveAccount({ ...account(alice, `${prefix}-ilink-a2`) }),
  );
  expect(again.id).toBe(first.id);
  expect(again.ilinkUserId).toBe(`${prefix}-ilink-a2`);
  expect(again.cursor).toBeNull();
  expect(again.contextToken).toBeNull();
});

test("账号可以挂一条 chat 类凭据", async () => {
  const [credential] = await asAlice(() =>
    database
      .insert(credentials)
      .values({
        kind: "chat",
        provider: "wechat",
        encryptedValue: "sealed",
        keyId: `${prefix}-key`,
        metadata: {},
      })
      .returning({ id: credentials.id }),
  );
  if (!credential) throw new Error("凭据未写入");
  const saved = await asAlice(() =>
    store.saveAccount({
      ...account(alice, `${prefix}-ilink-a2`),
      credentialId: credential.id,
    }),
  );
  expect(saved.credentialId).toBe(credential.id);
});

test("提示编号每人从 A1 起递增，关掉的编号不再发", async () => {
  const first = await asAlice(() =>
    store.openPrompt(alice, "extension", "ref-1"),
  );
  const second = await asAlice(() =>
    store.openPrompt(alice, "handin", "ref-2"),
  );
  // 第一个测试已给 alice 开过 A1。
  expect([first.code, second.code]).toEqual(["A2", "A3"]);

  const bobFirst = await asBob(() => store.openPrompt(bob, "approval", "b-1"));
  const bobSecond = await asBob(() => store.openPrompt(bob, "overdue", "b-2"));
  expect([bobFirst.code, bobSecond.code]).toEqual(["A1", "A2"]);

  expect(await asAlice(() => store.closePrompt(alice, "A3"))).toBe(true);
  expect(await asAlice(() => store.closePrompt(alice, "A3"))).toBe(false);
  expect(await asBob(() => store.closePrompt(alice, "A2"))).toBe(false);
  const open = await asAlice(() => store.openPrompts(alice));
  expect(open.map((prompt) => prompt.code)).toEqual(["A1", "A2"]);
  expect(open[1]?.kind).toBe("extension");
  expect(open[1]?.refId).toBe("ref-1");

  const next = await asAlice(() =>
    store.openPrompt(alice, "pick_agent", "ref-3"),
  );
  expect(next.code).toBe("A4");

  // 同时开几条也不撞号。
  const parallel = await Promise.all(
    ["p-1", "p-2", "p-3"].map((ref) =>
      asCarol(() => store.openPrompt(carol, "approval", ref)),
    ),
  );
  expect(parallel.map((prompt) => prompt.code).sort()).toEqual([
    "A1",
    "A2",
    "A3",
  ]);

  // (user_id, code) 唯一。
  await expect(
    asAlice(async () => {
      await database.insert(wechatPrompts).values({
        id: randomUUID(),
        userId: alice,
        code: "A1",
        kind: "approval",
        refId: "dup",
      });
    }),
  ).rejects.toThrow();
});

test("两个轮询器同时认领只有一个拿到账号，租约过期后另一个能拿到", async () => {
  const mine = [
    (await asAlice(() => store.account(alice)))?.id,
    (await asCarol(() => store.account(carol)))?.id,
  ];
  const ours = (claimed: { id: string }[]) =>
    claimed.map((row) => row.id).filter((id) => mine.includes(id));

  const [one, two] = await Promise.all([
    store.claimForPolling("poller-1", 60_000, 100),
    store.claimForPolling("poller-2", 60_000, 100),
  ]);
  const won = [...ours(one), ...ours(two)].sort();
  expect(won).toEqual([...mine].sort() as string[]);
  expect(ours(one).filter((id) => ours(two).includes(id))).toEqual([]);

  // 租约还在：谁也认领不到，持有人能续租，别人不能。
  expect(ours(await store.claimForPolling("poller-3", 60_000, 100))).toEqual(
    [],
  );
  const aliceId = mine[0] as string;
  const aliceHolder = ours(one).includes(aliceId) ? "poller-1" : "poller-2";
  expect(await store.renewLease(aliceId, aliceHolder, 60_000)).toBe(true);
  expect(await store.renewLease(aliceId, "poller-3", 60_000)).toBe(false);

  // 租约过期（按数据库时钟）后，另一个轮询器拿得到；原持有人再也续不回来。
  await asPlatform(() =>
    database
      .update(wechatAccounts)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(wechatAccounts.id, aliceId)),
  );
  expect(ours(await store.claimForPolling("poller-3", 60_000, 100))).toEqual([
    aliceId,
  ]);
  expect(await store.renewLease(aliceId, aliceHolder, 60_000)).toBe(false);
  expect(await store.renewLease(aliceId, "poller-3", 60_000)).toBe(true);
});

test("暂停到期前不认领，到期后恢复认领；解绑的账号永不认领", async () => {
  const aliceAccount = await asAlice(() => store.account(alice));
  if (!aliceAccount) throw new Error("alice 的账号应已存在");
  const expire = () =>
    asPlatform(() =>
      database
        .update(wechatAccounts)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(eq(wechatAccounts.id, aliceAccount.id)),
    );
  const claimsAlice = async () =>
    (await store.claimForPolling("poller-4", 60_000, 100)).some(
      (row) => row.id === aliceAccount.id,
    );

  await asAlice(() =>
    store.pause(aliceAccount.id, new Date(Date.now() + 3_600_000)),
  );
  await expire();
  expect((await asAlice(() => store.account(alice)))?.status).toBe("paused");
  expect(await claimsAlice()).toBe(false);

  await asPlatform(() =>
    database
      .update(wechatAccounts)
      .set({ pausedUntil: sql`now() - interval '1 second'` })
      .where(eq(wechatAccounts.id, aliceAccount.id)),
  );
  expect(await claimsAlice()).toBe(true);
  const resumed = await asAlice(() => store.account(alice));
  expect(resumed?.status).toBe("bound");
  expect(resumed?.pausedUntil).toBeNull();

  await expire();
  await asAlice(() => store.unbind(alice));
  expect(await claimsAlice()).toBe(false);
});
