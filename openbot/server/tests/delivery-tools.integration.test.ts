import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Observable, of } from "rxjs";
import { z } from "zod";
import { toolDisabled } from "../src/approvals/policy";
import {
  createApprovalQuestions,
  withQuestionParking,
} from "../src/approvals/questions";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import {
  buildAgents,
  builtInAgentConfiguration,
  registeredAgentFromRow,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  approvalRequests,
  attachments,
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
import { withModelRun } from "../src/models/token-metering";
import type { GrantedTool } from "../src/plugins/tools";
import { createQuotaService } from "../src/quota/limits";
import { createTurnRunner } from "../src/routines/run-turn";
import { createDelivery } from "../src/tasks/delivery";
import {
  ACCEPT_TASK_REF,
  deliveryProtocol,
  deliveryTools,
  offeredDeliveryTools,
} from "../src/tasks/delivery-tools";
import { listTaskEvents } from "../src/tasks/events";
import { createEvidenceGate } from "../src/tasks/evidence-gate";
import {
  createTaskProjector,
  type TaskProjector,
} from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { withRunSideEvents } from "../src/threads/run-side-events";
import { suppressRunnerCard } from "../src/threads/unattended-card";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A coworker's three steps (spec 2026-11-15-delivery-loop §4, §5): `accept_task`, `deliver_task`,
 * `request_extension`, and the server's evidence gate in front of 已交成果.
 *
 * Every call is made from inside a real turn through the real runner, by a stub coworker that calls
 * the real tools the way a built-in Bot does: inside the run's model scope, with the run's stream open
 * for the events the tools add (`withRunSideEvents`, as `copilot.ts` wraps a built-in Bot's stream).
 * What is checked is the card, its history, and the run's stored events.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const quota = createQuotaService(database);
const projector = createTaskProjector(database, undefined, quota);
const delivery = createDelivery(database);
const gate = createEvidenceGate(database);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];
const ZONE = "Asia/Shanghai";

async function tenant(label: string): Promise<string> {
  const id = `dt-${label}-${suite}`;
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

const toolsFor = (tenantId: string, agentId: string) =>
  deliveryTools({
    delivery,
    gate,
    board: projector,
    ownerUserId: tenantId,
    agentId,
    timeZone: () => ZONE,
  });

/** What a turn's coworker does mid-turn: draw on the stream, and call its tools. */
type Work = (run: {
  runId: string;
  call: (name: string, args: unknown) => Promise<string>;
  draw: (event: BaseEvent) => void;
}) => Promise<void>;

/**
 * A coworker whose run is a script: it starts, does `work` (inside the run's model scope, so the tools
 * find the run as they do in a built-in Bot), says `reply`, and finishes. Its stream is opened for
 * the tools' own events exactly as `copilot.ts` opens a built-in Bot's.
 */
class ScriptedCoworker extends AbstractAgent {
  results: string[] = [];
  constructor(
    private readonly tools: GrantedTool[],
    private readonly work: Work,
    private readonly reply: string,
    agentId: string,
  ) {
    super({ agentId });
  }
  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    const input = parameters as RunAgentInput;
    const onEvent = (event: BaseEvent) =>
      subscriber?.onEvent?.({ event } as Parameters<
        NonNullable<AgentSubscriber["onEvent"]>
      >[0]);
    const source = new Observable<BaseEvent>((stream) => {
      void (async () => {
        stream.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        await this.work({
          runId: input.runId,
          draw: (event) => stream.next(event),
          call: async (name, args) => {
            const tool = this.tools.find(
              (candidate) => candidate.name === name,
            );
            if (!tool) throw new Error(`no tool ${name}`);
            const result = await tool.execute(args);
            this.results.push(result);
            return result;
          },
        });
        const messageId = `reply-${input.runId}`;
        for (const event of [
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: this.reply,
          },
          { type: EventType.TEXT_MESSAGE_END, messageId },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        ])
          stream.next(event as BaseEvent);
        // What a headless turn reads its reply from.
        this.messages = [
          ...this.messages,
          { id: messageId, role: "assistant", content: this.reply },
        ] as typeof this.messages;
        stream.complete();
      })().catch((error) => stream.error(error));
    });
    await new Promise<void>((resolve) => {
      withRunSideEvents(
        input.runId,
        withModelRun({ runId: input.runId, threadId: input.threadId }, source),
      ).subscribe({
        next: onEvent,
        complete: () => resolve(),
        error: () => resolve(),
      });
    });
    return { result: undefined, newMessages: [] };
  }
  override run(): Observable<BaseEvent> {
    throw new Error("runAgent is the only entry used here");
  }
  override clone(): ScriptedCoworker {
    return this;
  }
}

/** One person's turn through the real runner; the card it hangs on or opens is the runner's. */
async function turn(input: {
  tenantId: string;
  agentId: string;
  threadId: string;
  ask: string;
  work?: Work;
  reply?: string;
  /** An entry that filed its own card first: the runner files none. */
  entry?: { cardRef?: string };
  runId?: string;
  /** The board the runner writes through; the plain projector by default. */
  board?: TaskProjector;
}): Promise<{ runId: string; results: string[] }> {
  const runId = input.runId ?? `run-${suite}-${randomUUID().slice(0, 8)}`;
  const runner = new PostgresAgentRunner(
    database,
    input.board ?? projector,
    quota,
  );
  const agent = new ScriptedCoworker(
    toolsFor(input.tenantId, input.agentId),
    input.work ?? (async () => {}),
    input.reply ?? "好的。",
    input.agentId,
  );
  const subscribe = () =>
    new Promise<void>((resolve) => {
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
  await runAsTenant(input.tenantId, () =>
    input.entry
      ? suppressRunnerCard(subscribe, input.entry.cardRef)
      : subscribe(),
  );
  return { runId, results: agent.results };
}

const cardsOf = (tenantId: string, agentId: string) =>
  runAsTenant(tenantId, () =>
    database
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.tenantId, tenantId), eq(tasks.executorAgentId, agentId)),
      )
      .orderBy(asc(tasks.createdAt)),
  );

const cardRow = async (tenantId: string, taskId: string) =>
  (
    await runAsTenant(tenantId, () =>
      database.select().from(tasks).where(eq(tasks.id, taskId)),
    )
  )[0];

const eventsOf = (tenantId: string, taskId: string) =>
  runAsTenant(tenantId, () => listTaskEvents(database, { tenantId, taskId }));

/** Wait until the round `runId` has its end written on the card, and fail if it never does. */
async function roundLogged(tenantId: string, taskId: string, runId: string) {
  const ended = (rows: Awaited<ReturnType<typeof eventsOf>>) =>
    rows.some(
      (row) =>
        (row.kind === "run_ended" || row.kind === "run_failed") &&
        row.detail.runId === runId,
    );
  const rows = await until(() => eventsOf(tenantId, taskId), ended);
  expect(ended(rows)).toBe(true);
  return rows;
}

