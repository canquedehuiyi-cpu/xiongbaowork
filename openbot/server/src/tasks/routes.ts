import { and, asc, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  groupBotThreads,
  groupTaskRuns,
  intelligenceChannelMappings,
  modelUsage,
  tasks,
} from "../db/schema";
import type { TaskProjector } from "./projector";

type Ctx = { Variables: AppVariables };

const PERIODS: Record<string, number> = {
  week: 7 * 86400000,
  month: 30 * 86400000,
};

/** What a uuid looks like, asked of a path parameter before it reaches a uuid column. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a card's "打开" lands, in the three shapes the board's screens take: a one-coworker
 * conversation, a group conversation, or a crew run.
 */
export type TaskOpenTarget = {
  kind: "channel" | "group" | "pipeline";
  id: string;
};

/** The rows the resolver needs, which is a projection of a task row and nothing more. */
type OpenTargetRow = {
  id: string;
  source: string;
  channelRef: string | null;
  runRef: string | null;
  parentTaskId: string | null;
};

/**
 * Which conversation or run each card on the page opens, in one batched read.
 *
 * `tasks.channel_ref` was never one column's meaning, and the board learned this the hard way (audit N1:
 * fifteen cards, not one working link). A routine writes a CHANNEL id, a group's answer writes a CHANNEL
 * id, the conversation runner writes the THREAD id it ran in (`threads/postgres-runner.ts`) and so does a
 * hand-off (`agents/handoff-delivery.ts`), and a crew's two cards write nothing at all. A thread id is not
 * a channel id — `channel_d049…` owns `55569917-…` — so a screen that builds `/channel/$ref` out of
 * whichever arrived is a dead link for three of the four shapes.
 *
 * RESOLVED AT READ, NOT WRITTEN AT WRITE. Rewriting the column would need a migration over history whose
 * answer is a guess (a thread id does not say which of the two tables mapped it), and every write site
 * would have to keep the new rule forever. Here, four tenant-scoped lookups answer for the whole page, and
 * cards that were written years ago become correct on the next fetch.
 *
 * Everything is filtered by WHOSE it is, not merely by the row existing: `channel_memberships.user_id`,
 * `intelligence_channel_mappings.user_id`, `group_bot_threads.owner_user_id`, `group_task_runs.tenant_id`.
 * The mapping tables would resolve another workspace's thread id quite happily, and a board that links
 * into somebody else's conversation is worse than one with a dead link (spec D15's 404-not-403, applied to
 * a read). Nothing found is `null`, and `null` is the answer the screen renders as "对话已不在" rather than
 * as a href.
 */
