import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { taskEvents, tasks, users } from "../db/schema";
import type { NoticeRunner } from "../devices/queued-results";
import {
  asPlatform,
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import { createDelivery, type Delivery } from "./delivery";
import { clockOf } from "./due-time";
import { appendTaskEvent } from "./events";

/**
 * The delivery checker (spec 2026-11-15-delivery-loop §8): the server's own clock over every followed
 * card that has not ended, once a minute.
 *
 * - 派出 · 待接下: five minutes after the card started waiting (followed, or handed to a new coworker)
 *   the coworker is nudged; thirty minutes after that the person is told it has not been taken on.
 * - 已接下: five minutes past the due time (`due_at`, or two hours after acceptance when no time was
 *   reported) the coworker is nudged; thirty-five minutes past it the card is recorded overdue (once:
 *   `overdue_at` is kept for good) and the person is told.
 * - After that, a nudge and a reminder at most every two hours each, and at most three reminders a day
 *   pushed to the person, a "day" being the person's own, on their time zone.
 * - Outside the person's work hours nothing is pushed: the reminder is held (`reminder_held_at`, and a
 *   `notified {result: "deferred"}` line) for the next start briefing, one per card until it is pushed.
 *   The coworker is still nudged: a nudge is not a push.
 * - While a turn is running on the card's thread nothing is done and nothing is written; the next pass
 *   looks again. "Running" is the runner's answer about the thread, never `active_run_ref` alone: a
 *   server that died mid-round leaves the column naming a round nothing runs any more.
 *
 * TWO REPLICAS, ONE NUDGE. Each card is claimed under its row lock (`for update skip locked`): what is
 * due is decided from the locked row and written to it (`last_nudged_at`, `overdue_at`,
 * `last_notified_at`, `notified_on` / `notified_count`, `reminder_held_at`) before anything leaves the
 * server, so a second checker on the same card skips it while it is held, and finds nothing due once it
 * is not. The nudge and the notification run after the claim commits -- a nudge waits for its turn to
 * start, and a row lock held over that would block the turn's own write to the card. A nudge that
 * finds the thread busy after all gives its claim back.
 *
 * WHOSE FRAME. The pass asks as `platform` which cards are followed and open, across every tenant, and
 * nothing else; each card is then checked, and every line written, in the tenant stamped on its own row.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long after a card starts waiting, or after its due time, the coworker is nudged. */
export const NUDGE_AFTER_MS = 5 * MINUTE;
/** How long after the first nudge's moment the person is told (and an accepted card is overdue). */
export const NOTIFY_AFTER_NUDGE_MS = 30 * MINUTE;
/** The least time between two nudges, and between two reminders, about one card. */
export const REPEAT_MS = 2 * HOUR;
/** The due time of a card whose coworker named none: this long after it was taken on. */
export const UNREPORTED_DUE_MS = 2 * HOUR;
/** Reminders pushed to the person about one card in one of their days. */
export const DAILY_NOTICES = 3;
/** Cards one pass checks, oldest change first; the rest wait a minute. */
const CARDS_PER_PASS = 500;

/** When the person works, on their own clock (Task 6 reads it from their preferences). */
export type WorkHours = {
  /** "HH:MM". */
  start: string;
  /** "HH:MM"; "24:00" is the end of the day. */
  end: string;
  /** An IANA zone, e.g. "Asia/Shanghai". */
  timeZone: string;
  /** Whether Saturdays and Sundays are work days. */
  weekends: boolean;
};

/** The default work hours: 09:00 to 18:00, weekdays (spec §10). */
export const DEFAULT_WORK_HOURS: Omit<WorkHours, "timeZone"> = {
  start: "09:00",
  end: "18:00",
  weekends: false,
};

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
  /** Tell the person (push, chat apps). Task 6 wires the real one. */
  notify: (tenantId: string, notice: DeliveryNotice) => Promise<NoticeResult>;
  /** Nudge the card's coworker (`tasks/nudge-run.ts` `startNudgeRun`). */
  nudge: (
    tenantId: string,
    taskId: string,
    text: string,
  ) => Promise<"started" | "skipped_running">;
  /** Whether a turn is running on the thread now: the runner's word ({@link threadRunning}). */
  turnRunning: (tenantId: string, threadId: string) => Promise<boolean>;
  /** The coworker's name as the person sees it, for what they are told. */
  agentName?: (tenantId: string, agentId: string) => Promise<string | null>;
  /** Narrow a pass to these tenants (a test's own people); absent, every tenant. */
  onlyTenants?: readonly string[];
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

/** Whether `timeZone` is one this runtime can read. */
function knownZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Work hours until Task 6 lets the person set them: the defaults, on the time zone their preferences
 * already hold (`workHours.timeZone`, else `timeZone`), else UTC.
 */
export function readDefaultWorkHours(database: Database) {
  return async (userId: string): Promise<WorkHours> => {
    const [user] = await runAsTenant(userId, () =>
      database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    const preferences = (user?.preferences ?? {}) as Record<string, unknown>;
    const hours = (preferences.workHours ?? {}) as Record<string, unknown>;
    const timeZone = [hours.timeZone, preferences.timeZone].find(knownZone);
    return { ...DEFAULT_WORK_HOURS, timeZone: timeZone ?? "UTC" };
  };
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
    nudgeAt,
    noticeAt: new Date(nudgeAt.getTime() + NOTIFY_AFTER_NUDGE_MS),
    waitingSince,
  };
}

/**
 * Since when the card has waited for its 接活回执: its latest `dispatched` (followed) or `reassigned`
 * (handed to a new coworker) line, else when it was opened.
 */
async function waitingSinceOf(
  database: Pick<Database, "select">,
  tenantId: string,
  card: CheckedCard,
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
  clock: { inHours: boolean; today: string },
) {
  const nudge =
    now >= schedule.nudgeAt && spaced(card.lastNudgedAt, schedule.nudgeAt, now);
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
      ? card.notifiedOn !== clock.today || card.notifiedCount < DAILY_NOTICES
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
): string {
  const title = `『${card.title}』`;
  if (!card.acceptedAt) {
    const since = waitingSince ?? card.createdAt ?? now;
    return `【系统催办】${title}派给你 ${lengthOf(now.getTime() - since.getTime())}了，还没接下。能做就先调用 accept_task 回执：预计几点交、验收标准；做不了就直接说明原因。`;
  }
  const what =
    "做完的部分先用 deliver_task 交上来，写上你怎么查过的；交不了就用 request_extension 申请延期，说明缺什么、要延到几点。";
  if (!card.dueAt)
    return `【系统催办】${title}接下 ${lengthOf(now.getTime() - card.acceptedAt.getTime())}了还没交，也没报预计时间。${what}`;
  const late = now.getTime() - card.dueAt.getTime();
  return late > 0
    ? `【系统催办】${title}预计 ${clockOf(card.dueAt, now, timeZone)} 交，已经过了 ${lengthOf(late)}。${what}`
    : `【系统催办】${title}预计 ${clockOf(card.dueAt, now, timeZone)} 交，进展如何？${what}`;
}

/** What the person is told about the card. */
function noticeOf(
  card: CheckedCard,
  schedule: Schedule,
  now: Date,
  name: string,
): DeliveryNotice {
  if (!schedule.deadline)
    return {
      kind: "pending_accept",
      taskId: card.id,
      text: `${name}还没接下『${card.title}』`,
    };
  return {
    kind: "overdue",
    taskId: card.id,
    text: `『${card.title}』已逾期 ${lengthOf(now.getTime() - schedule.deadline.getTime())}（${name}，催过 ${card.nudges} 次）`,
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
  // Which cards to look at, across every tenant: their ids and tenants, and nothing else.
  const cards = await asPlatform(() =>
    deps.database
      .select({ id: tasks.id, tenantId: tasks.tenantId })
      .from(tasks)
      .where(
        and(
          eq(tasks.tracked, true),
          eq(tasks.status, "running"),
          ...(deps.onlyTenants
            ? [inArray(tasks.tenantId, [...deps.onlyTenants])]
            : []),
        ),
      )
      .orderBy(tasks.updatedAt)
      .limit(CARDS_PER_PASS),
  );
  for (const card of cards) {
    // The row's own stamp is the only tenant a card is checked in (G01); a card stamped as nobody's is skipped.
    let tenantId: string;
    try {
      tenantId = assertPersonTenant(card.tenantId);
    } catch (error) {
      if (!(error instanceof TenantContextError)) throw error;
      log("delivery-check-untrusted-tenant", { taskId: card.id });
      continue;
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

  const hours = await deps.workHours(tenantId);
  const inHours = withinWorkHours(hours, now);
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
    const due = dueOn(card, schedule, now, { inHours, today });
    if (!due.nudge && !due.overdue && !due.notify) return null;
    const notice = noticeOf(card, schedule, now, name);
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
  if (claim.due.nudge)
    await nudgeCoworker(
      deps,
      delivery,
      tenantId,
      taskId,
      nudgeTextOf(claim.card, now, hours.timeZone, claim.schedule.waitingSince),
      { now, previous: claim.card.lastNudgedAt },
    );
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
    result = await deps.notify(tenantId, notice);
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
 * Nudge the coworker as the claim said. Started: one `nudged` line and `nudges + 1`. The thread busy
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
  claim: { now: Date; previous: Date | null },
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
      detail: { reason: reasonOf(error), at: claim.now.toISOString() },
    });
    return;
  }
  if (outcome === "started") {
    await delivery.nudged(tenantId, taskId, {
      actor: "system",
      text,
      at: claim.now,
    });
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
