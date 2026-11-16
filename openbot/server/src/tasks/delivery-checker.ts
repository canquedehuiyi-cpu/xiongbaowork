import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { taskEvents, tasks } from "../db/schema";
import type { NoticeRunner } from "../devices/queued-results";
import {
  asPlatform,
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import {
  DEFAULT_WORK_HOURS,
  readWorkHours,
  type WorkHours,
} from "../user-preferences";
import { TurnNotStarted } from "./card-turns";
import { createDelivery, type Delivery } from "./delivery";
import { EXTERNAL_DELIVERY_GUIDE } from "./delivery-tools";
import { diffTitle } from "./diff-summary";
import { clockOf } from "./due-time";
import { appendTaskEvent } from "./events";
import type { DeliverableRef } from "./projector";
import {
  NOTIFY_AFTER_NUDGE_MS,
  NUDGE_AFTER_MS,
  OVERDUE_AFTER_DUE_MS,
} from "../../../shared/delivery-timing";

/**
 * The delivery checker (spec 2026-11-15-delivery-loop §8): the server's own clock over every followed
 * card that has not ended, once a minute.
 *
 * - 派出 · 待接下: five minutes after the card started waiting (followed, or handed to a new coworker)
 *   the coworker is nudged; thirty minutes after that the person is told it has not been taken on.
 * - 已接下: five minutes past the due time (`due_at`, or two hours after acceptance when no time was
 *   reported) the coworker is nudged; thirty-five minutes past it the card is recorded overdue (once:
 *   `overdue_at` is kept for good) and the person is told.
 * - After that, a nudge and a reminder at most every two hours each, and at most three of each a day
 *   about one card -- three nudges to the coworker, three reminders pushed to the person -- a "day"
 *   being the person's own, on their time zone (`nudged_on` / `nudged_count`, `notified_on` /
 *   `notified_count`). A nudge opens a round the person pays for, so it keeps to the same rules as a
 *   push (the user's decision, 2026-11-15): an external employee's included.
 * - Outside the person's work hours nothing is pushed and nobody is nudged: the reminder is held
 *   (`reminder_held_at`, and a `notified {result: "deferred"}` line) for the next start briefing, one
 *   per card until it is pushed, and the nudge waits for the first pass inside their hours.
 * - A held reminder is the next start briefing's (`tasks/briefing.ts`), which carries it and records
 *   it told (`last_notified_at`, one of the day's three). In the hour that briefing may go out in
 *   ({@link BRIEFING_WINDOW_MS} from the start of work) the checker leaves a held reminder alone, so
 *   the person is not told twice at 09:00 whichever of the two loops gets there first; one the briefing
 *   did not carry is pushed once that hour is over.
 * - While a turn is running on the card's thread nothing is done and nothing is written; the next pass
 *   looks again. "Running" is the runner's answer about the thread, never `active_run_ref` alone: a
 *   server that died mid-round leaves the column naming a round nothing runs any more.
 * - An external employee's turn still waiting in its queue (its computer away, or its lane busy) is not
 *   running: the card is recorded overdue and the person told as for any card, saying the work is
 *   still queued, but the employee is not nudged -- a nudge would only queue a second turn behind the
 *   first (`turnQueued`).
 * - An external employee (`isExternal`) is nudged in words that name no tool it does not have: how the
 *   server reads its replies instead (`EXTERNAL_DELIVERY_GUIDE`).
 *
 * TWO REPLICAS, ONE NUDGE -- THE CLAIM, NOT "RUNNING". Each card is claimed under its row lock
 * (`for update skip locked`): what is due is decided from the locked row and written to it
 * (`last_nudged_at`, `overdue_at`, `last_notified_at`, `notified_on` / `notified_count`,
 * `reminder_held_at`) before anything leaves the
 * server, so a second checker on the same card skips it while it is held, and finds nothing due once it
 * is not. The nudge and the notification run after the claim commits -- a nudge waits for its turn to
 * start, and a row lock held over that would block the turn's own write to the card. A nudge that
 * finds the thread busy after all gives its claim back.
 *
 * DEPLOYMENT LIMIT: "RUNNING" IS ONE PROCESS'S WORD. The claim and its dedupe hold across replicas; the
 * question "is a turn running on this thread?" ({@link threadRunning}, and the idle-only admission and
 * `attachRun`'s `keepIfRunning` behind a nudge) is answered by this process's runner only, which knows
 * nothing of a turn on another replica. With more than one server replica, a checker that claims a
 * card while its coworker's turn runs on another replica sees the thread idle: it opens a nudge round
 * there too, takes the card's `active_run_ref`, and the other round's `deliver_task` is then refused as
 * no longer the card's round. Until a cross-replica "running" signal exists, the delivery loop is only
 * reliable on a single server replica (the chart's default `server.replicaCount` is 2), as the
 * runner's own thread store and stop button already are.
 *
 * WHOSE FRAME. The pass asks as `platform` which cards are followed and open, across every tenant, and
 * nothing else; each card is then checked, and every line written, in the tenant stamped on its own row.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/*
 * The nudge after a due time, the reminder after the nudge, and the overdue grace they add up to live in
 * `shared/delivery-timing.ts`: `tasks/overdue.ts` and the app's board read the same grace.
 */
export { NOTIFY_AFTER_NUDGE_MS, NUDGE_AFTER_MS, OVERDUE_AFTER_DUE_MS };
/** The least time between two nudges, and between two reminders, about one card. */
export const REPEAT_MS = 2 * HOUR;
/** The due time of a card whose coworker named none: this long after it was taken on. */
export const UNREPORTED_DUE_MS = 2 * HOUR;
/** Reminders pushed to the person about one card in one of their days. */
export const DAILY_NOTICES = 3;
/** Nudges the coworker is given about one card in one of the person's days. */
export const DAILY_NUDGES = 3;
/**
 * How long after the start (or the end) of the person's work hours that day's briefing may still go out
 * (a restart across the moment): the hour in which a held reminder is the start briefing's.
 */
export const BRIEFING_WINDOW_MS = HOUR;
/** Cards one page of a pass reads, soonest-due first; the pass reads page after page to the end. */
const CARDS_PER_PASS = 500;

/** When the person works, on their own clock: their preferences (`readWorkHours`). */
export type { WorkHours };
export { DEFAULT_WORK_HOURS };

/** What the person is told about one card. */
export type DeliveryNotice = {
  kind: "overdue" | "pending_accept";
  taskId: string;
  text: string;
};

/** What became of a notice: pushed, held for a briefing, or refused by a cap the sender keeps. */
export type NoticeResult = "sent" | "deferred" | "capped";

export type DeliveryCheckDeps = {
  database: Database;
  /** The person's work hours and time zone. */
  workHours: (userId: string) => Promise<WorkHours>;
  /**
   * Tell the person (push, chat apps: `tasks/briefing.ts` `createTaskNotices`). `now` is the pass's
   * clock, which also keys the message.
   */
  notify: (
    tenantId: string,
    notice: DeliveryNotice,
    now: Date,
  ) => Promise<NoticeResult>;
  /** Nudge the card's coworker (`tasks/nudge-run.ts` `startNudgeRun`). */
  nudge: (
    tenantId: string,
    taskId: string,
    text: string,
  ) => Promise<"started" | "skipped_running">;
  /** Whether a turn is running on the thread now: the runner's word ({@link threadRunning}). */
  turnRunning: (tenantId: string, threadId: string) => Promise<boolean>;
  /**
   * An external employee's turn on the thread still waiting to run (queued, not followed by any run):
   * whether its computer is away. Null when none waits. Absent: none ever does.
   */
  turnQueued?: (
    tenantId: string,
    threadId: string,
  ) => Promise<{ offline: boolean } | null>;
  /** Whether the coworker is an external employee (`device_acp`), told in words for one. Absent: none is. */
  isExternal?: (tenantId: string, agentId: string) => Promise<boolean>;
  /** The coworker's name as the person sees it, for what they are told. */
  agentName?: (tenantId: string, agentId: string) => Promise<string | null>;
  /** Narrow a pass to these tenants (a test's own people); absent, every tenant. */
  onlyTenants?: readonly string[];
  /** How many cards one page of a pass reads (default {@link CARDS_PER_PASS}). */
  cardsPerPass?: number;
};

/** Whether a turn is running on a thread, as the deployment's runner knows it (one process, local mode). */
export function threadRunning(
  runner: Pick<NoticeRunner, "hydrate" | "isRunning">,
) {
  return (tenantId: string, threadId: string): Promise<boolean> =>
    runAsTenant(tenantId, async () => {
      await runner.hydrate();
      return runner.isRunning({ threadId });
    });
}

/**
 * The person's work hours as the checker reads them: what they saved (`readWorkHours`) -- the
 * defaults (09:00 to 18:00, weekdays) on the zone their browser wrote, else the product's own
 * (`DEFAULT_TIME_ZONE`), the zone a coworker's 「下午三点」 is read on -- so the day the three reminders
 * are counted in, the work hours and the due time a nudge quotes are all on one clock.
 */
export function savedWorkHours(database: Database) {
  return (userId: string): Promise<WorkHours> =>
    readWorkHours(database, userId);
}

/** The local calendar day of an instant on a zone's clock: "2026-11-16". */
export function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

const minutesOf = (clock: string): number => {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** Whether `now` is in the hour the person's start briefing may go out in, on their clock. */
export function inStartBriefingHour(hours: WorkHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) =>
    Number(parts.find((piece) => piece.type === type)?.value ?? 0);
  const minute = part("hour") * 60 + part("minute");
  const start = minutesOf(hours.start);
  return minute >= start && minute < start + BRIEFING_WINDOW_MS / MINUTE;
}

/** Whether `now` is inside the person's work hours, on their clock. */
export function withinWorkHours(hours: WorkHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((piece) => piece.type === type)?.value ?? "";
  if (
    !hours.weekends &&
    (part("weekday") === "Sat" || part("weekday") === "Sun")
  )
    return false;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return minute >= minutesOf(hours.start) && minute < minutesOf(hours.end);
}

/** A stretch of time as the person reads it: 「40 分钟」「2 小时 5 分钟」. */
function lengthOf(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** What the checker reads of a card. */
type CheckedCard = {
  id: string;
  title: string;
  executorAgentId: string | null;
  threadRef: string | null;
  acceptedAt: Date | null;
  dueAt: Date | null;
  overdueAt: Date | null;
  nudges: number;
  lastNudgedAt: Date | null;
  lastNotifiedAt: Date | null;
  notifiedOn: string | null;
  notifiedCount: number;
  reminderHeldAt: Date | null;
  nudgedOn: string | null;
  nudgedCount: number;
  handoverPendingAt: Date | null;
  createdAt: Date;
};

const checkedColumns = {
  id: tasks.id,
  title: tasks.title,
  executorAgentId: tasks.executorAgentId,
  threadRef: tasks.threadRef,
  acceptedAt: tasks.acceptedAt,
  dueAt: tasks.dueAt,
  overdueAt: tasks.overdueAt,
  nudges: tasks.nudges,
  lastNudgedAt: tasks.lastNudgedAt,
  lastNotifiedAt: tasks.lastNotifiedAt,
  notifiedOn: tasks.notifiedOn,
  notifiedCount: tasks.notifiedCount,
  reminderHeldAt: tasks.reminderHeldAt,
  nudgedOn: tasks.nudgedOn,
  nudgedCount: tasks.nudgedCount,
  handoverPendingAt: tasks.handoverPendingAt,
  createdAt: tasks.createdAt,
};

/** A card the checker looks at: followed, with its coworker, and the work with the coworker. */
const checkable = (tenantId: string, taskId: string) =>
  and(
    eq(tasks.tenantId, tenantId),
    eq(tasks.id, taskId),
    eq(tasks.tracked, true),
    /*
     * `running` only: `awaiting_review` is handed in (the person's turn to review), and `needs_action`
     * waits on the person (an approval or a question) -- nudging the coworker about either is noise.
     */
    eq(tasks.status, "running"),
    isNotNull(tasks.threadRef),
    isNotNull(tasks.executorAgentId),
  );

/** Where a card is on the checker's clock. */
type Schedule = {
  /** The due time in force, for an accepted card; null while it waits to be taken on. */
  deadline: Date | null;
  /** The first nudge's moment; the first reminder's is thirty minutes later. */
  nudgeAt: Date;
  noticeAt: Date;
  /** When the card started waiting to be taken on (for a card not yet accepted). */
  waitingSince: Date;
};

function scheduleOf(card: CheckedCard, waitingSince: Date): Schedule {
  const deadline = card.acceptedAt
    ? (card.dueAt ?? new Date(card.acceptedAt.getTime() + UNREPORTED_DUE_MS))
    : null;
  const nudgeAt = new Date(
    (deadline ?? waitingSince).getTime() + NUDGE_AFTER_MS,
  );
  return {
    deadline,
    /*
     * A hand-over whose message did not go out (the new coworker's thread was busy) is said at the
     * first look that finds the thread free, not five minutes on: it is the person's own hand-over,
     * late. When the person is told stays as for any card waiting to be taken on.
     */
    nudgeAt: handoverWaits(card)
      ? new Date(Math.min(nudgeAt.getTime(), card.handoverPendingAt.getTime()))
      : nudgeAt,
    noticeAt: new Date(nudgeAt.getTime() + NOTIFY_AFTER_NUDGE_MS),
    waitingSince,
  };
}

/** A hand-over still to be said to a new coworker that has not taken the work on. */
function handoverWaits(
  card: Pick<CheckedCard, "acceptedAt" | "handoverPendingAt">,
): card is CheckedCard & { handoverPendingAt: Date } {
  return card.acceptedAt === null && card.handoverPendingAt !== null;
}

/**
 * Since when the card has waited for its 接活回执: its latest `dispatched` (followed) or `reassigned`
 * (handed to a new coworker) line, else when it was opened.
 */
export async function waitingSinceOf(
  database: Pick<Database, "select">,
  tenantId: string,
  card: Pick<CheckedCard, "id" | "acceptedAt" | "createdAt">,
): Promise<Date> {
  if (card.acceptedAt) return card.acceptedAt;
  const [latest] = await database
    .select({ at: taskEvents.createdAt })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.tenantId, tenantId),
        eq(taskEvents.taskId, card.id),
        inArray(taskEvents.kind, ["dispatched", "reassigned"]),
      ),
    )
    .orderBy(desc(taskEvents.createdAt))
    .limit(1);
  return latest?.at ?? card.createdAt;
}

