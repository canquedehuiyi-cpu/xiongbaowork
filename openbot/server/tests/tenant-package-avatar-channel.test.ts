import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ownerTenantOfBot } from "../src/agents/bot-owner";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  pluginGrants,
  subscriptions,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import {
  avatarAgentId,
  packageChannelId,
  provisionTenant,
} from "../src/tenant/provisioning";
import {
  type LoadedTenantPackage,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The 熊宝 package's default conversation is each person's OWN 分身 (decided 2026-11-06, option A).
 *
 * Found on a real deployment: the conversation every person got, 「我的分身」, was answered by the
 * catalogue Bot `general-assistant`, which belongs to nobody. Computer tools run on the paired machine
 * of a Bot's OWNER (`devices/selection.ts`), so that conversation could never use the person's
 * machine, and two Bots were both called 我的分身. The person's own `avatar-<person>` could.
 *
 * So: the catalogue Bot is now 通用助手, and the package's default conversation (`avatar: true` in
 * `channels.yaml`) is resolved per person to their own 分身, which is also given the two skills that
 * make building coworkers and skills in a conversation work. These run the real package through the
 * real sync, the real channel read path and the real grant read the app gates those tools on.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const newcomer = `pkg-avatar-new-${suite}`;
const existing = `pkg-avatar-old-${suite}`;
const people = [newcomer, existing];

const loaded = await loadTenantPackage("../examples/qoderwake");

const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const pluginStore = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

/**
 * The package as it shipped before this change: the catalogue Bot called 我的分身, the default
 * conversation answered by it, and no 分身 skills. An existing deployment's rows are what applying
 * this wrote, which is the state the next boot has to repair.
 */
const before: LoadedTenantPackage = {
  ...loaded,
  checksum: `before-${suite}`,
  agents: loaded.agents.map((agent) =>
    agent.id === "general-assistant"
      ? {
          ...agent,
          name: "我的分身",
          title: "个人分身",
          roleDescription:
            "代表我收集、整理和跟进信息，说话自然、简洁，中文优先；不确定就直说，不编造。",
          avatarSeed: "avatar-me",
          configuration: {
            systemPrompt:
              "你是用户的个人分身。用中文，简洁直接；不确定的事说明不确定，不要编造事实。",
          },
        }
      : agent,
  ),
  channels: loaded.channels
    .filter((channel) => !channel.avatar)
    .map((channel) =>
      channel.id === "general-assistant"
        ? {
            ...channel,
            name: "我的分身",
            description: "有事直接说，个人分身接。",
          }
        : channel,
    ),
  avatarSkills: [],
};

// The platform scope, as the boot path's catalogue write; the per-person writes run in each person's.
const apply = (tenantPackage: LoadedTenantPackage, members: string[]) =>
  runAsTenant("platform", () =>
    synchronizeTenantPackage(database, tenantPackage, members),
  );

// Provisioned the way every arrival path does it: the person row as Better Auth wrote it, then
// provisioning, which makes the 分身.
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

