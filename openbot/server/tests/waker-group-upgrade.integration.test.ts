import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createGroupConversations,
  createGroupStore,
  type GroupConversations,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  groupTaskTemplates,
  intelligenceChannelMappings,
  portraits,
  users,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import {
  createWakerGroupLink,
  stateOf,
} from "../src/waker-groups/channel-link";
import {
  convertGroups,
  type GroupUpgradeDeps,
  textArray,
} from "../src/waker-groups/upgrade";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The upgrade that turns crews into chats and gives old chats a crew (spec 2026-11-13 group-unify,
 * section 5; migrations 0210, 0211).
 *
 * Its ledger, `waker_group_upgrades`, is one row per crew the upgrade touched: what it did, the chat
 * it made or linked, the coworkers it left out. It is the owner's row like any tenant row (0072's
 * four policies, FORCE), it goes with the crew when the crew is deleted, and it follows the crew to
 * the heir when a shared group is handed over, while `original_owner` keeps who it was written for
 * (the rollback runbook leaves alone a converted crew that has changed hands). The app may never
 * change `original_owner` once written (0211).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const groupStore = createGroupStore(database, () => threadIdentity.mint());
const prefix = `wgup-${randomUUID()}`;
const DEV_USER = "dev-local-user";
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
    // Every chat here is made through `conversations()`, which writes its id down.
    const channelIds = createdChannels.splice(0);
    if (channelIds.length) {
      await database
        .delete(intelligenceChannelMappings)
        .where(inArray(intelligenceChannelMappings.channelId, channelIds));
      await database.execute(
        sql`delete from channels where id in ${channelIds}`,
      );
    }
    const groupIds = createdGroups.splice(0);
    if (groupIds.length) {
      await database
        .delete(portraits)
        .where(inArray(portraits.subjectId, groupIds));
      // The ledger rows, members and templates go with their crews.
      await database
        .delete(wakerGroups)
        .where(inArray(wakerGroups.id, groupIds));
    }
    const userIds = createdUsers.splice(0);
    if (userIds.length)
      await database
        .delete(wakerGroups)
        .where(inArray(wakerGroups.tenantId, userIds));
    if (createdAgents.length) {
      const ids = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    if (userIds.length)
      await database.delete(users).where(inArray(users.id, userIds));
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(name: string) {
  const id = `${prefix}-${name}-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Upgrade" }),
  );
  createdUsers.push(id);
  return id;
}

async function crew(owner: string, name: string) {
  const [row] = await runAsTenant(owner, () =>
    database
      .insert(wakerGroups)
      .values({ name })
      .returning({ id: wakerGroups.id }),
  );
  if (!row) throw new Error("crew not written");
  createdGroups.push(row.id);
  return row.id;
}

/** A ledger row written in `frame`, stamped for `tenant`. */
function record(
  frame: string,
  groupId: string,
  tenant: string,
  outcome = "converted",
) {
  return runAsTenant(frame, () =>
    database.execute(
      sql`insert into waker_group_upgrades (group_id, tenant_id, original_owner, outcome)
          values (${groupId}::uuid, ${tenant}, ${tenant}, ${outcome})`,
    ),
  );
}

/** The ledger rows of `groupIds` that `frame` can see. */
async function ledger(frame: string, groupIds: string[]) {
  return (await runAsTenant(frame, () =>
    database.execute(
      sql`select group_id::text as group_id, tenant_id, original_owner
            from waker_group_upgrades where group_id::text in ${groupIds}
           order by tenant_id`,
    ),
  )) as unknown as {
    group_id: string;
    tenant_id: string;
    original_owner: string;
  }[];
}

/** The SQLSTATE a write threw. */
async function refusal(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return stateOf(error);
  }
  throw new Error("expected a refusal");
}

/** What the database said, under drizzle's "Failed query" wrapper. */
function reason(error: unknown) {
  return String((error as { cause?: Error }).cause?.message ?? error);
}

describe("ledger", () => {
  test("the journal registers 0210 after 0209", async () => {
    const journal = (await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/meta/_journal.json",
        import.meta.url,
      ),
    ).json()) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const previous = journal.entries.find((item) => item.idx === 209);
    const entry = journal.entries.find((item) => item.idx === 210);
    expect(previous?.tag).toBe("0209_channel_kind");
    expect(entry?.tag).toBe("0210_waker_group_upgrades");
    expect(entry?.when ?? 0).toBeGreaterThan(previous?.when ?? Infinity);
  });

  test("a tenant reads and writes only its own ledger rows; platform reads all", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ours = await crew(alice, "周报");
    const another = await crew(alice, "复盘");
    const theirs = await crew(bob, "周报");

    await record(alice, ours, alice);
    expect(await refusal(() => record(alice, another, bob))).toBe("42501");
    await record(bob, theirs, bob);

    const all = [ours, another, theirs];
    expect((await ledger(alice, all)).map((row) => row.group_id)).toEqual([
      ours,
    ]);
    expect((await ledger(bob, all)).map((row) => row.group_id)).toEqual([
      theirs,
    ]);
    expect(
      (await ledger("platform", all)).map((row) => row.group_id).sort(),
    ).toEqual([ours, theirs].sort());

    // Bob can neither change nor delete Alice's row: to him it is not there.
    await runAsTenant(bob, async () => {
      await database.execute(
        sql`update waker_group_upgrades set outcome = 'no_owner' where group_id = ${ours}::uuid`,
      );
      await database.execute(
        sql`delete from waker_group_upgrades where group_id = ${ours}::uuid`,
      );
    });
    const [kept] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select outcome from waker_group_upgrades where group_id = ${ours}::uuid`,
      ),
    )) as unknown as { outcome: string }[];
    expect(kept?.outcome).toBe("converted");
  });

  test("the journal registers 0211 after 0210", async () => {
    const journal = (await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/meta/_journal.json",
        import.meta.url,
      ),
    ).json()) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const previous = journal.entries.find((item) => item.idx === 210);
    const entry = journal.entries.find((item) => item.idx === 211);
    expect(entry?.tag).toBe("0211_waker_group_upgrades_original_owner");
    expect(entry?.when ?? 0).toBeGreaterThan(previous?.when ?? Infinity);
  });

  test("a tenant cannot hand its own ledger row to another tenant", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ours = await crew(alice, "周报");
    await record(alice, ours, alice);

    // WITH CHECK, the half of the update policy the cross-tenant test above does not reach.
    const refused = await runAsTenant(alice, () =>
      database.execute(
        sql`update waker_group_upgrades set tenant_id = ${bob} where group_id = ${ours}::uuid`,
      ),
    ).catch((error: unknown) => error);
    expect(stateOf(refused)).toBe("42501");
    expect(reason(refused)).toContain("row-level security");
    expect(await ledger("platform", [ours])).toEqual([
      { group_id: ours, tenant_id: alice, original_owner: alice },
    ]);
  });

  test("every outcome the upgrade writes is accepted", async () => {
    const alice = await person("alice");
    const outcomes = [
      "started",
      "converted",
      "backfilled",
      "pending_members",
      "too_many",
      "no_owner",
    ];
    const ids: string[] = [];
    for (const outcome of outcomes) {
      const id = await crew(alice, `台账 ${outcome}`);
      await record(alice, id, alice, outcome);
      ids.push(id);
    }

    const rows = (await runAsTenant(alice, () =>
      database.execute(
        sql`select outcome from waker_group_upgrades where group_id::text in ${ids}`,
      ),
    )) as unknown as { outcome: string }[];
    expect(rows.map((row) => row.outcome).sort()).toEqual([...outcomes].sort());
  });

  test("original_owner keeps the value it was first written with", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ours = await crew(alice, "周报");
    await record(alice, ours, alice);

    // Not even the platform frame may change it: the app has no UPDATE on the column (0211).
    for (const frame of [alice, "platform"]) {
      const refused = await runAsTenant(frame, () =>
        database.execute(
          sql`update waker_group_upgrades set original_owner = ${bob} where group_id = ${ours}::uuid`,
        ),
      ).catch((error: unknown) => error);
      expect(stateOf(refused)).toBe("42501");
      expect(reason(refused)).toContain("permission denied");
    }
    // Every other column the upgrade moves stays writable.
    await runAsTenant("platform", () =>
      database.execute(
        sql`update waker_group_upgrades
               set outcome = 'started', channel_id = 'c', dropped_agent_ids = '{a}',
                   started_at = now(), updated_at = now(), tenant_id = ${bob}
             where group_id = ${ours}::uuid`,
      ),
    );
    expect(await ledger("platform", [ours])).toEqual([
      { group_id: ours, tenant_id: bob, original_owner: alice },
    ]);
  });

  test("an unknown outcome is refused", async () => {
    const alice = await person("alice");
    const ours = await crew(alice, "周报");

    expect(await refusal(() => record(alice, ours, alice, "done"))).toBe(
      "23514",
    );
  });

  test("deleting the crew deletes its ledger row", async () => {
    const alice = await person("alice");
    const ours = await crew(alice, "周报");
    await record(alice, ours, alice);

    await runAsTenant(alice, () =>
      database.execute(sql`delete from waker_groups where id = ${ours}::uuid`),
    );

    expect(await ledger("platform", [ours])).toEqual([]);
  });

  test("a hand-over moves the crew's ledger row too", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const ours = await crew(alice, "周报");
    const untouched = await crew(alice, "复盘");
    await record(alice, ours, alice);
    await record(alice, untouched, alice);
    // A shared group Alice started and has left past the service; Bob is still in it.
    const channelId = `channel_${randomUUID()}`;
    createdChannels.push(channelId);
    await runAsTenant("platform", async () => {
      await database.execute(
        sql`insert into channels (id, name, description, tenant_id, created_by, title, waker_group_id)
            values (${channelId}, '员工甲、员工乙', '', 'team', ${alice}, '周报', ${ours}::uuid)`,
      );
      await database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id)
            values (${channelId}, ${bob}, 'team'), (${channelId}, ${carol}, 'team')`,
      );
    });

    const [handed] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select public.xiongbao_team_channel_hand_over(${channelId}) as owner`,
      ),
    )) as unknown as { owner: string | null }[];
    expect(handed?.owner).toBe(bob);

    expect(await ledger("platform", [ours])).toEqual([
      { group_id: ours, tenant_id: bob, original_owner: alice },
    ]);
    expect(await ledger(bob, [ours])).toHaveLength(1);
    expect(await ledger(alice, [ours])).toEqual([]);
    // Only the crew that went: Alice's other row stays hers.
    expect(await ledger("platform", [untouched])).toEqual([
      { group_id: untouched, tenant_id: alice, original_owner: alice },
    ]);
  });
});

