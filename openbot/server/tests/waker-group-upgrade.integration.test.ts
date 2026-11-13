import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRoleRepository } from "../src/auth/guards";
import { createRoleOf } from "../src/auth/role-of";
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
  channelAgents,
  deploymentPackages,
  groupMessages,
  groupTaskRuns,
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
  runtimeOrder,
  stateOf,
  type WakerGroupLink,
  withWakerGroupLink,
} from "../src/waker-groups/channel-link";
import {
  type ConversionClaims,
  createWakerGroupActions,
} from "../src/waker-groups/linked-actions";
import { createWakerGroupRoutes } from "../src/waker-groups/routes";
import { createWakerGroupStore } from "../src/waker-groups/store";
import {
  backfillChannels,
  convertGroups,
  createConversionClaims,
  type GroupUpgradeDeps,
  reconcileLinked,
  runGroupUpgrade,
  startGroupUpgrade,
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
    groups?: GroupUpgradeDeps["groups"];
    link?: WakerGroupLink;
    log?: Record<string, unknown>[];
    canUse?: GroupUpgradeDeps["canUse"];
    hasRole?: GroupUpgradeDeps["hasRole"];
  } = {},
): GroupUpgradeDeps {
  const log = options.log ?? [];
  return {
    database,
    groups: options.groups ?? conversations(),
    link: options.link ?? linkFor(log),
    canUse: options.canUse ?? canUse,
    // Every person here holds the `user` role, as `canUse` above assumes.
    hasRole: options.hasRole ?? (async () => true),
    log: (line) => log.push(line),
  };
}

function linkFor(log: Record<string, unknown>[] = []) {
  return createWakerGroupLink({
    database,
    groupStore,
    log: (line) => log.push(line),
  });
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
    // Not an orphan: one Bot more than the crew.
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
          store: base.store,
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

/** `work` while the channel is stamped as an installed package's (`channels.package_id`). */
async function withPackage(channelId: string, work: () => Promise<void>) {
  const [installed] = await runAsTenant("platform", () =>
    database
      .insert(deploymentPackages)
      .values({
        tenantId: `${prefix}-pkg-${randomUUID()}`,
        sourcePath: "test",
        checksum: "test",
      })
      .returning({ id: deploymentPackages.id }),
  );
  if (!installed) throw new Error("package not written");
  await runAsTenant("platform", () =>
    database.execute(
      sql`update channels set package_id = ${installed.id}::uuid, kind = 'team' where id = ${channelId}`,
    ),
  );
  try {
    await work();
  } finally {
    await runAsTenant("platform", async () => {
      await database.execute(
        sql`update channels set package_id = null where id = ${channelId}`,
      );
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, installed.id));
    });
  }
}

/** A shared group chat `owner` opened with no order seeded: a crash between upstream's two writes. */
async function unseededChat(owner: string, agentIds: string[]) {
  const channel = await runAsTenant(owner, () =>
    channelStore.create({ id: owner, role: "user" }, agentIds, {
      shared: true,
    }),
  );
  createdChannels.push(channel.id);
  return channel;
}

/** Two Bots of `owner`'s, the first sorting after the second by id: an order only a seed keeps. */
async function twoOutOfIdOrder(owner: string) {
  const [one, two] = await bots(owner, 2);
  if (!one || !two) throw new Error("bots not written");
  return one.localeCompare(two) > 0 ? [one, two] : [two, one];
}

/** The answering order of a chat, as `platform` reads it. */
async function orderOf(channelId: string) {
  return runAsTenant("platform", () => groupStore.order(channelId));
}

async function hide(channelId: string) {
  await runAsTenant("platform", () =>
    database.execute(
      sql`update channels set deleted_at = now() where id = ${channelId}`,
    ),
  );
}

/** A reply in the chat, the way a Bot's answer lands. */
async function say(owner: string, channelId: string) {
  await runAsTenant("platform", () =>
    database.insert(groupMessages).values({
      id: `${prefix}-${randomUUID()}`,
      channelId,
      ownerUserId: owner,
      text: "已经聊过",
      tenantId: "team",
    }),
  );
}

async function devUser() {
  const existed = await runAsTenant("platform", () =>
    database.select({ id: users.id }).from(users).where(eq(users.id, DEV_USER)),
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
  return DEV_USER;
}

/**
 * index.ts's `canUseGroupBot` and the upgrade's `hasRole`, with `actorFor` as index.ts writes it: the
 * single-user owner is an administrator; anyone else needs the `admin` or `user` role.
 */
function productionChecks(singleUser: boolean) {
  // The one role answer index.ts builds `actorFor` and `hasRole` on.
  const roleOf = createRoleOf({
    singleUser,
    roles: createRoleRepository(database),
  });
  const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
    const role = await roleOf(ownerUserId);
    if (!role) throw new Error("A routine requires an authorized owner.");
    return { id: ownerUserId, role };
  };
  return {
    canUse: async (ownerUserId: string, agentId: string) =>
      Boolean(await profileStore.get(await actorFor(ownerUserId), agentId)),
    hasRole: async (userId: string) => (await roleOf(userId)) !== null,
  };
}

