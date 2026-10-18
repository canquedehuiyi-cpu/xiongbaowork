import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { registeredDevices, revokedAccess, users } from "../src/db/schema";
import { createDeviceStore } from "../src/devices/store";
import { isAccessRevoked } from "../src/tenant/access";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec J5's second half: a ban freezes the workspace's task queue and its runner connections.
 *
 * The ban itself has existed for a while — the platform console writes `revoked_access`, and the auth
 * layer and the People screens read it — which is exactly the shape of this gap: everything that
 * arrives with a session was stopped, while a clock and a dialled-out device kept working because
 * neither of them ever asks the session layer anything. A workspace an administrator banned went on
 * claiming queued actions and firing routines, and the only symptom was that its page would not open.
 *
 * Two things are asserted here rather than one, because both were easy to get wrong. The lookup joins
 * on the address rather than the id — `revoked_access` is keyed by email so an administrator can ban
 * somebody who registered and never signed in — and the device refusal answers `null`, the same answer
 * a wrong token gets, so a machine that outlived its owner's ban learns nothing about why.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `w-${suite}`;
const email = `Banned.${suite}@Example.com`;
const token = `obot_dev_${randomUUID()}`;
const devices = createDeviceStore(database);

async function seed() {
  await runAsTenant(tenant, async () => {
    // Idempotent, because both cases need the same account and bun runs them in order: a second insert
    // would otherwise fail on the primary key and every failure after the first would be this one.
    await database
      .insert(users)
      .values({
        id: tenant,
        email,
        name: `Banned owner ${suite}`,
        emailVerified: true,
      })
      .onConflictDoNothing();
    await database
      .insert(registeredDevices)
      .values({
        tenantId: tenant,
        deviceId: `dev-${suite}`,
        name: "Studio desktop",
        // The store stores a hash and compares in constant time, so the test hashes the same way.
        tokenHash: createHash("sha256").update(token).digest("hex"),
      })
      .onConflictDoNothing();
  });
}

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, email.toLowerCase()));
  });
  await runAsTenant(tenant, async () => {
    await database
      .delete(registeredDevices)
      .where(eq(registeredDevices.tenantId, tenant));
    await database.delete(users).where(eq(users.id, tenant));
  });
});

test("an open account is not banned, and a mixed-case ban still finds it", async () => {
  await seed();
  expect(await isAccessRevoked(database, tenant)).toBe(false);

  // The console stores the normalized address while the row keeps whatever the person typed. A join on
  // the raw column would miss every ban written against a mixed-case address — which is most of them.
  await runAsTenant("platform", async () => {
    await database
      .insert(revokedAccess)
      .values({ email: email.toLowerCase(), revokedBy: `admin-${suite}` });
  });
  expect(await isAccessRevoked(database, tenant)).toBe(true);
});

test("a banned workspace's device token stops being accepted, so its queue cannot be claimed", async () => {
  await seed();
  await runAsTenant("platform", async () => {
    await database
      .insert(revokedAccess)
      .values({ email: email.toLowerCase(), revokedBy: `admin-${suite}` })
      .onConflictDoNothing();
  });

  const refused = await devices.deviceForToken(token);
  expect(refused).toBeNull();

  // Lift the ban, and the same token works again: the freeze is the ban, not a destroyed device.
  await runAsTenant("platform", async () => {
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, email.toLowerCase()));
  });
  const restored = await devices.deviceForToken(token);
  expect(restored?.deviceId).toBe(`dev-${suite}`);
});

test("an empty id is not a ban", async () => {
  // The callers pass whatever a token or a context resolved to. An empty string means nobody, and
  // reading it as "banned" would freeze the whole deployment rather than one workspace.
  expect(await isAccessRevoked(database, "")).toBe(false);
});