/** What the groups service is in production (index.ts), minus the turns: no Bot answers here. */
function conversations(): GroupConversations {
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
    canUseBot: canUse,
    progressEveryMs: 0,
  });
}

/** The groups service's `canUseBot` as index.ts writes it: the owner can read the Bot's profile. */
async function canUse(ownerUserId: string, agentId: string) {
  return Boolean(
    await profileStore.get({ id: ownerUserId, role: "user" }, agentId),
  );
}

/** What the boot task is given in production, with the log kept for the test to read. */
function upgrade(
  options: {
    groups?: Pick<GroupConversations, "create">;
    log?: Record<string, unknown>[];
  } = {},
): GroupUpgradeDeps {
  const log = options.log ?? [];
  return {
    database,
    groups: options.groups ?? conversations(),
    link: createWakerGroupLink({
      database,
      groupStore,
      log: (line) => log.push(line),
    }),
    canUse,
    log: (line) => log.push(line),
  };
}

async function bot(owner: string, name: string) {
  const profile = await runAsTenant(owner, () =>
    profileStore.create(
      { id: owner, role: "user" },
      {
        name,
        title: "Tester",
        roleDescription: "Answer briefly.",
        visibility: "private",
      },
    ),
  );
  createdAgents.push(profile.id);
  return profile.id;
}