describe("phase 1: what a crash, a race or a rule leaves", () => {
  test("rule 3: a crew of the platform or the team is kept as no_owner", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const platformCrew = await oldCrew("platform", `${prefix} 平台`, ids);
    const teamCrew = await oldCrew("team", `${prefix} 团队`, ids);
    const before = await totals();

    await convertGroups(upgrade());

    expect(await ledgerOf(platformCrew)).toMatchObject({
      tenant_id: "platform",
      original_owner: "platform",
      outcome: "no_owner",
    });
    expect(await ledgerOf(teamCrew)).toMatchObject({
      tenant_id: "team",
      original_owner: "team",
      outcome: "no_owner",
    });
    expect((await totals())?.channels).toBe(before?.channels);
  });

  test("an owner with no role at all is no_owner, and nobody asks whether they may use a Bot", async () => {
    const alice = await person("alice");
    const groupId = await oldCrew(alice, "周报", await bots(alice, 2));
    const log: Record<string, unknown>[] = [];
    const checks = productionChecks(false);
    let asked = 0;

    await convertGroups(
      upgrade({
        log,
        hasRole: checks.hasRole,
        canUse: async (owner, agentId) => {
          asked += 1;
          return checks.canUse(owner, agentId);
        },
      }),
    );

    expect(await ledgerOf(groupId)).toMatchObject({
      tenant_id: alice,
      outcome: "no_owner",
      channel_id: null,
    });
    expect(asked).toBe(0);
    expect(log.filter((line) => line.groupId === groupId)).toEqual([]);
    expect(await chatsOf(alice)).toEqual([]);
  });

  test("an owner whose address is in revoked_access is no_owner: the group is not converted", async () => {
    const alice = await person("alice");
    const groupId = await oldCrew(alice, "周报", await bots(alice, 2));
    // The 0207 trigger has nothing to move for this person; the row is what counts as leaving.
    await runAsTenant("platform", () =>
      database.execute(
        sql`insert into revoked_access (email, revoked_by)
            values (${`${alice}@example.test`}, 'upgrade-test')`,
      ),
    );
    try {
      await convertGroups(upgrade());
    } finally {
      await runAsTenant("platform", () =>
        database.execute(
          sql`delete from revoked_access where email = ${`${alice}@example.test`}`,
        ),
      );
    }

    expect(await ledgerOf(groupId)).toMatchObject({
      tenant_id: alice,
      outcome: "no_owner",
      channel_id: null,
    });
    expect(await chatsOf(alice)).toEqual([]);
  });

  test("with the production check in single-user mode the owner is an administrator, and row security still keeps others' Bots out", async () => {
    const owner = await devUser();
    const bob = await person("bob");
    const ids = await bots(owner, 2);
    const notTheirs = await bot(bob, "Linus");
    const groupId = await oldCrew(owner, `${prefix} 管理员`, [
      ...ids,
      notTheirs,
    ]);

    await convertGroups(upgrade(productionChecks(true)));

    const ledger = await ledgerOf(groupId);
    expect(ledger).toMatchObject({
      tenant_id: owner,
      outcome: "converted",
      dropped_agent_ids: [notTheirs],
    });
    expect(await membersOf(groupId)).toEqual(ids);
  });

  test("a started row with no orphan is judged again, and may end pending or too many", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const pending = await oldCrew(alice, "待补成员", [
      await bot(alice, "Ada"),
      await bot(bob, "Linus"),
    ]);
    const crowded = await oldCrew(alice, "人太多", await bots(alice, 21));
    await started(pending, alice, { originalOwner: `${prefix}-first` });
    await started(crowded, alice, { dropped: ["gone"] });

    await convertGroups(upgrade());

    expect(await ledgerOf(pending)).toEqual({
      tenant_id: alice,
      original_owner: `${prefix}-first`,
      channel_id: null,
      outcome: "pending_members",
      dropped_agent_ids: [],
    });
    expect(await ledgerOf(crowded)).toMatchObject({
      channel_id: null,
      outcome: "too_many",
      dropped_agent_ids: [],
    });
    expect(await chatsOf(alice)).toEqual([]);
  });

  test("an orphan is a shared group: a personal chat with the same Bots is not adopted", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const personal = await runAsTenant(alice, () =>
      channelStore.create({ id: alice, role: "user" }, ids),
    );
    createdChannels.push(personal.id);

    await convertGroups(upgrade());

    const ledger = await ledgerOf(groupId);
    expect(ledger).toMatchObject({ outcome: "converted" });
    expect(ledger?.channel_id).not.toBe(personal.id);
    const chats = await chatsOf(alice);
    expect(chats.find((row) => row.id === personal.id)?.waker_group_id).toBe(
      null,
    );
    expect(chats.find((row) => row.id === ledger?.channel_id)).toMatchObject({
      tenant_id: "team",
      waker_group_id: groupId,
    });
  });

  test("an adopted orphan gets the order upstream would have seeded", async () => {
    const alice = await person("alice");
    // Positions put the Bot that sorts later by id first: only the seed keeps that order.
    const [first, second] = await twoOutOfIdOrder(alice);
    if (!first || !second) throw new Error("bots not written");
    const groupId = await oldCrew(alice, "周报", [first, second]);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const orphan = await unseededChat(alice, [first, second]);
    expect(await orderOf(orphan.id)).toEqual([]);

    await convertGroups(upgrade());

    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: orphan.id,
      outcome: "converted",
    });
    expect(await orderOf(orphan.id)).toEqual([first, second]);
    expect(await membersOf(groupId)).toEqual([first, second]);
  });

  test("a started row whose chat was deleted since is passed over without a word", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const unlinked = await oldCrew(alice, "周报", ids);
    const linked = await oldCrew(alice, "复盘", ids);
    const first = await openChat(alice, ids);
    await started(unlinked, alice, { channelId: first.id });
    const second = await openChat(alice, ids);
    await started(linked, alice, { channelId: second.id });
    await upgrade().link.adopt(linked, second.id);
    await hide(first.id);
    await hide(second.id);
    const log: Record<string, unknown>[] = [];

    await convertGroups(upgrade({ log }));
    await convertGroups(upgrade({ log }));

    expect(
      log.filter(
        (line) => line.groupId === unlinked || line.groupId === linked,
      ),
    ).toEqual([]);
    expect(await ledgerOf(unlinked)).toMatchObject({
      channel_id: first.id,
      outcome: "started",
    });
    expect(await ledgerOf(linked)).toMatchObject({
      channel_id: second.id,
      outcome: "started",
    });
    // The crews stay; their chats are not opened again.
    expect((await chatsOf(alice)).map((row) => [row.id, row.deleted])).toEqual([
      [first.id, true],
      [second.id, true],
    ]);
  });

  test("a chat the person opened for the crew mid-conversion wins: the empty one the upgrade made is hidden", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    const base = conversations();
    const link = linkFor();
    const log: Record<string, unknown>[] = [];
    let theirs = "";
    let ours = "";

    const counts = await convertGroups(
      upgrade({
        link,
        log,
        groups: {
          store: base.store,
          create: async (owner, input) => {
            const made = await base.create(owner, input);
            ours = made.id;
            // Between ② and ④ the person opens the crew's chat from the crew page.
            const opened = await openChat(alice, ids);
            theirs = opened.id;
            await link.adopt(groupId, opened.id);
            return made;
          },
        },
      }),
    );

    expect(counts.converted).toBeGreaterThanOrEqual(1);
    // The ledger names the chat the upgrade made, never the person's own (the runbook hides by it).
    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: ours,
      outcome: "converted",
    });
    const chats = await chatsOf(alice);
    expect(
      chats.map((row) => [row.id, row.waker_group_id, row.deleted]),
    ).toEqual([
      [ours, null, true],
      [theirs, groupId, false],
    ]);
    // What the upgrade hid is written down: the ledger now names the person's chat, not this one.
    expect(log.filter((line) => line.groupId === groupId)).toEqual([
      {
        type: "waker-group-upgrade-chat-hidden",
        groupId,
        channelId: ours,
        linkedChannelId: theirs,
      },
    ]);
  });

  test("when the chat the upgrade made already has messages, it is kept and said once", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    const base = conversations();
    const link = linkFor();
    const log: Record<string, unknown>[] = [];
    let theirs = "";
    let ours = "";

    await convertGroups(
      upgrade({
        link,
        log,
        groups: {
          store: base.store,
          create: async (owner, input) => {
            const made = await base.create(owner, input);
            ours = made.id;
            await say(alice, made.id);
            const opened = await openChat(alice, ids);
            theirs = opened.id;
            await link.adopt(groupId, opened.id);
            return made;
          },
        },
      }),
    );

    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: ours,
      outcome: "converted",
    });
    expect(log.filter((line) => line.groupId === groupId)).toEqual([
      {
        type: "waker-group-upgrade-chat-kept",
        groupId,
        channelId: ours,
        linkedChannelId: theirs,
      },
    ]);
    expect((await chatsOf(alice)).map((row) => [row.id, row.deleted])).toEqual([
      [ours, false],
      [theirs, false],
    ]);
  });

  test("a started row whose crew the person linked to another chat since is settled on the next boot", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    // Crashed after ③; then the person opened the crew's chat themselves.
    const ours = await openChat(alice, ids);
    await started(groupId, alice, { channelId: ours.id });
    const theirs = await openChat(alice, ids);
    await upgrade().link.adopt(groupId, theirs.id);
    const log: Record<string, unknown>[] = [];

    await convertGroups(upgrade({ log }));

    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: ours.id,
      outcome: "converted",
    });
    expect((await chatsOf(alice)).map((row) => [row.id, row.deleted])).toEqual([
      [ours.id, true],
      [theirs.id, false],
    ]);
    expect(log.filter((line) => line.groupId === groupId)).toEqual([
      {
        type: "waker-group-upgrade-chat-hidden",
        groupId,
        channelId: ours.id,
        linkedChannelId: theirs.id,
      },
    ]);
  });

  test("a started row with no chat of its own, settled on a chat the person opened, names no chat", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    // Crashed before ②; then the person opened the crew's chat themselves.
    await started(groupId, alice, {});
    const theirs = await openChat(alice, ids);
    await upgrade().link.adopt(groupId, theirs.id);
    const log: Record<string, unknown>[] = [];

    await convertGroups(upgrade({ log }));

    // The conversion made no chat, so the ledger names none: theirs is not the upgrade's to hide.
    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: null,
      outcome: "converted",
    });
    expect(
      (await chatsOf(alice)).map((row) => [
        row.id,
        row.waker_group_id,
        row.deleted,
      ]),
    ).toEqual([[theirs.id, groupId, false]]);
    expect(log.filter((line) => line.groupId === groupId)).toEqual([]);
  });

  test("the upgrade hides a chat only as its owner could: one they cannot reach is left alone", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    // A ledger row that names Bob's group, which Alice is not in: only the platform frame reaches it.
    const bobs = await openChat(bob, await bots(bob, 2));
    await started(groupId, alice, { channelId: bobs.id });
    const theirs = await openChat(alice, ids);
    await upgrade().link.adopt(groupId, theirs.id);
    const log: Record<string, unknown>[] = [];

    await convertGroups(upgrade({ log }));

    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: bobs.id,
      outcome: "converted",
    });
    expect((await chatsOf(bob)).map((row) => [row.id, row.deleted])).toEqual([
      [bobs.id, false],
    ]);
    expect(log.filter((line) => line.groupId === groupId)).toEqual([]);
  });

  test("a started row whose crew the person linked to another chat and deleted it is passed over, and lets go of its chat", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    const ours = await openChat(alice, ids);
    await started(groupId, alice, { channelId: ours.id });
    // The person opened the crew's chat themselves, then deleted it.
    const theirs = await openChat(alice, ids);
    await upgrade().link.adopt(groupId, theirs.id);
    await hide(theirs.id);
    const log: Record<string, unknown>[] = [];
    const claims = createConversionClaims({
      database,
      link: linkFor(),
      groupStore,
    });

    await convertGroups(upgrade({ log }));
    await convertGroups(upgrade({ log }));

    expect(log.filter((line) => line.groupId === groupId)).toEqual([]);
    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: ours.id,
      outcome: "started",
    });
    expect(
      await runAsTenant("platform", () => claims.claimedBy(ours.id)),
    ).toBeNull();
    // No longer held, the chat the conversion made is an ordinary old chat for phase 2.
    await backfillChannels(upgrade());
    const own = (await chatsOf(alice)).find(
      (row) => row.id === ours.id,
    )?.waker_group_id;
    expect(own).toBeTruthy();
    expect(own).not.toBe(groupId);
  });

  test("a package's channel is never an orphan: the conversion makes its own chat instead", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const packaged = await openChat(alice, ids);
    const log: Record<string, unknown>[] = [];
    await withPackage(packaged.id, async () => {
      await convertGroups(upgrade({ log }));

      expect(log.filter((line) => line.groupId === groupId)).toEqual([]);
      const ledger = await ledgerOf(groupId);
      expect(ledger).toMatchObject({ outcome: "converted" });
      expect(ledger?.channel_id).not.toBe(packaged.id);
      expect(
        (await chatsOf(alice)).find((row) => row.id === packaged.id)
          ?.waker_group_id,
      ).toBeNull();
    });
  });
});

