import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  groupBotThreads,
  intelligenceChannelMappings,
  taskBriefings,
  taskEvents,
  tasks,
} from "../db/schema";
import type { BriefingKind } from "../db/schema/task-briefings";
import type { DeliveryRouter } from "../delivery/router";
import type { DeliveryScope } from "../delivery/types";
import {
  asPlatform,
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import { minuteOfClock, type WorkHours } from "../user-preferences";
import {
  BRIEFING_WINDOW_MS,
  type DeliveryNotice,
  localDay,
  type NoticeResult,
  UNREPORTED_DUE_MS,
  withinWorkHours,
} from "./delivery-checker";
import { clockOf } from "./due-time";
import { appendTaskEvent } from "./events";
import { isOverdueNow } from "./overdue";

/**
 * 开工 / 收工清点 (spec 2026-11-15-delivery-loop §10), and the way out for what the delivery checker
 * tells the person.
 *
 * THE BRIEFING. At the start and at the end of the person's work hours, if they have followed work
 * (a card still open, one taken on today, or one they reviewed today), one message: how many they
 * reviewed today, what waits for their review, what is still being done (soonest due first), what is
 * overdue (how late, how many nudges), and -- the start briefing only -- the reminders held back
 * outside their work hours. No followed work, no briefing.
 *
 * ONCE A DAY, EVEN ACROSS RESTARTS. Each person's briefing is claimed by inserting its row in
 * `task_briefings` (person, kind, their local day) before it is built; a second replica, or this one
 * after a restart, finds the row and sends nothing. Nothing is held open while it is sent: the claim
 * commits on its own, and the outbox rows are written after. A claim still unsent ten minutes on
 * ({@link BRIEFING_CLAIM_LEASE_MS}: its server died before sending) may be taken back within the hour.
 *
 * WHEN. Every minute the pass reads each person's work hours: on a working day (Saturdays and Sundays
 * only if they said so), within an hour after their start or end time, the briefing of that kind is
 * claimed once. The hour covers a restart across the moment; past it, that day's briefing is skipped
 * rather than sent at a time it no longer fits.
 *
 * WHOSE FRAME. The pass asks as `platform` who has followed work, people's ids and nothing else;
 * each person is then briefed in the tenant stamped on their own cards (`assertPersonTenant`).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long after the start or end time a briefing may still go out (a restart across the moment). */
export { BRIEFING_WINDOW_MS };
/** How long a briefing's claim may stay unsent before another pass may take it back. */
export const BRIEFING_CLAIM_LEASE_MS = 10 * MINUTE;
/** Lately closed cards a briefing may be filed under when it names no open one. */
const CLOSED_SCOPE_CARDS = 20;
/** How far back a closed card or a 验收 line is read: enough to cover "today" on any zone. */
const LOOKBACK_MS = 48 * HOUR;
/** The statuses of a followed card that has not ended. */
const OPEN_STATUSES = ["running", "needs_action", "awaiting_review"] as const;
/** The statuses of a card the coworker still has. */
const WORKING_STATUSES = ["running", "needs_action"] as const;

export type { BriefingKind };

/** One briefing (spec §10), as the page and the messages show it. Times are ISO instants. */
export type Briefing = {
  /** Cards the person reviewed today, on their clock. */
  reviewed: number;
  /** Handed in, waiting for the person's review; oldest hand-in first. */
  awaitingReview: {
    taskId: string;
    title: string;
    agentName: string;
    deliveredAt: string;
  }[];
  /**
   * With the coworker and not overdue, soonest due first; `dueAt` is the due time in force (two hours
   * after acceptance when the coworker named none), null while the card waits to be taken on.
   */
  inProgress: {
    taskId: string;
    title: string;
    agentName: string;
    dueAt: string | null;
  }[];
  /** With the coworker and past due: how many minutes late, and how often nudged; latest first. */
  overdue: { taskId: string; title: string; minutes: number; nudges: number }[];
  /** The reminders held back outside work hours (start briefing only). */
  deferred: string[];
};

/** A reminder held outside work hours that a start briefing carries: its card, words and kind. */
type Carried = {
  taskId: string;
  text: string;
  kind: DeliveryNotice["kind"];
};

export type BriefingDeps = {
  database: Database;
  /** The person's work hours and time zone (`readWorkHours`). */
  workHours: (userId: string) => Promise<WorkHours>;
  /** The coworker's name as the person sees it. */
  agentName?: (tenantId: string, agentId: string) => Promise<string | null>;
  /** Hand a briefing to the person's outlets; resolves how many places it went to. */
  send?: (
    tenantId: string,
    kind: BriefingKind,
    briefing: Briefing,
    now: Date,
  ) => Promise<number>;
  /** Narrow a pass to these people (a test's own); absent, everybody. */
  onlyTenants?: readonly string[];
};

const log = (type: string, detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ type, ...detail }));

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The weekday and the minute of the day an instant is on a zone's clock. */
function localClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((piece) => piece.type === type)?.value ?? "";
  return {
    weekend: part("weekday") === "Sat" || part("weekday") === "Sun",
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/** The due time in force of an accepted card: `due_at`, or two hours after it was taken on. */
const deadlineOf = (card: { acceptedAt: Date | null; dueAt: Date | null }) =>
  card.acceptedAt
    ? (card.dueAt ?? new Date(card.acceptedAt.getTime() + UNREPORTED_DUE_MS))
    : null;

/** The briefing as a message: its heading, and a body of one summary line and the held reminders. */
export function briefingText(
  kind: BriefingKind,
  briefing: Briefing,
  timeZone: string,
  now: Date,
): { title: string; body: string } {
  const title = kind === "start" ? "开工清点" : "收工清点";
  const parts: string[] = [];
  if (briefing.awaitingReview.length)
    parts.push(`等你验收 ${briefing.awaitingReview.length} 件`);
  if (briefing.inProgress.length) {
    const soonest = briefing.inProgress.find((item) => item.dueAt)?.dueAt;
    parts.push(
      soonest
        ? `还在做 ${briefing.inProgress.length} 件，最早 ${clockOf(new Date(soonest), now, timeZone)} 到期`
        : `还在做 ${briefing.inProgress.length} 件`,
    );
  }
  if (briefing.overdue.length) parts.push(`逾期 ${briefing.overdue.length} 件`);
  if (briefing.reviewed) parts.push(`今天已验收 ${briefing.reviewed} 件`);
  if (briefing.deferred.length)
    parts.push(`作息外攒下 ${briefing.deferred.length} 条提醒`);
  const lines = [
    parts.join("；") || "没有要你处理的活",
    ...briefing.deferred.map((text) => `· ${text}`),
  ];
  return { title, body: lines.join("\n") };
}

export function createBriefings(deps: BriefingDeps) {
  const database = deps.database;

  /**
   * The briefing of `kind` for this person as of `now`, or null when they have no followed work
   * (spec §10). Read only: holding nothing back, sending nothing.
   */
  async function buildBriefing(
    tenantId: string,
    kind: BriefingKind,
    now: Date,
  ): Promise<Briefing | null> {
    return runAsTenant(
      tenantId,
      async () =>
        (await compose(tenantId, kind, now, await deps.workHours(tenantId)))
          ?.briefing ?? null,
    );
  }

  /** The briefing on these work hours, and which cards' held reminders it carries. */
  async function compose(
    tenantId: string,
    kind: BriefingKind,
    now: Date,
    hours: WorkHours,
  ): Promise<{ briefing: Briefing; carried: Carried[] } | null> {
    const today = localDay(now, hours.timeZone);
    const since = new Date(now.getTime() - LOOKBACK_MS);
    const cards = await database
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        executorAgentId: tasks.executorAgentId,
        acceptedAt: tasks.acceptedAt,
        dueAt: tasks.dueAt,
        overdueAt: tasks.overdueAt,
        nudges: tasks.nudges,
        reminderHeldAt: tasks.reminderHeldAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.tracked, true),
          or(
            inArray(tasks.status, [...OPEN_STATUSES]),
            gte(tasks.updatedAt, since),
          ),
        ),
      );
    const reviewedLines = await database
      .select({ taskId: taskEvents.taskId, at: taskEvents.createdAt })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.tenantId, tenantId),
          eq(taskEvents.kind, "reviewed"),
          gte(taskEvents.createdAt, since),
        ),
      );
    const reviewed = new Set(
      reviewedLines
        .filter((line) => localDay(line.at, hours.timeZone) === today)
        .map((line) => line.taskId),
    ).size;
    const open = cards.filter((card) =>
      (OPEN_STATUSES as readonly string[]).includes(card.status),
    );
    const takenOnToday = cards.some(
      (card) =>
        card.acceptedAt && localDay(card.acceptedAt, hours.timeZone) === today,
    );
    if (open.length === 0 && !takenOnToday && reviewed === 0) return null;

    const names = new Map<string, string>();
    const nameOf = async (agentId: string | null) => {
      if (!agentId) return "员工";
      const known = names.get(agentId);
      if (known) return known;
      const name =
        (await deps.agentName?.(tenantId, agentId).catch(() => null)) ?? "员工";
      names.set(agentId, name);
      return name;
    };

    const handedIn = open.filter((card) => card.status === "awaiting_review");
    const handedAt = new Map<string, Date>();
    if (handedIn.length)
      for (const line of await database
        .select({ taskId: taskEvents.taskId, at: taskEvents.createdAt })
        .from(taskEvents)
        .where(
          and(
            eq(taskEvents.tenantId, tenantId),
            eq(taskEvents.kind, "delivered"),
            inArray(
              taskEvents.taskId,
              handedIn.map((card) => card.id),
            ),
          ),
        )
        .orderBy(desc(taskEvents.createdAt)))
        if (!handedAt.has(line.taskId)) handedAt.set(line.taskId, line.at);
    const awaitingReview: Briefing["awaitingReview"] = [];
    for (const card of handedIn)
      awaitingReview.push({
        taskId: card.id,
        title: card.title,
        agentName: await nameOf(card.executorAgentId),
        deliveredAt: (handedAt.get(card.id) ?? card.updatedAt).toISOString(),
      });
    awaitingReview.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt));

    const working = open.filter((card) =>
      (WORKING_STATUSES as readonly string[]).includes(card.status),
    );
    const inProgress: (Briefing["inProgress"][number] & { at: number })[] = [];
    const overdue: Briefing["overdue"] = [];
    for (const card of working) {
      const deadline = deadlineOf(card);
      // Overdue now, by the one rule (`overdue.ts`): a card given more time is back in progress.
      if (isOverdueNow(card, now)) {
        overdue.push({
          taskId: card.id,
          title: card.title,
          minutes: deadline
            ? Math.max(
                0,
                Math.floor((now.getTime() - deadline.getTime()) / MINUTE),
              )
            : 0,
          nudges: card.nudges,
        });
        continue;
      }
      inProgress.push({
        taskId: card.id,
        title: card.title,
        agentName: await nameOf(card.executorAgentId),
        dueAt: deadline?.toISOString() ?? null,
        at: deadline?.getTime() ?? Number.POSITIVE_INFINITY,
      });
    }
    inProgress.sort((a, b) => a.at - b.at);
    overdue.sort((a, b) => b.minutes - a.minutes);

    const deferred: string[] = [];
    const carried: Carried[] = [];
    const held = working.filter((card) => card.reminderHeldAt !== null);
    if (kind === "start" && held.length) {
      const said = new Map<string, { text: string; kind: unknown }>();
      for (const line of await database
        .select({ taskId: taskEvents.taskId, detail: taskEvents.detail })
        .from(taskEvents)
        .where(
          and(
            eq(taskEvents.tenantId, tenantId),
            eq(taskEvents.kind, "notified"),
            inArray(
              taskEvents.taskId,
              held.map((card) => card.id),
            ),
          ),
        )
        .orderBy(desc(taskEvents.createdAt))) {
        const detail = line.detail as {
          result?: unknown;
          text?: unknown;
          kind?: unknown;
        };
        if (
          !said.has(line.taskId) &&
          detail.result === "deferred" &&
          typeof detail.text === "string" &&
          detail.text
        )
          said.set(line.taskId, { text: detail.text, kind: detail.kind });
      }
      for (const card of held) {
        const held = said.get(card.id);
        const text = held?.text ?? `『${card.title}』有一条提醒`;
        deferred.push(text);
        carried.push({
          taskId: card.id,
          text,
          kind: held?.kind === "pending_accept" ? "pending_accept" : "overdue",
        });
      }
    }

    return {
      briefing: {
        reviewed,
        awaitingReview,
        inProgress: inProgress.map(({ at: _at, ...item }) => item),
        overdue,
        deferred,
      },
      carried,
    };
  }

  /**
   * The held reminders went out with the start briefing: each card's reminder is no longer held (the
   * next start briefing does not carry it again), and the person was told about it now -- one of the
   * day's three (`notified_on` / `notified_count`, the person's `day`) and the moment the next
   * reminder is two hours from (`last_notified_at`), so the checker does not push it again at the
   * same moment (`tasks/delivery-checker.ts`). One `notified {result: "sent", via: "start_briefing"}`
   * line each, with the card's write.
   */
  async function toldInBriefing(
    tenantId: string,
    carried: Carried[],
    now: Date,
    day: string,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      const told = await transaction
        .update(tasks)
        .set({
          reminderHeldAt: null,
          lastNotifiedAt: now,
          notifiedCount: sql`case when ${tasks.notifiedOn} = ${day}::date then ${tasks.notifiedCount} + 1 else 1 end`,
          notifiedOn: day,
        })
        .where(
          and(
            eq(tasks.tenantId, tenantId),
            inArray(
              tasks.id,
              carried.map((item) => item.taskId),
            ),
            isNotNull(tasks.reminderHeldAt),
            lte(tasks.reminderHeldAt, now),
          ),
        )
        .returning({ id: tasks.id });
      for (const { id } of told) {
        const item = carried.find((each) => each.taskId === id);
        await appendTaskEvent(transaction, {
          tenantId,
          taskId: id,
          kind: "notified",
          actor: "system",
          detail: {
            kind: item?.kind ?? "overdue",
            text: item?.text ?? "",
            result: "sent",
            via: "start_briefing",
            at: now.toISOString(),
          },
        });
      }
    });
  }

  /** One person's briefings due now, each claimed once for their local day. */
  async function briefPerson(tenantId: string, now: Date): Promise<void> {
    const hours = await deps.workHours(tenantId);
    const clock = localClock(now, hours.timeZone);
    if (clock.weekend && !hours.weekends) return;
    const day = localDay(now, hours.timeZone);
    for (const kind of ["start", "end"] as const) {
      const at = minuteOfClock(kind === "start" ? hours.start : hours.end);
      if (clock.minute < at || clock.minute >= at + BRIEFING_WINDOW_MS / MINUTE)
        continue;
      const claim = and(
        eq(taskBriefings.tenantId, tenantId),
        eq(taskBriefings.kind, kind),
        eq(taskBriefings.localDay, day),
      );
      // The claim, committed on its own: whoever inserts the row briefs; anybody after finds it there.
      const [claimed] = await database
        .insert(taskBriefings)
        .values({ tenantId, kind, localDay: day, createdAt: now })
        .onConflictDoNothing()
        .returning({ kind: taskBriefings.kind });
      /*
       * A claim nobody finished. A server that exits between the claim and the send (a deploy, a
       * crash: no `catch` runs) leaves the row unsent (`offered` null) for good, and every pass after
       * would find it there and skip that day's briefing, and the reminders it carries with it. So a
       * claim is a lease: `created_at` is when it was last claimed, and one still unsent
       * {@link BRIEFING_CLAIM_LEASE_MS} on is taken back by whichever pass gets the row first (one
       * update: the row lock lets one through, and the next re-reads a fresh `created_at`). A send that
       * is merely slow and then finishes cannot reach anybody twice either: each place's row is keyed
       * by the person, the briefing and the place (`notifyPerson`), as for a retry after a failure.
       */
      const reclaimed = claimed
        ? []
        : await database
            .update(taskBriefings)
            .set({ createdAt: now })
            .where(
              and(
                claim,
                isNull(taskBriefings.offered),
                lt(
                  taskBriefings.createdAt,
                  new Date(now.getTime() - BRIEFING_CLAIM_LEASE_MS),
                ),
              ),
            )
            .returning({ kind: taskBriefings.kind });
      if (!claimed && reclaimed.length === 0) continue;
      // This pass's own claim: one taken back from it later is not this pass's to let go.
      const mine = and(claim, eq(taskBriefings.createdAt, now));
      let offered = 0;
      try {
        const composed = await compose(tenantId, kind, now, hours);
        if (composed && deps.send) {
          offered = await deps.send(tenantId, kind, composed.briefing, now);
          if (composed.carried.length && offered > 0)
            await toldInBriefing(tenantId, composed.carried, now, day);
        }
      } catch (error) {
        /*
         * Not sent: the claim is let go, so the next minute's pass, inside the same hour, tries again.
         * Trying again cannot send twice -- each place's row is keyed by the person, the briefing's
         * kind and day, and the place (`notifyPerson`), so what did go out before the failure is not
         * offered a second time, and still counts as reached.
         */
        await database
          .delete(taskBriefings)
          .where(and(mine, isNull(taskBriefings.offered)));
        throw error;
      }
      await database.update(taskBriefings).set({ offered }).where(claim);
    }
  }

  /**
   * One pass over everybody with followed work (see the module comment). `now` is the pass's clock:
   * the loop gives the wall clock, a test its own.
   */
  async function runBriefings(now: Date): Promise<void> {
    const since = new Date(now.getTime() - LOOKBACK_MS);
    // Who has followed work, across every tenant: their ids, and nothing else.
    const people = await asPlatform(() =>
      database
        .selectDistinct({ tenantId: tasks.tenantId })
        .from(tasks)
        .where(
          and(
            eq(tasks.tracked, true),
            or(
              inArray(tasks.status, [...OPEN_STATUSES]),
              gte(tasks.updatedAt, since),
            ),
            ...(deps.onlyTenants
              ? [inArray(tasks.tenantId, [...deps.onlyTenants])]
              : []),
          ),
        ),
    );
    for (const person of people) {
      let tenantId: string;
      try {
        tenantId = assertPersonTenant(person.tenantId);
      } catch (error) {
        if (!(error instanceof TenantContextError)) throw error;
        continue;
      }
      try {
        await runAsTenant(tenantId, () => briefPerson(tenantId, now));
      } catch (error) {
        log("task-briefing-failed", { tenantId, reason: reasonOf(error) });
      }
    }
  }

  return { buildBriefing, runBriefings };
}

