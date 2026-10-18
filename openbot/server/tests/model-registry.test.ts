import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { modelRegistry } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 011 acceptance: the library is per tenant -- one tenant's connected
 * models are invisible to another, the same tenant cannot connect the same
 * model twice, and the platform's provider catalogue reads to everybody.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `ma-${suite}`;
const tenantB = `mb-${suite}`;

test("each tenant sees only its own connected models", async () => {
  await runAsTenant(tenantA, () =>
    database.insert(modelRegistry).values([
      { provider: "openai", modelName: "gpt-6", credentialId: null },
      { provider: "zhipu", modelName: "glm-5.3", credentialId: null },
    ]),
  );
  await runAsTenant(tenantB, () =>
    database
      .insert(modelRegistry)
      .values({ provider: "deepseek", modelName: "v4", credentialId: null }),
  );
  const seenByA = await runAsTenant(tenantA, () =>
    database.select({ modelName: modelRegistry.modelName }).from(modelRegistry),
  );
  const seenByB = await runAsTenant(tenantB, () =>
    database.select({ modelName: modelRegistry.modelName }).from(modelRegistry),
  );
  expect(seenByA.map((row) => row.modelName).sort()).toEqual([
    "glm-5.3",
    "gpt-6",
  ]);
  expect(seenByB.map((row) => row.modelName)).toEqual(["v4"]);
});

test("the same tenant cannot connect one model twice", async () => {
  let refused = false;
  try {
    await runAsTenant(tenantA, () =>
      database
        .insert(modelRegistry)
        .values({ provider: "openai", modelName: "gpt-6", credentialId: null }),
    );
  } catch {
    refused = true;
  }
  expect(refused).toBeTrue();
});

afterAll(async () => {
  await runAsTenant("platform", () =>
    database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, [tenantA, tenantB])),
  );
});
