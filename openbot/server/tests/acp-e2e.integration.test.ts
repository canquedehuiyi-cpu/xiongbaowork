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
  createAcpSessionHints,
  createAcpTurnStarter,
  deviceAcpAgentFor,
  deviceAcpRuntime,
  useDeviceAcp,
} from "../src/agents/acp/agent";
import { createAcpContextLoader } from "../src/agents/acp/context";
import {
  createAcpApprovalHirer,
  createAcpEmployeeLoader,
  createAcpPermissionBridge,
} from "../src/agents/acp/permissions";
import { createAcpRelay } from "../src/agents/acp/relay";
import { createExternalAgentRoutes } from "../src/agents/acp/routes";
import { type AcpTurnRow, createAcpTurnStore } from "../src/agents/acp/turns";
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

/**
 * Everything production wires for external employees (index.ts), on this database, and the
 * computer: the runner's ACP host with the fake agent standing in for Codex.
 */
async function deployment(hirer: AgentActor, device: { deviceId: string }) {
  const target = { tenantId: hirer.id, deviceId: device.deviceId };
  const channel = createDeviceChannel();
  const turns = createAcpTurnStore(database);
  const projector = createTaskProjector(database, undefined, quota);
  const runner = new PostgresAgentRunner(database, projector);
  let startAcpTurn: ((row: AcpTurnRow) => Promise<void>) | undefined;
  const relay = createAcpRelay({
    channel,
    turns,
    startQueuedTurn: async (row) => {
      if (!startAcpTurn) throw new Error("not yet");
      await startAcpTurn(row);
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
  const log = join(scratch, `agent-${randomUUID()}.jsonl`);
  const scriptFile = join(scratch, `script-${randomUUID()}.json`);
  writeFileSync(scriptFile, JSON.stringify({ ...SCRIPT, log }));
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
  const options = { acp: relay };
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
        options,
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
      options,
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

  return {
    target,
    call,
    connect,
    beat,
    disconnect,
    say,
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
});
