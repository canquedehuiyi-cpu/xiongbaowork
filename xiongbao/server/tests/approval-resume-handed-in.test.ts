import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  EmptyTurnError,
  settle,
  type TurnRunner,
} from "@xiongbao/toolkit/run-turn";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalService } from "../src/approvals/service";
import {
  type ApprovalRecord,
  type ApprovalStore,
  approvalAction,
} from "../src/approvals/types";
import type { ChannelStore } from "../src/channels/routes";
import type { Database } from "../src/db/client";
import type { ResponsibilityStore } from "../src/responsibilities/types";
import { acceptedDelivery } from "../src/tasks/delivery-end";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../src/work/queue";

/**
 * 批准后续跑以「交付即收尾」结束（prod-anomalies 2.3 ①）。
 *
 * 最后一个要批准的动作获准之后，续跑这一段以被接受的 `deliver_task` 结束、没再说话。原来 run-turn 把它算成
 * 空轮，续跑循环当它失败：每 10 秒 release、从同一处重跑，同一张卡交付 5～6 次，审批停在 `consumed`。这里
 * 用真的审批服务（服务器自己在审批行上结算）和真的续跑循环，只把队列、审批行和续跑器换成内存里的替身，
 * 把循环转到重试次数用完，看续跑器跑了几次、队列项怎么收、审批记录到了什么状态。
 */

const OWNER = "owner-handed-in";
const APPROVAL = "approval-handed-in";

const action = approvalAction({
  actorId: OWNER,
  botId: "bot",
  toolRef: "computer_run_command",
  effect: "write",
  scope: "fixture.invalid",
  args: {},
  continuation: {
    runId: "original-run",
    threadId: "thread",
    toolCallId: "call",
    toolName: "computer_run_command",
    args: {},
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  },
});

/** The approval row, already run and its answer saved: the state every retry of the item meets. */
function approvalRow() {
  const row: ApprovalRecord = {
    id: APPROVAL,
    ownerUserId: OWNER,
    action,
    status: "consumed",
    decision: "allow_once",
    result: { content: "ran" },
    createdAt: new Date(0),
    decidedAt: new Date(0),
    consumedAt: new Date(0),
    completedAt: null,
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used here");
  };
  const store: ApprovalStore = {
    enabled: async () => true,
    setEnabled: unused,
    open: unused,
    get: async (owner, id) => {
      if (owner !== row.ownerUserId || id !== row.id)
        throw new Error("not owned");
      return structuredClone(row);
    },
    list: unused,
    decide: unused,
    consume: unused,
    saveResult: async () => false,
    finish: async () => {
      row.status = "completed";
      row.completedAt = new Date();
    },
    rules: unused,
    revoke: unused,
    getRecoveryContext: async () => ({
      request: structuredClone(row),
      tenantId: OWNER,
      parentActionDigest: action.actionDigest,
      parentRunId: action.runId,
      parentToolCallId: action.toolCallId,
    }),
  };
  return { row, store };
}

/** The work queue, in memory: a released item is handed out again, one try more, until its tries run out. */
function approvalQueue() {
  const calls = { finish: 0, release: 0 };
  let open = true;
  let attempts = 0;
  const queue = {
    claim: async () => {
      if (!open || attempts >= DEFAULT_MAX_ATTEMPTS) return [];
      attempts++;
      return [
        {
          kind: "approval.resume",
          key: APPROVAL,
          tenantId: OWNER,
          payload: { ownerUserId: OWNER, approvalId: APPROVAL },
          attempts,
        },
      ];
    },
    finish: async () => {
      calls.finish++;
      open = false;
      return true;
    },
    release: async () => {
      calls.release++;
      return true;
    },
  } as unknown as WorkQueue;
  return { queue, calls };
}

/** Every query reads nothing back: no goal run, no group row and no channel are waiting on this. */
const nothingWaiting: Database = (() => {
  const chain: unknown = new Proxy(() => undefined, {
    get: (_target, property) =>
      property === "then"
        ? (resolve: (rows: unknown[]) => void) => resolve([])
        : () => chain,
  });
  return chain as Database;
})();

/** The rest of the turn after the approval: read, then `deliver_task`, accepted. */
const handedIn: Message[] = [
  {
    id: "assistant-deliver",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "deliver-1",
        type: "function",
        function: { name: "deliver_task", arguments: "{}" },
      },
    ],
  },
  {
    id: "tool-deliver",
    role: "tool",
    toolCallId: "deliver-1",
    content: JSON.stringify({ delivered: true, taskId: "card-1" }),
  },
];

