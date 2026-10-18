import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents as agentTable,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  pluginGrants,
  skills as skillTable,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { packageChannelId } from "../src/tenant/provisioning";
import type { LoadedTenantPackage } from "../src/tenant-package";
import { synchronizeTenantPackage } from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 029: switching the brand package has to take the old brand's content back out.
 *
 * The predicate under test is a **set difference against what the package now declares**, and it cannot
 * be a filter on `package_id`: the deployment row is keyed by tenant and upserted in place, so the id
 * every package row carries survives a switch. That is how one development database ended up holding
 * eleven coworkers from a brand it no longer loads, each stamped with the brand it is not.
 *
 * Nothing here reads `examples/qoderwake`. The package is built in memory under this suite's own tenant
 * key, which gives it its own deployment row and therefore its own stamped rows: retiring a coworker
 * only ever retires a row this file created. Sharing the real package's ids would put this suite's
 * outcome in the hands of whichever test file happened to synchronize it first.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const person = `pkg-switch-${suite}`;
const tenantKey = `pkg-switch-tenant-${suite}`;

const alphaAgent = (id: string) => ({
  id,
  name: `员工 ${id}`,
  type: "built_in" as const,
  configuration: { systemPrompt: `我是 ${id}。` },
  title: `岗位 ${id}`,
  roleDescription: `只用于品牌包切换测试的 ${id}`,
  avatarSeed: id,
  skills: [],
});

const alphaChannel = (id: string) => ({
  id,
  name: `频道 ${id}`,
  description: `只用于品牌包切换测试的频道 ${id}`,
  permittedAgents: [`worker-${id}`],
  allowedGroups: ["all"],
});

/*
 * Every id this file writes is namespaced by the suite, including the platform-partition channel rows
 * and the coworkers: a leftover from an interrupted run must not be mistaken for a row the current
 * package owns, which is the one way this suite could make itself red for a reason it did not cause.
 */
const general = `general-${suite}`;
const operations = `operations-${suite}`;
const generalAgent = `worker-${general}`;
const operationsAgent = `worker-${operations}`;
/*
 * The third catalogue face ticket 029 had missed. Skills carry no brand until migration 0074, and the
 * sweep that keyed on `origin = 'catalogue'` was vetoed by an existing test: a deployment may hold two
 * brands' rows at once, so "not declared by me" is not the same question as "not mine".
 */
const shippedSkill = `switch-skill-${suite}`;
/** Written by the person rather than shipped, so no switch may remove it. */
const personalSkill = `switch-personal-${suite}`;
/** Another brand's skill, in a different workspace, which this sweep must never touch. */
const rivalKey = `pkg-switch-rival-${suite}`;
const rivalSkill = `switch-rival-${suite}`;

/** The first brand: two coworkers, two channels, and one skill shipped with it. */
const alpha = (): LoadedTenantPackage => ({
  tenantId: tenantKey,
  productName: "切换测试甲",
  stylesheet: null,
  agents: [alphaAgent(generalAgent), alphaAgent(operationsAgent)],
  omittedAgentIds: [],
  channels: [alphaChannel(general), alphaChannel(operations)],
  model: {
    provider: "openai",
    credentialSecretRef: "SWITCH_TEST_KEY",
    defaultModel: "test-model",
  },
  knowledgeSources: [],
  skills: [
    {
      slug: shippedSkill,
      title: "切换测试用的技能",
      summary: "只用来证明换包会把不再附带的技能收回去。",
      instructions: "把需求写成一条可验收的任务。",
      tools: [],
    },
  ],
  themeCss: "",
  sourcePath: `tests/fixtures/switch-alpha-${suite}`,
  checksum: `alpha-${suite}`,
});

/** The brand it switches to: the operations coworker, its channel and the skill are gone. */
const beta = (): LoadedTenantPackage => ({
  ...alpha(),
  productName: "切换测试乙",
  agents: [alphaAgent(generalAgent)],
  channels: [alphaChannel(general)],
  skills: [],
  checksum: `beta-${suite}`,
});