/** `runGroupUpgrade` against the test database, with the summary line it prints kept. */
async function run(
  deps: GroupUpgradeDeps = upgrade(),
  env: Record<string, string | undefined> = {},
) {
  const [result] = await printed(() =>
    runGroupUpgrade({ ...deps, databaseUrl: testDatabaseUrl() }, env),
  );
  return result;
}

/** A gate a test opens by hand: whatever awaits `opened` waits until then. */
function opening() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/** What `work` printed with console.error, kept from the output. */
async function printed<T>(work: () => Promise<T>): Promise<[T, string[]]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return [await work(), lines];
  } finally {
    console.error = original;
  }
}

/** A linked shared group of `owner`'s with `others` added, as `POST /api/groups` makes one now. */
async function linkedGroup(owner: string, others: string[], botCount = 3) {
  const ids = await bots(owner, botCount);
  const groups = withWakerGroupLink(conversations(), linkFor(), () => {});
  const channel = await runAsTenant(owner, () =>
    groups.create(owner, { agentIds: ids }),
  );
  // The link decorator adds `wakerGroupId`; the store type does not name it.
  const groupId = (channel as { wakerGroupId?: string | null }).wakerGroupId;
  if (!groupId) throw new Error("not linked");
  for (const other of others)
    await runAsTenant(owner, () =>
      conversations().addMember(owner, channel.id, {
        email: `${other}@example.test`,
      }),
    );
  return { channelId: channel.id, groupId, bots: ids };
}

/** The roster the chat answers in, as the mirror should hold it. */
async function truthOf(channelId: string) {
  return runAsTenant("platform", async () =>
    runtimeOrder(
      await groupStore.order(channelId),
      await groupStore.bots(channelId),
    ),
  );
}

async function dropBot(channelId: string, agentId: string) {
  await runAsTenant("platform", () =>
    database.execute(
      sql`delete from channel_agents where channel_id = ${channelId} and agent_id = ${agentId}`,
    ),
  );
}

async function crewOwner(groupId: string) {
  const [row] = await runAsTenant("platform", () =>
    database
      .select({ tenantId: wakerGroups.tenantId, name: wakerGroups.name })
      .from(wakerGroups)
      .where(eq(wakerGroups.id, groupId)),
  );
  return row ?? null;
}

/** `/api/waker-groups` as index.ts mounts it, with the conversions the boot task leaves unfinished. */
function crewApi(conversions?: ConversionClaims) {
  const link = linkFor();
  const crews = createWakerGroupStore(database);
  const actions = createWakerGroupActions({
    database,
    store: crews,
    link,
    groups: conversations(),
    channels: channelStore,
    actorFor: async (id) => ({ id, role: "user" }),
    canUse,
    conversions:
      conversions ??
      createConversionClaims({
        database,
        link,
        groupStore,
      }),
    log: () => {},
  });
  let caller = "";
  const routes = createWakerGroupRoutes(
    crews,
    async (context, next) => {
      context.set("actor", {
        id: caller,
        email: `${caller}@example.test`,
        role: "user",
      });
      await runAsTenant(caller, () => next());
    },
    actions,
  );
  return async (who: string, path: string) => {
    caller = who;
    const response = await routes.request(path, { method: "POST" });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json };
  };
}

