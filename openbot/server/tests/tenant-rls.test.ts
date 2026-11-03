import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents } from "../src/db/schema";
import {
  asPlatform,
  currentTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 003 acceptance (spec test decision #7): two tenants cannot see each other's rows at the
 * SQL layer, and inserts default into the running tenant without the call site naming it.
 *
 * Who else may look (G01-E, decision-tests): a caller with no frame at all is an error, because
 * every access needs a frame (the legacy `system` answer is gone); the `system` frame sees only the
 * platform's own catalogue, so not a person's row; `team` is a stamp and never a frame, so asking as
 * `team` throws before any statement runs; and `platform`, the explicit cross-tenant reader, sees the
 * row exactly as its owner stamped it.
 */
const url = testDatabaseUrl();
const db = createDatabase(url, TEST_POOL);

const marker = `rls-test-${Date.now()}`;

/**
 * The four answers for a row owned by `${marker}-a`, from everybody who is not its owner or a
 * stranger tenant: no frame, `system`, `team`, and `platform`.
 */
async function expectOnlyPlatformReaches(id: string) {
  const unframed = () =>
    db.select({ id: agents.id }).from(agents).where(eq(agents.id, id));
  // Building the statement already reads the frame, so it is asked inside the promise.
  await expect(
    Promise.resolve().then(async () => await unframed()),
  ).rejects.toThrow(TenantContextError);

  const seenBySystem = await runAsTenant("system", () =>
    db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)),
  );
  expect(seenBySystem).toEqual([]);

  expect(() =>
    runAsTenant("team", () =>
      db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)),
    ),
  ).toThrow(TenantContextError);

  const seenByPlatform = await asPlatform(() =>
    db
      .select({ id: agents.id, tenant: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, id)),
  );
  expect(seenByPlatform).toEqual([{ id, tenant: `${marker}-a` }]);
}
const agentId = `${marker}-agent-a`;

test("tenant isolation holds at the row level", async () => {
  await runAsTenant(`${marker}-a`, async () => {
    expect(currentTenant()).toBe(`${marker}-a`);
    await db.insert(agents).values({
      id: agentId,
      name: "A 的员工",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
  });

  const seenByB = await runAsTenant(`${marker}-b`, () =>
    db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)),
  );
  expect(seenByB).toEqual([]);

  const seenByA = await runAsTenant(`${marker}-a`, () =>
    db.select({ id: agents.id, tenant: agents.tenantId }).from(agents),
  );
  expect(seenByA.map((row) => row.id)).toContain(agentId);
  // Everything this test wrote belongs to this tenant; platform `system` rows
  // (a seeded tenant package, for one) are legitimately visible on top.
  expect(
    seenByA
      .filter((row) => row.id.startsWith(marker))
      .every((row) => row.tenant === `${marker}-a`),
  ).toBeTrue();

  await expectOnlyPlatformReaches(agentId);

  await runAsTenant(`${marker}-a`, () =>
    db.delete(agents).where(eq(agents.id, agentId)),
  );
});

/**
 * The same isolation across a transaction, which is where it was broken.
 *
 * A transaction runs on a connection of its own, so the tenant has to be put on THAT session before
 * its first statement — and read from the caller's scope rather than from inside Bun's callback, by
 * which time the scope is gone. Miss either and every transactional write lands in the `system`
 * partition, which every tenant can read: coworkers created through the profile store, approvals,
 * a channel's first message. The direct insert above cannot catch it, because it is not a transaction.
 */
test("a transaction writes and reads as the tenant that opened it", async () => {
  const txAgentId = `${marker}-agent-tx`;

  const written = await runAsTenant(`${marker}-a`, async () =>
    db.transaction(async (transaction) => {
      const [row] = await transaction
        .insert(agents)
        .values({
          id: txAgentId,
          name: "事务里写入的员工",
          type: "built_in",
          configuration: { systemPrompt: "test" },
        })
        .returning({ id: agents.id, tenant: agents.tenantId });
      // Read back on the same transaction: the statement that would show the leak from inside.
      const inside = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, txAgentId));
      return { tenant: row.tenant, seen: inside.length };
    }),
  );
  expect(written.tenant).toBe(`${marker}-a`);
  expect(written.seen).toBe(1);

  const seenByB = await runAsTenant(`${marker}-b`, () =>
    db.select({ id: agents.id }).from(agents).where(eq(agents.id, txAgentId)),
  );
  expect(seenByB).toEqual([]);

  await expectOnlyPlatformReaches(txAgentId);

  await runAsTenant(`${marker}-a`, () =>
    db.delete(agents).where(eq(agents.id, txAgentId)),
  );
});
