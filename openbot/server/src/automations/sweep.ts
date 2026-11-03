/**
 * D06 AUT1/AUT4: turning "this automation trigger is due" into exactly one firing.
 *
 * The same two halves as `routines/sweep.ts`, for the same reason: deciding what should fire is
 * not the act of firing it. Phase one reads every tenant's due triggers (as `platform`, which the
 * store says for itself), offers each one to the shared `work_items` queue IN THE OWNER'S FRAME
 * under a key that carries the minute it was due, and only then moves the trigger's clock with a
 * compare-and-set. Phase two claims those items, re-enters the owner's frame from the claimed row
 * (never a payload, never a default), and asks the store to begin the firing.
 *
 * TWO LAYERS OF IDEMPOTENCE. The queue key collapses replicas that woke at the same minute into one
 * work item. The firing's identity — trigger plus that same minute, a unique key on
 * `automation_firings` — collapses a redelivered work item into nothing: `beginFiring` answers
 * `duplicate` and neither counts a run nor starts one. So the queue item is finished the moment a
 * firing has begun, BEFORE the executor runs: a turn can take minutes, far longer than a lease, and
 * the firing row (not the lease) is what says it already happened.
 *
 * The key format is `routines/sweep.ts`'s minute key, pinned in `minuteKey` below and asserted
 * literally in `tests/automation-sweep.integration.test.ts`.
 */
import { assertPersonTenant, runAsTenant } from "../tenant/context";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import type { AutomationFiring, AutomationStore } from "./store";
import type { AutomationTargetKind } from "./types";

export const AUTOMATION_FIRE_KIND = "automation.fire";

/** How late a firing may be and still be worth having: under the 15-minute floor, like routines. */
export const AUTOMATION_GRACE_MS = 10 * 60_000;

const DEFAULT_LIMIT = 50;
const DEFAULT_LEASE_MS = 60_000;
const RETRY_DELAY_MS = 60_000;
const NO_EXECUTOR = "这个执行对象暂时无法自动运行。";

/** Carries one begun firing out. Called in the owner's tenant frame; expected not to throw. */
export type AutomationFiringExecutor = (
  firing: AutomationFiring,
) => Promise<void>;

export type AutomationSweepOptions = {
  store: Pick<
    AutomationStore,
    | "dueTriggers"
    | "advanceTrigger"
    | "beginFiring"
    | "finishFiring"
    | "reapAbandonedFirings"
  >;
  queue: WorkQueue;
  /** Who carries out each target kind (AUT3). A kind with nothing registered fails its firing. */
  executors: Partial<Record<AutomationTargetKind, AutomationFiringExecutor>>;
  /** Who this process is, for the lease. */
  owner: string;
  leaseMs?: number;
  maxAttempts?: number;
  limit?: number;
  graceMs?: number;
  /**
   * A clock for tests. Unset in production, where phase one judges "due" and "late" on the
   * database's clock end to end (`dueTriggers` hands its `now()` back with every row). When given,
   * phase one uses it end to end instead — it is handed to `dueTriggers` too — so a test's stamps and
   * its clock cannot disagree. Phase two reads it (or the process clock) for its claim-time window
   * check, as `routines/sweep.ts` does.
   */
  now?: () => Date;
  /**
   * Where a begun firing is carried out. Omitted, it is awaited inside this pass (the tests do this,
   * to read the outcome straight after). The server hands it off instead: offering and dispatching
   * share one loop, and a pass held for minutes by a slow turn would leave the next due triggers
   * past the grace window — marked missed by the offer, or dropped by the claim-time check — without
   * ever firing. The firing is already counted and recorded, so handing it off loses nothing.
   */
  background?: (run: () => Promise<void>) => void;
};

export type AutomationSweepReport = {
  considered: number;
  fired: string[];
  skipped: { automationId: string; reason: string }[];
};

/**
 * The minute a firing was due, rendered the same way by every replica: `2026-08-26T09:30Z`.
 * THE FORMAT IS THE IDEMPOTENCE — change it and every key already queued is orphaned.
 */
