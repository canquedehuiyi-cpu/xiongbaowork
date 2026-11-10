import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { setEdition } from "../src/edition";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { afterAll, afterEach, beforeAll } from "./support/platform-frame";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-edition-${randomUUID()}`;
const fresh = `${prefix}-fresh`,
  chose = `${prefix}-chose`;
const store = createApprovalStore(database);
const policy = policyOf(store);

/** The store's preferences and team settings, which every approval store made here has. */
function policyOf(store: ReturnType<typeof createApprovalStore>) {
  if (!store.policy) throw new Error("the approval store has no policy");
  return store.policy;
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: fresh, email: `${fresh}@example.test` },
    { id: chose, email: `${chose}@example.test` },
  ]);
});
afterEach(() => setEdition("team"));
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [fresh, chose]));
  await database.$client.close();
});

// Only what the safety policy names asks first (approvals/policy.ts); ordinary changes just happen.
// Each person's preferences are read and written in that person's own tenant frame.
const as = <T>(person: string, fn: () => Promise<T>) => runAsTenant(person, fn);

test("the personal edition does not ask before ordinary changes for somebody who has chosen nothing", async () => {
  setEdition("personal");
  expect(await as(fresh, () => policy.preferences(fresh))).toEqual({
    enabled: false,
    autoReview: false,
    hostCommands: "ask",
  });
});

test("nor does the team edition", async () => {
  expect((await as(fresh, () => policy.preferences(fresh))).enabled).toBe(
    false,
  );
});

test("a saved choice beats the personal edition's default", async () => {
  setEdition("personal");
  await as(chose, () => policy.setPreferences(chose, { enabled: true }));
  expect((await as(chose, () => policy.preferences(chose))).enabled).toBe(true);
  expect(await as(chose, () => store.enabled(chose))).toBe(true);
});

// The switch on Settings → Approvals reads this; it must say what the policy above decides.
test("the personal edition's switch shows asking first as off for somebody who chose nothing", async () => {
  setEdition("personal");
  expect(await as(fresh, () => store.enabled(fresh))).toBe(false);
  setEdition("team");
  expect(await as(fresh, () => store.enabled(fresh))).toBe(false);
});

/** A database that fails the test if the personal edition reads a stored value at all. */
const untouchable = new Proxy({} as typeof database, {
  get: (_target, property) => {
    throw new Error(
      `the personal edition read the database (${String(property)})`,
    );
  },
});

// A team deployment's settings and rules have no screen in the personal edition, so they are not read.
test("the personal edition ignores team approval settings and team rules", async () => {
  setEdition("personal");
  const personal = policyOf(createApprovalStore(untouchable));
  expect(await personal.teamSettings()).toEqual({
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "allow",
<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
    enforceDangerousCommands: false,
=======
    actionKinds: {},
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
  });
  expect(await personal.teamRules()).toEqual([]);
});