async function bots(owner: string, count: number) {
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) ids.push(await bot(owner, `员工${n}`));
  return ids;
}

/**
 * A crew as the old crew pages left one: written by `tenant` (a person, `system`, or someone since
 * deleted), its roster at the given positions — by default 0, 1, 2… in the order given.
 */
async function oldCrew(
  tenant: string,
  name: string,
  agentIds: string[],
  positions: string[] = agentIds.map((_, at) => String(at)),
) {
  const [row] = await runAsTenant("platform", async () => {
    const written = await database
      .insert(wakerGroups)
      .values({ tenantId: tenant, name })
      .returning({ id: wakerGroups.id });
    const id = written[0]?.id;
    if (id && agentIds.length)
      await database.insert(wakerGroupMembers).values(
        agentIds.map((agentId, at) => ({
          groupId: id,
          agentId,
          position: positions[at] ?? String(at),
        })),
      );
    return written;
  });
  if (!row) throw new Error("crew not written");
  createdGroups.push(row.id);
  return row.id;
}

type LedgerRow = {
  tenant_id: string;
  original_owner: string;
  channel_id: string | null;
  outcome: string;
  dropped_agent_ids: string[];
};

async function ledgerOf(groupId: string): Promise<LedgerRow | null> {
  const [row] = (await runAsTenant("platform", () =>
    database.execute(
      sql`select tenant_id, original_owner, channel_id, outcome, dropped_agent_ids
            from waker_group_upgrades where group_id = ${groupId}::uuid`,
    ),
  )) as unknown as LedgerRow[];
  return row ?? null;
}

