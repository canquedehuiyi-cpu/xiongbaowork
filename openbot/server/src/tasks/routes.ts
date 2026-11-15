import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  groupBotThreads,
  groupTaskRuns,
  intelligenceChannelMappings,
  modelUsage,
  taskSource,
  tasks,
  wakerFlows,
  wakerGroupMembers,
} from "../db/schema";
import { taskArchives } from "../db/schema/task-archives";
import { CardTurnRefused, type CardTurns } from "./card-turns";
import { createDelivery, type Delivery, stageOf } from "./delivery";
import { DEFAULT_TIME_ZONE, DELIVERY_EVENTS } from "./delivery-tools";
import { clockOf, dueRefusalText, readDueTime } from "./due-time";
import { listTaskEvents } from "./events";
import type { TaskProjector } from "./projector";

type Ctx = { Variables: AppVariables };

/**
 * What may be asked of `tasks.source`, and nothing else. The column is a Postgres enum, so a value
 * outside it would reach the database as `22P02` and come back as a 500 on input anyone can type.
 */
type TaskSource = (typeof taskSource.enumValues)[number];
const isTaskSource = (value: string): value is TaskSource =>
  (taskSource.enumValues as readonly string[]).includes(value);

const PERIODS: Record<string, number> = {
  week: 7 * 86400000,
  month: 30 * 86400000,
};

/** What a uuid looks like, asked of a path parameter before it reaches a uuid column. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a card's "打开" lands, in the four shapes the board's screens take: a one-coworker
 * conversation, a group conversation, a crew run, or the WakerFlow a crew run was started from
 * (spec D10, story WF4: a Flow's run is reviewed from the Flow, where its inputs, steps and 停止 are).
 */
