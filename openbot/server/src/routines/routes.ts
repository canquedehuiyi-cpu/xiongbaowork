import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { RoutineRunner } from "./runner";
import { MINIMUM_INTERVAL_MS } from "./schedule";
import {
  RoutineLimitError,
  RoutineNotFoundError,
  RoutineRefusedError,
  type RoutineRunOutcome,
  type RoutineStore,
  type RoutineSummary,
} from "./store";

export type { RoutineStore } from "./store";

/**
 * The routines page: what a person's standing instructions are, how to add one, and a switch to stop one.
 *
 * THERE IS NO EDIT ENDPOINT. `update` is the conversational tool path's; the page changes a schedule by
 * switching one off and writing another. A form that could rewrite a running routine's cron in place would
 * need the same care about the next occurrence as the create below, for a feature nobody asked for.
 *
 * CREATE IS FOR THE PAGE, AND ONLY FOR THE PAGE (spec C4, ticket WP-2.2). Composing a routine out of a
 * sentence stays conversational — the four `RoutineTools` a Bot calls mid-chat in
 * `plugins/builtin-routines.ts` — because the hard part of that is turning prose into a cron and a channel.
 * What the page needs is the other half: the person already knows the schedule they want, and making them
 * ask a Bot for it is a detour the original product does not make. So `POST /` takes a coworker, an
 * instruction and a cron and adds NOTHING of its own — the fifteen-minute floor, the twenty-routine cap,
 * the instruction limits and the "which conversation did you mean" question all stay in `store.ts` and
 * `schedule.ts` and are inherited by the call there. A second copy of a guardrail is a guardrail that
 * drifts, and the store's refusals are already written to be read aloud.
 *
 * THERE IS ALSO NO GET-BY-ID. A routine id is never a page's own state — nothing links to one, and
 * nothing needs to fetch one in isolation — so the list is the read, the same way the channel
 * roster is a list with no companion single-channel screen.
 *
 * Owner-scoped through the store on every route, never by filtering a broader read afterwards:
 * `listFor`, `create`, `setEnabled` and `remove` all take the caller's id and answer as if a routine that
 * belongs to somebody else does not exist, which is what keeps a wrong id and somebody else's id
 * indistinguishable from outside.
 */
