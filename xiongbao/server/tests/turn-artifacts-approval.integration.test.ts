import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import { Observable } from "rxjs";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import type { AgentActor } from "../src/agents/profile-types";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalAction,
  type ApprovalContinuation,
  type ApprovalDecision,
  parseApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import type { ChannelStore } from "../src/channels/routes";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import { configureTurnArtifacts } from "../src/computer/turn-artifacts";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import type { ResponsibilityStore } from "../src/responsibilities/types";
import { createTurnRunner, type RunnerLike } from "../src/routines/run-turn";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { workspaceComputer } from "./support/workspace-computer";

/**
 * 「改动之前先问」打开时，员工写文件要等人批准。批准后的那一次写由审批的续跑循环执行
 * （`approvals/resume-sweep.ts` → `service.resume` → `execute`），不在任何一段被观察的流里：
 * 等人的那段 run 停下时已经比对过，续跑的 run 开始时文件已经写好。这里走生产的组合——真的审批库、
 * 真的工作队列、真的续跑循环和真的轮次执行器，电脑是只记文件的替身（`support/workspace-computer.ts`），
 * 前面是真的网关和审批闸门——断言这一轮的产物清单里有那份文件，并且只有一次。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `artifacts-approval-${randomUUID()}`;
const store = createApprovalStore(database);
const service = createApprovalService(store, undefined, undefined, {
  settlement: "database",
});
const queue = createWorkQueue(database);
const people: string[] = [];

afterEach(() => configureTurnArtifacts(undefined));
afterAll(async () => {
  for (const owner of people) {
    const ids = (await runAsTenant(owner, () => store.list(owner))).map(
      (row) => row.id,
    );
    if (ids.length)
      await runAsTenant(owner, () =>
        database
          .delete(workItems)
          .where(
            and(
              eq(workItems.kind, "approval.resume"),
              inArray(workItems.key, ids),
            ),
          ),
      );
  }
  if (people.length)
    await runAsTenant("platform", () =>
      database.delete(users).where(inArray(users.id, people)),
    );
  await database.$client.close();
});

const lifecycle = (input: RunAgentInput, body: BaseEvent[]) =>
  [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[];

const writeCall = (id: string, args: { path: string; contents: string }) =>
  [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: "computer_write_file",
      parentMessageId: `${id}-message`,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ] as BaseEvent[];

const say = (text: string) =>
  [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ] as BaseEvent[];

const listed = (events: readonly BaseEvent[]) =>
  events.filter(
    (event) =>
      event.type === EventType.CUSTOM &&
      (event as unknown as { name: string }).name === TURN_ARTIFACTS_EVENT,
  ) as unknown as { value: { files: { path: string }[] } }[];

const paths = (events: readonly BaseEvent[]) =>
  listed(events).flatMap((event) => event.value.files.map((file) => file.path));

/**
 * One person, one employee with a computer, and the server's approval resume loop over them.
 *
 * `afterApproval` is what the model does once the carried-on turn hands it the approved write's
 * result, counted by how many tool results it has seen since: a write of its own, or an answer.
 */