/** Whether something last done at `last` may be done again now, for a moment that began at `from`. */
const spaced = (last: Date | null, from: Date, now: Date) =>
  last === null ||
  last.getTime() < from.getTime() ||
  now.getTime() - last.getTime() >= REPEAT_MS;

/** What is due on a card now, read from its locked row. */
function dueOn(
  card: CheckedCard,
  schedule: Schedule,
  now: Date,
  clock: { inHours: boolean; today: string; startBriefing: boolean },
) {
  // Only in the person's work hours, and not a fourth time in their day.
  const nudge =
    clock.inHours &&
    (card.nudgedOn !== clock.today || card.nudgedCount < DAILY_NUDGES) &&
    now >= schedule.nudgeAt &&
    spaced(card.lastNudgedAt, schedule.nudgeAt, now);
  const overdue =
    schedule.deadline !== null &&
    now >= schedule.noticeAt &&
    card.overdueAt === null;
  const reminder =
    now >= schedule.noticeAt &&
    spaced(card.lastNotifiedAt, schedule.noticeAt, now);
  const notify =
    reminder &&
    (clock.inHours
      ? (card.notifiedOn !== clock.today ||
          card.notifiedCount < DAILY_NOTICES) &&
        // Held for the start briefing, which is going out now: it says it, not a push of its own.
        !(card.reminderHeldAt !== null && clock.startBriefing)
      : // Held already: one reminder waits for the briefing, not one every two hours of the night.
        card.reminderHeldAt === null);
  return { nudge, overdue, notify };
}

