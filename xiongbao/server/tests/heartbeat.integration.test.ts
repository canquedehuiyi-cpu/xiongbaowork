import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import { heartbeatRuns } from "../src/db/schema/heartbeat";
import {
  proactiveCheckInRuns,
  proactiveSettings,
} from "../src/db/schema/proactive";
import { createProactiveStore } from "../src/proactive/store";
import { workItems } from "../src/db/schema/work";
import { createHeartbeatStore } from "../src/heartbeat/store";
import { HEARTBEAT_KIND } from "../src/heartbeat/schedule";
import { createHeartbeatRunner } from "../src/heartbeat/runner";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 心跳的设置怎么存、一串怎么接、每天次数怎么数，用真库；以及没事的醒来在库里不留痕迹。 */
const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createWorkQueue(db);
let clock = new Date("2026-11-20T10:07:00Z");
const store = createHeartbeatStore(db, { queue, now: () => clock });
const prefix = `hb-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const asOwner = <T>(work: () => T): T => runAsTenant(owner, work);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
const items = () =>
  asPlatform(() =>
    db
      .select({
        key: workItems.key,
        runAt: workItems.runAt,
        tenant: workItems.tenantId,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, HEARTBEAT_KIND),
          like(workItems.key, `${bot}:%`),
        ),
      ),
  );

beforeAll(async () => {
  await asOwner(async () => {
    await db
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` });
    await db.insert(agents).values({
      id: bot,
      name: "Heartbeat test Bot",
      type: "built_in",
      configuration: { lightModel: "keep-me" },
    });
  });
});
afterAll(async () => {
  await asPlatform(async () => {
    await db
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, HEARTBEAT_KIND),
          like(workItems.key, `${bot}:%`),
        ),
      );
    await db.delete(users).where(eq(users.id, owner));
    await db.delete(agents).where(eq(agents.id, bot));
  });
  await db.$client.end({ timeout: 5 });
});

test("打开心跳：存下设置、别的配置原样留着、第一次排在网格上并盖本人的租户", async () => {
  const applied = await asOwner(() =>
    store.apply(owner, bot, {
      enabled: true,
      intervalMinutes: 15,
      checklist: "看卡",
    }),
  );
  expect(applied).toMatchObject({
    ok: true,
    settings: { enabled: true, intervalMinutes: 15, checklist: "看卡" },
  });
  const [row] = await asOwner(() =>
    db
      .select({ configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, bot)),
  );
  expect(row?.configuration).toMatchObject({ lightModel: "keep-me" });
  const queued = await items();
  expect(queued).toHaveLength(1);
  expect(queued[0]?.runAt.toISOString()).toBe("2026-11-20T10:15:00.000Z");
  expect(queued[0]?.tenant).toBe(owner);
});

test("改清单不动排队；同一份再存是补排，不多出一串；改间隔换新的一串", async () => {
  await asOwner(() => store.apply(owner, bot, { checklist: "看卡和邮件" }));
  expect(await items()).toHaveLength(1);
  await asOwner(() => store.apply(owner, bot, { enabled: true }));
  expect(await items()).toHaveLength(1);
  await asOwner(() => store.apply(owner, bot, { intervalMinutes: 30 }));
  const queued = await items();
  expect(queued).toHaveLength(2);
  expect(new Set(queued.map((item) => item.key.split(":")[1])).size).toBe(2);
});

test("关掉的不排；外部员工和不是自己的员工不让设", async () => {
  await asOwner(() => store.apply(owner, bot, { enabled: false }));
  const before = (await items()).length;
  await asOwner(() => store.apply(owner, bot, { checklist: "x" }));
  expect((await items()).length).toBe(before);
  expect(
    await asOwner(() =>
      store.apply(owner, `${prefix}-nobody`, { enabled: true }),
    ),
  ).toEqual({
    ok: false,
    why: "not_found",
  });
  const stranger = `${prefix}-stranger`;
  expect(
    await runAsTenant(stranger, () =>
      store.apply(stranger, bot, { enabled: true }),
    ),
  ).toMatchObject({
    ok: false,
  });
});

