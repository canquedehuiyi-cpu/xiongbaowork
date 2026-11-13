import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
  GroupRefusedError,
} from "../src/channels/group";
import {
  ChannelNotOwnerError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  intelligenceChannelMappings,
  staffingProposals,
  users,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPortraitStore } from "../src/portraits/store";
import { parseDraft } from "../src/staffing/draft";
import {
  createStaffingExecutor,
  type StaffingExecutorDeps,
} from "../src/staffing/executor";
import { createStaffingProposalStore } from "../src/staffing/store";
import { runAsTenant } from "../src/tenant/context";
import {
  channelOwner,
  createWakerGroupLink,
  pickGroupName,
  runtimeOrder,
  type WakerGroupLink,
  withChannelRenameLink,
  withWakerGroupLink,
} from "../src/waker-groups/channel-link";
import {
  createWakerGroupActions,
  type StatusedWakerGroup,
} from "../src/waker-groups/linked-actions";
import { createWakerGroupRoutes } from "../src/waker-groups/routes";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { createWorkQueue } from "../src/work/queue";
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
    if (createdUsers.length)
      await database
        .delete(staffingProposals)
        .where(inArray(staffingProposals.ownerId, createdUsers));
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

/** What the groups service is in production (index.ts), minus the turns: no Bot answers here. */
function conversations() {
  return createGroupConversations({
    store: groupStore,
    queue: createWorkQueue(database),
    owner: `${prefix}-replica`,
    roster: async (ownerUserId, channelId) => {
      const actor: AgentActor = { id: ownerUserId, role: "user" };
      const channel = await channelStore.get(actor, channelId);
      if (!channel || channel.agentIds.length < 2) return null;
      const bots = [];
      for (const agentId of channel.agentIds) {
        const profile = await profileStore.get(actor, agentId);
        if (profile) bots.push({ id: agentId, name: profile.name });
      }
      return bots;
    },
    runTurn: async () => ({ replyText: "ok" }),
    caps: { maxDepth: 1, maxPerRun: 2 },
    mayAddress: async () => true,
    auditStore: { insert: async () => {} },
    createChannel: async (ownerUserId, agentIds, options) => {
      const channel = await channelStore.create(
        { id: ownerUserId, role: "user" },
        agentIds,
        options,
      );
      createdChannels.push(channel.id);
      return channel;
    },
    canUseBot: async (ownerUserId, agentId) =>
      Boolean(
        await profileStore.get({ id: ownerUserId, role: "user" }, agentId),
      ),
    progressEveryMs: 0,
  });
}