/**
 * What the coworker is told when nudged: which piece of work, how late, and what to do -- hand in what
 * is done or ask for more time (spec §8). Also the person's 再催.
 */
export function nudgeTextOf(
  card: Pick<CheckedCard, "title" | "acceptedAt" | "dueAt"> & {
    createdAt?: Date;
  },
  now: Date,
  timeZone: string,
  waitingSince?: Date,
  /** An external employee: told what to write, not which tool to call (it holds none). */
  options: { external?: boolean } = {},
): string {
  const title = `『${card.title}』`;
  const external = options.external === true;
  if (!card.acceptedAt) {
    const since = waitingSince ?? card.createdAt ?? now;
    const waited = `【系统催办】${title}派给你 ${lengthOf(now.getTime() - since.getTime())}了，还没接下。`;
    return external
      ? `${waited}能做就在回复里说已接下，并写「预计 HH:MM」或「预计 N 分钟」（换成真实的时间）；做不了就直接说明原因。\n${EXTERNAL_DELIVERY_GUIDE}`
      : `${waited}能做就先调用 accept_task 回执：预计几点交、验收标准；做不了就直接说明原因。`;
  }
  const what = external
    ? `做完的部分现在就交：改动会自动当作交付物，没有改动的就写一句「结论：」开头的交付结论，并用「自查：」开头的一句写你怎么查过的；交不了就说明缺什么，并写「延到 HH:MM」（换成真实的时间）说要延到几点。\n${EXTERNAL_DELIVERY_GUIDE}`
    : "做完的部分先用 deliver_task 交上来，写上你怎么查过的；交不了就用 request_extension 申请延期，说明缺什么、要延到几点。";
  if (!card.dueAt)
    return `【系统催办】${title}接下 ${lengthOf(now.getTime() - card.acceptedAt.getTime())}了还没交，也没报预计时间。${what}`;
  const late = now.getTime() - card.dueAt.getTime();
  /*
   * An external employee's 「预计 …」 is read off its replies (`dueSaidIn`): the card's time is quoted
   * as 「原定」, so one repeating it back -- after a hand-over, its own first time still to come -- is
   * not taken as having given it.
   */
  const promised = `${external ? "原定" : "预计"} ${clockOf(card.dueAt, now, timeZone)} 交`;
  return late > 0
    ? `【系统催办】${title}${promised}，已经过了 ${lengthOf(late)}。${what}`
    : `【系统催办】${title}${promised}，进展如何？${what}`;
}

