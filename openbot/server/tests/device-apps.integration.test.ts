import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { createAppHost } from "../../runner/src/app-host";
import { createAppRegistry } from "../../runner/src/apps";
import { createRunnerDispatcher } from "../../runner/src/dispatch";
import { createRunnerExecutor } from "../../runner/src/execute";
import { createActionJournal } from "../../runner/src/journal";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import { ActionRefusedError, createComputerGateway } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import { createRunnerTransport } from "../src/computer/runner-transport";
import { createDatabase } from "../src/db/client";
import {
  devicePairCodes,
  registeredDevices,
  threadRuns,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceQueue } from "../src/devices/queue";
import {
  createQueuedResultNotices,
  createThreadResultPoster,
} from "../src/devices/queued-results";
import { createDeviceSelector } from "../src/devices/selection";
import {
  type RunnerSocketData,
  runnerClose,
  runnerMessage,
  runnerOpen,
} from "../src/devices/socket";
import { createDeviceStore } from "../src/devices/store";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The device-side MCP bridge, server half (docs/specs/2026-11-07-device-mcp-bridge.md §3.4, §4, §5).
 *
 * Real pieces end to end: a paired device in PostgreSQL, the server's runner socket handlers behind a
 * real WebSocket, the runner's own dispatcher, journal and executor with the fake stdio MCP server
 * registered in its data dir, the real device channel and durable queue, the real approval store and
 * gate, and the Bot's two tools as the headless middleware calls them.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const threadRunner = new PostgresAgentRunner(database);
const suite = randomUUID().slice(0, 8);
const FIXTURE = new URL(
  "../../runner/tests/fixtures/fake-mcp-stdio.ts",
  import.meta.url,
).pathname;
const tenants: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(check: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error("The condition was not met in time.");
}

