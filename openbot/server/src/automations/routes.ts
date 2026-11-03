import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  AUTOMATION_HOOK_BODY_LIMIT,
  type AutomationIngressDeps,
  acceptAutomationEvent,
  HOOK_KEY_TOO_LONG,
  HOOK_TOO_LARGE,
  hookEventPayload,
  hookRefusal,
  hookSigningSecret,
  MAX_IDEMPOTENCY_KEY,
} from "./ingress-routes";
import type { AutomationStore } from "./store";
import { AutomationNotFoundError, AutomationRefusedError } from "./types";

type Ctx = { Variables: AppVariables };

const NOT_FOUND = new AutomationNotFoundError().message;
const BAD_BODY = "请求内容无法读取，请检查填写的内容。";
const ENABLED_REQUIRED = "请说明要启用还是停用。";
const NO_EVENT_ENTRY =
  "请先添加并启用一个事件入口触发条件，才能通过 API 运行。";
const RUN_UNAVAILABLE = "自动任务暂时无法通过 API 运行。";

/**
 * D06 AUT1/AUT3/AUT4: a person's automations, managed at `/api/automations`.
 *
 * Every route carries `requireUser` itself, which runs the request inside the caller's tenant
 * frame; the store takes the tenant (and, by D12, the owner) from that frame and nowhere else, so
 * nothing in a body or a path can name another tenant.
 *
 * Refusals a person can act on are 422 with the store's Chinese sentence. An id that is unknown,
 * deleted or another tenant's is the SAME 404 with the same body, so a guessed id learns nothing.
 * A webhook trigger's secret is in the response that creates (or rotates) it and in no other: the
 * store keeps only its hash; next to it is `signingSecret`, the Standard Webhooks key derived from it
 * and the deployment's pepper (`hookSigningSecret`), equally shown once.
 *
 * AUT2: `POST /:id/run` is the signed-in API entry. It starts the automation through its switched-on
 * event-entry (webhook) trigger, takes the same `Idempotency-Key`, carries the same untrusted body,
 * and answers like the public hook: 202 accepted, 400 an over-long Idempotency-Key, 404 not this
 * caller's, 409 paused or spent with nothing queued, 413 too large, 422 no event entry to start it
 * through.
 */
