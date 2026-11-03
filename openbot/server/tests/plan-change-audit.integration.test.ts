import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { commitWithAudit, recordAuditEvent } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { auditEvents, subscriptions, users } from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { createQuotaRoutes } from "../src/quota/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Every manual plan switch leaves a `plan.changed` row, in the tenant's own frame, written with the
 * move or not at all.
 *
 * The real routes against the real database as the application role, because the claims are about
 * row-level security (another tenant cannot read the row) and about the transaction (a trail that
 * cannot be written leaves the plan where it was) — neither of which a fake store would show.
 *
 * Audit rows are append-only and refuse a delete, so each run takes tenant ids of its own and the
 * rows it leaves are only ever read back by those ids.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `pca-${suite}`;
const neighbour = `pca-n-${suite}`;
const bare = `pca-b-${suite}`;
const quota = createQuotaService(database);

const as = (
  id: string,
  role: "admin" | "user",
): MiddlewareHandler<{ Variables: AppVariables }> =>
  async function actor(context, next) {
    context.set("actor", { id, role });
    await next();
  };

async function switchPlan(id: string, role: "admin" | "user", planId: string) {
  const response = await createQuotaRoutes(
    database,
    quota,
    as(id, role),
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

/** The `plan.changed` rows about `subject`, as `reader`'s frame sees them. */
async function planEvents(reader: string, subject: string) {
  return await runAsTenant(reader, async () => {
    await Promise.resolve();
    return await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "plan.changed"),
          eq(auditEvents.targetId, subject),
        ),
      );
  });
}

async function planOf(id: string) {
  return await runAsTenant(id, async () => {
    await Promise.resolve();
    return await database
      .select({ planId: subscriptions.planId })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, id));
  });
}

for (const id of [tenant, neighbour, bare]) {
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@pca.test`, name: id })
      .onConflictDoNothing(),
  );
}
for (const id of [tenant, neighbour]) {
  await runAsTenant(id, () =>
    database.insert(subscriptions).values({ tenantId: id, planId: "free" }),
  );
}

test("a switch writes one plan.changed row with from, to and the administrator, in the tenant's frame", async () => {
  const moved = await switchPlan(tenant, "admin", "pro");
  expect(moved.status).toBe(200);
  expect(moved.body).toEqual({ planId: "pro", changed: true });
  expect((await planOf(tenant)).map((row) => row.planId)).toEqual(["pro"]);

  const rows = await planEvents(tenant, tenant);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row?.tenantId).toBe(tenant);
  expect(row?.actorUserId).toBe(tenant);
  expect(row?.initiatorKind).toBe("person");
  expect(row?.targetType).toBe("tenant");
  expect(row?.payload).toEqual({
    fromPlanId: "free",
    toPlanId: "pro",
    tenantId: tenant,
  });
});

test("another tenant cannot read the row; the platform can", async () => {
  expect(await planEvents(neighbour, tenant)).toHaveLength(0);
  expect(await planEvents("system", tenant)).toHaveLength(0);
  expect(await planEvents("platform", tenant)).toHaveLength(1);
});

test("a switch to the plan already held writes nothing", async () => {
  const again = await switchPlan(tenant, "admin", "pro");
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ planId: "pro", changed: false });
  expect(await planEvents(tenant, tenant)).toHaveLength(1);
});

test("a refused switch writes no row: a member, and an unknown plan", async () => {
  const member = await switchPlan(neighbour, "user", "pro");
  expect(member.status).toBe(403);
  const unknown = await switchPlan(neighbour, "admin", "diamond");
  expect(unknown.status).toBe(404);
  const empty = await switchPlan(neighbour, "admin", "  ");
  expect(empty.status).toBe(400);

  expect((await planOf(neighbour)).map((row) => row.planId)).toEqual(["free"]);
  expect(await planEvents(neighbour, neighbour)).toHaveLength(0);
  expect(await planEvents("platform", neighbour)).toHaveLength(0);
});

test("a workspace with no subscription is recorded as coming from no plan", async () => {
  const first = await switchPlan(bare, "admin", "pro");
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ planId: "pro", changed: true });
  const rows = await planEvents(bare, bare);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toEqual({
    fromPlanId: null,
    toPlanId: "pro",
    tenantId: bare,
  });
});

test("a trail row that cannot be written takes the change back with it", async () => {
  // PostgreSQL's jsonb refuses a NUL escape, so this row fails at INSERT, after the move ran.
  const attempt = runAsTenant(neighbour, () =>
    commitWithAudit(database, async (audit, transaction) => {
      await transaction
        .update(subscriptions)
        .set({ planId: "pro" })
        .where(eq(subscriptions.tenantId, neighbour));
      await recordAuditEvent(audit, {
        eventType: "plan.changed",
        targetType: "tenant",
        targetId: neighbour,
        actorUserId: neighbour,
        payload: { fromPlanId: "free", toPlanId: "pro", note: "\u0000" },
      });
      return true;
    }),
  );
  await expect(attempt).rejects.toThrow();
  expect((await planOf(neighbour)).map((row) => row.planId)).toEqual(["free"]);
  expect(await planEvents("platform", neighbour)).toHaveLength(0);
});

test("through the route, a trail that cannot be written answers 500 and leaves the plan where it was", async () => {
  /*
   * The same database, except that any insert into the trail throws, on the pool or inside a
   * transaction. What is under test is the route's own wiring: an audit write made outside the
   * switch's transaction would leave the plan moved here.
   */
  const refuseTrail = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key);
        if (key === "insert") {
          return (table: unknown) => {
            if (table === auditEvents) throw new Error("trail unavailable");
            return (value as (table: unknown) => unknown).call(object, table);
          };
        }
        if (key === "transaction") {
          return (work: (transaction: object) => Promise<unknown>) =>
            (
              value as (
                body: (transaction: object) => Promise<unknown>,
              ) => Promise<unknown>
            ).call(object, (transaction) => work(refuseTrail(transaction)));
        }
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  const response = await createQuotaRoutes(
    refuseTrail(database),
    quota,
    as(neighbour, "admin"),
  ).request(
    new Request("http://openbot.test/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: "pro" }),
    }),
  );
  expect(response.status).toBe(500);
  expect((await planOf(neighbour)).map((row) => row.planId)).toEqual(["free"]);
  expect(await planEvents("platform", neighbour)).toHaveLength(0);
});

afterAll(async () => {
  // `users` has no tenant column and no row security: an unfiltered delete would empty the table
  // for every suite sharing the database. Each cleanup names its own rows.
  for (const id of [tenant, neighbour, bare]) {
    await runAsTenant(id, async () => {
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, id));
      await database.delete(users).where(eq(users.id, id));
    });
  }
  await database.$client.end({ timeout: 5 });
});
