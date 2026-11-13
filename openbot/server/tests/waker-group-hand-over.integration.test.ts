import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { reconcileDirectoryState } from "../src/auth/scim";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
  GroupNotFoundError,
  GroupRefusedError,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  groupTaskRuns,
  groupTaskTemplates,
  intelligenceChannelMappings,
  portraitMedia,
  portraits,
  revokedAccess,
  tasks,
  users,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import { restoreTenant, suspendTenant } from "../src/platform/store";
import type { TaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import {
  createWakerGroupLink,
  runtimeOrder,
  stateOf,
  type WakerGroupLink,
  withChannelRenameLink,
  withWakerGroupLink,
} from "../src/waker-groups/channel-link";
import { createWakerGroupActions } from "../src/waker-groups/linked-actions";
import { createWakerGroupRoutes } from "../src/waker-groups/routes";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A shared group whose creator leaves, or is deactivated, goes to its earliest member (spec
 * 2026-11-13 group-unify, 3.1.1; migration 0207).
 *
 * The heir is the earliest member still in the group whose account is not deactivated, ties by email
 * — the order upstream's `people()` reads, so its "who started this" and the database's `created_by`
 * agree again. The crew goes with the group, and everything of the crew's: its portrait and video,
 * its flow templates, its runs, the cards those runs filed on the board. The last one out leaves the
 * chat deleted and keeps the crew. A running flow stops a creator leaving, and only postpones a
 * deactivation's hand-over until a heal.
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
const people = createPeopleStore(database, []);
const prefix = `wgho-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];
const createdGroups: string[] = [];
const createdTasks: string[] = [];
const createdFlows: string[] = [];

afterEach(async () => {
  /*
   * Rows that point at a run without a cascade go first, so the crews' runs can go with them. Their
   * tables have only the owner's own policies (no `platform` branch), so each person deletes theirs.
   */
  for (const id of createdUsers) {
    await runAsTenant(id, async () => {
      await database.execute(
        sql`delete from flow_run_events where tenant_id = ${id}`,
      );
      await database.execute(
        sql`delete from group_pipeline_start_receipts where tenant_id = ${id}`,
      );
    });
  }
  await runAsTenant("platform", async () => {
    await database
      .delete(revokedAccess)
      .where(sql`${revokedAccess.email} like ${`${prefix}%`}`);
    const channelIds = createdChannels.splice(0);
    if (channelIds.length) {
      const linked = (await database.execute(
        sql`select waker_group_id from channels where id in ${channelIds} and waker_group_id is not null`,
      )) as unknown as { waker_group_id: string }[];
      createdGroups.push(...linked.map((row) => row.waker_group_id));
    }
    if (createdUsers.length) {
      const owned = await database
        .select({ id: wakerGroups.id })
        .from(wakerGroups)
        .where(inArray(wakerGroups.tenantId, createdUsers));
      createdGroups.push(...owned.map((row) => row.id));
    }
    const groupIds = [...new Set(createdGroups.splice(0))];
    if (groupIds.length) {
      await database.execute(
        sql`delete from portraits where subject_kind = 'group' and subject_id in ${groupIds}`,
      );
      await database.execute(
        sql`delete from portrait_media where subject_kind = 'group' and subject_id in ${groupIds}`,
      );
    }
    if (createdTasks.length)
      await database
        .delete(tasks)
        .where(inArray(tasks.id, createdTasks.splice(0)));
    for (const id of channelIds) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    if (groupIds.length)
      await database
        .delete(wakerGroups)
        .where(inArray(wakerGroups.id, groupIds));
    if (createdFlows.length)
      await database.execute(
        sql`delete from waker_flows where id in ${createdFlows.splice(0)}`,
      );
    if (createdAgents.length) {
      const ids = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    const userIds = createdUsers.splice(0);
    if (userIds.length) {
      await database.execute(
        sql`delete from usage_counters where tenant_id in ${userIds}`,
      );
      await database.delete(users).where(inArray(users.id, userIds));
    }
  });
});
afterAll(async () => {
  for (const side of sideClients.splice(0)) await side.$client.close();
  await database.$client.close();
});

async function person(name: string): Promise<AgentActor> {
  const id = `${prefix}-${name}-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Hand Over" }),
  );
  createdUsers.push(id);
  return { id, role: "user" };
}

const emailOf = (who: AgentActor) => `${who.id}@example.test`;

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

/**
 * What the groups service is in production (index.ts), minus the turns: no Bot answers here.
 * `beforeUse`, when given, runs as upstream asks whether a Bot may be used: after its checks on the
 * caller, before its write, which is where a test holds an addBots.
 */
function conversations(beforeUse?: () => Promise<void>) {
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
    canUseBot: async (ownerUserId, agentId) => {
      await beforeUse?.();
      return Boolean(
        await profileStore.get({ id: ownerUserId, role: "user" }, agentId),
      );
    },
    progressEveryMs: 0,
  });
}

/** A log the test reads, so the lines it expects stay out of the output. */
function collected() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (line: Record<string, unknown>) => lines.push(line) };
}

function linkCore(
  log?: (line: Record<string, unknown>) => void,
  store: Pick<typeof groupStore, "order" | "bots"> = groupStore,
) {
  return createWakerGroupLink({
    database,
    groupStore: store,
    ...(log ? { log } : {}),
  });
}

/**
 * A shared group made the way `POST /api/groups` makes one (so it comes back linked to a new crew of
 * the creator's), then the others added one after another: each later than the one before.
 */
async function linkedGroup(
  creator: AgentActor,
  others: AgentActor[] = [],
  botCount = 2,
) {
  const ids: string[] = [];
  for (let at = 0; at < botCount; at++)
    ids.push(await bot(creator, ["Ada", "Grace", "Linus", "Ken"][at] ?? "Bot"));
  const groups = withWakerGroupLink(conversations(), linkCore(), () => {});
  const channel = await runAsTenant(creator.id, () =>
    groups.create(creator.id, { agentIds: ids }),
  );
  const groupId = channel.wakerGroupId;
  if (!groupId) throw new Error("not linked");
  for (const other of others)
    await runAsTenant(creator.id, () =>
      conversations().addMember(creator.id, channel.id, {
        email: emailOf(other),
      }),
    );
  return { channelId: channel.id, groupId, bots: ids };
}

async function channelRow(channelId: string) {
  const rows = (await runAsTenant("platform", () =>
    database.execute(
      sql`select waker_group_id, title, created_by, deleted_at is not null as deleted
            from channels where id = ${channelId}`,
    ),
  )) as unknown as {
    waker_group_id: string | null;
    title: string | null;
    created_by: string | null;
    deleted: boolean;
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
  return (
    await runAsTenant("platform", () =>
      database
        .select({ agentId: wakerGroupMembers.agentId })
        .from(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, groupId))
        .orderBy(asc(sql`${wakerGroupMembers.position}::int`)),
    )
  ).map((row) => row.agentId);
}

/** Who is in the conversation, as `platform` reads it, earliest first. */
async function membersOf(channelId: string) {
  const rows = (await runAsTenant("platform", () =>
    database.execute(
      sql`select user_id from channel_memberships where channel_id = ${channelId} order by created_at, user_id`,
    ),
  )) as unknown as { user_id: string }[];
  return rows.map((row) => row.user_id);
}

/** The roster in the order the conversation answers, read in `frame`. */
async function truthIn(frame: string, channelId: string) {
  return runAsTenant(frame, async () =>
    runtimeOrder(
      await groupStore.order(channelId),
      await groupStore.bots(channelId),
    ),
  );
}

/** `xiongbao_team_channel_hand_over` in `frame`, the way the app calls it. */
async function handOver(frame: string, channelId: string) {
  const rows = (await runAsTenant(frame, () =>
    database.execute(
      sql`select public.xiongbao_team_channel_hand_over(${channelId}) as owner`,
    ),
  )) as unknown as { owner: string | null }[];
  return rows[0]?.owner ?? null;
}

/** Leave past the service, then ask for the hand-over: one transaction in the leaver's frame. */
async function leaveAndHandOver(who: AgentActor, channelId: string) {
  return runAsTenant(who.id, () =>
    database.transaction(async (tx) => {
      await tx.execute(
        sql`delete from channel_memberships where channel_id = ${channelId} and user_id = ${who.id}`,
      );
      const rows = (await tx.execute(
        sql`select public.xiongbao_team_channel_hand_over(${channelId}) as owner`,
      )) as unknown as { owner: string | null }[];
      return rows[0]?.owner ?? null;
    }),
  );
}