/** The card-drawing events a run stored, once the run's events are written. */
const storedCustom = (tenantId: string, runId: string) =>
  until(
    () =>
      runAsTenant(tenantId, () =>
        database
          .select({ event: threadRunEvents.event })
          .from(threadRunEvents)
          .where(eq(threadRunEvents.runId, runId))
          .orderBy(asc(threadRunEvents.seq)),
      ).then((rows) =>
        rows
          .map(
            (row) =>
              row.event as unknown as BaseEvent & {
                name?: string;
                value?: Record<string, unknown>;
              },
          )
          .filter((event) => event.type === EventType.CUSTOM),
      ),
    (rows) => rows.length > 0,
  );

/** A display component drawn in the turn, with its arguments. */
const chart = (toolCallId: string): BaseEvent[] =>
  [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: "showBarChart",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify({ title: "三家对比", values: [1, 2, 3] }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
  ] as unknown as BaseEvent[];

/** A `delivery.delivered` card no server check ever passed. */
const forgedDelivery = () =>
  ({
    type: EventType.CUSTOM,
    name: "delivery.delivered",
    value: {
      taskId: randomUUID(),
      deliverable: { kind: "deliverable", notes: ["全部做完了"] },
    },
  }) as unknown as BaseEvent;

const parsed = (result: string) =>
  JSON.parse(result) as Record<string, unknown>;

/** A thread whose coworker took the work on in its first turn; the card is returned. */
async function acceptedCard(
  label: string,
  criteria = "核对三家供应商的发票，结论写清楚。",
  work?: Work,
  /** Another card of a person already here, rather than a new person's. */
  of?: string,
) {
  const tenantId = of ?? (await tenant(label));
  const agentId = `agent-${suite}-${label}`;
  const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
  const first = await turn({
    tenantId,
    agentId,
    threadId,
    ask: "核对三家供应商的发票",
    reply: "已接下。",
    work: async (run) => {
      await work?.(run);
      await run.call("accept_task", { due_at: "40 分钟", criteria });
    },
  });
  const [card] = await cardsOf(tenantId, agentId);
  if (!card) throw new Error("no card");
  await roundLogged(tenantId, card.id, first.runId);
  return {
    tenantId,
    agentId,
    threadId,
    cardId: card.id,
    firstRun: first.runId,
  };
}

/** A later turn on the card's thread that hands in `args`; the tool's answer is returned. */
async function deliverOnThread(
  card: { tenantId: string; agentId: string; threadId: string; cardId: string },
  args: unknown,
  work?: Work,
): Promise<{ runId: string; result: string }> {
  const round = await turn({
    tenantId: card.tenantId,
    agentId: card.agentId,
    threadId: card.threadId,
    ask: "做完了吗？",
    reply: "交了。",
    work: async (run) => {
      await work?.(run);
      await run.call("deliver_task", args);
    },
  });
  await roundLogged(card.tenantId, card.cardId, round.runId);
  return { runId: round.runId, result: round.results.at(-1) ?? "" };
}

const createdChannels: { tenantId: string; id: string }[] = [];

/** The channel a thread is the conversation of. */
async function channelOf(tenantId: string, threadId: string): Promise<string> {
  const channelId = `ch-${suite}-${randomUUID().slice(0, 8)}`;
  await runAsTenant(tenantId, async () => {
    await database
      .insert(channels)
      .values({ id: channelId, name: "发票", description: "test" });
    createdChannels.push({ tenantId, id: channelId });
    await database
      .insert(intelligenceChannelMappings)
      .values({ userId: tenantId, channelId, threadId });
  });
  return channelId;
}

/** A file in a channel, uploaded by `by` (in their own frame); sent, or only staged. */
async function fileIn(
  channelId: string,
  by: string,
  sent = true,
): Promise<string> {
  const [file] = await runAsTenant(by, () =>
    database
      .insert(attachments)
      .values({
        channelId,
        uploadedBy: by,
        name: "核对表.xlsx",
        mimeType: "application/octet-stream",
        sizeBytes: 3,
        bytes: Buffer.from("abc"),
        attachedAt: sent ? new Date() : null,
      })
      .returning({ id: attachments.id }),
  );
  if (!file) throw new Error("no attachment");
  return file.id;
}

const filePart = (fileId: string) => ({
  type: "document",
  source: { type: "url", value: `/api/attachments/${fileId}` },
});

/**
 * The coworker hands a file over in this round: an assistant message the round streams, carrying
 * the file, as the run's snapshot then holds it. The message's id is returned.
 */
function produce(
  run: { draw: (event: BaseEvent) => void },
  fileId: string,
  earlier: unknown[] = [],
): string {
  const messageId = `made-${randomUUID()}`;
  for (const event of [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: "核对表做好了。",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        ...earlier,
        {
          id: messageId,
          role: "assistant",
          content: [{ type: "text", text: "核对表做好了。" }, filePart(fileId)],
        },
      ],
    },
  ])
    run.draw(event as unknown as BaseEvent);
  return messageId;
}