/** A ledger row as a crash would leave one, written as `platform` the way the task writes it. */
async function started(
  groupId: string,
  owner: string,
  options: { channelId?: string; dropped?: string[]; originalOwner?: string },
) {
  await runAsTenant("platform", () =>
    database.execute(
      sql`insert into waker_group_upgrades
            (group_id, tenant_id, original_owner, channel_id, outcome, dropped_agent_ids)
          values (${groupId}::uuid, ${owner}, ${options.originalOwner ?? owner},
                  ${options.channelId ?? null}, 'started', ${textArray(options.dropped ?? [])})`,
    ),
  );
}

type ChatRow = {
  id: string;
  tenant_id: string;
  created_by: string | null;
  title: string | null;
  waker_group_id: string | null;
  deleted: boolean;
};

/** Every chat `owner` started, oldest first, as `platform` reads them. */
async function chatsOf(owner: string): Promise<ChatRow[]> {
  return (await runAsTenant("platform", () =>
    database.execute(
      sql`select id, tenant_id, created_by, title, waker_group_id::text as waker_group_id,
                 deleted_at is not null as deleted
            from channels where created_by = ${owner}
           order by created_at, id`,
    ),
  )) as unknown as ChatRow[];
}

async function membersOf(groupId: string) {
  const rows = await runAsTenant("platform", () =>
    database
      .select({ agentId: wakerGroupMembers.agentId })
      .from(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, groupId))
      .orderBy(asc(sql`${wakerGroupMembers.position}::int`)),
  );
  return rows.map((row) => row.agentId);
}

/** A group chat `owner` opened through the groups service, outside the upgrade. */
async function openChat(owner: string, agentIds: string[]) {
  return runAsTenant(owner, () => conversations().create(owner, { agentIds }));
}

async function totals() {
  const [row] = (await runAsTenant("platform", () =>
    database.execute(
      sql`select (select count(*)::int from channels) as channels,
                 (select count(*)::int from waker_groups) as crews,
                 (select count(*)::int from waker_group_upgrades) as ledger`,
    ),
  )) as unknown as { channels: number; crews: number; ledger: number }[];
  return row;
}

