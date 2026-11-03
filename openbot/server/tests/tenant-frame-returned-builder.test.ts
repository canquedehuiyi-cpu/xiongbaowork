import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents } from "../src/db/schema";
import { runAsTenant, TenantContextError } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A builder returned, unawaited, after an await still runs as the tenant that built it.
 *
 * Bun 1.3.14 -- the version CI and the image run -- calls the `then` of a thenable that an async
 * function returns AFTER it has awaited something outside the caller's AsyncLocalStorage frame:
 *
 *   runAsTenant(t, async () => { await check(); return db.select().from(table) })
 *
 * drizzle builders are exactly such thenables, and the statement only reaches the pool when that
 * `then` runs. A client that read the tenant at that moment ran the statement as `system`, so the
 * tenant's own rows came back as `[]` with no error (responsibility run history, a notebook's
 * bindings), and an insert leaning on the `tenant_id` default would have landed in the partition
 * every tenant reads. `return await`, a return with no earlier await, and a transaction were never
 * affected, which is what made the shape easy to write and hard to see.
 *
 * Every case below runs against `agents`: a FORCE RLS tenant table whose `tenant_id` defaults to the
 * session's `app.tenant_id`, through the non-superuser app role CI connects as. The `await` before
 * each return is a real round trip, not a resolved promise, so the continuation is the same one
 * production code returns from.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `frame-${randomUUID().slice(0, 8)}`;
const tenantA = `${suite}-a`;
const tenantB = `${suite}-b`;
const seeded = `${suite}-seeded`;

/*
 * The two no-frame cases pin the guard themselves, so they assert the same thing whatever guard the
 * runner sets: with the guard off, the legacy behaviour (an unframed read sees nothing, an unframed
 * builder runs as the frame that awaits it); with it on, building a statement with no frame is
 * refused.
 */
const savedGuard = process.env.OPENBOT_TENANT_FRAME_GUARD;
function restoreGuard() {
  if (savedGuard === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
  else process.env.OPENBOT_TENANT_FRAME_GUARD = savedGuard;
}
afterEach(restoreGuard);

/** Runs `work` with the frame guard set to `guard`, restoring the runner's guard afterwards. */
async function withGuard<T>(
  guard: "off" | "throw",
  work: () => T | Promise<T>,
): Promise<T> {
  process.env.OPENBOT_TENANT_FRAME_GUARD = guard;
  try {
    return await work();
  } finally {
    restoreGuard();
  }
}

/** Something worth awaiting first, the way `owned(...)` or an ownership check is in the stores. */
async function precheck() {
  await database.select({ id: agents.id }).from(agents).limit(1);
}

beforeAll(async () => {
  await runAsTenant(tenantA, async () => {
    await database.insert(agents).values({
      id: seeded,
      name: "seeded",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
  });
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB, "system"]) {
    await runAsTenant(tenant, async () => {
      await database.delete(agents).where(like(agents.id, `${suite}-%`));
    });
  }
  await database.$client.close();
});

test("a select builder returned after an await reads the tenant's own row", async () => {
  const rows = await runAsTenant(tenantA, async () => {
    await precheck();
    return database
      .select({ id: agents.id, tenant: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, seeded));
  });
  expect(rows).toEqual([{ id: seeded, tenant: tenantA }]);
});

test("a relational query returned after an await reads the tenant's own row", async () => {
  const row = await runAsTenant(tenantA, async () => {
    await precheck();
    return database.query.agents.findFirst({
      columns: { id: true, tenantId: true },
      where: eq(agents.id, seeded),
    });
  });
  expect(row).toEqual({ id: seeded, tenantId: tenantA });
});

test("a chained select with where and orderBy returned after an await keeps the tenant", async () => {
  const second = `${suite}-seeded-2`;
  await runAsTenant(tenantA, async () => {
    await database.insert(agents).values({
      id: second,
      name: "seeded second",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
  });

  const rows = await runAsTenant(tenantA, async () => {
    await precheck();
    return database
      .select({ id: agents.id })
      .from(agents)
      .where(like(agents.id, `${suite}-seeded%`))
      .orderBy(asc(agents.id))
      .limit(10);
  });
  expect(rows.map((row) => row.id)).toEqual([seeded, second]);
});

test("an update ... returning after an await changes and returns the tenant's row", async () => {
  const rows = await runAsTenant(tenantA, async () => {
    await precheck();
    return database
      .update(agents)
      .set({ name: "renamed after an await" })
      .where(eq(agents.id, seeded))
      .returning({ id: agents.id, name: agents.name });
  });
  expect(rows).toEqual([{ id: seeded, name: "renamed after an await" }]);

  const [after] = await runAsTenant(tenantA, () =>
    database
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, seeded)),
  );
  expect(after?.name).toBe("renamed after an await");
});

test("an insert with no tenant named, returned after an await, lands in the tenant and not in system", async () => {
  const inserted = `${suite}-inserted`;
  const rows = await runAsTenant(tenantA, async () => {
    await precheck();
    return database
      .insert(agents)
      .values({
        id: inserted,
        name: "inserted after an await",
        type: "built_in",
        configuration: { systemPrompt: "test" },
      })
      .returning({ id: agents.id, tenant: agents.tenantId });
  });
  expect(rows).toEqual([{ id: inserted, tenant: tenantA }]);

  // The other side: the platform's own scope and another tenant must not see it.
  const fromSystem = await runAsTenant("system", () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, inserted)),
  );
  expect(fromSystem).toEqual([]);
  const fromB = await runAsTenant(tenantB, () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, inserted)),
  );
  expect(fromB).toEqual([]);
});

