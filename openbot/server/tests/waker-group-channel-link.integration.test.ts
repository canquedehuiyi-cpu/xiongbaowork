import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createGroupStore } from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  intelligenceChannelMappings,
  users,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import {
  channelOwner,
  createWakerGroupLink,
  pickGroupName,
  runtimeOrder,
} from "../src/waker-groups/channel-link";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A conversation and its crew (spec 2026-11-13 group-unify, sections 3.1, 4.1, 4.4, 4.5).
 *
 * The conversation is the truth — who is in it and the order they answer in — and the crew's roster
 * is its mirror. These tests drive `channel-link.ts` in the frames production uses: the channel is
 * read as `platform`, everything written is written as the conversation's owner.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const groupStore = createGroupStore(database, () => threadIdentity.mint());
const crewStore = createWakerGroupStore(database);
const prefix = `wgcore-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];
const createdGroups: string[] = [];
const createdFlows: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    if (createdFlows.length)
      await database
        .delete(wakerFlows)
        .where(inArray(wakerFlows.id, createdFlows.splice(0)));
    const channelIds = createdChannels.splice(0);
    if (channelIds.length) {
      // The crews linkChannel made for these channels go with them.
      const linked = (await database.execute(
        sql`select waker_group_id from channels where id in ${channelIds} and waker_group_id is not null`,
      )) as unknown as { waker_group_id: string }[];
      createdGroups.push(...linked.map((row) => row.waker_group_id));
      for (const id of channelIds) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, id));
        await database.delete(channels).where(eq(channels.id, id));
      }
    }
    if (createdGroups.length)
      await database
        .delete(wakerGroups)
        .where(inArray(wakerGroups.id, createdGroups.splice(0)));
    if (createdAgents.length) {
      const ids = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    for (const id of createdUsers.splice(0))
      await database.delete(users).where(eq(users.id, id));
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name: string): Promise<AgentActor> {
  const id = `${prefix}-${name}-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Link Core" }),
  );
  createdUsers.push(id);
  return { id, role: "user" };
}

async function bot(owner: AgentActor, name: string) {
  const profile = await runAsTenant(owner.id, () =>
    profileStore.create(owner, {
      name,
      title: "Tester",
      roleDescription: "Answer briefly.",
      visibility: "private",
    }),
  );
  createdAgents.push(profile.id);
  return profile.id;
}

/** A crew written in its owner's frame, stamped by the column default. */
async function crew(owner: AgentActor, name: string) {
  const [row] = await runAsTenant(owner.id, () =>
    database
      .insert(wakerGroups)
      .values({ name })
      .returning({ id: wakerGroups.id }),
  );
  if (!row) throw new Error("crew not written");
  createdGroups.push(row.id);
  return row.id;
}

/** A shared group opened the way `createGroupConversations.create` opens one: Bots in this order. */
async function sharedGroup(creator: AgentActor, agentIds: string[]) {
  const channel = await runAsTenant(creator.id, async () => {
    const made = await channelStore.create(creator, agentIds, {
      shared: true,
    });
    await groupStore.seedOrder(creator.id, made.id, agentIds);
    return made;
  });
  createdChannels.push(channel.id);
  return channel;
}

function linkCore(log?: (line: Record<string, unknown>) => void) {
  return createWakerGroupLink({
    database,
    groupStore,
    ...(log ? { log } : {}),
  });
}

async function channelRow(channelId: string) {
  const rows = (await runAsTenant("platform", () =>
    database.execute(
      sql`select waker_group_id, title, name, created_by from channels where id = ${channelId}`,
    ),
  )) as unknown as {
    waker_group_id: string | null;
    title: string | null;
    name: string;
    created_by: string | null;
  }[];
  const [row] = rows;
  if (!row) throw new Error(`channel ${channelId} is gone`);
  return row;
}

async function crewRow(groupId: string) {
  const [row] = await runAsTenant("platform", () =>
    database
      .select({ name: wakerGroups.name, tenantId: wakerGroups.tenantId })
      .from(wakerGroups)
      .where(eq(wakerGroups.id, groupId)),
  );
  return row ?? null;
}