/** What a write threw: its SQLSTATE and the database's own words. */
async function failure(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return {
      code: stateOf(error),
      message: cause?.message ?? (error as Error).message,
    };
  }
  throw new Error("expected a failure");
}

/**
 * A crew's flow as the pipeline leaves one: a template, a parent card, two step cards filed under it,
 * the run that points at all three, and an archive stamp on the parent. Written in the owner's frame.
 */
async function runWithCards(
  owner: AgentActor,
  groupId: string,
  status: "done" | "running" | "awaiting_action",
) {
  return runAsTenant(owner.id, async () => {
    const [template] = await database
      .insert(groupTaskTemplates)
      .values({ groupId, name: `流程-${randomUUID()}`, steps: [] })
      .returning({ id: groupTaskTemplates.id });
    const [parent] = await database
      .insert(tasks)
      .values({ title: "周报（父卡）", source: "group_run", status: "done" })
      .returning({ id: tasks.id });
    if (!template || !parent) throw new Error("flow not written");
    const steps = await database
      .insert(tasks)
      .values([
        {
          title: "周报（第 1 步）",
          source: "group_run",
          status: "done",
          parentTaskId: parent.id,
        },
        {
          title: "周报（第 2 步）",
          source: "group_run",
          status: "done",
          parentTaskId: parent.id,
        },
      ])
      .returning({ id: tasks.id });
    createdTasks.push(parent.id, ...steps.map((step) => step.id));
    const [run] = await database
      .insert(groupTaskRuns)
      .values({
        templateId: template.id,
        groupId,
        parentTaskId: parent.id,
        status,
        steps: steps.map((step, at) => ({
          id: `s${at + 1}`,
          agentId: "",
          instruction: `第 ${at + 1} 步`,
          state: "done" as const,
          taskId: step.id,
        })),
      })
      .returning({ id: groupTaskRuns.id });
    if (!run) throw new Error("run not written");
    await database.execute(
      sql`insert into task_archives (tenant_id, task_id, archived_by) values (${owner.id}, ${parent.id}, ${owner.id})`,
    );
    return {
      templateId: template.id,
      runId: run.id,
      cardIds: [parent.id, ...steps.map((step) => step.id)],
    };
  });
}

/** Whose each of the crew's rows is, as `platform` reads them. */
async function stamps(
  groupId: string,
  flow: { templateId: string; runId: string; cardIds: string[] },
) {
  const column = async (query: ReturnType<typeof sql>) =>
    (
      (await runAsTenant("platform", () =>
        database.execute(query),
      )) as unknown as { tenant_id: string }[]
    ).map((row) => row.tenant_id);
  return {
    crew: await column(
      sql`select tenant_id from waker_groups where id = ${groupId}::uuid`,
    ),
    portrait: await column(
      sql`select tenant_id from portraits where subject_kind = 'group' and subject_id = ${groupId}`,
    ),
    video: await column(
      sql`select tenant_id from portrait_media where subject_kind = 'group' and subject_id = ${groupId}`,
    ),
    template: await column(
      sql`select tenant_id from group_task_templates where id = ${flow.templateId}::uuid`,
    ),
    run: await column(
      sql`select tenant_id from group_task_runs where id = ${flow.runId}::uuid`,
    ),
    cards: await column(
      sql`select tenant_id from tasks where id in ${flow.cardIds} order by title`,
    ),
    archive: await column(
      sql`select tenant_id from task_archives where task_id in ${flow.cardIds}`,
    ),
  };
}

async function portray(owner: AgentActor, groupId: string) {
  await runAsTenant(owner.id, async () => {
    await database
      .insert(portraits)
      .values({ subjectKind: "group", subjectId: groupId, preset: "cute" });
    await database.insert(portraitMedia).values({
      subjectKind: "group",
      subjectId: groupId,
      contentType: "video/mp4",
      bytes: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
    });
  });
}

/** The board as a person reads it: `GET /api/tasks?group=`. */
const board = createTaskRoutes(
  database,
  async (context, next) => {
    const actor = context.req.header("x-actor") ?? "";
    context.set("actor", { id: actor, role: "user" } as never);
    await runAsTenant(actor, () => next());
  },
  {
    reviewed: async () => true,
    archived: async () => true,
  } as unknown as TaskProjector,
);

async function boardTitles(who: AgentActor, groupId: string) {
  const response = await board.request(
    new Request(`http://openbot.test/?group=${groupId}`, {
      headers: { "x-actor": who.id },
    }),
  );
  const body = (await response.json()) as { tasks: { title: string }[] };
  return body.tasks.map((task) => task.title).sort();
}

/** The three ways a person is deactivated in production, each through its real code. */
const deactivate = {
  scim: (who: AgentActor) =>
    runAsTenant("platform", () =>
      reconcileDirectoryState(
        { database, initialAdminEmails: [] },
        { userId: who.id, active: false },
      ),
    ),
  admin: async (who: AgentActor) => {
    const admin = `${prefix}-admin`;
    await runAsTenant(admin, () => people.revoke(who.id, admin));
  },
  operator: async (who: AgentActor) => {
    await suspendTenant(database, who.id, {
      id: `${prefix}-operator`,
      email: "operator@example.test",
    });
  },
};

