import { actionFingerprint } from "../../../shared/runner-actions";

export { actionFingerprint } from "../../../shared/runner-actions";

import { randomUUID } from "node:crypto";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { workItems } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import type { DispatchTarget } from "./channel";

export function runnerQueueKind(target: DispatchTarget): string {
  return `runner.action/${target.tenantId}/${target.deviceId}`;
}
export const QUEUE_ATTENTION_THRESHOLD = 20;
const LEASE_MS = 120_000;
const UNKNOWN = "outcome_unknown";

/**
 * Who was told "queued" and where, so the outcome can reach that conversation once it is known.
 *
 * Held by the server from the governed call that queued the action (the Bot, the person, the run's
 * thread), never read from the action's own payload, and kept beside the action rather than inside
 * it: it is not part of what the machine is asked to do, nor of the fingerprint that fences a
 * different request reusing the same key.
 */
export type QueuedOrigin = {
  botId: string;
  actorId: string;
  threadId: string;
  toolCallId?: string;
};
export type QueuedAction = {
  key: string;
  action: string;
  payload: unknown;
  origin?: QueuedOrigin;
};
/** A concluded queued action whose outcome is owed to the conversation that asked for it. */
export type QueuedNotice = {
  key: string;
  action: string;
  payload: unknown;
  origin: QueuedOrigin;
  receipt: ActionReceipt;
};
const NOTICE_LEASE_MS = 120_000;
const NOTICE_BATCH = 25;
const ORIGIN_FIELD_MAX = 512;

function originOf(value: unknown): QueuedOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const field = (name: string) => {
    const text = body[name];
    return typeof text === "string" &&
      text.trim() !== "" &&
      text.length <= ORIGIN_FIELD_MAX
      ? text
      : null;
  };
  const botId = field("botId");
  const actorId = field("actorId");
  const threadId = field("threadId");
  if (!botId || !actorId || !threadId) return null;
  const toolCallId = field("toolCallId");
  return { botId, actorId, threadId, ...(toolCallId ? { toolCallId } : {}) };
}
/** What a paused device answers every new action with until its owner has checked and resumed it. */
export const DEVICE_PAUSED =
  "这台设备已暂停：有一项操作可能已经执行，但没有收到结果。请设备的主人先在「设置 › 我的设备」里核查并恢复，再让员工继续操作这台设备。";

export class DeviceDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown = true,
  ) {
    super(message);
    this.name = "DeviceDeliveryError";
  }
}

