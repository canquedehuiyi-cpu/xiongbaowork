import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAcpClient } from "../../runner/src/acp/client";
import { type AcpHost, createAcpHost } from "../../runner/src/acp/host";
import type { FakeAcpScript } from "../../runner/tests/fixtures/fake-acp-agent";
import {
  type AcpTurnStarter,
  acpPermissionRequestOf,
  createAcpSessionHints,
  createAcpTurnStarter,
  deviceAcpAgentFor,
  deviceAcpRuntime,
  useDeviceAcp,
} from "../src/agents/acp/agent";
import { createAcpContextLoader } from "../src/agents/acp/context";
import {
  type AcpPermissionBridge,
  createAcpApprovalHirer,
  createAcpEmployeeLoader,
  createAcpPermissionBridge,
} from "../src/agents/acp/permissions";
import { createAcpRelay } from "../src/agents/acp/relay";
import { createExternalAgentRoutes } from "../src/agents/acp/routes";
import { createAcpTurnStore } from "../src/agents/acp/turns";
import {
  type AgentPresence,
  type PresenceDeviceReachable,
  readAgentPresence,
} from "../src/agents/presence";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { loadDeviceAcpEmployee } from "../src/agents/runtime-agents";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  acpTurns,
  agentProfiles,
  agents,
  approvalRequests,
  channels,
  intelligenceChannelMappings,
  OFFLINE_AFTER_MS,
  registeredDevices,
  subscriptions,
  tasks,
  threadRunEvents,
  threadRuns,
  threads,
  usageCounters,
  users,
  workItems,
} from "../src/db/schema";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import { createDeviceChannel } from "../src/devices/channel";
import {
  type RunnerSocketLike,
  runnerClose,
  runnerMessage,
  runnerOpen,
} from "../src/devices/socket";
import { createDeviceStore, type DeviceStore } from "../src/devices/store";
import { createQuotaService } from "../src/quota/limits";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工期二端到端：服务器这一侧全是真的——招聘接口、设备通道和 runner socket 处理（devices/socket.ts）、
 * relay、轮次存储（数据库）、DeviceAcpAgent 与 PostgresAgentRunner、许可桥、审批存储 / 服务 / 路由、看板、
 * presence；电脑那一侧是真的 runner ACP 宿主（runner/src/acp/host.ts）带着 Task 3 的假 ACP 智能体（子进程，
 * 按剧本发更新和许可请求）。两边之间不是 WebSocket，而是一个假 socket：服务器写下去的帧交给宿主
 * `handle`，宿主发上来的帧原样交给 `runnerMessage`，和 runner/src/index.ts 的接法一样（`ack` → `acked`）。
 *
 * 招聘 → 发一轮 → 请求推送 → 招聘人批准 → 电脑收到 allow_once → 轮次结束、看板卡关闭带改动交付物；
 * 电脑断开 → 新的一轮排队（presence 离线、排队 1）→ 重连 → 自动继续并完成。
 */

type Frame = Record<string, unknown>;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const deviceStore = createDeviceStore(database);
const quota = createQuotaService(database);
const prefix = `acp-e2e-${randomUUID()}`;
const tenants: string[] = [];
const hosts: AcpHost[] = [];
const cleanups: (() => void)[] = [];

const fixture = join(
  import.meta.dir,
  "..",
  "..",
  "runner",
  "tests",
  "fixtures",
  "fake-acp-agent.ts",
);
const scratch = mkdtempSync(join(tmpdir(), "openbot-acp-e2e-"));
const work = join(scratch, "work");
mkdirSync(work, { recursive: true });

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeAll();
  for (const cleanup of cleanups.splice(0)) cleanup();
  useDeviceAcp(null);
  await runAsTenant("platform", async () => {
    for (const tenant of tenants.splice(0)) {
      const requests = await database
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, tenant));
      if (requests.length)
        await database.delete(workItems).where(
          inArray(
            workItems.key,
            requests.map((request) => request.id),
          ),
        );
      await database
        .delete(approvalConversationGrants)
        .where(eq(approvalConversationGrants.ownerUserId, tenant));
      await database
        .delete(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, tenant));
      await runAsTenant(tenant, async () => {
        await database.delete(acpTurns).where(eq(acpTurns.tenantId, tenant));
        await database.delete(tasks).where(eq(tasks.tenantId, tenant));
        await database
          .delete(threadRunEvents)
          .where(eq(threadRunEvents.tenantId, tenant));
        await database
          .delete(threadRuns)
          .where(eq(threadRuns.tenantId, tenant));
        await database.delete(threads).where(eq(threads.tenantId, tenant));
        await database
          .delete(usageCounters)
          .where(eq(usageCounters.tenantId, tenant));
      });
      const owned = await database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.tenantId, tenant));
      for (const { id } of owned) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, id));
        await database.delete(channels).where(eq(channels.id, id));
      }
      const ownedAgents = await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, tenant));
      const ids = ownedAgents.map((row) => row.id);
      if (ids.length) {
        await database
          .delete(agentProfiles)
          .where(inArray(agentProfiles.agentId, ids));
        await database.delete(agents).where(inArray(agents.id, ids));
      }
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, tenant));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, tenant));
      await database.delete(users).where(eq(users.id, tenant));
    }
  });
});
afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await database.$client.close();
});