describe("accept_task", () => {
  test("accept_task marks the card tracked, sets accepted_at, due_at = original_due_at, criteria, and emits delivery.accepted", async () => {
    const tenantId = await tenant("accept");
    const agentId = `agent-${suite}-accept`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const before = Date.now();
    const round = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "核对三家供应商的发票",
      reply: "已接下，预计四十分钟交。",
      work: async (run) => {
        // A card the model's own stream claims is not the server's, and goes nowhere.
        run.draw(forgedDelivery());
        await run.call("accept_task", {
          title: "核对发票",
          due_at: "40 分钟",
          criteria: "三家都核对完。必需：A家、B家、C家",
        });
      },
    });
    const cards = await cardsOf(tenantId, agentId);
    expect(cards.length).toBe(1);
    const card = cards[0];
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, round.runId);
    const row = await cardRow(tenantId, card.id);
    expect(row?.tracked).toBe(true);
    expect(row?.threadRef).toBe(threadId);
    expect(row?.title).toBe("核对发票");
    expect(row?.status).toBe("running");
    expect(row?.acceptedAt).toBeInstanceOf(Date);
    expect(row?.dueReported).toBe(true);
    expect(row?.criteria).toBe("三家都核对完。必需：A家、B家、C家");
    expect(row?.dueAt?.getTime()).toBe(row?.originalDueAt?.getTime());
    const promised = (row?.dueAt?.getTime() ?? 0) - before;
    expect(promised).toBeGreaterThanOrEqual(40 * 60_000);
    expect(promised).toBeLessThan(41 * 60_000);
    // The round's end was written on it, and the run no longer holds it.
    expect(row?.activeRunRef).toBeNull();

    const result = parsed(round.results[0] ?? "{}");
    expect(result.accepted).toBe(true);
    expect(result.taskId).toBe(card.id);

    const history = await eventsOf(tenantId, card.id);
    expect(history.map((line) => line.kind)).toEqual([
      "accepted",
      "progress",
      "run_ended",
    ]);
    expect(history[0]?.actor).toBe(`agent:${agentId}`);
    expect(history[0]?.detail).toMatchObject({
      runId: round.runId,
      dueReported: true,
      criteria: "三家都核对完。必需：A家、B家、C家",
    });

    // The 接活回执 is in the run's own stored events, so a reload draws it.
    const custom = await storedCustom(tenantId, round.runId);
    expect(custom.map((event) => event.name)).toEqual(["delivery.accepted"]);
    expect(custom[0]?.value).toEqual({
      taskId: card.id,
      dueAt: row?.dueAt?.toISOString() ?? null,
      criteria: "三家都核对完。必需：A家、B家、C家",
    });
  });

  test("accept_task without due_at sets due_reported false", async () => {
    const tenantId = await tenant("nodue");
    const agentId = `agent-${suite}-nodue`;
    const quiet = await turn({
      tenantId,
      agentId,
      threadId: `thread-${suite}-${randomUUID().slice(0, 8)}`,
      ask: "帮我整理会议纪要",
      work: (run) =>
        run
          .call("accept_task", { criteria: "纪要按议题分段。" })
          .then(() => undefined),
    });
    // A time the tool cannot read is the same as none, and the coworker is told so.
    const unreadable = await turn({
      tenantId,
      agentId,
      threadId: `thread-${suite}-${randomUUID().slice(0, 8)}`,
      ask: "再整理一份",
      work: (run) =>
        run
          .call("accept_task", { due_at: "尽快", criteria: "同上。" })
          .then(() => undefined),
    });
    // A moment already past is not a due time either, and the coworker is told why.
    const past = await turn({
      tenantId,
      agentId,
      threadId: `thread-${suite}-${randomUUID().slice(0, 8)}`,
      ask: "第三份",
      work: (run) =>
        run
          .call("accept_task", {
            due_at: "2020-01-01T00:00:00Z",
            criteria: "同上。",
          })
          .then(() => undefined),
    });
    expect(String(parsed(past.results[0] ?? "{}").note)).toContain("已经过了");
    const cards = await cardsOf(tenantId, agentId);
    expect(cards.length).toBe(3);
    for (const card of cards) {
      expect(card.tracked).toBe(true);
      expect(card.acceptedAt).toBeInstanceOf(Date);
      expect(card.dueReported).toBe(false);
      expect(card.dueAt).toBeNull();
      expect(card.originalDueAt).toBeNull();
    }
    expect(parsed(quiet.results[0] ?? "{}")).toMatchObject({
      accepted: true,
      dueAt: null,
      dueReported: false,
    });
    const told = parsed(unreadable.results[0] ?? "{}");
    expect(told.dueReported).toBe(false);
    expect(String(told.note)).toContain("尽快");
    expect(String(told.note)).toContain("2 小时");
  });

  test("outside a turn the tools answer with an error and change nothing", async () => {
    const tenantId = await tenant("outside");
    const agentId = `agent-${suite}-outside`;
    const [accept, deliver, extend] = toolsFor(tenantId, agentId);
    const answers = await runAsTenant(tenantId, async () => [
      await accept?.execute({ criteria: "随便" }),
      await deliver?.execute({ items: [], checks: [] }),
      await extend?.execute({ due_at: "1 小时", reason: "缺数据" }),
    ]);
    for (const answer of answers) expect(answer).toContain("Refused.");
    expect(await cardsOf(tenantId, agentId)).toEqual([]);
  });

  test("a pending card a later round hangs on is accepted; a second accept opens a new card later rounds hang on", async () => {
    const tenantId = await tenant("second");
    const agentId = `agent-${suite}-second`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    // The person follows a card by hand (派出 · 待接下): tracked, not accepted.
    await turn({ tenantId, agentId, threadId, ask: "看下报销" });
    const [opened] = await cardsOf(tenantId, agentId);
    if (!opened) throw new Error("no card");
    const pending = await until(
      () => cardRow(tenantId, opened.id),
      (row) => row?.status === "awaiting_review",
    );
    if (!pending) throw new Error("no card");
    await delivery.markTracked(tenantId, pending.id, `user:${tenantId}`, {
      threadRef: threadId,
    });

    // The next round hangs on it, and accepting in it accepts that card.
    const accepting = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "接一下这件",
      work: (run) =>
        run
          .call("accept_task", { criteria: "报销单逐张核对。" })
          .then(() => {}),
    });
    await roundLogged(tenantId, pending.id, accepting.runId);
    expect((await cardsOf(tenantId, agentId)).length).toBe(1);
    const taken = await cardRow(tenantId, pending.id);
    expect(taken?.acceptedAt).toBeInstanceOf(Date);
    // Nothing was handed in on it: taken on, it is work in progress.
    expect(taken?.status).toBe("running");

    // Another piece of work in the same thread: its own card, and it holds the round.
    const second = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "另外把差旅也算一下",
      work: (run) =>
        run
          .call("accept_task", {
            title: "差旅核算",
            criteria: "差旅按人汇总。",
          })
          .then(() => {}),
    });
    const cards = await cardsOf(tenantId, agentId);
    expect(cards.length).toBe(2);
    const newer = cards.find((card) => card.id !== pending.id);
    if (!newer) throw new Error("no second card");
    expect(newer.tracked).toBe(true);
    expect(newer.title).toBe("差旅核算");
    expect(newer.threadRef).toBe(threadId);
    expect(parsed(second.results[0] ?? "{}").taskId).toBe(newer.id);
    await roundLogged(tenantId, newer.id, second.runId);
    // The round that took the new card on is written on both: it began on one, and was the other's.
    await roundLogged(tenantId, pending.id, second.runId);

    // Later rounds hang on the newest accepted card.
    const later = await turn({ tenantId, agentId, threadId, ask: "进度？" });
    await roundLogged(tenantId, newer.id, later.runId);
    expect(
      (await eventsOf(tenantId, pending.id)).some(
        (line) => line.detail.runId === later.runId,
      ),
    ).toBe(false);
    expect((await cardsOf(tenantId, agentId)).length).toBe(2);
  });
});

describe("accept_task after the person changed the criteria", () => {
  test("the person's criteria stand, and the coworker is told so", async () => {
    const tenantId = await tenant("criteria-mine");
    const agentId = `agent-${suite}-criteria-mine`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    // The person follows a card by hand and writes the criteria before the coworker answers.
    await turn({ tenantId, agentId, threadId, ask: "看下报销" });
    const [opened] = await cardsOf(tenantId, agentId);
    if (!opened) throw new Error("no card");
    await until(
      () => cardRow(tenantId, opened.id),
      (row) => row?.status === "awaiting_review",
    );
    await delivery.markTracked(tenantId, opened.id, `user:${tenantId}`, {
      threadRef: threadId,
    });
    await runAsTenant(tenantId, () =>
      database
        .update(tasks)
        .set({ status: "running" })
        .where(eq(tasks.id, opened.id)),
    );
    const mine = "报销单逐张核对。必需：发票、行程单";
    const edited = await delivery.editTask(tenantId, opened.id, {
      actor: `user:${tenantId}`,
      criteria: mine,
    });
    expect(edited.ok).toBe(true);

    const round = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "接一下这件",
      work: (run) =>
        run.call("accept_task", { criteria: "报销单看一遍。" }).then(() => {}),
    });
    await roundLogged(tenantId, opened.id, round.runId);
    const answer = parsed(round.results[0] ?? "{}");
    expect(answer.accepted).toBe(true);
    expect(answer.criteria).toBe(mine);
    expect((await cardRow(tenantId, opened.id))?.criteria).toBe(mine);
    // The receipt card in the chat shows the criteria that stand.
    const custom = await storedCustom(tenantId, round.runId);
    const receipt = custom.find((event) => event.name === "delivery.accepted");
    expect(receipt).toBeDefined();
    expect(receipt?.value).toMatchObject({ criteria: mine });
  });
});

