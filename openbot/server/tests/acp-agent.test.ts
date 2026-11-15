import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { EMPTY } from "rxjs";
import {
  type AcpPermissionRequest,
  createAcpSessionHints,
  createAcpTurnStarter,
  DeviceAcpAgent,
  type DeviceAcpAgentConfig,
  type DeviceAcpEmployee,
  routeExternalTurns,
  useDeviceAcp,
} from "../src/agents/acp/agent";
import {
  buildFirstTurnContext,
  createAcpContextLoader,
} from "../src/agents/acp/context";
import { createAcpRelay } from "../src/agents/acp/relay";
import type { AcpTurnRow } from "../src/agents/acp/turns";
import { TurnWatchdog } from "../src/channels/turn-watchdog";
import {
  ASKED_RUN,
  isAskedRun,
  onOpenBotRunner,
  type RegisteredAgent,
  registeredAgentFromRow,
  resolveRuntimeAgents,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { tasks, threadRunEvents, threadRuns, threads } from "../src/db/schema";
import {
  createTaskProjector,
  deliverableFromEvents,
} from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { createMemoryAcpTurnStore } from "./support/acp-turns-memory";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工的运行传输（agent.ts）：真 relay（relay.ts）+ 内存轮次存储 + 假设备通道，测试扮演电脑上的
 * runner 往上发帧。看板与排队续跑两例走真的 PostgresAgentRunner 和数据库。
 */

type Frame = Record<string, unknown>;
type Loose = BaseEvent & Record<string, unknown>;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const dbTenant = `t-acp-${suite}`;

function setup(
  options: {
    tenantId?: string;
    reachable?: boolean;
    startQueuedTurn?: (row: AcpTurnRow) => Promise<void>;
  } = {},
) {
  const tenantId = options.tenantId ?? "tenant-a";
  const target = { tenantId, deviceId: "laptop" };
  const turns = createMemoryAcpTurnStore();
  const down: Frame[] = [];
  const state = {
    reachable: options.reachable ?? true,
    startQueuedTurn: options.startQueuedTurn,
  };
  const relay = createAcpRelay({
    channel: {
      notify: (_target, frame) => {
        if (!state.reachable) return false;
        down.push(frame);
        return true;
      },
      isReachable: () => state.reachable,
      connectionOf: () => (state.reachable ? "conn-1" : null),
    },
    turns,
    startQueuedTurn: async (row) => {
      if (!state.startQueuedTurn) throw new Error("no starter");
      await state.startQueuedTurn(row);
    },
    log: () => undefined,
  });
  const ticks = new Set<() => void>();
  const sessions = createAcpSessionHints();
  let turnCount = 0;
  const contextCalls: string[] = [];
  const base: DeviceAcpAgentConfig = {
    agentId: "agent-1",
    ownerUserId: "user-1",
    tenantId,
    deviceId: "laptop",
    harness: "codex",
    workdirRef: "fld_work",
    name: "小码",
    relay,
    turns,
    reachable: () => state.reachable,
    context: async (threadId) => {
      contextCalls.push(threadId);
      return buildFirstTurnContext({
        persona: "你是熊宝团队里的员工「小码」，前端工程师。",
        recent: Array.from({ length: 25 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `第 ${index + 1} 条`,
        })),
        taskCard: "修好登录页（进行中）",
      });
    },
    sessions,
    every: (_ms, tick) => {
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
    newTurnId: () => {
      turnCount += 1;
      return `turn-${turnCount}`;
    },
    log: () => undefined,
  };
  const agent = (extra: Partial<DeviceAcpAgentConfig> = {}) =>
    new DeviceAcpAgent({ ...base, ...extra });
  const from = { ...target, connectionId: "conn-1" };
  /** The device says something, and the relay has taken it in. */
  const device = async (frame: Frame) => {
    relay.fromRunner(from, {
      agentId: "agent-1",
      threadId: "thread-1",
      ...frame,
    });
    await relay.drain(from);
  };
  const tick = () => {
    for (const fire of [...ticks]) fire();
  };
  const sent = (type: string) => down.filter((frame) => frame.type === type);
  return {
    target,
    turns,
    down,
    state,
    relay,
    sessions,
    contextCalls,
    base,
    agent,
    device,
    tick,
    ticks,
    sent,
  };
}

const input = (
  text: string,
  extra: Partial<RunAgentInput> = {},
): RunAgentInput => ({
  threadId: "thread-1",
  runId: `run-${randomUUID().slice(0, 8)}`,
  messages: [{ id: `user-${randomUUID()}`, role: "user", content: text }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  ...extra,
});

function watch(agent: DeviceAcpAgent, runInput: RunAgentInput) {
  const events: Loose[] = [];
  const state = { done: false, error: null as unknown };
  const subscription = agent.run(runInput).subscribe({
    next: (event) => events.push(event as Loose),
    complete: () => {
      state.done = true;
    },
    error: (error) => {
      state.error = error;
    },
  });
  return { events, state, subscription };
}

async function until(predicate: () => boolean, label = "condition") {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const texts = (events: Loose[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => String(event.delta))
    .join("");

const editUpdate = (seq: number, turnId: string): Frame => ({
  type: "acp.update",
  turnId,
  seq,
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "call-edit",
    title: "Edit src/login.ts",
    kind: "edit",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "src/login.ts",
        oldText: "a\nb\nc\n",
        newText: "a\nB\nc\nd\n",
      },
    ],
  },
});

const chunk = (seq: number, turnId: string, text: string): Frame => ({
  type: "acp.update",
  turnId,
  seq,
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  },
});

