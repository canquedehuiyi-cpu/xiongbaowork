/**
 * The Bot profile's own routes: pause and resume, reset, notifications, update routing, Activity,
 * and the attention badges the sidebar draws.
 *
 * EVERYTHING HERE IS THE CALLER'S OWN. Each route acts on the signed-in person's relationship with a
 * Bot, never on the Bot for everybody: pausing a public coworker stops the work done in your name,
 * and resetting it forgets what it knew about you. The Bot must be one the caller can reach, asked
 * of the profile store the way every other Bot route asks; a Bot they cannot see is "not found".
 */
import { isDevActorEmail } from "../auth/dev-actor-email";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ActivityStore } from "../activity/activity";
import type { AgentTrailReader, AuditEventType, AuditStore } from "../audit";
import {
  AuditQueryError,
  agentTrailPageFromUrl,
  recordAuditEvent,
} from "../audit";
import type { AdminScope } from "../auth/admin-scope";
import type { AppVariables } from "../auth/guards";
import { capabilityFor } from "../tenant/context";
import type {
  AttentionResponse,
  BotAttentionPayload,
  TaskService,
} from "../proactive/contracts";
import {
  type BotLifecycleStore,
  type BotNotify,
  UPDATE_KINDS,
  UPDATE_TRANSPORTS,
  type UpdateKind,
  type UpdateTransport,
} from "./lifecycle";
import type { BotReset } from "./lifecycle-reset";
import type { AgentActor, AgentProfile } from "./profile-types";
import type { WakeUpStore } from "./wake-up";

const NOTIFY_VALUES: readonly BotNotify[] = ["all", "needs_input", "none"];

export type BotLifecycleServices = {
  lifecycle: BotLifecycleStore;
  reset: BotReset;
  activity: ActivityStore;
  wakeUps: WakeUpStore;
  profiles: {
    get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  };
  /** The person's tasks that need them, per Bot (`tasks/*`). Without it, every count is nought. */
  tasks?: Pick<TaskService, "counts">;
  auditStore?: AuditStore;
  /** Reads one agent's trail for its detail page; absent means the trail answers 503. */
  auditTrail?: AgentTrailReader;
};