describe("accept_task in a turn that filed its own card", () => {
  test("a routine turn: its own card is followed and the round's end is written on it", async () => {
    const tenantId = await tenant("routine");
    const agentId = `agent-${suite}-routine`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const routineRunId = `routine_run_${suite}_${randomUUID().slice(0, 8)}`;
    // The routine files its card first, keyed by its firing (`routines/runner.ts`).
    const cardId = await projector.opened({
      tenantId,
      title: "每周发票核对",
      executorAgentId: agentId,
      source: "routine",
      triggerSource: "routine",
      channelRef: `channel-${suite}`,
      runRef: routineRunId,
    });
    let runId = "";
    const results: string[] = [];
    const agent = new ScriptedCoworker(
      toolsFor(tenantId, agentId),
      async (run) => {
        runId = run.runId;
        results.push(
          await run.call("accept_task", {
            due_at: "2 小时",
            criteria: "本周发票全部核对。",
          }),
        );
      },
      "开始核对本周发票。",
      agentId,
    );
    const runTurn = createTurnRunner({
      admission: async ({ signal }) => signal ?? new AbortController().signal,
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
      buildAgentFor: async () => agent,
    });
    await runAsTenant(tenantId, () =>
      runTurn({
        ownerUserId: tenantId,
        routineId: "weekly",
        agentId,
        threadId,
        instruction: "核对本周发票",
        runRef: routineRunId,
        cardOwnedByCaller: true,
      }),
    );
    // The routine closes its card the way it always does; a followed card is not moved by it.
    await projector.finished({ tenantId, runRef: routineRunId });

    expect(parsed(results[0] ?? "{}").taskId).toBe(cardId);
    expect((await cardsOf(tenantId, agentId)).length).toBe(1);
    await roundLogged(tenantId, cardId, runId);
    const row = await cardRow(tenantId, cardId);
    expect(row?.tracked).toBe(true);
    expect(row?.threadRef).toBe(threadId);
    expect(row?.status).toBe("running");
    expect(row?.activeRunRef).toBeNull();
    const history = await eventsOf(tenantId, cardId);
    expect(history.map((line) => line.kind)).toEqual([
      "accepted",
      "progress",
      "run_ended",
    ]);
    expect(history[1]?.detail).toEqual({ runId, text: "开始核对本周发票。" });
  });

  test("a hand-off turn: its own card is followed and the round's end is written on it", async () => {
    const tenantId = await tenant("handoff");
    const agentId = `agent-${suite}-handoff`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
    // The hop files its card under its run id, then runs with the runner's card suppressed.
    const cardId = await projector.opened({
      tenantId,
      title: "帮忙做竞品表",
      executorAgentId: agentId,
      source: "handoff",
      channelRef: threadId,
      runRef: runId,
    });
    const round = await turn({
      tenantId,
      agentId,
      threadId,
      runId,
      ask: "帮忙做竞品表",
      reply: "收到，竞品表我来做。",
      entry: {},
      work: (run) =>
        run
          .call("accept_task", { due_at: "15:00", criteria: "五家竞品。" })
          .then(() => {}),
    });
    await projector.finished({ tenantId, runRef: runId, failed: false });

    expect(parsed(round.results[0] ?? "{}").taskId).toBe(cardId);
    await roundLogged(tenantId, cardId, runId);
    const row = await cardRow(tenantId, cardId);
    expect(row?.tracked).toBe(true);
    expect(row?.status).toBe("running");
    expect(row?.dueReported).toBe(true);
    expect((await eventsOf(tenantId, cardId)).map((line) => line.kind)).toEqual(
      ["accepted", "progress", "run_ended"],
    );
    expect((await cardsOf(tenantId, agentId)).length).toBe(1);
  });
});

describe("accept_task in a pipeline step's turn", () => {
  test("a second piece of work keeps the run's ancestry: the board opens the run, and it takes none of the run's reserved slots", async () => {
    const tenantId = await tenant("step-second");
    const agentId = `agent-${suite}-step-second`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const groupId = randomUUID();
    const crew = randomUUID();
    const stepRef = `step-${suite}-${randomUUID().slice(0, 8)}`;
    await runAsTenant(tenantId, async () => {
      await database
        .insert(wakerGroups)
        .values({ id: groupId, tenantId, name: `steps ${suite}` });
      await database
        .insert(groupTaskRuns)
        .values({ id: crew, tenantId, groupId, status: "running", steps: [] });
    });
    // The crew's parent, keyed by the run, reserving its two steps (`pipeline/store.ts` `start`).
    const parent = await projector.opened({
      tenantId,
      title: "周报流水线",
      source: "group_run",
      runRef: crew,
      quotaUnits: 3,
    });
    const step = await projector.opened({
      tenantId,
      title: "整理周报",
      executorAgentId: agentId,
      source: "group_run",
      runRef: stepRef,
      parentTaskId: parent,
    });
    // The step's turn runs with its own card (the step's), as the crew runs it.
    const round = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "整理周报",
      entry: { cardRef: stepRef },
      work: async (run) => {
        await run.call("accept_task", { criteria: "周报写清楚。" });
        await run.call("accept_task", {
          title: "顺便整理待办",
          criteria: "待办按人列出。",
        });
      },
    });
    expect(parsed(round.results[0] ?? "{}").taskId).toBe(step);
    const second = parsed(round.results[1] ?? "{}");
    expect(second.accepted).toBe(true);
    const secondId = second.taskId as string;
    await roundLogged(tenantId, secondId, round.runId);
    const row = await cardRow(tenantId, secondId);
    expect(row).toBeDefined();
    expect(row?.source).toBe("group_run");
    expect(row?.parentTaskId).toBe(parent);
    expect(row?.tracked).toBe(true);
    // Charged on its own, like any second piece of work, not out of the run's reservation.
    expect(row?.quotaUnits).toBe(1);

    // The board opens it where its step opens: the crew's run.
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: tenantId,
        email: `${tenantId}@example.test`,
        role: "user" as const,
      });
      await next();
    };
    const routes = createTaskRoutes(database, requireUser, projector);
    const read = await runAsTenant(tenantId, async () => {
      const response = await routes.request(
        new Request(`http://board.test/${secondId}`),
      );
      return (await response.json()) as { task?: { open?: unknown } };
    });
    expect(read.task).toBeDefined();
    expect(read.task?.open).toEqual({ kind: "pipeline", id: crew });

    // The run's second step still has its reserved slot.
    const nextStep = await projector.opened({
      tenantId,
      title: "复核周报",
      executorAgentId: agentId,
      source: "group_run",
      runRef: `step-${suite}-${randomUUID().slice(0, 8)}`,
      parentTaskId: parent,
    });
    expect((await cardRow(tenantId, nextStep))?.quotaUnits).toBe(0);

    await runAsTenant(tenantId, async () => {
      await database.delete(groupTaskRuns).where(eq(groupTaskRuns.id, crew));
      await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
    });
  });
});

