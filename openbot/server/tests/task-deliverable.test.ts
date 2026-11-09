import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { attachmentUrl } from "../../shared/attachments";
import { NOT_SHOWN } from "../../shared/component-markers";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import { createDatabase } from "../src/db/client";
import { tasks, threadRunEvents, threadRuns, threads } from "../src/db/schema";
import { createResponsibilityEngine } from "../src/responsibilities/engine";
import type { ResponsibilityRunContext } from "../src/responsibilities/types";
import { createRoutineRunner, type TurnRunner } from "../src/routines/runner";
import type { RoutineStore } from "../src/routines/store";
import {
  createTaskProjector,
  type DeliverableRef,
  deliverableFromEvents,
  deliverableRefOf,
  isDeliverableRef,
  producedAttachments,
  type TaskProjector,
} from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec A9: 当某任务产出附件/文件/组件结果，任务进入"查收结果"；我点"查收"后任务转"已结束-已完成"。
 *
 * Every finish path that has a run's output in hand records it on the card as
 * `{ kind: "deliverable", components, attachments }`, so 查收结果 names what there is to look at.
 * The status rule is untouched: a run that finished is `awaiting_review` whether or not it produced
 * anything, and `reviewed` moves it to `done`. What a words-only chat answer should do is an open
 * product decision, so this file asserts only that such a card carries no deliverable.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const tenant = `t-${suite}`;
const agentId = `agent-${suite}`;

const CHART_ARGS = {
  title: "各团队收入",
  points: [
    { label: "销售", value: 120 },
    { label: "研发", value: 80 },
  ],
};

const event = (value: Record<string, unknown>): BaseEvent =>
  value as unknown as BaseEvent;

/** A display component call, streamed the way a coworker streams one: start, args in pieces, end. */
const drawn = (id: string, name: string, args: string): BaseEvent[] => [
  event({
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: name,
  }),
  event({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: id,
    delta: args.slice(0, 5),
  }),
  event({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: id,
    delta: args.slice(5),
  }),
  event({ type: EventType.TOOL_CALL_END, toolCallId: id }),
];

const said = (text: string): BaseEvent[] => [
  event({
    type: EventType.TEXT_MESSAGE_START,
    messageId: `m-${text.length}`,
    role: "assistant",
  }),
  event({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: `m-${text.length}`,
    delta: text,
  }),
  event({ type: EventType.TEXT_MESSAGE_END, messageId: `m-${text.length}` }),
];

const fileFrom = (id: string, role: "assistant" | "user", file: string) =>
  ({
    id,
    role,
    content: [
      { type: "text", text: "附上报告" },
      { type: "document", source: { type: "url", value: attachmentUrl(file) } },
    ],
  }) as unknown as Message;

describe("what a run produced, read from its stream", () => {
  test("a drawn display component is the deliverable, with the props it was drawn with", () => {
    const ref = deliverableFromEvents([
      ...said("图已画好"),
      ...drawn("call-1", "showBarChart", JSON.stringify(CHART_ARGS)),
    ]);
    expect(ref).toEqual({
      kind: "deliverable",
      components: [{ name: "showBarChart", args: CHART_ARGS }],
      attachments: [],
    });
    expect(isDeliverableRef(ref)).toBe(true);
  });

  test("words alone, an ordinary tool, a refused or malformed component produce nothing", () => {
    expect(deliverableFromEvents(said("三段结论已写好。"))).toBeUndefined();
    expect(
      deliverableFromEvents(drawn("call-2", "searchWeb", '{"query":"x"}')),
    ).toBeUndefined();
    expect(
      deliverableFromEvents([
        ...drawn("call-3", "showBarChart", JSON.stringify(CHART_ARGS)),
        event({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "call-3",
          messageId: "tool-3",
          content: `${NOT_SHOWN}the coworker may not use this component.`,
        }),
      ]),
    ).toBeUndefined();
    expect(
      deliverableFromEvents(drawn("call-4", "showBarChart", "{not json")),
    ).toBeUndefined();
  });

  test("an attachment counts when this run's assistant handed it over, not when a person sent it or an earlier turn did", () => {
    const snapshot = event({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        fileFrom("earlier", "assistant", "att-old"),
        fileFrom("person", "user", "att-person"),
        fileFrom("this-run", "assistant", "att-new"),
      ],
    });
    expect(deliverableFromEvents([snapshot], new Set(["earlier"]))).toEqual({
      kind: "deliverable",
      components: [],
      attachments: ["att-new"],
    });
    expect(
      producedAttachments([
        fileFrom("a", "assistant", "att-1"),
        fileFrom("b", "assistant", "att-1"),
        fileFrom("c", "user", "att-2"),
      ]),
    ).toEqual(["att-1"]);
  });

  test("the ref is only a deliverable when there is something in it, and only that kind reads as one", () => {
    expect(deliverableRefOf({})).toBeUndefined();
    expect(
      deliverableRefOf({ components: [], attachments: [] }),
    ).toBeUndefined();
    expect(deliverableRefOf({ attachments: ["a", "a"] })).toEqual({
      kind: "deliverable",
      components: [],
      attachments: ["a"],
    });
    expect(
      isDeliverableRef({
        kind: "circuit_breaker",
        components: [],
        attachments: [],
      }),
    ).toBe(false);
    expect(isDeliverableRef({ file: "report.md" })).toBe(false);
    expect(isDeliverableRef(null)).toBe(false);
  });
});

