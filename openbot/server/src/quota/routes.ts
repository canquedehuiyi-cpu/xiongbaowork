import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { plans, subscriptions } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import type { QuotaService } from "./limits";
import { tokenUsageFor } from "./token-usage";

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
    const [plan, usage, tokens] = await Promise.all([
      quota.planFor(tenantId),
      quota.usageFor(tenantId),
      tokenUsageFor(database, tenantId),
    ]);
    // Always a plan: a workspace with no subscription is held to Free, so the panel says Free too —
    // the ceilings it draws are the ones the write paths enforce.
    return context.json({
      plan: { id: plan.id, name: plan.name },
      limits: plan.limits,
      usage,
      // Model tokens through bound models this period; sums stay null when no call reported them.
      tokens,
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
     * Move the row if the tenant has one, add one if they do not.
     *
     * Update-then-insert rather than an upsert because `subscriptions` has no unique constraint on
     * `tenant_id` — provisioning's `onConflictDoNothing` only guards its own primary key — so there is
     * nothing for an upsert to conflict on. The constraint itself is a separate change (it also fixes
     * the admin list, where a second row duplicates the tenant); until then this is the shape that
     * cannot make a second row from a repeated switch.
     */
    const moved = await runAsTenant(tenantId, () =>
      database
        .update(subscriptions)
        .set({ planId, status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
            eq(subscriptions.status, "active"),
          ),
        )
        .returning({ id: subscriptions.id }),
    );
    if (moved.length === 0) {
      await runAsTenant(tenantId, () =>
        database.insert(subscriptions).values({ tenantId, planId }),
      );
    }
    return context.json({ planId });
  });

  return routes;
}
