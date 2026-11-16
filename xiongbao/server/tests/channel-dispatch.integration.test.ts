import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  CHANNEL_DISPATCH_KIND,
  createChannelDispatch,
  createChannelDispatchRoutes,
  dispatchRunId,
} from "../src/channels/dispatch";
import { type AgentChannel, createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import type { TurnRunner } from "../src/routines/runner";
import { createTaskProjector } from "../src/tasks/projector";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec B2/B3 against real PostgreSQL, as the NOBYPASSRLS application role under FORCE RLS.
 *
 * The real channel store, profile store, work queue and task projector; only the model is faked (a
 * `runTurn` that records what it was asked and answers in one line). What must hold:
 *
 * - a person who is not in the conversation, or names another tenant's coworker, gets 404 and nothing
 *   is written;
 * - a replay of the same message is the same work: one queue row, one card;
 * - every row lands under the asking person's tenant — the card, the queue row, and what the worker
 *   writes from a timer's `platform` frame, which takes the claimed row's tenant;
 * - the restart sweep closes a dispatch card whose turn died, and nothing else.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const projector = createTaskProjector(database);
const queue = createWorkQueue(database);

const turns: (Parameters<TurnRunner>[0] & { tenant: string })[] = [];
const service = createChannelDispatch({
  queue,
  owner: `channel-dispatch-test-${suite}`,
  board: projector,
  channel: (actor, channelId) => channelStore.get(actor, channelId),
  bot: async (actor, agentId) => {
    const profile = await profileStore.get(actor, agentId);
    return profile ? { id: agentId, name: profile.name } : null;
  },
  actorFor: async (id) => ({ id, role: "user" }),
  runTurn: async (input) => {
    turns.push({ ...input, tenant: currentTenant() });
    return { replyText: "看过了，第三条要改。" };
  },
  activity: ({ actor, channelId, pinnedAgentId, text, sourceId }) =>
    channelStore.recordActivity(
      actor,
      channelId,
      { text, agentId: pinnedAgentId, at: new Date() },
      { id: sourceId },
    ),
});

const alice: AgentActor = { id: `cd-alice-${suite}`, role: "user" };
const bob: AgentActor = { id: `cd-bob-${suite}`, role: "user" };
let pinnedId = "";
let helperId = "";
let foreignId = "";
let channel: AgentChannel;
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const seededKeys: string[] = [];

async function createProfile(owner: AgentActor, name: string) {
  const profile = await runAsTenant(owner.id, () =>
    profileStore.create(owner, {
      name,
      title: "测试员工",
      roleDescription: "Mock only, zero provider calls.",
      visibility: "private",
    }),
  );
  createdAgentIds.push(profile.id);
  return profile.id;
}

beforeAll(async () => {
  for (const person of [alice, bob])
    await runAsTenant(person.id, () =>
      database.insert(users).values({
        id: person.id,
        email: `${person.id}@example.test`,
        name: person.id,
      }),
    );
  pinnedId = await createProfile(alice, "小熊");
  helperId = await createProfile(alice, "阿审");
  foreignId = await createProfile(bob, "别人的员工");
  channel = await runAsTenant(alice.id, () =>
    channelStore.create(alice, [pinnedId]),
  );
  createdChannelIds.push(channel.id);
});

afterAll(async () => {
  // Best effort, each in the frame that can see the row; a leftover row is another suite's noise,
  // not this suite's failure.
  const quietly = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch {
      // ignored
    }
  };
  await quietly(() =>
    runAsTenant(alice.id, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, alice.id));
      if (seededKeys.length > 0)
        await database
          .delete(workItems)
          .where(
            and(
              eq(workItems.kind, CHANNEL_DISPATCH_KIND),
              inArray(workItems.key, seededKeys),
            ),
          );
      for (const channelId of createdChannelIds) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, channelId));
        await database.delete(channels).where(eq(channels.id, channelId));
      }
    }),
  );
  for (const person of [alice, bob])
    await quietly(() =>
      runAsTenant(person.id, async () => {
        for (const agentId of createdAgentIds) {
          await database
            .delete(agentProfiles)
            .where(eq(agentProfiles.agentId, agentId));
          await database.delete(agents).where(eq(agents.id, agentId));
        }
        await database.delete(users).where(eq(users.id, person.id));
      }),
    );
  await database.$client.close();
});