describe("phases 2 and 3", () => {
  /** Chats with no owner other test files left in this database: counted by every phase 2 run. */
  let ownerlessBefore = 0;
  // Whatever older chats this database holds are given their crews once, so the counts below are ours.
  beforeAll(async () => {
    const sink: Record<string, unknown>[] = [];
    ownerlessBefore = (await backfillChannels(upgrade({ log: sink })))
      .ownerless;
  });

  test("phase 2 links every unlinked chat of two or more, once", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const shared = await openChat(alice, ids);
    // A personal chat with several Bots, from before shared groups (P11).
    const personal = await runAsTenant(alice, () =>
      channelStore.create({ id: alice, role: "user" }, ids),
    );
    createdChannels.push(personal.id);
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set title = '个人群' where id = ${personal.id}`,
      ),
    );

    expect(await backfillChannels(upgrade())).toMatchObject({
      backfilled: 2,
      ownerless: ownerlessBefore,
    });

    const chats = await chatsOf(alice);
    expect(chats.map((row) => row.id).sort()).toEqual(
      [shared.id, personal.id].sort(),
    );
    for (const chat of chats) {
      const groupId = chat.waker_group_id;
      if (!groupId) throw new Error(`${chat.id} not linked`);
      expect(await ledgerOf(groupId)).toEqual({
        tenant_id: alice,
        original_owner: alice,
        channel_id: chat.id,
        outcome: "backfilled",
        dropped_agent_ids: [],
      });
      expect(await membersOf(groupId)).toEqual(await truthOf(chat.id));
      expect((await crewOwner(groupId))?.tenantId).toBe(alice);
    }
    const before = await totals();

    expect(await backfillChannels(upgrade())).toMatchObject({
      backfilled: 0,
      ownerless: ownerlessBefore,
    });
    expect(await totals()).toEqual(before);
  });

  test("phase 2 adds （2） when the name is taken", async () => {
    const alice = await person("alice");
    await crew(alice, "复盘");
    const old = await openChat(alice, await bots(alice, 2));
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set title = '复盘' where id = ${old.id}`,
      ),
    );

    await backfillChannels(upgrade());

    const [chat] = await chatsOf(alice);
    const groupId = chat?.waker_group_id;
    if (!groupId) throw new Error("not linked");
    expect((await crewOwner(groupId))?.name).toBe("复盘（2）");
  });

  test("phase 2 gives an old personal chat whose created_by is null a crew in its tenant's name", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const personal = await runAsTenant(alice, () =>
      channelStore.create({ id: alice, role: "user" }, ids),
    );
    createdChannels.push(personal.id);
    // Rows from before P11 carry no creator.
    await runAsTenant("platform", () =>
      database.execute(
        sql`update channels set created_by = null where id = ${personal.id}`,
      ),
    );

    expect(await backfillChannels(upgrade())).toMatchObject({
      backfilled: 1,
      ownerless: ownerlessBefore,
    });

    // `chatsOf` goes by creator, which this chat no longer has.
    const [row] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select waker_group_id::text as id from channels where id = ${personal.id}`,
      ),
    )) as unknown as { id: string | null }[];
    const groupId = row?.id;
    if (!groupId) throw new Error("not linked");
    expect(await ledgerOf(groupId)).toMatchObject({
      tenant_id: alice,
      channel_id: personal.id,
      outcome: "backfilled",
    });
  });

  test("phase 2 leaves a package's chats alone, and for-channel answers 404 for them", async () => {
    const alice = await person("alice");
    const chat = await openChat(alice, await bots(alice, 2));
    await withPackage(chat.id, async () => {
      expect(await backfillChannels(upgrade())).toMatchObject({
        backfilled: 0,
        ownerless: ownerlessBefore,
      });
      expect((await crewApi()(alice, `/for-channel/${chat.id}`)).status).toBe(
        404,
      );
      expect((await chatsOf(alice))[0]?.waker_group_id).toBeNull();
    });
  });

  test("for-channel on a one-on-one chat answers 404 before any conversion is asked to finish it", async () => {
    const alice = await person("alice");
    const [ada] = await bots(alice, 1);
    if (!ada) throw new Error("bot not written");
    const single = await runAsTenant(alice, () =>
      channelStore.create({ id: alice, role: "user" }, [ada]),
    );
    createdChannels.push(single.id);
    const groupId = await crew(alice, "单聊");
    // Conversions that claim every chat: only the one-on-one guard in front of them says no.
    const finished: string[] = [];
    const api = crewApi({
      claimedBy: async () => groupId,
      finish: async (_, channelId) => {
        finished.push(channelId);
      },
    });

    expect((await api(alice, `/for-channel/${single.id}`)).status).toBe(404);
    expect(finished).toEqual([]);
    expect((await chatsOf(alice))[0]?.waker_group_id).toBeNull();
  });

  test("a conversion whose adopt failed keeps its chat out of phase 2, and the next run finishes it", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    const link = linkFor();
    const log: Record<string, unknown>[] = [];
    await convertGroups(
      upgrade({
        log,
        link: {
          ...link,
          adopt: async () => {
            throw new Error("adopt down");
          },
        },
      }),
    );
    const ledger = await ledgerOf(groupId);
    expect(ledger).toMatchObject({ outcome: "started" });
    const chatId = ledger?.channel_id;
    if (!chatId) throw new Error("no chat written down");
    const before = await totals();

    expect(await backfillChannels(upgrade())).toMatchObject({
      backfilled: 0,
    });
    expect((await chatsOf(alice))[0]?.waker_group_id).toBeNull();
    expect((await totals())?.crews).toBe(before?.crews);

    await run();

    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: chatId,
      outcome: "converted",
    });
    expect((await chatsOf(alice)).map((row) => row.waker_group_id)).toEqual([
      groupId,
    ]);
    expect((await totals())?.crews).toBe(before?.crews);
  });

  test("a chat in the orphan window is not backfilled", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const orphan = await openChat(alice, ids);

    expect(await backfillChannels(upgrade())).toMatchObject({
      backfilled: 0,
    });
    expect((await chatsOf(alice)).map((row) => row.waker_group_id)).toEqual([
      null,
    ]);
    expect(
      await runAsTenant("platform", () =>
        createConversionClaims({
          database,
          link: linkFor(),
          groupStore,
        }).claimedBy(orphan.id),
      ),
    ).toBe(groupId);
  });

  test("for-channel on a chat claimed by an unfinished conversion finishes it with the original crew", async () => {
    const alice = await person("alice");
    const [first, second] = await twoOutOfIdOrder(alice);
    if (!first || !second) throw new Error("bots not written");
    const groupId = await oldCrew(alice, "周报", [first, second]);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const orphan = await unseededChat(alice, [first, second]);
    const before = await totals();

    const answer = await crewApi()(alice, `/for-channel/${orphan.id}`);

    expect(answer.status).toBe(200);
    expect((answer.json.group as { id: string }).id).toBe(groupId);
    expect(await ledgerOf(groupId)).toMatchObject({
      channel_id: orphan.id,
      outcome: "converted",
    });
    expect((await totals())?.crews).toBe(before?.crews);
    expect(await orderOf(orphan.id)).toEqual([first, second]);
    expect((await chatsOf(alice))[0]?.waker_group_id).toBe(groupId);
  });

  test("phase 2 skips a shared chat with no creator", async () => {
    const alice = await person("alice");
    const [ada, grace] = await bots(alice, 2);
    if (!ada || !grace) throw new Error("bots not written");
    // Other files may have left chats with no owner here too: only the difference is ours.
    const { ownerless: before } = await backfillChannels(upgrade());
    const ownerless = `${prefix}-ownerless-${randomUUID()}`;
    createdChannels.push(ownerless);
    await runAsTenant("platform", async () => {
      await database.execute(
        sql`insert into channels (id, tenant_id, name, description, created_by)
            values (${ownerless}, 'team', 'Ada、Grace', 'legacy', null)`,
      );
      await database.insert(channelAgents).values([
        { channelId: ownerless, agentId: ada, tenantId: "team" },
        { channelId: ownerless, agentId: grace, tenantId: "team" },
      ]);
    });
    const crews = (await totals())?.crews;

    expect(await backfillChannels(upgrade())).toMatchObject({
      backfilled: 0,
      ownerless: before + 1,
    });
    expect((await totals())?.crews).toBe(crews);
  });

  test("phase 2 logs the old shared chat it drops when no human is left in it", async () => {
    const alice = await person("alice");
    const [ada, grace] = await bots(alice, 2);
    if (!ada || !grace) throw new Error("bots not written");
    const empty = `${prefix}-empty-${randomUUID()}`;
    createdChannels.push(empty);
    await runAsTenant("platform", async () => {
      await database.execute(
        sql`insert into channels (id, tenant_id, name, description, created_by)
            values (${empty}, 'team', 'Ada、Grace', 'legacy', ${alice})`,
      );
      await database.insert(channelAgents).values([
        { channelId: empty, agentId: ada, tenantId: "team" },
        { channelId: empty, agentId: grace, tenantId: "team" },
      ]);
    });
    const log: Record<string, unknown>[] = [];

    await backfillChannels(upgrade({ log }));

    expect(log).toContainEqual({
      type: "waker-group-upgrade-chat-dropped",
      channelId: empty,
    });
    const [row] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select deleted_at is not null as gone, waker_group_id from channels where id = ${empty}`,
      ),
    )) as unknown as { gone: boolean; waker_group_id: string | null }[];
    expect(row).toMatchObject({ gone: true, waker_group_id: null });
  });

  test("phase 3 rewrites a drifted mirror", async () => {
    const alice = await person("alice");
    const made = await linkedGroup(alice, []);
    // A Bot taken out past the service: the mirror still lists it.
    await dropBot(made.channelId, made.bots[1] ?? "");
    expect(await membersOf(made.groupId)).toEqual(made.bots);

    const { reconciled } = await reconcileLinked(upgrade());

    expect(reconciled).toBeGreaterThanOrEqual(1);
    expect(await membersOf(made.groupId)).toEqual([made.bots[0], made.bots[2]]);
  });

  test("phase 3 hands over a group whose creator left past the service, then rewrites its mirror", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const made = await linkedGroup(alice, [bob]);
    await runAsTenant(alice, () =>
      groupStore.removeMember(made.channelId, alice),
    );
    await dropBot(made.channelId, made.bots[0] ?? "");
    const log: Record<string, unknown>[] = [];

    const counts = await reconcileLinked(upgrade({ log }));

    expect(counts.handedOver).toBeGreaterThanOrEqual(1);
    expect(counts.reconciled).toBeGreaterThanOrEqual(1);
    expect((await crewOwner(made.groupId))?.tenantId).toBe(bob);
    expect((await chatsOf(bob)).map((row) => row.id)).toEqual([made.channelId]);
    expect(await membersOf(made.groupId)).toEqual(made.bots.slice(1));
    expect(log).toContainEqual(
      expect.objectContaining({
        type: "waker-group-handed-over",
        channelId: made.channelId,
        from: alice,
        to: bob,
      }),
    );
  });

  test("phase 3 finishes a hand-over a running flow had put off", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const made = await linkedGroup(alice, [bob]);
    const [run] = await runAsTenant(alice, async () => {
      const [template] = await database
        .insert(groupTaskTemplates)
        .values({ groupId: made.groupId, name: "周报流程", steps: [] })
        .returning({ id: groupTaskTemplates.id });
      return database
        .insert(groupTaskRuns)
        .values({
          templateId: template?.id ?? null,
          groupId: made.groupId,
          status: "running",
          steps: [],
        })
        .returning({ id: groupTaskRuns.id });
    });
    if (!run) throw new Error("run not written");
    await runAsTenant(alice, () =>
      groupStore.removeMember(made.channelId, alice),
    );
    const log: Record<string, unknown>[] = [];

    await reconcileLinked(upgrade({ log }));
    // Put off, and said once: the mirror is not tried in a frame that cannot see the chat.
    expect(log.filter((line) => line.channelId === made.channelId)).toEqual([
      { type: "waker-group-hand-over-deferred", channelId: made.channelId },
    ]);
    expect((await crewOwner(made.groupId))?.tenantId).toBe(alice);

    await runAsTenant("platform", () =>
      database
        .update(groupTaskRuns)
        .set({ status: "done" })
        .where(eq(groupTaskRuns.id, run.id)),
    );
    await dropBot(made.channelId, made.bots[2] ?? "");
    const counts = await reconcileLinked(upgrade());

    expect(counts.handedOver).toBeGreaterThanOrEqual(1);
    expect((await crewOwner(made.groupId))?.tenantId).toBe(bob);
    expect(await membersOf(made.groupId)).toEqual(made.bots.slice(0, 2));
  });

  test("phase 1 runs before phase 2, so an orphan is not backfilled first", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const orphan = await openChat(alice, ids);
    const before = await totals();

    await run();

    expect(
      (await chatsOf(alice)).map((row) => [row.id, row.waker_group_id]),
    ).toEqual([[orphan.id, groupId]]);
    expect((await totals())?.crews).toBe(before?.crews);
  });

  test("a personal chat beside an unfinished conversion is not its orphan, so phase 2 gives it a crew", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    await started(groupId, alice, {});
    await Bun.sleep(5);
    const personal = await runAsTenant(alice, () =>
      channelStore.create({ id: alice, role: "user" }, ids),
    );
    createdChannels.push(personal.id);
    expect(
      await runAsTenant("platform", () =>
        createConversionClaims({
          database,
          link: linkFor(),
          groupStore,
        }).claimedBy(personal.id),
      ),
    ).toBeNull();

    await run();

    const chats = await chatsOf(alice);
    const own = chats.find((row) => row.id === personal.id)?.waker_group_id;
    expect(own).toBeTruthy();
    expect(own).not.toBe(groupId);
    expect(await ledgerOf(own ?? "")).toMatchObject({ outcome: "backfilled" });
    expect(await ledgerOf(groupId)).toMatchObject({ outcome: "converted" });
  });

  test("two runs at once: one works, the other is skipped", async () => {
    const alice = await person("alice");
    const ids = await bots(alice, 2);
    const groupId = await oldCrew(alice, "周报", ids);
    const old = await openChat(alice, ids);
    // Whichever run takes the lock waits here, holding it, until the other has been turned away.
    const gate = opening();
    const gated = (): GroupUpgradeDeps => ({
      ...upgrade(),
      canUse: async (owner, agentId) => {
        await gate.opened;
        return canUse(owner, agentId);
      },
    });
    const once = () =>
      runGroupUpgrade({ ...gated(), databaseUrl: testDatabaseUrl() }, {}).then(
        (result) => {
          if ("skipped" in result) gate.open();
          return result;
        },
      );

    const [results] = await printed(() => Promise.all([once(), once()]));

    expect(
      results.filter(
        (result) => "skipped" in result && result.skipped === "locked",
      ),
    ).toHaveLength(1);
    const chats = await chatsOf(alice);
    expect(chats).toHaveLength(2);
    expect(chats.find((row) => row.id === old.id)?.waker_group_id).toBeTruthy();
    expect(chats.filter((row) => row.waker_group_id === groupId)).toHaveLength(
      1,
    );
    // What one run leaves: a second run on its own finds nothing more to make.
    const after = await totals();
    await run();
    expect(await totals()).toEqual(after);
  });

  test("XIONGBAO_GROUP_UPGRADE=off does nothing", async () => {
    const alice = await person("alice");
    await oldCrew(alice, "周报", await bots(alice, 2));
    const before = await totals();

    // Not even a connection: the address leads nowhere.
    const result = await runGroupUpgrade(
      { ...upgrade(), databaseUrl: "postgres://nobody@127.0.0.1:1/nothing" },
      { XIONGBAO_GROUP_UPGRADE: "off" },
    );

    expect(result).toEqual({ skipped: "off" });
    expect(await totals()).toEqual(before);
  });

  test("the summary line carries all six counts", async () => {
    const alice = await person("alice");
    await oldCrew(alice, "周报", await bots(alice, 2));

    const [result, lines] = await printed(() =>
      runGroupUpgrade({ ...upgrade(), databaseUrl: testDatabaseUrl() }, {}),
    );

    const summaries = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type === "waker-group-upgrade");
    expect(summaries).toEqual([result]);
    for (const key of [
      "converted",
      "pending",
      "tooMany",
      "noOwner",
      "backfilled",
      "reconciled",
    ])
      expect(typeof summaries[0]?.[key]).toBe("number");
    expect(summaries[0]?.converted).toBeGreaterThanOrEqual(1);
  });

  test("the boot task logs a failure rather than throwing", async () => {
    const [outcome, lines] = await printed(async () => {
      const task = startGroupUpgrade({
        ...upgrade(),
        databaseUrl: "postgres://nobody@127.0.0.1:1/nothing",
      });
      await task.stop();
      return task.done;
    });

    expect(outcome).toBeNull();
    expect(lines.map((line) => JSON.parse(line).type as string)).toContain(
      "waker-group-upgrade-failed",
    );
  });

  test("the boot task returns at once, and stop waits for the item in hand and goes no further", async () => {
    const alice = await person("alice");
    const first = await oldCrew(alice, "周报", await bots(alice, 2));
    const second = await oldCrew(alice, "复盘", await bots(alice, 2));
    const gate = opening();
    let reached = false;
    let settled = false;

    const [, lines] = await printed(async () => {
      const task = startGroupUpgrade({
        ...upgrade(),
        databaseUrl: testDatabaseUrl(),
        // Alice's first crew is held while it asks about its Bots; everyone else's goes through.
        canUse: async (owner, agentId) => {
          if (owner === alice) {
            reached = true;
            await gate.opened;
          }
          return canUse(owner, agentId);
        },
      });
      task.done.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      while (!reached) await Bun.sleep(5);

      let stopped = false;
      const stopping = task.stop().then(() => {
        stopped = true;
      });
      await Bun.sleep(50);
      expect(stopped).toBe(false);
      expect(settled).toBe(false);
      gate.open();
      await stopping;
      expect(settled).toBe(true);
      return task.done;
    });

    // The crew in hand was finished; the next was not started, and nothing after phase 1 ran.
    expect(await ledgerOf(first)).toMatchObject({ outcome: "converted" });
    expect(await ledgerOf(second)).toBeNull();
    const summary = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.type === "waker-group-upgrade");
    expect(summary).toMatchObject({ backfilled: 0, reconciled: 0 });
  });
});