/** The mirror's Bots, and what the conversation says they should be, in its owner's frame. */
async function mirrorAndTruth(owner: AgentActor, channelId: string) {
  const groupId = (await channelRow(channelId)).waker_group_id;
  if (!groupId) throw new Error("not linked");
  const truth = await runAsTenant(owner.id, async () =>
    runtimeOrder(
      await groupStore.order(channelId),
      await groupStore.bots(channelId),
    ),
  );
  const mirrored = (await mirror(groupId)).map((entry) => entry.agentId);
  return { mirrored, truth };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("decorators", () => {
  test("a group made through POST /api/groups comes back linked", async () => {
    const alice = await person("alice");
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const routes = createGroupRoutes(
      withWakerGroupLink(conversations(), linkCore()),
      async (context, next) => {
        context.set("actor", alice as never);
        // As `requireUser` in production: the request runs inside the signed-in person's tenant.
        await runAsTenant(alice.id, () => next());
      },
    );

    const response = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ids }),
    });

    expect(response.status).toBe(201);
    const { channel } = (await response.json()) as {
      channel: { id: string; wakerGroupId?: string };
    };
    expect(channel.wakerGroupId).toMatch(UUID);
    const listed = await runAsTenant(alice.id, () => crewStore.list());
    expect(listed.find((item) => item.id === channel.wakerGroupId)).toEqual(
      expect.objectContaining({ channelId: channel.id }),
    );
  });

  test("a staffing group proposal ends linked and named as the draft", async () => {
    const alice = await person("alice");
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const link = linkCore();
    const proposals = createStaffingProposalStore(database);
    // Only the group steps run here: whatever else the executor holds is never reached.
    const unused = {} as never;
    const executor = createStaffingExecutor({
      database,
      proposals,
      profiles: profileStore,
      plugins: unused as StaffingExecutorDeps["plugins"],
      composioConfigured: false,
      routines: unused as StaffingExecutorDeps["routines"],
      channels: withChannelRenameLink(channelStore, link),
      groups: withWakerGroupLink(conversations(), link),
      portraits: unused as StaffingExecutorDeps["portraits"],
      auditStore: { insert: async () => {} },
    });
    const parsed = parseDraft("group", { name: "周报群组", members: ids });
    if (!parsed.ok) throw new Error(parsed.error);
    const proposal = await runAsTenant(alice.id, () =>
      proposals.create({
        ownerId: alice.id,
        proposedByAgentId: `avatar-${alice.id}`,
        threadId: null,
        kind: "group",
        draft: parsed.draft,
        baseVersion: null,
      }),
    );
    const owner = {
      id: alice.id,
      email: `${alice.id}@example.test`,
      role: "user" as const,
    };

    const applied = await runAsTenant(alice.id, () =>
      executor.apply(owner, proposal.id),
    );

    const items = (applied.result ?? []) as {
      step: string;
      outcome: string;
      target?: string;
    }[];
    expect(items.map((item) => [item.step, item.outcome])).toEqual([
      ["group", "done"],
      ["rename", "done"],
    ]);
    const channelId = items[0]?.target;
    if (!channelId) throw new Error("no channel");
    const groupId = (await channelRow(channelId)).waker_group_id;
    expect(groupId).toMatch(UUID);
    expect((await crewRow(groupId as string))?.name).toBe("周报群组");
    expect((await channelRow(channelId)).title).toBe("周报群组");
  });

  test("adding, removing and reordering Bots rewrites the mirror", async () => {
    const alice = await person("alice");
    const [ada, grace, linus] = [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
      await bot(alice, "Linus"),
    ];
    const groups = withWakerGroupLink(conversations(), linkCore());
    const channel = await runAsTenant(alice.id, () =>
      groups.create(alice.id, { agentIds: [ada, grace] }),
    );
    expect(channel.wakerGroupId).toMatch(UUID);

    await runAsTenant(alice.id, () =>
      groups.addBots(alice.id, channel.id, [linus]),
    );
    let seen = await mirrorAndTruth(alice, channel.id);
    expect(seen.mirrored).toEqual(seen.truth);
    expect(seen.mirrored).toEqual([ada, grace, linus]);

    await runAsTenant(alice.id, () =>
      groups.removeBots(alice.id, channel.id, [ada]),
    );
    seen = await mirrorAndTruth(alice, channel.id);
    expect(seen.mirrored).toEqual(seen.truth);
    expect(seen.mirrored).toEqual([grace, linus]);

    await runAsTenant(alice.id, () =>
      groups.reorder(alice.id, channel.id, [linus, grace]),
    );
    seen = await mirrorAndTruth(alice, channel.id);
    expect(seen.mirrored).toEqual(seen.truth);
    expect(seen.mirrored).toEqual([linus, grace]);
  });

  test("renaming a linked channel renames its crew; a taken name keeps the old one", async () => {
    const alice = await person("alice");
    const lines: Record<string, unknown>[] = [];
    const link = linkCore((line) => lines.push(line));
    const renaming = withChannelRenameLink(channelStore, link);
    const channel = await runAsTenant(alice.id, async () =>
      withWakerGroupLink(conversations(), link).create(alice.id, {
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      }),
    );
    const groupId = channel.wakerGroupId;
    if (!groupId) throw new Error("not linked");

    await runAsTenant(alice.id, () =>
      renaming.rename(alice, channel.id, "新名"),
    );
    expect((await crewRow(groupId))?.name).toBe("新名");

    await crew(alice, "已有的群组");
    expect(
      await runAsTenant(alice.id, () =>
        renaming.rename(alice, channel.id, "已有的群组"),
      ),
    ).toBe("已有的群组");
    expect((await crewRow(groupId))?.name).toBe("新名");
    expect(lines).toContainEqual({
      type: "waker-group-name-taken",
      channelId: channel.id,
      groupId,
      name: "已有的群组",
    });
    expect((await channelRow(channel.id)).title).toBe("已有的群组");
  });

  test("a failed link does not fail the create", async () => {
    const alice = await person("alice");
    const lines: Record<string, unknown>[] = [];
    const broken: WakerGroupLink = {
      ...linkCore(),
      linkChannel: async () => {
        throw new Error("crew store unavailable");
      },
    };
    const groups = withWakerGroupLink(conversations(), broken, (line) =>
      lines.push(line),
    );

    const channel = await runAsTenant(alice.id, async () =>
      groups.create(alice.id, {
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      }),
    );

    expect(channel.id).toBeString();
    expect("wakerGroupId" in channel).toBe(false);
    expect(lines).toEqual([
      {
        type: "waker-group-link-failed",
        channelId: channel.id,
        error: "crew store unavailable",
      },
    ]);
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();
  });

  test("Bot changes on an unlinked channel touch no crew", async () => {
    const alice = await person("alice");
    const base = conversations();
    const channel = await runAsTenant(alice.id, async () =>
      base.create(alice.id, {
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      }),
    );
    const linus = await bot(alice, "Linus");
    const before = await crewsOf(alice.id);

    await runAsTenant(alice.id, () =>
      withWakerGroupLink(base, linkCore()).addBots(alice.id, channel.id, [
        linus,
      ]),
    );

    expect(await crewsOf(alice.id)).toEqual(before);
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();
  });

  test("a failed mirror or name sync does not fail the write, and a refused write syncs nothing", async () => {
    const alice = await person("alice");
    const lines: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const flaky: WakerGroupLink = {
      ...linkCore(),
      reconcile: async (channelId) => {
        calls.push(`reconcile ${channelId}`);
        throw new Error("mirror unavailable");
      },
      syncName: async (channelId) => {
        calls.push(`syncName ${channelId}`);
        throw new Error("name unavailable");
      },
    };
    const log = (line: Record<string, unknown>) => lines.push(line);
    const groups = withWakerGroupLink(conversations(), flaky, log);
    const renaming = withChannelRenameLink(channelStore, flaky, log);
    const [ada, grace, linus] = [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
      await bot(alice, "Linus"),
    ];
    const channel = await runAsTenant(alice.id, () =>
      groups.create(alice.id, { agentIds: [ada, grace] }),
    );

    expect(
      await runAsTenant(alice.id, () =>
        groups.addBots(alice.id, channel.id, [linus]),
      ),
    ).toEqual({ added: [linus] });
    expect(
      await runAsTenant(alice.id, () =>
        renaming.rename(alice, channel.id, "周会"),
      ),
    ).toBe("周会");
    expect(lines).toEqual([
      {
        type: "waker-group-reconcile-failed",
        channelId: channel.id,
        error: "mirror unavailable",
      },
      {
        type: "waker-group-name-sync-failed",
        channelId: channel.id,
        error: "name unavailable",
      },
    ]);

    // The upstream refusal (a group keeps at least two Bots) is the answer; nothing follows it.
    calls.length = 0;
    expect(
      await runAsTenant(alice.id, () =>
        groups.removeBots(alice.id, channel.id, [ada, grace]),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(GroupRefusedError);
    expect(calls).toEqual([]);
  });
});