export type Briefings = ReturnType<typeof createBriefings>;

/**
 * Where the checker's reminders and the briefings leave the server (spec §10): the person's push
 * devices and their connected Slack, Teams and SMS (`DeliveryRouter.notifyPerson`), filed under the
 * conversation of the card it is about.
 */
export function createTaskNotices(deps: {
  database: Database;
  router: Pick<DeliveryRouter, "notifyPerson">;
  /** The person's conversation with a coworker, as delivery addresses it (`deliveryScopeFor`). */
  scopeFor: (
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ) => Promise<DeliveryScope | null>;
  workHours: (userId: string) => Promise<WorkHours>;
}) {
  const database = deps.database;

  /**
   * The conversations these cards hang on that the person can still reach, in the cards' order: a
   * card's `channel_ref` when it is a channel, else the conversation its thread belongs to (their own
   * one-to-one, or their coworker's thread in a group).
   */
  async function scopesOf(
    tenantId: string,
    cards: {
      channelRef: string | null;
      threadRef: string | null;
      executorAgentId: string | null;
    }[],
  ): Promise<DeliveryScope[]> {
    const refs = [
      ...new Set(
        cards.flatMap((card) =>
          [card.channelRef, card.threadRef].filter(
            (ref): ref is string => typeof ref === "string" && ref !== "",
          ),
        ),
      ),
    ];
    if (refs.length === 0) return [];
    const channelOf = new Map<string, string>();
    for (const row of await database
      .select({
        threadId: intelligenceChannelMappings.threadId,
        channelId: intelligenceChannelMappings.channelId,
      })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.userId, tenantId),
          inArray(intelligenceChannelMappings.threadId, refs),
        ),
      ))
      channelOf.set(row.threadId, row.channelId);
    for (const row of await database
      .select({
        threadId: groupBotThreads.threadId,
        channelId: groupBotThreads.channelId,
      })
      .from(groupBotThreads)
      .where(
        and(
          eq(groupBotThreads.ownerUserId, tenantId),
          inArray(groupBotThreads.threadId, refs),
        ),
      ))
      channelOf.set(row.threadId, row.channelId);
    const scopes: DeliveryScope[] = [];
    const tried = new Set<string>();
    for (const card of cards) {
      if (!card.executorAgentId) continue;
      const channels = [card.channelRef, card.threadRef].flatMap((ref) =>
        ref ? [channelOf.get(ref) ?? ref] : [],
      );
      for (const channelId of channels) {
        const key = JSON.stringify([channelId, card.executorAgentId]);
        if (tried.has(key)) continue;
        tried.add(key);
        const scope = await deps.scopeFor(
          tenantId,
          channelId,
          card.executorAgentId,
        );
        if (scope) scopes.push(scope);
      }
    }
    return scopes;
  }

  async function cardsOf(tenantId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await database
      .select({
        id: tasks.id,
        channelRef: tasks.channelRef,
        threadRef: tasks.threadRef,
        executorAgentId: tasks.executorAgentId,
      })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), inArray(tasks.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  /**
   * The delivery checker's `notify`: push the reminder about one card now. Outside the person's work
   * hours it is held (`deferred`), whatever the caller thought; reaching nobody (no device, no chat
   * account, no conversation left) holds it too, so the start briefing and the workbench still have it.
   */
  async function notify(
    tenantId: string,
    notice: DeliveryNotice,
    now: Date = new Date(),
  ): Promise<NoticeResult> {
    if (!withinWorkHours(await deps.workHours(tenantId), now))
      return "deferred";
    const reached = await deps.router.notifyPerson({
      ownerUserId: tenantId,
      kind: "overdue",
      id: `${notice.taskId}:${now.toISOString()}`,
      title: notice.kind === "overdue" ? "逾期提醒" : "还没接下",
      body: notice.text,
      scopes: await scopesOf(
        tenantId,
        await cardsOf(tenantId, [notice.taskId]),
      ),
      taskId: notice.taskId,
    });
    return reached.queued + reached.already > 0 ? "sent" : "deferred";
  }

  /** The briefing pass's `send`: one message, filed under the conversation of the first card it names. */
  async function sendBriefing(
    tenantId: string,
    kind: BriefingKind,
    briefing: Briefing,
    now: Date,
  ): Promise<number> {
    const hours = await deps.workHours(tenantId);
    const ids = [
      ...briefing.overdue,
      ...briefing.awaitingReview,
      ...briefing.inProgress,
    ].map((item) => item.taskId);
    /*
     * Then the followed work that closed lately, newest first. On the day every piece of work was
     * reviewed the briefing names no open card ("今天验收了 N 件"), and a push must be filed under
     * some conversation the person can still reach (`notifyPerson` queues none without one): without
     * these, a person with a phone and no chat account would miss exactly that day's 收工清点. Its
     * deep link is `/briefing` whichever conversation it is filed under.
     */
    const closed = (
      await database
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.tenantId, tenantId),
            eq(tasks.tracked, true),
            gte(tasks.updatedAt, new Date(now.getTime() - LOOKBACK_MS)),
          ),
        )
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(CLOSED_SCOPE_CARDS)
    )
      .map((row) => row.id)
      .filter((id) => !ids.includes(id));
    const { title, body } = briefingText(kind, briefing, hours.timeZone, now);
    const reached = await deps.router.notifyPerson({
      ownerUserId: tenantId,
      kind: "briefing",
      id: `${kind}:${localDay(now, hours.timeZone)}`,
      title,
      body,
      scopes: await scopesOf(
        tenantId,
        await cardsOf(tenantId, [...ids, ...closed]),
      ),
    });
    // Every place it reached, now or by an earlier try of this same briefing that failed part-way.
    return reached.queued + reached.already;
  }

  return { notify, sendBriefing };
}

/** `GET /api/me/briefing?kind=start|end`: the briefing as it stands now (null: no followed work). */
export function createBriefingRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  briefings: Pick<Briefings, "buildBriefing">,
  now: () => Date = () => new Date(),
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/", requireUser, async (context) => {
    const kind = context.req.query("kind");
    if (kind !== "start" && kind !== "end")
      return context.json({ error: "kind 只能是 start 或 end。" }, 400);
    return context.json({
      kind,
      briefing: await briefings.buildBriefing(
        context.var.actor.id,
        kind,
        now(),
      ),
    });
  });
  return routes;
}
