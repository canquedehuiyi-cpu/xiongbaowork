import { describe, expect, test } from "bun:test";
import type { AgentChannel } from "../src/channels/routes";
import {
  createWakeUpRunner,
  WAKE_UP_KIND,
  type WakeUpStore,
} from "../src/agents/wake-up";
import {
  createQuietUntil,
  inQuietHours,
  type QuietUntil,
  type QuietUser,
  quietHoursEnd,
  quietHoursMode,
  quietHoursOf,
} from "../src/user-preferences";
import { createDeliveryRouter } from "../src/delivery/router";
import { createProactiveEngine } from "../src/proactive/engine";
import { runAsTenant } from "../src/tenant/context";
import { Hono } from "hono";
import { userPreferencesRoutes } from "../src/user-preferences-routes";
import {
  QuietHoursRefusedError,
  type UserPreferencesStore,
} from "../src/user-preferences";

/**
 * 安静时段（期 3·3.2）：判断本身（按本人时区、跨午夜、边界），和每个主动入口怎么用它：推迟、不丢、紧急的不拦。
 * 入口都用假的队列和存储，只看它们对队列说了什么。
 */

const shanghai = (
  start = "22:00",
  end = "08:00",
  enabled = true,
): QuietUser => ({
  quietHours: { enabled, start, end },
  timeZone: "Asia/Shanghai",
});
// 上海是 UTC+8：UTC 15:30 是上海 23:30，UTC 23:59 是上海次日 07:59，UTC 00:00 是上海 08:00。
const at = (iso: string) => new Date(iso);

describe("inQuietHours", () => {
  test("跨午夜：22:00 起算在内，次日 08:00 不在内", () => {
    const user = shanghai();
    expect(inQuietHours(user, at("2026-11-20T13:59:00Z"))).toBe(false); // 21:59
    expect(inQuietHours(user, at("2026-11-20T14:00:00Z"))).toBe(true); // 22:00
    expect(inQuietHours(user, at("2026-11-20T15:30:00Z"))).toBe(true); // 23:30
    expect(inQuietHours(user, at("2026-11-20T16:00:00Z"))).toBe(true); // 00:00
    expect(inQuietHours(user, at("2026-11-20T23:59:00Z"))).toBe(true); // 07:59
    expect(inQuietHours(user, at("2026-11-21T00:00:00Z"))).toBe(false); // 08:00
    expect(inQuietHours(user, at("2026-11-21T04:00:00Z"))).toBe(false); // 12:00
  });

  test("不跨午夜：13:00 到 14:00", () => {
    const user = shanghai("13:00", "14:00");
    expect(inQuietHours(user, at("2026-11-20T04:59:00Z"))).toBe(false); // 12:59
    expect(inQuietHours(user, at("2026-11-20T05:00:00Z"))).toBe(true); // 13:00
    expect(inQuietHours(user, at("2026-11-20T05:59:00Z"))).toBe(true); // 13:59
    expect(inQuietHours(user, at("2026-11-20T06:00:00Z"))).toBe(false); // 14:00
  });

  test("按本人的时区算，不是服务器的", () => {
    const user: QuietUser = {
      quietHours: { enabled: true, start: "22:00", end: "08:00" },
      timeZone: "America/New_York",
    };
    // UTC 03:00 是纽约前一天 22:00（冬令时 UTC-5），在内；UTC 15:00 是纽约 10:00，不在内。
    expect(inQuietHours(user, at("2026-11-20T03:00:00Z"))).toBe(true);
    expect(inQuietHours(user, at("2026-11-20T15:00:00Z"))).toBe(false);
  });

  test("关着、开始等于结束、整个部署关掉，都不算", () => {
    const now = at("2026-11-20T16:00:00Z");
    expect(inQuietHours(shanghai("22:00", "08:00", false), now)).toBe(false);
    expect(inQuietHours(shanghai("22:00", "22:00"), now)).toBe(false);
    expect(inQuietHours(shanghai(), now, "off")).toBe(false);
  });
});

