import { and, desc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { plans, subscriptions } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import type { QuotaService } from "./limits";
import {
  createManualPaymentProvider,
  type PaymentProvider,
  type PlanChangeHook,
  runPlanChangeHooks,
} from "./payment-provider";
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
  options: {
    payment?: PaymentProvider;
    hooks?: readonly PlanChangeHook[];
  } = {},
) {
  // The reserved payment seam (spec K3): manual unless the deployment wired another, and no hooks.
  const payment = options.payment ?? createManualPaymentProvider();
  const hooks = options.hooks ?? [];
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

  /**
   * Both tiers, in the order a comparison page should show them. Platform-owned rows.
   *
   * `checkout` says how a change of tier happens here — which provider, and whether it is a hand-off
   * to a payment page or, as today, an instruction — without opening a checkout: a read starts nothing.
   */
  routes.get("/plans", requireUser, async (context) => {
    const rows = await runAsTenant("platform", () =>
      database.select().from(plans),
    );
    return context.json({
      plans: rows.sort((left, right) =>
        left.id === right.id ? 0 : left.id === "free" ? -1 : 1,
      ),
      checkout: {
        provider: payment.id,
        kind: payment.kind,
        ...(payment.kind === "manual" && payment.instructions
          ? { instructions: payment.instructions }
          : {}),
      },
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
     * Move the row if the tenant has one, add one if they do not — and read what it was, in the same
     * transaction, under a row lock, so the "from" a hook hears is the plan this switch replaced and
     * not one a concurrent switch wrote in between.
     *
     * Update-then-insert rather than an upsert because `subscriptions` has no unique constraint on
     * `tenant_id` — provisioning's `onConflictDoNothing` only guards its own primary key — so there is
     * nothing for an upsert to conflict on. The constraint itself is a separate change (it also fixes
     * the admin list, where a second row duplicates the tenant); until then this is the shape that
     * cannot make a second row from a repeated switch.
     *
     * The tenant a hook is told about is the one on the row that moved, never a field of the body.
     */
    const change = await runAsTenant(tenantId, () =>
      database.transaction(async (transaction) => {
        // Most recently changed first, the same row `planFor` reads as the tenant's plan.
        const previous = await transaction
          .select({ planId: subscriptions.planId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.tenantId, tenantId),
              eq(subscriptions.status, "active"),
            ),
          )
          .orderBy(
            desc(subscriptions.updatedAt),
            desc(subscriptions.createdAt),
            desc(subscriptions.id),
          )
          .for("update");
        const [moved] = await transaction
          .update(subscriptions)
          .set({ planId, status: "active", updatedAt: new Date() })
          .where(
            and(
              eq(subscriptions.tenantId, tenantId),
              eq(subscriptions.status, "active"),
            ),
          )
          .returning({ tenantId: subscriptions.tenantId });
        if (moved) {
          return {
            tenantId: moved.tenantId,
            fromPlanId: previous[0]?.planId ?? null,
          };
        }
        const [inserted] = await transaction
          .insert(subscriptions)
          .values({ tenantId, planId })
          .returning({ tenantId: subscriptions.tenantId });
        if (!inserted) throw new Error("The subscription row was not written.");
        return { tenantId: inserted.tenantId, fromPlanId: null };
      }),
    );

    // After the commit: a hook hears about a switch that has happened and cannot undo it.
    await runPlanChangeHooks(hooks, {
      tenantId: change.tenantId,
      fromPlanId: change.fromPlanId,
      toPlanId: planId,
      actorId: context.var.actor.id,
      provider: payment.id,
      at: new Date(),
    });
    return context.json({ planId });
  });

  return routes;
}
