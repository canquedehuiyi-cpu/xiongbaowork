import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/app-variables";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  groupBotThreads,
  groupTaskRuns,
  intelligenceChannelMappings,
  tasks,
  users,
  wakerGroups,
} from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * N1 / WP-1.1: every card the board renders has an "打开" that lands somewhere.
 *
 * The audit found fifteen cards and not one resolvable link. The cause is that `tasks.channel_ref` was
 * never one column's meaning: the routine and the group write a CHANNEL id, the conversation runner and
 * a hand-off write a THREAD id (which is not the channel's id — `channel_d049…` has thread `55569917-…`),
 * a crew's cards write nothing at all, and the screen built `/channel/$id` out of whichever of those it
 * was handed.
 *
 * So the answer is computed at read time rather than rewritten at write time: history becomes correct
 * without a migration, and the four write sites keep saying what each of them means. What the route now
 * owes the screen is one field per card — `open` — and this file asks the five shapes that field has to
 * cover, plus the two ways it must refuse: another workspace's thread id, and a target that is gone.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `open-${suite}`;
const stranger = `open-stranger-${suite}`;

const actor = { id: tenant, role: "user" as const };
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const projector = createTaskProjector(database);
const routes = createTaskRoutes(database, requireUser, projector);

type Open = { kind: string; id: string } | null;

/** The board's list, as the screen asks for it: id → the link the route resolved for it. */
async function openByTask(): Promise<Map<string, Open>> {
  return runAsTenant(tenant, async () => {
    const response = await routes.request(
      new Request("http://openbot.test/?q=open-target"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tasks: { id: string; open: Open }[];
    };
    return new Map(body.tasks.map((task) => [task.id, task.open]));
  });
}

const created: {
  channelIds: string[];
  agentIds: string[];
  groupIds: string[];
} = { channelIds: [], agentIds: [], groupIds: [] };

async function makeUser(id: string) {
  await runAsTenant(id, async () => {
    await database.insert(users).values({ id, email: `${id}@example.test` });
  });
}

/** Membership is the tenancy proof the resolver asks for, so both workspaces have to be people. */
await makeUser(tenant);

/** A conversation with `coworkers` Bots in it — the sidebar's own rule for group versus channel. */
async function makeChannel(
  owner: string,
  coworkers: string[],
  threadId: string,
): Promise<string> {
  const id = `channel_${randomUUID()}`;
  created.channelIds.push(id);
  await runAsTenant(owner, async () => {
    await database
      .insert(channels)
      .values({ id, tenantId: owner, name: "走查", description: "" });
    await database
      .insert(channelMemberships)
      .values({ channelId: id, userId: owner, tenantId: owner });
    for (const agentId of coworkers) {
      await database
        .insert(channelAgents)
        .values({ channelId: id, agentId, tenantId: owner });
    }
    await database.insert(intelligenceChannelMappings).values({
      userId: owner,
      tenantId: owner,
      channelId: id,
      threadId,
    });
  });
  return id;
}

async function makeAgent(name: string): Promise<string> {
  const id = `${suite}-${name}`;
  created.agentIds.push(id);
  await runAsTenant(tenant, async () => {
    await database
      .insert(agents)
      .values({
        id,
        tenantId: tenant,
        name,
        type: "built_in",
        configuration: {},
      });
  });
  return id;
}

/** One card, titled so the query above finds exactly the rows this file wrote. */
async function openCard(input: {
  source: "chat" | "routine" | "responsibility" | "handoff" | "group_run";
  channelRef?: string;
  runRef?: string;
  parentTaskId?: string;
  owner?: string;
}): Promise<string> {
  return projector.opened({
    tenantId: input.owner ?? tenant,
    title: `open-target ${input.source} ${randomUUID().slice(0, 8)}`,
    executorAgentId: created.agentIds[0] ?? null,
    source: input.source,
    ...(input.channelRef ? { channelRef: input.channelRef } : {}),
    ...(input.runRef ? { runRef: input.runRef } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
  });
}

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database
      .delete(groupTaskRuns)
      .where(eq(groupTaskRuns.tenantId, tenant));
    await database
      .delete(wakerGroups)
      .where(inArray(wakerGroups.id, created.groupIds));
    await database.delete(tasks).where(eq(tasks.tenantId, tenant));
  });
  await runAsTenant(stranger, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, stranger));
  });
  for (const id of created.channelIds) {
    await runAsTenant(tenant, async () => {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database
        .delete(groupBotThreads)
        .where(eq(groupBotThreads.channelId, id));
      await database
        .delete(channelAgents)
        .where(eq(channelAgents.channelId, id));
      await database
        .delete(channelMemberships)
        .where(eq(channelMemberships.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    });
  }
  await runAsTenant(tenant, async () => {
    await database.delete(agents).where(inArray(agents.id, created.agentIds));
    await database.delete(users).where(eq(users.id, tenant));
  });
  await runAsTenant(stranger, async () => {
    await database.delete(users).where(eq(users.id, stranger));
  });
  await database.$client.end({ timeout: 5 });
});