async function mirror(groupId: string) {
  return await runAsTenant("platform", () =>
    database
      .select({
        agentId: wakerGroupMembers.agentId,
        position: wakerGroupMembers.position,
      })
      .from(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, groupId))
      .orderBy(asc(sql`${wakerGroupMembers.position}::int`)),
  );
}

/** Whether `work` threw. */
async function refused(work: () => Promise<unknown>) {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
}

async function crewsOf(tenant: string) {
  const rows = await runAsTenant("platform", () =>
    database
      .select({ id: wakerGroups.id })
      .from(wakerGroups)
      .where(eq(wakerGroups.tenantId, tenant)),
  );
  return rows.map((row) => row.id);
}

/**
 * A multi-Bot channel written straight as `platform` with the given stamp, the way rows from before
 * shared groups (a person's own) or from frameless old code (`system`) look.
 */
async function legacyChannel(tenantId: string, agentIds: string[]) {
  const channelId = `${prefix}-legacy-${randomUUID()}`;
  await runAsTenant("platform", async () => {
    await database.insert(channels).values({
      id: channelId,
      tenantId,
      name: "Ada、Grace、Linus",
      description: "legacy",
    });
    await database
      .insert(channelAgents)
      .values(agentIds.map((agentId) => ({ channelId, agentId, tenantId })));
  });
  createdChannels.push(channelId);
  return channelId;
}

