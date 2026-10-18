import { actionFingerprint } from "../../../shared/runner-actions";

export { actionFingerprint } from "../../../shared/runner-actions";

import { randomUUID } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
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

export type QueuedAction = { key: string; action: string; payload: unknown };
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
    if (unknown)
      throw new DeviceDeliveryError(
        "This device is paused because an action may already have run. Its owner must check the device and review the receipt before requesting another action.",
      );
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
        ? "The device refused this action. It will not be replayed."
        : "This action may already have run. Check the device before creating a new action.",
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
  };
  return self;
}
