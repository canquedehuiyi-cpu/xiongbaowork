/**
 * D06 AUT2: the public event entry of an automation, `POST /api/automations/hooks/:triggerId`.
 *
 * WHO MAY CALL. Nobody signs in here: the trigger's secret is the credential. The store keeps only
 * its SHA-256 (`hashTriggerSecret`), so the two schemes this route accepts are the two that can be
 * checked against that hash and nothing else:
 *  - `Authorization: Bearer <secret>`: the SHA-256 of what was sent is compared, in constant time,
 *    with the stored hash.
 *  - Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`): the HMAC key is
 *    derived from that hash AND the deployment's key-encryption key (`signingSecretFromHash`), handed
 *    to the person once as `whsec_<base64>` next to the secret itself (`hookSigningSecret`), and
 *    verified by the same helper responsibility webhooks use. Peppered so that the stored hash alone
 *    (a database read, a backup) cannot sign a delivery; it is no more a credential than it is a
 *    Bearer token.
 * Verification runs over the raw bytes before anything is parsed.
 *
 * WHOSE TENANT. The trigger is looked up by id as `platform`, the one cross-tenant read; the owner it
 * names on its own row is the frame everything after it runs in. Nothing in the request can name a
 * tenant, an automation or a target.
 *
 * ANSWERS. 202 accepted (queued, or the same idempotency key again: `duplicate`). 401 the secret did
 * not check out. 404 — one body for all of them — an unknown id, a switched-off or removed trigger,
 * a deleted automation. 409 the automation is paused, has used up its runs, or is past its end date:
 * nothing is queued, counted or recorded. 413 the body is over 256 KiB.
 *
 * WHAT THE PAYLOAD IS. Data from outside. It rides in the work item to the firing and reaches the
 * Waker inside the untrusted-content envelope (`waker-executor.ts`), never as an instruction.
 */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { automations, automationTriggers } from "../db/schema";
import { verifyStandardWebhook } from "../responsibilities/signatures";
import { fitPayload } from "../responsibilities/triggers";
import { runAsTenant } from "../tenant/context";
import type { WorkQueue } from "../work/queue";
import { exhausted } from "./store";
import { type AutomationEventSource, offerAutomationEvent } from "./sweep";
import { automationTriggerConfigSchema } from "./types";

/** The same ceiling as responsibility webhooks: the raw bytes, before anything is parsed. */
export const AUTOMATION_HOOK_BODY_LIMIT = 256 * 1024;
export const MAX_IDEMPOTENCY_KEY = 200;

export const HOOK_NOT_FOUND = "找不到这个事件入口。";
export const HOOK_UNAUTHORIZED = "事件入口密钥或签名无效。";
export const HOOK_TOO_LARGE = "事件内容超过 256 KiB，未被接收。";
export const HOOK_KEY_TOO_LONG = `幂等键最多 ${MAX_IDEMPOTENCY_KEY} 个字符。`;
export const HOOK_UNAVAILABLE = "事件暂时无法接收，请稍后重试。";
export const AUTOMATION_PAUSED = "这个自动任务已停用，本次事件没有执行。";
export const AUTOMATION_MAX_RUNS =
  "这个自动任务已达到最大运行次数，本次事件没有执行。";
export const AUTOMATION_EXPIRED =
  "这个自动任务已过截止日期，本次事件没有执行。";

/**
 * The Standard Webhooks signing secret for a stored trigger-secret hash (hex SHA-256, all the server
 * keeps): `whsec_` + base64 of HMAC-SHA256 keyed by the deployment's key-encryption key. The pepper is
 * what keeps a leaked hash from being a signing key.
 */
export function signingSecretFromHash(
  secretHash: string,
  pepper: string,
): string {
  const key = createHmac("sha256", pepper)
    .update(`openbot-automation-hook-signing:v1:${secretHash.toLowerCase()}`)
    .digest();
  return `whsec_${key.toString("base64")}`;
}

/**
 * The same signing secret from the plaintext trigger secret. Shown once, beside the secret, by the
 * routes that create or rotate it.
 */