describe("link core, review round 2", () => {
  test("a 23505 with the channel still unlinked is thrown as it came", async () => {
    const alice = await person("alice");
    const ada = await bot(alice, "Ada");
    const channel = await sharedGroup(alice, [ada, await bot(alice, "Grace")]);
    // A roster naming one Bot twice breaks the mirror's primary key: a unique violation that no
    // other linker caused, so there is no winner's crew to answer with.
    const link = createWakerGroupLink({
      database,
      groupStore: { order: async () => [], bots: async () => [ada, ada] },
    });

    const failure = await link.linkChannel(channel.id).then(
      () => null,
      (error: unknown) => error,
    );

    const state = failure as {
      errno?: string;
      cause?: { errno?: string };
    } | null;
    expect(String(state?.errno ?? state?.cause?.errno)).toBe("23505");
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();
    expect(await crewsOf(alice.id)).toEqual([]);
  });

  test("a refused adopt leaves the channel's title and both mirrors as they were", async () => {
    const alice = await person("alice");
    const ada = await bot(alice, "Ada");
    const grace = await bot(alice, "Grace");
    const channelId = await legacyChannel(alice.id, [ada, grace]);
    const link = linkCore();
    const first = await link.linkChannel(channelId);
    if (!first) throw new Error("not linked");
    createdGroups.push(first);
    const second = await crew(alice, "另一个");
    await runAsTenant(alice.id, () =>
      database
        .insert(wakerGroupMembers)
        .values({ groupId: second, agentId: grace, position: "0" }),
    );
    const before = {
      title: (await channelRow(channelId)).title,
      first: await mirror(first),
      second: await mirror(second),
    };

    expect(await refused(() => link.adopt(second, channelId))).toBe(true);

    expect((await channelRow(channelId)).title).toBe(before.title);
    expect(await mirror(first)).toEqual(before.first);
    expect(await mirror(second)).toEqual(before.second);
    expect(before.second).toEqual([{ agentId: grace, position: "0" }]);
  });

  test("linkChannel on a deleted, unlinked channel answers null and makes no crew", async () => {
    const alice = await person("alice");
    const channel = await sharedGroup(alice, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);
    await runAsTenant("platform", () =>
      database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channel.id)),
    );

    expect(await linkCore().linkChannel(channel.id)).toBeNull();
    expect((await channelRow(channel.id)).waker_group_id).toBeNull();
    expect(await crewsOf(alice.id)).toEqual([]);
  });
});

