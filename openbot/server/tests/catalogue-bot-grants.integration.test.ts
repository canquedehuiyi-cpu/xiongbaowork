import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  pluginGrants,
  skills,
  subscriptions,
  users,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { grantedSkills } from "../src/plugins/tools";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A catalogue Bot's grants, read in a signed-in person's frame.
 *
 * Found reading the package sync against `listForAgent`: the brand package gives its catalogue Bot
 * 通用助手 (`general-assistant`, stamped `system`, nobody's) the skills `bot-creator` and
 * `skill-creator`, and writes those grants in its own `system` scope. `listForAgent` read only grants
 * stamped with the caller's frame, so in a person's frame 通用助手 held nothing, and the app — which
 * offers 造员工/造技能 only to a Bot holding those two, read from `/api/plugins/for/<bot>`, which is
 * that call — never offered them to anybody signed in. The runtime's skill index read the same.
 *
 * What must hold beside the fix: a person reads the platform's grants on a catalogue Bot and never
 * changes them, and still never sees another person's grants, on that Bot or on their own Bots.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const alice = `cat-grants-a-${suite}`;
const bob = `cat-grants-b-${suite}`;
const people = [alice, bob];
const CATALOGUE_BOT = "general-assistant";
const GATES = ["bot-creator", "skill-creator"];
const bobsSkill = `cat-grants-bob-${suite}`;

const loaded = await loadTenantPackage("../examples/xiongbao");

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

for (const person of people) {
  await runAsTenant(person, () =>
    database
      .insert(users)
      .values({ id: person, email: `${person}@example.test`, name: person }),
  );
  await provisionTenant(database, {
    id: person,
    email: `${person}@example.test`,
  });
}
// As the boot path does it: the catalogue is written in the sync's own `system` scope.
await runAsTenant("platform", () =>
  synchronizeTenantPackage(database, loaded, people),
);

afterAll(async () => {
  for (const person of people) {
    await runAsTenant(person, async () => {
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.tenantId, person));
      await database.delete(skills).where(eq(skills.tenantId, person));
      await database
        .delete(channelMemberships)
        .where(eq(channelMemberships.userId, person));
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.userId, person));
      await database.delete(channels).where(eq(channels.tenantId, person));
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.tenantId, person));
      await database.delete(agents).where(eq(agents.tenantId, person));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, person));
      await database.delete(users).where(eq(users.id, person));
    });
  }
  await database.$client.close();
});

const slugsOf = async (person: string, agentId: string) =>
  (await runAsTenant(person, () => store.listForAgent(agentId))).skills
    .map((skill) => skill.slug)
    .sort();

/** The package's own rows on the catalogue Bot, read where every row is visible. */
const packageGrants = () =>
  runAsTenant("platform", () =>
    database
      .select({
        ref: pluginGrants.ref,
        tenantId: pluginGrants.tenantId,
        grantedBy: pluginGrants.grantedBy,
      })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          eq(pluginGrants.agentId, CATALOGUE_BOT),
          eq(pluginGrants.grantedBy, "tenant-package"),
        ),
      )
      .orderBy(pluginGrants.ref),
  );

describe("a signed-in person reading the catalogue Bot's grants", () => {
  test("the package's grants are stamped `system`, as the sync writes them", async () => {
    expect(await packageGrants()).toEqual(
      GATES.map((ref) => ({
        ref,
        tenantId: "system",
        grantedBy: "tenant-package",
      })),
    );
  });

  test("holds bot-creator and skill-creator in a person's frame, as the app reads it", async () => {
    // `/api/plugins/for/general-assistant` answers with exactly this call, in the person's frame.
    expect(await slugsOf(alice, CATALOGUE_BOT)).toEqual(GATES);
    expect(await slugsOf(bob, CATALOGUE_BOT)).toEqual(GATES);
  });

  test("the runtime's skill index for a person's run agrees", async () => {
    const offered = await runAsTenant(alice, () =>
      grantedSkills({ store, botId: CATALOGUE_BOT }),
    );
    expect(offered.map((skill) => skill.slug).sort()).toEqual(GATES);
  });

  test("background work in the platform frame reads the same grants, and only those", async () => {
    expect(await slugsOf("platform", CATALOGUE_BOT)).toEqual(GATES);
  });
});