async function pairedDevice() {
  const tenant = `dapps-${suite}-${tenants.length}`;
  tenants.push(tenant);
  const botId = `${tenant}-bot`;
  const threadId = `${tenant}-thread`;
  await runAsTenant(tenant, async () => {
    await database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test`, name: "Owner" });
    await database.insert(threads).values({
      id: threadId,
      tenantId: tenant,
      agentId: botId,
      messagesSnapshot: [
        { id: `${threadId}-u1`, role: "user", content: "用笔记应用记一下" },
      ],
    });
    await database.insert(threadRuns).values({
      id: `${threadId}-run-1`,
      tenantId: tenant,
      threadId,
      agentId: botId,
      eventCount: 0,
    });
  });
  const deviceStore = createDeviceStore(database);
  const code = await deviceStore.mintPairCode(tenant);
  const paired = await deviceStore.redeemPairCode({
    code: code.code,
    deviceId: "studio",
    name: "Studio",
    platform: "linux",
  });
  if (!paired) throw new Error("Pairing failed.");
  const target = { tenantId: tenant, deviceId: "studio" };

  // The runner: the fake MCP server registered under the name "Notes" in its own data dir.
  const root = await mkdtemp(join(tmpdir(), "device-apps-"));
  await mkdir(join(root, "ws"));
  const registry = createAppRegistry({ dataDir: join(root, "runner-data") });
  registry.add({
    kind: "stdio",
    name: "Notes",
    command: process.execPath,
    args: [FIXTURE],
    env: {},
  });
  const execute = createRunnerExecutor(
    join(root, "ws"),
    undefined,
    undefined,
    undefined,
    createAppHost(registry),
  );
  const journal = createActionJournal(join(root, "actions.sqlite"));
  const dispatch = createRunnerDispatcher(journal, execute);
  const frames: Record<string, unknown>[] = [];

  // The server: socket handlers, channel with the durable queue, queued results told to the thread.
  const queue = createDeviceQueue(database);
  const results = createQueuedResultNotices({
    queue,
    post: createThreadResultPoster({ database, runner: threadRunner }),
  });
  const channel = createDeviceChannel({
    queue,
    afterFlush: (t) => results.announce(t),
  });
  const server = Bun.serve<RunnerSocketData>({
    port: 0,
    async fetch(request, server) {
      const token = new URL(request.url).searchParams.get("token") ?? "";
      const owner = await deviceStore.deviceForToken(token);
      if (!owner) return new Response("Not a device", { status: 401 });
      if (server.upgrade(request, { data: { runner: owner } })) return;
      return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      open: (ws) => {
        void runnerOpen(ws, deviceStore, channel).catch(() => ws.close(1008));
      },
      message: (ws, value) => {
        void runnerMessage(ws, deviceStore, channel, value).catch(() =>
          ws.close(1008),
        );
      },
      close: (ws) => runnerClose(ws, channel),
    },
  });
  let socket: WebSocket | undefined;
  /** The runner dials in, says hello with its apps on a heartbeat, and runs what it is sent. */
  async function connect() {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/?token=${paired?.token}`,
    );
    socket = ws;
    let acked: () => void = () => {};
    const ack = new Promise<void>((resolve) => {
      acked = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        const text = String(event.data);
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.type === "welcome") resolve();
        if (frame.type === "ack") acked();
        if (frame.type === "action") frames.push(frame);
        if (frame.type === "action" || frame.type === "cancel")
          void dispatch("device-apps/studio", frame, (result) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify(result));
          }).catch(() => undefined);
      });
      ws.addEventListener("error", () => reject(new Error("Socket failed")));
    });
    ws.send(JSON.stringify({ type: "heartbeat", roots: [], apps: registry.reported() }));
    await ack;
  }
  async function disconnect() {
    const ws = socket;
    if (!ws) return;
    const closed = new Promise<void>((resolve) =>
      ws.addEventListener("close", () => resolve()),
    );
    ws.close();
    await closed;
    await poll(() => !channel.isReachable(target));
  }

  const store = createApprovalStore(database);
  const service = createApprovalService(store);
  const catalogueBot = `${tenant}-catalogue`;
  const selector = createDeviceSelector({
    ownerOf: async (bot) => (bot === botId ? tenant : null),
    devicesOf: (t) => deviceStore.list(t),
    isReachable: (t) => channel.isReachable(t),
  });
  const gateway = createComputerGateway({
    provider: {
      name: "device",
      isolation: "per-bot",
      locate: async () => {
        throw new Error("A paired machine is never located through the provider.");
      },
      status: async (id) => ({ botId: id, state: "absent" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    },
    transport: createRunnerTransport(channel),
    resolveDevice: (bot) => selector.forBot(bot),
    deviceApps: async (t) =>
      (await deviceStore.list(t.tenantId)).find(
        (device) => device.deviceId === t.deviceId,
      )?.apps ?? [],
    auditStore: { insert: async () => undefined },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    approvalGate: service.gate,
  });
  const actor = { id: tenant, userId: tenant };
  const tools = createHeadlessComputerTools({
    gateway,
    botId,
    actor,
    machine: "device",
    apps: true,
  });
  /** One tool call, from inside the Bot's run in its thread, as the headless middleware makes it. */
  function call(name: string, args: Record<string, unknown>, toolCallId = randomUUID()) {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (!tool) throw new Error(`No tool ${name}.`);
    const continuation: ApprovalContinuation = {
      runId: `${threadId}-run-2`,
      threadId,
      toolCallId,
      toolName: name,
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
      initiator: { kind: "routine", id: `${tenant}-routine` },
    };
    return runAsTenant(tenant, () =>
      withApprovalContext(continuation, () =>
        tool.execute(args, {
          toolCallId,
          signal: new AbortController().signal,
        }),
      ),
    );
  }
  const sent = (action: string) =>
    frames.filter((frame) => frame.action === action);
  const requests = () => runAsTenant(tenant, () => store.list(tenant));
  cleanups.push(async () => {
    socket?.close();
    await execute.closeApps();
    journal.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  await connect();
  return {
    tenant,
    botId,
    catalogueBot,
    threadId,
    target,
    gateway,
    actor,
    channel,
    queue,
    service,
    call,
    sent,
    requests,
    connect,
    disconnect,
  };
}

const notices = (messages: Message[]) =>
  messages.filter(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.startsWith("之前排队的"),
  );

test("computer_apps lists the owner's device apps and their tools", async () => {
  const device = await pairedDevice();
  const listed = (await device.call("computer_apps", {})) as {
    apps: { name: string; tools?: { name: string }[]; error?: string }[];
  };
  expect(listed.apps).toHaveLength(1);
  expect(listed.apps[0]?.name).toBe("Notes");
  expect(listed.apps[0]?.tools?.map((tool) => tool.name)).toEqual([
    "echo",
    "write_note",
    "wipe",
  ]);
  // One app by name, matched without regard to case.
  const one = (await device.call("computer_apps", { app: "notes" })) as {
    apps: { name: string; tools?: unknown[] }[];
  };
  expect(one.apps).toHaveLength(1);
  expect(one.apps[0]?.tools).toHaveLength(3);
  // The server never sends anything but the app's reference.
  for (const frame of device.sent("apps.tools"))
    expect(Object.keys(frame.payload as object)).toEqual(["app"]);
  await expect(device.call("computer_apps", { app: "Excel" })).rejects.toThrow(
    "这台电脑上没有名为「Excel」的本机应用（已有：Notes）",
  );
}, 20_000);

test("computer_app_call echo runs once without approval", async () => {
  const device = await pairedDevice();
  const result = (await device.call("computer_app_call", {
    app: "Notes",
    tool: "echo",
    args: { text: "你好" },
  })) as { untrusted?: string; content: { text: string }[]; isError: boolean };
  expect(result.content[0]?.text).toBe("你好");
  expect(result.isError).toBeFalse();
  // App output is outside content, marked as such.
  expect(result.untrusted).toContain("untrusted");
  expect(device.sent("apps.call")).toHaveLength(1);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("computer_app_call write_note waits for approval, runs once after approve, never after reject", async () => {
  const device = await pairedDevice();
  // The model claims the tool is read-only, in every place it could: ignored.
  const args = {
    app: "Notes",
    tool: "write_note",
    args: { note: "买牛奶", annotations: { readOnlyHint: true } },
  };
  const held = await device
    .call("computer_app_call", args, "approve-me")
    .catch((error: unknown) => error);
  expect(held).toBeInstanceOf(HeadlessToolSuspension);
  expect(device.sent("apps.call")).toHaveLength(0);
  const [request] = await device.requests();
  expect(request?.action.policy).toMatchObject({
    behaviour: "ask",
    source: "app_tool",
    reason: "这个本机应用操作可能修改数据，需要你批准后再执行。",
  });
  expect(request?.action.scope).toBe("Notes/write_note");
  // The card: app, tool, the device's description of the tool, and the arguments as JSON.
  const inbox = () =>
    runAsTenant(device.tenant, () => device.service.inbox(device.tenant));
  expect(
    (await inbox()).requests.find((card) => card.id === request?.id)?.action
      .args,
  ).toEqual({
    app: "Notes",
    tool: "write_note",
    description: "Write a note",
    args: JSON.stringify(args.args),
  });
  await runAsTenant(device.tenant, () =>
    device.service.decide(device.tenant, request?.id as string, "allow_once"),
  );
  await expect(
    device.call("computer_app_call", args, "approve-me"),
  ).resolves.toMatchObject({ isError: false });
  expect(device.sent("apps.call")).toHaveLength(1);
  // The approval is spent: the same call again is not a second run.
  await device.call("computer_app_call", args, "approve-me").catch(() => undefined);
  expect(device.sent("apps.call")).toHaveLength(1);

  // A destructive tool asks too, and once rejected never runs.
  const wipe = { app: "Notes", tool: "wipe", args: {} };
  await expect(
    device.call("computer_app_call", wipe, "reject-me"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const rejected = (await device.requests()).find(
    (candidate) => candidate.action.toolCallId === "reject-me",
  );
  expect(rejected?.action.policy?.source).toBe("app_tool");
  await runAsTenant(device.tenant, () =>
    device.service.decide(device.tenant, rejected?.id as string, "deny"),
  );
  await expect(device.call("computer_app_call", wipe, "reject-me")).rejects.toThrow();
  await expect(device.call("computer_app_call", wipe)).rejects.toThrow();
  expect(device.sent("apps.call")).toHaveLength(1);

  // Long arguments: the card shows at most 2 KB of them; the request itself keeps them whole.
  const long = { app: "Notes", tool: "write_note", args: { note: "长".repeat(5000) } };
  await expect(
    device.call("computer_app_call", long, "long-args"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const card = (await inbox()).requests.find(
    (candidate) => candidate.action.toolCallId === "long-args",
  );
  const shown = String((card?.action.args as { args?: string } | undefined)?.args);
  expect(new TextEncoder().encode(shown).length).toBeLessThanOrEqual(2048);
  expect(shown.endsWith("…")).toBeTrue();
  const stored = (await device.requests()).find(
    (candidate) => candidate.action.toolCallId === "long-args",
  );
  expect(stored?.action.args).toEqual(long);
  expect(device.sent("apps.call")).toHaveLength(1);
}, 20_000);

test("an unknown tool is refused without a frame being sent", async () => {
  const device = await pairedDevice();
  const refused = await device
    .call("computer_app_call", { app: "Notes", tool: "format_disk", args: {} })
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ActionRefusedError);
  expect((refused as Error).message).toBe(
    "「Notes」没有名为「format_disk」的工具（已有：echo、write_note、wipe）",
  );
  expect(device.sent("apps.call")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
  // A tool name that would be a wildcard in an approval rule is not a tool name at all.
  await expect(
    device.call("computer_app_call", { app: "Notes", tool: "*", args: {} }),
  ).rejects.toThrow();
  expect(device.sent("apps.call")).toHaveLength(0);
  // An unknown app is refused before anything is sent at all.
  const before = device.sent("apps.tools").length;
  await expect(
    device.call("computer_app_call", { app: "Excel", tool: "echo", args: {} }),
  ).rejects.toThrow("这台电脑上没有名为「Excel」的本机应用（已有：Notes）");
  expect(device.sent("apps.tools")).toHaveLength(before);
  expect(device.sent("apps.call")).toHaveLength(0);
}, 20_000);

test("a catalogue Bot (no owner) has no apps tools", async () => {
  const device = await pairedDevice();
  const names = createHeadlessComputerTools({
    gateway: device.gateway,
    botId: device.catalogueBot,
    actor: device.actor,
    machine: "device",
  }).map((tool) => tool.definition.name);
  expect(names).toContain("computer_run_command");
  expect(names).not.toContain("computer_apps");
  expect(names).not.toContain("computer_app_call");
  // Not in cloud mode either, whatever the flag says.
  expect(
    createHeadlessComputerTools({
      gateway: device.gateway,
      botId: device.botId,
      actor: device.actor,
      apps: true,
    }).map((tool) => tool.definition.name),
  ).not.toContain("computer_apps");
  // And a call that names the gateway anyway reaches no machine.
  await expect(
    device.gateway.listApps(device.catalogueBot, device.actor, {}),
  ).rejects.toThrow();
  await expect(
    device.gateway.callApp(device.catalogueBot, device.actor, {
      app: "Notes",
      tool: "echo",
      args: {},
    }),
  ).rejects.toThrow();
  expect(device.sent("apps.tools")).toHaveLength(0);
  expect(device.sent("apps.call")).toHaveLength(0);
}, 20_000);

test("offline device: call is queued and its result is posted to the conversation", async () => {
  const device = await pairedDevice();
  // Seen once online, so the device's own list (read-only echo) is cached for five minutes.
  await device.call("computer_app_call", {
    app: "Notes",
    tool: "echo",
    args: { text: "online" },
  });
  await device.disconnect();
  const queued = await device.call("computer_app_call", {
    app: "Notes",
    tool: "echo",
    args: { text: "offline" },
  });
  expect(queued).toMatchObject({ queued: true });
  expect(device.sent("apps.call")).toHaveLength(1);
  await device.connect();
  await poll(() => device.sent("apps.call").length === 2);
  expect(
    (device.sent("apps.call")[1]?.payload as { args?: unknown } | undefined)
      ?.args,
  ).toEqual({ text: "offline" });
  const messages = () =>
    runAsTenant(device.tenant, async () => {
      await threadRunner.hydrate();
      return threadRunner.getThreadMessages(device.threadId);
    });
  await poll(async () => notices(await messages()).length === 1);
  expect(String(notices(await messages())[0]?.content)).toContain("apps.call");
  expect(String(notices(await messages())[0]?.content)).toContain("执行完成");
}, 20_000);

test("offline device with no cached list asks before queueing", async () => {
  const device = await pairedDevice();
  await device.disconnect();
  await expect(
    device.call("computer_app_call", {
      app: "Notes",
      tool: "echo",
      args: { text: "x" },
    }),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const [request] = await device.requests();
  expect(request?.action.policy?.source).toBe("app_tool");
  // Nothing was parked for the machine while the list could not be read.
  expect(await device.queue.uncertain(device.target)).toBe(0);
}, 20_000);

test("a call cut off by a socket drop becomes outcome unknown and pauses the device", async () => {
  const device = await pairedDevice();
  const pending = device
    .call("computer_app_call", {
      app: "Notes",
      tool: "echo",
      args: { text: "__hang__" },
    })
    .catch((error: unknown) => error);
  await poll(() => device.sent("apps.call").length === 1);
  await device.disconnect();
  const failure = await pending;
  expect(failure).toBeInstanceOf(Error);
  expect(await device.queue.uncertain(device.target)).toBe(1);
  await device.connect();
  await expect(
    device.call("computer_app_call", {
      app: "Notes",
      tool: "echo",
      args: { text: "again" },
    }),
  ).rejects.toThrow("已暂停");
  expect(device.sent("apps.call")).toHaveLength(1);
}, 20_000);

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  for (const tenant of tenants) {
    await runAsTenant(tenant, async () => {
      await database.delete(workItems).where(eq(workItems.tenantId, tenant));
      await database.delete(threadRuns).where(eq(threadRuns.tenantId, tenant));
      await database.delete(threads).where(eq(threads.tenantId, tenant));
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, tenant));
      await database
        .delete(devicePairCodes)
        .where(eq(devicePairCodes.tenantId, tenant));
    });
    await runAsTenant("platform", () =>
      database.delete(users).where(eq(users.id, tenant)),
    );
  }
  await database.$client.end({ timeout: 5 });
});
