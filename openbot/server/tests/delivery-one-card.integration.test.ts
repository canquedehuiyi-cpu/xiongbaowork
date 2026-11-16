import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { EMPTY } from "rxjs";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createApprovalQuestions,
  withQuestionParking,
} from "../src/approvals/questions";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
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
  approvalRequests,
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
import { createTurnRunner } from "../src/routines/run-turn";
import { createDelivery, firstSentenceOf } from "../src/tasks/delivery";
import { listTaskEvents } from "../src/tasks/events";
import {
  createTaskProjector,
  type TaskProjector,
} from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { roundOnCard } from "../src/tasks/turn-cards";
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
/** The board as the deployment wires it: a question a run left open parks its card after the close. */
const questions = createApprovalQuestions(database, async () => {}, projector);
const parkingBoard = withQuestionParking(projector, questions);
const approvals = createApprovalStore(database, projector);
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
  board?: TaskProjector;
}): Promise<string> {
  const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
  const runner = new PostgresAgentRunner(
    database,
    input.board ?? projector,
    quota,
  );
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
    // As `accept_task` does: this round is the card's now, and its end is written there.
    roundOnCard(runId, tenantId, card.id);
  };

/** An approval the gate would open inside the round named by `runId`, on `threadId`. */
const openApproval = (
  tenantId: string,
  agentId: string,
  threadId: string,
  runId: string,
  label: string,
) =>
  runAsTenant(tenantId, () =>
    approvals.open(
      approvalAction({
        actorId: tenantId,
        botId: agentId,
        toolRef: "computer_write_file",
        effect: "write",
        scope: "project",
        args: { path: `${label}.txt`, contents: "saved" },
        target: { filePath: `project/${label}.txt` },
        continuation: {
          runId,
          threadId,
          toolCallId: `call-${label}-${suite}`,
          toolName: "computer_write_file",
          args: { path: `${label}.txt`, contents: "saved" },
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
      }),
    ),
  );

/** The question `ask_person` saves when the round named by `runId` stops to ask the person. */
const askPerson = async (
  tenantId: string,
  agentId: string,
  threadId: string,
  runId: string,
  label: string,
) => {
  const key = `question-${label}-${suite}-${randomUUID().slice(0, 6)}`;
  await runAsTenant(tenantId, () =>
    database.insert(workItems).values({
      kind: "person.question",
      key,
      payload: {
        actorId: tenantId,
        botId: agentId,
        threadId,
        runId,
        question: `${label}：发给哪位联系人？`,
        mode: "completed_question",
      },
    }),
  );
  return key;
};

const cardRow = async (tenantId: string, taskId: string) =>
  (await cardsOf(tenantId, eq(tasks.id, taskId)))[0];

/** A thread whose coworker has taken on one piece of work, as the first test sets it up. */
async function trackedThread(label: string) {
  const tenantId = await tenant(label);
  const agentId = `agent-${suite}-${label}`;
  const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
  const first = await turn({
    tenantId,
    agentId,
    threadId,
    ask: "整理并发出周报",
    events: reply("已接下。"),
    during: acceptInTurn(tenantId, agentId, threadId),
  });
  const card = await cardOfRun(tenantId, first);
  if (!card) throw new Error("no card");
  await roundLogged(tenantId, card.id, first);
  return { tenantId, agentId, threadId, cardId: card.id };
}

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
    expect(
      (await delivery.openTrackedCard(tenantId, threadId, agentId))?.id,
    ).toBe(cardB);

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

  test("an approval raised in a round hung on a tracked card parks the card, and the decision brings it back", async () => {
    const tenantId = await tenant("approval");
    const agentId = `agent-${suite}-i`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const approvals = createApprovalStore(database, projector);
    const first = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "把报表写进项目目录",
      events: reply("已接下。"),
      during: acceptInTurn(tenantId, agentId, threadId),
    });
    const card = await cardOfRun(tenantId, first);
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, first);

    /** A later round that stops to ask, the way the approval gate files it: under the round's run id. */
    const askingRound = async (label: string) => {
      let approvalId = "";
      const runId = await turn({
        tenantId,
        agentId,
        threadId,
        ask: `写入 ${label}`,
        events: reply("需要你批准写文件。"),
        during: async (round) => {
          const opened = await runAsTenant(tenantId, () =>
            approvals.open(
              approvalAction({
                actorId: tenantId,
                botId: agentId,
                toolRef: "computer_write_file",
                effect: "write",
                scope: "project",
                args: { path: `${label}.txt`, contents: "saved" },
                target: { filePath: `project/${label}.txt` },
                continuation: {
                  runId: round,
                  threadId,
                  toolCallId: `call-${label}-${suite}`,
                  toolName: "computer_write_file",
                  args: { path: `${label}.txt`, contents: "saved" },
                  messages: [],
                  state: {},
                  context: [],
                  forwardedProps: {},
                },
              }),
            ),
          );
          approvalId = opened.id;
          await until(
            async () => (await cardsOf(tenantId, eq(tasks.id, card.id)))[0],
            (row) => row?.pendingApprovalId === approvalId,
          );
        },
      });
      await roundLogged(tenantId, card.id, runId);
      return { runId, approvalId };
    };

    const allowed = await askingRound("allow");
    let [row] = await cardsOf(tenantId, eq(tasks.id, card.id));
    // The round is over, and the card still waits on the person: the round ending does not move it.
    expect(row?.status).toBe("needs_action");
    expect(row?.pendingApprovalId).toBe(allowed.approvalId);
    expect(row?.activeRunRef).toBeNull();
    await runAsTenant(tenantId, () =>
      approvals.decide(tenantId, allowed.approvalId, "allow_once"),
    );
    row = (
      await until(
        () => cardsOf(tenantId, eq(tasks.id, card.id)),
        (rows) => rows[0]?.status === "running",
      )
    )[0];
    expect(row?.status).toBe("running");
    expect(row?.pendingApprovalId).toBeNull();

    // A denial ends that round's action, not the work: a followed card never becomes `failed`.
    const denied = await askingRound("deny");
    await runAsTenant(tenantId, () =>
      approvals.decide(tenantId, denied.approvalId, "deny"),
    );
    row = (
      await until(
        () => cardsOf(tenantId, eq(tasks.id, card.id)),
        (rows) => rows[0]?.pendingApprovalId === null,
      )
    )[0];
    expect(row?.status).toBe("running");
    expect(
      (await cardsOf(tenantId, eq(tasks.executorAgentId, agentId))).length,
    ).toBe(1);

    await runAsTenant(tenantId, () =>
      database
        .delete(approvalRequests)
        .where(
          inArray(approvalRequests.id, [allowed.approvalId, denied.approvalId]),
        ),
    );
  });

  test("a round that outlives the person's 验收 cannot pull the card back", async () => {
    const { tenantId, agentId, threadId, cardId } = await trackedThread("late");
    // Delivered: the card waits on the person (Task 3's `deliver_task` puts it here).
    await runAsTenant(tenantId, () =>
      database
        .update(tasks)
        .set({ status: "awaiting_review" })
        .where(eq(tasks.id, cardId)),
    );
    let approvalId = "";
    const round = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "再把附件也发我一份",
      events: reply("好的，我需要先写一个文件。"),
      during: async (runId) => {
        expect((await cardRow(tenantId, cardId))?.activeRunRef).toBe(runId);
        // While the round runs, the person reviews the delivery…
        expect(
          await delivery.review(tenantId, cardId, `user:${tenantId}`, "review"),
        ).toBe(true);
        // …and then the round stops to ask for an approval.
        approvalId = (
          await openApproval(tenantId, agentId, threadId, runId, "late")
        ).id;
        await settle(50);
      },
    });
    await settle(100);
    let row = await cardRow(tenantId, cardId);
    expect(row?.status).toBe("done");
    expect(row?.pendingApprovalId).toBeNull();
    expect(row?.activeRunRef).toBeNull();
    await runAsTenant(tenantId, () =>
      approvals.decide(tenantId, approvalId, "allow_once"),
    );
    await settle(100);
    row = await cardRow(tenantId, cardId);
    expect(row?.status).toBe("done");
    // The round's end is not written on a card that is over.
    const lines = await eventsOf(tenantId, cardId);
    expect(lines.some((line) => line.detail.runId === round)).toBe(false);
    await runAsTenant(tenantId, () =>
      database
        .delete(approvalRequests)
        .where(eq(approvalRequests.id, approvalId)),
    );
  });

  test("a round left named on the card by a crash is closed as superseded when the next round hangs on it", async () => {
    const { tenantId, agentId, threadId, cardId } =
      await trackedThread("crash");
    const crashed = `run-${suite}-crashed`;
    await runAsTenant(tenantId, () =>
      database
        .update(tasks)
        .set({ activeRunRef: crashed })
        .where(eq(tasks.id, cardId)),
    );
    const next = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "继续",
      events: reply("继续做。"),
    });
    await roundLogged(tenantId, cardId, next);
    const superseded = (await eventsOf(tenantId, cardId)).filter(
      (line) => line.detail.runId === crashed,
    );
    expect(superseded.map((line) => [line.kind, line.detail])).toEqual([
      ["run_failed", { runId: crashed, reason: "superseded" }],
    ]);
    // Its end, should it ever arrive, writes nothing more.
    await delivery.runEnded(tenantId, cardId, {
      runId: crashed,
      failed: false,
      firstSentence: "晚到的一句。",
    });
    expect(
      (await eventsOf(tenantId, cardId)).filter(
        (line) => line.detail.runId === crashed,
      ),
    ).toHaveLength(1);
    expect((await cardRow(tenantId, cardId))?.activeRunRef).toBeNull();
  });

  test("ask_person in a round hung on a tracked card parks the card, and the answer brings it back", async () => {
    const { tenantId, agentId, threadId, cardId } = await trackedThread("ask");
    let key = "";
    const round = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "把周报发出去",
      events: reply("发给谁？我先问一下你。"),
      board: parkingBoard,
      during: async (runId) => {
        key = await askPerson(tenantId, agentId, threadId, runId, "ask");
      },
    });
    await roundLogged(tenantId, cardId, round);
    const parked = await until(
      () => cardRow(tenantId, cardId),
      (row) => row?.status === "needs_action",
    );
    expect(parked?.status).toBe("needs_action");
    expect(parked?.pendingApprovalId).toBe(key);
    expect(parked?.activeRunRef).toBeNull();

    await runAsTenant(tenantId, () =>
      questions.respond(tenantId, key, "发给王经理"),
    );
    const back = await cardRow(tenantId, cardId);
    expect(back?.status).toBe("running");
    expect(back?.pendingApprovalId).toBeNull();
    expect(
      (await cardsOf(tenantId, eq(tasks.executorAgentId, agentId))).length,
    ).toBe(1);
    await runAsTenant(tenantId, () =>
      database
        .delete(workItems)
        .where(
          and(
            inArray(workItems.kind, ["person.question", "person.response"]),
            eq(workItems.key, key),
          ),
        ),
    );
  });

  /**
   * The approval resume loop carries a parked round on through the server's headless turn runner
   * (`approvals/resume-sweep.ts`): a new turn on the same thread, with a run id of its own and no
   * card of its own (`cardOwnedByCaller` unset). It reaches the thread runner like any turn, so it
   * hangs on the followed card under ITS run id -- the id the gate files the next approval under --
   * and reports its end there.
   */
  test("the approval continuation of a hung round hangs on the card, parks it on a new approval and logs its end", async () => {
    const { tenantId, agentId, threadId, cardId } =
      await trackedThread("resume");
    let firstApproval = "";
    const parkedRound = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "把文件写进项目目录",
      events: reply("需要你批准写文件。"),
      during: async (runId) => {
        firstApproval = (
          await openApproval(tenantId, agentId, threadId, runId, "resume-1")
        ).id;
      },
    });
    await roundLogged(tenantId, cardId, parkedRound);
    expect((await cardRow(tenantId, cardId))?.status).toBe("needs_action");
    await runAsTenant(tenantId, () =>
      approvals.decide(tenantId, firstApproval, "allow_once"),
    );
    await until(
      () => cardRow(tenantId, cardId),
      (row) => row?.status === "running",
    );

    let continuationRun = "";
    let secondApproval = "";
    class ContinuingAgent extends AbstractAgent {
      override async runAgent(
        parameters?: RunAgentParameters,
        subscriber?: AgentSubscriber,
      ): Promise<RunAgentResult> {
        const input = parameters as RunAgentInput;
        continuationRun = input.runId;
        secondApproval = (
          await openApproval(
            tenantId,
            agentId,
            threadId,
            input.runId,
            "resume-2",
          )
        ).id;
        await until(
          () => cardRow(tenantId, cardId),
          (row) => row?.pendingApprovalId === secondApproval,
        );
        const messageId = `reply-${input.runId}`;
        const emit = (event: BaseEvent) =>
          subscriber?.onEvent?.({ event } as Parameters<
            NonNullable<AgentSubscriber["onEvent"]>
          >[0]);
        emit({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        });
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: "第一个文件写好了。还要再写一个。",
        });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId });
        emit({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });
        this.messages = [
          ...this.messages,
          {
            id: messageId,
            role: "assistant",
            content: "第一个文件写好了。还要再写一个。",
          },
        ] as typeof this.messages;
        return { result: undefined, newMessages: [] };
      }
      run() {
        return EMPTY;
      }
    }
    const continuationRunner = createTurnRunner({
      admission: async ({ signal }) => signal ?? new AbortController().signal,
      // The platform client, inert: a headless turn needs a thread and a lock, neither under test here.
      intelligence: {
        getOrCreateThread: async (params: { threadId: string }) => ({
          thread: { id: params.threadId },
          created: false,
        }),
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async (params: {
          threadId: string;
          runId: string;
        }) => ({
          threadId: params.threadId,
          runId: params.runId,
          joinToken: "test",
        }),
        ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
        ɵcleanupThreadLock: async () => undefined,
      } as never,
      runner: new PostgresAgentRunner(database, projector, quota) as never,
      buildAgentFor: async () => new ContinuingAgent({ agentId }),
    });
    const usedBefore = await tasksUsed(tenantId);
    // The resume loop's own call (`approvals/resume-sweep.ts`), with the parked round's snapshot.
    await runAsTenant(tenantId, () =>
      continuationRunner({
        ownerUserId: tenantId,
        routineId: "approval",
        agentId,
        threadId,
        instruction: "",
        continuation: {
          snapshot: {
            runId: parkedRound,
            threadId,
            toolCallId: `call-resume-1-${suite}`,
            toolName: "computer_write_file",
            args: { path: "resume-1.txt", contents: "saved" },
            messages: [],
            state: {},
            context: [],
            forwardedProps: {},
          },
          result: { content: "saved" },
          messageId: `resume-${randomUUID()}`,
        },
      }),
    );
    await roundLogged(tenantId, cardId, continuationRun);
    expect(continuationRun).not.toBe(parkedRound);
    const row = await cardRow(tenantId, cardId);
    // The approval the continuation raised holds the card; the round's end did not release it.
    expect(row?.status).toBe("needs_action");
    expect(row?.pendingApprovalId).toBe(secondApproval);
    expect(row?.activeRunRef).toBeNull();
    const ended = (await eventsOf(tenantId, cardId)).filter(
      (line) => line.detail.runId === continuationRun,
    );
    expect(ended.map((line) => line.kind)).toEqual(["progress", "run_ended"]);
    expect(ended[0]?.detail.text).toBe("第一个文件写好了。");
    // No second card, no second charge.
    expect(
      (await cardsOf(tenantId, eq(tasks.executorAgentId, agentId))).length,
    ).toBe(1);
    expect(await tasksUsed(tenantId)).toBe(usedBefore);
    await runAsTenant(tenantId, () =>
      database
        .delete(approvalRequests)
        .where(inArray(approvalRequests.id, [firstApproval, secondApproval])),
    );
  });

  test("a board close that throws does not stop a hung round from ending on its card", async () => {
    const { tenantId, agentId, threadId, cardId } =
      await trackedThread("broken-close");
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let closes = 0;
    try {
      const round = await turn({
        tenantId,
        agentId,
        threadId,
        ask: "继续核对",
        events: reply("核对到第二家了。"),
        board: {
          ...projector,
          finished: async () => {
            closes++;
            throw new Error("看板写不进去");
          },
        },
      });
      const lines = await roundLogged(tenantId, cardId, round);
      expect(closes).toBe(1);
      expect(
        lines
          .filter((line) => line.detail.runId === round)
          .map((line) => line.kind),
      ).toEqual(["progress", "run_ended"]);
      expect((await cardRow(tenantId, cardId))?.activeRunRef).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });

  test("untracked cards keep one card per turn", async () => {
    const tenantId = await tenant("untracked");
    const agentId = `agent-${suite}-e`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const before = await tasksUsed(tenantId);
    const runs = [
      // The same chart the unrelated turn above draws on a tracked card: here it IS the deliverable.
      await turn({
        tenantId,
        agentId,
        threadId,
        ask: "一加一等于几？画个图。",
        events: [...chart(), ...reply("等于二。")],
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
    expect(rows[0]?.deliverableRef).toMatchObject({
      kind: "deliverable",
      components: [{ name: "showBarChart" }],
    });
    expect(rows[1]?.deliverableRef).toBeNull();
    expect(await tasksUsed(tenantId)).toBe(before + 2);
    for (const row of rows)
      expect(await eventsOf(tenantId, row.id)).toEqual([]);
  });

  test("a cancelled or reviewed card stays ended: a late finished(), approval park or resume does not move it", async () => {
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

    // A reviewed card is over in the same way.
    const doneRun = `run-${suite}-${randomUUID().slice(0, 8)}`;
    const doneId = await projector.opened({
      tenantId,
      title: "验收过的活",
      executorAgentId: `agent-${suite}-f`,
      source: "chat",
      runRef: doneRun,
    });
    await runAsTenant(tenantId, () =>
      database
        .update(tasks)
        .set({ status: "done", pendingApprovalId: approvalId })
        .where(eq(tasks.id, doneId)),
    );
    await projector.needsAction({ tenantId, runRef: doneRun, approvalId });
    await projector.resumed({ tenantId, approvalId, failed: true });
    await projector.finished({ tenantId, runRef: doneRun, failed: false });
    expect((await cardsOf(tenantId, eq(tasks.id, doneId)))[0]?.status).toBe(
      "done",
    );

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

test("reviewing a tracked awaiting_review card logs reviewed", async () => {
  const tenantId = await tenant("review");
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
      title: "等验收的活",
      executorAgentId: `agent-${suite}-j`,
      source: "chat",
      status: "awaiting_review",
      tracked: true,
      threadRef: `thread-${suite}-review`,
    }),
  );
  const review = () =>
    runAsTenant(tenantId, () =>
      routes.request(
        new Request(`http://openbot.test/${id}/review`, { method: "POST" }),
      ),
    );
  expect((await review()).status).toBe(200);
  const [row] = await cardsOf(tenantId, eq(tasks.id, id));
  expect(row?.status).toBe("done");
  expect(
    (await eventsOf(tenantId, id)).map((line) => [
      line.kind,
      line.actor,
      line.detail,
    ]),
  ).toEqual([["reviewed", `user:${tenantId}`, { via: "review" }]]);
  expect((await review()).status).toBe(409);
  expect(await eventsOf(tenantId, id)).toHaveLength(1);
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
      let asked = "";
      let ask = false;
      let breakClose = false;
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
          if (ask && input.agentId === ada)
            // `ask_person` in a later round on Ada's card: the question names this round's run.
            asked = await askPerson(
              ownerId,
              ada,
              input.threadId ?? "",
              input.runId ?? "",
              "group",
            );
          return {
            replyText:
              input.agentId === ada ? "核对中。还差 C 家。" : "我来看看。",
          };
        },
        caps: { maxDepth: 0, maxPerRun: 2 },
        mayAddress: async () => false,
        auditStore: { insert: async () => undefined },
        progressEveryMs: 0,
        // As the deployment wires it: a question a turn left open parks its card after the close.
        board: {
          ...parkingBoard,
          finished: async (input) => {
            if (breakClose) throw new Error("看板写不进去");
            await parkingBoard.finished(input);
          },
        },
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

      // A later round on Ada's card stops to ask the person: the card waits on them.
      ask = true;
      await conversations.send(ownerId, channel.id, {
        id: `${prefix}-m4`,
        text: "@Ada 发出去吧",
      });
      await drain();
      ask = false;
      const parked = (
        await cardsOf(ownerId, eq(tasks.executorAgentId, ada))
      )[0];
      expect(parked?.id).toBe(adaCard.id);
      expect(parked?.status).toBe("needs_action");
      expect(parked?.pendingApprovalId).toBe(asked);
      expect(parked?.activeRunRef).toBeNull();
      await runAsTenant(ownerId, () =>
        database
          .delete(workItems)
          .where(
            and(
              eq(workItems.kind, "person.question"),
              eq(workItems.key, asked),
            ),
          ),
      );

      // A board close that throws: the round on Ada's card still ends there.
      breakClose = true;
      const quiet = spyOn(console, "error").mockImplementation(() => {});
      try {
        await conversations.send(ownerId, channel.id, {
          id: `${prefix}-m5`,
          text: "@Ada 还差几家？",
        });
        await drain();
      } finally {
        quiet.mockRestore();
        breakClose = false;
      }
      const broken = calls.at(-1);
      expect(broken?.agentId).toBe(ada);
      const brokenLines = (await eventsOf(ownerId, adaCard.id)).filter(
        (line) => line.detail.runId === broken?.runId,
      );
      expect(brokenLines.map((line) => line.kind)).toEqual([
        "progress",
        "run_ended",
      ]);
      expect(
        (await cardsOf(ownerId, eq(tasks.id, adaCard.id)))[0]?.activeRunRef,
      ).toBeNull();
    });
  });

  test("group: a round that cannot be hung on the followed card says so and runs on a card of its own", async () => {
    const ownerId = await tenant("group-hang");
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
      let breakLookup = false;
      let breakAttach = false;
      const conversations = createGroupConversations({
        store: createGroupStore(database, () => threadIdentity.mint()),
        queue: createWorkQueue(database),
        owner: `${prefix}-hang-replica`,
        roster: async () => [
          { id: ada, name: "Ada" },
          { id: grace, name: "Grace" },
        ],
        runTurn: async (input) => {
          calls.push(input);
          return { replyText: "在做。" };
        },
        caps: { maxDepth: 0, maxPerRun: 2 },
        mayAddress: async () => false,
        auditStore: { insert: async () => undefined },
        progressEveryMs: 0,
        board: parkingBoard,
        delivery: {
          ...delivery,
          openTrackedCard: (...args) =>
            breakLookup
              ? Promise.reject(new Error("在跟卡查不出来"))
              : delivery.openTrackedCard(...args),
          attachRun: (...args) =>
            breakAttach
              ? Promise.reject(new Error("挂不上卡"))
              : delivery.attachRun(...args),
        },
      });
      const drain = async () => {
        for (let i = 0; i < 10 && (await conversations.sweep()); i++) {}
      };
      // Ada's card, followed on her group thread with this person.
      await conversations.send(ownerId, channel.id, {
        id: `${prefix}-h1`,
        text: "@Ada 核对三家供应商的发票",
      });
      await drain();
      const [adaCard] = await cardsOf(ownerId, eq(tasks.executorAgentId, ada));
      if (!adaCard) throw new Error("no card for Ada");
      await delivery.markTracked(ownerId, adaCard.id, `user:${ownerId}`);

      const logged: string[] = [];
      const quiet = spyOn(console, "error").mockImplementation(
        (line: unknown) => {
          logged.push(String(line));
        },
      );
      try {
        breakAttach = true;
        await conversations.send(ownerId, channel.id, {
          id: `${prefix}-h2`,
          text: "@Ada 进度怎么样？",
        });
        await drain();
        breakAttach = false;
        breakLookup = true;
        await conversations.send(ownerId, channel.id, {
          id: `${prefix}-h3`,
          text: "@Ada 还差几家？",
        });
        await drain();
      } finally {
        quiet.mockRestore();
        breakAttach = false;
        breakLookup = false;
      }
      const types = logged.map(
        (line) => (JSON.parse(line) as { type?: string }).type,
      );
      expect(types).toContain("group-turn-attach-failed");
      expect(types).toContain("group-turn-tracked-card-lookup-failed");

      // Neither round claimed the followed card: each was filed on a card of its own, under its run.
      const [attachFailed, lookupFailed] = calls.slice(-2);
      expect(attachFailed).toBeDefined();
      expect(lookupFailed).toBeDefined();
      const cards = await cardsOf(ownerId, eq(tasks.executorAgentId, ada));
      expect(cards).toHaveLength(3);
      for (const round of [attachFailed, lookupFailed]) {
        const own = cards.find((card) => card.runRef === round?.runId);
        expect(own).toBeDefined();
        expect(own?.tracked).toBe(false);
        expect(round?.cardOwnedByCaller).toBe(true);
      }
      // The followed card is as it was: no round named on it, no line from either round.
      const followed = cards.find((card) => card.id === adaCard.id);
      expect(followed).toBeDefined();
      expect(followed?.activeRunRef).toBeNull();
      expect(
        (await eventsOf(ownerId, adaCard.id)).map((line) => line.kind),
      ).toEqual(["dispatched"]);
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
  /*
   * The queue items these people's turns left behind -- above all an approval's `approval.resume`,
   * which outlives the approval it names. Left in a shared database they are claimed ahead of a later
   * suite's own, run by run (`tests/tasks.integration.test.ts` gives its resume ten tries).
   */
  await runAsTenant("platform", () =>
    database.delete(workItems).where(inArray(workItems.tenantId, tenants)),
  );
  // `task_events` is append-only for the application role; its rows stay, under tenants nobody has.
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, tenants)),
  );
  await database.$client.close();
});