describe("what stays private", () => {
  test("a person's own grant on the catalogue Bot is theirs alone", async () => {
    await runAsTenant(bob, async () => {
      await store.installSkill({
        slug: bobsSkill,
        title: "Bob's",
        summary: "For a test.",
        instructions: "Bob's own instructions.",
        ownerUserId: bob,
        by: `${bob}@example.test`,
      });
      await store.grant("skill", bobsSkill, CATALOGUE_BOT, bob);
    });

    expect(await slugsOf(bob, CATALOGUE_BOT)).toEqual(
      [...GATES, bobsSkill].sort(),
    );
    // Not in anybody else's frame, and not folded into the platform's reading of the Bot.
    expect(await slugsOf(alice, CATALOGUE_BOT)).toEqual(GATES);
    expect(await slugsOf("platform", CATALOGUE_BOT)).toEqual(GATES);
  });

  test("another person's own Bot still shows nothing of its grants", async () => {
    // Bob's 分身 holds the package's pairing in Bob's tenant; Alice's frame cannot read any of it.
    expect(await slugsOf(bob, avatarAgentId(bob))).toEqual(GATES);
    expect(
      await runAsTenant(alice, () => store.listForAgent(avatarAgentId(bob))),
    ).toEqual({ tools: [], skills: [] });
  });

  test("a person's own skill of the same name does not stand in for the deployment's", async () => {
    const [shipped] = await runAsTenant("platform", () =>
      database
        .select({ instructions: skills.instructions })
        .from(skills)
        .where(
          and(eq(skills.tenantId, "system"), eq(skills.slug, "bot-creator")),
        ),
    );
    expect(shipped).toBeDefined();
    await runAsTenant(alice, () =>
      store.installSkill({
        slug: "bot-creator",
        title: "Alice's shadow",
        summary: "For a test.",
        instructions: "Alice's own bot-creator.",
        ownerUserId: alice,
        by: `${alice}@example.test`,
      }),
    );

    const held = await runAsTenant(alice, () =>
      store.listForAgent(CATALOGUE_BOT),
    );
    expect(
      held.skills.find((skill) => skill.slug === "bot-creator")?.instructions,
    ).toBe(shipped?.instructions as string);
    expect(held.skills.map((skill) => skill.slug).sort()).toEqual(GATES);
  });
});

describe("a person cannot change the catalogue Bot's grants", () => {
  test("revoking one is refused in words, and the grant stays", async () => {
    await expect(
      runAsTenant(alice, () =>
        store.revoke("skill", "bot-creator", CATALOGUE_BOT, alice),
      ),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect((await packageGrants()).map((row) => row.ref)).toEqual(GATES);
    expect(await slugsOf(alice, CATALOGUE_BOT)).toEqual(GATES);
  });

  test("re-granting one is refused rather than taking the platform's row over", async () => {
    await expect(
      runAsTenant(alice, () =>
        store.grant("skill", "skill-creator", CATALOGUE_BOT, alice),
      ),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(await packageGrants()).toEqual(
      GATES.map((ref) => ({
        ref,
        tenantId: "system",
        grantedBy: "tenant-package",
      })),
    );
  });

  test("row security declines a direct write in a person's frame", async () => {
    const onCatalogueBot = and(
      eq(pluginGrants.agentId, CATALOGUE_BOT),
      eq(pluginGrants.tenantId, "system"),
    );
    const updated = await runAsTenant(alice, () =>
      database
        .update(pluginGrants)
        .set({ grantedBy: alice })
        .where(onCatalogueBot)
        .returning({ ref: pluginGrants.ref }),
    );
    expect(updated).toEqual([]);
    const deleted = await runAsTenant(alice, () =>
      database
        .delete(pluginGrants)
        .where(onCatalogueBot)
        .returning({ ref: pluginGrants.ref }),
    );
    expect(deleted).toEqual([]);
    expect((await packageGrants()).map((row) => row.ref)).toEqual(GATES);
  });
});
