import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AuditQueryError,
  type AuditReader,
  auditQueryFromUrl,
  recordAuditEvent,
} from "../audit";
import type { AdminScope } from "../auth/admin-scope";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { parsePageLimit } from "../paging";
import { STALE_ADMIN_REFUSAL } from "../plugins/admin-session-gate";
import { billingPeriod } from "../quota/limits";
import { capabilityFor } from "../tenant/context";
import { tokenUsageFor } from "../quota/token-usage";
import {
  listTenantPage,
  listTenants,
  restoreTenant,
  suspendTenant,
  TENANT_PAGE_MAX,
} from "./store";

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
  /**
   * Spec J5: the cross-tenant reads (token usage, one tenant's trail). Without the admin scope or the
   * reader they answer 503 rather than reading in the admin's own frame, where row-level security
   * would quietly show only the admin's own rows and the screen would look like a quiet deployment.
   */
  readers?: { adminScope?: AdminScope; auditReader?: AuditReader },
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

  const adminScope = readers?.adminScope;
  const auditReader = readers?.auditReader;
  // Re-reads the person's roles and grants the capability for this request (G01-E I10).
  const adminCapability: MiddlewareHandler<Ctx> =
    adminScope?.adminCapability ?? ((_context, next) => next());
  // A role removed since sign-in fails here as a 403, not as a refused platform read.
  const capabilityMissing = (context: Context<Ctx>) =>
    capabilityFor(context.var.actor.id) === "admin"
      ? undefined
      : context.json({ error: "Operator access required." }, 403);
  /*
   * The two levers write as `platform` (`revoked_access`, `sessions`, `routines`), where row-level
   * security has nothing to say, so the session's role alone would let a person whose role was
   * withdrawn since sign-in lock every administrator out, or lift their own suspension. Asked after
   * `requireAdmin`, so a member keeps that answer; without the admin scope nobody holds the
   * capability and both levers stay shut.
   */
  const staleOperator = (context: Context<Ctx>) =>
    capabilityFor(context.var.actor.id) === "admin"
      ? undefined
      : context.json({ error: STALE_ADMIN_REFUSAL }, 403);

  routes.post(
    "/tenants/:id/suspend",
    requireUser,
    requireAdmin,
    adminCapability,
    async (context) => {
      const stale = staleOperator(context);
      if (stale) return stale;
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
    adminCapability,
    async (context) => {
      const stale = staleOperator(context);
      if (stale) return stale;
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

  /*
   * Model tokens per tenant for one billing period (spec J5), from `model_token_calls`, the source of
   * the plan panel (K2). `period` is `YYYY-MM`, default this month; `limit`/`offset` page it.
   */
  routes.get(
    "/usage",
    requireUser,
    requireAdmin,
    adminCapability,
    async (context) => {
      if (!adminScope)
        return context.json({ error: "平台用量暂不可用。" }, 503);
      const withoutCapability = capabilityMissing(context);
      if (withoutCapability) return withoutCapability;
      const period = context.req.query("period")?.trim() || billingPeriod();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
        return context.json({ error: "period 必须是 YYYY-MM 格式。" }, 400);
      const limit = parsePageLimit(
        context.req.query("limit") ?? null,
        TENANT_PAGE_MAX,
      );
      if (!limit.ok) return context.json({ error: limit.error }, 400);
      const rawOffset = context.req.query("offset")?.trim() || "0";
      if (!/^\d{1,9}$/.test(rawOffset))
        return context.json({ error: "offset 必须是非负整数。" }, 400);
      const paging = { limit: limit.limit ?? 50, offset: Number(rawOffset) };
      // Who the tenants are, as `platform`: only an admin holding the capability gets past this door.
      const page = await adminScope.asAdminPlatform(context.var.actor, () =>
        listTenantPage(database, paging),
      );
      /*
       * Each tenant's tokens in that tenant's own frame. `model_token_calls` is owner-only under
       * row-level security (no `platform` read), so the admin acts as each owner in turn, through the
       * audited door, and reads exactly what that owner's plan panel reads (K2's `tokenUsageFor`).
       */
      const tenants = [];
      for (const tenant of page.tenants) {
        const usage = await adminScope.adminActAsOwner(
          context.var.actor,
          tenant.id,
          () => tokenUsageFor(database, tenant.id, period),
        );
        tenants.push({
          tenantId: tenant.id,
          email: tenant.email,
          name: tenant.name,
          usage,
        });
      }
      return context.json({
        period,
        tenants,
        nextOffset: page.hasMore ? paging.offset + paging.limit : null,
      });
    },
  );

  /*
   * One tenant's audit trail (spec J5): the admin audit list narrowed to rows stamped with that
   * tenant, with the same filters and cursor paging as `/api/admin/audit-events`.
   */
  routes.get(
    "/tenants/:id/audit",
    requireUser,
    requireAdmin,
    adminCapability,
    async (context) => {
      if (!adminScope || !auditReader)
        return context.json({ error: "审计日志尚未配置。" }, 503);
      const withoutCapability = capabilityMissing(context);
      if (withoutCapability) return withoutCapability;
      try {
        const query = {
          ...auditQueryFromUrl(new URL(context.req.url)),
          tenantId: context.req.param("id"),
        };
        return context.json(
          await adminScope.asAdminPlatform(context.var.actor, () =>
            auditReader.list(query),
          ),
        );
      } catch (error) {
        if (error instanceof AuditQueryError)
          return context.json({ error: error.message }, 400);
        throw error;
      }
    },
  );

  return routes;
}