/** The route, behind a stand-in for the session guard that frames the request as its guard does. */
function post(actor: AgentActor, channelId: string, body: unknown) {
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api/channels",
    createChannelDispatchRoutes(service, async (context, next) => {
      context.set("actor", { ...actor, email: `${actor.id}@example.test` });
      await runAsTenant(actor.id, () => next());
    }),
  );
  return app.request(`/api/channels/${channelId}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const cardsFor = (tenant: string, runRef: string) =>
  runAsTenant(tenant, () =>
    database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenant), eq(tasks.runRef, runRef))),
  );

const itemsFor = (tenant: string, key: string) =>
  runAsTenant(tenant, () =>
    database
      .select()
      .from(workItems)
      .where(
        and(eq(workItems.kind, CHANNEL_DISPATCH_KIND), eq(workItems.key, key)),
      ),
  );

test("a non-member and another tenant's coworker are 404, and nothing is written", async () => {
  const strangerRun = dispatchRunId(bob.id, channel.id, "outsider");
  const outsider = await post(bob, channel.id, {
    id: "outsider",
    agentId: helperId,
    text: "@阿审 帮我看看",
  });
  expect(outsider.status).toBe(404);

  const foreignRun = dispatchRunId(alice.id, channel.id, "foreign");
  const foreign = await post(alice, channel.id, {
    id: "foreign",
    agentId: foreignId,
    text: "@别人的员工 做点事",
  });
  expect(foreign.status).toBe(404);

  for (const [tenant, key] of [
    [bob.id, strangerRun],
    [alice.id, foreignRun],
  ] as const) {
    expect(await itemsFor(tenant, key)).toHaveLength(0);
    expect(await cardsFor(tenant, key)).toHaveLength(0);
  }
  expect(await itemsFor("platform", strangerRun)).toHaveLength(0);
  expect(await itemsFor("platform", foreignRun)).toHaveLength(0);
});

test("a dispatch is accepted once, replayed idempotently, and filed under the asker's tenant", async () => {
  const body = {
    id: `m-${suite}`,
    agentId: helperId,
    text: "@阿审 审一下合同",
  };
  const runId = dispatchRunId(alice.id, channel.id, body.id);
  seededKeys.push(runId);

  const first = await post(alice, channel.id, body);
  expect(first.status).toBe(202);
  const accepted = (await first.json()) as {
    taskId: string;
    runId: string;
    queued: boolean;
  };
  expect(accepted).toMatchObject({ runId, queued: true });

  const replay = await post(alice, channel.id, body);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual({ ...accepted, queued: false });

  const cards = await cardsFor(alice.id, runId);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    id: accepted.taskId,
    tenantId: alice.id,
    source: "chat",
    executorAgentId: helperId,
    channelRef: channel.id,
    status: "running",
  });
  const items = await itemsFor(alice.id, runId);
  expect(items).toHaveLength(1);
  expect(items[0]?.tenantId).toBe(alice.id);

  // Row-level security: another tenant cannot see either row.
  expect(await cardsFor(bob.id, runId)).toHaveLength(0);
  expect(await itemsFor(bob.id, runId)).toHaveLength(0);
});

test("the worker runs the named coworker on the channel's thread, in the claimed row's tenant", async () => {
  const runId = dispatchRunId(alice.id, channel.id, `m-${suite}`);

  // From a timer's frame, as every loop runs; drained until this suite's turn has run.
  for (let round = 0; round < 20; round += 1) {
    if (turns.some((turn) => turn.runId === runId)) break;
    if (!(await runAsTenant("platform", () => service.sweep()))) break;
  }

  const turn = turns.find((candidate) => candidate.runId === runId);
  expect(turn).toBeDefined();
  expect(turn?.tenant).toBe(alice.id);
  expect(turn?.ownerUserId).toBe(alice.id);
  expect(turn?.agentId).toBe(helperId);
  expect(turn?.threadId).toBe(channel.threadId);
  expect(turn?.cardOwnedByCaller).toBe(true);
  expect(turn?.userMessage).toMatchObject({ content: "@阿审 审一下合同" });

  const [card] = await cardsFor(alice.id, runId);
  expect(card?.status).toBe("awaiting_review");
  expect(card?.tenantId).toBe(alice.id);
  expect(await cardsFor(alice.id, runId)).toHaveLength(1);
  const [item] = await itemsFor(alice.id, runId);
  expect(item?.finishedAt).not.toBeNull();
  expect(item?.attempts).toBe(1);

  // B3: the answer is said in the channel, as its own coworker's roster line, naming who answered.
  const [row] = await runAsTenant(alice.id, () =>
    database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAgentId: channels.lastMessageAgentId,
        tenantId: channels.tenantId,
      })
      .from(channels)
      .where(eq(channels.id, channel.id)),
  );
  expect(row?.lastMessage).toBe("阿审：看过了，第三条要改。");
  expect(row?.lastMessageAgentId).toBe(pinnedId);
  expect(row?.tenantId).toBe(alice.id);

  // Handed out once: nothing of this suite's is left to claim, and nothing is replayed.
  const before = turns.length;
  await runAsTenant("platform", () => service.sweep());
  expect(turns.filter((t) => t.runId === runId)).toHaveLength(1);
  expect(turns.length).toBe(before);
});

test("the restart sweep closes a dispatch card whose turn died, and leaves the rest", async () => {
  const STALE = new Date(Date.now() - 30 * 60_000);
  const PAST = new Date(Date.now() - 20 * 60_000);
  const FUTURE = new Date(Date.now() + 60 * 60_000);
  const runs = {
    dead: randomUUID(),
    finished: randomUUID(),
    backlog: randomUUID(),
    live: randomUUID(),
    freshDead: randomUUID(),
    plainChat: randomUUID(),
  };
  seededKeys.push(...Object.values(runs));
  const cards = Object.fromEntries(
    Object.keys(runs).map((name) => [name, randomUUID()]),
  ) as Record<keyof typeof runs, string>;

  await runAsTenant(alice.id, async () => {
    await database.insert(workItems).values([
      // Claimed by a process that never came back: handed out once, lease long gone.
      {
        kind: CHANNEL_DISPATCH_KIND,
        key: runs.dead,
        attempts: 1,
        claimedBy: "dead-replica",
        leaseUntil: PAST,
      },
      // Done, but the card was never closed.
      {
        kind: CHANNEL_DISPATCH_KIND,
        key: runs.finished,
        attempts: 1,
        finishedAt: PAST,
      },
      // Not claimed yet (and not due, so no worker here takes it): a backlog, not a wreck.
      {
        kind: CHANNEL_DISPATCH_KIND,
        key: runs.backlog,
        attempts: 0,
        runAt: FUTURE,
      },
      // A turn still running under a live lease.
      {
        kind: CHANNEL_DISPATCH_KIND,
        key: runs.live,
        attempts: 1,
        claimedBy: "live-replica",
        leaseUntil: FUTURE,
      },
      {
        kind: CHANNEL_DISPATCH_KIND,
        key: runs.freshDead,
        attempts: 1,
        claimedBy: "dead-replica",
        leaseUntil: PAST,
      },
    ]);
    const card = (name: keyof typeof runs, updatedAt: Date) => ({
      id: cards[name],
      tenantId: alice.id,
      title: `dispatch ${name} ${suite}`,
      executorAgentId: helperId,
      source: "chat" as const,
      status: "running" as const,
      channelRef: channel.id,
      runRef: runs[name],
      updatedAt,
    });
    await database.insert(tasks).values([
      card("dead", STALE),
      card("finished", STALE),
      card("backlog", STALE),
      card("live", STALE),
      card("freshDead", new Date()),
      // A person's own conversation card: no dispatch ledger row at all.
      card("plainChat", STALE),
    ]);
  });

  await projector.reclaimAbandoned({ olderThanMs: 10 * 60_000 });

  const statusOf = async (name: keyof typeof runs) => {
    const [row] = await cardsFor(alice.id, runs[name]);
    return row?.status;
  };
  expect(await statusOf("dead")).toBe("failed");
  expect(await statusOf("finished")).toBe("failed");
  expect(await statusOf("backlog")).toBe("running");
  expect(await statusOf("live")).toBe("running");
  expect(await statusOf("freshDead")).toBe("running");
  expect(await statusOf("plainChat")).toBe("running");

  // Closed where it lives: the sweep runs as `platform` and never re-stamps the tenant.
  const [dead] = await cardsFor(alice.id, runs.dead);
  expect(dead?.tenantId).toBe(alice.id);
});