describe("quietHoursEnd", () => {
  test("不在安静时段是 null，在里面是结束那一分钟", () => {
    const user = shanghai();
    expect(quietHoursEnd(user, at("2026-11-20T04:00:00Z"))).toBeNull();
    expect(quietHoursEnd(user, at("2026-11-20T15:30:00Z"))?.toISOString()).toBe(
      "2026-11-21T00:00:00.000Z",
    );
    expect(quietHoursEnd(user, at("2026-11-20T23:59:30Z"))?.toISOString()).toBe(
      "2026-11-21T00:00:00.000Z",
    );
  });
});

describe("quietHoursOf and the deployment mode", () => {
  test("没存过：默认 22:00 到 08:00 开着；opt-in 下没存过就是关；存过的就算本人选了", () => {
    expect(quietHoursOf({}, "on")).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
    });
    expect(quietHoursOf({}, "opt-in").enabled).toBe(false);
    expect(quietHoursOf({ quietHours: { start: "23:00" } }, "opt-in")).toEqual({
      enabled: true,
      start: "23:00",
      end: "08:00",
    });
    expect(quietHoursOf({ quietHours: { enabled: false } }, "on").enabled).toBe(
      false,
    );
  });

  test("存坏了的时刻回到默认，不会让整天都安静", () => {
    expect(
      quietHoursOf({ quietHours: { start: "25:99", end: "nope" } }, "on"),
    ).toEqual({ enabled: true, start: "22:00", end: "08:00" });
  });

  test("XIONGBAO_QUIET_HOURS 只认 off 和 opt-in，别的都是 on", () => {
    expect(quietHoursMode({})).toBe("on");
    expect(quietHoursMode({ XIONGBAO_QUIET_HOURS: "OFF" })).toBe("off");
    expect(quietHoursMode({ XIONGBAO_QUIET_HOURS: "opt-in" })).toBe("opt-in");
    expect(quietHoursMode({ XIONGBAO_QUIET_HOURS: "whatever" })).toBe("on");
  });

  test("紧急的永远不拦，也不去读本人的设置", async () => {
    const database = {
      select() {
        throw new Error("urgent must not read preferences");
      },
    };
    const until = createQuietUntil(database as never);
    expect(await until("someone", { urgent: true })).toBeNull();
  });
});

/** 固定在上海 23:30 的安静时段里，结束是次日上海 08:00。 */
const resting: QuietUntil = async (_owner, options) =>
  options?.urgent ? null : new Date("2026-11-21T00:00:00Z");
const awake: QuietUntil = async () => null;
const NIGHT = new Date("2026-11-20T15:30:00Z");

describe("跟进（wake_up）", () => {
  function runner(quietUntil: QuietUntil, payload: Record<string, unknown>) {
    const released: Record<string, unknown>[] = [];
    let turns = 0;
    const wake = createWakeUpRunner({
      queue: {
        claim: async () => [
          {
            kind: WAKE_UP_KIND,
            key: "wake:1",
            tenantId: "alice",
            payload: {
              ownerUserId: "alice",
              agentId: "bot",
              reason: "check the build",
              dueAt: NIGHT.toISOString(),
              scheduledAt: NIGHT.toISOString(),
              ...payload,
            },
            attempts: 1,
          },
        ],
        finish: async () => true,
        purge: async () => 0,
        release: async (input: Record<string, unknown>) => {
          released.push(input);
          return true;
        },
      },
      store: { settle: async () => {} } as unknown as WakeUpStore,
      owner: "test",
      actorFor: async () => ({ id: "alice", role: "user" as const }),
      channels: {
        get: async () => null,
        direct: async () =>
          ({ id: "c1", threadId: "t1" }) as unknown as AgentChannel,
        recordActivity: async () => {},
      },
      runTurn: async () => {
        turns += 1;
        return { replyText: "done" };
      },
      quietUntil,
    });
    return { wake, released, turns: () => turns };
  }

  test("安静时段里到点：放回队列推迟到时段结束，不算一次尝试，这一轮没有开", async () => {
    const { wake, released, turns } = runner(resting, {});
    const report = await runAsTenant("platform", () => wake.sweep());
    expect(turns()).toBe(0);
    expect(report.ran).toEqual([]);
    expect(report.deferred).toEqual(["wake:1"]);
    expect(released).toHaveLength(1);
    expect(released[0]?.uncounted).toBe(true);
    expect(released[0]?.delayMs as number).toBeGreaterThan(0);
  });

  test("带 urgent 的跟进不拦", async () => {
    const { wake, released, turns } = runner(resting, { urgent: true });
    const report = await runAsTenant("platform", () => wake.sweep());
    expect(released).toHaveLength(0);
    expect(turns()).toBe(1);
    expect(report.ran).toEqual(["wake:1"]);
  });

  test("不在安静时段照旧，报告里也没有 deferred 这一项", async () => {
    const { wake, turns } = runner(awake, {});
    const report = await runAsTenant("platform", () => wake.sweep());
    expect(turns()).toBe(1);
    expect(report).toEqual({ ran: ["wake:1"], skipped: [] });
  });
});