/** What the new coworker is told on a hand-over; an external employee is told what to write, not which tool to call. */
export function handoverText(
  card: {
    title: string;
    criteria: string | null;
    deliverable: DeliverableRef | null;
    progress: string | null;
  },
  options: { external?: boolean } = {},
): string {
  const handedIn = card.deliverable
    ? [
        ...(card.deliverable.notes ?? []).map((note) => `结论：${note}`),
        ...(card.deliverable.links ?? []).map(
          (link) => `链接：${link.title ? `${link.title} ` : ""}${link.url}`,
        ),
        ...(card.deliverable.attachments ?? []).map((id) => `附件 ${id}`),
        ...(card.deliverable.components ?? []).map(
          (component) => `组件 ${component.name}`,
        ),
        ...(card.deliverable.diffs ?? []).map((diff) => diffTitle(diff)),
        ...(card.deliverable.checks ?? []).map((check) => `自查：${check}`),
      ]
    : [];
  return [
    `【系统转交】这件活从另一位员工那里转给你：『${card.title}』。`,
    `验收标准：${card.criteria ?? "（没写）"}`,
    handedIn.length
      ? `已经交过的：${handedIn.join("；")}`
      : "已经交过的：还没有",
    `上一位员工最后的进度：${card.progress ?? "（没有记录）"}`,
    options.external
      ? `先在回复里说已接下，并写「预计 HH:MM」或「预计 N 分钟」（换成真实的时间），再接着做。\n${EXTERNAL_DELIVERY_GUIDE}`
      : "先调用 accept_task 接下（预计几点交、验收标准），再接着做。",
  ].join("\n");
}