test("a builder made in one frame runs as that frame wherever it is awaited", async () => {
  // Handed out inside a plain object, so no frame wrapper ever touches its `then`.
  const { query } = await runAsTenant(tenantA, async () => {
    await precheck();
    return { query: database.select({ id: agents.id }).from(agents) };
  });
  const rows = await runAsTenant(tenantB, async () => {
    await precheck();
    return query.where(eq(agents.id, seeded));
  });
  expect(rows).toEqual([{ id: seeded }]);
});

test("the shapes that always worked still do", async () => {
  // `return await` after an await.
  const awaited = await runAsTenant(tenantA, async () => {
    await precheck();
    return await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, seeded));
  });
  expect(awaited).toEqual([{ id: seeded }]);

  // A builder returned from an async function with no earlier await.
  const direct = await runAsTenant(tenantA, async () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, seeded)),
  );
  expect(direct).toEqual([{ id: seeded }]);

  // A builder returned from a synchronous scope and awaited after the scope closed.
  const lazy = await runAsTenant(tenantA, () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, seeded)),
  );
  expect(lazy).toEqual([{ id: seeded }]);

  // A transaction returned after an await, with a builder returned unawaited inside it.
  const inTransaction = await runAsTenant(tenantA, async () => {
    await precheck();
    return database.transaction(async (transaction) => {
      await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, seeded));
      return transaction
        .select({ id: agents.id, tenant: agents.tenantId })
        .from(agents)
        .where(eq(agents.id, seeded));
    });
  });
  expect(inTransaction).toEqual([{ id: seeded, tenant: tenantA }]);

  // The isolation itself: another tenant, the platform's own `system` frame, and a caller with no
  // frame at all, see nothing.
  const fromB = await runAsTenant(tenantB, async () => {
    await precheck();
    return database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, seeded));
  });
  expect(fromB).toEqual([]);
  const fromSystem = await runAsTenant("system", async () => {
    await precheck();
    return database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, seeded));
  });
  expect(fromSystem).toEqual([]);
  const unscoped = await withGuard("off", () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, seeded)),
  );
  expect(unscoped).toEqual([]);
  // With the guard on, a caller with no frame is refused before it reaches any row.
  await withGuard("throw", () => {
    expect(() =>
      database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, seeded)),
    ).toThrow(TenantContextError);
  });
});

test("a builder made outside every frame still runs as the frame that awaits it", async () => {
  const rows = await withGuard("off", () => {
    const unframed = database.select({ id: agents.id }).from(agents);
    return runAsTenant(tenantA, async () =>
      unframed.where(eq(agents.id, seeded)),
    );
  });
  expect(rows).toEqual([{ id: seeded }]);
  // With the guard on there is no builder made outside every frame: making one is refused.
  await withGuard("throw", () => {
    expect(() => database.select({ id: agents.id }).from(agents)).toThrow(
      TenantContextError,
    );
  });
});