describe("decorators, fix round 1", () => {
  /** What a write threw, or null. */
  const thrown = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => error,
    );

  test("when the creator has left a shared group, a Bot change and a name sync leave the crew alone", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const lines: Record<string, unknown>[] = [];
    const log = (line: Record<string, unknown>) => lines.push(line);
    const link = linkCore(log);
    const groups = withWakerGroupLink(conversations(), link, log);
    const [ada, grace] = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const channel = await runAsTenant(alice.id, () =>
      groups.create(alice.id, { agentIds: [ada, grace] }),
    );
    const groupId = channel.wakerGroupId;
    if (!groupId) throw new Error("not linked");
    await runAsTenant(alice.id, () =>
      groups.addMember(alice.id, channel.id, {
        email: `${bob.id}@example.test`,
      }),
    );
    // The service keeps a creator in while others are; row security still lets them delete their own
    // membership, and then the crew's owner can no longer read the conversation.
    await runAsTenant(alice.id, () =>
      groupStore.removeMember(channel.id, alice.id),
    );
    const before = {
      mirror: await mirror(groupId),
      name: (await crewRow(groupId))?.name,
    };
    expect(before.mirror.map((entry) => entry.agentId)).toEqual([ada, grace]);
    const linus = await bot(bob, "Linus");
    lines.length = 0;

    expect(
      await runAsTenant(bob.id, () =>
        groups.addBots(bob.id, channel.id, [linus]),
      ),
    ).toEqual({ added: [linus] });
    expect(await mirror(groupId)).toEqual(before.mirror);

    // Nobody can rename it any more (only its creator may, 0122), so the name is followed the way
    // the self-heal would: from a title written past the store.
    await runAsTenant("platform", () =>
      database
        .update(channels)
        .set({ title: "新名" })
        .where(eq(channels.id, channel.id)),
    );
    await link.syncName(channel.id);
    expect((await crewRow(groupId))?.name).toBe(before.name);

    expect(lines).toEqual([
      { type: "waker-group-owner-gone", channelId: channel.id },
      { type: "waker-group-owner-gone", channelId: channel.id },
    ]);
  });

  test("a create that links nothing says so", async () => {
    const alice = await person("alice");
    const lines: Record<string, unknown>[] = [];
    const ownerless: WakerGroupLink = {
      ...linkCore(),
      linkChannel: async () => null,
    };
    const channel = await runAsTenant(alice.id, async () =>
      withWakerGroupLink(conversations(), ownerless, (line) =>
        lines.push(line),
      ).create(alice.id, {
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      }),
    );

    expect("wakerGroupId" in channel).toBe(false);
    expect(lines).toEqual([
      { type: "waker-group-link-skipped", channelId: channel.id },
    ]);
  });

  test("a refused rename syncs no name", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const calls: string[] = [];
    const watched: WakerGroupLink = {
      ...linkCore(),
      syncName: async (channelId) => {
        calls.push(channelId);
      },
    };
    const groups = withWakerGroupLink(conversations(), linkCore());
    const channel = await runAsTenant(alice.id, async () =>
      groups.create(alice.id, {
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      }),
    );
    await runAsTenant(alice.id, () =>
      groups.addMember(alice.id, channel.id, {
        email: `${bob.id}@example.test`,
      }),
    );

    // Bob is in the group but did not start it: only Alice may name it.
    expect(
      await thrown(
        runAsTenant(bob.id, () =>
          withChannelRenameLink(channelStore, watched).rename(
            bob,
            channel.id,
            "鲍勃的名字",
          ),
        ),
      ),
    ).toBeInstanceOf(ChannelNotOwnerError);
    expect(calls).toEqual([]);
  });

  test("a refused create links nothing", async () => {
    const alice = await person("alice");
    const calls: string[] = [];
    const watched: WakerGroupLink = {
      ...linkCore(),
      linkChannel: async (channelId) => {
        calls.push(channelId);
        return null;
      },
    };
    const before = await crewsOf(alice.id);

    // A group needs at least two Bots.
    const refusal = await thrown(
      runAsTenant(alice.id, async () =>
        withWakerGroupLink(conversations(), watched).create(alice.id, {
          agentIds: [await bot(alice, "Ada")],
        }),
      ),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
    expect(await crewsOf(alice.id)).toEqual(before);
  });
});

