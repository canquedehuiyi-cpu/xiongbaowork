import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createGroupConversations,
  createGroupStore,
  GROUP_TURN_KIND,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  routineRuns,
  routines,
  users,
  workItems,
} from "../src/db/schema";
import type { TurnRunner } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import {
  dispatchClaimedRoutines,
  offerDueRoutines,
  ROUTINE_FIRE_KIND,
} from "../src/routines/sweep";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * N13 / WP-1.6: work that runs for nobody must still find the work that belongs to somebody.
 *
 * Every background entry in this server — the routine cron, the group turn poller, the responsibility
 * engine, the culler — starts from a timer. A timer outlives every session, so the connection it
 * queries on has no tenant in its async-local context, and `currentTenant()` answers that with
 * `system`. Row-level security then does exactly what it was built to do and shows that worker only
 * the platform's own rows: not one due routine, not one queued turn. Nothing errors. The queue is
 * healthy, the cron runs on schedule, and no work is ever done.
 *
 * Until the delivery image connects as a role that can be governed, a superuser with `BYPASSRLS`
 * answers those same queries with every row and the whole defect is invisible — which is why this file
 * is written against `openbot_app`, and why the first test asserts the EMPTY answer. That assertion
 * is what makes the rest of the file worth reading: on a connection that enforces nothing every test
 * here would pass, and the fix could be reverted without anybody noticing.
 *
 * The rule being asserted is the one now written into `work/queue.ts` and `work/loop.ts`: a worker
 * asks as `platform` for the questions that have no tenant — what is due, what is unheld, what is
 * stale — and takes the claimed row's tenant for the work itself, because the reply, the run row and
 * the card it produces are read afterwards inside that one tenant. A worker that skips the second half
 * still does the work, and files the proof of it where nobody will look.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const queue = createWorkQueue(database);
const routineStore = createRoutineStore(database);
const suite = randomUUID().slice(0, 8);

/** Everything this file created, by tenant, so the tear-down can reach it from the right frame. */
const created = { tenants: [] as string[], channels: [] as string[] };

afterAll(async () => {
  /*
   * As `platform`, because this is the operator's own question — "delete everything this test suite
   * made, in whatever tenant each row happened to land in" — and no single tenant's frame can answer
   * it. Left behind, a due routine from one run of this file is read by the next run's sweep, which
   * then reports firings for a routine it never created.
   */
  await runAsTenant("platform", async () => {
    /*
     * BY TENANT, NOT BY KEY. A routine firing is keyed `routine_<id>:<minute>` — the routine's own id,
     * which carries nothing that identifies the suite that made it — so a prefix of this file's random
     * name would leave every one of those rows behind. And a leftover `work_items` row is not merely
     * untidy now that claims are made as `platform`: the next file's sweep claims it, finds the routine
     * gone, and reports a firing it never made. `tests/routine-sweep.integration.test.ts` is the file
     * that proves it, by failing.
     */
    for (const tenant of created.tenants) {
      await database.delete(workItems).where(eq(workItems.tenantId, tenant));
    }
    await database
      .delete(workItems)
      .where(sql`${workItems.key} like ${`${suite}%`}`);
    for (const tenant of created.tenants) {
      await database
        .delete(groupMessages)
        .where(eq(groupMessages.ownerUserId, tenant));
      await database
        .delete(groupBotThreads)
        .where(eq(groupBotThreads.ownerUserId, tenant));
      await database
        .delete(routineRuns)
        .where(
          sql`${routineRuns.routineId} in (select id from ${routines} where tenant_id = ${tenant})`,
        );
      await database.delete(routines).where(eq(routines.tenantId, tenant));
      await database
        .delete(agentProfiles)
        .where(
          sql`${agentProfiles.agentId} in (select id from ${agents} where tenant_id = ${tenant})`,
        );
      await database.delete(agents).where(eq(agents.tenantId, tenant));
      await database.delete(users).where(eq(users.id, tenant));
    }
  });
  for (const id of created.channels) {
    // One tenant's own channel, deleted in that tenant's frame — the platform may not rewrite a
    // workspace's roster, and `channels` cascades its memberships with it.
    await database
      .delete(intelligenceChannelMappings)
      .where(sql`${intelligenceChannelMappings.channelId} = ${id}`);
  }
  await runAsTenant(created.tenants[0] ?? "platform", async () => {
    for (const id of created.channels) {
      await database.delete(channels).where(eq(channels.id, id));
    }
  });
  await database.$client.close();
});

/** One workspace: a person, two Bots, a channel holding them — every row inside that one tenant. */
async function workspace() {
  const ownerId = `${suite}-owner-${randomUUID().slice(0, 8)}`;
  created.tenants.push(ownerId);
  const owner: AgentActor = { id: ownerId, role: "user" };
  return runAsTenant(ownerId, async () => {
    await database.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      name: "Unattended Owner",
    });
    const first = await profileStore.create(owner, {
      name: "Ada",
      title: "Tester",
      roleDescription: "Answer briefly.",
      visibility: "private",
    });
    const second = await profileStore.create(owner, {
      name: "Grace",
      title: "Tester",
      roleDescription: "Answer briefly.",
      visibility: "private",
    });
    const channel = await channelStore.create(owner, [first.id, second.id]);
    created.channels.push(channel.id);
    return {
      ownerId,
      botIds: [first.id, second.id],
      channelId: channel.id,
    };
  });
}

