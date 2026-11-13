import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Migration 0205: a conversation links to a crew (`channels.waker_group_id`).
 *
 * Three database pieces are proved here, in the frames production uses:
 *  - the column, its foreign key (`ON DELETE SET NULL`) and the one-live-channel-per-crew index;
 *  - the shared-group guard (`openbot_team_channel_guard`, rewritten from 0179) that lets the
 *    creator link an unlinked group and lets the foreign key unlink a group whose crew is gone,
 *    and nothing else — a member may not link, unlink or repoint;
 *  - the link trigger (`openbot_channel_waker_group_link`), which reads the crew through the
 *    current frame's row security, so a crew of another tenant or a WakerFlow's internal crew is
 *    refused even though the foreign key alone would admit it.
 */
const MIGRATION_TAG = "0205_waker_group_channel_link";
const PREVIOUS_WHEN = 1794502160837;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const prefix = `wglink-${randomUUID()}`;
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
    for (const id of createdChannels.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
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
      .values({ id, email: `${id}@example.test`, name: "Link Test" }),
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
      .values({ name: `${name}-${randomUUID().slice(0, 8)}` })
      .returning({ id: wakerGroups.id }),
  );
  if (!row) throw new Error("crew not written");
  createdGroups.push(row.id);
  return row.id;
}

/** A shared group the creator opens with two of their Bots, the way the store opens one. */
async function sharedGroup(creator: AgentActor) {
  const ids = [await bot(creator, "Ada"), await bot(creator, "Grace")];
  const channel = await runAsTenant(creator.id, () =>
    channelStore.create(creator, ids, { shared: true }),
  );
  createdChannels.push(channel.id);
  return channel.id;
}

/** `member` added to the creator's shared group, written from the creator's frame. */
async function addMember(
  creator: AgentActor,
  channelId: string,
  member: AgentActor,
) {
  await runAsTenant(creator.id, () =>
    database
      .insert(channelMemberships)
      .values({ channelId, userId: member.id, tenantId: "team" }),
  );
}

/** The SQLSTATE of a refusal, or "ok" when the work went through. */
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "ok";
  } catch (error) {
    const failure = error as { errno?: string; cause?: { errno?: string } };
    return failure.errno ?? failure.cause?.errno ?? String(error);
  }
}

/** The message of a refusal, or "ok". */
async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "ok";
  } catch (error) {
    const failure = error as { message?: string; cause?: { message?: string } };
    return `${failure.message ?? ""} ${failure.cause?.message ?? ""}`;
  }
}

function linkAs(frame: string, channelId: string, groupId: string | null) {
  return runAsTenant(frame, () =>
    database.execute(
      sql`update channels set waker_group_id = ${groupId}::uuid where id = ${channelId}`,
    ),
  );
}

/**
 * Runs `statement` in `frame` from inside a trigger the frame creates on a temporary table, so the
 * guard sees `pg_trigger_depth() > 1` with no foreign key involved (as in team-tenant-rls).
 */
function fromNestedTrigger(frame: string, statement: string) {
  const tag = `zz_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return database.$client.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${frame}, true)`;
    await tx.unsafe(`create temp table ${tag} (x int) on commit drop`);
    await tx.unsafe(
      `create function pg_temp.${tag}_f() returns trigger language plpgsql as $f$
       begin ${statement}; return new; end $f$`,
    );
    await tx.unsafe(
      `create trigger ${tag}_tr after insert on ${tag} for each row execute function pg_temp.${tag}_f()`,
    );
    await tx.unsafe(`insert into ${tag} values (1)`);
  });
}

async function linkOf(channelId: string) {
  const rows = await runAsTenant("platform", () =>
    database.execute<{ waker_group_id: string | null }>(
      sql`select waker_group_id from channels where id = ${channelId}`,
    ),
  );
  const [row] = rows as unknown as { waker_group_id: string | null }[];
  if (!row) throw new Error(`channel ${channelId} is gone`);
  return row.waker_group_id;
}

