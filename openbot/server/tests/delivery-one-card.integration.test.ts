import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  groupTaskRuns,
  intelligenceChannelMappings,
  tasks,
  threadRunEvents,
  threadRuns,
  threads,
  users,
  wakerGroups,
  workItems,
} from "../src/db/schema";
import type { PipelineStepStateRow } from "../src/db/schema/pipeline";
import { reapAbandonedPipelineRuns } from "../src/pipeline/reap";
import { createQuotaService } from "../src/quota/limits";
import { createDelivery, firstSentenceOf } from "../src/tasks/delivery";
import { listTaskEvents } from "../src/tasks/events";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 一件活一张卡 (spec 2026-11-15-delivery-loop §2, §3): a followed card spans turns.
 *
 * Every turn of a thread whose coworker holds an open tracked card -- a follow-up, a nudge, a return,
 * an unrelated question -- hangs on that card: no second card, no second charge against the month,
 * one progress line, and the card's lane is not moved by the turn ending. A card nobody tracks keeps
 * the old shape, one per turn. The turns are real turns through the real runner and projector; only
 * the coworker is a stub, because what is under test is the board, not what a model said.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const quota = createQuotaService(database);
const projector = createTaskProjector(database, undefined, quota);
const delivery = createDelivery(database);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];

async function tenant(label: string): Promise<string> {
  const id = `dl-${label}-${suite}`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email: `${id}@example.test` }),
  );
  tenants.push(id);
  return id;
}

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 80 && !done(value); attempt++) {
    await settle(25);
    value = await read();
  }
  return value;
}

const reply = (text: string): BaseEvent[] =>
  [
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "m" },
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
  ] as unknown as BaseEvent[];

const failure = (message: string): BaseEvent[] =>
  [
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    { type: EventType.RUN_ERROR, message },
  ] as unknown as BaseEvent[];

/** A display component drawn in the turn: on an untracked card it would be the deliverable. */
const chart = (): BaseEvent[] =>
  [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: `call-${randomUUID()}`,
      toolCallName: "showBarChart",
    },
  ] as unknown as BaseEvent[];

/**
 * One real turn through the real runner. `during` runs while the coworker is "thinking", which is
 * where a tool such as `accept_task` (Task 3) would mark the card.
 */
async function turn(input: {
  tenantId: string;
  agentId: string;
  threadId: string;
  ask: string;
  events: BaseEvent[];
  during?: (runId: string) => Promise<void>;
}): Promise<string> {
  const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
  const runner = new PostgresAgentRunner(database, projector, quota);
  const agent = {
    agentId: input.agentId,
    messages: [],
    abortRun: () => undefined,
    runAgent: async (
      _input: RunAgentInput,
      handlers: { onEvent: (arg: { event: BaseEvent }) => void },
    ) => {
      await settle(20);
      await input.during?.(runId);
      for (const event of input.events) handlers.onEvent({ event });
    },
  } as unknown as AbstractAgent;
  await runAsTenant(input.tenantId, async () => {
    await new Promise<void>((resolve) => {
      runner
        .run({
          threadId: input.threadId,
          agent,
          input: {
            runId,
            threadId: input.threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [
              { id: `msg-${randomUUID()}`, role: "user", content: input.ask },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          complete: () => void resolve(),
          error: () => void resolve(),
        });
    });
  });
  return runId;
}

const cardsOf = (tenantId: string, where = eq(tasks.tenantId, tenantId)) =>
  runAsTenant(tenantId, () =>
    database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), where))
      .orderBy(asc(tasks.createdAt)),
  );

const cardOfRun = async (tenantId: string, runId: string) =>
  (await cardsOf(tenantId, eq(tasks.runRef, runId)))[0];

const eventsOf = (tenantId: string, taskId: string) =>
  runAsTenant(tenantId, () => listTaskEvents(database, { tenantId, taskId }));

/** Wait until the turn named by `runId` has written its end line on the card. */
const roundLogged = (tenantId: string, taskId: string, runId: string) =>
  until(
    () => eventsOf(tenantId, taskId),
    (rows) =>
      rows.some(
        (row) =>
          (row.kind === "run_ended" || row.kind === "run_failed") &&
          row.detail.runId === runId,
      ),
  );

const tasksUsed = async (tenantId: string) =>
  (await quota.usageFor(tenantId)).tasks;