/** The deployment manual, whose rollback runbook (section 6.2) the tests below run as written. */
const MANUAL = await Bun.file(
  new URL("../../docs/deployment-xiongbao.md", import.meta.url),
).text();
const RUNBOOK_START = "<!-- group-upgrade-rollback:start -->";
const RUNBOOK_END = "<!-- group-upgrade-rollback:end -->";
const HAND_OVER_TRIGGER = "openbot_team_revoked_leaves";

/** The runbook's SQL between its two markers, as the operator pastes it. */
function runbookSql() {
  const start = MANUAL.indexOf(RUNBOOK_START);
  const end = MANUAL.indexOf(RUNBOOK_END);
  if (start < 0 || end < start) throw new Error("runbook markers missing");
  const fenced = /```sql\n([\s\S]*?)\n```/.exec(
    MANUAL.slice(start + RUNBOOK_START.length, end),
  );
  if (!fenced?.[1]) throw new Error("the runbook has no sql block");
  return fenced[1];
}

/** Its statements in order, each without its semicolon (none of them has one inside). */
function statementsOf(text: string) {
  return text
    .split(/;[ \t]*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/^--.*$/gm, "").trim() !== "");
}

/** The database owner, as the operator connects: only it may disable a trigger. */
function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: the runbook runs as the owner.",
    );
  const admin = new URL(raw);
  const target = new URL(testDatabaseUrl());
  if (admin.hostname !== target.hostname || admin.port !== target.port)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
    );
  return new SQL({
    adapter: "postgres",
    hostname: admin.hostname,
    port: admin.port ? Number(admin.port) : 5432,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}

/** Thrown to unwind the owner's transaction: the runbook touches every row of its tables. */
class Rollback extends Error {}

/**
 * `statements` as the owner, one by one in one transaction, then `look` at what they left before
 * the transaction is rolled back, so the shared test database is as it was.
 */
async function ownerRolledBack<T>(
  statements: string[],
  look: (tx: SQL, results: unknown[][]) => Promise<T>,
): Promise<T> {
  const owner = ownerConnection();
  let seen: { value: T } | null = null;
  try {
    await owner.begin(async (tx) => {
      const results: unknown[][] = [];
      for (const statement of statements)
        results.push(await tx.unsafe(statement));
      seen = { value: await look(tx as unknown as SQL, results) };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await owner.close();
  }
  if (!seen) throw new Error("the runbook was not run");
  return (seen as { value: T }).value;
}

/** The runbook between its BEGIN and COMMIT, run as the owner and rolled back. */
async function runRunbook<T>(
  look: (tx: SQL, handedOver: Record<string, unknown>[]) => Promise<T>,
) {
  const statements = statementsOf(runbookSql());
  expect(statements[0]).toBe("BEGIN");
  expect(statements.at(-1)).toBe("COMMIT");
  expect(statements[1]).toBe(
    "SELECT set_config('app.tenant_id', 'platform', true)",
  );
  // The listing of converted crews that changed hands comes first, before anything is undone.
  expect(statements[2]).toContain("g.tenant_id <> l.original_owner");
  return ownerRolledBack(statements.slice(1, -1), (tx, results) =>
    look(tx, [...(results[1] ?? [])] as Record<string, unknown>[]),
  );
}

/** The chat the ledger names for `groupId`. */
async function ledgerChannel(groupId: string) {
  const channelId = (await ledgerOf(groupId))?.channel_id;
  if (!channelId) throw new Error(`no chat in the ledger for ${groupId}`);
  return channelId;
}

async function linkOf(channelId: string) {
  const [row] = (await runAsTenant("platform", () =>
    database.execute(
      sql`select waker_group_id::text as group_id from channels where id = ${channelId}`,
    ),
  )) as unknown as { group_id: string | null }[];
  return row?.group_id ?? null;
}

/** In the owner's transaction: the chat's state and its link. */
async function chatIn(tx: SQL, channelId: string) {
  const [row] = await tx`select deleted_at, waker_group_id::text as group_id
                           from channels where id = ${channelId}`;
  return {
    deleted: row?.deleted_at !== null,
    deletedAt: row?.deleted_at ?? null,
    groupId: (row?.group_id as string | null) ?? null,
  };
}

/** In the owner's transaction: the crew's roster in `position` order. */
async function rosterIn(tx: SQL, groupId: string) {
  const rows =
    await tx`select agent_id from waker_group_members where group_id = ${groupId}::uuid
              order by position::int`;
  return [...rows].map((row: { agent_id: string }) => row.agent_id);
}

async function crewIn(tx: SQL, groupId: string) {
  const [row] =
    await tx`select tenant_id from waker_groups where id = ${groupId}::uuid`;
  return (row?.tenant_id as string | undefined) ?? null;
}

describe("rollback runbook", () => {
  test("the runbook is marked once", () => {
    for (const marker of [RUNBOOK_START, RUNBOOK_END])
      expect(MANUAL.split(marker).length - 1).toBe(1);
    expect(MANUAL.indexOf(RUNBOOK_START)).toBeLessThan(
      MANUAL.indexOf(RUNBOOK_END),
    );
  });

  test("the runbook SQL undoes an untouched conversion and backfill", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const mine = await bots(alice, 2);
    // Bob's Bot is private to him: Alice's conversion leaves it out.
    const theirs = await bot(bob, "别人的员工");
    const untouched = await oldCrew(alice, "周报", [...mine, theirs]);
    const spoken = await oldCrew(alice, "复盘", await bots(alice, 2));
    const handed = await oldCrew(alice, "交接", await bots(alice, 2));
    await convertGroups(upgrade());
    const untouchedChat = await ledgerChannel(untouched);
    const spokenChat = await ledgerChannel(spoken);
    const handedChat = await ledgerChannel(handed);
    expect(await ledgerOf(untouched)).toMatchObject({
      outcome: "converted",
      dropped_agent_ids: [theirs],
    });
    expect(await membersOf(untouched)).toEqual(mine);
    await say(alice, spokenChat);
    // Carol joins the converted chat while it is still empty; Alice leaves past the service.
    await runAsTenant(alice, () =>
      conversations().addMember(alice, handedChat, {
        email: `${carol}@example.test`,
      }),
    );
    await runAsTenant(alice, () => groupStore.removeMember(handedChat, alice));
    await runAsTenant("platform", () =>
      database.execute(
        sql`select public.xiongbao_team_channel_hand_over(${handedChat})`,
      ),
    );
    expect((await crewOwner(handed))?.tenantId).toBe(carol);
    expect(await ledgerOf(handed)).toMatchObject({
      tenant_id: carol,
      original_owner: alice,
    });

    const unused = await openChat(alice, await bots(alice, 2));
    const used = await openChat(alice, await bots(alice, 2));
    await backfillChannels(upgrade());
    const unusedCrew = await linkOf(unused.id);
    const usedCrew = await linkOf(used.id);
    if (!unusedCrew || !usedCrew) throw new Error("not backfilled");
    expect(await ledgerOf(unusedCrew)).toMatchObject({ outcome: "backfilled" });
    // Its template was deleted, which keeps the run and empties its template id.
    const [run] = await runAsTenant(alice, () =>
      database
        .insert(groupTaskRuns)
        .values({
          templateId: null,
          groupId: usedCrew,
          status: "done",
          steps: [],
        })
        .returning({ id: groupTaskRuns.id }),
    );
    if (!run) throw new Error("run not written");

    const seen = await runRunbook(async (tx, handedOver) => ({
      handedOver: handedOver.filter((row) =>
        [untouched, spoken, handed].includes(String(row.group_id)),
      ),
      untouched: await chatIn(tx, untouchedChat),
      roster: await rosterIn(tx, untouched),
      spoken: await chatIn(tx, spokenChat),
      handed: await chatIn(tx, handedChat),
      handedOwner: await crewIn(tx, handed),
      unusedCrew: await crewIn(tx, unusedCrew),
      unused: await chatIn(tx, unused.id),
      usedCrew: await crewIn(tx, usedCrew),
      runs: [
        ...(await tx`select id::text as id from group_task_runs where id = ${run.id}::uuid`),
      ].map((row: { id: string }) => row.id),
      ledger: Number(
        (await tx`select count(*)::int as n from waker_group_upgrades`)[0]?.n,
      ),
    }));

    // The untouched conversion is undone: its chat hidden, the coworker it left out back last.
    expect(seen.untouched).toMatchObject({ deleted: true, groupId: untouched });
    expect(seen.roster).toEqual([...mine, theirs]);
    // The unused backfill is gone, and its chat unlinked.
    expect(seen.unusedCrew).toBeNull();
    expect(seen.unused).toMatchObject({ deleted: false, groupId: null });
    // Spoken in, or used by a run whose template is gone: left alone.
    expect(seen.spoken).toMatchObject({ deleted: false, groupId: spoken });
    expect(seen.usedCrew).toBe(alice);
    expect(seen.runs).toEqual([run.id]);
    // Handed over: left with its heir, and written down by the opening query.
    expect(seen.handed).toMatchObject({ deleted: false, groupId: handed });
    expect(seen.handedOwner).toBe(carol);
    expect(seen.handedOver).toEqual([
      {
        group_id: handed,
        original_owner: alice,
        current_owner: carol,
        channel_id: handedChat,
      },
    ]);
    expect(seen.ledger).toBe(0);
    // Rolled back: the shared database is as it was.
    expect(await ledgerOf(untouched)).toMatchObject({ outcome: "converted" });
  });

  test("the runbook leaves alone a chat the person opened themselves", async () => {
    const alice = await person("alice");
    const bob = await person("bob");

    // The person opened the crew's chat mid-conversion: the ledger names the one the upgrade made.
    const racedIds = await bots(alice, 2);
    const raced = await oldCrew(alice, "周报", racedIds);
    const base = conversations();
    const link = linkFor();
    let racedOurs = "";
    let racedTheirs = "";
    await convertGroups(
      upgrade({
        link,
        groups: {
          store: base.store,
          create: async (owner, input) => {
            const made = await base.create(owner, input);
            if (owner === alice && !racedOurs) {
              racedOurs = made.id;
              const opened = await openChat(alice, racedIds);
              racedTheirs = opened.id;
              await link.adopt(raced, opened.id);
            }
            return made;
          },
        },
      }),
    );
    expect(await ledgerOf(raced)).toMatchObject({
      outcome: "converted",
      channel_id: racedOurs,
    });

    // Crashed before it made a chat; the person opened one since: the ledger names none.
    const nothingIds = await bots(alice, 2);
    const nothing = await oldCrew(alice, "复盘", nothingIds);
    await started(nothing, alice, {});
    const nothingTheirs = await openChat(alice, nothingIds);
    await upgrade().link.adopt(nothing, nothingTheirs.id);

    // The ledger names a chat that never linked the crew and nobody spoke in (the upgrade could
    // not hide it: Alice cannot reach Bob's group).
    const elsewhereIds = await bots(alice, 2);
    const elsewhere = await oldCrew(alice, "交接", elsewhereIds);
    const bobs = await openChat(bob, await bots(bob, 2));
    await started(elsewhere, alice, { channelId: bobs.id });
    const elsewhereTheirs = await openChat(alice, elsewhereIds);
    await upgrade().link.adopt(elsewhere, elsewhereTheirs.id);

    // A converted chat the person deleted since, with a coworker the conversion left out.
    const mine = await bots(alice, 2);
    const left = await bot(bob, "别人的员工");
    const deleted = await oldCrew(alice, "月报", [...mine, left]);

    await convertGroups(upgrade());
    expect(await ledgerOf(nothing)).toMatchObject({
      outcome: "converted",
      channel_id: null,
    });
    expect(await ledgerOf(elsewhere)).toMatchObject({
      outcome: "converted",
      channel_id: bobs.id,
    });
    const deletedChat = await ledgerChannel(deleted);
    await hide(deletedChat);

    const before = await runAsTenant("platform", () =>
      database.execute(
        sql`select deleted_at::text as at from channels where id = ${deletedChat}`,
      ),
    );
    const seen = await runRunbook(async (tx) => ({
      racedTheirs: await chatIn(tx, racedTheirs),
      racedOurs: await chatIn(tx, racedOurs),
      nothingTheirs: await chatIn(tx, nothingTheirs.id),
      elsewhereTheirs: await chatIn(tx, elsewhereTheirs.id),
      bobs: await chatIn(tx, bobs.id),
      deletedAt: (
        await tx`select deleted_at::text as at from channels where id = ${deletedChat}`
      )[0]?.at,
      roster: await rosterIn(tx, deleted),
    }));

    // The person's own chats stay, linked to their crews.
    expect(seen.racedTheirs).toMatchObject({ deleted: false, groupId: raced });
    expect(seen.racedOurs).toMatchObject({ deleted: true, groupId: null });
    expect(seen.nothingTheirs).toMatchObject({
      deleted: false,
      groupId: nothing,
    });
    expect(seen.elsewhereTheirs).toMatchObject({
      deleted: false,
      groupId: elsewhere,
    });
    // A chat that does not link the crew is not the conversion's to hide.
    expect(seen.bobs).toMatchObject({ deleted: false, groupId: null });
    // A chat deleted since is not undone again: nobody is added back to its crew.
    expect(seen.deletedAt).toBe((before as unknown as { at: string }[])[0]?.at);
    expect(seen.roster).toEqual(mine);
  });

  test("the runbook disables the hand-over trigger in its own step", async () => {
    const disabling = MANUAL.match(
      /^DO \$\$\n(?:(?!\$\$)[\s\S])*?DISABLE TRIGGER USER(?:(?!\$\$)[\s\S])*?\n\$\$;$/gm,
    );
    expect(disabling).toHaveLength(1);
    const statement = (disabling?.[0] ?? "").replace(/;$/, "");
    // Its own step: not part of the data rollback.
    expect(MANUAL.indexOf(statement)).toBeLessThan(
      MANUAL.indexOf(RUNBOOK_START),
    );
    expect(runbookSql()).not.toContain("TRIGGER");
    const alice = await person("alice");
    const bob = await person("bob");
    const made = await linkedGroup(alice, [bob]);

    const seen = await ownerRolledBack([], async (tx) => {
      // The manual disables every user trigger on the table: the hand-over one must be all of them.
      const triggers = [
        ...(await tx`select tgname from pg_trigger
                      where tgrelid = 'public.revoked_access'::regclass and not tgisinternal`),
      ].map((row: { tgname: string }) => row.tgname);
      await tx.unsafe(statement);
      const [state] = await tx`select tgenabled from pg_trigger
                                 where tgrelid = 'public.revoked_access'::regclass
                                   and tgname = ${HAND_OVER_TRIGGER}`;
      await tx`insert into revoked_access (email, revoked_by)
               values (${`${alice}@example.test`.toLowerCase()}, 'runbook-test')`;
      const [chat] =
        await tx`select created_by from channels where id = ${made.channelId}`;
      const members = [
        ...(await tx`select user_id from channel_memberships
                      where channel_id = ${made.channelId} order by created_at`),
      ].map((row: { user_id: string }) => row.user_id);
      return {
        triggers,
        enabled: state?.tgenabled,
        creator: chat?.created_by,
        members,
      };
    });

    expect(seen.triggers).toEqual([HAND_OVER_TRIGGER]);
    expect(seen.enabled).toBe("D");
    // Deactivated with the trigger off: she stays in her group, and it stays hers.
    expect(seen.creator).toBe(alice);
    expect(seen.members).toEqual([alice, bob]);
    // Rolled back: the trigger is on again.
    const [after] = (await runAsTenant("platform", () =>
      database.execute(
        sql`select tgenabled from pg_trigger
             where tgrelid = 'public.revoked_access'::regclass and tgname = ${HAND_OVER_TRIGGER}`,
      ),
    )) as unknown as { tgenabled: string }[];
    expect(after?.tgenabled).toBe("O");
  });

  test("the runbook's disabling step refuses to run when the table has another trigger", async () => {
    const statement = (
      MANUAL.match(
        /^DO \$\$\n(?:(?!\$\$)[\s\S])*?DISABLE TRIGGER USER(?:(?!\$\$)[\s\S])*?\n\$\$;$/gm,
      )?.[0] ?? ""
    ).replace(/;$/, "");
    const seen = await ownerRolledBack([], async (tx) => {
      await tx.unsafe(
        `CREATE TRIGGER runbook_test_extra BEFORE UPDATE ON public.revoked_access
           FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
      );
      try {
        await tx.unsafe(statement);
        return "ran";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(seen).toContain("revoked_access");
    expect(seen).not.toBe("ran");
  });
});