/** What the person is told about the card. */
function noticeOf(
  card: CheckedCard,
  schedule: Schedule,
  now: Date,
  name: string,
  queued: { offline: boolean } | null,
): DeliveryNotice {
  // The work is waiting in an external employee's queue: said, since that is why nothing moves.
  const waiting = queued
    ? queued.offline
      ? "，电脑离线，活还在排队"
      : "，活还在排队"
    : "";
  if (!schedule.deadline)
    return {
      kind: "pending_accept",
      taskId: card.id,
      text: queued
        ? `${name}还没接下『${card.title}』（${waiting.slice(1)}）`
        : `${name}还没接下『${card.title}』`,
    };
  return {
    kind: "overdue",
    taskId: card.id,
    text: `『${card.title}』已逾期 ${lengthOf(now.getTime() - schedule.deadline.getTime())}（${name}，催过 ${card.nudges} 次${waiting}）`,
  };
}

const log = (type: string, detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ type, ...detail }));

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * One pass over every followed card that has not ended (see the module comment). `now` is the pass's
 * clock: the loop gives the wall clock, a test its own.
 */
export async function runDeliveryCheck(
  deps: DeliveryCheckDeps,
  now: Date,
): Promise<void> {
  const delivery = createDelivery(deps.database);
  const page = deps.cardsPerPass ?? CARDS_PER_PASS;
  /** Where the last page ended: its last card's next moment (as text, to the microsecond) and id. */
  let after: { moment: string; id: string } | null = null;
  /** Cards this pass already checked: one whose next moment moved on as it was checked is not checked twice. */
  const checked = new Set<string>();
  for (;;) {
    const cards = await cardsAfter(deps, after, page);
    for (const card of cards) {
      if (checked.has(card.id)) continue;
      checked.add(card.id);
      await checkOne(deps, delivery, card, now);
    }
    const last = cards.at(-1);
    if (!last || cards.length < page) return;
    after = { moment: last.moment, id: last.id };
  }
}