/** A signed-up person: a Free subscription and their 分身, as sign-up leaves them. */
async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  tenants.push(id);
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email, name: "E2E Test" }),
  );
  await provisionTenant(database, { id, email });
  return { id, role: "user" };
}

/** The person's computer, paired by them, offering one shared folder (its latest heartbeat). */
async function computer(owner: AgentActor) {
  const deviceId = `${prefix}-laptop-${randomUUID()}`;
  const id = randomUUID();
  const workdirRef = `fld_${randomBytes(16).toString("base64url")}`;
  await runAsTenant(owner.id, () =>
    database.insert(registeredDevices).values({
      id,
      tenantId: owner.id,
      deviceId,
      name: "何总的 MacBook Pro",
      tokenHash: randomUUID(),
      lastSeenAt: new Date(),
      roots: [{ ref: workdirRef, name: "web" }],
      apps: [],
      pairedByUserId: owner.id,
    }),
  );
  return { id, deviceId, workdirRef };
}

/** The routes a signed-in person reaches, framed as production frames them. */
function signedIn(actor: AgentActor) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  return guard;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  ms = 20_000,
) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const edit = (id: string, path: string, oldText: string, newText: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  kind: "edit",
  title: `Edit ${path}`,
  status: "completed",
  content: [{ type: "diff", path, oldText, newText }],
});