export function createBotLifecycleRoutes(
  services: BotLifecycleServices,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * How an administrator reads a Bot's whole trail (G01-E I5): every row is filed in the tenant of
   * the person it is about, so only `platform` reads across them, and only an administrator who
   * holds the capability in this request gets there. Absent, an administrator is answered as anyone.
   */
  adminScope?: Pick<AdminScope, "adminCapability" | "asAdminPlatform">,
) {
  const {
    lifecycle,
    reset,
    activity,
    wakeUps,
    profiles,
    tasks,
    auditStore,
    auditTrail,
  } = services;
  const routes = new Hono<{ Variables: AppVariables }>();
  type C = Context<{ Variables: AppVariables }>;

  const record = async (
    context: C,
    eventType: Extract<AuditEventType, `bot.${string}`>,
    agentId: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && !isDevActorEmail(actor.email)
          ? { actorUserId: actor.id }
          : {}),
        payload: { bot: agentId, actor: actor?.email ?? "unknown", ...payload },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  /** The Bot, if the caller may reach it; otherwise the route has already answered 404. */
  const reachable = async (context: C): Promise<AgentProfile | Response> => {
    const agentId = context.req.param("agentId") ?? "";
    if (!agentId.trim())
      return context.json({ error: "A Bot id is required." }, 400);
    const agent = await profiles.get(context.var.actor, agentId);
    if (!agent) return context.json({ error: "Couldn't find that Bot." }, 404);
    return agent;
  };

  const body = async (context: C) =>
    ((await context.req.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >;

  /**
   * Every Bot that needs the caller, or has something unread, or is paused by them: questions,
   * approvals, stalled hand-offs, open items from check-ins and tasks that need them. With the
   * person's newest ping, which the app notifies once for, however many items it carried.
   */
  routes.get("/attention", requireUser, async (context) => {
    const ownerUserId = context.var.actor.id;
    const [counts, paused, taskCounts, lastPingId, waitingIn] =
      await Promise.all([
        activity.attention(ownerUserId),
        lifecycle.pausedFor(ownerUserId),
        tasks?.counts(ownerUserId) ?? Promise.resolve([]),
        activity.lastPing(ownerUserId),
        activity.waitingIn(ownerUserId),
      ]);
    const ids = [
      ...new Set([
        ...counts.map((row) => row.agentId),
        ...taskCounts
          .filter((row) => row.needsInput + row.ready + row.failed > 0)
          .map((row) => row.agentId),
        ...paused,
      ]),
    ];
    const notify = await lifecycle.notifyFor(ownerUserId, ids);
    const byId = new Map(counts.map((row) => [row.agentId, row]));
    const tasksById = new Map(taskCounts.map((row) => [row.agentId, row]));
    // Only Bots the caller can still reach: a count about a Bot they lost access to names it.
    const bots: BotAttentionPayload[] = [];
    for (const agentId of ids) {
      const agent = await profiles.get(context.var.actor, agentId);
      if (!agent) continue;
      const row = byId.get(agentId);
      const task = tasksById.get(agentId);
      const asks =
        (row?.questions ?? 0) +
        (row?.approvals ?? 0) +
        (row?.handoffs ?? 0) +
        (task?.needsInput ?? 0);
      bots.push({
        agentId,
        name: agent.name,
        questions: row?.questions ?? 0,
        approvals: row?.approvals ?? 0,
        handoffs: row?.handoffs ?? 0,
        unread: row?.unread ?? 0,
        paused: paused.includes(agentId),
        notify: notify[agentId] ?? "all",
        items: row?.items ?? 0,
        tasks: {
          needsInput: task?.needsInput ?? 0,
          ready: task?.ready ?? 0,
          failed: task?.failed ?? 0,
        },
        waitingIn: asks > 0 ? (waitingIn.get(agentId) ?? null) : null,
      });
    }
    return context.json({ bots, lastPingId } satisfies AttentionResponse);
  });

  routes.get("/routing", requireUser, async (context) =>
    context.json({ routing: await lifecycle.routing(context.var.actor.id) }),
  );

  routes.put("/routing/:kind", requireUser, async (context) => {
    const kind = context.req.param("kind") as UpdateKind;
    if (!UPDATE_KINDS.includes(kind))
      return context.json({ error: "Unknown kind of update." }, 400);
    const { transports } = await body(context);
    const value =
      transports === "all"
        ? "all"
        : Array.isArray(transports) &&
            transports.every((transport) =>
              UPDATE_TRANSPORTS.includes(transport as UpdateTransport),
            )
          ? (transports as UpdateTransport[])
          : null;
    if (value === null)
      return context.json(
        { error: "Choose slack, sms and push, or all of them." },
        400,
      );
    await lifecycle.setRouting(context.var.actor.id, kind, value);
    return context.json({
      routing: await lifecycle.routing(context.var.actor.id),
    });
  });

  routes.get("/:agentId/lifecycle", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
    });
  });

  routes.post("/:agentId/pause", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const stopped = await lifecycle.pause(context.var.actor.id, agent.id);
    await record(context, "bot.paused", agent.id, { stoppedTurns: stopped });
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
      stoppedTurns: stopped,
    });
  });

  routes.post("/:agentId/resume", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    await lifecycle.resume(context.var.actor.id, agent.id);
    await record(context, "bot.resumed", agent.id);
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
    });
  });

  routes.put("/:agentId/notifications", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const { notify } = await body(context);
    if (!NOTIFY_VALUES.includes(notify as BotNotify))
      return context.json({ error: "Choose all, needs_input or none." }, 400);
    await lifecycle.setNotify(
      context.var.actor.id,
      agent.id,
      notify as BotNotify,
    );
    await record(context, "bot.notifications_changed", agent.id, { notify });
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
    });
  });

  /** The notice: what a reset would delete, per kind, before anything is. */
  routes.get("/:agentId/reset", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    return context.json({
      plan: await reset.plan(context.var.actor.id, agent.id),
    });
  });

  routes.post("/:agentId/reset", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const { confirm } = await body(context);
    if (confirm !== true)
      return context.json(
        { error: "A reset deletes data. Confirm it explicitly." },
        400,
      );
    const deleted = await reset.execute(context.var.actor, agent.id);
    await record(context, "bot.reset", agent.id, { deleted });
    return context.json({ deleted });
  });

  routes.get("/:agentId/activity", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    return context.json({
      activity: await activity.forBot(context.var.actor.id, agent.id),
    });
  });

  /**
   * The Bot's recent audit trail, for the employee detail page (story D5).
   *
   * GET /api/bots/:agentId/audit?limit=1..100&cursor=…
   * → 200 { scope: "everyone" | "own", events: AuditEvent[], nextCursor?: string }
   *
   * Each event is `{ id, eventType, actorUserId, initiatorKind, initiatorId, targetType, targetId,
   * payload, createdAt }`, newest first; pass `nextCursor` back as `cursor` for the next page.
   *
   * The Bot's owner and an administrator see what everybody and the system did to it (`scope:
   * "everyone"`); anybody else who can reach it sees only what they did (`scope: "own"`). Either way
   * a row about one person's own relationship with the Bot — pausing, muting, resetting it — is shown
   * only to that person. 404 when the Bot is not reachable, 400 for a bad `limit` or `cursor`, 503
   * when no trail reader is wired.
   *
   * WHICH ROWS EXIST TO BE SEEN is the frame's (G01-E I1). The owner reads in their own frame, so
   * "everybody" means every row filed in the owner's tenant: their own, the system's and background
   * work's on their behalf, and an administrator's acting as them. What a colleague did to a shared
   * Bot is filed in the colleague's tenant and stays out of the owner's page. Only an administrator
   * holding the capability reads the Bot's rows across every tenant, as `platform`.
   *
   * WHICH BOTS: what the caller's own frame reaches, and for that administrator also another
   * person's private Bot, found as `platform` the way `GET /api/agents/:agentId` finds it for the
   * admin pages. Without that, the profile page an administrator opened answered 404 here.
   */
  routes.get(
    "/:agentId/audit",
    requireUser,
    adminScope?.adminCapability ?? ((_context, next) => next()),
    async (context) => {
      const actor = context.var.actor;
      // The admin door, only for an administrator who holds the capability in this request: a role
      // removed since sign-in, or a deployment with no admin scope, is answered as anyone.
      const admin =
        adminScope &&
        actor.role === "admin" &&
        capabilityFor(actor.id) === "admin"
          ? adminScope
          : undefined;
      const agentId = context.req.param("agentId") ?? "";
      if (!agentId.trim())
        return context.json({ error: "A Bot id is required." }, 400);
      const agent =
        (await profiles.get(actor, agentId)) ??
        // Somebody else's private Bot, reached from the admin pages only, as `platform`.
        (admin
          ? await admin.asAdminPlatform(actor, () =>
              profiles.get(actor, agentId),
            )
          : null);
      if (!agent) return context.json({ error: "Agent not found." }, 404);
      if (!auditTrail)
        return context.json({ error: "Audit logging is not configured." }, 503);
      const seesEveryone =
        admin !== undefined ||
        (typeof agent.ownerUserId === "string" &&
          agent.ownerUserId === actor.id);
      try {
        const page = agentTrailPageFromUrl(new URL(context.req.url));
        const query = {
          agentId: agent.id,
          viewerUserId: actor.id,
          seesEveryone,
          ...page,
        };
        const trail = admin
          ? await admin.asAdminPlatform(actor, () =>
              auditTrail.listAgentTrail(query),
            )
          : await auditTrail.listAgentTrail(query);
        return context.json({
          scope: seesEveryone ? "everyone" : "own",
          events: trail.events,
          ...(trail.nextCursor ? { nextCursor: trail.nextCursor } : {}),
        });
      } catch (error) {
        if (error instanceof AuditQueryError)
          return context.json({ error: error.message }, 400);
        throw error;
      }
    },
  );

  routes.post(
    "/:agentId/activity/handoffs/stop",
    requireUser,
    async (context) => {
      const agent = await reachable(context);
      if (agent instanceof Response) return agent;
      const { id } = await body(context);
      if (typeof id !== "string" || !id)
        return context.json({ error: "Which delegated task?" }, 400);
      const stopped = await activity.stopHandoff(
        context.var.actor.id,
        agent.id,
        id,
      );
      if (!stopped)
        return context.json(
          { error: "That delegated task is not running or queued." },
          404,
        );
      await record(context, "bot.handoff_stopped", agent.id, {
        hop: stopped.key,
        to: stopped.toBotId,
      });
      return context.json({ stopped: true });
    },
  );

  routes.post("/:agentId/follow-ups/cancel", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const { id } = await body(context);
    if (typeof id !== "string" || !id)
      return context.json({ error: "Which follow-up?" }, 400);
    const cancelled = await wakeUps.cancel(context.var.actor.id, agent.id, id);
    if (!cancelled)
      return context.json(
        { error: "That follow-up has already run or was cancelled." },
        404,
      );
    return context.json({ cancelled: true });
  });

  return routes;
}