export function createRoutineRoutes(
  routineStore: RoutineStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: {
    runner?: RoutineRunner;
    auditStore?: AuditStore;
    /**
     * May this caller have this coworker at all? Asked only by `POST /`.
     *
     * Optional because every other route here works off a routine the caller already owns and never names a
     * coworker. Absent means the question is not asked — which is what the tool path and the existing tests
     * do; production wires the profile store's own answer.
     */
    canUseBot?: BotAccessCheck;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * The page's 新建. See the header above for why this exists and what it deliberately does not do.
   */
  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
      instruction?: unknown;
      cron?: unknown;
      timezone?: unknown;
      channelId?: unknown;
    } | null;
    const agentId =
      typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const instruction =
      typeof body?.instruction === "string" ? body.instruction : "";
    const cron = typeof body?.cron === "string" ? body.cron.trim() : "";
    /*
     * Shape only, and nothing about the schedule or the coworker is decided here. The store owns the
     * instruction's length cap and the floor and the channel question; this guard exists so a form that sent
     * an empty body is refused as a bad request rather than reaching the store with `undefined` in a
     * not-null column.
     */
    if (!agentId || !instruction.trim() || !cron) {
      return context.json(
        {
          error: "A routine needs a coworker, an instruction, and a schedule.",
        },
        400,
      );
    }
    /*
     * Spec D15 on the way in: a coworker belonging to another workspace is answered exactly like one that
     * does not exist. Without this the store's own refusal ("You are in no channel with me") would confirm
     * that the id resolves to a real coworker somewhere else, and the person would get a sentence about a
     * conversation they cannot join for a mistake they cannot see.
     */
    if (
      options.canUseBot &&
      !(await options.canUseBot(context.var.actor, agentId))
    ) {
      return context.json({ error: "There is no such coworker here." }, 404);
    }
    const timezone =
      typeof body?.timezone === "string" && body.timezone.trim()
        ? body.timezone
        : undefined;
    const channelId =
      typeof body?.channelId === "string" && body.channelId.trim()
        ? body.channelId
        : undefined;
    try {
      const created = await routineStore.create({
        ownerUserId: context.var.actor.id,
        agentId,
        instruction,
        cron,
        ...(timezone ? { timezone } : {}),
        ...(channelId ? { channelId } : {}),
      });
      if (options.auditStore) {
        await recordAuditEvent(options.auditStore, {
          eventType: "routine.created",
          targetType: "routine",
          targetId: created.id,
          actorUserId: context.var.actor.id,
          payload: { cron: created.cron, agentId: created.agentId },
        }).catch(() => undefined);
      }
      /*
       * The row is read back through the list rather than re-shaped here.
       *
       * `RoutineDto` is built from a `RoutineSummary`, and only `listFor` computes the schedule's words and
       * the channel's name. Returning the freshly inserted row would mean a second implementation of that
       * sentence — and a card the page just added reading differently from the card it then reloads.
       */
      const rows = await routineStore.listFor(context.var.actor.id);
      const row = rows.find((summary) => summary.id === created.id);
      // The list is the caller's own, and the create just committed, so its absence is a broken
      // database rather than a race — and saying so is louder than answering with a half-shaped card.
      if (!row)
        throw new Error("a routine that was just created is not on the list");
      return context.json({ routine: routineDto(row) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Run now — the page's Test button. It DOES REAL WORK: the routine's Bot runs its instruction in
   * the routine's channel exactly as a scheduled firing would, through the same runner and headless
   * AG-UI path. A paused routine is refused (paused never runs), and so is a second click while a
   * run is still open.
   */
  if (options.runner) {
    const runner = options.runner;
    routes.post("/:id/run", requireUser, async (context) => {
      const id = context.req.param("id");
      try {
        const { runId } = await routineStore.startManualRun(
          context.var.actor.id,
          id,
        );
        if (options.auditStore)
          await recordAuditEvent(options.auditStore, {
            eventType: "routines.run_requested",
            targetType: "routine",
            targetId: id,
            actorUserId: context.var.actor.id,
            payload: { runId, source: "manual" },
          }).catch(() => undefined);
        void runner.run(runId).catch(() => {});
        return context.json({ accepted: true, runId }, 202);
      } catch (error) {
        return mapStoreError(context, error);
      }
    });
  }

  routes.get("/:id/runs", requireUser, async (context) => {
    try {
      const runs = await routineStore.listRuns(
        context.var.actor.id,
        context.req.param("id"),
      );
      return context.json({
        runs: runs.map((run) => ({
          id: run.id,
          status: run.status ?? "running",
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          error: run.error,
          source: run.source,
        })),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    const [routines, sweptAt] = await Promise.all([
      routineStore.listFor(context.var.actor.id),
      routineStore.lastSweptAt().catch(() => null),
    ]);
    return context.json({
      routines: routines.map(routineDto),
      sweep: sweepDto(sweptAt),
    });
  });

  routes.put("/:id/enabled", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return context.json({ error: "enabled must be true or false." }, 400);
    }
    // An empty id would reach the store and answer 500 on some backends instead of a 400 for a
    // malformed call. Owner-scoping stays in the store; shape is checked here.
    const id = context.req.param("id");
    if (!id.trim()) {
      return context.json({ error: "A routine id is required." }, 400);
    }

    try {
      await routineStore.setEnabled(context.var.actor.id, id, enabled);
      return context.json({ enabled });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    if (!id.trim()) {
      return context.json({ error: "A routine id is required." }, 400);
    }
    try {
      await routineStore.remove(context.var.actor.id, id);
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/**
 * One row of the routines page.
 *
 * THE DTO CARRIES THE WORDS, NOT THE CRON. The client never parses a schedule, so words-from-cron is
 * computed once, server-side, by the same library that decides when a routine actually fires — there
 * is no second implementation of cron-to-English anywhere to drift out of step with it. `schedule` is
 * opaque display text, never a value to parse: prose for the shapes `describeCron` recognizes, and
 * the raw five-field expression for everything stranger than that. `nextRunAt` is the one place a
 * time is computed, and it is computed the same way, by `nextOccurrence`.
 */
type RoutineDto = {
  id: string;
  /** Which Bot carries it out, so a Bot's own screen can show only its routines. */
  agentId: string;
  schedule: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  lastRun: { status: RoutineRunOutcome | null; at: string | null } | null;
};

export const SWEEP_SILENCE_MS = MINIMUM_INTERVAL_MS;

type SweepDto = {
  lastSweptAt: string | null;
  working: boolean;
};

function sweepDto(sweptAt: Date | null, now = new Date()): SweepDto {
  return {
    lastSweptAt: sweptAt?.toISOString() ?? null,
    working:
      sweptAt !== null && now.getTime() - sweptAt.getTime() <= SWEEP_SILENCE_MS,
  };
}

function routineDto(routine: RoutineSummary): RoutineDto {
  return {
    id: routine.id,
    agentId: routine.agentId,
    schedule: routine.schedule,
    timezone: routine.timezone,
    instruction: routine.instruction,
    channel: {
      id: routine.channelId,
      name: routine.channelName,
      gone: routine.channelDeleted,
    },
    enabled: routine.enabled,
    nextRunAt: routine.nextRunAt.toISOString(),
    lastRun: routine.lastRun
      ? {
          status: routine.lastRun.status,
          at: routine.lastRun.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  // The store's own sentence, verbatim: it already reads the same whether the id belongs to nobody
  // or to somebody else, which is what keeps ownership unprobeable from out here.
  if (error instanceof RoutineNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  /*
   * Asked before the general refusal, because the limit IS one: the sentence is the store's either way,
   * and the status is what tells the screen to offer "switch one off" instead of "fix your schedule".
   */
  if (error instanceof RoutineLimitError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof RoutineRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