export function createAutomationRoutes(
  store: AutomationStore,
  requireUser: MiddlewareHandler<Ctx>,
  ingress?: AutomationIngressDeps,
) {
  const routes = new Hono<Ctx>();

  /** One answer per failure kind; anything else is the server's own error. */
  const refuse = (context: Context<Ctx>, error: unknown) => {
    if (error instanceof AutomationNotFoundError) {
      // The store's sentence, which is the same for a missing id and another tenant's.
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof AutomationRefusedError) {
      return context.json({ error: error.message }, 422);
    }
    throw error;
  };

  const body = async (context: Context<Ctx>): Promise<unknown> => {
    try {
      return await context.req.json();
    } catch {
      throw new AutomationRefusedError(BAD_BODY);
    }
  };

  routes.get("/", requireUser, async (context) => {
    const automations = await store.list();
    return context.json({ automations });
  });

  routes.post("/", requireUser, async (context) => {
    try {
      const automation = await store.create(
        (await body(context)) as Parameters<AutomationStore["create"]>[0],
      );
      return context.json({ automation }, 201);
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.get("/:id", requireUser, async (context) => {
    try {
      const automation = await store.get(context.req.param("id"));
      if (!automation) return context.json({ error: NOT_FOUND }, 404);
      const triggers = await store.listTriggers(automation.id);
      return context.json({ automation, triggers });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.patch("/:id", requireUser, async (context) => {
    try {
      const automation = await store.update(
        context.req.param("id"),
        (await body(context)) as Parameters<AutomationStore["update"]>[1],
      );
      return context.json({ automation });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.put("/:id/enabled", requireUser, async (context) => {
    try {
      const input = (await body(context)) as { enabled?: unknown } | null;
      if (typeof input?.enabled !== "boolean") {
        throw new AutomationRefusedError(ENABLED_REQUIRED);
      }
      const automation = await store.setEnabled(
        context.req.param("id"),
        input.enabled,
      );
      return context.json({ automation });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const deleted = await store.softDelete(context.req.param("id"));
    if (!deleted) return context.json({ error: NOT_FOUND }, 404);
    return context.body(null, 204);
  });

  routes.post("/:id/triggers", requireUser, async (context) => {
    try {
      const { trigger, secret } = await store.addTrigger(
        context.req.param("id"),
        await body(context),
      );
      // The plaintext secret is here once; nothing can read it back afterwards.
      return context.json(
        secret === null
          ? { trigger }
          : {
              trigger,
              secret,
              ...(ingress
                ? {
                    signingSecret: hookSigningSecret(
                      secret,
                      ingress.signingPepper,
                    ),
                  }
                : {}),
            },
        201,
      );
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.put(
    "/:id/triggers/:triggerId/enabled",
    requireUser,
    async (context) => {
      try {
        const input = (await body(context)) as { enabled?: unknown } | null;
        if (typeof input?.enabled !== "boolean") {
          throw new AutomationRefusedError(ENABLED_REQUIRED);
        }
        const trigger = await store.setTriggerEnabled(
          context.req.param("id"),
          context.req.param("triggerId"),
          input.enabled,
        );
        return context.json({ trigger });
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  routes.delete("/:id/triggers/:triggerId", requireUser, async (context) => {
    try {
      const result = await store.removeTrigger(
        context.req.param("id"),
        context.req.param("triggerId"),
      );
      return context.json({ result });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post(
    "/:id/triggers/:triggerId/secret",
    requireUser,
    async (context) => {
      try {
        const secret = await store.rotateTriggerSecret(
          context.req.param("id"),
          context.req.param("triggerId"),
        );
        return context.json({
          secret,
          ...(ingress
            ? {
                signingSecret: hookSigningSecret(secret, ingress.signingPepper),
              }
            : {}),
        });
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  routes.post(
    "/:id/run",
    requireUser,
    bodyLimit({
      maxSize: AUTOMATION_HOOK_BODY_LIMIT,
      onError: (context) => context.json({ error: HOOK_TOO_LARGE }, 413),
    }),
    async (context) => {
      if (!ingress) return context.json({ error: RUN_UNAVAILABLE }, 503);
      try {
        // Read in the caller's frame: another tenant's id is the same 404 as an unknown one.
        const automation = await store.get(context.req.param("id"));
        if (!automation) return context.json({ error: NOT_FOUND }, 404);
        const triggers = await store.listTriggers(automation.id);
        const entry = triggers.find(
          (trigger) => trigger.enabled && trigger.config.kind === "webhook",
        );
        if (!entry) throw new AutomationRefusedError(NO_EVENT_ENTRY);
        const refusal = hookRefusal(automation, new Date());
        if (refusal) {
          return context.json({ error: refusal, accepted: false }, 409);
        }
        const idempotency = context.req.header("idempotency-key")?.trim();
        if (idempotency && idempotency.length > MAX_IDEMPOTENCY_KEY) {
          // The same 400 as the public hook: a malformed header, not a refusal to act on.
          return context.json({ error: HOOK_KEY_TOO_LONG }, 400);
        }
        const raw = await context.req.text();
        const accepted = await acceptAutomationEvent(ingress, {
          // The automation row's owner, which the caller's frame already had to match.
          tenantId: automation.tenantId,
          automationId: automation.id,
          triggerId: entry.id,
          source: "api",
          deliveryId: idempotency || randomUUID(),
          payload: hookEventPayload(raw, context.req.header("content-type")),
          actorUserId: context.var.actor.id,
        });
        return context.json(
          { accepted: true, duplicate: accepted.duplicate },
          202,
        );
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  return routes;
}