test("每天次数和巡检合起来数，超了 beginRun 答 capped、不写行", async () => {
  const limit = 3;
  const base = {
    ownerUserId: owner,
    agentId: bot,
    scheduledFor: new Date(),
    threadId: "t",
  };
  expect(
    await asOwner(() =>
      store.beginRun({ ...base, id: randomUUID(), dailyLimit: limit }),
    ),
  ).toBe(true);
  expect(
    await asOwner(() =>
      store.beginRun({ ...base, id: randomUUID(), dailyLimit: limit }),
    ),
  ).toBe(true);
  expect(await asOwner(() => store.runsToday(owner, bot))).toBe(2);
  // 巡检在同一个上限里占一个名额；没走到模型的 skipped 不占。
  const channel = `${prefix}-channel`;
  const setting = await asOwner(async () => {
    await db
      .insert(channels)
      .values({ id: channel, name: "hb", description: "" });
    return createProactiveStore(db).create(
      owner,
      { agentId: bot, channelId: channel, subject: "邮件" },
      randomUUID(),
    );
  });
  const checkIn = (outcome: "quiet" | "skipped") => ({
    id: randomUUID(),
    settingId: setting.id,
    ownerUserId: owner,
    agentId: bot,
    trigger: "schedule" as const,
    outcome,
    finishedAt: new Date(),
    ...(outcome === "skipped" ? { skipReason: "capped" as const } : {}),
  });
  await asOwner(() =>
    db
      .insert(proactiveCheckInRuns)
      .values([checkIn("quiet"), checkIn("skipped")]),
  );
  expect(await asOwner(() => store.runsToday(owner, bot))).toBe(3);
  expect(
    await asOwner(() =>
      store.beginRun({ ...base, id: randomUUID(), dailyLimit: 3 }),
    ),
  ).toBe("capped");
  await asOwner(() =>
    db
      .delete(proactiveCheckInRuns)
      .where(eq(proactiveCheckInRuns.settingId, setting.id)),
  );
  await asOwner(() =>
    db.delete(proactiveSettings).where(eq(proactiveSettings.id, setting.id)),
  );
  await asOwner(() => db.delete(channels).where(eq(channels.id, channel)));
  expect(await asOwner(() => store.runsToday(owner, bot))).toBe(2);
});

test("没事的醒来在库里只留一行 quiet：不写对话、不发通知", async () => {
  await asOwner(() =>
    store.apply(owner, bot, {
      enabled: true,
      intervalMinutes: 15,
      checklist: "看卡",
    }),
  );
  const [first] = await items();
  const chain = (await asOwner(() => store.read(bot)))?.heartbeat?.chain ?? "";
  const key = `${bot}:${chain}:2026-11-20T10:15Z`;
  await asPlatform(() =>
    db
      .update(workItems)
      .set({ runAt: new Date("2026-11-20T00:00:00Z") })
      .where(and(eq(workItems.kind, HEARTBEAT_KIND), eq(workItems.key, key))),
  );
  void first;
  let spoke = 0;
  const runner = createHeartbeatRunner({
    queue,
    store,
    owner: "test-heartbeat",
    runTurn: async () => ({ replyText: "HEARTBEAT_OK" }),
    mintThreadId: () => `${prefix}-thread`,
    actorFor: async () => ({ id: owner, role: "user" as const }),
    channels: {
      direct: async () => {
        spoke += 1;
        throw new Error("no conversation expected");
      },
      recordActivity: async () => {
        spoke += 1;
      },
    },
    dailyRuns: async () => 100,
    notify: async () => {
      spoke += 1;
    },
    now: () => clock,
  });
  const before = await asOwner(() =>
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, bot)),
  );
  const report = await asPlatform(() => runner.sweep());
  expect(report.ran).toEqual([{ key, outcome: "quiet" }]);
  expect(spoke).toBe(0);
  const after = await asOwner(() =>
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, bot)),
  );
  expect(after.length - before.length).toBe(1);
  expect(after.find((row) => row.outcome === "quiet")?.cardsClaimed).toBe(0);
  clock = new Date(clock.getTime());
});

test("心跳和巡检双向共用上限：心跳用满后巡检开不了，巡检用满后心跳开不了；只认领卡的醒来不占名额", async () => {
  const channel = `${prefix}-channel2`;
  const proactive = createProactiveStore(db);
  const other = `${prefix}-bot2`;
  const setting = await asOwner(async () => {
    await db.insert(agents).values({ id: other, name: other, type: "built_in", configuration: {} });
    await db.insert(channels).values({ id: channel, name: "hb2", description: "" });
    return proactive.create(owner, { agentId: other, channelId: channel, subject: "邮件" }, randomUUID());
  });
  const base = { ownerUserId: owner, agentId: other, scheduledFor: new Date() };
  // 只认领卡的醒来（没有线程）不占名额。
  await asOwner(() => store.beginRun({ ...base, id: randomUUID(), threadId: null, dailyLimit: null }));
  expect(await asOwner(() => store.runsToday(owner, other))).toBe(0);
  // 心跳用掉 1 个名额，上限 1：巡检再开一次被挡。
  expect(await asOwner(() => store.beginRun({ ...base, id: randomUUID(), threadId: "t", dailyLimit: 1 }))).toBe(true);
  expect(
    await asOwner(() =>
      proactive.beginRun({ id: randomUUID(), setting, trigger: "schedule", threadId: "p", dailyLimit: 1 }),
    ),
  ).toBe("capped");
  // 反过来：清掉心跳的账，巡检先开一次，心跳再开被挡。
  await asOwner(() => db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, other)));
  expect(
    await asOwner(() =>
      proactive.beginRun({ id: randomUUID(), setting, trigger: "schedule", threadId: "p2", dailyLimit: 1 }),
    ),
  ).toBe(true);
  expect(await asOwner(() => store.beginRun({ ...base, id: randomUUID(), threadId: "t2", dailyLimit: 1 }))).toBe("capped");
  await asOwner(async () => {
    await db.delete(proactiveCheckInRuns).where(eq(proactiveCheckInRuns.settingId, setting.id));
    await db.delete(proactiveSettings).where(eq(proactiveSettings.id, setting.id));
    await db.delete(channels).where(eq(channels.id, channel));
    await db.delete(agents).where(eq(agents.id, other));
  });
});