const end = (turnId: string, extra: Frame = {}): Frame => ({
  type: "acp.turn.end",
  turnId,
  stopReason: "end_turn",
  interrupted: false,
  ...extra,
});

afterAll(async () => {
  await runAsTenant(dbTenant, async () => {
    await database.delete(threadRunEvents);
    await database.delete(threadRuns);
    await database.delete(threads);
    await database.delete(tasks);
  });
});

describe("DeviceAcpAgent", () => {
  test("reachable run streams to RUN_FINISHED and the board card closes with the diff deliverable", async () => {
    const t = setup({ tenantId: dbTenant });
    const projector = createTaskProjector(database);
    const runner = new PostgresAgentRunner(database, projector);
    const threadId = `thread-${suite}-board`;
    const runInput = input("把登录页修好", { threadId });
    const agent = t.agent();
    // What the runtime does before a run: the agent carries the thread and its messages.
    agent.threadId = threadId;
    agent.setMessages(runInput.messages);
    const events: Loose[] = [];
    let completed = false;
    await runAsTenant(dbTenant, async () => {
      runner.run({ threadId, agent, input: runInput }).subscribe({
        next: (event) => events.push(event as Loose),
        complete: () => {
          completed = true;
        },
        error: (error) => {
          throw error;
        },
      });
    });
    const device = (frame: Frame) => t.device({ threadId, ...frame });

    await until(() => t.sent("acp.open").length === 1, "acp.open");
    expect(t.sent("acp.open")[0]).toEqual({
      type: "acp.open",
      agentId: "agent-1",
      threadId,
      harness: "codex",
      workdirRef: "fld_work",
    });
    // Nothing is prompted before the device says which session the lane has.
    expect(t.sent("acp.prompt")).toHaveLength(0);
    await device({ type: "acp.session", sessionId: "sess-1", loaded: true });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    const prompt = t.sent("acp.prompt")[0] as Frame;
    // A loaded session already has the conversation: only the person's words.
    expect(prompt.content).toEqual([{ type: "text", text: "把登录页修好" }]);
    expect(t.contextCalls).toHaveLength(0);
    const turnId = String(prompt.turnId);
    expect(t.turns.rows[0]?.status).toBe("sent");

    await device({ type: "acp.turn.ack", turnId });
    await device(chunk(1, turnId, "我来改登录页。"));
    await device(editUpdate(2, turnId));
    await device(chunk(3, turnId, "改好了。"));
    t.tick();
    await device(end(turnId));
    await until(() => completed, "the run to complete");

    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(texts(events)).toBe("我来改登录页。改好了。");
    expect(t.turns.rows[0]?.status).toBe("done");
    expect(
      t.sessions.get({ tenantId: dbTenant, agentId: "agent-1", threadId }),
    ).toBe("sess-1");

    const diff = {
      name: "acp.diff",
      args: { files: [{ path: "src/login.ts", added: 2, removed: 1 }] },
    };
    expect(deliverableFromEvents(events)?.components).toEqual([diff]);
    // The card the runner opened for this turn is closed with that deliverable.
    let card: { status: string; deliverableRef: unknown } | undefined;
    for (
      let attempt = 0;
      attempt < 100 && card?.status !== "awaiting_review";
      attempt++
    ) {
      card = await runAsTenant(dbTenant, async () => {
        const [row] = await database
          .select({
            status: tasks.status,
            deliverableRef: tasks.deliverableRef,
          })
          .from(tasks)
          .where(eq(tasks.runRef, runInput.runId))
          .limit(1);
        return row;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(card?.status).toBe("awaiting_review");
    expect(card?.deliverableRef).toEqual({
      kind: "deliverable",
      components: [diff],
      attachments: [],
    });
    // The heartbeat went out live, and a reconnect does not replay it.
    const isWaiting = (event: Loose) =>
      event.type === EventType.CUSTOM && event.name === "acp.waiting";
    expect(events.some(isWaiting)).toBe(true);
    const replayed: Loose[] = [];
    await runAsTenant(dbTenant, async () => {
      await new Promise<void>((resolve) => {
        runner
          .connect({ threadId } as Parameters<typeof runner.connect>[0])
          .subscribe({
            next: (event) => replayed.push(event as Loose),
            complete: resolve,
            error: () => resolve(),
          });
      });
    });
    expect(
      replayed.some((event) => event.type === EventType.RUN_FINISHED),
    ).toBe(true);
    expect(replayed.some(isWaiting)).toBe(false);
  });

  test("unreachable run queues the turn and answers the queued sentence", async () => {
    const t = setup({ reachable: false });
    const run = watch(t.agent(), input("跑一下测试"));
    await until(() => run.state.done, "the run to end");
    expect(run.events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);
    expect(run.events.at(-2)?.name).toBe("acp.queued");
    expect(texts(run.events)).toBe(
      "小码的电脑现在离线，这件活已排队，电脑回来后自动继续。",
    );
    expect(t.turns.rows).toHaveLength(1);
    expect(t.turns.rows[0]).toMatchObject({
      tenantId: "tenant-a",
      agentId: "agent-1",
      threadId: "thread-1",
      deviceId: "laptop",
      status: "queued",
      prompt: {
        content: [{ type: "text", text: "跑一下测试" }],
        runRef: run.events[0]?.runId,
      },
    });
    expect(t.down).toHaveLength(0);
    expect(t.ticks.size).toBe(0);
  });

  test("a turn behind another of its lane waits in the queue", async () => {
    const t = setup();
    const first = watch(t.agent(), input("第一件"));
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    const second = watch(t.agent(), input("第二件"));
    await until(() => second.state.done, "the second run to end");
    expect(texts(second.events)).toContain("这件活已排队");
    expect(t.turns.rows.map((row) => row.status)).toEqual(["sent", "queued"]);
    first.subscription.unsubscribe();
  });

  test("a run awaiting permission for 3 simulated hours is not ended by the stall guard", async () => {
    const t = setup();
    let now = 0;
    const stalled: string[] = [];
    const watchdog = new TurnWatchdog({
      stallMs: 120_000,
      now: () => now,
      onStall: (stream) => stalled.push(stream.id),
    });
    const permissions: AcpPermissionRequest[] = [];
    const agent = t.agent({
      onPermission: (request) => permissions.push(request),
    });
    const runInput = input("推送到远端");
    watchdog.open({ id: "acp-run", botId: "agent-1" });
    // A stream that says nothing for as long, to show the watch would end a silent one.
    watchdog.open({ id: "silent", botId: "agent-1" });
    const events: Loose[] = [];
    let done = false;
    agent.run(runInput).subscribe({
      next: (event) => {
        events.push(event as Loose);
        watchdog.record("acp-run");
      },
      complete: () => {
        done = true;
      },
    });
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    await t.device({ type: "acp.session", sessionId: "s", loaded: true });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    const turnId = String(t.sent("acp.prompt")[0]?.turnId);
    await t.device({ type: "acp.turn.ack", turnId });
    await t.device({
      type: "acp.permission.request",
      turnId,
      requestId: "req-1",
      toolCall: { toolCallId: "call-push", kind: "execute", title: "git push" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      facts: { insideWorkdir: true, paths: [] },
    });
    expect(t.turns.rows[0]?.status).toBe("awaiting");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.frame.requestId).toBe("req-1");
    // Its own card: the run's id.
    expect(permissions[0]?.runRef).toBe(runInput.runId);

    // Three hours, in 20-second steps: the heartbeat goes out, the watch is swept.
    for (let step = 0; step < (3 * 60 * 60) / 20; step += 1) {
      now += 20_000;
      t.tick();
      watchdog.sweep();
    }
    expect(stalled).toEqual(["silent"]);
    expect(done).toBe(false);
    const waiting = events.filter(
      (event) =>
        event.type === EventType.CUSTOM && event.name === "acp.waiting",
    );
    expect(waiting.length).toBeGreaterThanOrEqual(540);

    await t.device(chunk(1, turnId, "已推送。"));
    await t.device(end(turnId));
    await until(() => done, "the run to end");
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(t.ticks.size).toBe(0);
  });

  test("first turn of a new session carries persona, last 20 messages and the task card", async () => {
    const t = setup();
    const run = watch(t.agent(), input("继续修登录"));
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    await t.device({
      type: "acp.session",
      sessionId: "sess-new",
      loaded: false,
    });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    const content = t.sent("acp.prompt")[0]?.content as {
      type: string;
      text: string;
    }[];
    expect(t.contextCalls).toEqual(["thread-1"]);
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "text", text: "继续修登录" });
    const context = content[0]?.text ?? "";
    expect(context).toContain("你是熊宝团队里的员工「小码」");
    expect(context).toContain("当前任务卡：修好登录页（进行中）");
    expect(context).toContain("最近的 20 条消息");
    expect(context).not.toContain("第 5 条");
    expect(context).toContain("第 6 条");
    expect(context).toContain("第 25 条");

    // The session id is sent back as the next open's hint.
    const turnId = String(t.sent("acp.prompt")[0]?.turnId);
    await t.device(end(turnId));
    await until(() => run.state.done, "the run to end");
    watch(t.agent(), input("再来一件"));
    await until(() => t.sent("acp.open").length === 2, "the second open");
    expect(t.sent("acp.open")[1]?.sessionHint).toBe("sess-new");
  });

  test("interrupted turn emits acp.interrupted with the original prompt", async () => {
    const t = setup();
    const run = watch(t.agent(), input("把测试跑完"));
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    await t.device({ type: "acp.session", sessionId: "s", loaded: true });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    const turnId = String(t.sent("acp.prompt")[0]?.turnId);
    await t.device({ type: "acp.turn.ack", turnId });
    await t.device(chunk(1, turnId, "开始跑……"));
    await t.device(
      end(turnId, { stopReason: "interrupted", interrupted: true }),
    );
    await until(() => run.state.done, "the run to end");
    expect(texts(run.events)).toBe("开始跑……电脑关机，这件活中断了。");
    const interrupted = run.events.find(
      (event) =>
        event.type === EventType.CUSTOM && event.name === "acp.interrupted",
    );
    expect(interrupted?.value).toEqual({ turnId, prompt: "把测试跑完" });
    expect(run.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(t.turns.rows[0]?.status).toBe("interrupted");
  });

  test("one cancel backstop interrupting several turns of the employee ends each run", async () => {
    const t = setup();
    const runs = ["thread-1", "thread-2"].map((threadId) =>
      watch(t.agent(), input(`在 ${threadId} 干活`, { threadId })),
    );
    await until(() => t.sent("acp.open").length === 2, "two opens");
    for (const threadId of ["thread-1", "thread-2"])
      await t.device({
        type: "acp.session",
        threadId,
        sessionId: threadId,
        loaded: true,
      });
    await until(() => t.sent("acp.prompt").length === 2, "two prompts");
    const prompts = t.sent("acp.prompt");
    for (const prompt of prompts)
      await t.device({
        type: "acp.turn.ack",
        threadId: prompt.threadId,
        turnId: prompt.turnId,
      });
    // The process went away: both turns end interrupted together.
    for (const prompt of prompts)
      t.relay.fromRunner(
        { ...t.target, connectionId: "conn-1" },
        {
          type: "acp.turn.end",
          agentId: "agent-1",
          threadId: prompt.threadId,
          turnId: prompt.turnId,
          stopReason: "interrupted",
          interrupted: true,
        },
      );
    await t.relay.drain({ ...t.target, connectionId: "conn-1" });
    await until(() => runs.every((run) => run.state.done), "both runs to end");
    for (const run of runs) {
      expect(texts(run.events)).toBe("电脑关机，这件活中断了。");
      expect(run.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    }
    expect(t.turns.rows.map((row) => row.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
  });

  test("ask_mode_lost ends the run with an error and forgets the lane's session", async () => {
    const t = setup();
    const lane = {
      tenantId: "tenant-a",
      agentId: "agent-1",
      threadId: "thread-1",
    };
    t.sessions.set(lane, "sess-old");
    const run = watch(t.agent(), input("改一下配置"));
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    expect(t.sent("acp.open")[0]?.sessionHint).toBe("sess-old");
    await t.device({
      type: "acp.session",
      sessionId: "sess-old",
      loaded: true,
    });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    const turnId = String(t.sent("acp.prompt")[0]?.turnId);
    await t.device({
      type: "acp.error",
      turnId,
      code: "ask_mode_lost",
      message: "智能体离开了先问再做的模式，这件活停下了。",
    });
    await t.device(end(turnId, { stopReason: "error" }));
    await until(() => run.state.done, "the run to end");
    expect(run.events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "智能体离开了先问再做的模式，这件活停下了。",
    });
    expect(t.sessions.get(lane)).toBeUndefined();
    watch(t.agent(), input("再试一次"));
    await until(() => t.sent("acp.open").length === 2, "the next open");
    expect(t.sent("acp.open")[1]?.sessionHint).toBeUndefined();
  });

  test("a failed open ends the run with the device's sentence", async () => {
    const t = setup();
    const run = watch(t.agent(), input("开工"));
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    await t.device({
      type: "acp.error",
      code: "unknown_workdir",
      message: "这台电脑上找不到这个工作文件夹。",
    });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    const turnId = String(t.sent("acp.prompt")[0]?.turnId);
    await t.device({
      type: "acp.error",
      turnId,
      code: "not_open",
      message: "没打开。",
    });
    await t.device(end(turnId, { stopReason: "error" }));
    await until(() => run.state.done, "the run to end");
    expect(run.events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
  });

  test("stopping a running turn cancels it on the device", async () => {
    const t = setup();
    const agent = t.agent();
    const run = watch(agent, input("长任务"));
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    await t.device({ type: "acp.session", sessionId: "s", loaded: true });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    agent.abortRun();
    expect(run.state.done).toBe(true);
    expect(t.sent("acp.cancel")).toEqual([
      {
        type: "acp.cancel",
        agentId: "agent-1",
        threadId: "thread-1",
        turnId: t.sent("acp.prompt")[0]?.turnId,
      },
    ]);
    expect(t.ticks.size).toBe(0);
  });

  test("a clone keeps its configuration", async () => {
    const t = setup({ reachable: false });
    const cloned = t.agent().clone();
    expect(cloned).toBeInstanceOf(DeviceAcpAgent);
    const run = watch(cloned, input("离线时"));
    await until(() => run.state.done, "the run to end");
    expect(texts(run.events)).toContain("小码的电脑现在离线");
  });
});

describe("startQueuedTurn", () => {
  test("a turn queued while the computer was away runs when it comes back, in its own thread", async () => {
    const projector = createTaskProjector(database);
    const runner = new PostgresAgentRunner(database, projector);
    const threadId = `thread-${suite}-queued`;
    const announced: { text: string; threadId: string }[] = [];
    const t = setup({ tenantId: dbTenant, reachable: false });
    const employee: DeviceAcpEmployee = {
      id: "agent-1",
      name: "小码",
      ownerUserId: "user-1",
      deviceId: "laptop",
      harness: "codex",
      workdirRef: "fld_work",
      persona: "",
    };
    t.state.startQueuedTurn = createAcpTurnStarter({
      database,
      turns: t.turns,
      runner,
      employeeFor: async () => employee,
      agentFor: (_employee, row) => t.agent({ claimed: row }),
      announce: async ({ text, threadId: announcedIn, failed }) => {
        expect(failed).toBe(false);
        announced.push({ text, threadId: announcedIn });
      },
    });
    const device = (frame: Frame) => t.device({ threadId, ...frame });

    // Offline: the person's turn is answered with the queued sentence and stored.
    const runOffline = input("把依赖升级一下", { threadId });
    const offline = new DeviceAcpAgent({ ...t.base });
    offline.threadId = threadId;
    offline.setMessages(runOffline.messages);
    await runAsTenant(dbTenant, async () => {
      await new Promise<void>((resolve, reject) => {
        runner
          .run({ threadId, agent: offline, input: runOffline })
          .subscribe({ complete: resolve, error: reject });
      });
    });
    expect(t.turns.rows.map((row) => row.status)).toEqual(["queued"]);
    let stored: Message[] = [];
    for (let attempt = 0; attempt < 100 && stored.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stored = runAsTenant(dbTenant, () => runner.getThreadMessages(threadId));
    }

    // Back: the heartbeat resumes the lane, and the turn is posted into the same thread.
    t.state.reachable = true;
    const resumed = t.relay.resumeQueued(t.target);
    await until(() => t.sent("acp.open").length === 1, "acp.open");
    await device({ type: "acp.session", sessionId: "s2", loaded: false });
    await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
    expect(await resumed).toBe(1);
    const prompt = t.sent("acp.prompt")[0] as Frame;
    const turnId = t.turns.rows[0]?.turnId;
    expect(prompt.turnId).toBe(turnId);
    expect((prompt.content as unknown[]).at(-1)).toEqual({
      type: "text",
      text: "把依赖升级一下",
    });
    // The queued answer's card waits, open, for this run: one card for the work.
    const cards = () =>
      runAsTenant(dbTenant, () =>
        database
          .select({
            runRef: tasks.runRef,
            status: tasks.status,
            deliverableRef: tasks.deliverableRef,
          })
          .from(tasks)
          .where(eq(tasks.channelRef, threadId)),
      );
    expect(await cards()).toEqual([
      { runRef: runOffline.runId, status: "running", deliverableRef: null },
    ]);
    await device({ type: "acp.turn.ack", turnId });
    t.tick();
    await device(chunk(1, String(turnId), "依赖已升级。"));
    await device(editUpdate(2, String(turnId)));
    t.tick();
    await device(end(String(turnId)));
    await until(() => announced.length === 1, "the answer to be announced");
    expect(announced[0]).toEqual({ text: "依赖已升级。", threadId });
    let card = (await cards())[0];
    for (
      let attempt = 0;
      attempt < 100 && card?.status === "running";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      card = (await cards())[0];
    }
    expect(await cards()).toHaveLength(1);
    expect(card).toMatchObject({
      runRef: runOffline.runId,
      status: "awaiting_review",
      deliverableRef: { kind: "deliverable" },
    });
    expect(t.turns.rows[0]?.status).toBe("done");

    // Both runs are the thread's: the queued answer, then the turn itself.
    let runs: { id: string }[] = [];
    for (let attempt = 0; attempt < 100 && runs.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      runs = await runAsTenant(dbTenant, () =>
        database
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(eq(threadRuns.threadId, threadId)),
      );
    }
    expect(runs).toHaveLength(2);
    // The heartbeats went out live and were not kept.
    const kept = await runAsTenant(dbTenant, () =>
      database
        .select({ event: threadRunEvents.event })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.threadId, threadId)),
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(
      kept.some(
        ({ event }) => (event as { name?: unknown }).name === "acp.waiting",
      ),
    ).toBe(false);
    const history = runAsTenant(dbTenant, () =>
      runner.getThreadMessages(threadId),
    );
    expect(
      history.some(
        (message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.includes("依赖已升级"),
      ),
    ).toBe(true);
  });

  test("a queued turn whose thread is mid-run goes back to the queue", async () => {
    const t = setup({ tenantId: dbTenant });
    const threadId = `thread-${suite}-busy`;
    await runAsTenant(dbTenant, () =>
      database
        .insert(threads)
        .values({ id: threadId, tenantId: dbTenant, agentId: "agent-1" }),
    );
    await t.turns.enqueue({
      tenantId: dbTenant,
      agentId: "agent-1",
      threadId,
      deviceId: "laptop",
      turnId: `turn-busy-${suite}`,
      prompt: [{ type: "text", text: "等一下" }],
    });
    let ran = 0;
    t.state.startQueuedTurn = createAcpTurnStarter({
      database,
      turns: t.turns,
      runner: {
        hydrate: async () => undefined,
        isRunning: async () => true,
        getThreadMessages: () => [],
        run: () => {
          ran += 1;
          throw new Error("must not run");
        },
      },
      employeeFor: async () => ({
        id: "agent-1",
        name: "小码",
        ownerUserId: "user-1",
        deviceId: "laptop",
        harness: "codex",
        workdirRef: "fld_work",
        persona: "",
      }),
      agentFor: (_employee, row) => t.agent({ claimed: row }),
    });
    expect(await t.relay.resumeQueued(t.target)).toBe(0);
    expect(t.turns.rows[0]?.status).toBe("queued");
    expect(ran).toBe(0);

    // An employee moved to another computer: the turn is cancelled, not retried for ever.
    t.state.startQueuedTurn = createAcpTurnStarter({
      database,
      turns: t.turns,
      runner: {
        hydrate: async () => undefined,
        isRunning: async () => false,
        getThreadMessages: () => [],
        run: () => {
          throw new Error("must not run");
        },
      },
      employeeFor: async () => ({
        id: "agent-1",
        name: "小码",
        ownerUserId: "user-1",
        deviceId: "desktop",
        harness: "codex",
        workdirRef: "fld_work",
        persona: "",
      }),
    });
    await t.relay.resumeQueued(t.target);
    expect(t.turns.rows[0]?.status).toBe("cancelled");
  });
});

describe("device_acp in the runtime", () => {
  const row = (
    configuration: Record<string, unknown>,
    ownerUserId: string | null = "user-1",
  ) => ({
    id: "agent-1",
    name: "小码",
    type: "device_acp" as const,
    configuration,
    title: "前端工程师",
    roleDescription: "负责登录页。",
    ownerUserId,
  });

  test("an external employee's row becomes a device_acp agent by reference, or nothing", () => {
    const built = registeredAgentFromRow(
      row({ deviceId: "laptop", harness: "codex", workdirRef: "fld_work" }),
    );
    expect(built).toMatchObject({
      id: "agent-1",
      type: "device_acp",
      ownerUserId: "user-1",
      deviceId: "laptop",
      harness: "codex",
      workdirRef: "fld_work",
    });
    expect(built?.type === "device_acp" && built.persona).toContain("小码");
    expect(built?.type === "device_acp" && built.persona).toContain(
      "负责登录页。",
    );
    // Its own agent needs its app; every one needs a computer, a folder and its hirer.
    expect(
      registeredAgentFromRow(
        row({ deviceId: "laptop", harness: "custom", workdirRef: "fld_work" }),
      ),
    ).toBeNull();
    expect(
      registeredAgentFromRow(
        row({
          deviceId: "laptop",
          harness: "custom",
          workdirRef: "fld_work",
          appRef: "app_mine",
        }),
      ),
    ).toMatchObject({ harness: "custom", appRef: "app_mine" });
    expect(
      registeredAgentFromRow(
        row({ deviceId: "laptop", harness: "grok", workdirRef: "fld_work" }),
      ),
    ).toBeNull();
    expect(
      registeredAgentFromRow(row({ harness: "codex", workdirRef: "fld_work" })),
    ).toBeNull();
    expect(
      registeredAgentFromRow(
        row(
          { deviceId: "laptop", harness: "codex", workdirRef: "fld_work" },
          null,
        ),
      ),
    ).toBeNull();
    // A check-in or a title runs it on OpenBot's own runner, as itself.
    expect(onOpenBotRunner(built as RegisteredAgent)).toMatchObject({
      id: "agent-1",
      type: "built_in",
    });
  });

  test("the runtime builds the transport for an asked run and never sends it a run of its own", async () => {
    const t = setup({ reachable: false });
    useDeviceAcp({
      relay: t.relay,
      turns: t.turns,
      channel: { isReachable: () => t.state.reachable },
      sessions: t.sessions,
      context: async () => [],
    });
    try {
      const employee = registeredAgentFromRow(
        row({ deviceId: "laptop", harness: "codex", workdirRef: "fld_work" }),
      ) as RegisteredAgent;
      const model = { provider: "openai" as const, defaultModel: "gpt-5.5" };
      // Built where nobody's run marks itself asked for: the transport itself.
      const plain = await runAsTenant("tenant-a", () =>
        resolveRuntimeAgents(
          async () => [employee],
          model,
          async () => null,
        ),
      );
      expect(plain["agent-1"]).toBeInstanceOf(DeviceAcpAgent);

      // The runtime's own map: an asked run reaches the computer (queued here, it is away)...
      const args = [
        async () => [employee],
        model,
        async () => null,
      ] as unknown as Parameters<typeof resolveRuntimeAgents>;
      // `holdsTools`, the twentieth: what the runtime's own map passes (`createRequestAgents`).
      args[19] = isAskedRun;
      const runtime = await runAsTenant("tenant-a", () =>
        resolveRuntimeAgents(...args),
      );
      const agent = runtime["agent-1"] as DeviceAcpAgent;
      const asked = watch(
        agent,
        input("修登录", { forwardedProps: { [ASKED_RUN]: true } }),
      );
      await until(() => asked.state.done, "the asked run to end");
      expect(texts(asked.events)).toContain("小码的电脑现在离线");
      expect(t.turns.rows).toHaveLength(1);

      // ...and a run the runtime makes for itself (a title) never does.
      const own = watch(
        agent,
        input("Generate a short title for the conversation above."),
      );
      await until(
        () => own.state.done || own.state.error !== null,
        "the title run to end",
      );
      expect(t.turns.rows).toHaveLength(1);
      expect(t.down).toHaveLength(0);
    } finally {
      useDeviceAcp(null);
    }
  });
});

test("a group sends an external employee's turns to its own runner", async () => {
  const ran: string[] = [];
  const route = routeExternalTurns({
    isExternal: async (agentId) => agentId === "codex-1",
    normal: async (turn: { agentId: string }) => {
      ran.push(`normal:${turn.agentId}`);
      return { replyText: "" };
    },
    external: async (turn: { agentId: string }) => {
      ran.push(`external:${turn.agentId}`);
      return { replyText: "" };
    },
  });
  await route({ agentId: "codex-1" });
  await route({ agentId: "writer" });
  expect(ran).toEqual(["external:codex-1", "normal:writer"]);
});

test("a turn that ended where this run could not hear it still ends the run", async () => {
  const t = setup();
  const run = watch(t.agent(), input("在别的服务器上结束"));
  await until(() => t.sent("acp.open").length === 1, "acp.open");
  await t.device({ type: "acp.session", sessionId: "s", loaded: true });
  await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
  const turnId = String(t.sent("acp.prompt")[0]?.turnId);
  // Another replica's relay took the device's frames and wrote the end; none reached this one.
  await t.turns.setStatus("tenant-a", turnId, "interrupted");
  t.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(run.state.done).toBe(false);
  t.tick();
  await until(() => run.state.done, "the run to end");
  expect(texts(run.events)).toBe("电脑关机，这件活中断了。");
  expect(run.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("a new session's context is read from the thread's stored messages and its open card", async () => {
  const threadId = `thread-${suite}-context`;
  const runId = `run-${suite}-context`;
  await runAsTenant(dbTenant, async () => {
    await database.insert(threads).values({
      id: threadId,
      tenantId: dbTenant,
      agentId: "agent-1",
      messagesSnapshot: [
        { id: "s", role: "system", content: "不算" },
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `m-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content:
            index === 23
              ? [{ type: "text", text: "第 24 条" }]
              : `第 ${index + 1} 条`,
        })),
      ],
    });
    await createTaskProjector(database).opened({
      tenantId: dbTenant,
      title: "升级依赖",
      executorAgentId: "agent-1",
      source: "chat",
      channelRef: threadId,
      runRef: runId,
    });
  });
  const load = createAcpContextLoader(database);
  const [block] = (await load({
    tenantId: dbTenant,
    agentId: "agent-1",
    threadId,
    runId,
    persona: "你是熊宝团队里的员工「小码」。",
  })) as { type: string; text: string }[];
  expect(block?.type).toBe("text");
  expect(block?.text).toContain("你是熊宝团队里的员工「小码」。");
  expect(block?.text).toContain("当前任务卡：升级依赖（进行中）");
  expect(block?.text).toContain("最近的 20 条消息");
  expect(block?.text).not.toContain("不算");
  expect(block?.text).not.toContain("第 4 条");
  expect(block?.text).toContain("用户：第 5 条");
  expect(block?.text).toContain("你：第 24 条");
  // Another tenant's frame reads none of it.
  const [other] = (await load({
    tenantId: `${dbTenant}-other`,
    agentId: "agent-1",
    threadId,
    persona: "",
  })) as { text: string }[];
  expect(other?.text).not.toContain("第 24 条");
  expect(other?.text).not.toContain("升级依赖");
});

test("a computer connected to another server is not called away: the turn is queued to start there", async () => {
  const t = setup({ reachable: false });
  const run = watch(
    t.agent({ onlineElsewhere: async () => true }),
    input("开工"),
  );
  await until(() => run.state.done, "the run to end");
  expect(texts(run.events)).toBe("小码的这件活已排队，马上开始。");
  expect(t.turns.rows[0]?.status).toBe("queued");
});

test("stopped while being queued for an away computer, the turn is cancelled", async () => {
  const t = setup({ reachable: false });
  const agent = t.agent();
  const run = watch(agent, input("算了"));
  agent.abortRun();
  await until(() => t.turns.rows[0]?.status === "cancelled", "the cancel");
  expect(run.state.done).toBe(true);
  expect(texts(run.events)).toBe("这件活已停止。");
});

test("a computer away for more than 30 minutes keeps its turn: it runs on, to be reconciled when it is back", async () => {
  const t = setup();
  const run = watch(
    t.agent({ onlineElsewhere: async () => false }),
    input("长任务"),
  );
  await until(() => t.sent("acp.open").length === 1, "acp.open");
  await t.device({ type: "acp.session", sessionId: "s", loaded: true });
  await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
  const turnId = String(t.sent("acp.prompt")[0]?.turnId);
  await t.device({ type: "acp.turn.ack", turnId });
  t.state.reachable = false;
  // An hour of heartbeats with the computer away (20 seconds each).
  for (let beat = 0; beat < 180; beat += 1) {
    t.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(run.state.done).toBe(false);
  expect(t.turns.rows[0]?.status).toBe("running");
  // Back, with what it did meanwhile: the run goes on to its end.
  t.state.reachable = true;
  await t.device(chunk(1, turnId, "断网期间做完了。"));
  await t.device(end(turnId));
  await until(() => run.state.done, "the run to end");
  expect(texts(run.events)).toBe("断网期间做完了。");
});

test("stopping a turn while its computer is connected to another server leaves the row to the device", async () => {
  const t = setup();
  const agent = t.agent({ onlineElsewhere: async () => true });
  const run = watch(agent, input("长任务"));
  await until(() => t.sent("acp.open").length === 1, "acp.open");
  await t.device({ type: "acp.session", sessionId: "s", loaded: true });
  await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
  t.state.reachable = false;
  agent.abortRun();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(run.state.done).toBe(true);
  expect(t.turns.rows[0]?.status).toBe("sent");
});

test("stopping a turn while its computer is away cancels the row here", async () => {
  const t = setup();
  const agent = t.agent();
  const run = watch(agent, input("长任务"));
  await until(() => t.sent("acp.open").length === 1, "acp.open");
  await t.device({ type: "acp.session", sessionId: "s", loaded: true });
  await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
  t.state.reachable = false;
  agent.abortRun();
  await until(() => t.turns.rows[0]?.status === "cancelled", "the cancel");
  expect(run.state.done).toBe(true);
  // The next message in the thread is not held behind it.
  t.state.reachable = true;
  watch(t.agent(), input("下一件"));
  await until(() => t.sent("acp.open").length === 2, "the next open");
});

test("a resumed turn that fails says so where it was asked", async () => {
  const runner = new PostgresAgentRunner(
    database,
    createTaskProjector(database),
  );
  const threadId = `thread-${suite}-fails`;
  const told: { text: string; failed: boolean }[] = [];
  const t = setup({ tenantId: dbTenant });
  await t.turns.enqueue({
    tenantId: dbTenant,
    agentId: "agent-1",
    threadId,
    deviceId: "laptop",
    turnId: `turn-fails-${suite}`,
    prompt: { content: [{ type: "text", text: "跑测试" }] },
  });
  t.state.startQueuedTurn = createAcpTurnStarter({
    database,
    turns: t.turns,
    runner,
    employeeFor: async () => ({
      id: "agent-1",
      name: "小码",
      ownerUserId: "user-1",
      deviceId: "laptop",
      harness: "codex",
      workdirRef: "fld_work",
      persona: "",
    }),
    agentFor: (_employee, row) => t.agent({ claimed: row }),
    announce: async ({ text, failed }) => {
      told.push({ text, failed });
    },
  });
  const resumed = t.relay.resumeQueued(t.target);
  const device = (frame: Frame) => t.device({ threadId, ...frame });
  await until(() => t.sent("acp.open").length === 1, "acp.open");
  await device({ type: "acp.session", sessionId: "s", loaded: true });
  await until(() => t.sent("acp.prompt").length === 1, "acp.prompt");
  expect(await resumed).toBe(1);
  const turnId = `turn-fails-${suite}`;
  await device({
    type: "acp.error",
    turnId,
    code: "turn_failed",
    message: "测试命令没能运行。",
  });
  await device(end(turnId, { stopReason: "error" }));
  await until(() => told.length === 1, "the failure to be told");
  expect(told[0]).toEqual({ text: "测试命令没能运行。", failed: true });
  // Let the run's write-through land before the suite's rows are cleared.
  for (let attempt = 0; attempt < 100; attempt++) {
    const [stored] = await runAsTenant(dbTenant, () =>
      database
        .select({ id: threadRuns.id })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, threadId)),
    );
    if (stored) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a resumed run that ends before its prompt went out puts the turn back", async () => {
  const t = setup({ tenantId: dbTenant });
  await t.turns.enqueue({
    tenantId: dbTenant,
    agentId: "agent-1",
    threadId: `thread-${suite}-empty`,
    deviceId: "laptop",
    turnId: `turn-empty-${suite}`,
    prompt: { content: [{ type: "text", text: "空跑" }] },
  });
  t.state.startQueuedTurn = createAcpTurnStarter({
    database,
    turns: t.turns,
    runner: {
      hydrate: async () => undefined,
      isRunning: async () => false,
      getThreadMessages: () => [],
      // A runner that refused the run quietly: the agent never ran.
      run: () => EMPTY,
    },
    employeeFor: async () => ({
      id: "agent-1",
      name: "小码",
      ownerUserId: "user-1",
      deviceId: "laptop",
      harness: "codex",
      workdirRef: "fld_work",
      persona: "",
    }),
    agentFor: (_employee, row) => t.agent({ claimed: row }),
  });
  expect(await t.relay.resumeQueued(t.target)).toBe(0);
  expect(t.turns.rows[0]?.status).toBe("queued");
});

test("stopped while it is being decided whether the computer is elsewhere, the queued turn is cancelled", async () => {
  const t = setup({ reachable: false });
  let answer!: (elsewhere: boolean) => void;
  let asked = false;
  const agent = t.agent({
    onlineElsewhere: () => {
      asked = true;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    },
  });
  const run = watch(agent, input("算了吧"));
  await until(() => asked, "the question");
  agent.abortRun();
  answer(false);
  await until(() => t.turns.rows[0]?.status === "cancelled", "the cancel");
  expect(run.state.done).toBe(true);
  expect(texts(run.events)).toBe("这件活已停止。");
});
