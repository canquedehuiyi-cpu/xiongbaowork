import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import { proactiveSettings } from "../src/db/schema/proactive";
import { workItems } from "../src/db/schema/work";
import { createDeliveryStore } from "../src/delivery/store";
import { createProactiveStore } from "../src/proactive/store";
import { runAsTenant } from "../src/tenant/context";
import {
  createQuietUntil,
  createUserPreferencesStore,
} from "../src/user-preferences";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 安静时段（期 3·3.2）里碰数据库的那几处，用真库：本人存的时段怎么读出来、合并和读回，推迟的通知在队列里的
 * 「最早可领时刻」，巡检推迟下一次的写法（只往后推，不往前拉）。
 */
const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefs = createUserPreferencesStore(db);
const delivery = createDeliveryStore(db);
const proactive = createProactiveStore(db);
const prefix = `quiet-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const channel = `${prefix}-channel`;
const asOwner = <T>(work: () => T): T => runAsTenant(owner, work);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);

beforeAll(async () => {
  await asOwner(async () => {
    await db
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` });
    await db.insert(agents).values({
      id: bot,
      name: "Quiet test Bot",
      type: "built_in",
      configuration: {},
    });
    await db
      .insert(channels)
      .values({ id: channel, name: "Quiet test", description: "" });
  });
});
afterAll(async () => {
  await asPlatform(async () => {
    await db.delete(users).where(eq(users.id, owner));
    await db.delete(channels).where(eq(channels.id, channel));
    await db.delete(agents).where(eq(agents.id, bot));
  });
  await db.$client.end({ timeout: 5 });
});

test("没存过的人读到默认的安静时段和作息里的时区；存一项不冲掉别的；通用的读不带它", async () => {
  await asOwner(async () => {
    expect(await prefs.quietHours?.read(owner)).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
      timeZone: "Asia/Shanghai",
    });
    expect(await prefs.quietHours?.patch(owner, { start: "23:00" })).toEqual({
      enabled: true,
      start: "23:00",
      end: "08:00",
      timeZone: "Asia/Shanghai",
    });
    expect(await prefs.quietHours?.patch(owner, { enabled: false })).toEqual({
      enabled: false,
      start: "23:00",
      end: "08:00",
      timeZone: "Asia/Shanghai",
    });
    expect(await createUserPreferencesStore(db).read(owner)).not.toHaveProperty(
      "quietHours",
    );
    await prefs.quietHours?.patch(owner, { enabled: true, start: "22:00" });
  });
});

test("createQuietUntil 按本人存的时段答结束时刻；关掉的、紧急的答 null", async () => {
  const quietUntil = createQuietUntil(db);
  // 上海 23:30（UTC 15:30）在 22:00 到 08:00 里，结束是 UTC 次日 00:00。
  expect(
    (
      await quietUntil(owner, { now: new Date("2026-11-20T15:30:00Z") })
    )?.toISOString(),
  ).toBe("2026-11-21T00:00:00.000Z");
  // 上海 12:00 不在里面。
  expect(
    await quietUntil(owner, { now: new Date("2026-11-20T04:00:00Z") }),
  ).toBeNull();
  expect(
    await quietUntil(owner, {
      now: new Date("2026-11-20T15:30:00Z"),
      urgent: true,
    }),
  ).toBeNull();
  await asOwner(() => prefs.quietHours?.patch(owner, { enabled: false }));
  expect(
    await quietUntil(owner, { now: new Date("2026-11-20T15:30:00Z") }),
  ).toBeNull();
  await asOwner(() => prefs.quietHours?.patch(owner, { enabled: true }));
  // 查不到的人不拦。
  expect(
    await quietUntil(`${prefix}-nobody`, {
      now: new Date("2026-11-20T15:30:00Z"),
    }),
  ).toBeNull();
});

test("推迟的通知写进发件箱，队列里的最早可领时刻就是时段结束", async () => {
  const until = new Date(Date.now() + 6 * 60 * 60_000);
  const row = await asOwner(() =>
    delivery.offerOutbox({
      ownerUserId: owner,
      channelId: channel,
      agentId: bot,
      threadId: `${prefix}-thread`,
      dedupeKey: `${prefix}:held`,
      bindingId: null,
      deviceId: null,
      transport: "slack",
      text: "有事找你",
      kind: "attention",
      requestId: null,
      runAt: until,
    }),
  );
  if (!row) throw new Error("expected an outbox row");
  const [item] = await asPlatform(() =>
    db
      .select({ runAt: workItems.runAt })
      .from(workItems)
      .where(
        and(eq(workItems.kind, "delivery.outbound"), eq(workItems.key, row.id)),
      ),
  );
  expect(item?.runAt.toISOString()).toBe(until.toISOString());
  // 没有 runAt 的照旧立刻可领。
  const now = await asOwner(() =>
    delivery.offerOutbox({
      ownerUserId: owner,
      channelId: channel,
      agentId: bot,
      threadId: `${prefix}-thread`,
      dedupeKey: `${prefix}:now`,
      bindingId: null,
      deviceId: null,
      transport: "slack",
      text: "你好",
      kind: "reply",
      requestId: null,
    }),
  );
  if (!now) throw new Error("expected an outbox row");
  const [immediate] = await asPlatform(() =>
    db
      .select({ runAt: workItems.runAt })
      .from(workItems)
      .where(
        and(eq(workItems.kind, "delivery.outbound"), eq(workItems.key, now.id)),
      ),
  );
  expect((immediate?.runAt.getTime() ?? 0) <= Date.now() + 1_000).toBe(true);
  await asPlatform(() =>
    db
      .delete(workItems)
      .where(
        and(eq(workItems.kind, "delivery.outbound"), eq(workItems.key, row.id)),
      ),
  );
  await asPlatform(() =>
    db
      .delete(workItems)
      .where(
        and(eq(workItems.kind, "delivery.outbound"), eq(workItems.key, now.id)),
      ),
  );
});

test("巡检的下一次只往后推到时段结束，不往前拉", async () => {
  const setting = await asOwner(() =>
    proactive.create(
      owner,
      { agentId: bot, channelId: channel, subject: "邮件" },
      randomUUID(),
    ),
  );
  const nextRunAt = async () =>
    (
      await asOwner(() =>
        db
          .select({ at: proactiveSettings.nextRunAt })
          .from(proactiveSettings)
          .where(eq(proactiveSettings.id, setting.id)),
      )
    )[0]?.at;
  const soon = new Date(Date.now() + 10 * 60_000);
  const later = new Date(Date.now() + 8 * 60 * 60_000);
  await asOwner(() =>
    db
      .update(proactiveSettings)
      .set({ nextRunAt: soon })
      .where(eq(proactiveSettings.id, setting.id)),
  );
  await asOwner(() => proactive.deferNextRun(setting.id, later));
  expect((await nextRunAt())?.toISOString()).toBe(later.toISOString());
  // 已经比这更晚的，不被拉回来。
  await asOwner(() => proactive.deferNextRun(setting.id, soon));
  expect((await nextRunAt())?.toISOString()).toBe(later.toISOString());
  await asOwner(() =>
    db.delete(proactiveSettings).where(eq(proactiveSettings.id, setting.id)),
  );
});
