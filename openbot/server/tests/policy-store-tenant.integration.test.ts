import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { actionPolicy } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * G01-D: the computer boundary is the deployment's row, so it is stamped `platform` whoever saves
 * it, and read back as `platform` by the boot load and the listener's re-read, which have no frame.
 *
 * Before, the administrator's save ran in the administrator's request frame and stamped the row
 * with THEIR tenant; the boot load, unframed, read as `system` and row-level security hid it. The
 * rule was saved and the screen said so, and a restart quietly went back to the configured default.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const rule = 'intent == "activate" && contains(element.name, "submit")';
const admin = `policy-admin-${crypto.randomUUID()}`;
const savedGuard = process.env.OPENBOT_TENANT_FRAME_GUARD;

const stored = () =>
  runAsTenant("platform", () =>
    database.select().from(actionPolicy).where(eq(actionPolicy.id, "current")),
  );

afterEach(async () => {
  if (savedGuard === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
  else process.env.OPENBOT_TENANT_FRAME_GUARD = savedGuard;
  await runAsTenant("platform", () =>
    database.delete(actionPolicy).where(eq(actionPolicy.id, "current")),
  );
});

describe("the computer boundary is the deployment's row", () => {
  test("an administrator's save is stamped platform, not the administrator's tenant", async () => {
    const store = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await runAsTenant(admin, () =>
      store.set({ mode: "enforce", deny: [rule], allow: ["true"] }, "a@x.test"),
    );

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe("platform");
  });

  test("a restart reads it back with no frame at all, and never falls back to system", async () => {
    const store = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await runAsTenant(admin, () =>
      store.set({ mode: "enforce", deny: [rule], allow: ["true"] }),
    );

    // Boot and the NOTIFY listener run outside any frame: under `throw` an unframed read would fail.
    process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
    const restarted = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    expect(await restarted.load()).toBe("the database");
    expect(restarted.get().deny).toEqual([rule]);

    const replica = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await replica.refresh();
    expect(replica.get().deny).toEqual([rule]);
  });

  test("a row an older build stamped with an administrator's tenant is still found and replaced", async () => {
    // What a deployment that saved a rule before this change holds.
    await runAsTenant(admin, () =>
      database.insert(actionPolicy).values({
        id: "current",
        mode: "enforce",
        deny: ["legacy"],
        allow: ["true"],
      }),
    );
    process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
    const store = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    expect(await store.load()).toBe("the database");
    expect(store.get().deny).toEqual(["legacy"]);

    await runAsTenant(`someone-else-${crypto.randomUUID()}`, () =>
      store.reset(),
    );
    expect(await stored()).toHaveLength(0);
  });
});