async function scene(afterApproval: (answered: number) => BaseEvent[]) {
  const owner = `${prefix}-${randomUUID().slice(0, 8)}`;
  const bot = `${owner}-bot`;
  people.push(owner);
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
  // 「改动之前先问」：员工每次改东西都先问这个人。
  await runAsTenant(owner, () =>
    service.setPreferences(owner, { enabled: true }),
  );

  const computer = workspaceComputer({
    approvalGate: (candidate) => service.gate(candidate),
  });
  configureTurnArtifacts({
    gateway: computer.gateway,
    seatOf: computer.seatOf,
  });
  const seat = await computer.seatOf(bot, owner);
  const toolsOf = (actorId: string) =>
    createHeadlessComputerTools({
      gateway: computer.gateway,
      seat,
      actor: { id: actorId, userId: actorId, initiator: { kind: "person" } },
    });

  /** The Bot's write, held for the person: returns the request id. */
  const ask = async (call: ApprovalContinuation) => {
    const tool = toolsOf(owner).find(
      (candidate) => candidate.definition.name === call.toolName,
    );
    if (!tool) throw new Error("no write tool");
    const waiting = await runAsTenant(owner, () =>
      withApprovalContext(call, () =>
        tool.execute(call.args, {
          toolCallId: call.toolCallId,
          signal: new AbortController().signal,
        }),
      ),
    ).then(
      () => undefined,
      (error: unknown) => error as { waiting?: { requestId?: unknown } },
    );
    const id = waiting?.waiting?.requestId;
    if (typeof id !== "string")
      throw new Error(`expected the write to wait, got ${String(waiting)}`);
    return id;
  };

  /** The approved action, carried out as index.ts's `executeApprovedAction` does: the same tool again. */
  const execute = (action: ApprovalAction) => {
    const call = parseApprovalContinuation(action.continuation);
    const tool = toolsOf(action.actorId).find(
      (candidate) => candidate.definition.name === call.toolName,
    );
    if (!tool) throw new Error("no write tool");
    return withApprovalContext(call, () =>
      tool.execute(call.args, {
        toolCallId: call.toolCallId,
        signal: new AbortController().signal,
      }),
    );
  };

  const threadId = `${owner}-thread`;
  /** Every event of every run the carried-on turn sent on, in this person's conversation only. */
  const persisted: BaseEvent[] = [];
  const runner: RunnerLike = {
    run: ({ agent, input }) =>
      new Observable<BaseEvent>((subscriber) => {
        agent
          .runAgent(input, {
            onEvent: ({ event }) => {
              if (input.threadId === threadId) persisted.push(event);
              subscriber.next(event);
            },
          })
          .then(
            () => subscriber.complete(),
            (error) => subscriber.error(error),
          );
      }),
    stop: async () => true,
  };
  const runTurn = createTurnRunner({
    admission: serverTurnAdmission,
    intelligence: {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => undefined,
      ɵrenewThreadLock: async () => undefined,
      ɵcleanupThreadLock: async () => undefined,
    },
    runner,
    buildAgentFor: async () =>
      new HttpAgent({
        agentId: bot,
        url: "https://agent.example/ag-ui",
        fetch: async (_url, init) => {
          const input = JSON.parse(String(init?.body)) as RunAgentInput;
          const answered = input.messages.filter(
            (message) => message.role === "tool",
          ).length;
          return new Response(
            lifecycle(input, afterApproval(answered))
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
    toolsForTurn: async ({ ownerUserId }) => toolsOf(ownerUserId),
  });

  const resume = createApprovalResumeTick({
    approvalQueue: queue,
    approvalOwner: `${owner}-approval`,
    approvalService: service,
    executeApprovedAction: execute,
    database,
    responsibilityStore: {} as ResponsibilityStore,
    // A person's own chat with one employee: carried on as the real one does for it.
    groupConversations: { continueWaiting: (_approvalId, run) => run() },
    approvalContinuationRunner: runTurn,
    channelStore: {} as ChannelStore,
    actorFor: async (id): Promise<AgentActor> => ({ id, role: "user" }),
    notify: async () => undefined,
  });

  /** The Bot asks to write `path`, the person answers, and the loop carries the turn on. */
  const approveWrite = async (path: string, decision: ApprovalDecision) => {
    const toolCallId = randomUUID();
    const args = { path, contents: "the report" };
    const call: ApprovalContinuation = {
      runId: randomUUID(),
      threadId,
      toolCallId,
      toolName: "computer_write_file",
      args,
      messages: [
        { id: "u1", role: "user", content: "Write the report" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name: "computer_write_file",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      ],
      state: {},
      context: [],
      forwardedProps: {},
    };
    const id = await ask(call);
    expect(computer.files.has(path)).toBe(false);
    await runAsTenant(owner, () => service.decide(owner, id, decision, "web"));
    /*
     * The queue hands out the oldest item of its kind, and a shared test database may hold another
     * suite's: a tick that took one of those leaves it for later, so tick until this one is done.
     */
    for (let tick = 0; tick < 50; tick += 1) {
      await resume();
      if (
        (await runAsTenant(owner, () => store.get(owner, id))).status ===
        "completed"
      )
        break;
    }
    expect(computer.files.has(path)).toBe(true);
    return id;
  };

  return { approveWrite, persisted, computer, owner };
}

test("a file an approved write left is listed in the turn's artifacts, once", async () => {
  const { approveWrite, persisted } = await scene(() => say("Written."));
  await approveWrite("out/report.md", "allow_once");
  expect(listed(persisted)).toHaveLength(1);
  expect(paths(persisted)).toEqual(["out/report.md"]);
});

test("the carried-on turn writing the same file again still lists it once, with its own files", async () => {
  const { approveWrite, persisted } = await scene((answered) =>
    answered === 1
      ? writeCall("again", { path: "out/report.md", contents: "v2" })
      : answered === 2
        ? writeCall("notes", { path: "out/notes.md", contents: "n" })
        : say("Written."),
  );
  // 「始终允许」：之后同样的写不再问，续跑的那段自己写得进去。
  await approveWrite("out/report.md", "allow_always");
  expect(listed(persisted)).toHaveLength(1);
  expect(paths(persisted).sort()).toEqual(["out/notes.md", "out/report.md"]);
});
