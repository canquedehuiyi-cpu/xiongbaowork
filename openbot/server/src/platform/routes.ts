import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { listTenants, restoreTenant, suspendTenant } from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The operator screen behind `admin`: who the deployment serves, what each
 * tenant holds, and the two levers. Everything here reads through the
 * `platform` session scope the store sets; a person's own routes never can.
 */
export function createPlatformRoutes(
  database: Database,
  requireUser: MiddlewareHandler<Ctx>,
  audit?: Parameters<typeof recordAuditEvent>[0],
) {
  const routes = new Hono<Ctx>();
  const requireAdmin: MiddlewareHandler<Ctx> = async (context, next) => {
    if (context.var.actor?.role !== "admin") {
      return context.json({ error: "Operator access required." }, 403);
    }
    await next();
  };

  routes.get("/tenants", requireUser, requireAdmin, async (context) => {
    return context.json({ tenants: await listTenants(database) });
  });

  routes.post(
    "/tenants/:id/suspend",
    requireUser,
    requireAdmin,
    async (context) => {
      const id = context.req.param("id");
      const done = await suspendTenant(database, id, context.var.actor);
      if (!done) return context.json({ error: "No such tenant." }, 404);
      if (audit) {
        await recordAuditEvent(audit, {
          eventType: "platform.tenant_suspended",
          targetType: "person",
          targetId: id,
          actorUserId: context.var.actor.id,
          payload: {},
        });
      }
      return context.json({ ok: true });
    },
  );

  routes.post(
    "/tenants/:id/restore",
    requireUser,
    requireAdmin,
    async (context) => {
      const id = context.req.param("id");
      const done = await restoreTenant(database, id);
      if (!done) return context.json({ error: "No such tenant." }, 404);
      if (audit) {
        await recordAuditEvent(audit, {
          eventType: "platform.tenant_restored",
          targetType: "person",
          targetId: id,
          actorUserId: context.var.actor.id,
          payload: {},
        });
      }
      return context.json({ ok: true });
    },
  );

  return routes;
}