/**
 * A continuation runner whose turn starts and ends as `messages` and `handedIn` say, settled by the
 * toolkit's own `settle` exactly as `createTurnRunner` does: silence that is not a hand-in is
 * {@link EmptyTurnError}.
 */
function continuation(input: {
  messages: Message[];
  handedIn?: (toolName: string, result: string) => boolean;
}) {
  const ran: unknown[] = [];
  const runner: TurnRunner = async (turn) => {
    ran.push(turn.continuation);
    turn.onStarted?.();
    const outcome = settle({
      stopped: false,
      added: input.messages,
      chunks: [],
      pendingInterrupts: [],
      componentNames: new Set(),
      ...(input.handedIn ? { handedIn: input.handedIn } : {}),
    });
    if (outcome.kind === "empty") throw new EmptyTurnError();
    if (outcome.kind !== "completed") throw new Error(outcome.kind);
    return { replyText: outcome.replyText };
  };
  return { runner, ran };
}

function resumeLoop(runner: TurnRunner) {
  const { row, store } = approvalRow();
  const { queue, calls } = approvalQueue();
  const tick = createApprovalResumeTick({
    approvalQueue: queue,
    approvalOwner: "approval-owner",
    approvalService: createApprovalService(store, undefined, undefined, {
      settlement: "database",
    }),
    executeApprovedAction: async () => {
      throw new Error("the approved action already ran");
    },
    database: nothingWaiting,
    responsibilityStore: {} as ResponsibilityStore,
    groupConversations: { continueWaiting: (_approvalId, run) => run() },
    approvalContinuationRunner: runner,
    channelStore: {} as ChannelStore,
    actorFor: async () => {
      throw new Error("no channel to write to");
    },
    notify: async () => undefined,
  });
  /** Ticks as the server's loop would, for every try the queue would hand out. */
  const runOut = async () => {
    for (let i = 0; i <= DEFAULT_MAX_ATTEMPTS; i++) await tick();
  };
  return { row, calls, tick, runOut };
}

let logged: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => logged.mockRestore());

const loggedTypes = () =>
  logged.mock.calls.map(
    ([line]: unknown[]) => (JSON.parse(String(line)) as { type: string }).type,
  );

test("续跑以被接受的交付结束、没说话：只跑一次，队列项收尾，审批记为完成", async () => {
  const { runner, ran } = continuation({
    messages: handedIn,
    handedIn: acceptedDelivery,
  });
  const loop = resumeLoop(runner);
  await loop.runOut();

  expect(ran).toHaveLength(1);
  expect(loop.calls).toEqual({ finish: 1, release: 0 });
  expect(loop.row.status).toBe("completed");
  expect(loggedTypes()).not.toContain("approval-resume-error");
  expect(loggedTypes()).not.toContain("approval-continuation-ended");
});

test("被挡回的交付不算交付；续跑已经开始，空轮也不再从同一处重跑", async () => {
  const bounced: Message[] = [
    handedIn[0] as Message,
    {
      id: "tool-deliver",
      role: "tool",
      toolCallId: "deliver-1",
      content: JSON.stringify({ bounced: true }),
    },
  ];
  const { runner, ran } = continuation({
    messages: bounced,
    handedIn: acceptedDelivery,
  });
  const loop = resumeLoop(runner);
  await loop.runOut();

  // Still the empty turn it was (the conversation's run says so); the decision is not run again.
  expect(ran).toHaveLength(1);
  expect(loop.calls).toEqual({ finish: 1, release: 0 });
  expect(loop.row.status).toBe("completed");
  expect(loggedTypes()).toContain("approval-continuation-ended");
  expect(loggedTypes()).not.toContain("approval-resume-error");
});

test("开始之后才失败的续跑不重跑：它的工具已经执行过了", async () => {
  const ran: unknown[] = [];
  const runner: TurnRunner = async (turn) => {
    ran.push(turn.continuation);
    turn.onStarted?.();
    throw new Error("The model provider is having problems right now.");
  };
  const loop = resumeLoop(runner);
  await loop.runOut();

  expect(ran).toHaveLength(1);
  expect(loop.calls).toEqual({ finish: 1, release: 0 });
  expect(loop.row.status).toBe("completed");
});

test("还没开始就失败的续跑照旧放回队列重试：什么都没执行", async () => {
  const ran: unknown[] = [];
  const runner: TurnRunner = async (turn) => {
    ran.push(turn.continuation);
    throw new Error("Thread lock denied");
  };
  const loop = resumeLoop(runner);
  await loop.tick();

  expect(ran).toHaveLength(1);
  expect(loop.calls).toEqual({ finish: 0, release: 1 });
  expect(loop.row.status).toBe("consumed");
  expect(loggedTypes()).toContain("approval-resume-error");
});