test("a routine's card opens the conversation it fires into", async () => {
  const bot = await makeAgent("routine-bot");
  const thread = `thread_${randomUUID()}`;
  const channelId = await makeChannel(tenant, [bot], thread);
  // The routine writes a CHANNEL id — the one shape the screen already got right.
  const id = await openCard({ source: "routine", channelRef: channelId });

  const open = (await openByTask()).get(id);
  expect(open).toEqual({ kind: "channel", id: channelId });
});

test("a group's card opens the group, because two coworkers answer there", async () => {
  const first = await makeAgent("group-bot-1");
  const second = await makeAgent("group-bot-2");
  const thread = `thread_${randomUUID()}`;
  const channelId = await makeChannel(tenant, [first, second], thread);
  const id = await openCard({ source: "chat", channelRef: channelId });

  const open = (await openByTask()).get(id);
  // Same route, different screen: the sidebar sends a channel with more than one Bot to /group/.
  expect(open).toEqual({ kind: "group", id: channelId });
});

test("a conversation card resolves the thread id it was written with back to its channel", async () => {
  const bot = await makeAgent("chat-bot");
  const thread = `thread_${randomUUID()}`;
  const channelId = await makeChannel(tenant, [bot], thread);
  /*
   * This is the dead link the audit hit fifteen times: `threads/postgres-runner.ts` puts the THREAD id in
   * `channel_ref`, and a thread id is not a channel id, so `/channel/<thread>` answered "could not load".
   */
  const id = await openCard({ source: "chat", channelRef: thread });

  const open = (await openByTask()).get(id);
  expect(open).toEqual({ kind: "channel", id: channelId });
});

test("a hand-off card opens the group conversation whose coworker thread it ran in", async () => {
  const bot = await makeAgent("handoff-bot-1");
  const other = await makeAgent("handoff-bot-2");
  const thread = `thread_${randomUUID()}`;
  const channelId = await makeChannel(
    tenant,
    [bot, other],
    `thread_${randomUUID()}`,
  );
  await runAsTenant(tenant, async () => {
    await database
      .insert(groupBotThreads)
      .values({
        ownerUserId: tenant,
        tenantId: tenant,
        channelId,
        agentId: bot,
        threadId: thread,
      });
  });
  const id = await openCard({ source: "handoff", channelRef: thread });

  const open = (await openByTask()).get(id);
  expect(open).toEqual({ kind: "group", id: channelId });
});

test("a crew's parent and its step both open the run, and the step does not open itself", async () => {
  const bot = await makeAgent("crew-bot");
  const runId = randomUUID();
  const stepRunRef = randomUUID();
  const groupId = randomUUID();
  created.groupIds.push(groupId);
  await runAsTenant(tenant, async () => {
    await database
      .insert(wakerGroups)
      .values({ id: groupId, tenantId: tenant, name: "走查组" });
    await database.insert(groupTaskRuns).values({
      id: runId,
      tenantId: tenant,
      groupId,
      status: "running",
      cursor: 1,
      steps: [],
    });
  });
  /*
   * Neither card carries a channel: a crew is not a conversation, and the panel that shows it is
   * `/pipelines?run=<id>`. The parent's run reference IS the run id; the step's is its own turn, so the
   * step has to be read through the parent it hangs under — otherwise both cards point at a run that
   * has no panel.
   */
  const parent = await openCard({ source: "group_run", runRef: runId });
  const step = await openCard({
    source: "group_run",
    runRef: stepRunRef,
    parentTaskId: parent,
  });

  const opened = await openByTask();
  expect(opened.get(parent)).toEqual({ kind: "pipeline", id: runId });
  expect(opened.get(step)).toEqual({ kind: "pipeline", id: runId });
  void bot;
});

test("a card that does not belong to a conversation answers null rather than a dead link", async () => {
  const id = await openCard({
    source: "responsibility",
    channelRef: `thread_never_mapped_${randomUUID()}`,
  });
  const open = (await openByTask()).get(id);
  expect(open).toBeNull();
});

test("another workspace's thread id resolves to nothing, not to its channel", async () => {
  await makeUser(stranger);
  const strangerBot = `${suite}-stranger-bot`;
  await runAsTenant(stranger, async () => {
    await database.insert(agents).values({
      id: strangerBot,
      tenantId: stranger,
      name: "别人的员工",
      type: "built_in",
      configuration: {},
    });
  });
  const strangerThread = `thread_${randomUUID()}`;
  const strangerChannel = await makeChannel(
    stranger,
    [strangerBot],
    strangerThread,
  );

  /*
   * The mapping table is a lookup, and a lookup that ignores whose it is turns the board into a window
   * onto somebody else's conversations. Spec D15: the honest answer about a scope with no such row is
   * the same answer as about a row that does not exist.
   */
  const id = await openCard({ source: "chat", channelRef: strangerThread });

  const open = (await openByTask()).get(id);
  expect(open).toBeNull();
  // …and the stranger's own channel is still real, so the null above is refusal rather than absence.
  const theirs = await runAsTenant(stranger, async () =>
    database
      .select({ id: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.threadId, strangerThread)),
  );
  expect(theirs.map((row) => row.id)).toEqual([strangerChannel]);
});

test("a crew whose run is gone opens nothing", async () => {
  const goneRunId = randomUUID();
  const id = await openCard({ source: "group_run", runRef: goneRunId });
  const open = (await openByTask()).get(id);
  expect(open).toBeNull();
});