afterAll(async () => {
  for (const person of people) {
    await runAsTenant(person, async () => {
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

const actorOf = (person: string) => ({ id: person, role: "user" as const });

const channelOf = (person: string, id: string) =>
  runAsTenant(person, () =>
    channelStore.get(actorOf(person), packageChannelId(person, id)),
  );

const skillsOfAvatar = async (person: string) =>
  (
    await runAsTenant(person, () =>
      pluginStore.listForAgent(avatarAgentId(person)),
    )
  ).skills
    .map((skill) => skill.slug)
    .sort();

const threadOf = async (person: string, id: string) => {
  const [row] = await runAsTenant(person, () =>
    database
      .select({ threadId: intelligenceChannelMappings.threadId })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(
            intelligenceChannelMappings.channelId,
            packageChannelId(person, id),
          ),
          eq(intelligenceChannelMappings.userId, person),
        ),
      ),
  );
  return row?.threadId;
};

const catalogueAssistant = async () => {
  const [row] = await runAsTenant(newcomer, () =>
    database
      .select({
        name: agents.name,
        title: agentProfiles.title,
        roleDescription: agentProfiles.roleDescription,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(eq(agents.id, "general-assistant")),
  );
  return row;
};

describe("an existing person, synchronized by the package as it shipped before", () => {
  test("starts where the real deployment was: 我的分身 answered by the ownerless catalogue Bot", async () => {
    await apply(before, [existing]);

    const old = await channelOf(existing, "general-assistant");
    expect(old?.name).toBe("我的分身");
    expect(old?.agentIds).toEqual(["general-assistant"]);
    expect(await channelOf(existing, "avatar")).toBeNull();
    expect((await catalogueAssistant())?.name).toBe("我的分身");
    expect(await skillsOfAvatar(existing)).toEqual([]);
  });

  test("the next start repairs it in place: the default conversation is their own 分身", async () => {
    const historyThread = await threadOf(existing, "general-assistant");
    expect(typeof historyThread).toBe("string");

    await apply(loaded, [existing]);

    const mine = await channelOf(existing, "avatar");
    expect(mine?.name).toBe("我的分身");
    // One Bot, so it is a 1:1 conversation pinned to it, and that Bot is this person's own.
    expect(mine?.agentIds).toEqual([avatarAgentId(existing)]);
    expect(mine?.active).toBe(true);
    expect(await ownerTenantOfBot(database, avatarAgentId(existing))).toBe(
      existing,
    );

    /*
     * The old conversation is kept, renamed, on the Bot that wrote its history. Moving the 分身 into
     * it instead would not work: an Intelligence thread admits exactly one agent, so the 分身 could not
     * answer inside the catalogue Bot's thread, and minting a new thread would hide the history.
     */
    const shared = await channelOf(existing, "general-assistant");
    expect(shared?.name).toBe("通用助手");
    expect(shared?.agentIds).toEqual(["general-assistant"]);
    expect(await threadOf(existing, "general-assistant")).toBe(historyThread);

    expect(await skillsOfAvatar(existing)).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
  });

  test("the catalogue Bot is renamed on the same start and still belongs to nobody", async () => {
    const assistant = await catalogueAssistant();
    expect(assistant?.name).toBe("通用助手");
    expect(assistant?.title).toBe("General Assistant");
    expect(assistant?.roleDescription).not.toContain("代表我");
    expect(assistant?.ownerUserId).toBeNull();
    // Not routed to anybody's machine: device selection still finds no owner for it.
    expect(await ownerTenantOfBot(database, "general-assistant")).toBeNull();
  });
});

describe("a newly provisioned person", () => {
  test("gets a default conversation answered by their own 分身, and only by it", async () => {
    await apply(loaded, [newcomer]);

    const mine = await channelOf(newcomer, "avatar");
    expect(mine?.name).toBe("我的分身");
    expect(mine?.agentIds).toEqual([avatarAgentId(newcomer)]);
    expect(mine?.active).toBe(true);
    // Somebody else's 分身 is never in it: each copy resolves its own person.
    expect(mine?.agentIds).not.toContain(avatarAgentId(existing));
  });

  test("can build coworkers and skills in that conversation: the 分身 holds both gate skills", async () => {
    /*
     * The app offers `save_bot` and `save_skill` (and their reads) only to a Bot holding `bot-creator`
     * and `skill-creator`, read from `/api/plugins/for/<bot>`, which is this store call. The default
     * conversation pins the 分身, so this is what decides whether the feature is there.
     */
    expect(await skillsOfAvatar(newcomer)).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
    // 通用助手 keeps the package's pairing too. Read as rows: what a person's frame makes of a
    // catalogue Bot's grants is a separate question from this change.
    const held = await runAsTenant("platform", () =>
      database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "skill"),
            eq(pluginGrants.agentId, "general-assistant"),
            eq(pluginGrants.grantedBy, "tenant-package"),
          ),
        ),
    );
    expect(held.map((row) => row.ref).sort()).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
  });

  test("synchronizing again changes nothing, and a grant the person made survives the package", async () => {
    await runAsTenant(newcomer, () =>
      database
        .update(pluginGrants)
        .set({ grantedBy: newcomer })
        .where(
          and(
            eq(pluginGrants.kind, "skill"),
            eq(pluginGrants.ref, "skill-creator"),
            eq(pluginGrants.agentId, avatarAgentId(newcomer)),
          ),
        ),
    );
    const thread = await threadOf(newcomer, "avatar");

    await apply({ ...loaded, avatarSkills: ["bot-creator"] }, [newcomer]);

    const grants = await runAsTenant(newcomer, () =>
      database
        .select({ ref: pluginGrants.ref, grantedBy: pluginGrants.grantedBy })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "skill"),
            eq(pluginGrants.agentId, avatarAgentId(newcomer)),
            inArray(pluginGrants.ref, ["bot-creator", "skill-creator"]),
          ),
        ),
    );
    // The package's own grant stays; the one the person now owns is theirs, not the package's to take.
    expect(grants.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      { ref: "bot-creator", grantedBy: "tenant-package" },
      { ref: "skill-creator", grantedBy: newcomer },
    ]);
    expect(await threadOf(newcomer, "avatar")).toBe(thread);

    await apply(loaded, [newcomer]);
    expect(await skillsOfAvatar(newcomer)).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
  });

  test("a package that stops giving the 分身 a skill takes back only its own grant", async () => {
    await runAsTenant(newcomer, () =>
      database
        .update(pluginGrants)
        .set({ grantedBy: "tenant-package" })
        .where(eq(pluginGrants.agentId, avatarAgentId(newcomer))),
    );
    await apply({ ...loaded, avatarSkills: ["skill-creator"] }, [newcomer]);
    expect(await skillsOfAvatar(newcomer)).toEqual(["skill-creator"]);

    await apply(loaded, [newcomer]);
    expect(await skillsOfAvatar(newcomer)).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
  });
});

test("a person with no 分身 is refused by name, not handed a conversation with nobody in it", async () => {
  const unprovisioned = `pkg-avatar-none-${suite}`;
  await runAsTenant(unprovisioned, () =>
    database.insert(users).values({
      id: unprovisioned,
      email: `${unprovisioned}@example.test`,
      name: unprovisioned,
    }),
  );
  try {
    await expect(apply(loaded, [unprovisioned])).rejects.toThrow(
      `"${unprovisioned}" has no 分身`,
    );
    // Refused before anything of theirs was written.
    const written = await runAsTenant(unprovisioned, () =>
      database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.tenantId, unprovisioned)),
    );
    expect(written).toEqual([]);
  } finally {
    await runAsTenant(unprovisioned, () =>
      database.delete(users).where(eq(users.id, unprovisioned)),
    );
  }
});
