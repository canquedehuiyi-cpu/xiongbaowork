import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  deploymentPackages,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 024 acceptance (spec G1, test decision #3): the 熊宝 package is a package the loader accepts,
 * it says the product's own name, and applying it twice is one application.
 *
 * The second part is the one that matters after an upstream sync. A package is re-read on every boot,
 * so an upsert that is not idempotent would duplicate coworkers in each person's workspace the first
 * time they pull the upstream and restart.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = "qw";
const tenant = `t-${suite}-pkg`;
const ids = [
  "general-assistant",
  "backend-engineer",
  "code-reviewer",
  "qa-engineer",
  "ops-assistant",
];

const loaded = await loadTenantPackage("../examples/qoderwake");

test("the package declares the product, five seed coworkers and the navigation entries", () => {
  expect(loaded.agents.map((entry) => entry.id)).toEqual(ids);
  // The spec's engineer card is the one named in the objective, so it has to be in the seed.
  expect(
    loaded.agents.find((entry) => entry.id === "backend-engineer")?.title,
  ).toBe("Backend Engineer");
  expect(loaded.channels.length).toBeGreaterThanOrEqual(3);
  // `我的分身` is the personal avatar card: the onboarding asks somebody to configure it, so a package
  // without it starts every new tenant with a hole in the middle of their nav.
  expect(loaded.agents[0]?.name).toContain("分身");
});

test("the shipped copy says nothing in English that a person would read as unfinished", async () => {
  const text = [loaded.brand, loaded.agents, loaded.skills, loaded.channels]
    .map((part) => JSON.stringify(part))
    .join("\n");
  // A placeholder left behind from the upstream example reads as a broken install rather than as
  // somebody's English, so it is checked as text rather than eyeballed once.
  for (const leftover of [
    "TODO",
    "FIXME",
    "Lorem",
    "Compliance",
    "Risk &",
    "Everyday Work",
  ]) {
    expect(text.includes(leftover)).toBeFalse();
  }
});

test("the checksum moves only when the package changes", async () => {
  const again = await loadTenantPackage("../examples/qoderwake");
  expect(again.checksum).toBe(loaded.checksum);
});

test("synchronising twice leaves one row per coworker, not two", async () => {
  // The test database is shared with the upstream example package, which ships a channel with the
  // same id. The synchroniser refuses to steal a channel it did not create — correct behaviour, and
  // the reason this test clears the ground it stands on first.
  await runAsTenant("platform", () =>
    database
      .delete(channels)
      .where(inArray(channels.id, loaded.channels.map((entry) => entry.id))),
  );
  await runAsTenant(tenant, async () => {
    await synchronizeTenantPackage(database, loaded);
    await synchronizeTenantPackage(database, loaded);
  });

  const rows = await runAsTenant(tenant, () =>
    database
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.id, ids)),
  );
  expect(rows.length).toBe(ids.length);

  const stamped = await runAsTenant("platform", () =>
    database
      .select({ checksum: deploymentPackages.checksum })
      .from(deploymentPackages)
      .where(eq(deploymentPackages.checksum, loaded.checksum)),
  );
  /*
   * One stamp for this package after two synchronisations. Counted by checksum rather than as "one
   * row in the table", because the table is shared with every other package this test database has
   * ever been pointed at, and a number that includes them proves nothing about this one.
   */
  expect(stamped.length).toBe(1);
});

afterAll(async () => {
  for (const scope of [tenant, "platform"]) {
    await runAsTenant(scope, async () => {
      await database.delete(channels);
      await database.delete(agentProfiles);
      await database.delete(agents);
      await database.delete(deploymentPackages);
    });
  }
  await database.$client.end({ timeout: 5 });
});