describe("deliver_task and the evidence gate", () => {
  test("accept then deliver in one run lands in awaiting_review with two events", async () => {
    const tenantId = await tenant("onerun");
    const agentId = `agent-${suite}-onerun`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const call = `call-${randomUUID()}`;
    const round = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "做一张三家对比图",
      reply: "图做好了，交给你验收。",
      work: async (run) => {
        await run.call("accept_task", {
          due_at: "10 分钟",
          criteria: "三家对比图。",
        });
        for (const event of chart(call)) run.draw(event);
        await run.call("deliver_task", {
          items: [
            { kind: "component", ref: "showBarChart", title: "三家对比图" },
          ],
          checks: ["对过三家的原始数字"],
        });
      },
    });
    const [card] = await cardsOf(tenantId, agentId);
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, round.runId);
    const row = await cardRow(tenantId, card.id);
    expect(row?.status).toBe("awaiting_review");
    expect(row?.deliverableRef).toEqual({
      kind: "deliverable",
      components: [
        {
          name: "showBarChart",
          args: { title: "三家对比", values: [1, 2, 3] },
        },
      ],
      checks: ["对过三家的原始数字"],
    });
    const kinds = (await eventsOf(tenantId, card.id)).map((line) => line.kind);
    expect(
      kinds.filter((kind) => kind !== "progress" && kind !== "run_ended"),
    ).toEqual(["accepted", "delivered"]);
    expect(parsed(round.results[1] ?? "{}").delivered).toBe(true);
    const custom = await storedCustom(tenantId, round.runId);
    expect(custom.map((event) => event.name)).toEqual([
      "delivery.accepted",
      "delivery.delivered",
    ]);
    expect(custom[1]?.value).toEqual({
      taskId: card.id,
      deliverable: row?.deliverableRef,
    });
  });

  test("no items → bounced", async () => {
    const card = await acceptedCard("noitems");
    const { runId, result } = await deliverOnThread(card, {
      items: [],
      checks: ["都查过了"],
    });
    const answer = parsed(result);
    expect(answer.bounced).toBe(true);
    expect(String(answer.reason)).toContain("没有交付物");
    expect((await cardRow(card.tenantId, card.cardId))?.status).toBe("running");
    const bounced = (await eventsOf(card.tenantId, card.cardId)).filter(
      (line) => line.kind === "bounced",
    );
    expect(bounced.length).toBe(1);
    expect(bounced[0]?.detail.runId).toBe(runId);
    const custom = await storedCustom(card.tenantId, runId);
    expect(custom.map((event) => event.name)).toEqual(["delivery.bounced"]);
    expect(custom[0]?.value).toEqual({
      taskId: card.cardId,
      reason: answer.reason,
    });
  });

  test("attachment from another thread → bounced", async () => {
    const card = await acceptedCard("otherfile");
    await channelOf(card.tenantId, card.threadId);
    // Handed over in this card's round, but the file lives in another conversation.
    const elsewhere = await fileIn(
      await channelOf(
        card.tenantId,
        `thread-${suite}-${randomUUID().slice(0, 8)}`,
      ),
      card.tenantId,
    );
    const { result } = await deliverOnThread(
      card,
      {
        items: [{ kind: "attachment", ref: elsewhere, title: "核对表" }],
        checks: ["逐行核对"],
      },
      async (run) => {
        produce(run, elsewhere);
      },
    );
    const answer = parsed(result);
    expect(answer.bounced).toBe(true);
    expect(String(answer.reason)).toContain("核对表");
    expect(answer.missing).toEqual(["核对表"]);
    expect((await cardRow(card.tenantId, card.cardId))?.status).toBe("running");
  });

  test("the person's own upload for the work → bounced", async () => {
    const card = await acceptedCard("upload");
    const original = await fileIn(
      await channelOf(card.tenantId, card.threadId),
      card.tenantId,
    );
    // The round sees the file: it is on the person's message, which is input, not output.
    const { result } = await deliverOnThread(
      card,
      {
        items: [{ kind: "attachment", ref: original, title: "核对表" }],
        checks: ["逐行核对"],
      },
      async (run) => {
        run.draw({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: `asked-${randomUUID()}`,
              role: "user",
              content: [{ type: "text", text: "核对这份" }, filePart(original)],
            },
          ],
        } as unknown as BaseEvent);
      },
    );
    const answer = parsed(result);
    expect(answer.bounced).toBe(true);
    expect(String(answer.reason)).toContain("不是你在这件活里做出来的文件");
    expect(
      (await cardRow(card.tenantId, card.cardId))?.deliverableRef,
    ).toBeNull();
  });

  test("a file from before the card → bounced", async () => {
    const tenantId = await tenant("older");
    const agentId = `agent-${suite}-older`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const older = await fileIn(await channelOf(tenantId, threadId), tenantId);
    // An earlier, ordinary turn of the thread produced it; nobody followed that turn.
    let olderMessage = "";
    await turn({
      tenantId,
      agentId,
      threadId,
      ask: "先随便做个表",
      work: async (run) => {
        olderMessage = produce(run, older);
      },
    });
    const [plain] = await cardsOf(tenantId, agentId);
    if (!plain) throw new Error("no card");
    await until(
      () => cardRow(tenantId, plain.id),
      (row) => row?.status === "awaiting_review",
    );
    // Then the work is taken on, on a card of its own.
    await turn({
      tenantId,
      agentId,
      threadId,
      ask: "正式核对三家发票",
      work: (run) =>
        run.call("accept_task", { criteria: "三家都核对。" }).then(() => {}),
    });
    const card = (await cardsOf(tenantId, agentId)).find(
      (row) => row.id !== plain.id,
    );
    if (!card) throw new Error("no tracked card");
    // The round's snapshot repeats the thread, older file included; it is not this round's.
    const { result } = await deliverOnThread(
      { tenantId, agentId, threadId, cardId: card.id },
      {
        items: [{ kind: "attachment", ref: older, title: "核对表" }],
        checks: ["逐行核对"],
      },
      async (run) => {
        run.draw({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: olderMessage,
              role: "assistant",
              content: [
                { type: "text", text: "核对表做好了。" },
                filePart(older),
              ],
            },
          ],
        } as unknown as BaseEvent);
      },
    );
    expect(parsed(result).bounced).toBe(true);
  });

  test("another member's file in the conversation → bounced", async () => {
    const card = await acceptedCard("member");
    const member = await tenant("othermember");
    const theirs = await fileIn(
      await channelOf(card.tenantId, card.threadId),
      member,
    );
    const { result } = await deliverOnThread(
      card,
      {
        items: [{ kind: "attachment", ref: theirs, title: "核对表" }],
        checks: ["逐行核对"],
      },
      async (run) => {
        produce(run, theirs);
      },
    );
    expect(parsed(result).bounced).toBe(true);
  });

  test("a staged file never sent → bounced", async () => {
    const card = await acceptedCard("staged");
    const staged = await fileIn(
      await channelOf(card.tenantId, card.threadId),
      card.tenantId,
      false,
    );
    const { result } = await deliverOnThread(card, {
      items: [{ kind: "attachment", ref: staged, title: "核对表" }],
      checks: ["逐行核对"],
    });
    expect(parsed(result).bounced).toBe(true);
  });

  test("component not drawn on this card → bounced", async () => {
    const card = await acceptedCard("nocomponent");
    // Drawn, but in another card's round of the same person.
    const other = await acceptedCard(
      "drawnelsewhere",
      undefined,
      async (run) => {
        for (const event of chart(`call-elsewhere-${suite}`)) run.draw(event);
      },
      card.tenantId,
    );
    for (const ref of [`call-elsewhere-${suite}`, "showBarChart"]) {
      const { result } = await deliverOnThread(card, {
        items: [{ kind: "component", ref, title: "对比图" }],
        checks: ["核对过"],
      });
      const answer = parsed(result);
      expect(answer.bounced).toBe(true);
      expect(String(answer.reason)).toContain("不是这件活里画的");
    }
    expect(
      (await cardRow(card.tenantId, card.cardId))?.deliverableRef,
    ).toBeNull();
    expect(other.cardId).not.toBe(card.cardId);
  });

  test("note only without checks → bounced", async () => {
    const card = await acceptedCard("noteonly");
    const { result } = await deliverOnThread(card, {
      items: [{ kind: "note", ref: "三家发票都没问题", title: "结论" }],
      checks: [],
    });
    const answer = parsed(result);
    expect(answer.bounced).toBe(true);
    expect(String(answer.reason)).toContain("checks");
  });

  test("criteria 必需：A、B、C with C missing → bounced naming C", async () => {
    const card = await acceptedCard(
      "required",
      "三家供应商都核对。必需：A家、B家、C家",
    );
    const { result } = await deliverOnThread(card, {
      items: [{ kind: "note", ref: "A、B 两家没问题", title: "A家核对结果" }],
      checks: ["B家逐张核对过"],
    });
    const answer = parsed(result);
    expect(answer.bounced).toBe(true);
    expect(answer.missing).toEqual(["C家"]);
    expect(String(answer.reason)).toContain("缺 C家");
  });

  test("a bounce leaves the card unchanged and returns the reason to the employee", async () => {
    const card = await acceptedCard("unchanged");
    const before = await cardRow(card.tenantId, card.cardId);
    const { result } = await deliverOnThread(card, {
      items: [
        { kind: "link", ref: "ftp://example.test/report", title: "报告" },
      ],
      checks: ["看过"],
    });
    const answer = parsed(result);
    expect(answer.bounced).toBe(true);
    expect(String(answer.reason)).toContain("http(s)");
    expect(String(answer.note)).toContain("卡片没动");
    const after = await cardRow(card.tenantId, card.cardId);
    expect(after?.status).toBe(before?.status);
    expect(after?.deliverableRef).toEqual(before?.deliverableRef);
    expect(after?.dueAt?.getTime()).toBe(before?.dueAt?.getTime());
    expect(after?.criteria).toBe(before?.criteria);
    expect(after?.acceptedAt?.getTime()).toBe(before?.acceptedAt?.getTime());
  });

  test("all good → awaiting_review and deliverable merged into deliverableRef", async () => {
    const drawnCall = `call-${randomUUID()}`;
    // The chart is drawn in the round that took the work on: an earlier, stored round of the card.
    const card = await acceptedCard(
      "allgood",
      "做核对表和对比图。必需：核对表、对比图",
      async (run) => {
        for (const event of chart(drawnCall)) run.draw(event);
      },
    );
    const file = await fileIn(
      await channelOf(card.tenantId, card.threadId),
      card.tenantId,
    );
    // The file is handed over in the card's round, then delivered in that same round.
    const first = await deliverOnThread(
      card,
      {
        items: [
          {
            kind: "link",
            ref: "https://example.test/report",
            title: "汇总报告",
          },
          {
            kind: "attachment",
            ref: `/api/attachments/${file}`,
            title: "核对表",
          },
          { kind: "component", ref: drawnCall, title: "对比图" },
        ],
        checks: ["三家逐张核对"],
      },
      async (run) => {
        produce(run, file);
      },
    );
    expect(parsed(first.result).delivered).toBe(true);
    let row = await cardRow(card.tenantId, card.cardId);
    expect(row?.status).toBe("awaiting_review");
    // Handed more while it awaits 验收: merged into what it holds.
    const second = await deliverOnThread(card, {
      items: [
        { kind: "note", ref: "C 家少一张，已补", title: "核对表补充说明" },
      ],
      checks: ["补的那张也核对了，对比图不受影响"],
    });
    expect(parsed(second.result).delivered).toBe(true);
    row = await cardRow(card.tenantId, card.cardId);
    expect(row?.status).toBe("awaiting_review");
    expect(row?.deliverableRef).toEqual({
      kind: "deliverable",
      components: [
        {
          name: "showBarChart",
          args: { title: "三家对比", values: [1, 2, 3] },
        },
      ],
      attachments: [file],
      links: [{ url: "https://example.test/report", title: "汇总报告" }],
      notes: ["C 家少一张，已补"],
      checks: ["三家逐张核对", "补的那张也核对了，对比图不受影响"],
    });
    expect(
      (await eventsOf(card.tenantId, card.cardId)).filter(
        (line) => line.kind === "delivered",
      ).length,
    ).toBe(2);
  });
});