async function openTargetsFor(
  database: Database,
  tenantId: string,
  rows: OpenTargetRow[],
): Promise<Map<string, TaskOpenTarget | null>> {
  const targets = new Map<string, TaskOpenTarget | null>();
  const refs = [
    ...new Set(
      rows
        .map((row) => row.channelRef)
        .filter((ref): ref is string => typeof ref === "string" && ref !== ""),
    ),
  ];

  /** Channel ids the caller is a member of, so a `channel_ref` cannot name somebody else's room. */
  const mine = new Set<string>();
  /** Thread ids of this caller's own one-coworker conversations. */
  const byThread = new Map<string, string>();
  /** Thread ids of this caller's Bots inside a group — a hop answered in one of those. */
  const byGroupThread = new Map<string, string>();
  if (refs.length > 0) {
    for (const row of await database
      .select({ channelId: channelMemberships.channelId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.userId, tenantId),
          inArray(channelMemberships.channelId, refs),
        ),
      )) {
      mine.add(row.channelId);
    }
    for (const row of await database
      .select({
        channelId: intelligenceChannelMappings.channelId,
        threadId: intelligenceChannelMappings.threadId,
      })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.userId, tenantId),
          inArray(intelligenceChannelMappings.threadId, refs),
        ),
      )) {
      byThread.set(row.threadId, row.channelId);
    }
    for (const row of await database
      .select({
        channelId: groupBotThreads.channelId,
        threadId: groupBotThreads.threadId,
      })
      .from(groupBotThreads)
      .where(
        and(
          eq(groupBotThreads.ownerUserId, tenantId),
          inArray(groupBotThreads.threadId, refs),
        ),
      )) {
      byGroupThread.set(row.threadId, row.channelId);
    }
  }

  /** Which of this caller's conversations a `channel_ref` names — a channel, or a thread that maps to one. */
  const channelOf = (row: OpenTargetRow): string | null => {
    const ref = row.channelRef;
    if (!ref) return null;
    if (mine.has(ref)) return ref;
    return byThread.get(ref) ?? byGroupThread.get(ref) ?? null;
  };

  /*
   * One coworker, or several? The sidebar's own rule (`app-sidebar/channel.tsx`) sends a channel with more
   * than one Bot to `/group/$channelId`, because that transcript is shared and the other is not. The board
   * has to agree with the sidebar or the same conversation opens in two screens, so this asks the same
   * question the same way — how many Bots are linked in.
   */
  const channelIds = [
    ...new Set(rows.map(channelOf).filter((id): id is string => id !== null)),
  ];
  const coworkers = new Map<string, number>();
  if (channelIds.length > 0) {
    for (const row of await database
      .select({
        channelId: channelAgents.channelId,
        agentId: channelAgents.agentId,
      })
      .from(channelAgents)
      .where(
        and(
          eq(channelAgents.tenantId, tenantId),
          inArray(channelAgents.channelId, channelIds),
        ),
      )) {
      coworkers.set(row.channelId, (coworkers.get(row.channelId) ?? 0) + 1);
    }
  }

  /*
   * The crew's cards, which name no conversation at all.
   *
   * A parent's run reference IS the run id (`pipeline/store.ts`), but a step's is that step's own turn —
   * which is also what parks the card on an approval, so it cannot change. The step therefore reaches the
   * run through the parent it hangs under, in one read for the whole page.
   */
  const parentIds = [
    ...new Set(
      rows
        .filter((row) => row.source === "group_run" && row.parentTaskId)
        .map((row) => row.parentTaskId as string),
    ),
  ];
  const parentRunRef = new Map<string, string>();
  if (parentIds.length > 0) {
    for (const row of await database
      .select({ id: tasks.id, runRef: tasks.runRef })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), inArray(tasks.id, parentIds)))) {
      if (row.runRef) parentRunRef.set(row.id, row.runRef);
    }
  }
  const runIds = [
    ...new Set(
      rows
        .filter((row) => row.source === "group_run")
        .map((row) =>
          row.parentTaskId
            ? (parentRunRef.get(row.parentTaskId) ?? "")
            : (row.runRef ?? ""),
        )
        .filter((id) => id !== ""),
    ),
  ];
  const runsAboard = new Set<string>();
  if (runIds.length > 0) {
    for (const row of await database
      .select({ id: groupTaskRuns.id })
      .from(groupTaskRuns)
      .where(
        and(
          eq(groupTaskRuns.tenantId, tenantId),
          inArray(groupTaskRuns.id, runIds),
        ),
      )) {
      runsAboard.add(row.id);
    }
  }

  for (const row of rows) {
    if (row.source === "group_run") {
      const runId = row.parentTaskId
        ? (parentRunRef.get(row.parentTaskId) ?? null)
        : (row.runRef ?? null);
      targets.set(
        row.id,
        runId && runsAboard.has(runId) ? { kind: "pipeline", id: runId } : null,
      );
      continue;
    }
    const ref = row.channelRef;
    if (!ref) {
      targets.set(row.id, null);
      continue;
    }
    const channelId = channelOf(row);
    targets.set(
      row.id,
      channelId
        ? {
            kind: (coworkers.get(channelId) ?? 0) > 1 ? "group" : "channel",
            id: channelId,
          }
        : null,
    );
  }
  return targets;
}

/**
 * The model each run answered with, read from the usage rows the gate already writes.
 *
 * One query for the page rather than one per card. The newest row for a run wins, because a run that
 * was retried after a refusal should be reported as what finally answered it.
 */
async function modelsForRuns(
  database: Database,
  runRefs: (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(runRefs.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({ runId: modelUsage.runId, model: modelUsage.model })
    .from(modelUsage)
    .where(inArray(modelUsage.runId, ids))
    .orderBy(asc(modelUsage.createdAt));
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.runId) latest.set(row.runId, row.model);
  }
  return latest;
}

/**
 * The board's read side: one list endpoint carrying every filter the screen exposes, and the two
 * human transitions (review, archive). There is deliberately no second read for the header counts --
 * the screen asks for its list once and counts what it was given, so the board cannot show two
 * different answers to "what is on it". Reads run under the caller's tenant scope the auth middleware
 * set; nothing here can cross it.
 */
