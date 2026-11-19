import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  tasks,
  threadRuns,
  threads,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { interruptStaleRuns } from "../src/recovery/interrupted-runs";
import { runAsTenant } from "../src/tenant/context";
import { RunEventWriter } from "../src/threads/run-event-writer";
import {
  createTurnNotifier,
  interruptedChatTurn,
  interruptedTurnTeller,
  oneToOneConversation,
  type TurnEndedInput,
} from "../src/threads/turn-notice";
import {
  createUserPreferencesStore,
  readRunEndNotice,
} from "../src/user-preferences";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What the end-of-turn notice reads from the database (期九·五): which conversation a thread is and
 * whether it is a one-to-one one, whether a cut-off turn was a person's own chat turn, and the person's
 * three switches. Each is read in the person's own frame, so one person's rows are never another's.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const people: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];
const threadIds: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(tasks).where(inArray(tasks.tenantId, people));
    await database
      .delete(intelligenceChannelMappings)
      .where(inArray(intelligenceChannelMappings.channelId, channelIds));
    await database.delete(channels).where(inArray(channels.id, channelIds));
    await database.delete(threads).where(inArray(threads.id, threadIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.end();
});

async function person(label: string): Promise<string> {
  const id = `tn-${suite}-${label}`;
  people.push(id);
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@tn.test`, name: label }),
  );
  return id;
}

async function employee(owner: string): Promise<string> {
  const id = `tn-${suite}-agent-${randomUUID().slice(0, 6)}`;
  agentIds.push(id);
  await runAsTenant(owner, () =>
    database.insert(agents).values({
      id,
      name: "员工",
      type: "built_in",
      configuration: { systemPrompt: "测试。" },
    }),
  );
  return id;
}

/** One person's conversation with one employee: a channel, their membership and their thread. */
async function directChat(owner: string, agentId: string) {
  const channelId = `tn-${suite}-ch-${randomUUID().slice(0, 6)}`;
  const threadId = randomUUID();
  channelIds.push(channelId);
  threadIds.push(threadId);
  await runAsTenant(owner, async () => {
    await database
      .insert(channels)
      .values({ id: channelId, name: "单聊", description: "" });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: owner });
    await database.insert(channelAgents).values({ channelId, agentId });
    await database
      .insert(intelligenceChannelMappings)
      .values({ userId: owner, channelId, threadId });
    await database.insert(threads).values({ id: threadId, agentId });
  });
  return { channelId, threadId };
}

describe("which conversation a thread is", () => {
  const lookup = oneToOneConversation(database);

  test("a person's thread with one employee is a one-to-one conversation, found by its channel", async () => {
    const alice = await person("alice");
    const worker = await employee(alice);
    const chat = await directChat(alice, worker);
    expect(
      await lookup({
        ownerUserId: alice,
        threadId: chat.threadId,
        agentId: worker,
      }),
    ).toEqual({ channelId: chat.channelId });
  });

  test("another employee, or a thread nobody has, is not", async () => {
    const alice = await person("alice2");
    const worker = await employee(alice);
    const other = await employee(alice);
    const chat = await directChat(alice, worker);
    expect(
      await lookup({
        ownerUserId: alice,
        threadId: chat.threadId,
        agentId: other,
      }),
    ).toBeNull();
    expect(
      await lookup({
        ownerUserId: alice,
        threadId: randomUUID(),
        agentId: worker,
      }),
    ).toBeNull();
  });

  test("a group conversation, which has several employees, is not: its turns have their own notices", async () => {
    const alice = await person("alice3");
    const writer = await employee(alice);
    const coder = await employee(alice);
    const channelId = `tn-${suite}-grp-${randomUUID().slice(0, 6)}`;
    const threadId = randomUUID();
    channelIds.push(channelId);
    threadIds.push(threadId);
    await runAsTenant(alice, async () => {
      await database.insert(channels).values({
        id: channelId,
        tenantId: TEAM_TENANT,
        name: "群组",
        description: "",
      });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: alice, tenantId: TEAM_TENANT });
      for (const agentId of [writer, coder])
        await database
          .insert(channelAgents)
          .values({ channelId, agentId, tenantId: TEAM_TENANT });
      await database
        .insert(intelligenceChannelMappings)
        .values({ userId: alice, channelId, threadId });
    });
    // Both employees are there for the person to see, so that is what makes it a group, not a gap.
    const visible = await runAsTenant(alice, () =>
      database
        .select({ agentId: channelAgents.agentId })
        .from(channelAgents)
        .where(eq(channelAgents.channelId, channelId)),
    );
    expect(visible).toHaveLength(2);
    expect(
      await lookup({ ownerUserId: alice, threadId, agentId: writer }),
    ).toBeNull();
  });

  test("another person never finds somebody else's conversation, by thread or by channel", async () => {
    const alice = await person("alice4");
    const bob = await person("bob4");
    const worker = await employee(alice);
    const chat = await directChat(alice, worker);
    expect(
      await lookup({
        ownerUserId: bob,
        threadId: chat.threadId,
        agentId: worker,
      }),
    ).toBeNull();
  });
});

describe("whether a cut-off turn was a person's own chat turn", () => {
  const lookup = interruptedChatTurn(database);

  async function turn(owner: string, source: "chat" | "group_run" | "routine") {
    const agentId = await employee(owner);
    const threadId = randomUUID();
    const runId = `run-${randomUUID()}`;
    threadIds.push(threadId);
    await runAsTenant(owner, async () => {
      await database.insert(threads).values({ id: threadId, agentId });
      await database.insert(threadRuns).values({
        id: runId,
        threadId,
        agentId,
        createdAt: new Date("2026-11-19T01:00:00Z"),
      });
      await database.insert(tasks).values({
        title: "做个报告",
        source,
        channelRef: threadId,
        runRef: runId,
        status: "running",
      });
    });
    return { agentId, runId };
  }

  test("a chat turn names its employee and when it began", async () => {
    const alice = await person("alice5");
    const { agentId, runId } = await turn(alice, "chat");
    expect(await lookup({ tenantId: alice, runId })).toEqual({
      agentId,
      startedAt: Date.parse("2026-11-19T01:00:00Z"),
    });
  });

  test("a group's step or a routine's firing is not: they are told their own way", async () => {
    const alice = await person("alice6");
    for (const source of ["group_run", "routine"] as const) {
      const { runId } = await turn(alice, source);
      expect(await lookup({ tenantId: alice, runId })).toBeNull();
    }
  });

  test("another person does not find the turn", async () => {
    const alice = await person("alice7");
    const bob = await person("bob7");
    const { runId } = await turn(alice, "chat");
    expect(await lookup({ tenantId: bob, runId })).toBeNull();
  });
});

describe("the three switches", () => {
  const store = createUserPreferencesStore(database).runEndNotice;

  test("are all on until the person turns one off", async () => {
    const alice = await person("alice8");
    expect(await runAsTenant(alice, () => store?.read(alice))).toEqual({
      push: true,
      im: true,
      desktop: true,
    });
    expect(await readRunEndNotice(database, alice)).toEqual({
      push: true,
      im: true,
      desktop: true,
    });
  });

  test("a save names any of them and keeps the rest, so each switch is its own", async () => {
    const alice = await person("alice9");
    expect(
      await runAsTenant(alice, () => store?.patch(alice, { push: false })),
    ).toEqual({
      push: false,
      im: true,
      desktop: true,
    });
    expect(
      await runAsTenant(alice, () => store?.patch(alice, { desktop: false })),
    ).toEqual({
      push: false,
      im: true,
      desktop: false,
    });
    expect(
      await runAsTenant(alice, () =>
        store?.patch(alice, { push: true, im: false }),
      ),
    ).toEqual({
      push: true,
      im: false,
      desktop: false,
    });
    expect(await readRunEndNotice(database, alice)).toEqual({
      push: true,
      im: false,
      desktop: false,
    });
  });

  test("one person's switches are not another's", async () => {
    const alice = await person("alice10");
    const bob = await person("bob10");
    await runAsTenant(alice, () =>
      store?.patch(alice, { push: false, im: false, desktop: false }),
    );
    expect(await readRunEndNotice(database, bob)).toEqual({
      push: true,
      im: true,
      desktop: true,
    });
  });

  test("the general preferences read keeps its shape, and saving other preferences keeps the switches", async () => {
    const alice = await person("alice11");
    const preferences = createUserPreferencesStore(database);
    await runAsTenant(alice, () =>
      preferences.runEndNotice?.patch(alice, { im: false }),
    );
    const general = await runAsTenant(alice, () =>
      preferences.patch(alice, { messageListEmphasis: "agent" }),
    );
    expect(Object.keys(general)).not.toContain("runEndNotice");
    expect(
      Object.keys(await runAsTenant(alice, () => preferences.read(alice))),
    ).not.toContain("runEndNotice");
    expect(await readRunEndNotice(database, alice)).toEqual({
      push: true,
      im: false,
      desktop: true,
    });
  });

  test("a row that says something other than false reads as on: a malformed row never silences a person", async () => {
    const alice = await person("alice12");
    await runAsTenant(alice, () =>
      database
        .update(users)
        .set({
          // Written by hand, as a row from an older build or a bad edit might be: not what the type allows.
          preferences: {
            runEndNotice: { push: "no", im: 0, desktop: false },
          } as never,
        })
        .where(eq(users.id, alice)),
    );
    expect(await readRunEndNotice(database, alice)).toEqual({
      push: true,
      im: true,
      desktop: false,
    });
  });
});

describe("a restart that cut a turn off", () => {
  /** What a dead process leaves: the turn's rows written as it ran, and its card on the board. */
  async function died(owner: string, source: "chat" | "group_run") {
    const agentId = await employee(owner);
    const threadId = randomUUID();
    const runId = `dead-${randomUUID().slice(0, 8)}`;
    threadIds.push(threadId);
    await runAsTenant(owner, async () => {
      await database.insert(threads).values({ id: threadId, agentId });
      await database.insert(tasks).values({
        title: "做个报告",
        source,
        channelRef: threadId,
        runRef: runId,
        status: "running",
      });
    });
    const writer = new RunEventWriter(database, {
      tenant: owner,
      threadId,
      runId,
      agentId,
      startedAt: Date.now() - 12 * 60_000,
    });
    for (const event of [
      { type: EventType.RUN_STARTED, threadId, runId },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "say",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "say",
        delta: "开始。",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "say" },
    ] as BaseEvent[])
      writer.push(event);
    await writer.flush();
    // It began twelve minutes ago: the run's row is stamped when it is first written.
    await runAsTenant(owner, () =>
      database
        .update(threadRuns)
        .set({ createdAt: new Date(Date.now() - 12 * 60_000) })
        .where(eq(threadRuns.id, runId)),
    );
    return { agentId, threadId, runId };
  }

  function sweepWith(options: { oneToOne?: boolean } = {}) {
    const decided: TurnEndedInput[] = [];
    const told: string[] = [];
    const notifier = createTurnNotifier({
      viewers: () => 0,
      preferences: async () => ({ push: true, im: true, desktop: true }),
      conversation: async () =>
        options.oneToOne === false ? null : { channelId: "chat-x" },
      botName: async () => "研究员",
      notify: async (_scope, input) => {
        told.push(input.text);
      },
      announce: async () => {},
    });
    const tell = interruptedTurnTeller({
      lookup: interruptedChatTurn(database),
      notifier: () => ({
        ended: (input) => {
          decided.push(input);
          return notifier.ended(input);
        },
      }),
    });
    return { decided, told, tell };
  }

  test("a person's own chat turn is told to them as interrupted, with its employee and how long it ran", async () => {
    const alice = await person("alice13");
    const { agentId, threadId, runId } = await died(alice, "chat");
    const f = sweepWith();
    await interruptStaleRuns({
      database,
      staleMs: 0,
      closed: (run) => (run.runId === runId ? f.tell(run) : undefined),
    });
    expect(f.decided).toHaveLength(1);
    expect(f.decided[0]).toMatchObject({
      ownerUserId: alice,
      agentId,
      threadId,
      runId,
      end: { kind: "interrupted" },
    });
    expect(f.told).toHaveLength(1);
    expect(f.told[0]).toMatch(
      /^研究员：服务重启，这一轮在中途被打断了，回复「继续」接着做（已跑 12 分钟）$/,
    );
  });

  test("a turn that is not a person's chat turn (a group's step) says nothing", async () => {
    const alice = await person("alice14");
    const { runId } = await died(alice, "group_run");
    const f = sweepWith();
    await interruptStaleRuns({
      database,
      staleMs: 0,
      closed: (run) => (run.runId === runId ? f.tell(run) : undefined),
    });
    expect(f.decided).toHaveLength(0);
    expect(f.told).toHaveLength(0);
  });

  test("a chat turn of a conversation that is not one-to-one says nothing either", async () => {
    const alice = await person("alice15");
    const { runId } = await died(alice, "chat");
    const f = sweepWith({ oneToOne: false });
    await interruptStaleRuns({
      database,
      staleMs: 0,
      closed: (run) => (run.runId === runId ? f.tell(run) : undefined),
    });
    expect(f.decided).toHaveLength(1);
    expect(f.told).toHaveLength(0);
  });
});