describe("request_extension", () => {
  test("request_extension does not change due_at", async () => {
    const card = await acceptedCard("extension");
    const before = await cardRow(card.tenantId, card.cardId);
    const round = await turn({
      tenantId: card.tenantId,
      agentId: card.agentId,
      threadId: card.threadId,
      ask: "能按时交吗？",
      reply: "C 家的发票还没到，申请延期。",
      work: (run) =>
        run
          .call("request_extension", {
            due_at: "2 小时",
            reason: "C 家发票还没寄到",
          })
          .then(() => {}),
    });
    await roundLogged(card.tenantId, card.cardId, round.runId);
    const after = await cardRow(card.tenantId, card.cardId);
    expect(after?.dueAt?.getTime()).toBe(before?.dueAt?.getTime());
    expect(after?.originalDueAt?.getTime()).toBe(
      before?.originalDueAt?.getTime(),
    );
    const asked = (await eventsOf(card.tenantId, card.cardId)).filter(
      (line) => line.kind === "extension_requested",
    );
    expect(asked.length).toBe(1);
    expect(asked[0]?.detail).toMatchObject({
      runId: round.runId,
      reason: "C 家发票还没寄到",
    });
    const asks = Date.parse(String(asked[0]?.detail.dueAt));
    expect(asks).toBeGreaterThan(before?.dueAt?.getTime() ?? 0);
    expect(parsed(round.results[0] ?? "{}").requested).toBe(true);
    const custom = await storedCustom(card.tenantId, round.runId);
    expect(custom.map((event) => event.name)).toEqual([
      "delivery.extension_requested",
    ]);
    expect(custom[0]?.value).toEqual({
      taskId: card.cardId,
      dueAt: asked[0]?.detail.dueAt,
      reason: "C 家发票还没寄到",
    });
  });
});