describe("migration 0205: a conversation links to a crew", () => {
  test("the journal registers 0205 after 0204", async () => {
    const journal = (await Bun.file(
      new URL(
        "../recovery/recovery-20261018-v1/meta/_journal.json",
        import.meta.url,
      ),
    ).json()) as { entries: { idx: number; tag: string; when: number }[] };
    const entry = journal.entries.find((item) => item.idx === 205);
    expect(entry?.tag).toBe(MIGRATION_TAG);
    expect(entry?.when ?? 0).toBeGreaterThan(PREVIOUS_WHEN);
  });

  test("the creator links an unlinked shared group to a crew of their own", async () => {
    const alice = await person("alice");
    const channelId = await sharedGroup(alice);
    const groupId = await crew(alice, "Weekly");
    expect(await linkOf(channelId)).toBeNull();

    expect(await outcome(() => linkAs(alice.id, channelId, groupId))).toBe(
      "ok",
    );
    expect(await linkOf(channelId)).toBe(groupId);
  });

  test("the creator cannot point a linked group at another crew", async () => {
    const alice = await person("alice");
    const channelId = await sharedGroup(alice);
    const first = await crew(alice, "First");
    const second = await crew(alice, "Second");
    await linkAs(alice.id, channelId, first);

    expect(await outcome(() => linkAs(alice.id, channelId, second))).toBe(
      "42501",
    );
    expect(await linkOf(channelId)).toBe(first);
  });

  test("a member who is not the creator cannot link or unlink", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const channelId = await sharedGroup(alice);
    await addMember(alice, channelId, bob);
    const bobsCrew = await crew(bob, "Bob");
    const alicesCrew = await crew(alice, "Alice");

    expect(await outcome(() => linkAs(bob.id, channelId, bobsCrew))).toBe(
      "42501",
    );
    expect(await linkOf(channelId)).toBeNull();

    await linkAs(alice.id, channelId, alicesCrew);
    // Bob cannot see Alice's crew, so to him it might as well be gone: the guard must not take
    // that for the foreign key unlinking a deleted one.
    expect(await outcome(() => linkAs(bob.id, channelId, null))).toBe("42501");
    expect(await linkOf(channelId)).toBe(alicesCrew);
    // Nor from inside a trigger of his own, where the depth looks like the foreign key's: the crew
    // still exists, which only a check that reads past row security can tell him apart by.
    expect(
      await outcome(() =>
        fromNestedTrigger(
          bob.id,
          `update public.channels set waker_group_id = null where id = '${channelId}'`,
        ),
      ),
    ).toBe("42501");
    expect(await linkOf(channelId)).toBe(alicesCrew);
  });

  test("a crew of another tenant cannot be linked", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const channelId = await sharedGroup(alice);
    const bobsCrew = await crew(bob, "Bob");

    // The foreign key alone admits it (it reads past row security); the trigger does not.
    expect(await outcome(() => linkAs(alice.id, channelId, bobsCrew))).toBe(
      "42501",
    );
    expect(await linkOf(channelId)).toBeNull();
  });

  test("a WakerFlow's internal crew cannot be linked", async () => {
    const alice = await person("alice");
    const channelId = await sharedGroup(alice);
    const groupId = await crew(alice, "Flow crew");
    const [flow] = await runAsTenant(alice.id, () =>
      database
        .insert(wakerFlows)
        .values({ name: "流程", revision: 1, groupId })
        .returning({ id: wakerFlows.id }),
    );
    if (!flow) throw new Error("flow not written");
    createdFlows.push(flow.id);

    expect(await outcome(() => linkAs(alice.id, channelId, groupId))).toBe(
      "42501",
    );
    expect(await linkOf(channelId)).toBeNull();
  });

  test("a personal multi-Bot channel links only to its own tenant's crew", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const ids = [await bot(alice, "Ada"), await bot(alice, "Grace")];
    const channelId = `${prefix}-personal-${randomUUID()}`;
    await runAsTenant("platform", async () => {
      await database.insert(channels).values({
        id: channelId,
        name: "Ada, Grace",
        description: "",
        tenantId: alice.id,
      });
      await database.execute(
        sql`insert into channel_agents (channel_id, agent_id, tenant_id) values (${channelId}, ${ids[0]}, ${alice.id}), (${channelId}, ${ids[1]}, ${alice.id})`,
      );
    });
    createdChannels.push(channelId);
    const alicesCrew = await crew(alice, "Alice");
    const bobsCrew = await crew(bob, "Bob");

    expect(await outcome(() => linkAs(alice.id, channelId, bobsCrew))).toBe(
      "42501",
    );
    expect(await linkOf(channelId)).toBeNull();
    expect(await outcome(() => linkAs(alice.id, channelId, alicesCrew))).toBe(
      "ok",
    );
    expect(await linkOf(channelId)).toBe(alicesCrew);
  });

  test("deleting the crew unlinks the channel, soft-deleted shared groups included", async () => {
    const alice = await person("alice");
    const live = await sharedGroup(alice);
    const gone = await sharedGroup(alice);
    const liveCrew = await crew(alice, "Live");
    const goneCrew = await crew(alice, "Gone");
    await linkAs(alice.id, live, liveCrew);
    await linkAs(alice.id, gone, goneCrew);
    await runAsTenant(alice.id, () =>
      database.execute(
        sql`update channels set deleted_at = now() where id = ${gone}`,
      ),
    );
    const deletedAt = async (id: string) => {
      const rows = (await runAsTenant("platform", () =>
        database.execute(sql`select deleted_at from channels where id = ${id}`),
      )) as unknown as { deleted_at: unknown }[];
      return rows[0]?.deleted_at ?? null;
    };
    const goneAt = await deletedAt(gone);
    expect(goneAt).not.toBeNull();

    expect(
      await outcome(() =>
        runAsTenant(alice.id, () =>
          database
            .delete(wakerGroups)
            .where(inArray(wakerGroups.id, [liveCrew, goneCrew])),
        ),
      ),
    ).toBe("ok");
    expect(await linkOf(live)).toBeNull();
    expect(await linkOf(gone)).toBeNull();
    expect(await deletedAt(live)).toBeNull();
    expect(await deletedAt(gone)).toEqual(goneAt);
  });

  test("one live channel per crew; a soft-deleted one does not count", async () => {
    const alice = await person("alice");
    const first = await sharedGroup(alice);
    const second = await sharedGroup(alice);
    const groupId = await crew(alice, "Shared");
    await linkAs(alice.id, first, groupId);

    expect(await outcome(() => linkAs(alice.id, second, groupId))).toBe(
      "23505",
    );
    await runAsTenant(alice.id, () =>
      database.execute(
        sql`update channels set deleted_at = now() where id = ${first}`,
      ),
    );
    expect(await outcome(() => linkAs(alice.id, second, groupId))).toBe("ok");
    expect(await linkOf(second)).toBe(groupId);
    expect(await linkOf(first)).toBe(groupId);
  });

  test("the platform frame may relink", async () => {
    const alice = await person("alice");
    const channelId = await sharedGroup(alice);
    const first = await crew(alice, "First");
    const second = await crew(alice, "Second");
    await linkAs(alice.id, channelId, first);

    expect(await outcome(() => linkAs("platform", channelId, second))).toBe(
      "ok",
    );
    expect(await linkOf(channelId)).toBe(second);
  });

  test("the guard's other rules are unchanged", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const channelId = await sharedGroup(alice);
    await addMember(alice, channelId, bob);

    expect(
      await refusal(() =>
        runAsTenant(bob.id, () =>
          database.execute(
            sql`update channels set name = 'Renamed' where id = ${channelId}`,
          ),
        ),
      ),
    ).toContain("only the creator renames or describes a shared group");
    expect(
      await outcome(() =>
        runAsTenant(bob.id, () =>
          database.execute(
            sql`update channels set last_message_at = now() where id = ${channelId}`,
          ),
        ),
      ),
    ).toBe("ok");
    const rows = (await runAsTenant("platform", () =>
      database.execute(
        sql`select last_message_at from channels where id = ${channelId}`,
      ),
    )) as unknown as { last_message_at: unknown }[];
    expect(rows[0]?.last_message_at ?? null).not.toBeNull();
    expect(
      await refusal(() =>
        runAsTenant(alice.id, () =>
          database.execute(
            sql`update channels set allowed_groups = array['ops'] where id = ${channelId}`,
          ),
        ),
      ),
    ).toContain("only the activity columns of a shared group change");
  });
});
