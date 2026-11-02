import { and, desc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { commitWithAudit, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { plans, subscriptions } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import type { QuotaService } from "./limits";

type Ctx = { Variables: AppVariables };

/**
 * The tenant's own plan, its ceilings and what has been used (ticket 022, spec K2/K3).
 *
 * Two reads and one write. The write is the manual switch — this product takes no payment — so it is
 * an administrator's act, not a self-service one: anyone signed in can read their plan, only a
 * platform administrator can move it.
 */
export function createQuotaRoutes(
  database: Database,
  quota: QuotaService,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/", requireUser, async (context) => {
    const tenantId = context.var.actor.id;
    const [plan, usage] = await Promise.all([
      quota.planFor(tenantId),
      quota.usageFor(tenantId),
    ]);
    // Always a plan: a workspace with no subscription is held to Free, so the panel says Free too —
    // the ceilings it draws are the ones the write paths enforce.
    return context.json({
      plan: { id: plan.id, name: plan.name },
      limits: plan.limits,
      usage,
    });
  });

  /** Both tiers, in the order a comparison page should show them. Platform-owned rows. */
  routes.get("/plans", requireUser, async (context) => {
    const rows = await runAsTenant("platform", () =>
      database.select().from(plans),
    );
    return context.json({
      plans: rows.sort((left, right) =>
        left.id === right.id ? 0 : left.id === "free" ? -1 : 1,
      ),
    });
  });

  /**
   * Switch tier by hand.
   *
   * There is no payment provider behind this, so the only honest framing is a row that moves: the
   * ceilings read here are the ones the write paths enforce, which is what makes "switch to Pro and
   * build the third coworker" a real test rather than a screen change.
   *
   * Administrators only. With no payment behind the row, a switch any signed-in person could make
   * would hand every tenant Pro for free; the role is checked before the body is read.
   */
  routes.post("/plan", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req
      .json<{ planId?: unknown }>()
      .catch(() => null)) as { planId?: unknown } | null;
    const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      return context.json({ error: "Choose a plan." }, 400);
    }
    const tenantId = context.var.actor.id;
    const [known] = await runAsTenant("platform", () =>
      database
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.id, planId))
        .limit(1),
    );
    if (!known) return context.json({ error: "No such plan." }, 404);

    /*
     * Move the row if the tenant has one, add one if they do not — and write the trail row that says
     * so in the same transaction.
     *
     * Update-then-insert rather than an upsert because `subscriptions` has no unique constraint on
     * `tenant_id` — provisioning's `onConflictDoNothing` only guards its own primary key — so there is
     * nothing for an upsert to conflict on. The constraint itself is a separate change (it also fixes
     * the admin list, where a second row duplicates the tenant); until then this is the shape that
     * cannot make a second row from a repeated switch.
     *
     * Audited, and fail closed. A tier granted with no payment behind it is exactly the act somebody
     * later asks "who did this"; so the `plan.changed` row commits with the move or neither does, and
     * a trail that cannot be written answers 500 with the plan where it was. Everything runs in the
     * tenant's own frame, the one the subscription lives in, so the row is that tenant's to read and
     * no other tenant's.
     *
     * A switch to the plan the workspace is already on is a no-op: nothing is written, the row or
     * the trail, and the answer says `changed: false`. A `from == to` row would read as a grant that
     * never happened.
     */
    const actorUserId = context.var.actor.id;
    const changed = await runAsTenant(tenantId, () =>
      commitWithAudit(database, async (audit, transaction) => {
        const current = await transaction
          .select({ planId: subscriptions.planId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.tenantId, tenantId),
              eq(subscriptions.status, "active"),
            ),
          )
          .orderBy(desc(subscriptions.updatedAt))
          .for("update");
        if (
          current.length > 0 &&
          current.every((row) => row.planId === planId)
        ) {
          return false;
        }
        if (current.length > 0) {
          await transaction
            .update(subscriptions)
            .set({ planId, status: "active", updatedAt: new Date() })
            .where(
              and(
                eq(subscriptions.tenantId, tenantId),
                eq(subscriptions.status, "active"),
              ),
            );
        } else {
          await transaction.insert(subscriptions).values({ tenantId, planId });
        }
        await recordAuditEvent(audit, {
          eventType: "plan.changed",
          targetType: "tenant",
          targetId: tenantId,
          actorUserId,
          payload: {
            fromPlanId: current[0]?.planId ?? null,
            toPlanId: planId,
            tenantId,
          },
        });
        return true;
      }),
    );
    return context.json({ planId, changed });
  });

  return routes;
}