export type ActionReceipt = {
  state: "waiting" | "running" | "completed" | "unknown" | "failed";
  output?: unknown;
};
export type DeviceActionReview = {
  key: string;
  action: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  review: { at: string; by: string; resolution: string; note: string } | null;
};
export type DeviceQueue = {
  enqueue: (
    target: DispatchTarget,
    item: QueuedAction,
  ) => Promise<"queued" | "already" | "refused">;
  pending: (target: DispatchTarget) => Promise<number>;
  uncertain: (target: DispatchTarget) => Promise<number>;
  reviews: (target: DispatchTarget) => Promise<DeviceActionReview[]>;
  review: (
    target: DispatchTarget,
    key: string,
    input: {
      resolution: "checked_executed" | "checked_not_executed";
      note: string;
    },
  ) => Promise<boolean>;
  receipt: (
    target: DispatchTarget,
    key: string,
  ) => Promise<ActionReceipt | null>;
  executeOnce: <T>(
    target: DispatchTarget,
    item: QueuedAction,
    execute: () => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  drain: (
    target: DispatchTarget,
    owner: string,
    execute: (item: QueuedAction) => Promise<unknown>,
  ) => Promise<number>;
  /**
   * Lease the concluded actions whose outcome has not yet been told to the conversation that queued
   * them. A lease, not a flag, so two replicas flushing the same device never both hold one, and a
   * process that dies holding it gives it back when the lease runs out.
   */
  claimNotices: (
    target: DispatchTarget,
    owner: string,
  ) => Promise<QueuedNotice[]>;
  /**
   * Settle a leased notice: `posted` or `skipped` is final, `null` hands it back to be tried again.
   * False when the lease was no longer this owner's.
   */
  settleNotice: (
    target: DispatchTarget,
    key: string,
    owner: string,
    outcome: "posted" | "skipped" | null,
  ) => Promise<boolean>;
};

/**
 * A committed claim precedes dispatch. Once claimed, an action is never automatically executed by
 * another owner. Losing a reply or a process leaves an explicit unknown receipt, not fresh work.
 * Device kinds have no purge job: completed identities continue to fence late retries.
 */
export function createDeviceQueue(database: Database): DeviceQueue {
  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
  const keyOf = (target: DispatchTarget, key: string) =>
    `${runnerQueueKind(target)}:${key}`;
  const match = (target: DispatchTarget, key: string) =>
    and(
      eq(workItems.tenantId, target.tenantId),
      eq(workItems.kind, runnerQueueKind(target)),
      eq(workItems.key, keyOf(target, key)),
    );
  const deviceMatch = (target: DispatchTarget) =>
    and(
      eq(workItems.tenantId, target.tenantId),
      eq(workItems.kind, runnerQueueKind(target)),
    );
  const unresolved = (target: DispatchTarget) =>
    and(
      deviceMatch(target),
      eq(workItems.lastError, UNKNOWN),
      sql`${workItems.payload}->'review' is null`,
    );
  const withDevice = <T>(
    target: DispatchTarget,
    body: (tx: Transaction) => Promise<T>,
  ) =>
    runAsTenant(target.tenantId, () =>
      database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${runnerQueueKind(target)}, 0))`,
        );
        await tx
          .update(workItems)
          .set({
            finishedAt: sql`now()`,
            claimedBy: null,
            leaseUntil: null,
            updatedAt: sql`now()`,
            lastError: UNKNOWN,
          })
          .where(
            and(
              deviceMatch(target),
              isNull(workItems.finishedAt),
              sql`${workItems.attempts} > 0`,
              sql`(${workItems.leaseUntil} is null or ${workItems.leaseUntil} <= now())`,
            ),
          );
        return body(tx);
      }),
    );
  const assertUnpaused = async (tx: Transaction, target: DispatchTarget) => {
    const [unknown] = await tx
      .select({ key: workItems.key })
      .from(workItems)
      .where(unresolved(target))
      .limit(1);
    if (unknown) throw new DeviceDeliveryError(DEVICE_PAUSED);
  };
  const read = (target: DispatchTarget, key: string) =>
    runAsTenant(
      target.tenantId,
      async () =>
        (
          await database
            .select()
            .from(workItems)
            .where(match(target, key))
            .limit(1)
        )[0],
    );
  const receiptOf = (row: typeof workItems.$inferSelect): ActionReceipt => ({
    state:
      row.lastError === UNKNOWN
        ? "unknown"
        : row.lastError
          ? "failed"
          : row.finishedAt
            ? "completed"
            : row.attempts > 0
              ? "running"
              : "waiting",
    ...(row.finishedAt && !row.lastError
      ? { output: (row.payload as Record<string, unknown>).result ?? null }
      : {}),
  });
  const replay = <T>(receipt: ActionReceipt): T => {
    if (receipt.state === "completed") return receipt.output as T;
    throw new DeviceDeliveryError(
      receipt.state === "failed"
        ? "设备拒绝了这项操作，不会重放。"
        : "这项操作可能已经执行，但没有收到结果。请先在设备上核查，再发起新的操作。",
      receipt.state !== "failed",
    );
  };
  const conclude = (
    target: DispatchTarget,
    key: string,
    owner: string,
    output: unknown,
    error?: string,
  ) =>
    withDevice(target, async (tx) => {
      const [row] = await tx
        .update(workItems)
        .set({
          finishedAt: sql`now()`,
          claimedBy: null,
          leaseUntil: null,
          updatedAt: sql`now()`,
          lastError: error ?? null,
          ...(!error
            ? {
                payload: sql`${workItems.payload} || ${{ result: output ?? null }}::jsonb`,
              }
            : {}),
        })
        .where(
          and(
            match(target, key),
            eq(workItems.claimedBy, owner),
            isNull(workItems.finishedAt),
          ),
        )
        .returning({ key: workItems.key });
      if (!row)
        throw new DeviceDeliveryError(
          "The action receipt could not be confirmed. It will not be replayed.",
        );
    });
  const self: DeviceQueue = {
    async enqueue(target, item) {
      const fingerprint = actionFingerprint(item.action, item.payload);
      return withDevice(target, async (tx) => {
        const [row] = await tx
          .select()
          .from(workItems)
          .where(match(target, item.key))
          .limit(1);
        if (row) {
          const body = row.payload as Record<string, unknown>;
          if (
            (body.fingerprint ??
              actionFingerprint(String(body.action ?? ""), body.payload)) !==
            fingerprint
          )
            throw new DeviceDeliveryError(
              "This action id already belongs to a different request.",
              false,
            );
          return "already";
        }
        await assertUnpaused(tx, target);
        const origin = originOf(item.origin);
        await tx.insert(workItems).values({
          tenantId: target.tenantId,
          kind: runnerQueueKind(target),
          key: keyOf(target, item.key),
          payload: {
            tenantId: target.tenantId,
            deviceId: target.deviceId,
            action: item.action,
            payload: item.payload ?? null,
            fingerprint,
            ...(origin ? { origin } : {}),
          },
        });
        return "queued";
      });
    },
    async receipt(target, key) {
      await withDevice(target, async () => undefined);
      const row = await read(target, key);
      return row ? receiptOf(row) : null;
    },
    async pending(target) {
      const [row] = await runAsTenant(target.tenantId, () =>
        database
          .select({ value: count() })
          .from(workItems)
          .where(
            and(
              eq(workItems.tenantId, target.tenantId),
              eq(workItems.kind, runnerQueueKind(target)),
              isNull(workItems.finishedAt),
            ),
          ),
      );
      return row?.value ?? 0;
    },
    async uncertain(target) {
      const [row] = await withDevice(target, (tx) =>
        tx.select({ value: count() }).from(workItems).where(unresolved(target)),
      );
      return row?.value ?? 0;
    },
    async reviews(target) {
      const rows = await withDevice(target, (tx) =>
        tx
          .select()
          .from(workItems)
          .where(and(deviceMatch(target), eq(workItems.lastError, UNKNOWN)))
          .orderBy(
            sql`(${workItems.payload}->'review' is null) desc`,
            sql`${workItems.updatedAt} desc`,
          )
          .limit(100),
      );
      return rows.map((row) => {
        const body = row.payload as Record<string, unknown>;
        return {
          key: row.key.slice(`${runnerQueueKind(target)}:`.length),
          action: String(body.action ?? ""),
          payload: body.payload,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          review: (body.review as DeviceActionReview["review"]) ?? null,
        };
      });
    },
    async review(target, key, input) {
      if (
        !input.note.trim() ||
        input.note.length > 2000 ||
        !["checked_executed", "checked_not_executed"].includes(input.resolution)
      )
        return false;
      return withDevice(target, async (tx) => {
        const [row] = await tx
          .update(workItems)
          .set({
            payload: sql`${workItems.payload} || jsonb_build_object('review', jsonb_build_object('at', now(), 'by', ${target.tenantId}::text, 'resolution', ${input.resolution}::text, 'note', ${input.note.trim()}::text))`,
            updatedAt: sql`now()`,
          })
          .where(and(match(target, key), unresolved(target)))
          .returning({ key: workItems.key });
        return !!row;
      });
    },
    async executeOnce<T>(
      target: DispatchTarget,
      item: QueuedAction,
      execute: () => Promise<T>,
      timeoutMs = 60_000,
    ) {
      await self.enqueue(target, item);
      const owner = randomUUID();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const receipt = await self.receipt(target, item.key);
        if (
          receipt &&
          receipt.state !== "running" &&
          receipt.state !== "waiting"
        )
          return replay<T>(receipt);
        const claimed = await withDevice(target, async (tx) => {
          await assertUnpaused(tx, target);
          const [active] = await tx
            .select({ key: workItems.key })
            .from(workItems)
            .where(
              and(
                deviceMatch(target),
                isNull(workItems.finishedAt),
                sql`${workItems.attempts} > 0`,
              ),
            )
            .limit(1);
          if (active) return false;
          const [row] = await tx
            .update(workItems)
            .set({
              claimedBy: owner,
              leaseUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`,
              attempts: 1,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                match(target, item.key),
                isNull(workItems.finishedAt),
                eq(workItems.attempts, 0),
              ),
            )
            .returning({ key: workItems.key });
          return !!row;
        });
        if (claimed) {
          try {
            const output = await execute();
            await conclude(target, item.key, owner, output);
            return output;
          } catch (error) {
            await conclude(target, item.key, owner, null, UNKNOWN).catch(
              () => undefined,
            );
            throw error;
          }
        }
        if (Date.now() >= deadline)
          throw new DeviceDeliveryError(
            "This action is already in flight; its result is not confirmed. It will not be replayed.",
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async drain(target, owner, execute) {
      let done = 0;
      for (; done < 25; ) {
        const item = await withDevice(target, async (tx) => {
          const [blocked] = await tx
            .select({ key: workItems.key })
            .from(workItems)
            .where(
              sql`${unresolved(target)} or (${deviceMatch(target)} and ${workItems.finishedAt} is null and ${workItems.attempts} > 0)`,
            )
            .limit(1);
          if (blocked) return null;
          const [next] = await tx
            .select()
            .from(workItems)
            .where(
              and(
                deviceMatch(target),
                isNull(workItems.finishedAt),
                eq(workItems.attempts, 0),
                sql`${workItems.runAt} <= now()`,
              ),
            )
            .orderBy(workItems.createdAt, workItems.key)
            .limit(1);
          if (!next) return null;
          const [claimed] = await tx
            .update(workItems)
            .set({
              claimedBy: owner,
              attempts: 1,
              leaseUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`,
              updatedAt: sql`now()`,
            })
            .where(
              match(
                target,
                next.key.slice(`${runnerQueueKind(target)}:`.length),
              ),
            )
            .returning();
          return claimed;
        });
        if (!item) return done;
        const key = item.key.slice(`${runnerQueueKind(target)}:`.length);
        if (item.attempts !== 1) {
          await conclude(target, key, owner, null, UNKNOWN);
          return done;
        }
        const body = item.payload as { action?: string; payload?: unknown };
        try {
          const output = await execute({
            key,
            action: String(body.action ?? ""),
            payload: body.payload,
          });
          await conclude(target, key, owner, output);
        } catch {
          await conclude(target, key, owner, null, UNKNOWN).catch(
            () => undefined,
          );
          return done;
        }
        done += 1;
      }
      return done;
    },
    async claimNotices(target, owner) {
      const rows = await withDevice(target, async (tx) => {
        const due = sql`${workItems.key} in (select ${workItems.key} from ${workItems} where ${and(
          deviceMatch(target),
          isNotNull(workItems.finishedAt),
          sql`${workItems.payload}->'origin' is not null`,
          sql`(${workItems.payload}->'notice' is null or (${workItems.payload}->'notice'->>'state' = 'leased' and (${workItems.payload}->'notice'->>'until')::timestamptz <= now()))`,
        )} order by ${workItems.finishedAt}, ${workItems.key} limit ${NOTICE_BATCH})`;
        return tx
          .update(workItems)
          .set({
            payload: sql`${workItems.payload} || jsonb_build_object('notice', jsonb_build_object('state', 'leased', 'by', ${owner}::text, 'until', now() + make_interval(secs => ${NOTICE_LEASE_MS / 1000})))`,
            updatedAt: sql`now()`,
          })
          .where(and(deviceMatch(target), due))
          .returning();
      });
      return rows.flatMap((row) => {
        const body = row.payload as Record<string, unknown>;
        const origin = originOf(body.origin);
        if (!origin) return [];
        return [
          {
            key: row.key.slice(`${runnerQueueKind(target)}:`.length),
            action: String(body.action ?? ""),
            payload: body.payload,
            origin,
            receipt: receiptOf(row),
          },
        ];
      });
    },
    async settleNotice(target, key, owner, outcome) {
      const [row] = await withDevice(target, (tx) =>
        tx
          .update(workItems)
          .set({
            payload: outcome
              ? sql`${workItems.payload} || jsonb_build_object('notice', jsonb_build_object('state', ${outcome}::text, 'at', now()))`
              : sql`${workItems.payload} - 'notice'`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              match(target, key),
              sql`${workItems.payload}->'notice'->>'state' = 'leased'`,
              sql`${workItems.payload}->'notice'->>'by' = ${owner}::text`,
            ),
          )
          .returning({ key: workItems.key }),
      );
      return !!row;
    },
  };
  return self;
}