/**
 * Soonest-due first, by a rough next moment: five minutes past the due time (or the opening, for a card
 * still waiting to be taken on), or two hours after the last nudge if that is later. The cards nearest
 * to needing something are checked first in a pass, not whichever changed least recently.
 */
const nextMoment = sql`greatest(
  coalesce(${tasks.dueAt}, ${tasks.acceptedAt} + interval '2 hours', ${tasks.createdAt}) + interval '5 minutes',
  coalesce(${tasks.lastNudgedAt} + interval '2 hours', '-infinity'::timestamptz)
)`;

/**
 * One page of the cards to look at, across every tenant -- their ids and tenants, and nothing else --
 * after `after` in the pass's order.
 *
 * EVERY CARD, EVERY PASS: the pass reads page after page (keyset on the next moment and the id) until
 * none is left, rather than one page and "the rest wait a minute". A card the pass can do nothing about
 * -- queued with an external employee whose computer is away, outside the person's hours, out of the
 * day's nudges -- keeps its next moment, so it stays first in the order however often it is checked,
 * and a single page of such cards would have taken every pass forever: the cards behind them never
 * checked, never recorded overdue, nobody told. The page bounds what one query holds, not what a pass
 * does. Passes do not overlap (the loop waits for one to finish before the next minute's), and a card
 * whose next moment moves while the pass runs is checked next pass at worst.
 */
async function cardsAfter(
  deps: DeliveryCheckDeps,
  after: { moment: string; id: string } | null,
  page: number,
): Promise<{ id: string; tenantId: string; moment: string }[]> {
  return asPlatform(() =>
    deps.database
      .select({
        id: tasks.id,
        tenantId: tasks.tenantId,
        moment: sql<string>`(${nextMoment})::text`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.tracked, true),
          eq(tasks.status, "running"),
          ...(deps.onlyTenants
            ? [inArray(tasks.tenantId, [...deps.onlyTenants])]
            : []),
          ...(after
            ? [
                sql`(${nextMoment}, ${tasks.id}) > (${after.moment}::timestamptz, ${after.id}::uuid)`,
              ]
            : []),
        ),
      )
      .orderBy(nextMoment, tasks.id)
      .limit(page),
  );
}