describe("phase 1", () => {
  test("rule 1: a WakerFlow crew is left alone and not recorded", async () => {
    const alice = await person("alice");
    const flowCrew = await oldCrew(alice, "流程群组", await bots(alice, 2));
    const [flow] = await runAsTenant(alice, () =>
      database
        .insert(wakerFlows)
        .values({ name: "流程", revision: 1, groupId: flowCrew })
        .returning({ id: wakerFlows.id }),
    );
    if (!flow) throw new Error("flow not written");
    createdFlows.push(flow.id);

    await convertGroups(upgrade());

    expect(await ledgerOf(flowCrew)).toBeNull();
    expect(await chatsOf(alice)).toEqual([]);
  });

  test("rule 2: a crew already linked is skipped", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const linked = await oldCrew(alice, "已挂接", ids);
    const chat = await openChat(alice, ids);
    await upgrade().link.adopt(linked, chat.id);

    await convertGroups(upgrade());

    expect(await ledgerOf(linked)).toBeNull();
    expect((await chatsOf(alice)).map((row) => row.id)).toEqual([chat.id]);
  });

  test("a crew whose chat was deleted is not given a new one", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const left = await oldCrew(alice, "聊天已删", ids);
    const chat = await openChat(alice, ids);
    await upgrade().link.adopt(left, chat.id);
    // The last person left (Q6): the chat is hidden and the crew stays, not started.
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set deleted_at = now() where id = ${chat.id}`,
      ),
    );

    await convertGroups(upgrade());

    expect(await ledgerOf(left)).toBeNull();
    expect((await chatsOf(alice)).map((row) => row.id)).toEqual([chat.id]);
  });

  test("rule 3: a crew whose owner is gone or reserved is kept as no_owner", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const reserved = await oldCrew("system", `${prefix} 平台群组`, ids);
    const ghost = `${prefix}-ghost-${randomUUID()}`;
    const orphaned = await oldCrew(ghost, "人已删除", ids);
    const before = await totals();

    const counts = await convertGroups(upgrade());

    expect(await ledgerOf(reserved)).toEqual({
      tenant_id: "system",
      original_owner: "system",
      channel_id: null,
      outcome: "no_owner",
      dropped_agent_ids: [],
    });
    expect(await ledgerOf(orphaned)).toMatchObject({
      tenant_id: ghost,
      original_owner: ghost,
      outcome: "no_owner",
    });
    expect(counts.noOwner).toBeGreaterThanOrEqual(2);
    expect((await totals())?.channels).toBe(before?.channels);
    expect(await membersOf(reserved)).toEqual(ids);
  });

  test("rule 4: fewer than two usable coworkers keeps the crew as pending_members, members untouched", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const own = await bot(alice, "Ada");
    const notHers = await bots(bob, 2);
    const pending = await oldCrew(alice, "待补成员", [own, ...notHers]);

    const counts = await convertGroups(upgrade());

    expect(await ledgerOf(pending)).toEqual({
      tenant_id: alice,
      original_owner: alice,
      channel_id: null,
      outcome: "pending_members",
      dropped_agent_ids: [],
    });
    expect(counts.pending).toBeGreaterThanOrEqual(1);
    expect(await membersOf(pending)).toEqual([own, ...notHers]);
    expect(await chatsOf(alice)).toEqual([]);
  });

  test("rule 5: more than twenty is too_many and nothing is cut", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 21);
    const crowded = await oldCrew(alice, "人太多", ids);

    const counts = await convertGroups(upgrade());

    expect(await ledgerOf(crowded)).toMatchObject({
      tenant_id: alice,
      original_owner: alice,
      channel_id: null,
      outcome: "too_many",
    });
    expect(counts.tooMany).toBeGreaterThanOrEqual(1);
    expect(await membersOf(crowded)).toEqual(ids);
    expect(await chatsOf(alice)).toEqual([]);
  });

  test("rule 6: two to twenty becomes a chat with the same name, order, portrait and flows", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const [ada, grace] = await bots(alice, 2);
    const notHers = await bot(bob, "Linus");
    if (!ada || !grace) throw new Error("bots not written");
    // Positions say Grace, then Bob's Bot, then Ada; written in another order on purpose.
    const groupId = await oldCrew(
      alice,
      "周报",
      [ada, notHers, grace],
      ["2", "1", "0"],
    );
    await runAsTenant(alice, async () => {
      await database
        .insert(portraits)
        .values({ subjectKind: "group", subjectId: groupId, preset: "cute" });
      await database
        .insert(groupTaskTemplates)
        .values({ groupId, name: "周报流程", steps: [] });
    });

    const counts = await convertGroups(upgrade());

    expect(counts.converted).toBeGreaterThanOrEqual(1);
    const [chat, ...more] = await chatsOf(alice);
    expect(more).toEqual([]);
    expect(chat).toMatchObject({
      tenant_id: "team",
      created_by: alice,
      title: "周报",
      waker_group_id: groupId,
      deleted: false,
    });
    if (!chat) throw new Error("no chat");
    expect(await ledgerOf(groupId)).toEqual({
      tenant_id: alice,
      original_owner: alice,
      channel_id: chat.id,
      outcome: "converted",
      dropped_agent_ids: [notHers],
    });
    expect(await runAsTenant(alice, () => groupStore.order(chat.id))).toEqual([
      grace,
      ada,
    ]);
    // The crew is the same row: its portrait and flow are still keyed by its id.
    expect(await membersOf(groupId)).toEqual([grace, ada]);
    const kept = await runAsTenant("platform", async () => ({
      crews: await database
        .select({ name: wakerGroups.name })
        .from(wakerGroups)
        .where(eq(wakerGroups.id, groupId)),
      pictures: await database
        .select({ preset: portraits.preset })
        .from(portraits)
        .where(eq(portraits.subjectId, groupId)),
      templates: await database
        .select({ name: groupTaskTemplates.name })
        .from(groupTaskTemplates)
        .where(eq(groupTaskTemplates.groupId, groupId)),
    }));
    expect(kept).toEqual({
      crews: [{ name: "周报" }],
      pictures: [{ preset: "cute" }],
      templates: [{ name: "周报流程" }],
    });
  });

  test("the single-user owner dev-local-user is converted the same way", async () => {
    const existed = await runAsTenant("platform", () =>
      database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, DEV_USER)),
    );
    if (existed.length === 0) {
      await runAsTenant(DEV_USER, () =>
        database.insert(users).values({
          id: DEV_USER,
          email: "dev-local-user@example.test",
          name: "Local",
        }),
      );
      createdUsers.push(DEV_USER);
    }
    const ids = await bots(DEV_USER, 2);
    const groupId = await oldCrew(DEV_USER, `${prefix} 单用户`, ids);

    await convertGroups(upgrade());

    const ledger = await ledgerOf(groupId);
    expect(ledger).toMatchObject({
      tenant_id: DEV_USER,
      original_owner: DEV_USER,
      outcome: "converted",
    });
    const chat = (await chatsOf(DEV_USER)).find(
      (row) => row.id === ledger?.channel_id,
    );
    expect(chat).toMatchObject({
      tenant_id: "team",
      created_by: DEV_USER,
      title: `${prefix} 单用户`,
      waker_group_id: groupId,
    });
  });

  test("the second run changes nothing", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ids = await bots(alice, 2);
    await oldCrew(alice, "周报", ids);
    await oldCrew(alice, "待补成员", [ids[0] ?? "", await bot(bob, "Linus")]);
    await oldCrew("system", `${prefix} 平台群组`, ids);

    const first = await convertGroups(upgrade());
    expect(first.converted).toBeGreaterThanOrEqual(1);
    const before = await totals();

    expect(await convertGroups(upgrade())).toEqual({
      converted: 0,
      pending: 0,
      tooMany: 0,
      noOwner: 0,
    });
    expect(await totals()).toEqual(before);
  });

  test("a started orphan is adopted, not rebuilt", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const [ada, grace] = await bots(alice, 2);
    const notHers = await bot(bob, "Linus");
    if (!ada || !grace) throw new Error("bots not written");
    const groupId = await oldCrew(alice, "周报", [ada, notHers, grace]);
    // Same Bots, but opened before the conversion started: not the orphan.
    const earlier = await openChat(alice, [ada, grace]);
    await Bun.sleep(5);
    await started(groupId, alice, { dropped: [notHers] });
    // The crash came between opening the chat (②) and writing its id down (③).
    const orphan = await openChat(alice, [ada, grace]);

    await convertGroups(upgrade());

    expect(await ledgerOf(groupId)).toEqual({
      tenant_id: alice,
      original_owner: alice,
      channel_id: orphan.id,
      outcome: "converted",
      dropped_agent_ids: [notHers],
    });
    const chats = await chatsOf(alice);
    expect(chats.map((row) => row.id)).toEqual([earlier.id, orphan.id]);
    expect(chats.map((row) => row.waker_group_id)).toEqual([null, groupId]);
    expect(chats[1]?.title).toBe("周报");
  });

  test("a started row with its chat written down goes on from linking", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const unlinked = await oldCrew(alice, "周报", ids);
    const linked = await oldCrew(alice, "复盘", ids);
    // Crashed after ③: the chat is recorded, not yet linked.
    const first = await openChat(alice, ids);
    await started(unlinked, alice, { channelId: first.id });
    // Crashed after ④: the chat is recorded and linked, the ledger not yet converted.
    const second = await openChat(alice, ids);
    await started(linked, alice, { channelId: second.id });
    await upgrade().link.adopt(linked, second.id);

    await convertGroups(upgrade());

    expect(await ledgerOf(unlinked)).toMatchObject({
      channel_id: first.id,
      outcome: "converted",
    });
    expect(await ledgerOf(linked)).toMatchObject({
      channel_id: second.id,
      outcome: "converted",
    });
    const chats = await chatsOf(alice);
    expect(chats.map((row) => [row.id, row.waker_group_id, row.title])).toEqual(
      [
        [first.id, unlinked, "周报"],
        [second.id, linked, "复盘"],
      ],
    );
  });

  test("a started row with no orphan is rebuilt", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    // Who it was first written for stays, whatever the rebuild writes.
    await started(groupId, alice, { originalOwner: `${prefix}-first` });
    // Not an orphan: one Bot short of the crew.
    const other = await openChat(alice, [...ids, await bot(alice, "Linus")]);

    await convertGroups(upgrade());

    const ledger = await ledgerOf(groupId);
    expect(ledger).toMatchObject({
      tenant_id: alice,
      original_owner: `${prefix}-first`,
      outcome: "converted",
      dropped_agent_ids: [],
    });
    const chats = await chatsOf(alice);
    expect(chats).toHaveLength(2);
    expect(ledger?.channel_id).not.toBe(other.id);
    expect(chats.find((row) => row.id === ledger?.channel_id)).toMatchObject({
      waker_group_id: groupId,
      title: "周报",
    });
  });

  test("a crew whose chat cannot be made is logged and the rest go on", async () => {
    const alice = await person("alice");
    const [ada, grace, linus] = await bots(alice, 3);
    if (!ada || !grace || !linus) throw new Error("bots not written");
    const broken = await oldCrew(alice, "建不出来", [ada, linus]);
    const fine = await oldCrew(alice, "周报", [ada, grace]);
    const base = conversations();
    const log: Record<string, unknown>[] = [];

    await convertGroups(
      upgrade({
        log,
        groups: {
          create: async (owner, input) => {
            const { agentIds } = input as { agentIds: string[] };
            if (agentIds.includes(linus)) throw new Error("no chat today");
            return base.create(owner, input);
          },
        },
      }),
    );

    expect(log).toContainEqual({
      type: "waker-group-upgrade-item-failed",
      groupId: broken,
      error: "no chat today",
    });
    expect(await ledgerOf(fine)).toMatchObject({ outcome: "converted" });
    // Left started, for the next boot to rebuild.
    expect(await ledgerOf(broken)).toMatchObject({
      outcome: "started",
      channel_id: null,
    });
    expect((await chatsOf(alice)).map((row) => row.waker_group_id)).toEqual([
      fine,
    ]);

    await convertGroups(upgrade());
    expect(await ledgerOf(broken)).toMatchObject({ outcome: "converted" });
  });

  test("a same-titled old chat is left alone", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const old = await openChat(alice, ids);
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set title = '复盘' where id = ${old.id}`,
      ),
    );
    const groupId = await oldCrew(alice, "复盘", ids);

    await convertGroups(upgrade());

    const chats = await chatsOf(alice);
    expect(
      chats.map((row) => [row.id === old.id, row.title, row.waker_group_id]),
    ).toEqual([
      [true, "复盘", null],
      [false, "复盘", groupId],
    ]);
    expect(chats.every((row) => !row.deleted)).toBe(true);
  });
});