describe("通知投递", () => {
  type Row = { kind: string; transport: string; runAt?: Date };
  function router(quietUntil: QuietUntil | undefined) {
    const rows: Row[] = [];
    const binding = {
      id: "b1",
      ownerUserId: "alice",
      channelId: "c1",
      agentId: "bot",
      threadId: "t1",
      transport: "slack",
      optedOutAt: null,
    };
    const scope = {
      ownerUserId: "alice",
      channelId: "c1",
      agentId: "bot",
      threadId: "t1",
    };
    const store = {
      bindingsByUse: async () => [binding],
      bindingsFor: async () => [binding],
      devices: async () => [{ id: "d1" }],
      checkInConversations: async () => [{ agentId: "bot", channelId: "c1" }],
      offerOutbox: async (row: Row) => {
        rows.push(row);
        return { id: "x" };
      },
      outboxByKey: async () => null,
      latestInbox: async () => null,
    };
    const deliveries = createDeliveryRouter({
      store: store as never,
      queue: {} as never,
      owner: "test",
      providers: { slack: {} as never, push: {} as never },
      authoriseScope: async () => true,
      scopeFor: async () => scope,
      runTurn: async () => ({ replyText: "" }),
      routeFor: async () => ({ allows: () => true, notify: true }) as never,
      ...(quietUntil ? { quietUntil } : {}),
    });
    return { deliveries, rows, scope };
  }

  test("巡检的「有事找你」在安静时段里照常写进发件箱，但推迟到时段结束", async () => {
    const { deliveries, rows } = router(resting);
    await runAsTenant("alice", () =>
      deliveries.notifyAttention({
        ownerUserId: "alice",
        pingId: "p1",
        text: "有事找你",
        pushBody: "两件事",
        items: [{ suggestionId: "s1" }],
      } as never),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(row.runAt?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
  });

  test("人不在时的「这一轮结束了」也推迟；对话里的回复不推迟；紧急的不推迟", async () => {
    const { deliveries, rows, scope } = router(resting);
    await runAsTenant("alice", async () => {
      await deliveries.notify(scope, {
        id: "away-1",
        kind: "reply",
        text: "做完了",
        away: { push: true, chat: true, chatText: "做完了" },
      });
      await deliveries.notify(scope, {
        id: "reply-1",
        kind: "reply",
        text: "你好",
      });
      await deliveries.notify(scope, {
        id: "away-2",
        kind: "reply",
        text: "线上出事了",
        urgent: true,
        away: { push: true, chat: true, chatText: "线上出事了" },
      });
    });
    const by = (text: string) =>
      rows.filter((row) => (row as unknown as { text: string }).text === text);
    expect(by("做完了").length).toBeGreaterThan(0);
    for (const row of by("做完了")) expect(row.runAt).toBeDefined();
    for (const row of by("你好")) expect(row).not.toHaveProperty("runAt");
    for (const row of by("线上出事了")) expect(row).not.toHaveProperty("runAt");
  });

  test("没接安静时段的路由行为不变", async () => {
    const { deliveries, rows } = router(undefined);
    await runAsTenant("alice", () =>
      deliveries.notifyAttention({
        ownerUserId: "alice",
        pingId: "p2",
        text: "有事找你",
        pushBody: "x",
        items: [{ suggestionId: "s1" }],
      } as never),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty("runAt");
  });
});

describe("巡检", () => {
  function engine(quietUntil: QuietUntil) {
    const deferred: { id: string; until: Date }[] = [];
    let turns = 0;
    let offered: {
      kind: string;
      key: string;
      payload: Record<string, unknown>;
    } | null = null;
    const setting = {
      id: "s1",
      tenantId: "alice",
      ownerUserId: "alice",
      agentId: "bot",
      channelId: "c1",
      enabled: true,
      focus: "",
      subject: "",
      sourceLink: null,
      intervalMinutes: 60,
    };
    const finished: string[] = [];
    const proactive = createProactiveEngine({
      store: {
        closeStaleRuns: async () => 0,
        pings: { unoffered: async () => [], waiting: async () => [] },
        claimDue: async () => [setting],
        byId: async () => setting,
        deferNextRun: async (id: string, until: Date) => {
          deferred.push({ id, until });
        },
      } as never,
      queue: {
        offer: async (item: never) => {
          offered = item;
          return "queued" as const;
        },
        claim: async () =>
          offered
            ? [
                {
                  ...(offered as object),
                  tenantId: "alice",
                  attempts: 1,
                },
              ]
            : [],
        renew: async () => true,
        finish: async (input: { key: string }) => {
          finished.push(input.key);
          return true;
        },
        release: async () => true,
      } as never,
      owner: "test",
      runTurn: async () => {
        turns += 1;
        return { replyText: "" };
      },
      resolveScope: async () => null,
      attention: { notifyAttention: async () => {} } as never,
      catalogue: { listServers: async () => [] },
      mintThreadId: () => "thread",
      quietUntil,
    } as never);
    return { proactive, deferred, turns: () => turns, finished };
  }

  test("定时的巡检在安静时段里不开：这一次不跑，下一次推到时段结束，也没有开轮", async () => {
    const { proactive, deferred, turns, finished } = engine(resting);
    await runAsTenant("platform", () => proactive.sweep());
    expect(turns()).toBe(0);
    expect(deferred).toEqual([
      { id: "s1", until: new Date("2026-11-21T00:00:00Z") },
    ]);
    expect(finished).toHaveLength(1);
  });
});

describe("安静时段的读写接口", () => {
  function app(override: { patch?: () => Promise<unknown> } = {}) {
    let saved = {
      enabled: true,
      start: "22:00",
      end: "08:00",
      timeZone: "Asia/Shanghai",
    };
    const store = {
      claimStarterTour: async () => {},
      read: async () => {
        throw new Error("通用读不是这里要的");
      },
      patch: async () => {
        throw new Error("通用保存不是这里要的");
      },
      quietHours: {
        read: async () => saved,
        patch: async (_id: string, patch: object) => {
          if (override.patch) return override.patch();
          saved = { ...saved, ...patch };
          return saved;
        },
      },
    } as unknown as UserPreferencesStore;
    return new Hono().route(
      "/api/settings/preferences",
      userPreferencesRoutes(async (context, next) => {
        context.set("actor", {
          id: "alice",
          email: "alice@example.com",
          role: "user",
        });
        await next();
      }, store),
    );
  }
  const call = (path: string, init?: RequestInit) =>
    app().request(`/api/settings/preferences${path}`, init);
  const patch = (body: unknown) => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  test("读出开关、起止和时区", async () => {
    const response = await call("/quiet-hours");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      quietHours: {
        enabled: true,
        start: "22:00",
        end: "08:00",
        timeZone: "Asia/Shanghai",
      },
    });
  });

  test("只改一项，别的留着", async () => {
    const response = await call("/quiet-hours", patch({ start: "23:30" }));
    expect(response.status).toBe(200);
    expect(
      (
        (await response.json()) as {
          quietHours: { start: string; end: string };
        }
      ).quietHours,
    ).toMatchObject({ start: "23:30", end: "08:00" });
  });

  test("检查之后别处又改了起止、库里把它拦下：同样是 400，不是 500", async () => {
    const response = await runAsTenant("alice", () =>
      app({
        patch: async () => {
          throw new QuietHoursRefusedError("start equals end");
        },
      }).request("/api/settings/preferences/quiet-hours", patch({ end: "07:00" })),
    );
    expect(response.status).toBe(400);
  });

  test("时刻写错、空的、多余的键、起止相同，都是 400", async () => {
    for (const body of [
      { start: "25:00" },
      {},
      { enabled: "yes" },
      { timeZone: "UTC" },
      { start: "08:00" },
    ])
      expect((await call("/quiet-hours", patch(body))).status).toBe(400);
  });
});