describe("routes", () => {
  // Crews the routes made that no channel holds any more (removed, unlinked, never chatted). Runs
  // before the file's own cleanup, while the people are still listed.
  afterEach(async () => {
    for (const id of createdUsers) createdGroups.push(...(await crewsOf(id)));
  });

  type Listed = StatusedWakerGroup;
  type Made = {
    group: Listed;
    channel: { id: string; name: string; wakerGroupId: string };
  };
  type Answer = { status: number; text: string; json: Record<string, unknown> };

  /**
   * `/api/waker-groups` as index.ts mounts it: the actions over the undecorated groups service and the
   * rename-decorated channel store. `as(person)` signs the next request in, the way `requireUser`
   * does in production: inside that person's own tenant.
   */
  function crewApi(options: { link?: WakerGroupLink } = {}) {
    const link = options.link ?? linkCore();
    const actions = createWakerGroupActions({
      database,
      store: crewStore,
      link,
      groups: conversations(),
      channels: withChannelRenameLink(channelStore, link),
      actorFor: async (id) => ({ id, role: "user" }),
      portraits: createPortraitStore(database),
      canUse: async (owner, agentId) =>
        Boolean(await profileStore.get({ id: owner, role: "user" }, agentId)),
    });
    let caller: AgentActor | null = null;
    const routes = createWakerGroupRoutes(
      crewStore,
      async (context, next) => {
        const actor = caller;
        if (!actor) throw new Error("nobody signed in");
        context.set("actor", {
          id: actor.id,
          email: `${actor.id}@example.test`,
          role: "user",
        });
        await runAsTenant(actor.id, () => next());
      },
      actions,
    );
    return async (
      actor: AgentActor,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Answer> => {
      caller = actor;
      const response = await routes.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: response.status, text, json };
    };
  }

  /** A route that is expected to fail with a 500 does it without the stack Hono prints for one. */
  async function quietly<T>(work: () => Promise<T>) {
    const original = console.error;
    console.error = () => {};
    try {
      return await work();
    } finally {
      console.error = original;
    }
  }

  /** Every conversation a person opened, deleted or not, as `platform` reads them. */
  async function chatsOf(userId: string) {
    return (await runAsTenant("platform", () =>
      database.execute(
        sql`select id, deleted_at is not null as deleted, waker_group_id
              from channels where created_by = ${userId} order by created_at`,
      ),
    )) as unknown as {
      id: string;
      deleted: boolean;
      waker_group_id: string | null;
    }[];
  }

  async function namedCrews(tenant: string, name: string) {
    return runAsTenant("platform", () =>
      database
        .select({ id: wakerGroups.id })
        .from(wakerGroups)
        .where(
          sql`${wakerGroups.tenantId} = ${tenant} and ${wakerGroups.name} = ${name}`,
        ),
    );
  }

  /** Roster rows written past every check, as an upgrade's conversion leaves them. */
  async function writeRoster(groupId: string, agentIds: string[]) {
    await runAsTenant("platform", async () => {
      await database
        .delete(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, groupId));
      await database.insert(wakerGroupMembers).values(
        agentIds.map((agentId, position) => ({
          groupId,
          agentId,
          position: String(position),
        })),
      );
    });
  }

  async function listedBy(person: AgentActor, groupId: string) {
    const listed = await runAsTenant(person.id, () => crewStore.list());
    return listed.find((group) => group.id === groupId) ?? null;
  }

  /** Unlink a conversation past every check, the way a group from before linking looks. */
  async function unlink(channelId: string) {
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set waker_group_id = null where id = ${channelId}`,
      ),
    );
  }

  const broken = (): WakerGroupLink => ({
    ...linkCore(),
    adopt: async () => {
      throw new Error("adopt unavailable");
    },
  });

  test("POST with agentIds makes the crew and its chat in one call", async () => {
    const alice = await person("alice");
    const [ada, grace, linus] = [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
      await bot(alice, "Linus"),
    ];
    const submitted = [linus, ada, grace];

    const answer = await crewApi()(alice, "POST", "/", {
      name: "周报群组",
      description: "每周一",
      agentIds: submitted,
    });

    expect(answer.status).toBe(201);
    const { group, channel } = answer.json as unknown as Made;
    expect(group.name).toBe("周报群组");
    expect(group.description).toBe("每周一");
    expect(group.channelId).toBe(channel.id);
    expect(channel.wakerGroupId).toBe(group.id);
    expect((await channelRow(channel.id)).title).toBe(group.name);
    expect((await channelRow(channel.id)).waker_group_id).toBe(group.id);
    expect(
      await runAsTenant(alice.id, () => groupStore.order(channel.id)),
    ).toEqual(submitted);
    expect((await mirror(group.id)).map((entry) => entry.agentId)).toEqual(
      submitted,
    );
    expect(group.members.map((member) => member.agentId)).toEqual(submitted);
  });

  test("POST with a taken name answers 409 and makes no channel", async () => {
    const alice = await person("alice");
    const api = crewApi();
    expect((await api(alice, "POST", "/", { name: "周报" })).status).toBe(201);
    const before = await chatsOf(alice.id);

    const answer = await api(alice, "POST", "/", {
      name: "周报",
      agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
    });

    expect(answer.status).toBe(409);
    expect(await chatsOf(alice.id)).toEqual(before);
    expect(await namedCrews(alice.id, "周报")).toHaveLength(1);
  });

  test("POST with 1 or 21 agentIds answers 400 and makes nothing", async () => {
    const alice = await person("alice");
    const api = crewApi();
    const ada = await bot(alice, "Ada");
    const many = Array.from({ length: 21 }, (_, n) => `${prefix}-nobody-${n}`);

    for (const agentIds of [[ada], [ada, ada], many]) {
      const answer = await api(alice, "POST", "/", {
        name: "太少或太多",
        agentIds,
      });
      expect(answer.status).toBe(400);
      expect(answer.json.error).toBe("一个群组要有 2 到 20 位员工。");
    }
    expect(await crewsOf(alice.id)).toEqual([]);
    expect(await chatsOf(alice.id)).toEqual([]);
  });

  test("POST whose chat cannot be made removes the crew it just made", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    // Bob's private Bot is one Alice cannot use.
    const ids = [await bot(alice, "Ada"), await bot(bob, "Linus")];

    const answer = await crewApi()(alice, "POST", "/", {
      name: "用不了的员工",
      agentIds: ids,
    });

    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await namedCrews(alice.id, "用不了的员工")).toEqual([]);
    expect(await chatsOf(alice.id)).toEqual([]);
  });

  test("POST whose adopt fails after the chat was made hides that chat and removes the crew", async () => {
    const alice = await person("alice");
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];

    const answer = await quietly(() =>
      crewApi({ link: broken() })(alice, "POST", "/", {
        name: "挂不上",
        agentIds: ids,
      }),
    );

    expect(answer.status).toBeGreaterThanOrEqual(400);
    const chats = await chatsOf(alice.id);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.deleted).toBe(true);
    expect(chats[0]?.waker_group_id).toBeNull();
    expect(await namedCrews(alice.id, "挂不上")).toEqual([]);
  });

  test("POST chat whose adopt fails hides the chat it made and keeps the crew unlinked", async () => {
    const alice = await person("alice");
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const made = await crewApi()(alice, "POST", "/", { name: "未开始" });
    const groupId = (made.json.group as Listed).id;
    await writeRoster(groupId, ids);

    const answer = await quietly(() =>
      crewApi({ link: broken() })(alice, "POST", `/${groupId}/chat`),
    );

    expect(answer.status).toBeGreaterThanOrEqual(400);
    const chats = await chatsOf(alice.id);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.deleted).toBe(true);
    expect(await listedBy(alice, groupId)).toEqual(
      expect.objectContaining({ id: groupId, channelId: null }),
    );
  });

  test("the list states chatStatus from usable members, not the row count", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const api = crewApi();
    const mine = [] as string[];
    for (let n = 0; n < 21; n++) mine.push(await bot(alice, `Bot${n}`));
    const theirs = [await bot(bob, "Linus"), await bot(bob, "Ken")];
    const crewNamed = async (name: string) =>
      ((await api(alice, "POST", "/", { name })).json.group as Listed).id;

    const pending = await crewNamed("待补成员");
    await writeRoster(pending, [mine[0] as string, ...theirs]);
    const tooMany = await crewNamed("太多");
    await writeRoster(tooMany, mine);
    const notStarted = await crewNamed("未开始");
    await writeRoster(notStarted, mine.slice(0, 2));
    const chatting = (
      (
        await api(alice, "POST", "/", {
          name: "可聊天",
          agentIds: mine.slice(0, 2),
        })
      ).json as unknown as Made
    ).group.id;

    const answer = await api(alice, "GET", "/");

    expect(answer.status).toBe(200);
    const groups = answer.json.groups as Listed[];
    const of = (id: string) => groups.find((group) => group.id === id);
    expect(of(pending)).toEqual(
      expect.objectContaining({
        usableMemberCount: 1,
        chatStatus: "pending_members",
        channelId: null,
      }),
    );
    expect(of(pending)?.members).toHaveLength(3);
    expect(of(tooMany)).toEqual(
      expect.objectContaining({
        usableMemberCount: 21,
        chatStatus: "too_many",
      }),
    );
    expect(of(notStarted)).toEqual(
      expect.objectContaining({
        usableMemberCount: 2,
        chatStatus: "not_started",
      }),
    );
    expect(of(chatting)).toEqual(
      expect.objectContaining({ usableMemberCount: 2, chatStatus: "chat" }),
    );
    expect(of(chatting)?.channelId).toBeString();
  });

  test("POST without agentIds is the old behaviour", async () => {
    const alice = await person("alice");
    const api = crewApi();

    const answer = await api(alice, "POST", "/", { name: "旧的建法" });

    expect(answer.status).toBe(201);
    expect("channel" in answer.json).toBe(false);
    const group = answer.json.group as Listed;
    expect(group.members).toEqual([]);
    expect(await chatsOf(alice.id)).toEqual([]);
    const listed = (await api(alice, "GET", "/")).json.groups as Listed[];
    expect(listed.find((item) => item.id === group.id)?.channelId).toBeNull();
  });

  test("PATCH renames both sides and refuses a taken name", async () => {
    const alice = await person("alice");
    const api = crewApi();
    const linked = (
      await api(alice, "POST", "/", {
        name: "原名",
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      })
    ).json as unknown as Made;
    const unlinked = (
      (await api(alice, "POST", "/", { name: "没聊天" })).json.group as Listed
    ).id;
    await api(alice, "POST", "/", { name: "已占用" });

    const renamed = await api(alice, "PATCH", `/${linked.group.id}`, {
      name: "新名字",
      description: "说明",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.group).toEqual(
      expect.objectContaining({
        id: linked.group.id,
        name: "新名字",
        description: "说明",
        channelId: linked.channel.id,
      }),
    );
    expect((await channelRow(linked.channel.id)).title).toBe("新名字");
    expect((await crewRow(linked.group.id))?.name).toBe("新名字");

    const taken = await api(alice, "PATCH", `/${linked.group.id}`, {
      name: "已占用",
    });
    expect(taken.status).toBe(409);
    expect((await channelRow(linked.channel.id)).title).toBe("新名字");
    expect((await crewRow(linked.group.id))?.name).toBe("新名字");

    for (const name of ["   ", "x".repeat(81)])
      expect(
        (await api(alice, "PATCH", `/${linked.group.id}`, { name })).status,
      ).toBe(400);

    const alone = await api(alice, "PATCH", `/${unlinked}`, {
      name: "还是没聊天",
    });
    expect(alone.status).toBe(200);
    expect((await crewRow(unlinked))?.name).toBe("还是没聊天");
    expect(
      (await chatsOf(alice.id)).filter(
        (chat) => chat.waker_group_id === unlinked,
      ),
    ).toEqual([]);
    expect(
      (await api(alice, "PATCH", `/${unlinked}`, { name: "已占用" })).status,
    ).toBe(409);
    expect((await crewRow(unlinked))?.name).toBe("还是没聊天");
  });

  test("POST chat opens a chat for a crew of 2–20 that has none, and refuses otherwise", async () => {
    const alice = await person("alice");
    const api = crewApi();
    const [ada, grace] = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const two = (
      (await api(alice, "POST", "/", { name: "两位" })).json.group as Listed
    ).id;
    await writeRoster(two, [grace, ada]);
    const one = (
      (await api(alice, "POST", "/", { name: "一位" })).json.group as Listed
    ).id;
    await writeRoster(one, [ada]);

    const opened = await api(alice, "POST", `/${two}/chat`);
    expect(opened.status).toBe(201);
    const { group, channel } = opened.json as unknown as Made;
    expect(group.channelId).toBe(channel.id);
    expect(channel.wakerGroupId).toBe(two);
    expect((await channelRow(channel.id)).title).toBe("两位");
    expect(
      await runAsTenant(alice.id, () => groupStore.order(channel.id)),
    ).toEqual([grace, ada]);

    const again = await api(alice, "POST", `/${two}/chat`);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("这个群组已经可以聊天了。");

    const short = await api(alice, "POST", `/${one}/chat`);
    expect(short.status).toBe(409);
    expect(short.json.error).toBe("一个群组要有 2 到 20 位员工。");
    expect(
      (await chatsOf(alice.id)).filter((chat) => !chat.deleted),
    ).toHaveLength(1);
  });

  test("for-channel links an unlinked channel for its creator, and a second call changes nothing", async () => {
    const alice = await person("alice");
    const api = crewApi();
    const made = (
      await api(alice, "POST", "/", {
        name: "旧群聊",
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      })
    ).json as unknown as Made;
    await unlink(made.channel.id);
    const before = (await crewsOf(alice.id)).length;

    const first = await api(alice, "POST", `/for-channel/${made.channel.id}`);
    expect(first.status).toBe(200);
    const group = first.json.group as Listed;
    expect(group.id).not.toBe(made.group.id);
    expect(group.channelId).toBe(made.channel.id);
    expect((await channelRow(made.channel.id)).waker_group_id).toBe(group.id);
    expect(group.members.map((member) => member.agentId)).toEqual(
      made.group.members.map((member) => member.agentId),
    );
    expect(await crewsOf(alice.id)).toHaveLength(before + 1);

    const second = await api(alice, "POST", `/for-channel/${made.channel.id}`);
    expect(second.status).toBe(200);
    expect((second.json.group as Listed).id).toBe(group.id);
    expect(await crewsOf(alice.id)).toHaveLength(before + 1);
  });

  test("for-channel answers 403 to a member who is not the creator and 404 to a stranger", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const api = crewApi();
    const groups = conversations();
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const linked = (
      await api(alice, "POST", "/", { name: "挂着的", agentIds: ids })
    ).json as unknown as Made;
    const loose = (
      await api(alice, "POST", "/", { name: "没挂的", agentIds: ids })
    ).json as unknown as Made;
    await unlink(loose.channel.id);
    for (const channelId of [linked.channel.id, loose.channel.id])
      await runAsTenant(alice.id, () =>
        groups.addMember(alice.id, channelId, {
          email: `${bob.id}@example.test`,
        }),
      );
    const before = await crewsOf(alice.id);

    for (const channelId of [linked.channel.id, loose.channel.id]) {
      const member = await api(bob, "POST", `/for-channel/${channelId}`);
      expect(member.status).toBe(403);
      expect(member.json).toEqual({ error: "只有发起人能调整这个群组。" });

      const stranger = await api(carol, "POST", `/for-channel/${channelId}`);
      expect(stranger.status).toBe(404);
      expect(stranger.text).not.toContain(linked.group.id);
    }
    expect(
      (await api(carol, "POST", `/for-channel/${prefix}-no-such-channel`))
        .status,
    ).toBe(404);
    // Neither asking linked anything, made a crew, or said which crew a conversation has.
    expect((await channelRow(loose.channel.id)).waker_group_id).toBeNull();
    expect(await crewsOf(alice.id)).toEqual(before);
    expect(await crewsOf(bob.id)).toEqual([]);
    expect(await crewsOf(carol.id)).toEqual([]);
  });

  test("another tenant gets 404 from PATCH and chat", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const api = crewApi();
    const groupId = (
      (await api(alice, "POST", "/", { name: "爱丽丝的" })).json.group as Listed
    ).id;
    await writeRoster(groupId, [
      await bot(alice, "Ada"),
      await bot(alice, "Grace"),
    ]);

    const renamed = await api(bob, "PATCH", `/${groupId}`, { name: "鲍勃的" });
    expect(renamed.status).toBe(404);
    expect((await api(bob, "POST", `/${groupId}/chat`)).status).toBe(404);
    expect((await api(bob, "PATCH", "/not-a-uuid", { name: "x" })).status).toBe(
      404,
    );
    expect((await api(bob, "POST", "/not-a-uuid/chat")).status).toBe(404);

    expect(await crewRow(groupId)).toEqual({
      name: "爱丽丝的",
      tenantId: alice.id,
    });
    expect(await chatsOf(bob.id)).toEqual([]);
    expect(await chatsOf(alice.id)).toEqual([]);
  });

  test("a creator who has left their chat cannot open a second one for its crew, and is told why", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const api = crewApi();
    const made = (
      await api(alice, "POST", "/", {
        name: "离开的群",
        agentIds: [await bot(alice, "Ada"), await bot(alice, "Grace")],
      })
    ).json as unknown as Made;
    await runAsTenant(alice.id, () =>
      conversations().addMember(alice.id, made.channel.id, {
        email: `${bob.id}@example.test`,
      }),
    );
    // As in the decorator tests: row security lets her delete her own membership.
    await runAsTenant(alice.id, () =>
      groupStore.removeMember(made.channel.id, alice.id),
    );
    // To her the crew now reads as having no chat, with two Bots: "not started".
    const listed = (await api(alice, "GET", "/")).json.groups as Listed[];
    expect(listed.find((group) => group.id === made.group.id)).toEqual(
      expect.objectContaining({ channelId: null, chatStatus: "not_started" }),
    );

    const answer = await api(alice, "POST", `/${made.group.id}/chat`);

    expect(answer.status).toBe(409);
    expect(answer.json.code).toBe("waker-group-owner-gone");
    expect((await channelRow(made.channel.id)).waker_group_id).toBe(
      made.group.id,
    );
    const others = (await chatsOf(alice.id)).filter(
      (chat) => chat.id !== made.channel.id,
    );
    expect(others).toHaveLength(1);
    expect(others[0]?.deleted).toBe(true);
    expect(
      (await api(alice, "POST", `/for-channel/${made.channel.id}`)).status,
    ).toBe(404);
  });
});
