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

/** Where an event-started firing came from (AUT2): the public hook, or the signed-in API. */
export type AutomationEventSource = "hook" | "api";

/**
 * What an event-started firing carries to its executor (AUT2). `payload` came from outside the
 * product: an executor hands it on as untrusted data, never as an instruction.
 */
export type AutomationEvent = {
  source: AutomationEventSource;
  receivedAt: string;
  payload: Record<string, unknown>;
};

/**
 * Carries one begun firing out. Called in the owner's tenant frame; expected not to throw. `event`
 * is present when the firing was started by a hook or an API call rather than by the clock.
 */
export type AutomationFiringExecutor = (
  firing: AutomationFiring,
  event?: AutomationEvent,
) => Promise<void>;

export type AutomationSweepOptions = {
  store: Pick<
    AutomationStore,
    "dueTriggers" | "advanceTrigger" | "beginFiring" | "finishFiring"
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
export function minuteKey(due: Date): string {
  return `${due.toISOString().slice(0, 16)}Z`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * AUT2: one event (a hook delivery or an API call) becomes one work item, offered in the owner's
 * frame — the tenant the caller read from the trigger or automation row, never from the request.
 *
 * The key carries the caller's idempotency key, so the same delivery again collides here; the
 * firing's identity (`<source>:<delivery id>`) collides again in `beginFiring` after the queue row is
 * gone. Phase two below claims it like any other firing.
 */
export async function offerAutomationEvent(
  queue: Pick<WorkQueue, "offer">,
  input: {
    tenantId: string;
    automationId: string;
    triggerId: string;
    source: AutomationEventSource;
    deliveryId: string;
    payload: Record<string, unknown>;
    receivedAt: Date;
  },
): Promise<{ status: "queued" | "already" | "refused"; key: string }> {
  const tenant = assertPersonTenant(input.tenantId);
  const externalId = `${input.source}:${input.deliveryId}`;
  const key = `${input.triggerId}:${externalId}`;
  const status = await runAsTenant(tenant, async () => {
    return await queue.offer({
      kind: AUTOMATION_FIRE_KIND,
      key,
      payload: {
        automationId: input.automationId,
        triggerId: input.triggerId,
        triggerKind: "webhook",
        source: input.source,
        externalId,
        receivedAt: input.receivedAt.toISOString(),
        event: input.payload,
      },
    });
  });
  return { status, key };
}

/** The event an item carries, when it was offered by `offerAutomationEvent`. */
function eventOf(payload: Record<string, unknown>): AutomationEvent | null {
  const source = payload.source;
  if (source !== "hook" && source !== "api") return null;
  const event = payload.event;
  return {
    source,
    receivedAt:
      typeof payload.receivedAt === "string" ? payload.receivedAt : "",
    payload:
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : {},
  };
}

/** Phase one: due triggers become idempotent work items, and each trigger's clock moves once. */
export async function offerDueAutomations(
  options: AutomationSweepOptions,
): Promise<{ offered: string[] }> {
  const now = options.now?.() ?? new Date();
  const graceMs = options.graceMs ?? AUTOMATION_GRACE_MS;
  const due = await options.store.dueTriggers(options.limit ?? DEFAULT_LIMIT);
  const offered: string[] = [];

  for (const trigger of due) {
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
      // An event (AUT2) carries what started it; its identity is the delivery it came with.
      const event = scheduledFor ? null : eventOf(item.payload);
      const eventId = item.payload.externalId;
      // The firing's identity: this trigger at this minute, or this delivery. A redelivery collides.
      const externalId = scheduledFor
        ? `due:${minuteKey(scheduledFor)}`
        : event && typeof eventId === "string" && eventId
          ? eventId
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
            await (event ? execute(firing, event) : execute(firing));
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
