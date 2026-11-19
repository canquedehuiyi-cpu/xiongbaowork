import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { BotPausedError } from "../src/agents/lifecycle";
import { createBotLifecycleRoutes } from "../src/agents/lifecycle-routes";
import { createWakeUpRunner, type WakeUpPayload } from "../src/agents/wake-up";
import type {
  AgentTrailQuery,
  AgentTrailReader,
  AuditEventInput,
} from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import type { OpenBotRole } from "../src/auth/roles";
import { currentTenant, runAsTenant } from "../src/tenant/context";

const ACTOR = { id: "u1", email: "person@openbot.test", role: "user" } as const;

type Actor = { id: string; email: string; role: "admin" | "user" };

function app(
  options: {
    actor?: Actor;
    auditTrail?: AgentTrailReader | null;
    /** The roles the admin scope re-reads for the actor; absent means no admin scope is wired. */
    roles?: OpenBotRole[];
  } = {},
) {
  const rows: AuditEventInput[] = [];
  const calls: string[] = [];
  const state = { paused: false, notify: "all" as string };
  const services = {
    lifecycle: {
      get: async () => ({
        agentId: "bot-1",
        paused: state.paused,
        pausedAt: null,
        notify: state.notify,
      }),
      pause: async (owner: string) => {
        calls.push(`pause:${owner}`);
        state.paused = true;
        return 2;
      },
      resume: async () => {
        state.paused = false;
      },
      setNotify: async (_o: string, _a: string, notify: string) => {
        state.notify = notify;
      },
      pausedFor: async () => (state.paused ? ["bot-1"] : []),
      notifyFor: async () => ({}),
      routing: async () => ({
        progress: "all",
        decision: "all",
        question: "all",
      }),
      setRouting: async () => {},
    },
    reset: {
      plan: async () => ({ conversations: 3 }),
      execute: async (actor: { id: string }) => {
        calls.push(`reset:${actor.id}`);
        return { conversations: 3 };
      },
    },
    activity: {
      forBot: async () => ({ inProgress: [], scheduled: [], completed: [] }),
      stopHandoff: async (_o: string, _a: string, key: string) =>
        key === "hop-1" ? { key, toBotId: "bot-2" } : null,
      attention: async () => [
        {
          agentId: "bot-1",
          questions: 1,
          approvals: 0,
          handoffs: 0,
          unread: 2,
          items: 3,
        },
        {
          agentId: "hidden-bot",
          questions: 4,
          approvals: 0,
          handoffs: 0,
          unread: 0,
          items: 1,
        },
      ],
      lastPing: async () => "ping-7",
      waitingIn: async () =>
        new Map([
          ["bot-1", "channel-asking"],
          ["hidden-bot", "channel-hidden"],
        ]),
    },
    tasks: {
      counts: async () => [
        { agentId: "bot-1", needsInput: 1, ready: 2, failed: 0 },
        { agentId: "bot-2", needsInput: 0, ready: 0, failed: 0 },
        { agentId: "hidden-bot", needsInput: 1, ready: 0, failed: 0 },
      ],
    },
    wakeUps: { cancel: async () => true },
    profiles: {
      get: async (_actor: unknown, id: string) =>
        id === "bot-1"
          ? { id: "bot-1", name: "Sales", ownerUserId: "owner-1" }
          : // Another person's private Bot: no person's frame finds it, only `platform` does.
            id === "private-bot" && currentTenant() === "platform"
            ? { id: "private-bot", name: "Ledger", ownerUserId: "owner-2" }
            : null,
    },
    auditStore: {
      insert: async (event: AuditEventInput) => void rows.push(event),
    },
    ...(options.auditTrail ? { auditTrail: options.auditTrail } : {}),
  } as never;
  const requireUser = async (
    context: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    const actor = options.actor ?? ACTOR;
    context.set("actor", actor);
    // In the signed-in person's own frame, as `createRequireUser` runs every request.
    await runAsTenant(actor.id, () => next());
  };
  const roles = options.roles;
  const adminScope = roles
    ? createAdminScope({ roleRepository: { rolesForUser: async () => roles } })
    : undefined;
  const hono = new Hono().route(
    "/api/bots",
    createBotLifecycleRoutes(services, requireUser as never, adminScope),
  );
  return { rows, calls, hono, state };
}

