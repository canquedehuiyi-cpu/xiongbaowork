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

const loaded = await loadTenantPackage("../examples/xiongbao");

test("the package declares the product, five seed coworkers and the navigation entries", () => {
  expect(loaded.agents.map((entry) => entry.id)).toEqual(ids);
  // The spec's engineer card is the one named in the objective, so it has to be in the seed.
  expect(
    loaded.agents.find((entry) => entry.id === "backend-engineer")?.title,
  ).toBe("Backend Engineer");
  expect(loaded.channels.length).toBeGreaterThanOrEqual(3);
});

test("the default conversation is the person's own 分身, and the shared Bot does not claim to be it", () => {
  /*
   * `我的分身` is still the first thing in the nav -- the onboarding asks somebody to configure it, so a
   * package without it starts every new tenant with a hole in the middle of their nav -- but it is now
   * the conversation with the person's OWN 分身 (`avatar: true`), not with a catalogue Bot of that name.
   * A catalogue Bot has no owner, so it can never use anybody's paired machine; the 分身 can.
   */
  const [first] = loaded.channels;
  expect(first?.name).toBe("我的分身");
  expect(first?.avatar).toBe(true);
  expect(first?.permittedAgents).toEqual([]);

  // The shared one is 通用助手, and nothing a person reads on it says it is somebody's 分身. Before
  // this, two Bots were both called 我的分身 and the catalogue one's page said it belonged to someone
  // else.
  const shared = loaded.agents.find(
    (entry) => entry.id === "general-assistant",
  );
  expect(shared?.name).toBe("通用助手");
  expect(
    [shared?.name, shared?.title, shared?.roleDescription].join(" "),
  ).not.toContain("个人分身");
  expect(
    loaded.channels.find((entry) => entry.id === "general-assistant")?.name,
  ).toBe("通用助手");
  for (const agent of loaded.agents) expect(agent.name).not.toBe("我的分身");

  /*
   * Building a coworker or a skill in a conversation is gated on holding these two skills. The 分身
   * holds them so the default conversation keeps the feature, and 通用助手 keeps them too.
   */
  expect(loaded.avatarSkills).toEqual(["bot-creator", "skill-creator"]);
  expect(shared?.skills).toEqual(["bot-creator", "skill-creator"]);
});

test("the shipped copy says nothing in English that a person would read as unfinished", async () => {
  // brand.yaml's words, as the loaded package carries them: the product's names.
  const brand = {
    productName: loaded.productName,
    englishName: loaded.englishName,
  };
  const text = [brand, loaded.agents, loaded.skills, loaded.channels]
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
  const again = await loadTenantPackage("../examples/xiongbao");
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