/**
 * A routine whose next occurrence has already arrived, and the stamp that says when.
 *
 * The stamp comes back with it because that is the honest thing to compare a clock advance against.
 * Measured against the wall clock instead, the assertion reads a cron boundary that the sweep had
 * every right to land on and calls it stale — a fifteen-minute boundary can legally sit eight seconds
 * behind a `Date.now()` taken a moment later.
 */
async function due(ownerId: string, botId: string, channelId: string) {
  const routine = await runAsTenant(ownerId, () =>
    routineStore.create({
      ownerUserId: ownerId,
      agentId: botId,
      channelId,
      instruction: "Say the morning thing.",
      // The schedule guardrail's floor is fifteen minutes, so this is the fastest legal clock. What
      // matters to the sweep is only that the stamp has already arrived, which `due` puts there.
      cron: "*/15 * * * *",
    }),
  );
  // Due now, not due at the next minute: the sweep's only question is what has arrived. Written in
  // the owner's frame, because that is whose row it is.
  const dueAt = new Date(Date.now() - 60_000);
  await runAsTenant(ownerId, () =>
    database
      .update(routines)
      .set({ nextRunAt: dueAt })
      .where(eq(routines.id, routine.id)),
  );
  return { routine, dueAt };
}

describe("an unattended worker against row level security", () => {
  test("a tenant's due routine is invisible to a worker that has no tenant", async () => {
    const space = await workspace();
    const { routine } = await due(
      space.ownerId,
      space.botIds[0] ?? "",
      space.channelId,
    );

    /*
     * THE NEGATIVE HALF. This is the statement the sweep issues — one select on one table, one
     * connection — with nothing in its context, which is what a timer looks like to the database. It
     * must answer empty. If it answers a row, this connection is a superuser or holds `BYPASSRLS`, and
     * every other test in this file is checking an enforcement that was never switched on.
     */
    const asNoTenant = await database
      .select({ id: routines.id })
      .from(routines)
      .where(eq(routines.id, routine.id));
    expect(asNoTenant).toEqual([]);

    const asStranger = await runAsTenant(`${suite}-stranger`, () =>
      database
        .select({ id: routines.id })
        .from(routines)
        .where(eq(routines.id, routine.id)),
    );
    expect(asStranger).toEqual([]);

    const asPlatform = await runAsTenant("platform", () =>
      database
        .select({ id: routines.id, tenantId: routines.tenantId })
        .from(routines)
        .where(eq(routines.id, routine.id)),
    );
    expect(asPlatform.map((row) => row.tenantId)).toEqual([space.ownerId]);
  });

  test("the sweep reaches that routine and queues the firing in its owner's name", async () => {
    const space = await workspace();
    const { routine, dueAt } = await due(
      space.ownerId,
      space.botIds[0] ?? "",
      space.channelId,
    );
    const options = {
      routineStore,
      queue,
      owner: `${suite}-offerer`,
      dispatch: async () => {},
    };

    const { offered } = await offerDueRoutines(options);
    expect(offered).toContain(routine.id);

    /*
     * OFFERED AS THE ROUTINE'S TENANT, not as the sweep's. Once a worker with no session claims this
     * row, its stamp is the only thing left that says whose firing it is — and phase two opens the
     * run row inside exactly that. Queued as `system` it would be work nobody can attribute, which is
     * how this defect reappears after somebody "fixes" the claim and leaves the offer alone.
     */
    const queued = await runAsTenant("platform", () =>
      database
        .select({ key: workItems.key, tenantId: workItems.tenantId })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, ROUTINE_FIRE_KIND),
            like(workItems.key, `${routine.id}:%`),
          ),
        ),
    );
    expect(queued.map((row) => row.tenantId)).toEqual([space.ownerId]);

    // And the clock moved off the stamp this pass read, which is the half that used to match no row
    // at all. Against the stamp rather than against the wall clock: the next occurrence of a
    // fifteen-minute cron is a boundary, and a boundary may legitimately sit a few seconds behind a
    // `Date.now()` taken after it.
    const advanced = await runAsTenant("platform", () =>
      database
        .select({ nextRunAt: routines.nextRunAt })
        .from(routines)
        .where(eq(routines.id, routine.id)),
    );
    expect(advanced[0]?.nextRunAt.getTime()).toBeGreaterThan(dueAt.getTime());
  });

  test("a contextless claim takes another tenant's item and says whose work it is", async () => {
    const space = await workspace();
    const key = `${suite}-claim-${randomUUID().slice(0, 8)}`;
    await runAsTenant(space.ownerId, () =>
      queue.offer({
        kind: ROUTINE_FIRE_KIND,
        key,
        payload: { routineId: "none", scheduledFor: new Date().toISOString() },
      }),
    );

    // No frame around this call at all, exactly as the cron script makes it.
    const claimed = await queue.claim({
      kind: ROUTINE_FIRE_KIND,
      owner: `${suite}-claimant`,
      leaseMs: 60_000,
      limit: 50,
    });
    const item = claimed.find((candidate) => candidate.key === key);
    expect(item?.tenantId).toBe(space.ownerId);
  });

  test("a dispatched firing leaves a run row its owner can read", async () => {
    const space = await workspace();
    const { routine } = await due(
      space.ownerId,
      space.botIds[0] ?? "",
      space.channelId,
    );
    const dispatched: string[] = [];
    const options = {
      routineStore,
      queue,
      owner: `${suite}-runner`,
      dispatch: async (runId: string) => {
        dispatched.push(runId);
      },
    };

    await offerDueRoutines(options);
    const report = await dispatchClaimedRoutines(options);
    expect(report.fired).toContain(routine.id);

    /*
     * READ BACK THROUGH THE OWNER'S OWN METHOD, in the owner's own frame — `listRuns` is what the
     * routines page calls. The claim above needed `platform`; the row must NOT be stamped with it. An
     * open run filed under the platform is invisible to the screen that lists a routine's firings, and
     * to the `finishRun` and the fatigue rule that write to it afterwards. This is the assertion that
     * stops a future "just run the whole sweep as platform" from passing.
     */
    const history = await runAsTenant(space.ownerId, () =>
      routineStore.listRuns(space.ownerId, routine.id),
    );
    expect(history).toHaveLength(1);
    expect(dispatched).toContain(history[0]?.id);
    // In flight, which is what a null status means: the turn is the dispatcher's, not this pass's.
    expect(history[0]?.status).toBeNull();

    const settled = await runAsTenant("platform", () =>
      database
        .select({
          tenantId: workItems.tenantId,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, ROUTINE_FIRE_KIND),
            like(workItems.key, `${routine.id}:%`),
          ),
        ),
    );
    expect(settled[0]?.tenantId).toBe(space.ownerId);
    expect(settled[0]?.finishedAt).not.toBeNull();
  });

  test("the group poller claims a turn it is not a member of and answers inside that tenant", async () => {
    const space = await workspace();
    const groupStore = createGroupStore(database, () => threadIdentity.mint());
    const seen: Parameters<TurnRunner>[0][] = [];
    const conversations = createGroupConversations({
      store: groupStore,
      queue: createWorkQueue(database),
      owner: `${suite}-group`,
      roster: async (ownerUserId, channelId) => {
        const actor: AgentActor = { id: ownerUserId, role: "user" };
        const channel = await channelStore.get(actor, channelId);
        if (!channel || channel.agentIds.length < 2) return null;
        const bots: { id: string; name: string }[] = [];
        for (const agentId of channel.agentIds) {
          const profile = await profileStore.get(actor, agentId);
          if (profile) bots.push({ id: agentId, name: profile.name });
        }
        return bots;
      },
      runTurn: async (input) => {
        seen.push(input);
        return { replyText: "Noted." };
      },
      caps: { maxDepth: 1, maxPerRun: 2 },
      mayAddress: async () => true,
      auditStore: { insert: async () => {} },
    });

    const messageId = `${suite}-group-${randomUUID().slice(0, 8)}`;
    // A person's own request: their tenant, their session, their message.
    await runAsTenant(space.ownerId, () =>
      conversations.send(space.ownerId, space.channelId, {
        id: messageId,
        text: "Both of you, take that note.",
      }),
    );

    // The poller: no session, no tenant, one second on the clock.
    expect(await conversations.sweep()).toBe(true);
    expect(seen).toHaveLength(2);
    expect(
      seen.every((input) => input.ownerUserId === space.ownerId),
    ).toBeTrue();

    /*
     * THE TRANSCRIPT AS ITS OWNER READS IT. The person's message was written in their own frame, so it
     * was always going to be here; the two replies were written by the poller, and they are here only
     * if the turn ran inside the claimed item's tenant rather than inside the platform's. A reply
     * filed where the asker cannot read it is this feature's whole failure, and it looks like success
     * from the outside: the queue drains, the model is spent, the group shows an empty conversation.
     */
    const transcript = await runAsTenant(space.ownerId, () =>
      groupStore.list(space.channelId),
    );
    const replies = transcript.filter((row) => row.agentId !== null);
    expect(replies).toHaveLength(2);
    expect(replies.map((row) => row.text)).toEqual(["Noted.", "Noted."]);

    const stranger = await runAsTenant(`${suite}-stranger`, () =>
      groupStore.list(space.channelId),
    );
    expect(stranger).toEqual([]);

    const settled = await runAsTenant("platform", () =>
      database
        .select({
          tenantId: workItems.tenantId,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, GROUP_TURN_KIND),
            eq(workItems.key, messageId),
          ),
        ),
    );
    expect(settled[0]?.tenantId).toBe(space.ownerId);
    expect(settled[0]?.finishedAt).not.toBeNull();
  });
});