describe("hand-over function (0207)", () => {
  test("the journal registers 0207 after 0206", async () => {
    const journal = (await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/meta/_journal.json",
        import.meta.url,
      ),
    ).json()) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entry = journal.entries.find((item) => item.idx === 207);
    expect(entry?.tag).toBe("0207_team_channel_hand_over");
    expect(entry?.when ?? 0).toBeGreaterThan(1794537806196);
  });

  test("a creator who leaves hands the group to the earliest member still in it", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId } = await linkedGroup(alice, [bob, carol]);

    expect(await leaveAndHandOver(alice, channelId)).toBe(bob.id);

    expect((await channelRow(channelId)).created_by).toBe(bob.id);
    const seen = await runAsTenant(bob.id, () => groupStore.people(channelId));
    expect(seen[0]?.userId).toBe(bob.id);
  });

  test("members who joined at the same moment are ordered by email", async () => {
    const alice = await person("alice");
    const zed = await person("zed");
    const amy = await person("amy");
    const { channelId } = await linkedGroup(alice);
    // The larger address first, so insertion order cannot be what decides.
    await runAsTenant("platform", () =>
      database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id, created_at)
            values (${channelId}, ${zed.id}, 'team', '2026-01-01T00:00:00Z'),
                   (${channelId}, ${amy.id}, 'team', '2026-01-01T00:00:00Z')`,
      ),
    );

    expect(await leaveAndHandOver(alice, channelId)).toBe(amy.id);
    const seen = await runAsTenant(amy.id, () => groupStore.people(channelId));
    expect(seen[0]?.userId).toBe(amy.id);
  });

  test("everything moves to the heir: crew, portrait, video, templates, runs, their cards and archive stamps", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId, groupId } = await linkedGroup(alice, [bob, carol], 3);
    await portray(alice, groupId);
    const flow = await runWithCards(alice, groupId, "done");
    const metric = `${prefix}-tasks`;
    await runAsTenant(alice.id, () =>
      database.execute(
        sql`insert into usage_counters (period, metric, value) values ('2026-11', ${metric}, 7)`,
      ),
    );
    const mirrored = await mirror(groupId);
    expect(mirrored).toHaveLength(3);
    expect(await boardTitles(alice, groupId)).toEqual([
      "周报（父卡）",
      "周报（第 1 步）",
      "周报（第 2 步）",
    ]);

    expect(await leaveAndHandOver(alice, channelId)).toBe(bob.id);

    expect(await stamps(groupId, flow)).toEqual({
      crew: [bob.id],
      portrait: [bob.id],
      video: [bob.id],
      template: [bob.id],
      run: [bob.id],
      cards: [bob.id, bob.id, bob.id],
      archive: [bob.id],
    });
    expect(await mirror(groupId)).toEqual(mirrored);
    const bobs = await runAsTenant(bob.id, () => crewStore.list());
    expect(bobs.find((item) => item.id === groupId)?.channelId).toBe(channelId);
    expect(await boardTitles(bob, groupId)).toEqual([
      "周报（父卡）",
      "周报（第 1 步）",
      "周报（第 2 步）",
    ]);
    const alices = await runAsTenant(alice.id, () => crewStore.list());
    expect(alices.some((item) => item.id === groupId)).toBe(false);
    expect(await boardTitles(alice, groupId)).toEqual([]);
    // What the runs already spent stays with who spent it.
    const spent = (await runAsTenant("platform", () =>
      database.execute(
        sql`select tenant_id, value from usage_counters where metric = ${metric}`,
      ),
    )) as unknown as { tenant_id: string; value: number }[];
    expect(spent).toEqual([{ tenant_id: alice.id, value: 7 }]);
  });

  test("the run's coordination rows move too", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const flow = await runWithCards(alice, groupId, "done");
    // The receipt has only its owner's own policies, so it is written in Alice's frame; an event row
    // needs its run to be the flow's, which only `platform` writes past.
    await runAsTenant(alice.id, () =>
      database.execute(
        sql`insert into group_pipeline_start_receipts
              (tenant_id, request_id, fingerprint, template_id, template_snapshot, task, run_id)
            values (${alice.id}, ${randomUUID()}::uuid, ${"a".repeat(64)}, ${flow.templateId}::uuid, '{}', '周报', ${flow.runId}::uuid)`,
      ),
    );
    await runAsTenant("platform", async () => {
      const [made] = (await database.execute(
        sql`insert into waker_flows (tenant_id, name) values (${alice.id}, ${`${prefix}-flow`}) returning id`,
      )) as unknown as { id: string }[];
      if (!made) throw new Error("flow not written");
      createdFlows.push(made.id);
      await database.execute(
        sql`insert into flow_run_events (tenant_id, flow_id, run_id, correlation_id, type, payload)
            values (${alice.id}, ${made.id}::uuid, ${flow.runId}::uuid, 'c-1', 'run_started', '{}')`,
      );
    });

    expect(await leaveAndHandOver(alice, channelId)).toBe(bob.id);

    const stamped = async (frame: string) =>
      (await runAsTenant(frame, () =>
        database.execute(
          sql`select 'receipt' as kind, tenant_id from group_pipeline_start_receipts where run_id = ${flow.runId}::uuid
              union all
              select 'event', tenant_id from flow_run_events where run_id = ${flow.runId}::uuid`,
        ),
      )) as unknown as { kind: string; tenant_id: string }[];
    expect(await stamped(bob.id)).toEqual([
      { kind: "receipt", tenant_id: bob.id },
      { kind: "event", tenant_id: bob.id },
    ]);
    expect(await stamped(alice.id)).toEqual([]);
  });

  test("cards of another tenant or another crew stay put", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    await runWithCards(alice, groupId, "done");
    const other = await crew(alice, "另一个群组");
    const otherFlow = await runWithCards(alice, other, "done");
    const [own] = await runAsTenant(bob.id, () =>
      database
        .insert(tasks)
        .values({ title: "鲍勃自己的", source: "chat" })
        .returning({ id: tasks.id }),
    );
    if (!own) throw new Error("card not written");
    createdTasks.push(own.id);

    expect(await leaveAndHandOver(alice, channelId)).toBe(bob.id);

    const otherStamps = await stamps(other, otherFlow);
    expect(otherStamps.crew).toEqual([alice.id]);
    expect(otherStamps.run).toEqual([alice.id]);
    expect(otherStamps.cards).toEqual([alice.id, alice.id, alice.id]);
    expect(otherStamps.archive).toEqual([alice.id]);
    const [mine] = await runAsTenant("platform", () =>
      database
        .select({ tenantId: tasks.tenantId })
        .from(tasks)
        .where(eq(tasks.id, own.id)),
    );
    expect(mine?.tenantId).toBe(bob.id);
  });

  test("a name the heir already uses gets （2）, and the chat keeps its title", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const name = (await crewRow(groupId))?.name ?? "";
    const title = (await channelRow(channelId)).title;
    await crew(bob, name);

    expect(await leaveAndHandOver(alice, channelId)).toBe(bob.id);

    expect(await crewRow(groupId)).toEqual({
      name: `${name}（2）`,
      tenantId: bob.id,
    });
    expect((await channelRow(channelId)).title).toBe(title);
  });

  for (const status of ["running", "awaiting_action"] as const) {
    test(`nothing moves while a crew run is still going (${status})`, async () => {
      const alice = await person("alice");
      const bob = await person("bob");
      const { channelId, groupId } = await linkedGroup(alice, [bob]);
      const flow = await runWithCards(alice, groupId, status);

      const refused = await failure(() => leaveAndHandOver(alice, channelId));

      expect(refused.code).toBe("55006");
      expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
      expect((await channelRow(channelId)).created_by).toBe(alice.id);
      const left = await stamps(groupId, flow);
      expect(left.crew).toEqual([alice.id]);
      expect(left.template).toEqual([alice.id]);
      expect(left.run).toEqual([alice.id]);
      expect(left.cards).toEqual([alice.id, alice.id, alice.id]);
    });
  }

  test("while the creator is in and active, a member's call changes nothing", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    // Even with a run going: there is nothing to hand over, so nothing is refused either.
    await runWithCards(alice, groupId, "running");
    const touched = async () =>
      (
        (await runAsTenant("platform", () =>
          database.execute(
            sql`select updated_at::text as at from waker_groups where id = ${groupId}::uuid`,
          ),
        )) as unknown as { at: string }[]
      )[0]?.at;
    const before = await touched();

    expect(await handOver(bob.id, channelId)).toBe(alice.id);

    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);
    expect(await touched()).toBe(before);
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
  });

  test("a stranger is refused the same way whether or not the group exists", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId } = await linkedGroup(alice, [bob]);
    await runAsTenant(alice.id, () =>
      database.execute(
        sql`delete from channel_memberships where channel_id = ${channelId} and user_id = ${alice.id}`,
      ),
    );

    const real = await failure(() => handOver(carol.id, channelId));
    const made = await failure(() => handOver(carol.id, `${prefix}-nothing`));

    expect(real).toEqual({
      code: "42501",
      message: "only a member hands a shared group over",
    });
    expect(made).toEqual(real);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
  });

  test("the last one out leaves the chat deleted and the crew with them", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);
    const flow = await runWithCards(alice, groupId, "done");

    expect(await leaveAndHandOver(alice, channelId)).toBeNull();

    const row = await channelRow(channelId);
    expect(row.deleted).toBe(true);
    expect(row.waker_group_id).toBe(groupId);
    expect(row.created_by).toBe(alice.id);
    const left = await stamps(groupId, flow);
    expect(left.crew).toEqual([alice.id]);
    expect(left.run).toEqual([alice.id]);
    expect(left.cards).toEqual([alice.id, alice.id, alice.id]);
    const listed = await runAsTenant(alice.id, () => crewStore.list());
    expect(listed.find((item) => item.id === groupId)?.channelId).toBeNull();
  });

  test("with only deactivated members left, nothing moves and the chat stays", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    await deactivate.scim(bob);
    expect(await membersOf(channelId)).toEqual([alice.id]);
    // Added back past every service: the only way a deactivated person is in a group.
    await runAsTenant("platform", () =>
      database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id) values (${channelId}, ${bob.id}, 'team')`,
      ),
    );

    expect(await leaveAndHandOver(alice, channelId)).toBe(alice.id);

    const row = await channelRow(channelId);
    expect(row.deleted).toBe(false);
    expect(row.created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);
  });

  test("the last one out is refused while a crew run is going, and the chat stays", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);
    const flow = await runWithCards(alice, groupId, "running");

    const refused = await failure(() => leaveAndHandOver(alice, channelId));

    expect(refused.code).toBe("55006");
    expect(await membersOf(channelId)).toEqual([alice.id]);
    const row = await channelRow(channelId);
    expect(row.deleted).toBe(false);
    expect(row.created_by).toBe(alice.id);
    expect((await stamps(groupId, flow)).run).toEqual([alice.id]);
  });

  test("with only deactivated members left, a leave is refused while a crew run is going", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    await deactivate.scim(bob);
    await runAsTenant("platform", () =>
      database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id) values (${channelId}, ${bob.id}, 'team')`,
      ),
    );
    await runWithCards(alice, groupId, "running");

    const refused = await failure(() => leaveAndHandOver(alice, channelId));

    expect(refused.code).toBe("55006");
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
    const row = await channelRow(channelId);
    expect(row.deleted).toBe(false);
    expect(row.created_by).toBe(alice.id);
  });

  test("a personal channel and a shared group with no creator are left alone", async () => {
    const alice = await person("alice");
    const [ada, grace] = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const personal = `${prefix}-personal-${randomUUID()}`;
    const ownerless = `${prefix}-ownerless-${randomUUID()}`;
    await runAsTenant("platform", async () => {
      await database.execute(
        sql`insert into channels (id, tenant_id, name, description, created_by)
            values (${personal}, ${alice.id}, 'Ada、Grace', 'legacy', ${alice.id}),
                   (${ownerless}, 'team', 'Ada、Grace', 'legacy', null)`,
      );
      await database.insert(channelAgents).values([
        { channelId: personal, agentId: ada, tenantId: alice.id },
        { channelId: personal, agentId: grace, tenantId: alice.id },
      ]);
    });
    createdChannels.push(personal, ownerless);

    expect(await handOver("platform", personal)).toBeNull();
    expect(await handOver("platform", ownerless)).toBeNull();
    expect((await channelRow(personal)).created_by).toBe(alice.id);
    expect((await channelRow(ownerless)).created_by).toBeNull();
    expect((await channelRow(ownerless)).deleted).toBe(false);
  });

  test("platform can hand over a group whose creator was removed past the service", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    await runAsTenant("platform", () =>
      database.execute(
        sql`delete from channel_memberships where channel_id = ${channelId} and user_id = ${alice.id}`,
      ),
    );

    expect(await handOver("platform", channelId)).toBe(bob.id);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
  });

  test("the guards still refuse a direct created_by change, and only the outer function is the app's", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const take = (frame: string) =>
      failure(() =>
        runAsTenant(frame, () =>
          database.execute(
            sql`update channels set created_by = ${bob.id} where id = ${channelId}`,
          ),
        ),
      );

    expect((await take(bob.id)).code).toBe("42501");
    expect((await take(alice.id)).code).toBe("42501");
    for (const call of [
      sql`select public.openbot_team_channel_hand_over_write(${channelId}, ${alice.id}, ${bob.id}, ${groupId}::uuid)`,
      sql`select public.openbot_team_channel_hand_over_core(${channelId})`,
      sql`select public.openbot_team_person_leaves_groups(${alice.id})`,
    ]) {
      const denied = await failure(() =>
        runAsTenant(alice.id, () => database.execute(call)),
      );
      expect(denied.code).toBe("42501");
      expect(denied.message).toContain("permission denied");
    }
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
  });

  test("the functions are definer, pin search_path, and only one is granted", async () => {
    const functions = (await runAsTenant("platform", () =>
      database.execute(
        sql`select p.proname as name, p.prosecdef as definer, p.proconfig as config,
                   has_function_privilege('openbot_app', p.oid, 'EXECUTE') as app,
                   has_function_privilege('public', p.oid, 'EXECUTE') as everyone
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in (
               'openbot_team_channel_hand_over_write', 'openbot_team_channel_hand_over_core',
               'xiongbao_team_channel_hand_over', 'openbot_team_person_leaves_groups',
               'openbot_team_revoked_leaves')
             order by 1`,
      ),
    )) as unknown as {
      name: string;
      definer: boolean;
      config: string[] | null;
      app: boolean;
      everyone: boolean;
    }[];

    expect(functions.map((fn) => fn.name)).toEqual([
      "openbot_team_channel_hand_over_core",
      "openbot_team_channel_hand_over_write",
      "openbot_team_person_leaves_groups",
      "openbot_team_revoked_leaves",
      "xiongbao_team_channel_hand_over",
    ]);
    for (const fn of functions) {
      expect(fn.definer).toBe(true);
      expect(
        (fn.config ?? []).some((setting) => setting.startsWith("search_path=")),
      ).toBe(true);
      expect(fn.everyone).toBe(false);
      expect(fn.app).toBe(fn.name === "xiongbao_team_channel_hand_over");
    }
    expect(
      functions.find((fn) => fn.name === "openbot_team_channel_hand_over_write")
        ?.config,
    ).toContain("app.tenant_id=platform");

    const triggers = (await runAsTenant("platform", () =>
      database.execute(
        sql`select c.relname as "table", t.tgtype as type, t.tgenabled as enabled
              from pg_trigger t join pg_class c on c.oid = t.tgrelid
             where t.tgname = 'openbot_team_revoked_leaves' and not t.tgisinternal`,
      ),
    )) as unknown as { table: string; type: number; enabled: string }[];
    // ROW (1) | INSERT (4), and not BEFORE (2): after the row is in.
    expect(triggers).toEqual([
      { table: "revoked_access", type: 1 | 4, enabled: "O" },
    ]);
  });

  test("the lookups a deactivation makes by person have indexes", async () => {
    const indexes = (await runAsTenant("platform", () =>
      database.execute(
        sql`select indexdef from pg_indexes
             where schemaname = 'public' and indexname in (
               'channel_memberships_user_idx', 'channels_team_created_by_idx', 'users_lower_email_idx')
             order by indexname`,
      ),
    )) as unknown as { indexdef: string }[];

    expect(indexes.map((row) => row.indexdef)).toEqual([
      "CREATE INDEX channel_memberships_user_idx ON public.channel_memberships USING btree (user_id)",
      "CREATE INDEX channels_team_created_by_idx ON public.channels USING btree (created_by) WHERE (tenant_id = 'team'::text)",
      "CREATE INDEX users_lower_email_idx ON public.users USING btree (lower(email))",
    ]);
  });
});

describe("deactivation (0207 trigger)", () => {
  async function threeWithAFlow() {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const made = await linkedGroup(alice, [bob, carol]);
    const flow = await runWithCards(alice, made.groupId, "done");
    return { alice, bob, carol, ...made, flow };
  }

  async function expectHandedToBob(
    made: Awaited<ReturnType<typeof threeWithAFlow>>,
  ) {
    expect((await channelRow(made.channelId)).created_by).toBe(made.bob.id);
    expect(await membersOf(made.channelId)).toEqual([
      made.bob.id,
      made.carol.id,
    ]);
    const moved = await stamps(made.groupId, made.flow);
    expect(moved.crew).toEqual([made.bob.id]);
    expect(moved.run).toEqual([made.bob.id]);
    expect(moved.cards).toEqual([made.bob.id, made.bob.id, made.bob.id]);
  }

  test("a SCIM deactivation hands the creator's group to the earliest active member in the same write", async () => {
    const made = await threeWithAFlow();

    await deactivate.scim(made.alice);

    // Read at once, not after the deferred offboarding: the hand-over is part of the insert.
    await expectHandedToBob(made);
  });

  test("an administrator's removal does the same, inside its transaction", async () => {
    const made = await threeWithAFlow();

    await deactivate.admin(made.alice);

    await expectHandedToBob(made);
  });

  test("a removal whose transaction fails after the insert moves nothing", async () => {
    const made = await threeWithAFlow();

    const thrown = await runAsTenant(`${prefix}-admin`, () =>
      database.transaction(async (tx) => {
        await tx
          .insert(revokedAccess)
          .values({ email: emailOf(made.alice), revokedBy: `${prefix}-admin` });
        throw new Error("the rest of the removal failed");
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((await channelRow(made.channelId)).created_by).toBe(made.alice.id);
    expect(await membersOf(made.channelId)).toEqual([
      made.alice.id,
      made.bob.id,
      made.carol.id,
    ]);
    expect((await crewRow(made.groupId))?.tenantId).toBe(made.alice.id);
  });

  test("an operator's tenant suspension does the same", async () => {
    const made = await threeWithAFlow();

    await deactivate.operator(made.alice);

    await expectHandedToBob(made);
  });

  test("the earliest member who is deactivated is skipped, and leaves the group", async () => {
    const made = await threeWithAFlow();
    const joined = (await runAsTenant("platform", () =>
      database.execute(
        sql`select created_at::text as at from channel_memberships
             where channel_id = ${made.channelId} and user_id = ${made.bob.id}`,
      ),
    )) as unknown as { at: string }[];

    await deactivate.scim(made.bob);

    expect(await membersOf(made.channelId)).toEqual([
      made.alice.id,
      made.carol.id,
    ]);
    expect((await channelRow(made.channelId)).created_by).toBe(made.alice.id);
    expect(
      await runAsTenant(made.bob.id, () => groupStore.people(made.channelId)),
    ).toEqual([]);
    // Put back where he was, past every service: still the earliest, still deactivated.
    await runAsTenant("platform", () =>
      database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id, created_at)
            values (${made.channelId}, ${made.bob.id}, 'team', ${joined[0]?.at}::timestamptz)`,
      ),
    );

    expect(await leaveAndHandOver(made.alice, made.channelId)).toBe(
      made.carol.id,
    );
    expect((await crewRow(made.groupId))?.tenantId).toBe(made.carol.id);
  });

  test("a deactivated member who did not start the group just leaves it", async () => {
    const made = await threeWithAFlow();

    await deactivate.scim(made.carol);

    expect(await membersOf(made.channelId)).toEqual([
      made.alice.id,
      made.bob.id,
    ]);
    expect((await channelRow(made.channelId)).created_by).toBe(made.alice.id);
    expect((await crewRow(made.groupId))?.tenantId).toBe(made.alice.id);
  });

  test("a deactivated creator alone leaves the chat deleted and keeps the crew", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);

    await deactivate.scim(alice);

    const row = await channelRow(channelId);
    expect(row.deleted).toBe(true);
    expect(row.created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);
    const listed = await runAsTenant(alice.id, () =>
      crewActions().list(alice.id),
    );
    expect(listed.find((item) => item.id === groupId)?.chatStatus).toBe(
      "not_started",
    );
  });

  test("a chat already deleted is not handed over, so the crew stays with whoever owns its new chat", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    // Deleted the old way (DELETE /api/channels/:id): the crew stays, "not started", and opens anew.
    await runAsTenant(alice.id, () =>
      channelStore.softDelete(alice, channelId),
    );
    const opened = await runAsTenant(alice.id, () =>
      crewActions().startChat(alice.id, groupId),
    );
    if (!opened) throw new Error("no new chat");
    createdChannels.push(opened.channel.id);

    await deactivate.scim(alice);

    // The old chat's member does not take the crew from the chat it now belongs to.
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);
    expect((await channelRow(opened.channel.id)).deleted).toBe(true);
    expect(await membersOf(channelId)).toEqual([bob.id]);
  });

  test("a running flow does not block a deactivation; the hand-over waits for a heal", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const flow = await runWithCards(alice, groupId, "running");

    await deactivate.scim(alice);

    expect(await deniedEmails([alice])).toEqual([emailOf(alice)]);
    expect(await membersOf(channelId)).toEqual([bob.id]);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);

    await runAsTenant("platform", () =>
      database
        .update(groupTaskRuns)
        .set({ status: "done" })
        .where(eq(groupTaskRuns.id, flow.runId)),
    );
    const api = crewApi();
    const opened = await api(bob, "POST", `/for-channel/${channelId}`);
    expect(opened.status).toBe(200);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    expect((await stamps(groupId, flow)).run).toEqual([bob.id]);
  });

  test("a deactivated creator alone with a crew run going still leaves the chat deleted", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);
    const flow = await runWithCards(alice, groupId, "running");

    await deactivate.scim(alice);

    expect(await deniedEmails([alice])).toEqual([emailOf(alice)]);
    expect(await membersOf(channelId)).toEqual([]);
    const row = await channelRow(channelId);
    expect(row.deleted).toBe(true);
    expect(row.created_by).toBe(alice.id);
    expect((await stamps(groupId, flow)).run).toEqual([alice.id]);
  });

  test("a hand-over that fails for another reason does not fail the deactivation, and waits for a heal", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const flow = await runWithCards(alice, groupId, "done");
    // A template of this crew already under Bob, by the same name: the crew went to him and back.
    const left = (await runAsTenant("platform", () =>
      database.execute(
        sql`insert into group_task_templates (tenant_id, group_id, name, steps)
            select ${bob.id}, group_id, name, '[]'::jsonb from group_task_templates
             where id = ${flow.templateId}::uuid
            returning id`,
      ),
    )) as unknown as { id: string }[];

    await deactivate.scim(alice);

    expect(await deniedEmails([alice])).toEqual([emailOf(alice)]);
    expect(await membersOf(channelId)).toEqual([bob.id]);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect((await stamps(groupId, flow)).crew).toEqual([alice.id]);

    // The next heal, once the clash is gone, hands it over.
    await runAsTenant("platform", () =>
      database.execute(
        sql`delete from group_task_templates where id = ${left[0]?.id ?? ""}::uuid`,
      ),
    );
    const opened = await crewApi()(bob, "POST", `/for-channel/${channelId}`);
    expect(opened.status).toBe(200);
    expect((await channelRow(channelId)).created_by).toBe(bob.id);
    expect((await stamps(groupId, flow)).template).toEqual([bob.id]);
  });

  test("a deactivation whose leaving cannot get its locks in time still deactivates", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId } = await linkedGroup(alice, [bob]);
    const holder = sideClient();
    const remover = sideClient();
    const holding = gate();
    const done = gate();
    // Someone holds Alice's membership row; the deactivating request waits at most a moment.
    const held = runAsTenant("platform", () =>
      holder.client.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from channel_memberships
               where channel_id = ${channelId} and user_id = ${alice.id} for update`,
        );
        holding.open();
        await done.shut;
      }),
    );
    await holding.shut;

    const removed = await runAsTenant("platform", () =>
      remover.client.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        await tx
          .insert(revokedAccess)
          .values({ email: emailOf(alice), revokedBy: "test" });
      }),
    ).then(
      () => null,
      (error: unknown) => stateOf(error) ?? String(error),
    );
    done.open();
    await held;

    expect(removed).toBeNull();
    expect(await deniedEmails([alice])).toEqual([emailOf(alice)]);
    // She is out of reach; leaving the group waits for the next heal of its owner.
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    const opened = await crewApi()(bob, "POST", `/for-channel/${channelId}`);
    expect(opened.status).toBe(200);
    expect((await channelRow(channelId)).created_by).toBe(bob.id);
  });

  test("a deactivation and the same person's leave at once both go through", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId, groupId } = await linkedGroup(alice, [bob, carol]);
    const leaver = sideClient();
    const remover = sideClient();
    const locked = gate();
    const go = gate();
    // A leave as `link.leave` takes its locks: the channel row, then the leaver's membership.
    const leaving = runAsTenant(alice.id, () =>
      leaver.client.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from channels where id = ${channelId} and deleted_at is null for update`,
        );
        locked.open();
        await go.shut;
        await tx.execute(
          sql`delete from channel_memberships where channel_id = ${channelId} and user_id = ${alice.id}`,
        );
        const rows = (await tx.execute(
          sql`select public.xiongbao_team_channel_hand_over(${channelId}) as owner`,
        )) as unknown as { owner: string | null }[];
        return rows[0]?.owner ?? null;
      }),
    );
    await locked.shut;
    const removing = runAsTenant("platform", async () => {
      await remover.client
        .insert(revokedAccess)
        .values({ email: emailOf(alice), revokedBy: "test" });
    });
    const removerWaited = await waitsOnALock(remover.name);
    // What the deactivation holds while it waits: not her membership row, which the leave deletes
    // next. Holding it there is the other order, and a deadlock.
    const free = (await runAsTenant("platform", () =>
      database.transaction(
        (tx) =>
          tx.execute(
            sql`select 1 from channel_memberships
                 where channel_id = ${channelId} and user_id = ${alice.id} for update skip locked`,
          ) as unknown as Promise<unknown[]>,
      ),
    )) as unknown[];
    go.open();

    const [left, removed] = await Promise.allSettled([leaving, removing]);

    expect(removerWaited).toBe(true);
    expect(free).toHaveLength(1);
    // A refusal shows as its SQLSTATE (a deadlock is 40P01).
    const outcome = (settled: PromiseSettledResult<unknown>) =>
      settled.status === "fulfilled"
        ? settled.value
        : (stateOf(settled.reason) ?? String(settled.reason));
    expect(outcome(left)).toBe(bob.id);
    expect(outcome(removed)).toBeUndefined();
    expect(await deniedEmails([alice])).toEqual([emailOf(alice)]);
    expect(await membersOf(channelId)).toEqual([bob.id, carol.id]);
    expect((await channelRow(channelId)).created_by).toBe(bob.id);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
  });

  test("restoring the account gives nothing back", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const settled = async () => {
      expect((await channelRow(channelId)).created_by).toBe(bob.id);
      expect(await membersOf(channelId)).toEqual([bob.id]);
      expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    };

    await deactivate.scim(alice);
    await settled();
    await runAsTenant("platform", () =>
      reconcileDirectoryState(
        { database, initialAdminEmails: [] },
        { userId: alice.id, active: true },
      ),
    );
    expect(await deniedEmails([alice])).toEqual([]);
    await settled();

    await deactivate.admin(alice);
    await runAsTenant(`${prefix}-admin`, () => people.restore(alice.id));
    expect(await deniedEmails([alice])).toEqual([]);
    await settled();

    await deactivate.operator(alice);
    await restoreTenant(database, alice.id);
    expect(await deniedEmails([alice])).toEqual([]);
    await settled();
  });

  test("a second deactivation of the same person does nothing more", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId, groupId } = await linkedGroup(bob, [carol]);
    await deactivate.scim(alice);
    // Added back past every service after the first one.
    await runAsTenant("platform", () =>
      database.execute(
        sql`insert into channel_memberships (channel_id, user_id, tenant_id) values (${channelId}, ${alice.id}, 'team')`,
      ),
    );

    await deactivate.admin(alice);
    await deactivate.operator(alice);

    expect(await deniedEmails([alice])).toEqual([emailOf(alice)]);
    expect(await membersOf(channelId)).toEqual([bob.id, carol.id, alice.id]);
    expect((await channelRow(channelId)).created_by).toBe(bob.id);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
  });

  test("an address with no account is deny-listed and nothing else happens", async () => {
    const nobody = `${prefix}-nobody@example.test`;

    await runAsTenant("platform", () =>
      database
        .insert(revokedAccess)
        .values({ email: nobody, revokedBy: "test" }),
    );

    const rows = await runAsTenant("platform", () =>
      database
        .select({ email: revokedAccess.email })
        .from(revokedAccess)
        .where(eq(revokedAccess.email, nobody)),
    );
    expect(rows).toEqual([{ email: nobody }]);
  });

  test("0207 hands over for people deactivated before it", async () => {
    const made = await threeWithAFlow();
    const migration = await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/sql/0207_team_channel_hand_over.sql",
        import.meta.url,
      ),
    ).text();
    const backfill = migration.split("--> statement-breakpoint").at(-1) ?? "";
    expect(backfill).toContain("openbot_team_person_leaves_groups(uid)");
    const owner = ownerConnection();
    class Rollback extends Error {}
    let before: { creator: unknown; members: unknown[] } | null = null;
    let after: typeof before = null;
    const read = async (tx: SQL) => ({
      creator: (
        await tx`select created_by from channels where id = ${made.channelId}`
      )[0]?.created_by,
      members: (
        await tx`select user_id from channel_memberships where channel_id = ${made.channelId} order by created_at`
      ).map((row: { user_id: string }) => row.user_id),
    });
    try {
      await owner.begin(async (tx) => {
        // As a deployment that deny-listed her before 0207 existed.
        await tx`alter table revoked_access disable trigger openbot_team_revoked_leaves`;
        await tx`insert into revoked_access (email, revoked_by) values (${emailOf(made.alice)}, 'before-0207')`;
        await tx`alter table revoked_access enable trigger openbot_team_revoked_leaves`;
        before = await read(tx as unknown as SQL);
        await tx.unsafe(backfill);
        after = await read(tx as unknown as SQL);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await owner.close();
    }

    expect(before).toEqual({
      creator: made.alice.id,
      members: [made.alice.id, made.bob.id, made.carol.id],
    });
    expect(after).toEqual({
      creator: made.bob.id,
      members: [made.bob.id, made.carol.id],
    });
    // Rolled back: the shared database is as it was.
    expect((await channelRow(made.channelId)).created_by).toBe(made.alice.id);
  });

  test("0207's backfill run a second time changes nothing", async () => {
    // One group handed over, one put off by a running flow: the two states a first run leaves.
    const made = await threeWithAFlow();
    const later = await linkedGroup(made.alice, [made.bob]);
    const going = await runWithCards(made.alice, later.groupId, "running");
    const channelIds = [made.channelId, later.channelId];
    const groupIds = [made.groupId, later.groupId];
    const cardIds = [...made.flow.cardIds, ...going.cardIds];
    const migration = await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/sql/0207_team_channel_hand_over.sql",
        import.meta.url,
      ),
    ).text();
    const backfill = migration.split("--> statement-breakpoint").at(-1) ?? "";
    expect(backfill).toContain("openbot_team_person_leaves_groups(uid)");
    const owner = ownerConnection();
    class Rollback extends Error {}
    const plain = (rows: object[]) => [...rows].map((row) => ({ ...row }));
    // Every row a run could touch, with its physical place: any update, even a no-op one, moves it.
    const read = async (tx: SQL) => ({
      channels: plain(
        await tx`select id, ctid::text as at, created_by, deleted_at from channels
                  where id in ${tx(channelIds)} order by id`,
      ),
      members: plain(
        await tx`select channel_id, user_id, ctid::text as at from channel_memberships
                  where channel_id in ${tx(channelIds)} order by channel_id, user_id`,
      ),
      crews: plain(
        await tx`select id::text, tenant_id, name, ctid::text as at from waker_groups
                  where id::text in ${tx(groupIds)} order by id`,
      ),
      runs: plain(
        await tx`select id::text, tenant_id, ctid::text as at from group_task_runs
                  where group_id::text in ${tx(groupIds)} order by id`,
      ),
      cards: plain(
        await tx`select id::text, tenant_id, ctid::text as at from tasks
                  where id::text in ${tx(cardIds)} order by id`,
      ),
    });
    let once: Awaited<ReturnType<typeof read>> | null = null;
    let twice: typeof once = null;
    try {
      await owner.begin(async (tx) => {
        await tx`alter table revoked_access disable trigger openbot_team_revoked_leaves`;
        await tx`insert into revoked_access (email, revoked_by) values (${emailOf(made.alice)}, 'before-0207')`;
        await tx`alter table revoked_access enable trigger openbot_team_revoked_leaves`;
        await tx.unsafe(backfill);
        once = await read(tx as unknown as SQL);
        await tx.unsafe(backfill);
        twice = await read(tx as unknown as SQL);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await owner.close();
    }

    if (!once || !twice) throw new Error("the backfill did not run");
    const first: Awaited<ReturnType<typeof read>> = once;
    // The first run did its work: one group handed to Bob, the other left to a heal.
    expect(
      first.channels.map((row) => [row.id, row.created_by, row.deleted_at]),
    ).toEqual(
      [
        [made.channelId, made.bob.id, null],
        [later.channelId, made.alice.id, null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(first.members.map((row) => row.user_id)).not.toContain(
      made.alice.id,
    );
    expect(twice).toEqual(first);
  });
});

/** The deny-list rows of these people. */
async function deniedEmails(who: AgentActor[]) {
  const rows = await runAsTenant("platform", () =>
    database
      .select({ email: revokedAccess.email })
      .from(revokedAccess)
      .where(inArray(revokedAccess.email, who.map(emailOf))),
  );
  return rows.map((row) => row.email);
}

/** The database owner, for the one test that runs a migration statement: only it may. */
function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: only the owner runs 0207's statements.",
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

/** `/api/waker-groups` as index.ts mounts it, signed in as whoever asks. */
function crewActions(link: WakerGroupLink = linkCore(() => {})) {
  return createWakerGroupActions({
    database,
    store: crewStore,
    link,
    groups: conversations(),
    channels: withChannelRenameLink(channelStore, link, () => {}),
    actorFor: async (id) => ({ id, role: "user" }),
    canUse: async (owner, agentId) =>
      Boolean(await profileStore.get({ id: owner, role: "user" }, agentId)),
    log: () => {},
  });
}

type Answer = { status: number; json: Record<string, unknown> };

/** Requests to a set of routes, each signed in the way `requireUser` does it. */
function signedIn(
  mount: (requireUser: Parameters<typeof createWakerGroupRoutes>[1]) => {
    request: (path: string, init: RequestInit) => Response | Promise<Response>;
  },
) {
  let caller: AgentActor | null = null;
  const routes = mount(async (context, next) => {
    const actor = caller;
    if (!actor) throw new Error("nobody signed in");
    context.set("actor", {
      id: actor.id,
      email: emailOf(actor),
      role: "user",
    } as never);
    await runAsTenant(actor.id, () => next());
  });
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
    return { status: response.status, json };
  };
}