/** Check one card of a pass, in the tenant stamped on its row. */
async function checkOne(
  deps: DeliveryCheckDeps,
  delivery: Delivery,
  card: { id: string; tenantId: string },
  now: Date,
): Promise<void> {
  // The row's own stamp is the only tenant a card is checked in (G01); a card stamped as nobody's is skipped.
  let tenantId: string;
  try {
    tenantId = assertPersonTenant(card.tenantId);
  } catch (error) {
    if (!(error instanceof TenantContextError)) throw error;
    log("delivery-check-untrusted-tenant", { taskId: card.id });
    return;
  }
  try {
    await runAsTenant(tenantId, () =>
      checkCard(deps, delivery, tenantId, card.id, now),
    );
  } catch (error) {
    log("delivery-check-card-failed", {
      taskId: card.id,
      reason: reasonOf(error),
    });
  }
}

async function checkCard(
  deps: DeliveryCheckDeps,
  delivery: Delivery,
  tenantId: string,
  taskId: string,
  now: Date,
): Promise<void> {
  const database = deps.database;
  // A first look without a lock: most cards most minutes have nothing due, and are asked nothing more.
  const [seen] = await database
    .select(checkedColumns)
    .from(tasks)
    .where(checkable(tenantId, taskId))
    .limit(1);
  if (!seen?.threadRef || !seen.executorAgentId) return;
  const first = scheduleOf(
    seen,
    await waitingSinceOf(database, tenantId, seen),
  );
  if (now < first.nudgeAt) return;
  // The coworker is at it right now: not a word, and not a line; the next pass looks again.
  if (await deps.turnRunning(tenantId, seen.threadRef)) return;
  // Queued and not running: the card is still checked, but nobody is nudged into a second turn.
  const queued =
    (await deps.turnQueued?.(tenantId, seen.threadRef).catch(() => null)) ??
    null;
  const external =
    (await deps
      .isExternal?.(tenantId, seen.executorAgentId)
      .catch(() => false)) ?? false;

  const hours = await deps.workHours(tenantId);
  const inHours = withinWorkHours(hours, now);
  const startBriefing = inHours && inStartBriefingHour(hours, now);
  const today = localDay(now, hours.timeZone);
  const name =
    (await deps
      .agentName?.(tenantId, seen.executorAgentId)
      .catch(() => null)) ?? "员工";

  // The claim: what is due, decided from the locked row and written to it, before anything leaves.
  const claim = await database.transaction(async (transaction) => {
    const [card] = await transaction
      .select(checkedColumns)
      .from(tasks)
      .where(checkable(tenantId, taskId))
      .for("update", { skipLocked: true });
    // Another checker holds it, or it moved on since the first look.
    if (!card) return null;
    const schedule = scheduleOf(
      card,
      await waitingSinceOf(transaction, tenantId, card),
    );
    const due = dueOn(card, schedule, now, { inHours, today, startBriefing });
    if (queued) due.nudge = false;
    if (!due.nudge && !due.overdue && !due.notify) return null;
    const notice = noticeOf(card, schedule, now, name, queued);
    await transaction
      .update(tasks)
      .set({
        ...(due.nudge ? { lastNudgedAt: now } : {}),
        ...(due.overdue ? { overdueAt: now, updatedAt: new Date() } : {}),
        ...(due.notify && inHours
          ? {
              lastNotifiedAt: now,
              notifiedOn: today,
              notifiedCount:
                card.notifiedOn === today ? card.notifiedCount + 1 : 1,
              reminderHeldAt: null,
            }
          : {}),
        ...(due.notify && !inHours
          ? { lastNotifiedAt: now, reminderHeldAt: now }
          : {}),
      })
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)));
    if (due.overdue && schedule.deadline)
      await appendTaskEvent(transaction, {
        tenantId,
        taskId,
        kind: "overdue",
        actor: "system",
        detail: {
          dueAt: schedule.deadline.toISOString(),
          at: now.toISOString(),
        },
      });
    // Outside work hours the reminder is kept, not sent: the next start briefing carries it.
    if (due.notify && !inHours)
      await appendTaskEvent(transaction, {
        tenantId,
        taskId,
        kind: "notified",
        actor: "system",
        detail: {
          ...noticeDetail(notice),
          result: "deferred",
          at: now.toISOString(),
        },
      });
    return { card, schedule, due, notice };
  });
  if (!claim) return;

  if (claim.due.notify && inHours)
    await remind(deps, tenantId, claim.notice, now, today);
  if (claim.due.nudge) {
    /*
     * The hand-over the new coworker never got, rather than a plain nudge: the plain one names the
     * work and asks for a receipt, and the new coworker would never hear what was done before it.
     */
    const handover = handoverWaits(claim.card)
      ? await delivery.handoverOf(tenantId, taskId)
      : null;
    await nudgeCoworker(
      deps,
      delivery,
      tenantId,
      taskId,
      handover
        ? handoverText(handover, { external })
        : nudgeTextOf(
            claim.card,
            now,
            hours.timeZone,
            claim.schedule.waitingSince,
            { external },
          ),
      {
        now,
        previous: claim.card.lastNudgedAt,
        today,
        handover: handover?.pendingAt ?? null,
      },
    );
  }
}