/** A different workspace, with a skill of its own that this suite's sweeps must never reach. */
const rival = (): LoadedTenantPackage => ({
  ...alpha(),
  tenantId: rivalKey,
  productName: "切换测试丁（别人的工作区）",
  agents: [],
  channels: [],
  skills: [
    {
      slug: rivalSkill,
      title: "另一个品牌带来的技能",
      summary: "不属于本次同步的那个包，所以回收不许碰它。",
      instructions: "别的品牌的说明。",
      tools: [],
    },
  ],
  sourcePath: `tests/fixtures/switch-rival-${suite}`,
  checksum: `rival-${suite}`,
});

const derivedId = (channelId: string) => packageChannelId(person, channelId);
const declaredIds = (package_: LoadedTenantPackage) =>
  package_.channels.map((channel) => derivedId(channel.id));

const applyPackage = (tenantPackage: LoadedTenantPackage) =>
  runAsTenant("platform", async () =>
    synchronizeTenantPackage(database, tenantPackage, [person]),
  );

const liveChannels = async () =>
  await runAsTenant(person, async () =>
    database
      .select({ id: channels.id })
      .from(channels)
      .where(inArray(channels.id, declaredIds(alpha()))),
  );

/**
 * Which of this suite's three skills are still in the catalogue.
 *
 * Asked in the platform scope because the question spans workspaces: the rival's row belongs to another
 * tenant key and the person's to another partition, and a sweep that reaches either is the bug.
 */
const slugsPresent = async () => {
  const rows = await runAsTenant("platform", async () =>
    database
      .select({ slug: skillTable.slug })
      .from(skillTable)
      .where(
        inArray(skillTable.slug, [shippedSkill, personalSkill, rivalSkill]),
      ),
  );
  return rows.map((row) => row.slug);
};

const liveProfile = async (agentId: string) =>
  await runAsTenant("platform", async () =>
    database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.agentId, agentId),
          isNull(agentProfiles.ownerUserId),
          isNull(agentProfiles.deletedAt),
        ),
      ),
  );

await database.insert(users).values({
  id: person,
  email: `${person}@example.test`,
  name: "Package switch fixture",
});
await applyPackage(alpha());

/*
 * Two rows that must survive every switch this suite performs: a skill the person wrote themselves
 * (`origin` defaults to `yours`, and the row has an owner), and a skill that belongs to a different
 * workspace's package. Both are the failure modes the first attempt at this sweep had, found by running
 * it against a test that was already asserting the second one.
 */
await runAsTenant(person, async () => {
  await database.insert(skillTable).values({
    id: personalSkill,
    ownerUserId: person,
    slug: personalSkill,
    title: "我自己写的技能",
    summary: "换包不许动它。",
    instructions: "写给自己的那条说明。",
    installedBy: person,
  });
});
await runAsTenant("platform", async () =>
  synchronizeTenantPackage(database, rival()),
);

afterAll(async () => {
  // Everything this file created carries either this suite's person or this suite's tenant key, so
  // taking it away cannot reach another suite's rows -- which is the reason the package is synthetic.
  await runAsTenant(person, async () => {
    await database
      .delete(channelMemberships)
      .where(eq(channelMemberships.userId, person));
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.userId, person));
    await database
      .delete(channels)
      .where(inArray(channels.id, declaredIds(alpha())));
  });
  await runAsTenant("platform", async () => {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, [generalAgent, operationsAgent]));
    await database
      .delete(agentTable)
      .where(inArray(agentTable.id, [generalAgent, operationsAgent]));
    await database
      .delete(deploymentPackages)
      .where(inArray(deploymentPackages.tenantId, [tenantKey, rivalKey]));
    await database
      .delete(pluginGrants)
      .where(
        inArray(pluginGrants.ref, [shippedSkill, personalSkill, rivalSkill]),
      );
    await database
      .delete(skillTable)
      .where(
        inArray(skillTable.slug, [shippedSkill, personalSkill, rivalSkill]),
      );
  });
  await database.delete(users).where(eq(users.id, person));
  await database.$client.close();
});