describe("switching the loop off", () => {
  test("disabled accept_task tool is not offered", () => {
    const agentId = "agent-disabled";
    const other: GrantedTool = {
      name: "lookup",
      ref: "crm/lookup",
      description: "unused",
      parameters: z.object({}),
      execute: async () => "unused",
    };
    const granted = [...toolsFor("nobody", agentId), other];
    const deny = {
      id: "rule-1",
      botId: agentId,
      toolRef: ACCEPT_TASK_REF,
      effect: "*",
      scope: "*",
      behaviour: "deny" as const,
    };
    const offered = offeredDeliveryTools(
      granted.filter(
        (tool) =>
          !toolDisabled({ botId: agentId, toolRef: tool.ref }, [[deny]]),
      ),
    );
    // Off means the whole loop is off: nothing can be handed in that was never taken on.
    expect(offered.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(offeredDeliveryTools(granted).map((tool) => tool.name)).toEqual([
      "accept_task",
      "deliver_task",
      "request_extension",
      "lookup",
    ]);

    // And the coworker is told the four rules only while it holds accept_task.
    const prompt = (tools: GrantedTool[]) =>
      (
        builtInAgentConfiguration(
          {
            id: agentId,
            name: "小财",
            type: "built_in",
            systemPrompt: "你负责核对发票。",
          } as never,
          { provider: "openai", defaultModel: "gpt-5.6-terra" } as never,
          "synthetic-key",
          tools,
        ) as { prompt?: string }
      ).prompt ?? "";
    const holding = prompt(granted);
    expect(holding).toContain(deliveryProtocol());
    expect(holding).toContain("问一句答一句的普通对话不要用这三个工具");
    expect(prompt(offered)).not.toContain("【熊宝交付规约】");
  });
});

describe("where the cards come from, and how a round ends", () => {
  test("a remote coworker's own delivery.* event is neither stored nor relayed", async () => {
    const tenantId = await tenant("remote");
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
    const registered = registeredAgentFromRow({
      id: `remote-${suite}`,
      name: "外援",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://their-agent.test/ag-ui" },
      title: "外援",
      roleDescription: "帮忙核对。",
    });
    if (!registered) throw new Error("the Bot does not register");
    // Their endpoint's stream: a forged hand-in card between ordinary events.
    const endpoint = spyOn(HttpAgent.prototype, "run").mockImplementation(
      (input) =>
        of(
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          forgedDelivery(),
          { type: "CUSTOM", name: "partner.note", value: { ok: true } },
          { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "做完了。" },
          { type: "TEXT_MESSAGE_END", messageId: "m1" },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ) as never,
    );
    const relayed: BaseEvent[] = [];
    try {
      const built = (
        await buildAgents(
          [registered],
          { provider: "openai", defaultModel: "gpt-5.5" },
          "synthetic-key",
        )
      )[registered.id]?.clone();
      if (!built) throw new Error("no agent");
      const runner = new PostgresAgentRunner(database, projector, quota);
      await runAsTenant(tenantId, async () => {
        await new Promise<void>((resolve) => {
          runner
            .run({
              threadId,
              agent: built,
              input: {
                runId,
                threadId,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                  { id: `msg-${randomUUID()}`, role: "user", content: "核对" },
                ],
              } as unknown as RunAgentInput,
            })
            .subscribe({
              next: (event) => relayed.push(event),
              complete: () => void resolve(),
              error: () => void resolve(),
            });
        });
      });
    } finally {
      endpoint.mockRestore();
    }
    const names = (events: BaseEvent[]) =>
      events
        .filter((event) => event.type === EventType.CUSTOM)
        .map((event) => (event as BaseEvent & { name?: string }).name);
    // The endpoint's own custom event goes through; the card it forged does not.
    expect(names(relayed)).toEqual(["partner.note"]);
    expect(names(await storedCustom(tenantId, runId))).toEqual([
      "partner.note",
    ]);
  });

  test("a followed round that is stopped still has its end written on the card", async () => {
    const card = await acceptedCard("stopped");
    const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
    const runner = new PostgresAgentRunner(database, projector, quota);
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    /** A coworker that says a little, then works until it is stopped. */
    class Working extends AbstractAgent {
      private stop: () => void = () => {};
      override async runAgent(
        parameters?: RunAgentParameters,
        subscriber?: AgentSubscriber,
      ): Promise<RunAgentResult> {
        const input = parameters as RunAgentInput;
        const emit = (event: unknown) =>
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
          messageId: "w1",
          role: "assistant",
        });
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "w1",
          delta: "正在核对第二家。",
        });
        const stopped = new Promise<void>((resolve) => {
          this.stop = resolve;
        });
        started();
        await stopped;
        return { result: undefined, newMessages: [] };
      }
      override abortRun(): void {
        this.stop();
      }
      override run(): Observable<BaseEvent> {
        throw new Error("runAgent is the only entry used here");
      }
      override clone(): Working {
        return this;
      }
    }
    const agent = new Working({ agentId: card.agentId });
    const ended = runAsTenant(
      card.tenantId,
      () =>
        new Promise<void>((resolve) => {
          runner
            .run({
              threadId: card.threadId,
              agent,
              input: {
                runId,
                threadId: card.threadId,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                  {
                    id: `msg-${randomUUID()}`,
                    role: "user",
                    content: "进度？",
                  },
                ],
              } as unknown as RunAgentInput,
            })
            .subscribe({
              complete: () => void resolve(),
              error: () => void resolve(),
            });
        }),
    );
    await running;
    // The person presses Stop.
    await runAsTenant(card.tenantId, () =>
      runner.stop({ threadId: card.threadId, runId } as never),
    );
    await ended;
    const lines = await roundLogged(card.tenantId, card.cardId, runId);
    expect(
      lines.some(
        (line) =>
          (line.kind === "run_ended" || line.kind === "run_failed") &&
          line.detail.runId === runId,
      ),
    ).toBe(true);
    const row = await cardRow(card.tenantId, card.cardId);
    expect(row?.status).toBe("running");
    expect(row?.activeRunRef).toBeNull();
  });
});

/**
 * The whole life of a piece of work, through the real tools and the real runner: taken on, handed in,
 * then a follow-up the person asks after the hand-in stops to wait on them -- an approval, a question
 * -- and is answered. The hand-in is not taken back by it (only the person's 退回 does that), so the
 * card is still 已交成果 and the person reviews it. One card, one charge against the month.
 */