const post = (body?: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("Bot lifecycle routes", () => {
  test("pause and resume act for the caller and are audited", async () => {
    const { rows, calls, hono } = app();
    const paused = await hono.request("http://t/api/bots/bot-1/pause", post());
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      lifecycle: { paused: true },
      stoppedTurns: 2,
    });
    expect(calls).toEqual(["pause:u1"]);
    await hono.request("http://t/api/bots/bot-1/resume", post());
    expect(rows.map((row) => row.eventType)).toEqual([
      "bot.paused",
      "bot.resumed",
    ]);
    expect(rows[0]?.payload.stoppedTurns).toBe(2);
  });

  test("a Bot the caller cannot reach is not found, and nothing happens", async () => {
    const { rows, calls, hono } = app();
    const response = await hono.request(
      "http://t/api/bots/someone-elses/pause",
      post(),
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("reset shows its notice first and refuses without an explicit confirm", async () => {
    const { rows, calls, hono } = app();
    const notice = await hono.request("http://t/api/bots/bot-1/reset");
    expect(await notice.json()).toEqual({ plan: { conversations: 3 } });
    const refused = await hono.request(
      "http://t/api/bots/bot-1/reset",
      post({}),
    );
    expect(refused.status).toBe(400);
    expect(calls).toEqual([]);
    const done = await hono.request(
      "http://t/api/bots/bot-1/reset",
      post({ confirm: true }),
    );
    expect(done.status).toBe(200);
    expect(calls).toEqual(["reset:u1"]);
    expect(rows[0]?.eventType).toBe("bot.reset");
  });

  test("notification preference is validated and audited", async () => {
    const { rows, hono } = app();
    const bad = await hono.request("http://t/api/bots/bot-1/notifications", {
      ...post({ notify: "loud" }),
      method: "PUT",
    });
    expect(bad.status).toBe(400);
    const good = await hono.request("http://t/api/bots/bot-1/notifications", {
      ...post({ notify: "needs_input" }),
      method: "PUT",
    });
    expect(await good.json()).toMatchObject({
      lifecycle: { notify: "needs_input" },
    });
    expect(rows[0]?.eventType).toBe("bot.notifications_changed");
  });

  test("attention lists only Bots the caller can still reach", async () => {
    const { hono } = app();
    const response = await hono.request("http://t/api/bots/attention");
    const { bots } = (await response.json()) as { bots: { agentId: string }[] };
    expect(bots.map((row) => row.agentId)).toEqual(["bot-1"]);
  });

  test("attention carries each Bot's open items and the tasks that need the person, and the newest ping", async () => {
    const { hono } = app();
    const response = await hono.request("http://t/api/bots/attention");
    expect(await response.json()).toEqual({
      bots: [
        {
          agentId: "bot-1",
          name: "Sales",
          questions: 1,
          approvals: 0,
          handoffs: 0,
          unread: 2,
          paused: false,
          notify: "all",
          items: 3,
          tasks: { needsInput: 1, ready: 2, failed: 0 },
          waitingIn: "channel-asking",
        },
      ],
      lastPingId: "ping-7",
    });
  });

  test("stopping a delegated task is audited; an unknown one is a 404", async () => {
    const { rows, hono } = app();
    const missing = await hono.request(
      "http://t/api/bots/bot-1/activity/handoffs/stop",
      post({ id: "nope" }),
    );
    expect(missing.status).toBe(404);
    const stopped = await hono.request(
      "http://t/api/bots/bot-1/activity/handoffs/stop",
      post({ id: "hop-1" }),
    );
    expect(stopped.status).toBe(200);
    expect(rows[0]).toMatchObject({
      eventType: "bot.handoff_stopped",
      payload: { hop: "hop-1", to: "bot-2" },
    });
  });
});

describe("an agent's audit trail route", () => {
  const EVENT = {
    id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
    actorUserId: "u1",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "bot.paused",
    targetType: "agent",
    targetId: "bot-1",
    payload: { bot: "bot-1" },
    createdAt: "2026-11-01T10:00:00.000Z",
  };
  const VALID_CURSOR = Buffer.from(
    JSON.stringify({ id: EVENT.id, createdAt: "2026-11-01T10:00:00.000000Z" }),
  ).toString("base64url");

  function trail(nextCursor?: string) {
    const queries: AgentTrailQuery[] = [];
    // The frame each read ran in: the caller's own, or `platform` for an administrator.
    const frames: string[] = [];
    const reader: AgentTrailReader = {
      listAgentTrail: async (query) => {
        queries.push(query);
        frames.push(currentTenant());
        return { events: [EVENT], ...(nextCursor ? { nextCursor } : {}) };
      },
    };
    return { queries, frames, reader };
  }

  test("a Bot the caller cannot reach is not found, and the trail is never read", async () => {
    const { queries, reader } = trail();
    const { hono } = app({ auditTrail: reader });
    const response = await hono.request(
      "http://t/api/bots/someone-elses/audit",
    );
    expect(response.status).toBe(404);
    expect(queries).toEqual([]);
  });

  test("without a trail reader the route answers 503", async () => {
    const { hono } = app({ auditTrail: null });
    const response = await hono.request("http://t/api/bots/bot-1/audit");
    expect(response.status).toBe(503);
  });

  test("a cursor or limit the server cannot read is a 400, and the trail is never read", async () => {
    const { queries, reader } = trail();
    const { hono } = app({ auditTrail: reader });
    const badCursor = await hono.request(
      "http://t/api/bots/bot-1/audit?cursor=not-a-cursor",
    );
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({
      error: "cursor must be a valid audit page cursor",
    });
    const badLimit = await hono.request(
      "http://t/api/bots/bot-1/audit?limit=abc",
    );
    expect(badLimit.status).toBe(400);
    expect(queries).toEqual([]);
  });

  test("a colleague who does not own the Bot is limited to their own rows", async () => {
    const { queries, frames, reader } = trail("next-page");
    const { hono } = app({ auditTrail: reader });
    const response = await hono.request("http://t/api/bots/bot-1/audit");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scope: "own",
      events: [EVENT],
      nextCursor: "next-page",
    });
    expect(queries).toEqual([
      { agentId: "bot-1", viewerUserId: "u1", seesEveryone: false, limit: 50 },
    ]);
    expect(frames).toEqual(["u1"]);
  });

  test("the owner sees everyone's rows, and the page it asked for is forwarded", async () => {
    const { queries, frames, reader } = trail();
    const { hono } = app({
      actor: { id: "owner-1", email: "owner@openbot.test", role: "user" },
      auditTrail: reader,
    });
    const response = await hono.request(
      `http://t/api/bots/bot-1/audit?limit=500&cursor=${VALID_CURSOR}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.scope).toBe("everyone");
    expect(body).not.toHaveProperty("nextCursor");
    expect(queries).toEqual([
      {
        agentId: "bot-1",
        viewerUserId: "owner-1",
        seesEveryone: true,
        limit: 100,
        cursor: VALID_CURSOR,
      },
    ]);
    // In the owner's own frame: row-level security keeps it to the rows filed in their tenant.
    expect(frames).toEqual(["owner-1"]);
  });

  test("an administrator holding the capability sees everyone's rows on a Bot they do not own, as platform", async () => {
    const { queries, frames, reader } = trail();
    const { hono } = app({
      actor: { id: "admin-1", email: "admin@openbot.test", role: "admin" },
      auditTrail: reader,
      roles: ["admin"],
    });
    const response = await hono.request("http://t/api/bots/bot-1/audit");
    expect(((await response.json()) as { scope: string }).scope).toBe(
      "everyone",
    );
    expect(queries[0]).toMatchObject({
      viewerUserId: "admin-1",
      seesEveryone: true,
    });
    expect(frames).toEqual(["platform"]);
  });

  test("an administrator holding the capability reads the trail of another person's private Bot", async () => {
    const { queries, frames, reader } = trail();
    const { hono } = app({
      actor: { id: "admin-1", email: "admin@openbot.test", role: "admin" },
      auditTrail: reader,
      roles: ["admin"],
    });
    const response = await hono.request("http://t/api/bots/private-bot/audit");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { scope: string }).scope).toBe(
      "everyone",
    );
    expect(queries).toEqual([
      {
        agentId: "private-bot",
        viewerUserId: "admin-1",
        seesEveryone: true,
        limit: 50,
      },
    ]);
    expect(frames).toEqual(["platform"]);
  });

  test("another person's private Bot stays not found without the capability", async () => {
    for (const options of [
      {},
      {
        actor: {
          id: "admin-1",
          email: "admin@openbot.test",
          role: "admin",
        } as Actor,
        roles: ["user"] as OpenBotRole[],
      },
      {
        actor: {
          id: "admin-1",
          email: "admin@openbot.test",
          role: "admin",
        } as Actor,
      },
    ]) {
      const { queries, reader } = trail();
      const { hono } = app({ ...options, auditTrail: reader });
      const response = await hono.request(
        "http://t/api/bots/private-bot/audit",
      );
      expect(response.status).toBe(404);
      expect(queries).toEqual([]);
    }
  });

  test("an administrator whose role was removed since sign-in is answered as anyone", async () => {
    const { queries, frames, reader } = trail();
    const { hono } = app({
      actor: { id: "admin-1", email: "admin@openbot.test", role: "admin" },
      auditTrail: reader,
      roles: ["user"],
    });
    const response = await hono.request("http://t/api/bots/bot-1/audit");
    expect(((await response.json()) as { scope: string }).scope).toBe("own");
    expect(queries[0]).toMatchObject({ seesEveryone: false });
    expect(frames).toEqual(["admin-1"]);
  });

  test("with no admin scope wired an administrator is answered as anyone, in their own frame", async () => {
    const { queries, frames, reader } = trail();
    const { hono } = app({
      actor: { id: "admin-1", email: "admin@openbot.test", role: "admin" },
      auditTrail: reader,
    });
    const response = await hono.request("http://t/api/bots/bot-1/audit");
    expect(((await response.json()) as { scope: string }).scope).toBe("own");
    expect(queries[0]).toMatchObject({ seesEveryone: false });
    expect(frames).toEqual(["admin-1"]);
  });
});

describe("follow-up runner", () => {
  const payload: WakeUpPayload = {
    ownerUserId: "u1",
    agentId: "bot-1",
    reason: "check the build",
    dueAt: new Date().toISOString(),
    scheduledAt: new Date().toISOString(),
  };
  function runner(
    runTurn: () => Promise<{ replyText: string }>,
    claimed: { tenantId?: string } = {},
  ) {
    const settled: string[] = [];
    const said: string[] = [];
    const notified: string[] = [];
    const instructions: string[] = [];
    /** The tenant the turn and the settle each ran as. */
    const tenants = { turn: [] as string[], settle: [] as string[] };
    const wake = createWakeUpRunner({
      queue: {
        claim: async () => [
          {
            kind: "bot.wakeup",
            // The stamp on the row is the trusted tenant; the payload's owner only has to agree.
            // An explicit undefined is a row stamped as nobody's, not the default stamp: a row the
            // types say cannot exist, which is exactly what the runner must refuse.
            tenantId: ("tenantId" in claimed
              ? claimed.tenantId
              : payload.ownerUserId) as string,
            key: "w1",
            payload,
            attempts: 1,
          },
        ],
        finish: async () => true,
        purge: async () => 0,
      },
      store: {
        settle: async (_id: string, outcome: { status: string }) => {
          tenants.settle.push(currentTenant());
          settled.push(outcome.status);
        },
      } as never,
      owner: "replica",
      actorFor: async (id) => ({ id, role: "user" }),
      channels: {
        get: async () => null,
        direct: async () => ({
          id: "c1",
          threadId: "t1",
          name: "",
          agentIds: [],
          active: true,
          lastMessageAt: null,
        }),
        recordActivity: async (_a, _c, activity) =>
          void said.push(activity.text),
      },
      runTurn: async (input) => {
        instructions.push(input.instruction);
        tenants.turn.push(currentTenant());
        return runTurn();
      },
      notify: async (_scope, input) => void notified.push(input.text),
    });
    return { wake, settled, said, notified, instructions, tenants };
  }

  test("a due follow-up runs one turn in the person's conversation and tells them", async () => {
    const { wake, settled, said, notified, instructions } = runner(
      async () => ({
        replyText: "The build is green.",
      }),
    );
    expect(await wake.sweep()).toEqual({ ran: ["w1"], skipped: [] });
    expect(instructions[0]).toContain("check the build");
    expect(said).toEqual(["The build is green."]);
    expect(notified).toEqual(["The build is green."]);
    expect(settled).toEqual(["succeeded"]);
  });

  test("a paused Bot's follow-up is skipped and nothing is said", async () => {
    const { wake, settled, said, notified } = runner(async () => {
      throw new BotPausedError();
    });
    expect(await wake.sweep()).toEqual({ ran: [], skipped: ["w1"] });
    expect(settled).toEqual(["skipped"]);
    expect(said).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("a failed turn is recorded once and never retried", async () => {
    const { wake, settled } = runner(async () => {
      throw new Error("model refused");
    });
    await wake.sweep();
    expect(settled).toEqual(["failed"]);
  });

  /*
   * G01: the follow-up runs as the person on its row. The sweep is a timer with no tenant of its
   * own, so without this the turn, the settle and the reply all ran as `system`.
   */
  test("a follow-up runs as the tenant stamped on its row", async () => {
    const { wake, tenants } = runner(async () => ({ replyText: "Done." }));
    expect(await wake.sweep()).toEqual({ ran: ["w1"], skipped: [] });
    expect(tenants.turn).toEqual(["u1"]);
    expect(tenants.settle).toEqual(["u1"]);
  });

  test("a follow-up stamped as nobody's is failed and never run", async () => {
    for (const stamped of ["system", "platform", undefined]) {
      const { wake, settled, said, instructions } = runner(
        async () => ({ replyText: "should not run" }),
        { tenantId: stamped },
      );
      expect(await wake.sweep()).toEqual({ ran: [], skipped: ["w1"] });
      expect(instructions).toEqual([]);
      expect(said).toEqual([]);
      expect(settled).toEqual(["failed"]);
    }
  });

  test("a follow-up whose owner is not the tenant on its row is refused", async () => {
    const { wake, settled, instructions } = runner(
      async () => ({ replyText: "should not run" }),
      { tenantId: "u2" },
    );
    expect(await wake.sweep()).toEqual({ ran: [], skipped: ["w1"] });
    expect(instructions).toEqual([]);
    expect(settled).toEqual(["failed"]);
  });
});