/** What the agent on the computer does: Codex's ask mode, then one scripted turn per prompt. */
const SCRIPT: FakeAcpScript = {
  sessionId: "sess_e2e",
  modes: {
    currentModeId: "auto",
    availableModes: [
      { id: "read-only", name: "Read only" },
      { id: "auto", name: "Auto" },
    ],
  },
  setMode: "ok",
  turns: [
    {
      steps: [
        { update: chunk("我先修登录页。") },
        { update: edit("edit-1", "src/login.ts", "a\n", "b\nc\n") },
        {
          permission: {
            toolCall: {
              toolCallId: "push-1",
              kind: "execute",
              title: "git push origin main",
              rawInput: { command: "git push origin main" },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Always", kind: "allow_always" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        },
        { update: chunk("已推送。") },
      ],
    },
    {
      steps: [
        { update: edit("edit-2", "package.json", "x\ny\n", "x\nz\n") },
        { update: chunk("依赖已升级。") },
      ],
    },
  ],
};

/** The person's computer: the runner's ACP host, with the fake agent wherever Codex would start. */
function newComputer(script: FakeAcpScript): DeviceSide {
  const log = join(scratch, `agent-${randomUUID()}.jsonl`);
  const scriptFile = join(scratch, `script-${randomUUID()}.json`);
  writeFileSync(scriptFile, JSON.stringify({ ...script, log }));
  const spawns: string[] = [];
  const host = createAcpHost({
    roots: () => work,
    apps: () => null,
    adapterDir: join(scratch, "adapters"),
    processEnv: async () => ({ ...process.env }),
    idleMs: 120_000,
    spawn: (spec, handlers, options) => {
      spawns.push(spec.sessionMode ?? "");
      return createAcpClient(
        {
          ...spec,
          command: process.execPath,
          args: [fixture],
          env: { FAKE_ACP_SCRIPT_FILE: scriptFile },
          cwd: work,
        },
        handlers,
        options,
      );
    },
  });
  hosts.push(host);
  const received = (): Frame[] => {
    try {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Frame);
    } catch {
      return [];
    }
  };
  return { host, received, spawns };
}

/** The computer's side of a deployment: kept across a server restart. */
type DeviceSide = {
  host: AcpHost;
  received: () => Frame[];
  spawns: string[];
};

/**
 * Everything production wires for external employees (index.ts), on this database, and the
 * computer: the runner's ACP host with the fake agent standing in for Codex (`computer`: a computer
 * that outlives a previous server).
 */
async function deployment(
  hirer: AgentActor,
  device: { deviceId: string },
  options: { script?: FakeAcpScript; computer?: DeviceSide } = {},
) {
  const target = { tenantId: hirer.id, deviceId: device.deviceId };
  const announced: { threadId: string; text: string; failed: boolean }[] = [];
  const channel = createDeviceChannel();
  const turns = createAcpTurnStore(database);
  const projector = createTaskProjector(database, undefined, quota);
  const runner = new PostgresAgentRunner(database, projector);
  let startAcpTurn: AcpTurnStarter | undefined;
  let bridgeLate: AcpPermissionBridge | undefined;
  // As index.ts wires it.
  const relay = createAcpRelay({
    channel,
    turns,
    startQueuedTurn: async (row) => {
      if (!startAcpTurn) throw new Error("not yet");
      await startAcpTurn(row);
    },
    adoptTurn: async (row) => {
      if (!startAcpTurn) throw new Error("not yet");
      return startAcpTurn.adopt(row);
    },
    permission: (row, frame) => {
      void bridgeLate?.onRequest(acpPermissionRequestOf(row, frame));
    },
    closed: async (turn, { followed }) => {
      await bridgeLate?.expireTurn(turn);
      if (!followed && turn.runRef)
        await projector.finished({
          tenantId: turn.tenantId,
          runRef: turn.runRef,
          failed: true,
          onlyUnsettled: true,
        });
    },
    log: () => undefined,
  });
  // index.ts `deviceOnlineElsewhere` and `deviceReachableAnywhere`.
  const onlineElsewhere = async (where: {
    tenantId: string;
    deviceId: string;
  }) =>
    (await deviceStore.list(where.tenantId)).some(
      (entry) => entry.deviceId === where.deviceId && entry.online,
    );
  const reachableAnywhere: PresenceDeviceReachable = async (where) =>
    channel.isReachable(where) || (await onlineElsewhere(where));
  useDeviceAcp({
    relay,
    turns,
    channel,
    sessions: createAcpSessionHints(),
    context: createAcpContextLoader(database),
    onlineElsewhere,
  });
  const approvals = createApprovalService(
    createApprovalStore(database, projector),
    undefined,
    undefined,
    { externalAgentHirer: createAcpApprovalHirer(database) },
  );
  const bridge = createAcpPermissionBridge({
    relay,
    turns,
    approvals: approvals.store,
    onDecided: (listener) => approvals.onDecided(listener),
    policy: (candidate) => approvals.policyOutcome(candidate),
    board: projector,
    employee: createAcpEmployeeLoader(database, deviceStore),
    log: () => undefined,
  });
  bridgeLate = bridge;
  cleanups.push(() => bridge.dispose());
  const runtime = deviceAcpRuntime();
  if (!runtime) throw new Error("no runtime");
  runtime.onPermission = (request) => {
    void bridge.onRequest(request);
  };
  startAcpTurn = createAcpTurnStarter({
    database,
    turns,
    runner,
    employeeFor: (row) => loadDeviceAcpEmployee(database, row.agentId),
    announce: async ({ threadId, text, failed }) => {
      announced.push({ threadId, text, failed });
    },
    abandoned: async (row, runRef) => {
      if (runRef)
        await projector.finished({
          tenantId: row.tenantId,
          runRef,
          failed: true,
          onlyUnsettled: true,
        });
    },
    log: () => undefined,
  });
  const routes = new Hono();
  routes.route(
    "/agents/external",
    createExternalAgentRoutes({
      database,
      profiles,
      devices: deviceStore,
      requireUser: signedIn(hirer),
      quota,
      turns,
      cancelTurn: (tenantId, turnId) => relay.cancelTurn(tenantId, turnId),
    }),
  );
  routes.route("/approvals", createApprovalRoutes(approvals, signedIn(hirer)));
  const call = (method: string, path: string, body?: unknown) =>
    routes.request(
      new Request(`http://e2e.test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      }),
    );

  // The computer: the runner's ACP host, starting the fake agent wherever it would start Codex.
  const computerSide =
    options.computer ?? newComputer(options.script ?? SCRIPT);
  const { host, received, spawns } = computerSide;

  /*
   * One runner connection. The device's credential check is not this test's (device-apps covers
   * pairing); its heartbeat writes the real `last_seen_at` every replica reads.
   */
  const socketStore = {
    ...deviceStore,
    isCurrent: async () => true,
  } as DeviceStore;
  const down: Frame[] = [];
  let socket: RunnerSocketLike | null = null;
  const socketOptions = { acp: relay };
  const connect = async () => {
    const ws: RunnerSocketLike = {
      data: {
        runner: {
          id: "registration",
          tenantId: hirer.id,
          deviceId: device.deviceId,
          credentialVersion: "v1",
        },
      },
      send: (value) => {
        const frame = JSON.parse(value) as Frame;
        if (frame.type === "ack") host.acked();
        else if (String(frame.type).startsWith("acp.")) {
          down.push(frame);
          void host.handle(frame);
        }
      },
      close: () => undefined,
    };
    await runnerOpen(ws, socketStore, channel, undefined, relay);
    socket = ws;
    host.attach((frame) => {
      if (socket !== ws) throw new Error("The runner socket is not open.");
      void runnerMessage(
        ws,
        socketStore,
        channel,
        JSON.stringify(frame),
        undefined,
        socketOptions,
      );
    });
  };
  const beat = async () => {
    const ws = socket;
    if (!ws) throw new Error("not connected");
    host.heartbeatSent();
    await runnerMessage(
      ws,
      socketStore,
      channel,
      JSON.stringify({ type: "heartbeat" }),
      undefined,
      socketOptions,
    );
  };
  const disconnect = () => {
    const ws = socket;
    socket = null;
    host.detach();
    if (ws) runnerClose(ws, channel);
  };

  /** A person's turn in their 1:1 conversation with the employee, as the runtime runs it. */
  const say = async (agentId: string, threadId: string, text: string) => {
    const employee = await runAsTenant(hirer.id, () =>
      loadDeviceAcpEmployee(database, agentId),
    );
    if (!employee) throw new Error("no employee");
    const agent = deviceAcpAgentFor(employee, { tenantId: hirer.id });
    if (!agent) throw new Error("no external employee runtime");
    const input: RunAgentInput = {
      threadId,
      runId: `${prefix}-run-${randomUUID().slice(0, 8)}`,
      messages: [{ id: `user-${randomUUID()}`, role: "user", content: text }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    agent.threadId = threadId;
    agent.setMessages(input.messages);
    const events: BaseEvent[] = [];
    const state = { done: false };
    await runAsTenant(hirer.id, async () => {
      runner.run({ threadId, agent: agent as never, input }).subscribe({
        next: (event) => events.push(event),
        complete: () => {
          state.done = true;
        },
        error: () => {
          state.done = true;
        },
      });
    });
    return { runId: input.runId, events, state };
  };

  const presence = (agentId: string): Promise<AgentPresence[]> =>
    runAsTenant(hirer.id, () =>
      readAgentPresence(database, hirer, [agentId], {
        deviceReachable: reachableAnywhere,
      }),
    );
  const card = async (runRef: string) => {
    const rows = await runAsTenant(hirer.id, () =>
      database
        .select({
          status: tasks.status,
          title: tasks.title,
          pendingApprovalId: tasks.pendingApprovalId,
          deliverableRef: tasks.deliverableRef,
        })
        .from(tasks)
        .where(eq(tasks.runRef, runRef)),
    );
    return rows;
  };
  const approvalRows = () =>
    runAsTenant(hirer.id, () =>
      database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, hirer.id),
            like(approvalRequests.toolCallId, "acp:%"),
          ),
        ),
    );
  const turnRows = (agentId: string) =>
    runAsTenant(hirer.id, () =>
      database
        .select({ turnId: acpTurns.turnId, status: acpTurns.status })
        .from(acpTurns)
        .where(eq(acpTurns.agentId, agentId)),
    );

  /** A run of this server driven directly (no thread runner), its card opened as a run's would be. */
  const sayDirect = async (agentId: string, threadId: string, text: string) => {
    const employee = await runAsTenant(hirer.id, () =>
      loadDeviceAcpEmployee(database, agentId),
    );
    if (!employee) throw new Error("no employee");
    const agent = deviceAcpAgentFor(employee, { tenantId: hirer.id });
    if (!agent) throw new Error("no external employee runtime");
    const runId = `${prefix}-run-${randomUUID().slice(0, 8)}`;
    await projector.opened({
      tenantId: hirer.id,
      title: text,
      executorAgentId: agentId,
      source: "chat",
      channelRef: threadId,
      runRef: runId,
    });
    const events: BaseEvent[] = [];
    const subscription = runAsTenant(hirer.id, () =>
      agent
        .run({
          threadId,
          runId,
          messages: [
            { id: `user-${randomUUID()}`, role: "user", content: text },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        })
        .subscribe({ next: (event) => events.push(event) }),
    );
    return { runId, events, subscription };
  };
  const threadEvents = (threadId: string) =>
    runAsTenant(hirer.id, () =>
      database
        .select({ events: threadRunEvents.event })
        .from(threadRunEvents)
        .where(eq(threadRunEvents.threadId, threadId)),
    );
  const stop = (threadId: string) =>
    runAsTenant(hirer.id, () => runner.stop({ threadId }));

  return {
    target,
    call,
    connect,
    beat,
    disconnect,
    say,
    sayDirect,
    stop,
    threadEvents,
    announced,
    computer: computerSide,
    relay,
    bridge,
    presence,
    card,
    approvalRows,
    turnRows,
    down,
    received,
    spawns,
  };
}

const texts = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => String((event as { delta?: unknown }).delta))
    .join("");

describe("an external employee, end to end", () => {
  test("hired, asks before pushing, is allowed once, delivers; queues while its computer is away and carries on when it is back", async () => {
    const hirer = await person();
    const device = await computer(hirer);
    const d = await deployment(hirer, device);

    // Hire: the hirer's own computer, its shared folder, Codex, pushes asked first.
    const hired = await d.call("POST", "/agents/external", {
      deviceId: device.deviceId,
      harness: "codex",
      name: "小码",
      workdirRef: device.workdirRef,
      rules: {
        editInside: "direct",
        touchOutside: "ask",
        runCommand: "dangerous",
        network: "ask",
        push: "ask",
      },
    });
    expect(hired.status).toBe(201);
    const agentId = ((await hired.json()) as { agent: { id: string } }).agent
      .id;

    // The computer connects and beats.
    await d.connect();
    await d.beat();
    expect(await d.presence(agentId)).toEqual([
      { agentId, status: "resting", doing: null },
    ]);

    // A turn: it reaches the computer, the agent edits a file and asks to push.
    const threadId = `${prefix}-thread-${randomUUID().slice(0, 8)}`;
    const first = await d.say(agentId, threadId, "修好登录页再推送");
    await until(
      async () => (await d.approvalRows()).length === 1,
      "the approval",
    );
    const [approval] = await d.approvalRows();
    if (!approval) throw new Error("no approval");
    expect(approval.status).toBe("pending");
    expect(approval.action.args).toEqual({ command: "git push origin main" });
    expect((approval.action.target as { acp: Frame }).acp).toMatchObject({
      employee: "小码",
      computer: "何总的 MacBook Pro",
      action: "小码想要运行命令：git push origin main",
      files: ["src/login.ts"],
    });
    // Its one card waits on the hirer.
    await until(
      async () => (await d.card(first.runId))[0]?.status === "needs_action",
      "the card to wait",
    );
    expect((await d.card(first.runId))[0]?.pendingApprovalId).toBe(approval.id);
    // Nothing is answered on the computer yet: the agent is still waiting.
    expect(
      d.down.filter((frame) => frame.type === "acp.permission.answer"),
    ).toEqual([]);

    // The hirer allows it once; the computer receives allow_once and the agent goes on.
    const decided = await d.call("POST", `/approvals/${approval.id}/decision`, {
      decision: "allow_once",
    });
    expect(decided.status).toBe(200);
    await until(() => first.state.done, "the first run to finish");
    const answers = d.down.filter(
      (frame) => frame.type === "acp.permission.answer",
    );
    expect(answers).toHaveLength(1);
    // The request the computer reported, answered with the agent's own allow_once option.
    expect(answers[0]).toMatchObject({
      agentId,
      requestId: (approval.action.target as { acp: Frame }).acp.requestId,
      optionId: "allow",
    });
    const answered = d
      .received()
      .find(
        (message) =>
          message.result !== undefined &&
          String(message.id).startsWith("fake-"),
      );
    expect(answered?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(first.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(texts(first.events)).toContain("我先修登录页。");
    expect(texts(first.events)).toContain("已推送。");
    // The card closes for review, the changed file as its deliverable.
    await until(
      async () => (await d.card(first.runId))[0]?.status === "awaiting_review",
      "the first card to close",
    );
    expect((await d.card(first.runId))[0]?.deliverableRef).toEqual({
      kind: "deliverable",
      components: [
        {
          name: "acp.diff",
          args: { files: [{ path: "src/login.ts", added: 2, removed: 1 }] },
        },
      ],
      attachments: [],
    });
    expect((await d.approvalRows())[0]?.status).toBe("approved");
    await d.beat();
    expect(await d.presence(agentId)).toEqual([
      { agentId, status: "resting", doing: null },
    ]);

    // The computer goes away, long enough that no server of the deployment still hears it.
    d.disconnect();
    await runAsTenant(hirer.id, () =>
      database
        .update(registeredDevices)
        .set({ lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 1_000) })
        .where(eq(registeredDevices.id, device.id)),
    );
    expect(await d.presence(agentId)).toEqual([
      { agentId, status: "offline", doing: null, queued: 0 },
    ]);

    // A new turn is queued, and said to be.
    const second = await d.say(agentId, threadId, "把依赖升级一下");
    await until(() => second.state.done, "the queued answer");
    expect(texts(second.events)).toBe(
      "小码的电脑现在离线，这件活已排队，电脑回来后自动继续。",
    );
    expect((await d.turnRows(agentId)).map((row) => row.status).sort()).toEqual(
      ["done", "queued"],
    );
    expect(await d.presence(agentId)).toEqual([
      { agentId, status: "offline", doing: null, queued: 1 },
    ]);
    // Its card stays open for the run that will do the work.
    expect((await d.card(second.runId))[0]?.status).toBe("running");

    // The computer comes back: its heartbeat resumes the queue, and the turn runs to the end.
    await d.connect();
    await d.beat();
    await until(
      async () => (await d.card(second.runId))[0]?.status === "awaiting_review",
      "the queued turn's card to close",
    );
    expect((await d.turnRows(agentId)).map((row) => row.status)).toEqual([
      "done",
      "done",
    ]);
    const prompts = d.down.filter((frame) => frame.type === "acp.prompt");
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1]?.content)).toContain("把依赖升级一下");
    // One card for the queued work, closed with what it changed.
    const cards = await d.card(second.runId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.deliverableRef).toEqual({
      kind: "deliverable",
      components: [
        {
          name: "acp.diff",
          args: { files: [{ path: "package.json", added: 1, removed: 1 }] },
        },
      ],
      attachments: [],
    });
    // The same adapter process, in Codex's ask mode, did both turns: it lived through the outage.
    expect(d.spawns).toEqual(["read-only"]);
    expect(
      d.received().filter((message) => message.method === "session/prompt"),
    ).toHaveLength(2);
    expect(await d.presence(agentId)).toEqual([
      { agentId, status: "resting", doing: null },
    ]);
  }, 60_000);

  /** Hires Codex on the computer, the way the hire page does. */
  const hire = async (
    d: Awaited<ReturnType<typeof deployment>>,
    device: {
      deviceId: string;
      workdirRef: string;
    },
  ) => {
    const hired = await d.call("POST", "/agents/external", {
      deviceId: device.deviceId,
      harness: "codex",
      name: "小码",
      workdirRef: device.workdirRef,
      rules: {
        editInside: "direct",
        touchOutside: "ask",
        runCommand: "dangerous",
        network: "ask",
        push: "ask",
      },
    });
    expect(hired.status).toBe(201);
    return ((await hired.json()) as { agent: { id: string } }).agent.id;
  };
  const push = {
    permission: {
      toolCall: {
        toolCallId: "push-1",
        kind: "execute",
        title: "git push origin main",
        rawInput: { command: "git push origin main" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };
  const eventTexts = (rows: { events: unknown }[]) => JSON.stringify(rows);

  test("the server restarts mid-turn: the computer replays, a run adopts the turn, the answer lands and the card closes", async () => {
    const hirer = await person();
    const device = await computer(hirer);
    const script: FakeAcpScript = {
      ...SCRIPT,
      turns: [
        {
          steps: [
            { update: chunk("我先看看代码。") },
            { sleepMs: 800 },
            { update: chunk("改好了，测试也过了。") },
          ],
        },
      ],
    };
    const before = await deployment(hirer, device, { script });
    const agentId = await hire(before, device);
    await before.connect();
    await before.beat();
    const threadId = `${prefix}-thread-${randomUUID().slice(0, 8)}`;
    const first = await before.sayDirect(agentId, threadId, "修一下登录页");
    await until(
      () => texts(first.events).includes("我先看看代码。"),
      "the first words",
    );

    // The server goes away: its socket, its run and its bridge with it. The computer keeps working.
    before.disconnect();
    first.subscription.unsubscribe();
    before.bridge.dispose();

    // A new server process, nothing in memory; the computer reconnects and replays.
    const after = await deployment(hirer, device, {
      computer: before.computer,
    });
    await after.connect();
    await after.beat();
    await until(
      async () =>
        (await after.card(first.runId))[0]?.status === "awaiting_review",
      "the card to close",
    );
    // One card for the piece of work, closed by the run that adopted the turn.
    expect(await after.card(first.runId)).toHaveLength(1);
    expect((await after.turnRows(agentId)).map((row) => row.status)).toEqual([
      "done",
    ]);
    // The whole answer reached the conversation, what was said before the restart included:
    // announced, and in the thread's stored run.
    await until(() => after.announced.length > 0, "the answer to be announced");
    expect(after.announced).toHaveLength(1);
    expect(after.announced[0]?.text).toBe("我先看看代码。改好了，测试也过了。");
    expect(after.announced[0]?.failed).toBe(false);
    await until(
      async () =>
        eventTexts(await after.threadEvents(threadId)).includes(
          "改好了，测试也过了。",
        ),
      "the run to be stored",
    );
    const stored = eventTexts(await after.threadEvents(threadId));
    expect(stored).toContain("我先看看代码。");
    expect(stored).toContain("改好了，测试也过了。");
    // Nothing was cancelled, and the turn was prompted once, by the server before the restart.
    expect(after.down.filter((frame) => frame.type === "acp.cancel")).toEqual(
      [],
    );
    expect(
      before.down.filter((frame) => frame.type === "acp.prompt"),
    ).toHaveLength(1);
    expect(after.down.filter((frame) => frame.type === "acp.prompt")).toEqual(
      [],
    );
  }, 60_000);

  test("a permission asked while the server restarts reaches its hirer, is answered, and the turn completes", async () => {
    const hirer = await person();
    const device = await computer(hirer);
    const script: FakeAcpScript = {
      ...SCRIPT,
      turns: [
        {
          steps: [
            { update: chunk("我先修登录页。") },
            { sleepMs: 500 },
            push,
            { update: chunk("已推送。") },
          ],
        },
      ],
    };
    const before = await deployment(hirer, device, { script });
    const agentId = await hire(before, device);
    await before.connect();
    await before.beat();
    const threadId = `${prefix}-thread-${randomUUID().slice(0, 8)}`;
    const first = await before.sayDirect(agentId, threadId, "修好登录页再推送");
    await until(
      () => texts(first.events).includes("我先修登录页。"),
      "the first words",
    );
    // Restart before the agent asks: the old server never sees the request.
    before.disconnect();
    first.subscription.unsubscribe();
    before.bridge.dispose();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await before.approvalRows()).toEqual([]);

    const after = await deployment(hirer, device, {
      computer: before.computer,
    });
    await after.connect();
    await after.beat();
    // The hirer gets the card, and the turn's one board card waits on it.
    await until(
      async () => (await after.approvalRows()).length === 1,
      "the approval",
    );
    const [approval] = await after.approvalRows();
    if (!approval) throw new Error("no approval");
    expect(approval.status).toBe("pending");
    expect(approval.action.args).toEqual({ command: "git push origin main" });
    await until(
      async () => (await after.card(first.runId))[0]?.status === "needs_action",
      "the card to wait",
    );
    expect((await after.card(first.runId))[0]?.pendingApprovalId).toBe(
      approval.id,
    );

    const decided = await after.call(
      "POST",
      `/approvals/${approval.id}/decision`,
      { decision: "allow_once" },
    );
    expect(decided.status).toBe(200);
    await until(
      async () =>
        (await after.card(first.runId))[0]?.status === "awaiting_review",
      "the card to close",
    );
    const answers = after.down.filter(
      (frame) => frame.type === "acp.permission.answer",
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ agentId, optionId: "allow" });
    await until(() => after.announced.length > 0, "the answer");
    expect(after.announced[0]?.text).toContain("已推送。");
    expect((await after.turnRows(agentId)).map((row) => row.status)).toEqual([
      "done",
    ]);
    expect((await after.approvalRows())[0]?.status).toBe("approved");
  }, 60_000);

  test("stopped while its computer was away: when the computer is back the turn is cancelled there, and the lane's next turn runs", async () => {
    const hirer = await person();
    const device = await computer(hirer);
    const script: FakeAcpScript = {
      ...SCRIPT,
      turns: [
        {
          steps: [
            { update: chunk("开始推送。") },
            push,
            { update: chunk("不该出现。") },
          ],
        },
        { steps: [{ update: chunk("第二件做完了。") }] },
      ],
    };
    const d = await deployment(hirer, device, { script });
    const agentId = await hire(d, device);
    await d.connect();
    await d.beat();
    const threadId = `${prefix}-thread-${randomUUID().slice(0, 8)}`;
    const first = await d.say(agentId, threadId, "推送一下");
    await until(
      async () => (await d.approvalRows()).length === 1,
      "the approval",
    );

    // The computer goes away for good (no server hears it), and the hirer presses stop.
    d.disconnect();
    await runAsTenant(hirer.id, () =>
      database
        .update(registeredDevices)
        .set({ lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 1_000) })
        .where(eq(registeredDevices.id, device.id)),
    );
    await d.stop(threadId);
    await until(() => first.state.done, "the stopped run to end");
    await until(
      async () => (await d.turnRows(agentId))[0]?.status === "cancelled",
      "the turn to be cancelled here",
    );
    // The next message in the same conversation waits for the computer.
    const second = await d.say(agentId, threadId, "再做第二件");
    await until(() => second.state.done, "the queued answer");
    expect(texts(second.events)).toContain("这件活已排队");

    // The computer is back: its inventory still has the stopped turn waiting; it is cancelled there,
    // and the lane is not held behind it.
    await d.connect();
    await d.beat();
    await until(
      async () => (await d.card(second.runId))[0]?.status === "awaiting_review",
      "the second turn's card to close",
    );
    const firstTurn = (await d.turnRows(agentId)).find(
      (row) => row.status === "cancelled",
    );
    if (!firstTurn) throw new Error("no cancelled turn");
    const cancelAt = d.down.findIndex(
      (frame) =>
        frame.type === "acp.cancel" && frame.turnId === firstTurn.turnId,
    );
    const promptAt = d.down.findIndex(
      (frame) =>
        frame.type === "acp.prompt" && frame.turnId !== firstTurn.turnId,
    );
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(promptAt).toBeGreaterThan(cancelAt);
    // The agent got session/cancel, never said what came after the permission, and did the second.
    const received = d.computer.received();
    expect(
      received.some((message) => message.method === "session/cancel"),
    ).toBe(true);
    expect(JSON.stringify(received)).not.toContain("不该出现。");
    expect((await d.turnRows(agentId)).map((row) => row.status).sort()).toEqual(
      ["cancelled", "done"],
    );
    // Its approval did not stay open.
    await d.bridge.poll();
    await until(
      async () => (await d.approvalRows())[0]?.status === "denied",
      "the approval to expire",
    );
    // Nothing was answered on the computer for it.
    expect(
      d.down.filter((frame) => frame.type === "acp.permission.answer"),
    ).toEqual([]);
  }, 60_000);

  test("the hirer cancels a queued turn: it never runs, its card closes; a running one is cancelled on the computer", async () => {
    const hirer = await person();
    const device = await computer(hirer);
    const script: FakeAcpScript = {
      ...SCRIPT,
      turns: [
        { steps: [{ update: chunk("在做。") }, { waitForCancel: true }] },
      ],
    };
    const d = await deployment(hirer, device, { script });
    const agentId = await hire(d, device);
    const threadId = `${prefix}-thread-${randomUUID().slice(0, 8)}`;

    // Queued while the computer is away.
    await runAsTenant(hirer.id, () =>
      database
        .update(registeredDevices)
        .set({ lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 1_000) })
        .where(eq(registeredDevices.id, device.id)),
    );
    const queued = await d.say(agentId, threadId, "排着的活");
    await until(() => queued.state.done, "the queued answer");
    const [row] = await d.turnRows(agentId);
    if (!row) throw new Error("no turn");
    expect(row.status).toBe("queued");
    // A turn that is not this employee's: 404.
    expect(
      (
        await d.call(
          "POST",
          `/agents/external/${agentId}/turns/no-such-turn/cancel`,
        )
      ).status,
    ).toBe(404);
    const cancelled = await d.call(
      "POST",
      `/agents/external/${agentId}/turns/${row.turnId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      turnId: row.turnId,
      status: "cancelled",
    });
    expect((await d.turnRows(agentId))[0]?.status).toBe("cancelled");
    expect((await d.card(queued.runId))[0]?.status).toBe("failed");
    // Again: already over.
    expect(
      (
        await d.call(
          "POST",
          `/agents/external/${agentId}/turns/${row.turnId}/cancel`,
        )
      ).status,
    ).toBe(409);
    // The computer comes back: nothing of it runs.
    await d.connect();
    await d.beat();
    await d.beat();
    expect(d.down.filter((frame) => frame.type === "acp.prompt")).toEqual([]);

    // A running one: cancelled on the computer, the run says so, the card closes.
    const running = await d.say(agentId, threadId, "正在做的活");
    await until(() => texts(running.events).includes("在做。"), "the work");
    const live = (await d.turnRows(agentId)).find(
      (turn) => turn.status === "running",
    );
    if (!live) throw new Error("no running turn");
    const stopped = await d.call(
      "POST",
      `/agents/external/${agentId}/turns/${live.turnId}/cancel`,
    );
    expect(stopped.status).toBe(200);
    await until(() => running.state.done, "the run to end");
    expect(texts(running.events)).toContain("这件活已取消。");
    expect(
      d.down.some(
        (frame) => frame.type === "acp.cancel" && frame.turnId === live.turnId,
      ),
    ).toBe(true);
    await until(
      () =>
        d.computer
          .received()
          .some((message) => message.method === "session/cancel"),
      "the agent to be told",
    );
    await until(
      async () =>
        (await d.card(running.runId))[0]?.status !== "running" &&
        (await d.card(running.runId))[0]?.status !== undefined,
      "the card to close",
    );
  }, 60_000);
});