export function createTaskRoutes(
  database: Database,
  requireUser: MiddlewareHandler<Ctx>,
  projector: TaskProjector,
) {
  const routes = new Hono<Ctx>();

  const filters = (context: {
    req: { query: (k: string) => string | undefined };
  }) => {
    const conditions = [];
    const status = context.req.query("status");
    const source = context.req.query("source");
    const executor = context.req.query("executor");
    const search = context.req.query("q");
    const period = context.req.query("period");
    // Which machine did the work — the board's other axis, and the one a person with a laptop and a
    // studio desktop needs, because "what is running at home" is not the same list as "what is
    // running on the train".
    const deviceId = context.req.query("deviceId");
    /*
     * A crew, not one coworker: `/wakers` names a group of them, and the board has to answer to that
     * name the same way a chat does. Comma-separated because the roster is short — a crew is three or
     * four coworkers, not a paginated set — and because a list of query parameters with the same name
     * would mean the screen builds one parameter per member instead of carrying the roster it already
     * has.
     */
    const executors = context.req.query("executors");
    if (status) conditions.push(eq(tasks.status, status as never));
    if (source) conditions.push(eq(tasks.source, source as never));
    if (executor) conditions.push(eq(tasks.executorAgentId, executor));
    // `!== undefined` rather than truthiness: `?executors=` with nothing after it is a crew that has
    // nobody in it, which is an answer — no work — and not the same as never being asked.
    if (executors !== undefined) {
      const ids = executors.split(",").filter((id) => id.length > 0);
      conditions.push(
        ids.length > 0 ? inArray(tasks.executorAgentId, ids) : sql`false`,
      );
    }
    if (search) conditions.push(like(tasks.title, `%${search}%`));
    if (deviceId) conditions.push(eq(tasks.deviceId, deviceId));
    const window = PERIODS[period ?? ""];
    if (window)
      conditions.push(gte(tasks.createdAt, new Date(Date.now() - window)));
    return conditions.length ? and(...conditions) : undefined;
  };

  routes.get("/", requireUser, async (context) => {
    const where = filters(context);
    const rows = await database
      .select()
      .from(tasks)
      .where(where)
      .orderBy(desc(tasks.updatedAt))
      .limit(200);
    const models = await modelsForRuns(
      database,
      rows.map((row) => row.runRef),
    );
    /*
     * Where each card opens, resolved for the whole page at once. See `openTargetsFor`.
     */
    const open = await openTargetsFor(
      database,
      context.var.actor.id,
      rows.map((row) => ({
        id: row.id,
        source: row.source,
        channelRef: row.channelRef,
        runRef: row.runRef,
        parentTaskId: row.parentTaskId,
      })),
    );
    /*
     * Which model answered each task, beside the task itself.
     *
     * The board's whole premise is that one lane can hold a developer's task and a reviewer's task
     * that ran on different models, so a card that cannot say which one answered is a card somebody
     * has to open. The answer is already on record in `model_usage` — written per run by the gate,
     * including a `bound` row for a coworker with its own model — so this reads it rather than
     * inventing a second account of it. A task with no usage row (a routine whose run never reached
     * a model, or one from before the gate was mounted) answers with null and shows as unset.
     */
    return context.json({
      tasks: rows.map((row) => ({
        ...row,
        model: row.runRef ? (models.get(row.runRef) ?? null) : null,
        open: open.get(row.id) ?? null,
      })),
    });
  });

  /*
   * Spec D15: "跨租户默认 404 而非 403". The projector's boolean cannot tell "not your card" from
   * "right card, wrong lane" — both come back false — and answering the second to a caller who cannot
   * see the first is a leak wearing a refusal: it confirms that the id exists somewhere. So existence
   * is asked first, under the caller's own tenant scope, where row-level security is what answers it.
   * The 404 is not politeness; it is the true statement about a scope that has no such row.
   */
  const cardIsHere = async (tenantId: string, taskId: string) => {
    /*
     * Asked before the query, because `tasks.id` is a uuid and Postgres answers a string that is not
     * one with `22P02` — which this route would have handed back as a 500. That is not a leak of
     * another workspace's data, but it is a crash on input a caller can type, and the honest answer to
     * "an id that cannot be an id" is the same 404 as "an id that is not here".
     */
    if (!UUID_PATTERN.test(taskId)) return false;
    const [row] = await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
      .limit(1);
    return Boolean(row);
  };

  routes.post("/:id/review", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) {
      return context.json({ error: "No such task here." }, 404);
    }
    const ok = await projector.reviewed({ tenantId, taskId });
    return ok
      ? context.json({ ok: true })
      : context.json({ error: "Not awaiting review." }, 409);
  });

  routes.post("/:id/archive", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) {
      return context.json({ error: "No such task here." }, 404);
    }
    const ok = await projector.archived({ tenantId, taskId });
    return ok
      ? context.json({ ok: true })
      : context.json({ error: "Cannot archive from this state." }, 409);
  });

  return routes;
}