test("the first brand gives the person a copy of every channel it declares", async () => {
  const rows = await liveChannels();
  expect(rows.map((row) => row.id).sort()).toEqual(
    [...declaredIds(alpha())].sort(),
  );
  expect(await liveProfile(operationsAgent)).toHaveLength(1);
});

test("switching to a brand that declares less takes the undeclared channels back out", async () => {
  await applyPackage(beta());

  const remaining = (await liveChannels()).map((row) => row.id).sort();
  expect(remaining).toEqual([...declaredIds(beta())].sort());

  /*
   * A channel nobody is in is a door to nowhere, so its membership and its thread go with it: both are
   * `ON DELETE CASCADE`, and a row that outlives its channel would list itself and then refuse to open.
   */
  const memberships = await runAsTenant(person, async () =>
    database
      .select({ channelId: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, person)),
  );
  expect(memberships.map((row) => row.channelId).sort()).toEqual(remaining);

  const mappings = await runAsTenant(person, async () =>
    database
      .select({ channelId: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.userId, person)),
  );
  expect(mappings.map((row) => row.channelId).sort()).toEqual(remaining);
});

/**
 * Coworkers are retired, not erased. `agent_profiles.deleted_at` is what the roster, the seat count and
 * the read path already honour, while the runtime row underneath holds memories, routines and
 * responsibilities a *person* built -- all of them `ON DELETE CASCADE`, so deleting the row would take
 * somebody's work down with a brand's rename.
 */
test("the coworker the new brand stopped declaring leaves the roster", async () => {
  expect(await liveProfile(operationsAgent)).toHaveLength(0);
  expect(await liveProfile(generalAgent)).toHaveLength(1);

  // Retired, not gone: the row is still there for the conversation that names it.
  const stillPresent = await runAsTenant("platform", async () =>
    database
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(eq(agentTable.id, operationsAgent)),
  );
  expect(stillPresent).toHaveLength(1);
});

test("switching back brings the same content to the same ids, once each", async () => {
  await applyPackage(alpha());

  const rows = await liveChannels();
  expect(rows.map((row) => row.id).sort()).toEqual(
    [...declaredIds(alpha())].sort(),
  );
  expect(await liveProfile(operationsAgent)).toHaveLength(1);

  const memberships = await runAsTenant(person, async () =>
    database
      .select({ channelId: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, person)),
  );
  expect(memberships.length).toBe(alpha().channels.length);
});

/*
 * The catalogue face ticket 029 had missed, asserted last: the tests above form one chain of switches
 * whose assertions depend on which brand the previous one left applied, so anything added to the middle
 * of the file fails for a reason it did not cause. These two bring their own starting state.
 */
test("a skill the new brand stopped shipping is taken back", async () => {
  await applyPackage(alpha());
  expect(await slugsPresent()).toContain(shippedSkill);

  await applyPackage(beta());
  expect(await slugsPresent()).not.toContain(shippedSkill);

  // Switching back re-seeds it under the same slug, once, rather than inventing a second copy.
  await applyPackage(alpha());
  const restored = await runAsTenant("platform", async () =>
    database
      .select({ id: skillTable.id })
      .from(skillTable)
      .where(eq(skillTable.slug, shippedSkill)),
  );
  expect(restored).toHaveLength(1);
});

/**
 * The two boundaries that make the sweep safe, asserted together because a sweep that gets either one
 * wrong deletes content belonging to somebody else.
 *
 * A skill a person wrote is theirs, and another workspace's skill belongs to another package. The second
 * is not a hypothetical: `a redeploy takes back only grants from the package being synchronized` was
 * already in the suite, and it is the test that vetoed the first version of this code, which keyed on
 * `origin = 'catalogue'` because skills had nothing else to key on.
 */
test("a person's own skill and another package's skill both survive this package's switch", async () => {
  await applyPackage(alpha());
  expect(await slugsPresent()).toContain(shippedSkill);

  await applyPackage(beta());

  const survivors = await slugsPresent();
  expect(survivors).not.toContain(shippedSkill);
  expect(survivors).toContain(personalSkill);
  expect(survivors).toContain(rivalSkill);
});
