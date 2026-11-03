import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, subscriptions, users } from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { createQuotaRoutes } from "../src/quota/routes";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * One subscription row per tenant (audit defect #7, remainder; migration 0129).
 *
 * Until 0129 nothing in the database said a tenant has one subscription: provisioning checked first
 * and then inserted, so two first calls racing both wrote a Free row, and a plan switch on a
 * workspace whose only row was canceled inserted a second row beside it. The quota reader papered
 * over the duplicates by ordering, but the administrator's tenant list (a join on `tenant_id`) listed
 * the tenant twice. Now the database refuses a second row, provisioning is an insert that does
 * nothing on that conflict, and a switch is an upsert on it.
 *
 * Real database, application role, every write in the tenant's own frame: the claims are about a
 * constraint and about row-level security admitting the upsert, which no fake would show.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const quota = createQuotaService(database);
const tenants: string[] = [];

function newTenant(label: string): string {
  const id = `subu-${label}-${suite}`;
  tenants.push(id);
  return id;
}

async function person(id: string): Promise<void> {
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@subu.test`, name: id })
      .onConflictDoNothing(),
  );
}

async function rowsOf(id: string) {
  return runAsTenant(id, () =>
    database
      .select({ planId: subscriptions.planId, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, id)),
  );
}

const asAdmin = (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async function actor(context, next) {
    context.set("actor", { id, role: "admin" });
    await next();
  };

async function switchPlan(id: string, planId: string) {
  const response = await createQuotaRoutes(
    database,
    quota,
    asAdmin(id),
  ).request(
    new Request("http://openbot.test/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as {
      planId?: string;
      changed?: boolean;
    } | null,
  };
}

/** The unique violation under drizzle's wrapper, wherever the driver put it. */
function pgError(error: unknown): { code?: string; constraint?: string } {
  let current = error as {
    code?: string;
    errno?: string;
    constraint?: string;
    constraint_name?: string;
    cause?: unknown;
  } | null;
  while (current) {
    // Bun's driver puts the SQLSTATE in `errno` (its `code` is its own); others use `code`.
    const code = current.errno ?? current.code;
    if (code === "23505") {
      return {
        code,
        constraint: current.constraint ?? current.constraint_name,
      };
    }
    current = current.cause as typeof current;
  }
  return {};
}

afterAll(async () => {
  for (const id of tenants) {
    await runAsTenant(id, async () => {
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, id));
      await database.delete(agents).where(eq(agents.tenantId, id));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, id));
    });
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, id)),
    );
  }
  await database.$client.close();
});

test("the database refuses a second subscription row for one tenant", async () => {
  const id = newTenant("second");
  await person(id);
  await runAsTenant(id, () =>
    database.insert(subscriptions).values({ tenantId: id, planId: "free" }),
  );
  const refusal = async () => {
    try {
      await runAsTenant(id, () =>
        database.insert(subscriptions).values({ tenantId: id, planId: "pro" }),
      );
    } catch (error) {
      return pgError(error);
    }
    return { inserted: true };
  };
  const unique = { code: "23505", constraint: "subscriptions_tenant_unique" };
  expect(await refusal()).toEqual(unique);
  // A canceled row holds the tenant's place too: there is one row per tenant, whatever its status.
  await runAsTenant(id, () =>
    database
      .update(subscriptions)
      .set({ status: "canceled" })
      .where(eq(subscriptions.tenantId, id)),
  );
  expect(await refusal()).toEqual(unique);
  expect(await rowsOf(id)).toEqual([{ planId: "free", status: "canceled" }]);
});

test("provisioning twice, and twice at once, leaves one Free row", async () => {
  const id = newTenant("provision");
  await person(id);
  const user = { id, email: `${id}@subu.test`, name: id };
  // Two first calls racing: before 0129 both could pass the "no row yet" read and both insert.
  await Promise.all([
    provisionTenant(database, user),
    provisionTenant(database, user),
    provisionTenant(database, user),
  ]);
  await provisionTenant(database, user);
  expect(await rowsOf(id)).toEqual([{ planId: "free", status: "active" }]);
});

test("provisioning again leaves the plan somebody chose alone", async () => {
  const id = newTenant("chosen");
  await person(id);
  const user = { id, email: `${id}@subu.test`, name: id };
  await provisionTenant(database, user);
  expect((await switchPlan(id, "pro")).status).toBe(200);
  await provisionTenant(database, user);
  expect(await rowsOf(id)).toEqual([{ planId: "pro", status: "active" }]);
  expect((await quota.planFor(id)).id).toBe("pro");
});

test("a switch on a workspace whose only row is canceled reactivates that row, not a second one", async () => {
  const id = newTenant("canceled");
  await person(id);
  await runAsTenant(id, () =>
    database
      .insert(subscriptions)
      .values({ tenantId: id, planId: "free", status: "canceled" }),
  );
  const moved = await switchPlan(id, "pro");
  expect(moved).toEqual({
    status: 200,
    body: { planId: "pro", changed: true },
  });
  expect(await rowsOf(id)).toEqual([{ planId: "pro", status: "active" }]);
  expect((await quota.planFor(id)).id).toBe("pro");
});

test("two first switches at once leave one row on the plan they named", async () => {
  const id = newTenant("race");
  await person(id);
  const answers = await Promise.all([
    switchPlan(id, "pro"),
    switchPlan(id, "pro"),
  ]);
  expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
  expect(await rowsOf(id)).toEqual([{ planId: "pro", status: "active" }]);
});