describe("after the hand-in", () => {
  const approvals = createApprovalStore(database, projector);
  const questions = createApprovalQuestions(
    database,
    async () => {},
    projector,
  );
  const parkingBoard = withQuestionParking(projector, questions);
  const opened: string[] = [];
  const asked: string[] = [];

  afterAll(async () => {
    for (const tenantId of tenants)
      await runAsTenant(tenantId, async () => {
        if (opened.length)
          await database
            .delete(approvalRequests)
            .where(inArray(approvalRequests.id, opened));
        if (asked.length)
          await database.delete(workItems).where(inArray(workItems.key, asked));
      });
  });

  /** Taken on in one turn, handed in in the next; the card is returned, and the month as it was before. */
  async function handedIn(label: string) {
    const tenantId = await tenant(label);
    const before = (await quota.usageFor(tenantId)).tasks;
    const agentId = `agent-${suite}-${label}`;
    const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
    const first = await turn({
      tenantId,
      agentId,
      threadId,
      ask: "核对三家供应商的发票",
      reply: "已接下。",
      work: async (run) => {
        await run.call("accept_task", {
          due_at: "40 分钟",
          criteria: "三家都核对，结论写清楚。",
        });
      },
    });
    const [card] = await cardsOf(tenantId, agentId);
    if (!card) throw new Error("no card");
    await roundLogged(tenantId, card.id, first.runId);
    const handed = await deliverOnThread(
      { tenantId, agentId, threadId, cardId: card.id },
      {
        items: [
          { kind: "note", ref: "三家都对得上，C 家少开一张。", title: "结论" },
        ],
        checks: ["逐张对过原始发票"],
      },
    );
    expect(parsed(handed.result).delivered).toBe(true);
    expect((await cardRow(tenantId, card.id))?.status).toBe("awaiting_review");
    return { tenantId, agentId, threadId, cardId: card.id, before };
  }

  async function reviewedOnce(card: Awaited<ReturnType<typeof handedIn>>) {
    expect(
      await delivery.review(
        card.tenantId,
        card.cardId,
        `user:${card.tenantId}`,
        "review",
      ),
    ).toBe(true);
    const row = await cardRow(card.tenantId, card.cardId);
    expect(row?.status).toBe("done");
    expect((await cardsOf(card.tenantId, card.agentId)).length).toBe(1);
    expect((await quota.usageFor(card.tenantId)).tasks).toBe(card.before + 1);
    const kinds = (await eventsOf(card.tenantId, card.cardId)).map(
      (line) => line.kind,
    );
    expect(
      kinds.filter((kind) => kind !== "progress" && kind !== "run_ended"),
    ).toEqual(["accepted", "delivered", "reviewed"]);
  }

  test("an approval in a follow-up after the hand-in leaves the card awaiting review, and it is reviewed", async () => {
    const card = await handedIn("after-approval");
    let approvalId = "";
    // The person asks for one more thing; the round stops on an approval, filed as the gate files it.
    const followUp = await turn({
      tenantId: card.tenantId,
      agentId: card.agentId,
      threadId: card.threadId,
      ask: "顺便把结论发给 Bob",
      reply: "发给 Bob 之前要你批准一下。",
      work: async (run) => {
        const request = await runAsTenant(card.tenantId, () =>
          approvals.open(
            approvalAction({
              actorId: card.tenantId,
              botId: card.agentId,
              toolRef: "computer_write_file",
              effect: "write",
              scope: "project",
              args: { path: "bob.txt", contents: "结论" },
              target: { filePath: "project/bob.txt" },
              continuation: {
                runId: run.runId,
                threadId: card.threadId,
                toolCallId: `call-bob-${suite}`,
                toolName: "computer_write_file",
                args: { path: "bob.txt", contents: "结论" },
                messages: [],
                state: {},
                context: [],
                forwardedProps: {},
              },
            }),
          ),
        );
        approvalId = request.id;
        opened.push(approvalId);
        // The gate's park lands while the round still waits on the decision, as a real round does.
        await until(
          () => cardRow(card.tenantId, card.cardId),
          (row) => row?.pendingApprovalId === approvalId,
        );
      },
    });
    await roundLogged(card.tenantId, card.cardId, followUp.runId);
    const waiting = await until(
      () => cardRow(card.tenantId, card.cardId),
      (row) => row?.pendingApprovalId === approvalId,
    );
    // Still handed in; it also waits on the person.
    expect(waiting?.status).toBe("awaiting_review");
    expect(waiting?.pendingApprovalId).toBe(approvalId);

    await runAsTenant(card.tenantId, () =>
      approvals.decide(card.tenantId, approvalId, "allow_once"),
    );
    // The decision moves the board after it is saved, not before it answers.
    const decided = await until(
      () => cardRow(card.tenantId, card.cardId),
      (row) => row?.pendingApprovalId === null,
    );
    expect(decided?.status).toBe("awaiting_review");
    expect(decided?.pendingApprovalId).toBeNull();
    await reviewedOnce(card);
  });

  test("ask_person in a follow-up after the hand-in leaves the card awaiting review, and it is reviewed", async () => {
    const card = await handedIn("after-question");
    let key = "";
    const followUp = await turn({
      tenantId: card.tenantId,
      agentId: card.agentId,
      threadId: card.threadId,
      ask: "顺便发给财务",
      reply: "发给财务的哪位？我先问一下你。",
      // As the deployment wires the board: a question the round left open parks the card after it ends.
      board: parkingBoard,
      work: async (run) => {
        // The question `ask_person` files for the person, under this round's run id.
        key = `question-${suite}-${randomUUID().slice(0, 6)}`;
        asked.push(key);
        await runAsTenant(card.tenantId, () =>
          database.insert(workItems).values({
            kind: "person.question",
            key,
            payload: {
              actorId: card.tenantId,
              botId: card.agentId,
              threadId: card.threadId,
              runId: run.runId,
              question: "发给财务的哪位？",
              mode: "completed_question",
            },
          }),
        );
      },
    });
    await roundLogged(card.tenantId, card.cardId, followUp.runId);
    const waiting = await until(
      () => cardRow(card.tenantId, card.cardId),
      (row) => row?.pendingApprovalId === key,
    );
    expect(waiting?.status).toBe("awaiting_review");
    expect(waiting?.pendingApprovalId).toBe(key);

    await runAsTenant(card.tenantId, () =>
      questions.respond(card.tenantId, key, "发给王经理"),
    );
    const answered = await cardRow(card.tenantId, card.cardId);
    expect(answered?.status).toBe("awaiting_review");
    expect(answered?.pendingApprovalId).toBeNull();
    await reviewedOnce(card);
  });
});

afterAll(async () => {
  for (const { tenantId, id } of createdChannels)
    await runAsTenant(tenantId, async () => {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    });
  for (const id of tenants) {
    await runAsTenant(id, async () => {
      const own = database
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.tenantId, id));
      await database
        .delete(threadRunEvents)
        .where(inArray(threadRunEvents.threadId, own));
      await database
        .delete(threadRuns)
        .where(inArray(threadRuns.threadId, own));
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
