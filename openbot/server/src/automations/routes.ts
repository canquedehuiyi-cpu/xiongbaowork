import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { AutomationStore } from "./store";
import { AutomationNotFoundError, AutomationRefusedError } from "./types";

type Ctx = { Variables: AppVariables };

const NOT_FOUND = new AutomationNotFoundError().message;
const BAD_BODY = "请求内容无法读取，请检查填写的内容。";
const ENABLED_REQUIRED = "请说明要启用还是停用。";

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
 * store keeps only its hash.
 */
export function createAutomationRoutes(
  store: AutomationStore,
  requireUser: MiddlewareHandler<Ctx>,
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
        secret === null ? { trigger } : { trigger, secret },
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
        return context.json({ secret });
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  return routes;
}