/**
 * A person's turn through the real runner and the real projector, then 查收 through the projector.
 * The agent is a stub that waits before emitting, the way a real coworker does, so the card's INSERT
 * lands before its UPDATE (see `task-card-run-error.test.ts`).
 */
async function takeTurn(events: BaseEvent[]) {
  const threadId = `thread-${suite}-${randomUUID().slice(0, 8)}`;
  const runId = `run-${suite}-${randomUUID().slice(0, 8)}`;
  const runner = new PostgresAgentRunner(database, projector);
  const agent = {
    agentId,
    messages: [],
    abortRun: () => undefined,
    runAgent: async (
      _input: RunAgentInput,
      handlers: { onEvent: (arg: { event: BaseEvent }) => void },
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      for (const item of events) handlers.onEvent({ event: item });
    },
  } as unknown as AbstractAgent;

  await runAsTenant(tenant, async () => {
    await new Promise<void>((resolve) => {
      runner
        .run({
          threadId,
          agent,
          input: {
            runId,
            threadId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [
              {
                id: `msg-${runId}`,
                role: "user",
                content: "画一张各团队收入的柱状图",
              },
            ],
          } as unknown as RunAgentInput,
        })
        .subscribe({
          complete: () => void resolve(),
          error: () => void resolve(),
        });
    });
  });

  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await runAsTenant(tenant, async () => {
      const [found] = await database
        .select({
          id: tasks.id,
          status: tasks.status,
          deliverableRef: tasks.deliverableRef,
        })
        .from(tasks)
        .where(eq(tasks.runRef, runId))
        .limit(1);
      return found;
    });
    if (row && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the card for ${runId} never left running`);
}

const started = event({
  type: EventType.RUN_STARTED,
  threadId: "t",
  runId: "r",
});
const ended = event({
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId: "r",
});

describe("a chat turn's card", () => {
  test("a turn that drew a component enters 查收结果 carrying it, and 查收 ends it as done", async () => {
    const card = await takeTurn([
      started,
      ...said("柱状图在这里。"),
      ...drawn("call-chart", "showBarChart", JSON.stringify(CHART_ARGS)),
      ended,
    ]);
    expect(card.status).toBe("awaiting_review");
    expect(card.deliverableRef as DeliverableRef).toEqual({
      kind: "deliverable",
      components: [{ name: "showBarChart", args: CHART_ARGS }],
      attachments: [],
    });

    expect(
      await projector.reviewed({ tenantId: tenant, taskId: card.id }),
    ).toBe(true);
    const [after] = await runAsTenant(tenant, async () => {
      return await database
        .select({ status: tasks.status, deliverableRef: tasks.deliverableRef })
        .from(tasks)
        .where(eq(tasks.id, card.id));
    });
    expect(after?.status).toBe("done");
    // 查收 closes the card; what was produced stays on it for whoever opens it later.
    expect(isDeliverableRef(after?.deliverableRef)).toBe(true);
    // Once is enough: a second 查收 has nothing left to move.
    expect(
      await projector.reviewed({ tenantId: tenant, taskId: card.id }),
    ).toBe(false);
  });

  test("a turn that only answered in words carries no deliverable", async () => {
    const card = await takeTurn([started, ...said("三段结论已写好。"), ended]);
    expect(card.status).toBe("awaiting_review");
    expect(card.deliverableRef).toBeNull();
  });

  test("a failed turn offers nothing to review, even what it drew before failing", async () => {
    const card = await takeTurn([
      started,
      ...drawn("call-half", "showBarChart", JSON.stringify(CHART_ARGS)),
      event({
        type: EventType.RUN_ERROR,
        message: "The coworker did not answer.",
      }),
    ]);
    expect(card.status).toBe("failed");
    expect(card.deliverableRef).toBeNull();
  });
});

type Finished = Parameters<TaskProjector["finished"]>[0];

function recordingBoard(finished: Finished[]) {
  return {
    async opened() {
      return "task-card";
    },
    async finished(input: Finished) {
      finished.push(input);
    },
  } satisfies Pick<TaskProjector, "opened" | "finished">;
}

describe("an unattended firing's card", () => {
  const CHANNEL: AgentChannel = {
    id: "channel_1",
    name: "周报",
    agentIds: ["bot_helper"],
    threadId: "thread_owner_channel_1",
    active: true,
    lastMessageAt: null,
  };

  async function fireRoutine(runTurn: TurnRunner) {
    const finished: Finished[] = [];
    const routineStore = {
      async runContext() {
        return {
          routineId: "routine_1",
          ownerUserId: "user_owner",
          tenantId: "user_owner",
          agentId: "bot_helper",
          channelId: CHANNEL.id,
          instruction: "画本周的收入图",
        };
      },
      async finishRun() {},
      async consecutiveFailures() {
        return 1;
      },
      async setEnabled() {},
    } as unknown as RoutineStore;
    const channelStore = {
      async get() {
        return CHANNEL;
      },
      async recordActivity() {},
    } as unknown as ChannelStore;
    await createRoutineRunner({
      routineStore,
      channelStore,
      runTurn,
      board: recordingBoard(finished),
    }).run("routine_run_1");
    return finished;
  }

  test("a routine firing files what it drew and handed over with its card", async () => {
    const finished = await fireRoutine(async () => ({
      replyText: "本周收入图已画好。",
      components: [{ name: "showBarChart", args: CHART_ARGS }],
      attachments: ["att-weekly"],
    }));
    expect(finished).toEqual([
      {
        tenantId: "user_owner",
        runRef: "routine_run_1",
        deliverableRef: {
          kind: "deliverable",
          components: [{ name: "showBarChart", args: CHART_ARGS }],
          attachments: ["att-weekly"],
        },
      },
    ]);
    // Still the review lane: neither `failed` nor anything else that would change the status rule.
    expect(finished[0]?.failed).toBeUndefined();
  });

  test("a routine firing that only replied files no deliverable", async () => {
    const finished = await fireRoutine(async () => ({
      replyText: "无新进展。",
    }));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.deliverableRef).toBeUndefined();
  });

  test("a responsibility run files what it drew with its card", async () => {
    const finished: Finished[] = [];
    const context: ResponsibilityRunContext = {
      runId: "run-1",
      responsibilityId: "goal-1",
      ownerUserId: "person-1",
      tenantId: "person-1",
      agentId: "bot-1",
      channelId: "channel-1",
      threadId: "thread-1",
      instruction: "Produce the quarterly graph",
      successCriteria: "Graph is visible",
      progress: "",
      eventId: "event-1",
      event: { source: "github", type: "issue.opened", payload: { number: 8 } },
      continuation: null,
    };
    let available = true;
    const engine = createResponsibilityEngine({
      store: {
        async ingestEvent() {
          return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
        },
        async beginRun() {
          if (!available) return null;
          available = false;
          return context;
        },
        async settleRun() {},
        async requeueRun() {
          return false;
        },
      },
      queue: {
        async claim() {
          return [
            {
              kind: "responsibility.run",
              key: "run-1",
              tenantId: "person-1",
              payload: { runId: "run-1" },
              attempts: 1,
            },
          ];
        },
        async renew() {
          return true;
        },
        async finish() {
          return true;
        },
        async release() {
          return false;
        },
      },
      board: recordingBoard(finished),
      runTurn: async () => ({
        replyText: "季度图已画好。",
        components: [{ name: "showLineChart", args: { title: "季度" } }],
      }),
    });
    await engine.dispatch({ owner: "replica-1" });
    expect(finished).toEqual([
      {
        tenantId: "person-1",
        runRef: "run-1",
        failed: false,
        deliverableRef: {
          kind: "deliverable",
          components: [{ name: "showLineChart", args: { title: "季度" } }],
          attachments: [],
        },
      },
    ]);
  });
});

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database.delete(threadRunEvents);
    await database.delete(threadRuns);
    await database.delete(threads);
    await database.delete(tasks);
  });
});