export function hookSigningSecret(secret: string, pepper: string): string {
  return signingSecretFromHash(
    createHash("sha256").update(secret, "utf8").digest("hex"),
    pepper,
  );
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** `Authorization: Bearer <secret>` against the stored hash, in constant time. */
export function bearerMatchesHash(
  secretHash: string,
  header: string | undefined,
): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!match?.[1] || !HEX_SHA256.test(secretHash)) return false;
  const supplied = createHash("sha256").update(match[1], "utf8").digest();
  const stored = Buffer.from(secretHash, "hex");
  return supplied.length === stored.length && timingSafeEqual(supplied, stored);
}

/** Why an automation will not take an event now (AUT4 + paused), or null when it will. */
export function hookRefusal(
  automation: {
    enabled: boolean;
    maxRuns: number | null;
    runCount: number;
    endDate: Date | null;
  },
  now: Date,
): string | null {
  // Spent first: a spent automation is also switched off, and "used up" is the truer sentence.
  const reason = exhausted(automation, now);
  if (reason === "max_runs") return AUTOMATION_MAX_RUNS;
  if (reason === "end_date") return AUTOMATION_EXPIRED;
  if (!automation.enabled) return AUTOMATION_PAUSED;
  return null;
}

/** The body as the Waker will see it: parsed JSON when it is JSON, the text otherwise. */
export function hookEventPayload(
  raw: string,
  contentType: string | undefined,
): Record<string, unknown> {
  let body: unknown = raw;
  if (raw.trim() === "") body = null;
  else {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return fitPayload({
    contentType: (contentType ?? "").slice(0, 120),
    body,
  });
}

/** A webhook trigger as the public route reads it, before it knows who is calling. */
export type AutomationHook = {
  id: string;
  automationId: string;
  /** The owner, from the trigger row: the only tenant anything after the lookup runs in. */
  tenantId: string;
  secretHash: string;
  automation: {
    enabled: boolean;
    maxRuns: number | null;
    runCount: number;
    endDate: Date | null;
  };
};

export type AutomationHookDirectory = {
  /** A switched-on webhook trigger of a live automation, or null for anything else. */
  resolve(triggerId: string): Promise<AutomationHook | null>;
};

const uuid = z.uuid();

/** The one cross-tenant read of this route, as `platform`, said here rather than trusted to a caller. */
export function createAutomationHookDirectory(
  database: Database,
): AutomationHookDirectory {
  return {
    async resolve(triggerId) {
      if (!uuid.safeParse(triggerId).success) return null;
      const rows = await runAsTenant("platform", async () => {
        return await database
          .select({
            id: automationTriggers.id,
            automationId: automationTriggers.automationId,
            tenantId: automationTriggers.tenantId,
            config: automationTriggers.config,
            triggerEnabled: automationTriggers.enabled,
            secretHash: automationTriggers.secretHash,
            enabled: automations.enabled,
            deletedAt: automations.deletedAt,
            maxRuns: automations.maxRuns,
            runCount: automations.runCount,
            endDate: automations.endDate,
          })
          .from(automationTriggers)
          .innerJoin(
            automations,
            and(
              eq(automations.id, automationTriggers.automationId),
              eq(automations.tenantId, automationTriggers.tenantId),
            ),
          )
          .where(eq(automationTriggers.id, triggerId))
          .limit(1);
      });
      const row = rows[0];
      if (!row?.triggerEnabled || row.deletedAt !== null) return null;
      const config = automationTriggerConfigSchema.safeParse(row.config);
      if (!config.success || config.data.kind !== "webhook") return null;
      if (!row.secretHash || !HEX_SHA256.test(row.secretHash)) return null;
      return {
        id: row.id,
        automationId: row.automationId,
        tenantId: row.tenantId,
        secretHash: row.secretHash,
        automation: {
          enabled: row.enabled,
          maxRuns: row.maxRuns,
          runCount: row.runCount,
          endDate: row.endDate,
        },
      };
    },
  };
}

export type AutomationIngressDeps = {
  queue: Pick<WorkQueue, "offer">;
  /** The deployment's key-encryption key: the pepper of every Standard Webhooks signing secret. */
  signingPepper: string;
  auditStore?: AuditStore;
  /** Told after new work is queued, so a dispatch can start now instead of at the next poll. */
  onOffered?: () => void;
  now?: () => Date;
};

/**
 * Queue one event for one automation trigger, in the owner's frame, and audit it once.
 * Shared by the public hook and the signed-in `POST /api/automations/:id/run`.
 */
export async function acceptAutomationEvent(
  deps: AutomationIngressDeps,
  input: {
    tenantId: string;
    automationId: string;
    triggerId: string;
    source: AutomationEventSource;
    deliveryId: string;
    payload: Record<string, unknown>;
    actorUserId: string;
  },
): Promise<{ duplicate: boolean; key: string }> {
  const now = deps.now?.() ?? new Date();
  const offered = await offerAutomationEvent(deps.queue, {
    tenantId: input.tenantId,
    automationId: input.automationId,
    triggerId: input.triggerId,
    source: input.source,
    deliveryId: input.deliveryId,
    payload: input.payload,
    receivedAt: now,
  });
  const duplicate = offered.status !== "queued";
  if (!duplicate) {
    if (deps.auditStore) {
      const auditStore = deps.auditStore;
      await runAsTenant(input.tenantId, async () => {
        await recordAuditEvent(auditStore, {
          eventType: "automation.triggered",
          targetType: "automation",
          targetId: input.automationId,
          actorUserId: input.actorUserId,
          ...(input.source === "hook"
            ? { initiator: { kind: "deployment" as const } }
            : {}),
          payload: {
            source: input.source,
            triggerId: input.triggerId,
            deliveryId: input.deliveryId.slice(0, MAX_IDEMPOTENCY_KEY),
            key: offered.key,
          },
        });
      }).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            type: "automation-trigger-audit-failed",
            triggerId: input.triggerId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
    deps.onOffered?.();
  }
  return { duplicate, key: offered.key };
}

export type AutomationHookRoutesDeps = AutomationIngressDeps & {
  directory: AutomationHookDirectory;
};

export function createAutomationHookRoutes(deps: AutomationHookRoutesDeps) {
  const now = () => deps.now?.() ?? new Date();
  const routes = new Hono();
  routes.use(
    "*",
    bodyLimit({
      maxSize: AUTOMATION_HOOK_BODY_LIMIT,
      onError: (context) => context.json({ error: HOOK_TOO_LARGE }, 413),
    }),
  );
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "automation-hook-error",
        errorType: error.name,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: HOOK_UNAVAILABLE }, 503);
  });

  routes.post("/:triggerId", async (context) => {
    const hook = await deps.directory.resolve(context.req.param("triggerId"));
    // Unknown, switched off, removed, deleted: the same answer, so an id learns nothing more.
    if (!hook) return context.json({ error: HOOK_NOT_FOUND }, 404);

    const raw = await context.req.text();
    const header = (name: string) => context.req.header(name) ?? undefined;
    const signature = header("webhook-signature");
    const authentic = signature
      ? verifyStandardWebhook(
          signingSecretFromHash(hook.secretHash, deps.signingPepper),
          raw,
          {
            id: header("webhook-id"),
            timestamp: header("webhook-timestamp"),
            signature,
          },
          Math.floor(now().getTime() / 1000),
        )
      : bearerMatchesHash(hook.secretHash, header("authorization"));
    if (!authentic) return context.json({ error: HOOK_UNAUTHORIZED }, 401);

    // Paused or spent: refused before anything is written, so resuming later replays nothing.
    const refusal = hookRefusal(hook.automation, now());
    if (refusal) {
      return context.json({ error: refusal, accepted: false }, 409);
    }

    // Signed, the event is the webhook-id the signature covers; an unsigned Idempotency-Key must
    // not win there, or a captured request replays under a fresh key and runs again.
    const idempotency = (
      signature ? header("webhook-id") : header("idempotency-key")
    )?.trim();
    if (idempotency && idempotency.length > MAX_IDEMPOTENCY_KEY) {
      return context.json({ error: HOOK_KEY_TOO_LONG }, 400);
    }

    const accepted = await acceptAutomationEvent(deps, {
      tenantId: hook.tenantId,
      automationId: hook.automationId,
      triggerId: hook.id,
      source: "hook",
      deliveryId: idempotency || randomUUID(),
      payload: hookEventPayload(raw, header("content-type")),
      actorUserId: hook.tenantId,
    });
    return context.json({ accepted: true, duplicate: accepted.duplicate }, 202);
  });
  return routes;
}