function crewApi(link: WakerGroupLink = linkCore(() => {})) {
  const actions = crewActions(link);
  return signedIn((requireUser) =>
    createWakerGroupRoutes(crewStore, requireUser, actions),
  );
}

function groupApi(
  link: WakerGroupLink,
  log: (line: Record<string, unknown>) => void = () => {},
) {
  const groups = withWakerGroupLink(conversations(), link, log);
  return signedIn((requireUser) =>
    createGroupRoutes(groups, requireUser as never),
  );
}

/** A promise and the hand that settles it. */
function gate() {
  let open = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

const sideClients: ReturnType<typeof createDatabase>[] = [];

/**
 * A pool of its own, named in `pg_stat_activity`, so a test can hold a transaction open on it while
 * others run, and tell when it waits on a lock. The shared pool has two connections.
 */
function sideClient() {
  const name = `wgho_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("application_name", name);
  const client = createDatabase(url.toString(), TEST_POOL);
  sideClients.push(client);
  return { name, client };
}

/**
 * Until a session of `name` waits on a lock another session holds: true, or false after five seconds.
 * It does not throw, so a test still opens its gates and lets its held transactions go.
 */
async function waitsOnALock(name: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = (await runAsTenant("platform", () =>
      database.execute(
        sql`select 1 from pg_stat_activity
             where application_name = ${name} and cardinality(pg_blocking_pids(pid)) > 0
             limit 1`,
      ),
    )) as unknown[];
    if (rows.length > 0) return true;
    await Bun.sleep(10);
  }
  return false;
}

describe("leaving through the service", () => {
  test("the creator leaves through DELETE /members/:self and the earliest member takes over", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId, groupId, bots } = await linkedGroup(
      alice,
      [bob, carol],
      3,
    );
    const link = linkCore(() => {});
    const api = groupApi(link);

    expect(
      (await api(alice, "DELETE", `/${channelId}/members/${alice.id}`)).status,
    ).toBe(204);

    const listed = await api(bob, "GET", `/${channelId}`);
    const seen = listed.json.people as { userId: string; creator: boolean }[];
    expect(seen[0]).toEqual(
      expect.objectContaining({ userId: bob.id, creator: true }),
    );
    await runAsTenant(bob.id, () =>
      withChannelRenameLink(channelStore, link, () => {}).rename(
        bob,
        channelId,
        "鲍勃的群",
      ),
    );
    expect((await crewRow(groupId))?.name).toBe("鲍勃的群");
    const removed = await api(bob, "DELETE", `/${channelId}/bots`, {
      agentIds: [bots[0]],
    });
    expect(removed.status).toBe(200);
    expect(await mirror(groupId)).toEqual(await truthIn(bob.id, channelId));
    expect(await mirror(groupId)).toHaveLength(2);
    expect((await api(alice, "GET", `/${channelId}`)).status).toBe(404);
  });

  test("the upstream service on its own still refuses a creator who leaves while others are in", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId } = await linkedGroup(alice, [bob]);

    const refusal = await runAsTenant(alice.id, () =>
      conversations().removeMember(alice.id, channelId, alice.id),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(GroupRefusedError);
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
  });

  test("a creator cannot leave while a crew run is going, and stays in", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    await runWithCards(alice, groupId, "running");
    const api = groupApi(linkCore(() => {}));

    const answer = await api(
      alice,
      "DELETE",
      `/${channelId}/members/${alice.id}`,
    );

    expect(answer.status).toBe(400);
    expect(answer.json.error).toBe("有组团流程正在运行，先停下再退群。");
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
  });

  test("the last person out deletes the chat, and the crew can open a new one", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);
    const api = groupApi(linkCore(() => {}));

    expect(
      (await api(alice, "DELETE", `/${channelId}/members/${alice.id}`)).status,
    ).toBe(204);

    expect((await channelRow(channelId)).deleted).toBe(true);
    const opened = await runAsTenant(alice.id, () =>
      crewActions().startChat(alice.id, groupId),
    );
    expect(opened).not.toBeNull();
    if (!opened) return;
    expect(opened.channel.id).not.toBe(channelId);
    expect((await channelRow(opened.channel.id)).waker_group_id).toBe(groupId);
  });

  test("a member who is not the creator leaves the upstream way", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const api = groupApi(linkCore(() => {}));

    expect(
      (await api(bob, "DELETE", `/${channelId}/members/${bob.id}`)).status,
    ).toBe(204);

    expect(await membersOf(channelId)).toEqual([alice.id]);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);
  });

  test("a hand-over and an addBots at once end consistent: the leave lands after addBots's checks", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const linus = await bot(alice, "Linus");
    const reached = gate();
    const held = gate();
    const groups = withWakerGroupLink(
      conversations(async () => {
        reached.open();
        await held.shut;
      }),
      linkCore(() => {}),
      () => {},
    );
    const adding = runAsTenant(alice.id, () =>
      groups.addBots(alice.id, channelId, [linus]),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await reached.shut;

    await runAsTenant(alice.id, () =>
      groups.removeMember(alice.id, channelId, alice.id),
    );
    held.open();
    const added = await adding;

    // Upstream's checks passed while she was the creator; its write, after the leave, finds a
    // conversation she can no longer read.
    expect(added).toBeInstanceOf(GroupNotFoundError);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    expect(await mirror(groupId)).toEqual(await truthIn(bob.id, channelId));
    expect(await mirror(groupId)).not.toContain(linus);
  });

  test("a hand-over and an addBots at once end consistent: the addBots first", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const linus = await bot(alice, "Linus");
    const groups = withWakerGroupLink(
      conversations(),
      linkCore(() => {}),
      () => {},
    );

    await runAsTenant(alice.id, () =>
      groups.addBots(alice.id, channelId, [linus]),
    );
    await runAsTenant(alice.id, () =>
      groups.removeMember(alice.id, channelId, alice.id),
    );

    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    expect(await mirror(groupId)).toEqual(await truthIn(bob.id, channelId));
    expect(await mirror(groupId)).toContain(linus);
  });

  test("a hand-over and an addBots at once end consistent: the leave first", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const linus = await bot(alice, "Linus");
    const groups = withWakerGroupLink(
      conversations(),
      linkCore(() => {}),
      () => {},
    );

    await runAsTenant(alice.id, () =>
      groups.removeMember(alice.id, channelId, alice.id),
    );
    const added = await runAsTenant(alice.id, () =>
      groups.addBots(alice.id, channelId, [linus]),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(added).toBeInstanceOf(GroupNotFoundError);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    expect(await mirror(groupId)).toEqual(await truthIn(bob.id, channelId));
  });

  test("the last person out cannot leave while a crew run is going either, and the chat and crew stay", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);
    const flow = await runWithCards(alice, groupId, "running");
    const api = groupApi(linkCore(() => {}));

    const answer = await api(
      alice,
      "DELETE",
      `/${channelId}/members/${alice.id}`,
    );

    expect(answer.status).toBe(400);
    expect(answer.json.error).toBe("有组团流程正在运行，先停下再退群。");
    expect(await membersOf(channelId)).toEqual([alice.id]);
    const row = await channelRow(channelId);
    expect(row.deleted).toBe(false);
    expect(row.created_by).toBe(alice.id);
    expect(row.waker_group_id).toBe(groupId);
    const left = await stamps(groupId, flow);
    expect(left.crew).toEqual([alice.id]);
    expect(left.run).toEqual([alice.id]);
    expect(left.cards).toEqual([alice.id, alice.id, alice.id]);
  });

  test("a run that starts while a leave waits for the crew's row is seen, and the leave is refused", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId } = await linkedGroup(alice, [bob]);
    const [template] = await runAsTenant(alice.id, () =>
      database
        .insert(groupTaskTemplates)
        .values({ groupId, name: `流程-${randomUUID()}`, steps: [] })
        .returning({ id: groupTaskTemplates.id }),
    );
    if (!template) throw new Error("template not written");
    const starter = sideClient();
    const leaver = sideClient();
    const inserted = gate();
    const commit = gate();
    // A run being started: inserted, not yet committed, holding a key-share lock on the crew's row.
    let runId = "";
    const starting = runAsTenant(alice.id, () =>
      starter.client.transaction(async (tx) => {
        const [run] = await tx
          .insert(groupTaskRuns)
          .values({
            templateId: template.id,
            groupId,
            status: "running",
            steps: [],
          })
          .returning({ id: groupTaskRuns.id });
        runId = run?.id ?? "";
        inserted.open();
        await commit.shut;
      }),
    );
    await inserted.shut;
    const api = groupApi(
      createWakerGroupLink({ database: leaver.client, groupStore }),
    );

    const leaving = api(alice, "DELETE", `/${channelId}/members/${alice.id}`);
    const leaverWaited = await waitsOnALock(leaver.name);
    commit.open();
    await starting;
    const answer = await leaving;

    expect(leaverWaited).toBe(true);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toBe("有组团流程正在运行，先停下再退群。");
    expect(await membersOf(channelId)).toEqual([alice.id, bob.id]);
    expect((await channelRow(channelId)).created_by).toBe(alice.id);
    expect((await crewRow(groupId))?.tenantId).toBe(alice.id);
    const runs = (await runAsTenant("platform", () =>
      database.execute(
        sql`select tenant_id from group_task_runs where id = ${runId}::uuid`,
      ),
    )) as unknown as { tenant_id: string }[];
    expect(runs).toEqual([{ tenant_id: alice.id }]);
  });

  test("the creator and the earliest member leaving at once leave the crew with the one who left, until a heal", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const { channelId, groupId } = await linkedGroup(alice, [bob, carol]);
    const side = sideClient();
    const deleted = gate();
    const commit = gate();
    // Bob leaves the upstream way (`store.removeMember`, no lock on the channel row), not yet committed.
    const bobLeaving = runAsTenant(bob.id, () =>
      side.client.transaction(async (tx) => {
        await tx.execute(
          sql`delete from channel_memberships where channel_id = ${channelId} and user_id = ${bob.id}`,
        );
        deleted.open();
        await commit.shut;
      }),
    );
    await deleted.shut;

    const answer = await groupApi(linkCore(() => {}))(
      alice,
      "DELETE",
      `/${channelId}/members/${alice.id}`,
    );
    commit.open();
    await bobLeaving;

    // The accepted race (3.1.1 第 8 条): the crew went to Bob, who is gone too.
    expect(answer.status).toBe(204);
    expect(await membersOf(channelId)).toEqual([carol.id]);
    expect((await channelRow(channelId)).created_by).toBe(bob.id);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    // Carol opening settings is the heal.
    const opened = await crewApi()(carol, "POST", `/for-channel/${channelId}`);
    expect(opened.status).toBe(200);
    expect((await channelRow(channelId)).created_by).toBe(carol.id);
    expect((await crewRow(groupId))?.tenantId).toBe(carol.id);
  });

  test("a leave that commits while the mirror write waits on the channel row is seen in the row it locks", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId, bots } = await linkedGroup(alice, [bob], 3);
    const holder = sideClient();
    const leaver = sideClient();
    const mirrorer = sideClient();
    const holding = gate();
    const release = gate();
    // Holds Alice's membership row, so her leave stops holding the channel row, before it deletes it.
    const held = runAsTenant("platform", () =>
      holder.client.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from channel_memberships
               where channel_id = ${channelId} and user_id = ${alice.id} for update`,
        );
        holding.open();
        await release.shut;
      }),
    );
    await holding.shut;
    const reached = gate();
    const roster = gate();
    const { lines, log } = collected();
    const gated = createWakerGroupLink({
      database: mirrorer.client,
      groupStore: {
        order: async (id) => {
          reached.open();
          await roster.shut;
          return groupStore.order(id);
        },
        bots: async (id) => {
          await roster.shut;
          return groupStore.bots(id);
        },
      },
      log,
    });
    // Alice can still read the channel: the reconcile passes its first check and waits at the roster.
    const reconciling = gated.reconcile(channelId);
    await reached.shut;
    // `link.leave` alone: the service's own reconcile afterwards would write the same mirror at the
    // same moment, and that race is not this test's.
    const leaving = runAsTenant(alice.id, () =>
      createWakerGroupLink({ database: leaver.client, groupStore }).leave(
        alice.id,
        channelId,
      ),
    );
    const leaveWaited = await waitsOnALock(leaver.name);
    // The roster is read while she is still in; the share lock then waits for her leave.
    roster.open();
    const mirrorWaited = await waitsOnALock(mirrorer.name);
    release.open();
    await held;
    const left = await leaving;

    expect(leaveWaited).toBe(true);
    expect(left).toEqual({ heir: bob.id });
    expect(mirrorWaited).toBe(true);
    expect(await reconciling).toBe(true);
    expect(
      lines.filter((line) => line.type === "waker-group-owner-gone"),
    ).toEqual([]);
    expect((await crewRow(groupId))?.tenantId).toBe(bob.id);
    expect(await mirror(groupId)).toEqual(await truthIn(bob.id, channelId));
    expect(await mirror(groupId)).toHaveLength(bots.length);
  });

  test("a reconcile that read the roster before the hand-over follows the new owner and logs no owner-gone", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const { channelId, groupId, bots } = await linkedGroup(alice, [bob], 3);
    // An order the ids alone would not give, so a roster read in the wrong frame shows.
    await runAsTenant(alice.id, () =>
      conversations().reorder(alice.id, channelId, [...bots].reverse()),
    );
    const reached = gate();
    const held = gate();
    const { lines, log } = collected();
    const gated = linkCore(log, {
      order: async (id) => {
        reached.open();
        await held.shut;
        return groupStore.order(id);
      },
      bots: async (id) => {
        await held.shut;
        return groupStore.bots(id);
      },
    });
    const reconciling = gated.reconcile(channelId);
    await reached.shut;

    await runAsTenant(alice.id, () =>
      withWakerGroupLink(
        conversations(),
        linkCore(() => {}),
        () => {},
      ).removeMember(alice.id, channelId, alice.id),
    );
    held.open();

    expect(await reconciling).toBe(true);
    expect(await mirror(groupId)).toEqual(await truthIn(bob.id, channelId));
    expect(await mirror(groupId)).toEqual([...bots].reverse());
    expect(
      lines.filter((line) => line.type === "waker-group-owner-gone"),
    ).toEqual([]);
  });

  test("the Task 3 window: a creator who leaves between the check and the write leaves the mirror as it was", async () => {
    const alice = await person("alice");
    const { channelId, groupId } = await linkedGroup(alice);
    const before = await mirror(groupId);
    expect(before).toHaveLength(2);
    const reached = gate();
    const held = gate();
    const { lines, log } = collected();
    const gated = linkCore(log, {
      order: async (id) => {
        reached.open();
        await held.shut;
        return groupStore.order(id);
      },
      bots: async (id) => {
        await held.shut;
        return groupStore.bots(id);
      },
    });
    const reconciling = gated.reconcile(channelId);
    await reached.shut;

    await runAsTenant(alice.id, () =>
      withWakerGroupLink(
        conversations(),
        linkCore(() => {}),
        () => {},
      ).removeMember(alice.id, channelId, alice.id),
    );
    held.open();

    expect(await reconciling).toBe(false);
    expect(await mirror(groupId)).toEqual(before);
    expect(lines).toEqual([{ type: "waker-group-owner-gone", channelId }]);
  });
});