describe("link core", () => {
  test("channelOwner follows the owner rule", () => {
    expect(channelOwner({ tenantId: "team", createdBy: "u1" })).toBe("u1");
    expect(channelOwner({ tenantId: "team", createdBy: null })).toBeNull();
    expect(channelOwner({ tenantId: "u2", createdBy: null })).toBe("u2");
    // Only a person owns a crew: rows stamped by no person have no owner.
    expect(channelOwner({ tenantId: "system", createdBy: null })).toBeNull();
    expect(channelOwner({ tenantId: "platform", createdBy: null })).toBeNull();
    expect(
      channelOwner({ tenantId: "team", createdBy: "platform" }),
    ).toBeNull();
    expect(channelOwner({ tenantId: "team", createdBy: "system" })).toBeNull();
    expect(channelOwner({ tenantId: "team", createdBy: "team" })).toBeNull();
  });

  test("pickGroupName adds （2） up to （99）, then the id prefix, within 80 characters", async () => {
    const alice = await person("alice");
    const own = await crew(alice, "复盘");
    await runAsTenant(alice.id, async () => {
      expect(await pickGroupName(database, "复盘")).toBe("复盘（2）");
      // Renaming a crew to the name it already has is not a clash with itself.
      expect(await pickGroupName(database, "复盘", { except: own })).toBe(
        "复盘",
      );
    });

    const rows = await runAsTenant(alice.id, () =>
      database
        .insert(wakerGroups)
        .values(
          Array.from({ length: 98 }, (_, index) => ({
            name: `复盘（${index + 2}）`,
          })),
        )
        .returning({ id: wakerGroups.id }),
    );
    createdGroups.push(...rows.map((row) => row.id));
    const id = randomUUID();
    expect(
      await runAsTenant(alice.id, () =>
        pickGroupName(database, "复盘", { idForSuffix: id }),
      ),
    ).toBe(`复盘${id.slice(0, 6)}`);

    const long = "长".repeat(81);
    const fresh = await runAsTenant(alice.id, () =>
      pickGroupName(database, long),
    );
    expect(fresh.length).toBeLessThanOrEqual(80);
    expect(fresh).toBe("长".repeat(80));
    await crew(alice, "长".repeat(80));
    const clashed = await runAsTenant(alice.id, () =>
      pickGroupName(database, long),
    );
    expect(clashed.length).toBeLessThanOrEqual(80);
    expect(clashed.endsWith("（2）")).toBe(true);
  });

  test("linkChannel makes the crew, mirrors the order and links, once", async () => {
    const alice = await person("alice");
    const b1 = await bot(alice, "Ada");
    const b2 = await bot(alice, "Grace");
    const channel = await sharedGroup(alice, [b2, b1]);
    const link = linkCore();

    const groupId = await link.linkChannel(channel.id);
    expect(groupId).not.toBeNull();
    if (!groupId) return;
    const row = await channelRow(channel.id);
    expect(row.waker_group_id).toBe(groupId);
    expect(await crewRow(groupId)).toEqual({
      name: row.name,
      tenantId: alice.id,
    });
    expect(await mirror(groupId)).toEqual([
      { agentId: b2, position: "0" },
      { agentId: b1, position: "1" },
    ]);

    const before = await crewsOf(alice.id);
    expect(await link.linkChannel(channel.id)).toBe(groupId);
    expect(await crewsOf(alice.id)).toEqual(before);
  });

  test("linkChannel on a shared group with no creator makes nothing", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set created_by = null where id = ${channel.id}`,
      ),
    );

    expect(await linkCore().linkChannel(channel.id)).toBeNull();
    expect(await crewsOf(alice.id)).toEqual([]);
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();
  });

  test("runtimeOrder puts unordered Bots after the ordered ones, by id", () => {
    expect(runtimeOrder(["b", "x", "a"], ["d", "a", "c", "b"])).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  test("the mirror keeps a Bot that has no order row", async () => {
    const alice = await person("alice");
    const ids = [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
      await bot(alice, "Linus"),
    ];
    // An old personal multi-Bot channel: three Bots linked, only two given order rows.
    const channelId = await legacyChannel(alice.id, ids);
    const unordered = ids[0] as string;
    const ordered = [ids[2] as string, ids[1] as string];
    await runAsTenant(alice.id, () =>
      groupStore.seedOrder(alice.id, channelId, ordered),
    );
    const link = linkCore();

    const groupId = await link.linkChannel(channelId);
    expect(groupId).not.toBeNull();
    if (!groupId) return;
    const expected = [
      { agentId: ordered[0], position: "0" },
      { agentId: ordered[1], position: "1" },
      { agentId: unordered, position: "2" },
    ];
    expect(await mirror(groupId)).toEqual(expected);

    expect(await link.reconcile(channelId)).toBe(true);
    expect(await mirror(groupId)).toEqual(expected);
  });

  test("adopt links an existing crew, renames the channel to it and mirrors the chat", async () => {
    const alice = await person("alice");
    const b1 = await bot(alice, "Ada");
    const b2 = await bot(alice, "Grace");
    const channel = await sharedGroup(alice, [b2, b1]);
    const groupId = await crew(alice, "编程群组");
    // Whatever the crew held before, the chat's roster wins.
    await runAsTenant(alice.id, () =>
      database
        .insert(wakerGroupMembers)
        .values({ groupId, agentId: b1, position: "0" }),
    );

    await linkCore().adopt(groupId, channel.id);

    const row = await channelRow(channel.id);
    expect(row.waker_group_id).toBe(groupId);
    expect(row.title).toBe("编程群组");
    expect(await mirror(groupId)).toEqual([
      { agentId: b2, position: "0" },
      { agentId: b1, position: "1" },
    ]);
  });

  test("reconcile rewrites the mirror after a Bot is deleted", async () => {
    const alice = await person("alice");
    const b1 = await bot(alice, "Ada");
    const b2 = await bot(alice, "Grace");
    const b3 = await bot(alice, "Linus");
    const channel = await sharedGroup(alice, [b1, b2, b3]);
    const link = linkCore();
    const groupId = await link.linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");

    await runAsTenant("platform", async () => {
      await database.delete(agentProfiles).where(eq(agentProfiles.agentId, b2));
      await database.delete(agents).where(eq(agents.id, b2));
    });
    // Still mirrored until something reconciles.
    expect((await mirror(groupId)).map((entry) => entry.agentId)).toEqual([
      b1,
      b2,
      b3,
    ]);

    expect(await link.reconcile(channel.id)).toBe(true);
    expect(await mirror(groupId)).toEqual([
      { agentId: b1, position: "0" },
      { agentId: b3, position: "1" },
    ]);
  });

  test("reconcile on an unlinked channel answers false and makes nothing", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    expect(await linkCore().reconcile(channel.id)).toBe(false);
    expect(await crewsOf(alice.id)).toEqual([]);
  });

  test("reconcile keeps the crew's name when the title is taken, and says so", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const lines: Record<string, unknown>[] = [];
    const link = linkCore((line) => lines.push(line));
    const groupId = await link.linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");
    const original = (await crewRow(groupId))?.name;
    await crew(alice, "周报");

    await runAsTenant(alice.id, () =>
      channelStore.rename(alice, channel.id, "周报"),
    );
    expect(await link.reconcile(channel.id)).toBe(true);

    expect((await crewRow(groupId))?.name).toBe(original);
    expect(lines).toContainEqual({
      type: "waker-group-name-taken",
      channelId: channel.id,
      groupId,
      name: "周报",
    });
  });

  test("reconcile and syncName follow a free title", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const link = linkCore();
    const groupId = await link.linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");

    await runAsTenant(alice.id, () =>
      channelStore.rename(alice, channel.id, "周会"),
    );
    await link.syncName(channel.id);
    expect((await crewRow(groupId))?.name).toBe("周会");

    await runAsTenant(alice.id, () =>
      channelStore.rename(alice, channel.id, "月会"),
    );
    expect(await link.reconcile(channel.id)).toBe(true);
    expect((await crewRow(groupId))?.name).toBe("月会");
  });

  test("linkedGroupOf and liveChannelOf answer for a linked channel", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const link = linkCore();
    expect(await link.linkedGroupOf(channel.id)).toBeNull();
    const groupId = await link.linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");

    expect(await link.linkedGroupOf(channel.id)).toBe(groupId);
    expect(await runAsTenant(alice.id, () => link.liveChannelOf(groupId))).toBe(
      channel.id,
    );
    // Bob is no member: the channel is not his to see.
    expect(
      await runAsTenant(bob.id, () => link.liveChannelOf(groupId)),
    ).toBeNull();
  });

  test("the list carries channelId for a live linked channel only, and still hides a WakerFlow crew", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const groupId = await linkCore().linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");
    const loose = await crew(alice, "未挂接");
    const flowCrew = await crew(alice, "流程内部");
    const [flow] = await runAsTenant(alice.id, () =>
      database
        .insert(wakerFlows)
        .values({ name: "流程", revision: 1, groupId: flowCrew })
        .returning({ id: wakerFlows.id }),
    );
    if (!flow) throw new Error("flow not written");
    createdFlows.push(flow.id);

    const listed = await runAsTenant(alice.id, () => crewStore.list());
    expect(listed.find((item) => item.id === groupId)?.channelId).toBe(
      channel.id,
    );
    expect(listed.find((item) => item.id === loose)?.channelId).toBeNull();
    expect(listed.some((item) => item.id === flowCrew)).toBe(false);

    await runAsTenant("platform", () =>
      database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channel.id)),
    );
    const afterDelete = await runAsTenant(alice.id, () => crewStore.list());
    expect(
      afterDelete.find((item) => item.id === groupId)?.channelId,
    ).toBeNull();
  });

  test("another tenant's list sees no channelId of ours", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const groupId = await linkCore().linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");

    const listed = await runAsTenant(bob.id, () => crewStore.list());
    expect(listed.some((item) => item.id === groupId)).toBe(false);
    expect(listed.some((item) => item.channelId === channel.id)).toBe(false);
  });
});

describe("link core, fix round 1", () => {
  test("three linkChannel calls at once all answer the one crew", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    // Enough connections for the three transactions to really overlap (TEST_POOL holds two).
    const wide = createDatabase(testDatabaseUrl(), { max: 6 });
    try {
      const link = createWakerGroupLink({ database: wide, groupStore });
      const answers = await Promise.allSettled([
        link.linkChannel(channel.id),
        link.linkChannel(channel.id),
        link.linkChannel(channel.id),
      ]);
      const groupId = (await channelRow(channel.id)).waker_group_id;
      expect(groupId).not.toBeNull();
      expect(answers).toEqual([
        { status: "fulfilled", value: groupId },
        { status: "fulfilled", value: groupId },
        { status: "fulfilled", value: groupId },
      ]);
      expect(await crewsOf(alice.id)).toEqual([groupId as string]);
    } finally {
      await wide.$client.close();
    }
  });

  test("a channel stamped system, or a shared group created by platform, gets no crew", async () => {
    const alice = await person("alice");
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const before = {
      system: await crewsOf("system"),
      platform: await crewsOf("platform"),
    };

    const orphan = await legacyChannel("system", ids);
    expect(await linkCore().linkChannel(orphan)).toBeNull();
    expect((await channelRow(orphan)).waker_group_id).toBeNull();

    const channel = await sharedGroup(alice, ids);
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set created_by = 'platform' where id = ${channel.id}`,
      ),
    );
    expect(await linkCore().linkChannel(channel.id)).toBeNull();
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();

    expect(await crewsOf("system")).toEqual(before.system);
    expect(await crewsOf("platform")).toEqual(before.platform);
    expect(await crewsOf(alice.id)).toEqual([]);
  });

  test("a crew already named with a （2） is not reported as taken again", async () => {
    const alice = await person("alice");
    await crew(alice, "周报");
    await crew(alice, "日报");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    await runAsTenant(alice.id, () =>
      channelStore.rename(alice, channel.id, "周报"),
    );
    const lines: Record<string, unknown>[] = [];
    const link = linkCore((line) => lines.push(line));
    const groupId = await link.linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");
    expect((await crewRow(groupId))?.name).toBe("周报（2）");
    const taken = () =>
      lines.filter((line) => line.type === "waker-group-name-taken");

    // A real clash is said once per attempt...
    await runAsTenant(alice.id, () =>
      channelStore.rename(alice, channel.id, "日报"),
    );
    expect(await link.reconcile(channel.id)).toBe(true);
    expect(taken()).toHaveLength(1);
    expect((await crewRow(groupId))?.name).toBe("周报（2）");

    // ...and a name that is already the clash-free form of the title is no clash at all.
    await runAsTenant(alice.id, () =>
      channelStore.rename(alice, channel.id, "周报"),
    );
    expect(await link.reconcile(channel.id)).toBe(true);
    expect(await link.reconcile(channel.id)).toBe(true);
    await link.syncName(channel.id);
    expect(taken()).toHaveLength(1);
    expect((await crewRow(groupId))?.name).toBe("周报（2）");
  });

  test("adopt refuses a channel linked to another crew, and keeps the link", async () => {
    const alice = await person("alice");
    const channelId = await legacyChannel(alice.id, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const link = linkCore();
    const first = await link.linkChannel(channelId);
    if (!first) throw new Error("not linked");
    // Cleaned up even if a wrong adopt unlinked it.
    createdGroups.push(first);
    const second = await crew(alice, "另一个");

    expect(await refused(() => link.adopt(second, channelId))).toBe(true);
    expect(await link.linkedGroupOf(channelId)).toBe(first);
    // The same crew again is no change of mind.
    await link.adopt(first, channelId);
    expect(await link.linkedGroupOf(channelId)).toBe(first);
  });

  test("adopt refuses a deleted channel", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    const groupId = await crew(alice, "已删");
    await runAsTenant("platform", () =>
      database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channel.id)),
    );

    expect(await refused(() => linkCore().adopt(groupId, channel.id))).toBe(
      true,
    );
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();
    expect(await mirror(groupId)).toEqual([]);
  });

  test("a blank title falls back to the channel's name", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    await runAsTenant("platform", () =>
      database
        .update(channels)
        .set({ title: "   " })
        .where(eq(channels.id, channel.id)),
    );
    const groupId = await linkCore().linkChannel(channel.id);
    if (!groupId) throw new Error("not linked");
    expect((await crewRow(groupId))?.name).toBe(
      (await channelRow(channel.id)).name,
    );
  });

  test("the 80-character cut never splits a surrogate pair", async () => {
    const alice = await person("alice");
    const wanted = `a${"😀".repeat(40)}`;
    const name = await runAsTenant(alice.id, () =>
      pickGroupName(database, wanted),
    );
    expect(name).toBe(`a${"😀".repeat(39)}`);
    expect(name.length).toBe(79);
    const last = name.charCodeAt(name.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