/** A card opened by the turn, then followed the way `accept_task` (Task 3) follows it. */
const acceptInTurn =
  (tenantId: string, agentId: string, threadId: string) =>
  async (runId: string) => {
    const card = await until(
      () => cardOfRun(tenantId, runId),
      (row) => row !== undefined,
    );
    if (!card) throw new Error("the turn opened no card");
    await delivery.markTracked(tenantId, card.id, `agent:${agentId}`, {
      threadRef: threadId,
    });
    await runAsTenant(tenantId, () =>
      database
        .update(tasks)
        .set({ acceptedAt: new Date() })
        .where(eq(tasks.id, card.id)),
    );
  };

describe("one tracked piece of work, one card", () => {
  test("follow-up, nudge-like and return-like turns on a tracked card's thread add no new card and charge quota once", async () => {
    const tenantId = await tenant("three");
    const agentId = `agent-${suite}-a`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const before = await tasksUsed(tenantId);

    const first = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "核对三家供应商的发票",
      events: reply("好的，已接下。预计四十分钟交。"),
      during: acceptInTurn(tenantId, agentId, threadId),
    });
    const card = await cardOfRun(tenantId, first);
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, first);
    expect(await tasksUsed(tenantId)).toBe(before + 1);

    const later: string[] = [];
    for (const ask of [
      "进度怎么样了？",
      "【催办】「核对发票」已到预计时间，请交已做完的部分或申请延期。",
      "退回：缺 C 家的发票，请补上。",
    ]) {
      const runId = await turn({
        tenantId,
        agentId,
        threadId,
        ask,
        events: reply("收到，正在处理 C 家。稍后交。"),
      });
      later.push(runId);
      await roundLogged(tenantId, card.id, runId);
    }

    const rows = await cardsOf(tenantId, eq(tasks.executorAgentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(card.id);
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.tracked).toBe(true);
    expect(rows[0]?.threadRef).toBe(threadId);
    // The card charged once, when it was opened; the three turns that hung on it charged nothing.
    expect(await tasksUsed(tenantId)).toBe(before + 1);

    const events = await eventsOf(tenantId, card.id);
    expect(events.filter((row) => row.kind === "dispatched")).toHaveLength(1);
    // One end line and one progress line per turn, the first turn included.
    expect(events.filter((row) => row.kind === "run_ended")).toHaveLength(4);
    const progress = events.filter((row) => row.kind === "progress");
    expect(progress).toHaveLength(4);
    expect(progress[0]?.detail.text).toBe("好的，已接下。");
    expect(progress.slice(1).map((row) => row.detail.runId)).toEqual(later);
    expect(progress[1]?.detail.text).toBe("收到，正在处理 C 家。");
    expect(progress[1]?.actor).toBe(`agent:${agentId}`);
  });

  test("an unrelated turn on a tracked thread logs one progress line and does not advance the card", async () => {
    const tenantId = await tenant("unrelated");
    const agentId = `agent-${suite}-b`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const first = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "做一份竞品对比",
      events: reply("已接下，预计下午三点交。"),
      during: acceptInTurn(tenantId, agentId, threadId),
    });
    const card = await cardOfRun(tenantId, first);
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, first);
    const linesBefore = (await eventsOf(tenantId, card.id)).length;

    // Nothing to do with the work, and it even draws a chart: on an untracked card that is a
    // deliverable and a move to 查收结果. Here it must be neither.
    const runId = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "顺便问一下，今天上海天气怎么样？",
      events: [
        ...chart(),
        ...reply("今天上海多云，最高二十度！要不要我再查一下明天的？"),
      ],
    });
    await roundLogged(tenantId, card.id, runId);

    const rows = await cardsOf(tenantId, eq(tasks.executorAgentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.deliverableRef).toBeNull();
    const added = (await eventsOf(tenantId, card.id)).slice(linesBefore);
    expect(added.map((row) => row.kind)).toEqual(["progress", "run_ended"]);
    expect(added[0]?.detail).toEqual({
      runId,
      text: "今天上海多云，最高二十度！",
    });
  });

  test("a second accept on the same thread opens a new tracked card and later turns attach to it", async () => {
    const tenantId = await tenant("second");
    const agentId = `agent-${suite}-c`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const first = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "整理三月报表",
      events: reply("已接下。"),
      during: acceptInTurn(tenantId, agentId, threadId),
    });
    const cardA = await cardOfRun(tenantId, first);
    if (!cardA) throw new Error("no card");
    await roundLogged(tenantId, cardA.id, first);

    // A turn on card A in which the coworker takes on a SECOND piece of work: Task 3's `accept_task`
    // opens a new card for it; simulated here with the projector, `markTracked` and `accepted_at`.
    let cardB = "";
    const second = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "另外再帮我订下周的会议室",
      events: reply("好的，会议室这件也接下了。"),
      during: async (runId) => {
        cardB = await projector.opened({
          tenantId,
          title: "订下周的会议室",
          executorAgentId: agentId,
          source: "chat",
          channelRef: threadId,
          runRef: `${runId}:accept`,
        });
        await delivery.markTracked(tenantId, cardB, `agent:${agentId}`, {
          threadRef: threadId,
        });
        await runAsTenant(tenantId, () =>
          database
            .update(tasks)
            .set({ acceptedAt: new Date(Date.now() + 1000) })
            .where(eq(tasks.id, cardB)),
        );
      },
    });
    await roundLogged(tenantId, cardA.id, second);
    expect(await delivery.openTrackedCard(tenantId, threadId, agentId)).toEqual(
      { id: cardB },
    );

    const third = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "会议室订好了吗？",
      events: reply("正在查空闲的会议室。"),
    });
    await roundLogged(tenantId, cardB, third);
    const onA = await eventsOf(tenantId, cardA.id);
    expect(onA.some((row) => row.detail.runId === third)).toBe(false);
    const rows = await cardsOf(tenantId, eq(tasks.executorAgentId, agentId));
    expect(rows.map((row) => row.id).sort()).toEqual([cardA.id, cardB].sort());
    expect(rows.every((row) => row.status === "running")).toBe(true);
  });

  test("a failed run keeps the tracked card running with last_error and a run_failed event", async () => {
    const tenantId = await tenant("failed");
    const agentId = `agent-${suite}-d`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const first = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "汇总上周的工单",
      events: reply("已接下。"),
      during: acceptInTurn(tenantId, agentId, threadId),
    });
    const card = await cardOfRun(tenantId, first);
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, first);

    const broken = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "继续",
      events: failure("模型连接中断"),
    });
    await roundLogged(tenantId, card.id, broken);
    let [row] = await cardsOf(tenantId, eq(tasks.id, card.id));
    expect(row?.status).toBe("running");
    expect(row?.lastError).toBe("模型连接中断");
    const failed = (await eventsOf(tenantId, card.id)).filter(
      (line) => line.kind === "run_failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toEqual({
      runId: broken,
      error: "模型连接中断",
    });
    // A round is recorded once: a second report of the same run writes nothing.
    await delivery.runEnded(tenantId, card.id, {
      runId: broken,
      failed: true,
      error: "again",
    });
    expect(
      (await eventsOf(tenantId, card.id)).filter(
        (line) => line.detail.runId === broken,
      ),
    ).toHaveLength(1);

    // The next round that works clears it.
    const mended = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "再试一次",
      events: reply("这次好了。"),
    });
    await roundLogged(tenantId, card.id, mended);
    [row] = await cardsOf(tenantId, eq(tasks.id, card.id));
    expect(row?.status).toBe("running");
    expect(row?.lastError).toBeNull();
    expect(
      (await cardsOf(tenantId, eq(tasks.executorAgentId, agentId))).length,
    ).toBe(1);
  });

  test("untracked cards keep one card per turn", async () => {
    const tenantId = await tenant("untracked");
    const agentId = `agent-${suite}-e`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const before = await tasksUsed(tenantId);
    const runs = [
      await turn({
        tenantId,
        agentId,
        threadId,
        ask: "一加一等于几？",
        events: reply("等于二。"),
      }),
      await turn({
        tenantId,
        agentId,
        threadId,
        ask: "那二加二呢？",
        events: reply("等于四。"),
      }),
    ];
    const rows = await until(
      () => cardsOf(tenantId, eq(tasks.executorAgentId, agentId)),
      (list) =>
        list.length === 2 &&
        list.every((row) => row.status === "awaiting_review"),
    );
    expect(rows.map((row) => row.runRef)).toEqual(runs);
    expect(rows.every((row) => row.status === "awaiting_review")).toBe(true);
    expect(rows.every((row) => !row.tracked)).toBe(true);
    expect(await tasksUsed(tenantId)).toBe(before + 2);
    for (const row of rows)
      expect(await eventsOf(tenantId, row.id)).toEqual([]);
  });

  test("a cancelled card stays cancelled: a late finished(), approval park or resume does not move it", async () => {
    const tenantId = await tenant("cancel");
    const runRef = `run-${suite}-${randomUUID().slice(0, 8)}`;
    const approvalId = `ap-${randomUUID()}`;
    const id = await projector.opened({
      tenantId,
      title: "取消的活",
      executorAgentId: `agent-${suite}-f`,
      source: "chat",
      channelRef: `thread-${suite}-cancel`,
      runRef,
    });
    await runAsTenant(tenantId, () =>
      database
        .update(tasks)
        .set({ status: "cancelled", pendingApprovalId: approvalId })
        .where(eq(tasks.id, id)),
    );
    await projector.needsAction({ tenantId, runRef, approvalId });
    await projector.resumed({ tenantId, approvalId, failed: false });
    await projector.finished({ tenantId, runRef, failed: false });
    await projector.finished({ tenantId, runRef, failed: true });
    expect(await projector.reviewed({ tenantId, taskId: id })).toBe(false);
    expect(await projector.archived({ tenantId, taskId: id })).toBe(false);
    const [row] = await cardsOf(tenantId, eq(tasks.id, id));
    expect(row?.status).toBe("cancelled");

    // A cancelled tracked card is over: the next turn on its thread is not hung on it.
    await delivery.markTracked(tenantId, id, `user:${tenantId}`);
    expect(
      await delivery.openTrackedCard(
        tenantId,
        `thread-${suite}-cancel`,
        `agent-${suite}-f`,
      ),
    ).toBeNull();
  });

  test("reclaimAbandoned and pipeline reap skip tracked cards", async () => {
    const tenantId = await tenant("reclaim");
    const agentId = `agent-${suite}-g`;
    const stale = new Date(Date.now() - 30 * 60_000);
    const ids = {
      tracked: randomUUID(),
      untracked: randomUUID(),
      stepTracked: randomUUID(),
      stepUntracked: randomUUID(),
    };
    const groupId = randomUUID();
    const crew = randomUUID();
    const refs = {
      stepTracked: `step-${suite}-tracked`,
      stepUntracked: `step-${suite}-untracked`,
    };
    const step = (
      id: string,
      runRef: string,
      taskId: string,
    ): PipelineStepStateRow =>
      ({
        id,
        agentId,
        instruction: "mock only",
        state: "running",
        runRef,
        taskId,
      }) as PipelineStepStateRow;
    await runAsTenant(tenantId, async () => {
      await database.insert(tasks).values([
        {
          id: ids.tracked,
          tenantId,
          title: "tracked routine card",
          executorAgentId: agentId,
          source: "routine",
          tracked: true,
          updatedAt: stale,
        },
        {
          id: ids.untracked,
          tenantId,
          title: "untracked routine card",
          executorAgentId: agentId,
          source: "routine",
          updatedAt: stale,
        },
        {
          id: ids.stepTracked,
          tenantId,
          title: "tracked step",
          executorAgentId: agentId,
          source: "group_run",
          runRef: refs.stepTracked,
          tracked: true,
        },
        {
          id: ids.stepUntracked,
          tenantId,
          title: "untracked step",
          executorAgentId: agentId,
          source: "group_run",
          runRef: refs.stepUntracked,
        },
      ]);
      await database
        .insert(wakerGroups)
        .values({ id: groupId, tenantId, name: `delivery ${suite}` });
      await database.insert(groupTaskRuns).values({
        id: crew,
        tenantId,
        groupId,
        status: "running",
        steps: [
          step("one", refs.stepTracked, ids.stepTracked),
          step("two", refs.stepUntracked, ids.stepUntracked),
        ],
        updatedAt: stale,
      });
    });

    await projector.reclaimAbandoned({ olderThanMs: 10 * 60_000 });
    await reapAbandonedPipelineRuns(database, projector, {
      olderThanMs: 10 * 60_000,
    });

    const status = new Map(
      (await cardsOf(tenantId, inArray(tasks.id, Object.values(ids)))).map(
        (row) => [row.id, row.status],
      ),
    );
    // The untracked controls show both passes ran over this tenant.
    expect(status.get(ids.untracked)).toBe("failed");
    expect(status.get(ids.stepUntracked)).toBe("failed");
    expect(status.get(ids.tracked)).toBe("running");
    expect(status.get(ids.stepTracked)).toBe("running");

    await runAsTenant(tenantId, async () => {
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenantId));
      await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
    });
  });

  test("archiving a tracked awaiting_review card reviews it and logs reviewed", async () => {
    const tenantId = await tenant("archive");
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: tenantId,
        email: `${tenantId}@example.test`,
        role: "user",
      });
      await next();
    };
    const routes = createTaskRoutes(database, requireUser, projector);
    const id = randomUUID();
    await runAsTenant(tenantId, () =>
      database.insert(tasks).values({
        id,
        tenantId,
        title: "交付了的活",
        executorAgentId: `agent-${suite}-h`,
        source: "chat",
        status: "awaiting_review",
        tracked: true,
        threadRef: `thread-${suite}-archive`,
      }),
    );
    const response = await runAsTenant(tenantId, () =>
      routes.request(
        new Request(`http://openbot.test/${id}/archive`, { method: "POST" }),
      ),
    );
    expect(response.status).toBe(200);
    const [row] = await cardsOf(tenantId, eq(tasks.id, id));
    expect(row?.status).toBe("done");
    const lines = await eventsOf(tenantId, id);
    expect(lines.map((line) => [line.kind, line.actor, line.detail])).toEqual([
      ["reviewed", `user:${tenantId}`, { via: "archive" }],
    ]);

    // A second archive of the now-done card is refused, and logs nothing.
    const again = await runAsTenant(tenantId, () =>
      routes.request(
        new Request(`http://openbot.test/${id}/archive`, { method: "POST" }),
      ),
    );
    expect(again.status).toBe(409);
    expect(await eventsOf(tenantId, id)).toHaveLength(1);
  });
});