function noticeDetail(notice: DeliveryNotice) {
  return { kind: notice.kind, text: notice.text };
}

/**
 * Push the reminder the claim took. A reminder the sender did not push (`deferred`, `capped`) or could
 * not (a failure) gives its place in the day's count back; one it held is the briefing's.
 */
async function remind(
  deps: DeliveryCheckDeps,
  tenantId: string,
  notice: DeliveryNotice,
  now: Date,
  today: string,
): Promise<void> {
  let result: NoticeResult | null = null;
  try {
    result = await deps.notify(tenantId, notice, now);
  } catch (error) {
    log("delivery-check-notify-failed", {
      taskId: notice.taskId,
      reason: reasonOf(error),
    });
  }
  if (result)
    await appendTaskEvent(deps.database, {
      tenantId,
      taskId: notice.taskId,
      kind: "notified",
      actor: "system",
      detail: { ...noticeDetail(notice), result, at: now.toISOString() },
    });
  if (result === "sent") return;
  await deps.database
    .update(tasks)
    .set({
      notifiedCount: sql`greatest(${tasks.notifiedCount} - 1, 0)`,
      ...(result === "deferred" ? { reminderHeldAt: now } : {}),
    })
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.id, notice.taskId),
        eq(tasks.notifiedOn, today),
        eq(tasks.lastNotifiedAt, now),
      ),
    );
}

/**
 * Nudge the coworker as the claim said. Started: one `nudged` line, `nudges + 1`, and one more on the
 * day's count. The thread busy
 * after all: the claim is given back (`last_nudged_at` as it was) and nothing is written, as when the
 * pass saw the turn running. Refused for another reason (the coworker paused, the model refused): one
 * quiet `nudge_skipped` line, and the claim stands, so the next try is two hours on, not every minute.
 */
async function nudgeCoworker(
  deps: DeliveryCheckDeps,
  delivery: Delivery,
  tenantId: string,
  taskId: string,
  text: string,
  claim: {
    now: Date;
    previous: Date | null;
    today: string;
    /** The hand-over this round says, cleared from the card once the round starts. */
    handover?: Date | null;
  },
): Promise<void> {
  let outcome: "started" | "skipped_running";
  try {
    outcome = await deps.nudge(tenantId, taskId, text);
  } catch (error) {
    log("delivery-check-nudge-refused", { taskId, reason: reasonOf(error) });
    await appendTaskEvent(deps.database, {
      tenantId,
      taskId,
      kind: "nudge_skipped",
      actor: "system",
      detail: {
        reason: reasonOf(error),
        ...(error instanceof TurnNotStarted && error.detail
          ? { cause: error.detail }
          : {}),
        at: claim.now.toISOString(),
      },
    });
    return;
  }
  if (outcome === "started") {
    await delivery.nudged(tenantId, taskId, {
      actor: "system",
      text,
      at: claim.now,
      day: claim.today,
    });
    if (claim.handover)
      await delivery.handedOver(tenantId, taskId, claim.handover);
    return;
  }
  await deps.database
    .update(tasks)
    .set({ lastNudgedAt: claim.previous })
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.id, taskId),
        eq(tasks.lastNudgedAt, claim.now),
      ),
    );
}
