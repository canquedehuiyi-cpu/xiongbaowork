import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { TURN_TIME_LIMIT_MINUTES } from "@xiongbao/shared/turn-notices";
import { TURN_LIMITS } from "@xiongbao/toolkit/limits";
import { eq, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  threadRunLiveness,
  threadRuns,
  threads,
  users,
} from "../src/db/schema";
import { RUN_STALE_MS } from "../src/recovery/interrupted-runs";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { afterAll, afterEach, test } from "./support/platform-frame";

/**
 * A person's own turn, running on the server, as work their conversation is waiting on (期九·四).
 *
 * The page can be closed while the turn goes on, so the roster has to be able to say 「后台进行中」
 * from the rows alone: a turn writes a `thread_run_liveness` row as it goes, and a heartbeat every
 * write moves forward. These tests write those rows the way the run writer does and read the answer
 * back, because the list is a query over them.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
/** The deployment that runs a chat's computer tools on the server. */
const withTurns = createChannelStore(database, profileStore, threadIdentity, {
  turns: true,
});
/** One that has not switched that on: it answers exactly what it always did. */
const withoutTurns = createChannelStore(database, profileStore, threadIdentity);

const testPrefix = `channel-turn-work-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdThreadIds: string[] = [];

afterEach(async () => {
  for (const threadId of createdThreadIds.splice(0))
    await database.delete(threads).where(eq(threads.id, threadId));
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0))
    await database.delete(users).where(eq(users.id, userId));
});

afterAll(async () => {
  await database.$client.close();
});

async function setup() {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Turn Work Test User",
    }),
  );
  createdUserIds.push(id);
  const owner: AgentActor = { id, role: "user" };
  const profile = await runAsTenant(owner.id, () =>
    profileStore.create(owner, {
      name: "Researcher",
      title: "Research",
      roleDescription: "Find things out.",
      visibility: "private",
    }),
  );
  createdAgentIds.push(profile.id);
  const channel = await runAsTenant(owner.id, () =>
    withTurns.create(owner, [profile.id]),
  );
  createdChannelIds.push(channel.id);
  return { owner, botId: profile.id, channel };
}

/** A turn's rows as the run writer leaves them: the thread, the run, and its liveness. */
async function turn(
  owner: AgentActor,
  input: {
    threadId: string;
    botId: string;
    status?: "running" | "finished" | "interrupted";
    /** How long ago the turn began and its heartbeat last moved, in milliseconds. */
    startedAgoMs?: number;
    heartbeatAgoMs?: number;
  },
) {
  const runId = `${testPrefix}-run-${randomUUID()}`;
  const startedAt = new Date(Date.now() - (input.startedAgoMs ?? 0));
  await runAsTenant(owner.id, async () => {
    await database
      .insert(threads)
      .values({ id: input.threadId, agentId: input.botId })
      .onConflictDoNothing();
    await database.insert(threadRuns).values({
      id: runId,
      threadId: input.threadId,
      agentId: input.botId,
      createdAt: startedAt,
    });
    await database.insert(threadRunLiveness).values({
      runId,
      status: input.status ?? "running",
      heartbeatAt: sql`now() - (${input.heartbeatAgoMs ?? 0} * interval '1 millisecond')`,
    });
  });
  if (!createdThreadIds.includes(input.threadId))
    createdThreadIds.push(input.threadId);
  return { runId, startedAt };
}

async function workFor(
  store: typeof withTurns,
  owner: AgentActor,
  channel: { id: string; threadId: string },
) {
  return (
    (await runAsTenant(owner.id, () => store.workIn(owner, [channel]))).get(
      channel.id,
    ) ?? []
  );
}

describe("a person's own turn as work", () => {
  test("a turn running on the server, with the clock it started on", async () => {
    const { owner, botId, channel } = await setup();
    const { runId, startedAt } = await turn(owner, {
      threadId: channel.threadId,
      botId,
      startedAgoMs: 12 * 60_000,
    });

    const work = await workFor(withTurns, owner, channel);

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "turn",
      key: runId,
      botId,
      botName: "Researcher",
    });
    expect(work[0]?.since.getTime()).toBe(startedAt.getTime());
  });

  test("nothing once the turn has finished or was marked interrupted", async () => {
    const { owner, botId, channel } = await setup();
    await turn(owner, {
      threadId: channel.threadId,
      botId,
      status: "finished",
    });
    await turn(owner, {
      threadId: channel.threadId,
      botId,
      status: "interrupted",
    });

    expect(await workFor(withTurns, owner, channel)).toEqual([]);
  });

  test("nothing for a turn whose process stopped writing: it is the restart sweep's, not work", async () => {
    const { owner, botId, channel } = await setup();
    await turn(owner, {
      threadId: channel.threadId,
      botId,
      heartbeatAgoMs: RUN_STALE_MS + 5_000,
    });

    expect(await workFor(withTurns, owner, channel)).toEqual([]);
  });

  test("a deployment that has not switched it on answers what it always did", async () => {
    const { owner, botId, channel } = await setup();
    await turn(owner, { threadId: channel.threadId, botId });

    expect(await workFor(withoutTurns, owner, channel)).toEqual([]);
  });

  test("only the person's own thread: another thread's turn is not theirs to see", async () => {
    const { owner, botId, channel } = await setup();
    await turn(owner, {
      threadId: `${testPrefix}-elsewhere-${randomUUID()}`,
      botId,
    });

    expect(await workFor(withTurns, owner, channel)).toEqual([]);
  });
});

describe("the limit the screen names", () => {
  test("is the minutes a person's turn actually runs under", () => {
    expect(TURN_TIME_LIMIT_MINUTES * 60_000).toBe(
      TURN_LIMITS.workTurnTimeoutMs,
    );
  });
});