describe("first sentence of a reply", () => {
  test("cuts at Chinese or English sentence punctuation and at 60 characters", () => {
    expect(firstSentenceOf("好的，已接下。预计四十分钟交。")).toBe(
      "好的，已接下。",
    );
    expect(firstSentenceOf("  Done! Next I will check C.")).toBe("Done!");
    expect(firstSentenceOf("Version 3.5 is out. More later")).toBe(
      "Version 3.5 is out.",
    );
    expect(firstSentenceOf("第一行没有标点\n第二行")).toBe("第一行没有标点");
    expect(firstSentenceOf("字".repeat(80))).toBe("字".repeat(60));
    expect(firstSentenceOf("   \n ")).toBeUndefined();
  });
});

/**
 * A group's followed card hangs on the viewer × coworker group thread (`group_bot_threads`), never on
 * the channel: the channel carries every Bot's answers to every member, and only the one thread is
 * this coworker's conversation with this person.
 */
describe("group", () => {
  const profileStore = createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  );
  const threadIdentity = createThreadIdentity("test-deployment");
  const channelStore = createChannelStore(
    database,
    profileStore,
    threadIdentity,
  );
  const prefix = `dl-group-${suite}`;
  const createdAgents: string[] = [];
  const createdChannels: string[] = [];

  afterAll(async () => {
    await runAsTenant("platform", async () => {
      await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
      for (const id of createdChannels) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, id));
        await database.delete(channels).where(eq(channels.id, id));
      }
      if (createdAgents.length) {
        await database
          .delete(agentProfiles)
          .where(inArray(agentProfiles.agentId, createdAgents));
        await database.delete(agents).where(inArray(agents.id, createdAgents));
      }
    });
  });

  test("group: tracked card lives on the viewer×employee group thread, other group messages do not attach", async () => {
    const ownerId = await tenant("group");
    const owner: AgentActor = { id: ownerId, role: "user" };
    await runAsTenant(ownerId, async () => {
      const make = async (name: string) => {
        const profile = await profileStore.create(owner, {
          name,
          title: "Tester",
          roleDescription: "Answer briefly.",
          visibility: "private",
        });
        createdAgents.push(profile.id);
        return profile.id;
      };
      const ada = await make("Ada");
      const grace = await make("Grace");
      const channel = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(channel.id);

      const calls: Parameters<TurnRunner>[0][] = [];
      let accept = false;
      const conversations = createGroupConversations({
        store: createGroupStore(database, () => threadIdentity.mint()),
        queue: createWorkQueue(database),
        owner: `${prefix}-replica`,
        roster: async (ownerUserId, channelId) => {
          const actor: AgentActor = { id: ownerUserId, role: "user" };
          const found = await channelStore.get(actor, channelId);
          if (!found || found.agentIds.length < 2) return null;
          const bots = [];
          for (const agentId of found.agentIds) {
            const profile = await profileStore.get(actor, agentId);
            if (profile) bots.push({ id: agentId, name: profile.name });
          }
          return bots;
        },
        runTurn: async (input) => {
          calls.push(input);
          if (accept && input.agentId === ada) {
            // `accept_task` (Task 3) in Ada's turn: no thread named, so the card's own record says
            // which thread it is -- and for a group card that must be the group thread.
            const card = await cardOfRun(ownerId, input.runId ?? "");
            if (!card) throw new Error("Ada's turn opened no card");
            await delivery.markTracked(ownerId, card.id, `agent:${ada}`);
          }
          return {
            replyText:
              input.agentId === ada ? "核对中。还差 C 家。" : "我来看看。",
          };
        },
        caps: { maxDepth: 0, maxPerRun: 2 },
        mayAddress: async () => false,
        auditStore: { insert: async () => undefined },
        progressEveryMs: 0,
        board: projector,
        delivery,
      });
      const drain = async () => {
        for (let i = 0; i < 10 && (await conversations.sweep()); i++) {}
      };
      const usedBefore = await tasksUsed(ownerId);

      accept = true;
      await conversations.send(ownerId, channel.id, {
        id: `${prefix}-m1`,
        text: "@Ada 核对三家供应商的发票",
      });
      await drain();
      accept = false;

      const [adaCard] = await cardsOf(ownerId, eq(tasks.executorAgentId, ada));
      if (!adaCard) throw new Error("no card for Ada");
      const adaThread = calls[0]?.threadId;
      expect(adaCard.tracked).toBe(true);
      expect(adaCard.threadRef).toBe(adaThread ?? "missing");
      expect(adaCard.threadRef).not.toBe(channel.id);
      expect(adaCard.status).toBe("running");

      await conversations.send(ownerId, channel.id, {
        id: `${prefix}-m2`,
        text: "@Ada 进度怎么样？",
      });
      await conversations.send(ownerId, channel.id, {
        id: `${prefix}-m3`,
        text: "@Grace 帮我看看这份合同",
      });
      await drain();

      const adaCards = await cardsOf(ownerId, eq(tasks.executorAgentId, ada));
      expect(adaCards).toHaveLength(1);
      expect(adaCards[0]?.status).toBe("running");
      // The follow-up ran on Ada's group thread, its runner card suppressed: the tracked card is it.
      const followUp = calls.find(
        (call) => call.agentId === ada && call !== calls[0],
      );
      expect(followUp?.threadId).toBe(adaThread);
      expect(followUp?.cardOwnedByCaller).toBe(true);
      const lines = await eventsOf(ownerId, adaCard.id);
      expect(lines.map((line) => line.kind)).toEqual([
        "dispatched",
        "progress",
        "run_ended",
        "progress",
        "run_ended",
      ]);
      expect(lines[3]?.detail).toEqual({
        runId: followUp?.runId,
        text: "核对中。",
      });

      // Grace's message is her own work on her own thread: a card of its own, untracked.
      const graceCards = await cardsOf(
        ownerId,
        eq(tasks.executorAgentId, grace),
      );
      expect(graceCards).toHaveLength(1);
      expect(graceCards[0]?.tracked).toBe(false);
      expect(graceCards[0]?.status).toBe("awaiting_review");
      // Ada's card once, Grace's once; the follow-up on Ada's card charged nothing.
      expect(await tasksUsed(ownerId)).toBe(usedBefore + 2);
    });
  });
});

afterAll(async () => {
  for (const id of tenants) {
    await runAsTenant(id, async () => {
      await database
        .delete(threadRunEvents)
        .where(
          inArray(
            threadRunEvents.threadId,
            database
              .select({ id: threads.id })
              .from(threads)
              .where(eq(threads.tenantId, id)),
          ),
        );
      await database
        .delete(threadRuns)
        .where(
          inArray(
            threadRuns.threadId,
            database
              .select({ id: threads.id })
              .from(threads)
              .where(eq(threads.tenantId, id)),
          ),
        );
      await database.delete(threads).where(eq(threads.tenantId, id));
      await database.delete(tasks).where(eq(tasks.tenantId, id));
    });
  }
  // `task_events` is append-only for the application role; its rows stay, under tenants nobody has.
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, tenants)),
  );
  await database.$client.close();
});
