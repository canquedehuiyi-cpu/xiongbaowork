import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHeartbeatRoutes } from "../src/agents/heartbeat-routes";
import type { HeartbeatStore } from "../src/heartbeat/store";
import { runAsTenant } from "../src/tenant/context";

/** 员工设置里心跳的读写接口（3.4 界面要用的）：谁能读、谁能改、写错了怎么说。 */
function app(
  options: { canSee?: boolean; owner?: boolean; apply?: unknown } = {},
) {
  const calls: unknown[] = [];
  const store = {
    read: async () => ({
      type: "built_in",
      heartbeat: {
        enabled: true,
        intervalMinutes: 30,
        checklist: "看卡",
        chain: "secret",
      },
    }),
    recent: async () => [{ id: "r1", outcome: "quiet" }],
    apply:
      options.apply ??
      (async (_o: string, _a: string, patch: unknown) => {
        calls.push(patch);
        return {
          ok: true,
          settings: { enabled: true, intervalMinutes: 30, checklist: "看卡" },
          scheduledFor: new Date("2026-11-20T10:30:00Z"),
        };
      }),
  } as unknown as HeartbeatStore;
  const routes = createHeartbeatRoutes({
    store,
    profiles: {
      get: async () =>
        options.canSee === false
          ? null
          : ({
              id: "bot",
              ownerUserId: options.owner === false ? "someone" : "alice",
              systemOwned: false,
              deletedAt: null,
            } as never),
    },
    requireUser: async (context, next) => {
      context.set("actor", {
        id: "alice",
        email: "a@example.com",
        role: "user",
      });
      await next();
    },
  });
  return { app: new Hono().route("/api/agents", routes), calls };
}
const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("心跳接口", () => {
  test("读：设置和最近几次，不带内部串号", async () => {
    const { app: a } = app();
    const response = await runAsTenant("alice", () =>
      a.request("/api/agents/bot/heartbeat"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      heartbeat: object;
      recent: unknown[];
    };
    expect(body.heartbeat).toEqual({
      enabled: true,
      intervalMinutes: 30,
      checklist: "看卡",
    });
    expect(body.recent).toHaveLength(1);
  });

  test("看不到的员工 404", async () => {
    const { app: a } = app({ canSee: false });
    expect((await a.request("/api/agents/bot/heartbeat")).status).toBe(404);
  });

  test("写：只带要改的几项，答新设置和下一次醒来的时刻", async () => {
    const { app: a, calls } = app();
    const response = await runAsTenant("alice", () =>
      a.request("/api/agents/bot/heartbeat", put({ intervalMinutes: 30 })),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ intervalMinutes: 30 }]);
    expect(((await response.json()) as { nextWakeAt: string }).nextWakeAt).toBe(
      "2026-11-20T10:30:00.000Z",
    );
  });

  test("间隔不到 15 分钟、清单太长、多余的键，400，不存", async () => {
    const { app: a, calls } = app();
    for (const body of [
      { intervalMinutes: 5 },
      { checklist: "x".repeat(2001) },
      { chain: "x" },
      {},
    ])
      expect(
        (await a.request("/api/agents/bot/heartbeat", put(body))).status,
      ).toBe(400);
    expect(calls).toEqual([]);
  });

  test("不是主人也不是管理员 403", async () => {
    const { app: a } = app({ owner: false });
    expect(
      (await a.request("/api/agents/bot/heartbeat", put({ enabled: true })))
        .status,
    ).toBe(403);
  });

  test("外部员工 400，归别人的员工 403", async () => {
    const external = app({
      apply: async () => ({ ok: false, why: "external" }),
    });
    expect(
      (
        await external.app.request(
          "/api/agents/bot/heartbeat",
          put({ enabled: true }),
        )
      ).status,
    ).toBe(400);
    const other = app({ apply: async () => ({ ok: false, why: "not_yours" }) });
    expect(
      (
        await other.app.request(
          "/api/agents/bot/heartbeat",
          put({ enabled: true }),
        )
      ).status,
    ).toBe(403);
  });
});