export type TaskOpenTarget = {
  kind: "channel" | "group" | "pipeline" | "wakerflow";
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
  /*
   * Which of those runs are this workspace's, and which WakerFlow started each one. `flow_id` is read
   * in the same tenant-scoped query as the run itself, so a Flow id is only ever the run row's own and
   * never something a card claimed: the card carries a run reference, nothing more.
   *
   * The Flow is joined, not just named: only a Flow this workspace can still open (its own, a plan
   * Flow, not deleted) is a target. A deleted Flow's page answers 404, so its runs' cards keep opening
   * the run's pipeline panel, which still reads the run itself.
   */
  const runsAboard = new Map<string, string | null>();
  if (runIds.length > 0) {
    for (const row of await database
      .select({ id: groupTaskRuns.id, flowId: wakerFlows.id })
      .from(groupTaskRuns)
      .leftJoin(
        wakerFlows,
        and(
          eq(wakerFlows.id, groupTaskRuns.flowId),
          eq(wakerFlows.tenantId, tenantId),
          eq(wakerFlows.definitionMode, "json-plan-v1"),
          isNull(wakerFlows.deletedAt),
        ),
      )
      .where(
        and(
          eq(groupTaskRuns.tenantId, tenantId),
          inArray(groupTaskRuns.id, runIds),
        ),
      )) {
      runsAboard.set(row.id, row.flowId ?? null);
    }
  }

  for (const row of rows) {
    if (row.source === "group_run") {
      const runId = row.parentTaskId
        ? (parentRunRef.get(row.parentTaskId) ?? null)
        : (row.runRef ?? null);
      if (!runId || !runsAboard.has(runId)) {
        targets.set(row.id, null);
        continue;
      }
      // A Flow's run opens the Flow; a crew run started from the pipelines screen (or whose Flow is
      // gone) keeps its panel.
      const flowId = runsAboard.get(runId) ?? null;
      targets.set(
        row.id,
        flowId
          ? { kind: "wakerflow", id: flowId }
          : { kind: "pipeline", id: runId },
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

/** A 退回's reason: said in the conversation as the person's message, so a sentence, not an essay. */
const RETURN_REASON_CHARS = 500;
const CRITERIA_CHARS = 1000;

const returnBody = z.object({
  reason: z.string().trim().min(1).max(RETURN_REASON_CHARS),
});
const extensionBody = z.object({
  decision: z.enum(["grant", "deny"]),
  dueAt: z.string().trim().min(1).max(100).optional(),
});
const editBody = z
  .object({
    dueAt: z.string().trim().min(1).max(100).optional(),
    criteria: z.string().trim().min(1).max(CRITERIA_CHARS).optional(),
  })
  .refine((body) => body.dueAt !== undefined || body.criteria !== undefined);

export { clockOf };

/** What the followed-card routes need beyond the board: the card's conversation, and the person's rules. */
export type TaskRouteOptions = {
  /** Where a decision on a followed card is said and acted on in its thread (`tasks/card-turns.ts`). */
  turns?: CardTurns;
  /**
   * Whether this coworker's `accept_task` is switched off for this person (`delivery/accept_task`, as
   * the approval rules disable a tool): such a coworker does not work in three steps, and its card
   * cannot be followed.
   */
  acceptTaskDisabled?: (tenantId: string, agentId: string) => Promise<boolean>;
  /** The person's time zone, for a due time written without one. */
  timeZone?: (tenantId: string) => string;
  now?: () => Date;
  /** The followed cards' writes; a test may stand in for them. Absent: `createDelivery(database)`. */
  delivery?: Delivery;
};

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
  options: TaskRouteOptions = {},
) {
  const routes = new Hono<Ctx>();
  const delivery = options.delivery ?? createDelivery(database);
  const now = options.now ?? (() => new Date());
  const zoneOf = options.timeZone ?? (() => DEFAULT_TIME_ZONE);
  const log = (type: string, detail: Record<string, unknown>) =>
    console.error(JSON.stringify({ type, ...detail }));

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
    /*
     * Spec A4's Group choice, by the crew's own id. Its roster alone is not the crew's work: a crew
     * run's parent card names no coworker (`tasks.executor_agent_id` is null on it, see the schema), so
     * an `executors=` roster filter drops exactly the card that stands for the whole run. A group is
     * therefore its members' cards, the parent card of every run of this crew, and those runs' step
     * cards (a step whose coworker has since left the crew is still part of that run). Read under the
     * caller's own scope like the rest; a malformed id names no crew and matches nothing.
     */
    const group = context.req.query("group");
    if (status) conditions.push(eq(tasks.status, status as never));
    /*
     * Spec A4/C2: 触发方式 is one choice on the screen and more than one value here — 自主工作 is a
     * routine OR a responsibility firing, and that pair is also the board's 无人值守 filter. So the
     * parameter is a comma list. Values the enum does not know are dropped rather than sent on, and a
     * list left with nothing in it (`?source=`, or only unknown words) matches nothing — the same rule
     * `executors=` keeps below: a filter that was asked for and names nothing is an answer, not the
     * absence of a filter.
     */
    if (source !== undefined) {
      const sources = [
        ...new Set(
          source
            .split(",")
            .map((value) => value.trim())
            .filter(isTaskSource),
        ),
      ];
      conditions.push(
        sources.length > 0 ? inArray(tasks.source, sources) : sql`false`,
      );
    }
    if (executor) conditions.push(eq(tasks.executorAgentId, executor));
    // `!== undefined` rather than truthiness: `?executors=` with nothing after it is a crew that has
    // nobody in it, which is an answer — no work — and not the same as never being asked.
    if (executors !== undefined) {
      const ids = executors.split(",").filter((id) => id.length > 0);
      conditions.push(
        ids.length > 0 ? inArray(tasks.executorAgentId, ids) : sql`false`,
      );
    }
    if (group !== undefined) {
      if (!UUID_PATTERN.test(group)) {
        conditions.push(sql`false`);
      } else {
        const runParents = database
          .select({ id: groupTaskRuns.parentTaskId })
          .from(groupTaskRuns)
          .where(eq(groupTaskRuns.groupId, group));
        conditions.push(
          or(
            inArray(
              tasks.executorAgentId,
              database
                .select({ id: wakerGroupMembers.agentId })
                .from(wakerGroupMembers)
                .where(eq(wakerGroupMembers.groupId, group)),
            ),
            inArray(tasks.id, runParents),
            inArray(tasks.parentTaskId, runParents),
          ),
        );
      }
    }
    if (search) conditions.push(like(tasks.title, `%${search}%`));
    // 逾期 (spec 2026-11-15-delivery-loop §11): a card the checker once found overdue stays so.
    if (context.req.query("overdue") === "1")
      conditions.push(isNotNull(tasks.overdueAt));
    if (deviceId) conditions.push(eq(tasks.deviceId, deviceId));
    const window = PERIODS[period ?? ""];
    if (window)
      conditions.push(gte(tasks.createdAt, new Date(Date.now() - window)));
    return conditions.length ? and(...conditions) : undefined;
  };

  /*
   * `archivedAt` rides beside each card (spec A5/A7): a failure somebody filed away still reads
   * `failed`, and this stamp is what moves it from 需要关注 to 已结束 on the screen. Joined on the
   * tenant too, so a stamp can only ever describe a card of the same workspace -- and only while
   * it is current: the projector writes the stamp and the card's `updatedAt` at one instant, so a
   * card that moved again since (a re-run that failed afresh) no longer counts as filed away.
   */
  const cardRows = (where: ReturnType<typeof filters>, limit: number) =>
    database
      .select({
        ...getTableColumns(tasks),
        archivedAt: taskArchives.archivedAt,
      })
      .from(tasks)
      .leftJoin(
        taskArchives,
        and(
          eq(taskArchives.taskId, tasks.id),
          eq(taskArchives.tenantId, tasks.tenantId),
          gte(taskArchives.archivedAt, tasks.updatedAt),
        ),
      )
      .where(where)
      .orderBy(desc(tasks.updatedAt))
      .limit(limit);

  /*
   * Which model answered each task, beside the task itself.
   *
   * The board's whole premise is that one lane can hold a developer's task and a reviewer's task
   * that ran on different models, so a card that cannot say which one answered is a card somebody
   * has to open. The answer is already on record in `model_usage` — written per run by the gate,
   * including a `bound` row for a coworker with its own model — so this reads it rather than
   * inventing a second account of it. A task with no usage row (a routine whose run never reached
   * a model, or one from before the gate was mounted) answers with null and shows as unset.
   *
   * Where each card opens is resolved for the whole page at once (see `openTargetsFor`), and a
   * followed card says where it is in the three steps (`stage`, spec 2026-11-15-delivery-loop §11).
   */
  const present = async (
    tenantId: string,
    rows: Awaited<ReturnType<typeof cardRows>>,
  ) => {
    const models = await modelsForRuns(
      database,
      rows.map((row) => row.runRef),
    );
    const open = await openTargetsFor(
      database,
      tenantId,
      rows.map((row) => ({
        id: row.id,
        source: row.source,
        channelRef: row.channelRef,
        runRef: row.runRef,
        parentTaskId: row.parentTaskId,
      })),
    );
    return rows.map((row) => ({
      ...row,
      stage: stageOf(row),
      model: row.runRef ? (models.get(row.runRef) ?? null) : null,
      open: open.get(row.id) ?? null,
    }));
  };

  routes.get("/", requireUser, async (context) => {
    const rows = await cardRows(filters(context), 200);
    return context.json({
      tasks: await present(context.var.actor.id, rows),
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
    // A followed card's 验收 is written by `tasks/delivery.ts`, with its 「验收」 line.
    const ok =
      (await delivery.review(
        tenantId,
        taskId,
        `user:${context.var.actor.id}`,
        "review",
      )) ?? (await projector.reviewed({ tenantId, taskId }));
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
    /*
     * On a followed card, archiving is 验收 (spec 2026-11-15-delivery-loop §3): `awaiting_review` →
     * `done` with a 「验收（从归档）」 line, through `tasks/delivery.ts`. `null` says the card is not
     * followed, and archiving it is what it always was.
     */
    const reviewed = await delivery.review(
      tenantId,
      taskId,
      `user:${context.var.actor.id}`,
      "archive",
    );
    const ok =
      reviewed ??
      (await projector.archived({
        tenantId,
        taskId,
        archivedBy: context.var.actor.id,
      }));
    return ok
      ? context.json({ ok: true })
      : context.json({ error: "Cannot archive from this state." }, 409);
  });

  const notHere = (context: {
    json: (body: unknown, status: 404) => Response;
  }) => context.json({ error: "No such task here." }, 404);
  const bodyOf = async (context: { req: { json: () => Promise<unknown> } }) =>
    await context.req.json().catch(() => null);

  /*
   * One card, for a deep link and the phone's card page (spec 2026-11-15-delivery-loop §11), shaped
   * as the list shapes it. Every route below asks `cardIsHere` first, in the caller's own frame: a card
   * of another tenant -- a group member's card, asked for by the group's owner, included (spec §6) --
   * is not here, and every one of them answers 404 for it.
   */
  routes.get("/:id", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    const rows = await cardRows(
      and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)),
      1,
    );
    const [task] = await present(tenantId, rows);
    return task ? context.json({ task }) : notHere(context);
  });

  /** The card's history, oldest first (spec §7). */
  routes.get("/:id/events", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    return context.json({
      events: await listTaskEvents(database, { tenantId, taskId }),
    });
  });

  /*
   * 退回 (spec §6): the work goes back to the coworker with the person's reason, which is said in the
   * card's thread as the person's own message, and the coworker's turn on it starts there and then.
   */
  routes.post("/:id/return", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    const body = returnBody.safeParse(await bodyOf(context));
    if (!body.success)
      return context.json(
        { error: `退回要写原因，${RETURN_REASON_CHARS} 字以内。` },
        400,
      );
    const reason = body.data.reason;
    /*
     * The reason is said first, and the card moves only once it is in: a 退回 the coworker never
     * hears -- the thread busy, the coworker paused, the group gone -- would leave the card with the
     * coworker and the reason only in the history. So a reason that cannot be said refuses the whole
     * 退回, and the card stays where it was, with nothing written.
     */
    if (!options.turns)
      return context.json({ error: "现在退回不了，稍后再试。" }, 503);
    const turns = options.turns;
    /*
     * The card is taken for this 退回 first (`return_pending_at`): two at once -- a double click --
     * would otherwise both say the reason and both start a turn. The one that does not get it is told
     * a 退回 is under way. The claim is let go on every way out below that does not return the card.
     */
    const claim = await delivery.claimReturn(tenantId, taskId);
    if (!claim.ok)
      return context.json(
        {
          error:
            claim.why === "pending"
              ? "正在退回，稍等一下。"
              : "这件活不在等你验收，不能退回。",
        },
        409,
      );
    const card = { threadRef: claim.threadRef, agentId: claim.agentId };
    const release = () =>
      delivery.releaseReturn(tenantId, taskId, claim.claimedAt).catch((error) =>
        log("task-return-release-failed", {
          taskId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    let said: { runId: string | null; groupMessageId: string | null };
    try {
      said = await turns.sendAsUser(
        tenantId,
        { threadId: card.threadRef, agentId: card.agentId },
        `退回：${reason}`,
        { source: `task-return:${taskId}` },
      );
    } catch (error) {
      await release();
      if (error instanceof CardTurnRefused)
        return context.json({ error: error.message }, 409);
      log("task-return-turn-failed", {
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return context.json({ error: "现在退回不了，稍后再试。" }, 503);
    }
    /** The reason was said but the card did not move: let the claim go and stop the turn just started. */
    const undo = async () => {
      await release();
      if (said.runId)
        await turns.stopRound(tenantId, {
          threadId: card.threadRef,
          agentId: card.agentId,
          runId: said.runId,
        });
    };
    let returned: Awaited<ReturnType<typeof delivery.returnTask>>;
    try {
      returned = await delivery.returnTask(tenantId, taskId, {
        actor: `user:${tenantId}`,
        reason,
        claimedAt: claim.claimedAt,
      });
    } catch (error) {
      // The card could not be written (a database fault): undone as if the reason was never said.
      log("task-return-write-failed", {
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await undo();
      return context.json({ error: "现在退回不了，稍后再试。" }, 503);
    }
    if (!returned) {
      // Reviewed or cancelled in the moment between (or the claim ran out and another 退回 took it):
      // the turn just started is stopped (a group's message, already in the transcript, stays).
      await undo();
      return context.json({ error: "这件活不在等你验收，不能退回。" }, 409);
    }
    return context.json({
      ok: true,
      returns: returned.returns,
      runId: said.runId,
      groupMessageId: said.groupMessageId,
    });
  });

  /** 取消 (spec §6): the work is over, and the round running on it is stopped. */
  routes.post("/:id/cancel", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    const cancelled = await delivery.cancelTask(
      tenantId,
      taskId,
      `user:${tenantId}`,
    );
    if (!cancelled)
      return context.json({ error: "这件活不在跟或已经结束。" }, 409);
    if (cancelled.threadRef)
      await options.turns?.stopRound(tenantId, {
        threadId: cancelled.threadRef,
        agentId: cancelled.agentId,
        runId: cancelled.runId,
      });
    return context.json({ ok: true });
  });

  /*
   * The person's answer to the coworker's 延期申请 (spec §4): only the latest, unanswered one. The
   * chat's 延期申请 card learns the answer from a `delivery.extension_decided` event in the thread.
   */
  routes.post("/:id/extension", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    const body = extensionBody.safeParse(await bodyOf(context));
    if (!body.success)
      return context.json({ error: "decision 只能是 grant 或 deny。" }, 400);
    const decided = await delivery.decideExtension(tenantId, taskId, {
      actor: `user:${tenantId}`,
      decision: body.data.decision,
      ...(body.data.dueAt ? { dueAt: body.data.dueAt } : {}),
      now: now(),
      timeZone: zoneOf(tenantId),
    });
    if (!decided.ok) {
      if (decided.why === "not_open")
        return context.json({ error: "这件活不在跟或已经结束。" }, 409);
      if (decided.why === "handed_in")
        return context.json({ error: "成果已交，退回之后才能答复延期。" }, 409);
      if (decided.why === "no_request")
        return context.json({ error: "没有待答复的延期申请。" }, 409);
      return context.json({ error: `${dueRefusalText(decided.why)}。` }, 400);
    }
    const dueAt = decided.dueAt?.toISOString() ?? null;
    if (decided.threadRef && decided.agentId)
      await options.turns
        ?.say(
          tenantId,
          {
            threadId: decided.threadRef,
            agentId: decided.agentId,
            runId: decided.runId,
          },
          {
            type: EventType.CUSTOM,
            name: DELIVERY_EVENTS.extensionDecided,
            value: { taskId, decision: body.data.decision, dueAt },
          } as BaseEvent,
          // In a group, said in the group: the transcript is where the person and the coworker read it.
          body.data.decision === "grant" && decided.dueAt
            ? `准许延期到 ${clockOf(decided.dueAt, now(), zoneOf(tenantId))}`
            : "延期不批，按原时间交",
        )
        .catch((error) =>
          log("task-extension-notice-failed", {
            taskId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
    return context.json({ ok: true, decision: body.data.decision, dueAt });
  });

  /*
   * The person changes the due time or the criteria (spec §4, §5.4): while the coworker has the work,
   * not once it is handed in. Only `due_at` moves; `original_due_at` keeps what the coworker said.
   */
  routes.patch("/:id", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    const body = editBody.safeParse(await bodyOf(context));
    if (!body.success)
      return context.json(
        {
          error: `要改的是 dueAt 或 criteria（${CRITERIA_CHARS} 字以内）。`,
        },
        400,
      );
    let dueAt: Date | undefined;
    if (body.data.dueAt !== undefined) {
      const reading = readDueTime(body.data.dueAt, now(), zoneOf(tenantId));
      if (!reading.at)
        return context.json({ error: `${dueRefusalText(reading.why)}。` }, 400);
      dueAt = reading.at;
    }
    const edited = await delivery.editTask(tenantId, taskId, {
      actor: `user:${tenantId}`,
      ...(dueAt ? { dueAt } : {}),
      ...(body.data.criteria !== undefined
        ? { criteria: body.data.criteria }
        : {}),
    });
    if (!edited.ok)
      return context.json(
        {
          error:
            edited.why === "not_followed"
              ? "这件活不在跟。"
              : "成果已交或这件活已结束，退回之后才能改。",
        },
        409,
      );
    return context.json({
      ok: true,
      dueAt: edited.dueAt?.toISOString() ?? null,
      criteria: edited.criteria,
    });
  });

  /*
   * 当作一件活来跟 (spec §1): the card waits for its coworker's 接活回执, which the coworker's next
   * turn on the thread is asked for (`threads/postgres-runner.ts`). A coworker whose `accept_task` is
   * switched off does not work in three steps, so its card cannot be followed.
   */
  routes.post("/:id/track", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const taskId = context.req.param("id");
    if (!(await cardIsHere(tenantId, taskId))) return notHere(context);
    const [card] = await database
      .select({ agentId: tasks.executorAgentId })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
      .limit(1);
    if (
      card?.agentId &&
      (await options.acceptTaskDisabled?.(tenantId, card.agentId))
    )
      return context.json(
        {
          error:
            "这位员工的接活工具（accept_task）已关闭，不能当作一件活来跟。",
        },
        409,
      );
    const tracked = await delivery.track(tenantId, taskId, `user:${tenantId}`);
    if (!tracked.ok)
      return context.json(
        {
          error:
            tracked.why === "followed"
              ? "这件活已经在跟了。"
              : tracked.why === "no_coworker"
                ? "这张卡没有执行的员工，不能当作一件活来跟。"
                : "这件活已经结束了。",
        },
        409,
      );
    return context.json({
      ok: true,
      stage: "pending_accept",
      threadRef: tracked.threadRef,
    });
  });

  return routes;
}