describe("for-channel hand-over", () => {
  /** A linked group of three whose creator then deleted their own membership, past the service. */
  async function leftPastTheService() {
    const alice = await person("alice");
    const bob = await person("bob");
    const carol = await person("carol");
    const made = await linkedGroup(alice, [bob, carol]);
    await runAsTenant(alice.id, () =>
      groupStore.removeMember(made.channelId, alice.id),
    );
    return { alice, bob, carol, ...made };
  }

  test("the earliest member who opens settings takes over a group whose creator left past the service", async () => {
    const made = await leftPastTheService();
    const api = crewApi();

    const answer = await api(
      made.bob,
      "POST",
      `/for-channel/${made.channelId}`,
    );

    expect(answer.status).toBe(200);
    expect(answer.json.group).toEqual(
      expect.objectContaining({ id: made.groupId }),
    );
    expect((await channelRow(made.channelId)).created_by).toBe(made.bob.id);
    expect((await crewRow(made.groupId))?.tenantId).toBe(made.bob.id);
  });

  test("a later member still gets 403, and the earliest one becomes the owner", async () => {
    const made = await leftPastTheService();
    const api = crewApi();

    const answer = await api(
      made.carol,
      "POST",
      `/for-channel/${made.channelId}`,
    );

    expect(answer.status).toBe(403);
    expect((await channelRow(made.channelId)).created_by).toBe(made.bob.id);
    expect((await crewRow(made.groupId))?.tenantId).toBe(made.bob.id);
  });

  test("a hand-over put off by a running flow is logged and answers 403", async () => {
    const made = await leftPastTheService();
    await runWithCards(made.alice, made.groupId, "running");
    const { lines, log } = collected();
    const api = crewApi(linkCore(log));

    const answer = await api(
      made.bob,
      "POST",
      `/for-channel/${made.channelId}`,
    );

    expect(answer.status).toBe(403);
    expect(lines).toContainEqual({
      type: "waker-group-hand-over-deferred",
      channelId: made.channelId,
    });
    expect((await channelRow(made.channelId)).created_by).toBe(made.alice.id);
    expect((await crewRow(made.groupId))?.tenantId).toBe(made.alice.id);
  });
});