/**
 * How long a firing may stay `running`, untouched, before a pass declares it abandoned: twice the
 * unattended turn timeout, the same horizon as `ABANDONED_RUN_MS` in `routines/sweep.ts`, so a
 * slow-but-alive turn always records its own outcome first.
 */
export const ABANDONED_FIRING_MS = 10 * 60_000;

export const ABANDONED_FIRING_ERROR =
  "服务器没有完成这次执行，可能中途重启了；本次不会重新执行。";

export function minuteKey(due: Date): string {
  return `${due.toISOString().slice(0, 16)}Z`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Phase one: due triggers become idempotent work items, and each trigger's clock moves once. */
export async function offerDueAutomations(
  options: AutomationSweepOptions,
): Promise<{ offered: string[] }> {
  const testClock = options.now?.();
  const graceMs = options.graceMs ?? AUTOMATION_GRACE_MS;
  const due = await options.store.dueTriggers(
    options.limit ?? DEFAULT_LIMIT,
    testClock,
  );
  const offered: string[] = [];

  for (const trigger of due) {
    // The clock the row was judged due by: the database's, never this replica's.
    const now = trigger.asOf;
    try {
      // The owner, as the trigger row names it. A row that names nobody is not acted on at all.
      const tenant = assertPersonTenant(trigger.tenantId);
      const lateBy = now.getTime() - trigger.nextRunAt.getTime();
      if (trigger.kind !== "unreadable" && lateBy <= graceMs) {
        // Offered BEFORE the clock moves: a crash between the two re-offers the same key next pass.
        await runAsTenant(tenant, async () => {
          await options.queue.offer({
            kind: AUTOMATION_FIRE_KIND,
            key: `${trigger.id}:${minuteKey(trigger.nextRunAt)}`,
            payload: {
              automationId: trigger.automationId,
              triggerId: trigger.id,
              triggerKind: trigger.kind,
              scheduledFor: trigger.nextRunAt.toISOString(),
            },
          });
        });
        offered.push(trigger.automationId);
        // False means another sweep moved it first; the offer collided under the same key either way.
        await runAsTenant(tenant, async () => {
          await options.store.advanceTrigger(trigger.id, trigger.nextRunAt);
        });
      } else {
        // A stale stamp is not a backlog to replay: move the clock without firing.
        await runAsTenant(tenant, async () => {
          await options.store.advanceTrigger(trigger.id, trigger.nextRunAt, {
            now,
            missed: true,
          });
        });
      }
    } catch (error) {
      // One trigger's failure is one trigger's failure; the pass carries on.
      console.warn(
        JSON.stringify({
          type: "automation-sweep-offer-failed",
          automationId: trigger.automationId,
          triggerId: trigger.id,
          reason: reasonOf(error),
        }),
      );
    }
  }
  return { offered };
}

/** Phase two: claimed items become begun firings, each carried out by its target's executor. */
export async function dispatchClaimedAutomations(
  options: AutomationSweepOptions,
): Promise<AutomationSweepReport> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const graceMs = options.graceMs ?? AUTOMATION_GRACE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await options.queue.claim({
    kind: AUTOMATION_FIRE_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });
  const report: AutomationSweepReport = {
    considered: claimed.length,
    fired: [],
    skipped: [],
  };

  /*
   * THE REAPER (WF-F: mark failed, never replay). The queue item is finished the moment a firing
   * has begun, so a server that dies before the outcome is recorded leaves the firing `running` with
   * nothing to come back for it. Age is the signal, on the database's clock; best-effort, so a
   * reaper that cannot run never stops this pass from carrying out what it claimed.
   */
  try {
    const reaped = await options.store.reapAbandonedFirings(
      ABANDONED_FIRING_MS,
      ABANDONED_FIRING_ERROR,
    );
    if (reaped > 0) {
      console.warn(
        JSON.stringify({ type: "automation-firings-reaped", reaped }),
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "automation-firing-reap-failed",
        reason: reasonOf(error),
      }),
    );
  }

  const finish = async (key: string, automationId: string, reason: string) => {
    const finished = await options.queue.finish({
      kind: AUTOMATION_FIRE_KIND,
      key,
      owner: options.owner,
    });
    if (!finished) {
      console.warn(
        JSON.stringify({
          type: "automation-fire-finish-lost",
          automationId,
          key,
          reason,
        }),
      );
    }
  };

  for (const item of claimed) {
    const automationId = String(item.payload.automationId ?? "");
    const triggerId = String(item.payload.triggerId ?? "");

    if (
      !(await options.queue.renew({
        kind: AUTOMATION_FIRE_KIND,
        key: item.key,
        owner: options.owner,
        leaseMs,
      }))
    ) {
      report.skipped.push({
        automationId,
        reason: "the lease went to another replica",
      });
      continue;
    }

    let tenant: string;
    try {
      // The tenant the database stamped on the claimed item. Never the payload's, never a default.
      tenant = assertPersonTenant(item.tenantId);
    } catch {
      const reason = "the work item names no person";
      await finish(item.key, automationId, reason);
      report.skipped.push({ automationId, reason });
      continue;
    }

    try {
      const now = options.now?.() ?? new Date();
      const stamp = item.payload.scheduledFor;
      const parsedStamp = typeof stamp === "string" ? new Date(stamp) : null;
      const scheduledFor =
        parsedStamp && !Number.isNaN(parsedStamp.getTime())
          ? parsedStamp
          : null;
      // The firing's identity: this trigger at this minute. A redelivery collides on it.
      const externalId = scheduledFor
        ? `due:${minuteKey(scheduledFor)}`
        : `item:${item.key}`;
      if (scheduledFor && now.getTime() - scheduledFor.getTime() > graceMs) {
        const reason = "claimed too long after the occurrence it was due for";
        await finish(item.key, automationId, reason);
        report.skipped.push({ automationId, reason });
        continue;
      }

      const begun = await runAsTenant(tenant, async () => {
        return await options.store.beginFiring({
          automationId,
          triggerId,
          externalId,
          fingerprint: item.key,
          now,
        });
      });
      if (begun.status !== "started") {
        const reason =
          begun.status === "duplicate"
            ? "this moment already fired"
            : `stopped: ${begun.reason}`;
        await finish(item.key, automationId, reason);
        report.skipped.push({ automationId, reason });
        continue;
      }

      // Counted and recorded, so the queue's part is over before the turn starts (see the header).
      await finish(item.key, automationId, "fired");
      const { firing } = begun;
      const execute = options.executors[firing.automation.target.kind];
      // Never throws: whatever happens is written on the firing row, in the owner's frame.
      const carryOut = () =>
        runAsTenant(tenant, async () => {
          try {
            if (!execute) {
              await options.store.finishFiring(
                firing.id,
                "failed",
                NO_EXECUTOR,
              );
              return;
            }
            await execute(firing);
          } catch (error) {
            // Executors record their own outcomes; this is the backstop for one that threw anyway.
            console.error(
              JSON.stringify({
                type: "automation-fire-crashed",
                automationId,
                firingId: firing.id,
                reason: reasonOf(error),
              }),
            );
            await options.store
              .finishFiring(firing.id, "failed", reasonOf(error))
              .catch(() => undefined);
          }
        });
      report.fired.push(automationId);
      if (options.background) {
        options.background(carryOut);
      } else {
        await carryOut();
      }
    } catch (error) {
      // Nothing began (or we could not tell): released for another go, bounded by the attempt cap.
      const reason = reasonOf(error);
      try {
        await options.queue.release({
          kind: AUTOMATION_FIRE_KIND,
          key: item.key,
          owner: options.owner,
          delayMs: RETRY_DELAY_MS,
          reason,
        });
      } catch (releaseError) {
        console.warn(
          JSON.stringify({
            type: "automation-fire-release-failed",
            automationId,
            reason: reasonOf(releaseError),
          }),
        );
      }
      if (item.attempts >= maxAttempts) {
        console.warn(
          JSON.stringify({
            type: "automation-fire-gave-up",
            automationId,
            key: item.key,
            attempts: item.attempts,
            reason,
          }),
        );
      }
      report.skipped.push({ automationId, reason });
    }
  }
  return report;
}
