import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import { createAppHost } from "../../runner/src/app-host";
import { createAppRegistry } from "../../runner/src/apps";
import { createRunnerDispatcher } from "../../runner/src/dispatch";
import { createRunnerExecutor } from "../../runner/src/execute";
import { createDiscoverActions } from "../../runner/src/discover-actions";
import { createActionJournal } from "../../runner/src/journal";
import { HOST_COMMANDS_NEVER, TOOL_DISABLED } from "../src/approvals/policy";
import type { AuditEventInput } from "../src/audit";
import {
  type ApprovalResumeDependencies,
  createApprovalService,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalAction,
  type ApprovalContinuation,
  parseApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import {
  ActionRefusedError,
  APP_CALL_BACKSTOP_MS,
  createComputerGateway,
  localAppsAllowed,
} from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import { createRunnerTransport } from "../src/computer/runner-transport";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  devicePairCodes,
  registeredDevices,
  threadRuns,
  threads,
  users,
  workItems,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceQueue, DEVICE_PAUSED } from "../src/devices/queue";
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
import { createDeviceTakeovers } from "../src/devices/takeover";
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
const DISCOVER_APPDATA = "C:\\Users\\me\\AppData\\Roaming";
const FIXTURE_SECRET_DIR = "C:\\Users\\me\\fixture-secret-dir";
const FIXTURE_SECRET = "sk-fixture-secret-value";
/** What the fixture candidate's command, arguments and env hold, none of which may leave the device. */
const FIXTURE_LEAKS = [
  FIXTURE_SECRET,
  "FIXTURE_TOKEN",
  "fixture-secret-dir",
  "fake-mcp-stdio",
  process.execPath,
];
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

async function pairedDevice(
  options: {
    hostCommandsCap?: "allow" | "ask" | "never";
    /** The gateway's clock, for the five-minute life of a device's tool list. */
    now?: () => number;
    /** False: a runner from before app discovery, which does not handle `apps.discover`. */
    discovery?: boolean;
    /** False: a runner that lists candidates but does not handle `apps.enable` yet. */
    enable?: boolean;
    /** The deployment's action policy; absent allows everything. */
    policy?: { allow: string[]; deny: string[] };
    /** The gateway's reachability check; absent, the channel's own. */
    deviceReachable?: () => boolean;
  } = {},
) {
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
  // The machine discovery reads: a Windows one, with a Claude desktop config, by injection.
  const discoveryFiles: Record<string, unknown> = {
    [`${DISCOVER_APPDATA}\\Claude\\claude_desktop_config.json`]: {
      mcpServers: {
        Figma: {
          command: "C:\\Users\\me\\tools\\figma-mcp.exe",
          args: ["--root", "C:\\Users\\me\\secret-project"],
          env: { FIGMA_TOKEN: "sk-figma-secret-value" },
        },
        // A candidate that really runs once enabled: the same fake MCP server, other arguments.
        fixture: {
          command: process.execPath,
          args: [FIXTURE, "--profile", FIXTURE_SECRET_DIR],
          env: { FIXTURE_TOKEN: FIXTURE_SECRET },
        },
      },
    },
  };
  const appHost = createAppHost(registry);
  const discoverActions =
    options.discovery === false
      ? undefined
      : createDiscoverActions({
          dataDir: join(root, "runner-data"),
          registry,
          host: appHost,
          deps: {
            // The runner's clock too, so a candidate's ten minutes run out with the gateway's.
            ...(options.now ? { now: options.now } : {}),
            platform: "win32",
            env: { APPDATA: DISCOVER_APPDATA, USERPROFILE: "C:\\Users\\me" },
            readText: (path) =>
              discoveryFiles[path] === undefined
                ? undefined
                : JSON.stringify(discoveryFiles[path]),
            readInstalled: async () =>
              [
                { DisplayName: "Notes" },
                { DisplayName: "微信" },
                { DisplayName: "Photoshop" },
              ] as never,
            resolveCommand: (command) =>
              command.endsWith(".exe") || command === process.execPath
                ? command
                : undefined,
          },
        });
  // A runner from between the two phases answers an enable the way any runner answers an action
  // it does not know.
  const discovery: typeof discoverActions =
    discoverActions && options.enable === false
      ? async (action, body, signal) =>
          action === "apps.enable"
            ? { ok: false, error: `Nothing on this machine handles "${action}".` }
            : discoverActions(action, body, signal)
      : discoverActions;
  const execute = createRunnerExecutor(
    join(root, "ws"),
    undefined,
    undefined,
    undefined,
    appHost,
    discovery ? { discovery } : undefined,
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
  let listing:
    | ((frame: Record<string, unknown>) => Record<string, unknown> | undefined)
    | undefined;
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
        // A test can answer the tool list itself: a shape of its own, or nothing at all.
        if (frame.type === "action" && frame.action === "apps.tools" && listing) {
          const answer = listing(frame);
          if (answer !== undefined && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "result", id: frame.id, ...answer }));
          return;
        }
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
  const policy = store.policy;
  if (!policy) throw new Error("The approval store has no policy surface.");
  if (options.hostCommandsCap) {
    // Only the value the gate reads is changed; the team row itself is covered elsewhere.
    const teamSettings = policy.teamSettings.bind(policy);
    policy.teamSettings = async () => ({
      ...(await teamSettings()),
      hostCommandsCap: options.hostCommandsCap as "allow" | "ask" | "never",
    });
  }
  // As index.ts composes it: the server carries out an approved action itself, on the approval row.
  const service = createApprovalService(store, undefined, undefined, {
    settlement: "database",
  });
  const takeovers = createDeviceTakeovers();
  const catalogueBot = `${tenant}-catalogue`;
  const deviceApps = async (t: { tenantId: string; deviceId: string }) =>
    (await deviceStore.list(t.tenantId)).find(
      (device) => device.deviceId === t.deviceId,
    )?.apps ?? [];
  /** The gateway's own audit rows, as `recordAuditEvent` hands them to the store. */
  const audits: AuditEventInput[] = [];
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
    deviceApps,
    // As index.ts composes them.
    deviceReachable:
      options.deviceReachable ?? ((machine) => channel.isReachable(machine)),
    rememberDeviceApp: (machine, app) =>
      deviceStore.rememberApp(machine.tenantId, machine.deviceId, app),
    auditStore: {
      insert: async (event) => {
        audits.push(event);
      },
    },
    policy: () => ({
      mode: "enforce",
      ...(options.policy ?? { allow: ["true"], deny: [] }),
    }),
    approvalGate: service.gate,
    approvalRefusal: service.refusal,
    deviceTakeovers: takeovers,
    ...(options.now ? { now: options.now } : {}),
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
  /** The approved action carried out again, as the resume worker in index.ts does. */
  function executeApproved(action: ApprovalAction) {
    const continuation = parseApprovalContinuation(action.continuation);
    const tool = tools.find(
      (candidate) => candidate.definition.name === continuation.toolName,
    );
    if (!tool) throw new Error(`No tool ${continuation.toolName}.`);
    return withApprovalContext(continuation, () =>
      tool.execute(continuation.args, {
        toolCallId: continuation.toolCallId,
        signal: new AbortController().signal,
      }),
    );
  }
  /** The person's answer carried out through the real resume path; what the Bot is told. */
  async function resume(id: string) {
    const continued: { content: string; error?: string }[] = [];
    const dependencies: ApprovalResumeDependencies = {
      validate: (action) =>
        service.validateReentry(action, () => executeApproved(action)),
      execute: executeApproved,
      continue: async (input) => {
        continued.push(input.result);
      },
    };
    await runAsTenant(tenant, () => service.resume(tenant, id, dependencies));
    return continued;
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
    resume,
    sent,
    requests,
    connect,
    disconnect,
    takeovers,
    registry,
    audits,
    /** The apps the server's device record holds for this machine now. */
    recordedApps: () => deviceApps(target),
    /** Answer `apps.tools` frames from the test (undefined: no answer); unset: the real runner. */
    answerListing: (
      answer:
        | ((frame: Record<string, unknown>) => Record<string, unknown> | undefined)
        | undefined,
    ) => {
      listing = answer;
    },
    /** The device-queue rows written for one action on this machine. */
    queuedRows: (action: string) =>
      runAsTenant(tenant, async () =>
        (
          await database
            .select({ payload: workItems.payload })
            .from(workItems)
            .where(eq(workItems.tenantId, tenant))
        ).filter(
          (row) => (row.payload as Record<string, unknown>).action === action,
        ).length,
      ),
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

test("computer_apps lists enabled, available and installed groups, and the result carries no command, path or env value", async () => {
  const device = await pairedDevice();
  const listed = (await device.call("computer_apps", {})) as {
    apps: { name: string }[];
    available?: { candidate: string; name: string; source: string; status: string }[];
    installed?: string[];
    hints?: { available: string; installed: string };
    discoveryError?: string;
  };
  expect(listed.discoveryError).toBeUndefined();
  expect(listed.apps.map((app) => app.name)).toEqual(["Notes"]);
  expect(listed.available?.map((candidate) => candidate.name)).toEqual([
    "Figma",
    "fixture",
  ]);
  expect(listed.available?.[0]).toMatchObject({
    name: "Figma",
    status: "ready",
    kind: "stdio",
  });
  expect(listed.available?.[0]?.candidate).toMatch(/^cand_/);
  // Notes is already an enabled app: it is not "installed without an app".
  expect([...(listed.installed ?? [])].sort()).toEqual(["Photoshop", "微信"].sort());
  expect(listed.hints?.available).toContain("computer_app_enable");
  expect(listed.hints?.installed).toContain("桌面操控");
  const text = JSON.stringify(listed);
  for (const secret of ["sk-figma-secret-value", "secret-project", "figma-mcp.exe", "AppData", "FIGMA_TOKEN", ...FIXTURE_LEAKS])
    expect(text).not.toContain(secret);
  expect(device.sent("apps.discover")).toHaveLength(1);
}, 20_000);

test("computer_apps with app lists that one app and sends no apps.discover frame", async () => {
  const device = await pairedDevice();
  const one = (await device.call("computer_apps", { app: "Notes" })) as {
    apps: unknown[];
    available?: unknown;
    installed?: unknown;
  };
  expect(one.apps).toHaveLength(1);
  expect(one.available).toBeUndefined();
  expect(one.installed).toBeUndefined();
  expect(device.sent("apps.discover")).toHaveLength(0);
}, 20_000);

test("a runner without discovery still lists enabled apps and says the device app needs updating", async () => {
  const device = await pairedDevice({ discovery: false });
  const listed = (await device.call("computer_apps", {})) as {
    apps: { name: string; tools?: unknown[] }[];
    available?: unknown;
    discoveryError?: string;
  };
  expect(listed.apps.map((app) => app.name)).toEqual(["Notes"]);
  expect(listed.apps[0]?.tools).toHaveLength(3);
  expect(listed.available).toBeUndefined();
  expect(listed.discoveryError).toBe(
    "主人电脑上的设备端版本较旧，更新后才能查看可启用的应用。",
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
  // The tool list was read straight off the socket: no device-queue row, no receipt.
  expect(device.sent("apps.tools")).toHaveLength(1);
  expect(await device.queuedRows("apps.tools")).toBe(0);
  expect(await device.queuedRows("apps.call")).toBe(1);
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
  ).rejects.toThrow("does not belong to a tenant with machines of its own");
  await expect(
    device.gateway.callApp(device.catalogueBot, device.actor, {
      app: "Notes",
      tool: "echo",
      args: {},
    }),
  ).rejects.toThrow("does not belong to a tenant with machines of its own");
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

test("the approval card masks secrets in an app call's arguments before cutting them", async () => {
  const device = await pairedDevice();
  const args = {
    app: "Notes",
    tool: "write_note",
    args: { note: "x", token: "tok-SECRET-123", nested: { password: "pw-SECRET-456" } },
  };
  await expect(
    device.call("computer_app_call", args, "secret-args"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const card = (
    await runAsTenant(device.tenant, () => device.service.inbox(device.tenant))
  ).requests.find((candidate) => candidate.action.toolCallId === "secret-args");
  const shown = JSON.stringify(card?.action);
  expect(shown).not.toContain("tok-SECRET-123");
  expect(shown).not.toContain("pw-SECRET-456");
  expect(String((card?.action.args as { args?: string } | undefined)?.args)).toContain(
    "[private value]",
  );
}, 20_000);

test("a queued or malformed tool list is no list: the call asks, and nothing is cached", async () => {
  for (const answer of [
    { ok: true, output: { queued: true, key: "parked" } },
    { ok: true, output: { tools: "not a list" } },
  ]) {
    const device = await pairedDevice();
    device.answerListing(() => answer);
    // Not refused as an unknown tool: the list could not be read, so the call waits for approval.
    await expect(
      device.call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "a" } }),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(device.sent("apps.call")).toHaveLength(0);
    // Nothing was cached from it: with the real list back, a read-only tool runs without asking.
    device.answerListing(undefined);
    await expect(
      device.call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "b" } }),
    ).resolves.toMatchObject({ isError: false });
    expect(device.sent("apps.tools")).toHaveLength(2);
    expect(device.sent("apps.call")).toHaveLength(1);
  }
}, 30_000);

test("with the team's cap at never, or the tool disabled, the app is never started for its list", async () => {
  const capped = await pairedDevice({ hostCommandsCap: "never" });
  await expect(
    capped.call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "x" } }),
  ).rejects.toThrow("set to never run");
  expect(capped.sent("apps.tools")).toHaveLength(0);
  expect(capped.sent("apps.call")).toHaveLength(0);
  // Refused before the list, and still on the approval decision log.
  const logged = await runAsTenant(capped.tenant, () =>
    database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, capped.tenant),
          eq(auditEvents.eventType, "approval.evaluated"),
        ),
      ),
  );
  expect(JSON.stringify(logged)).toContain("host_command_cap");

  const disabled = await pairedDevice();
  await runAsTenant(disabled.tenant, () =>
    disabled.service.createRule(disabled.tenant, {
      botId: disabled.botId,
      toolRef: "computer_app_call",
      effect: "*",
      scope: "*",
      behaviour: "deny",
    }),
  );
  await expect(
    disabled.call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "x" } }),
  ).rejects.toThrow(TOOL_DISABLED);
  expect(disabled.sent("apps.tools")).toHaveLength(0);
  expect(disabled.sent("apps.call")).toHaveLength(0);
}, 20_000);

test("while a person has taken over the machine, the app is never started for its list", async () => {
  const device = await pairedDevice();
  device.takeovers.request(device.target, device.botId, "我来操作一下");
  await expect(
    device.call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "x" } }),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  expect(device.sent("apps.tools")).toHaveLength(0);
  expect(device.sent("apps.call")).toHaveLength(0);
}, 20_000);

/**
 * Pause the device the way production does: an action was carried to the machine and its reply was
 * lost with the connection, so its outcome is unknown until the owner checks it.
 *
 * Done while the runner is away. With it connected, the channel's own flush (started on attach and
 * after every heartbeat, without being awaited) can deliver the queued action to the runner, which
 * runs it and answers, before the drain below gets to it; the action then completes, nothing is
 * uncertain, and the device is not paused. Away, no flush can reach the machine; back, every flush
 * finds the uncertain action and stops there.
 */
async function pauseWithLostReply(
  device: Awaited<ReturnType<typeof pairedDevice>>,
  key: string,
) {
  await device.disconnect();
  await device.queue.enqueue(device.target, {
    key,
    action: "exec",
    payload: { command: "true" },
  });
  await device.queue.drain(device.target, "test-owner", async () => {
    throw new Error("reply lost after the run");
  });
  expect(await device.queue.uncertain(device.target)).toBe(1);
  await device.connect();
  expect(await device.queue.uncertain(device.target)).toBe(1);
}

test("a paused device is not asked for a tool list: the call is told it is paused", async () => {
  const device = await pairedDevice();
  await pauseWithLostReply(device, "lost-reply");
  await expect(
    device.call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "x" } }),
  ).rejects.toThrow(DEVICE_PAUSED);
  expect(device.sent("apps.tools")).toHaveLength(0);
  expect(device.sent("apps.call")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("a paused device still lists the enabled apps, with a discoveryError", async () => {
  const device = await pairedDevice();
  await pauseWithLostReply(device, "lost-reply-2");
  const listed = (await device.call("computer_apps", {})) as {
    apps: { name: string; error?: string }[];
    available?: unknown;
    hints?: unknown;
    discoveryError?: string;
  };
  expect(listed.apps.map((app) => app.name)).toEqual(["Notes"]);
  expect(listed.apps[0]?.error).toContain("已暂停");
  expect(listed.discoveryError).toStartWith("这次没能查看主人电脑上的其他应用：");
  expect(listed.discoveryError).toContain("已暂停");
  expect(listed.available).toBeUndefined();
  expect(listed.hints).toBeUndefined();
  expect(device.sent("apps.discover")).toHaveLength(0);
}, 20_000);

test("a socket drop while listing tools asks instead and never pauses the device", async () => {
  const device = await pairedDevice();
  let listed: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    listed = resolve;
  });
  device.answerListing(() => {
    listed();
    return undefined;
  });
  const pending = device
    .call("computer_app_call", { app: "Notes", tool: "echo", args: { text: "x" } })
    .catch((error: unknown) => error);
  await asked;
  await device.disconnect();
  expect(await pending).toBeInstanceOf(HeadlessToolSuspension);
  expect(await device.queue.uncertain(device.target)).toBe(0);
  expect(await device.queuedRows("apps.tools")).toBe(0);
  expect(device.sent("apps.call")).toHaveLength(0);
}, 20_000);

/** The request a call opened, by its tool call id. */
async function requestFor(
  device: Awaited<ReturnType<typeof pairedDevice>>,
  toolCallId: string,
) {
  const request = (await device.requests()).find(
    (candidate) => candidate.action.toolCallId === toolCallId,
  );
  if (!request) throw new Error(`No request for ${toolCallId}.`);
  return request;
}

async function approve(
  device: Awaited<ReturnType<typeof pairedDevice>>,
  toolCallId: string,
) {
  const request = await requestFor(device, toolCallId);
  await runAsTenant(device.tenant, () =>
    device.service.decide(device.tenant, request.id, "allow_once"),
  );
  return request.id;
}

test("approved while the device was away with no tool list, the call runs once it is back", async () => {
  const device = await pairedDevice();
  await device.disconnect();
  // No list can be had: not read-only, so both ask, with no description on the card.
  for (const [toolCallId, tool, args] of [
    ["away-echo", "echo", { text: "回来了" }],
    ["away-write", "write_note", { note: "买牛奶" }],
  ] as const)
    await expect(
      device.call("computer_app_call", { app: "Notes", tool, args }, toolCallId),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const echo = await approve(device, "away-echo");
  const write = await approve(device, "away-write");
  await device.connect();
  // Now the list says echo is read-only and describes both tools: still the same actions.
  const echoed = await device.resume(echo);
  expect(echoed).toHaveLength(1);
  expect(echoed[0]?.error).toBeUndefined();
  expect(echoed[0]?.content).toContain("回来了");
  const written = await device.resume(write);
  expect(written[0]?.error).toBeUndefined();
  expect(written[0]?.content).not.toContain("Not done");
  expect(device.sent("apps.call")).toHaveLength(2);
  // Spent: a second resume runs nothing.
  await device.resume(echo);
  expect(device.sent("apps.call")).toHaveLength(2);
}, 30_000);

test("approved after the tool list expired and the device went away, the call is queued and runs on return", async () => {
  let clock = Date.now();
  const device = await pairedDevice({ now: () => clock });
  // Asked online: the list (with the tool's description) is fresh and cached.
  await expect(
    device.call(
      "computer_app_call",
      { app: "Notes", tool: "write_note", args: { note: "过期" } },
      "ttl-write",
    ),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const card = (
    await runAsTenant(device.tenant, () => device.service.inbox(device.tenant))
  ).requests.find((candidate) => candidate.action.toolCallId === "ttl-write");
  expect(
    (card?.action.args as { description?: string } | undefined)?.description,
  ).toBe("Write a note");
  // More than five minutes later, with the device away: no list, no description.
  clock += 301_000;
  await device.disconnect();
  const id = await approve(device, "ttl-write");
  const told = await device.resume(id);
  expect(told).toHaveLength(1);
  expect(told[0]?.error).toBeUndefined();
  expect(told[0]?.content).toContain("queued");
  expect(device.sent("apps.call")).toHaveLength(0);
  await device.connect();
  await poll(() => device.sent("apps.call").length === 1);
  expect(
    (device.sent("apps.call")[0]?.payload as { args?: unknown } | undefined)?.args,
  ).toEqual({ note: "过期" });
}, 30_000);

test("with the team's cap at never, listing local apps is refused before any app is started", async () => {
  const capped = await pairedDevice({ hostCommandsCap: "never" });
  await expect(capped.call("computer_apps", {})).rejects.toThrow("set to never run");
  await expect(capped.call("computer_apps", { app: "Notes" })).rejects.toThrow(
    "set to never run",
  );
  expect(capped.sent("apps.tools")).toHaveLength(0);
  expect(capped.sent("apps.discover")).toHaveLength(0);
}, 20_000);

test("only the Bot's owner may use the owner's local apps", async () => {
  const device = await pairedDevice();
  // The tools are offered only to a run whose actor is the owner, and only on a device.
  expect(localAppsAllowed({ machine: "device", owner: device.tenant, actorId: device.tenant })).toBeTrue();
  expect(localAppsAllowed({ machine: "device", owner: device.tenant, actorId: "teammate" })).toBeFalse();
  expect(localAppsAllowed({ machine: "device", owner: null, actorId: device.tenant })).toBeFalse();
  expect(localAppsAllowed({ machine: "workspace", owner: device.tenant, actorId: device.tenant })).toBeFalse();
  // And the gateway refuses anyone else, before anything reaches the machine.
  const teammate = { id: `${device.tenant}-teammate`, userId: `${device.tenant}-teammate` };
  await expect(device.gateway.listApps(device.botId, teammate, {})).rejects.toThrow(
    "只有员工的主人本人",
  );
  await expect(
    device.gateway.callApp(device.botId, teammate, {
      app: "Notes",
      tool: "echo",
      args: { text: "x" },
    }),
  ).rejects.toThrow("只有员工的主人本人");
  expect(device.sent("apps.discover")).toHaveLength(0);
  expect(device.sent("apps.tools")).toHaveLength(0);
  expect(device.sent("apps.call")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("a call's backstop outlasts a fresh connection: start, list and call", () => {
  expect(APP_CALL_BACKSTOP_MS).toBeGreaterThanOrEqual(20_000 + 20_000 + 120_000 + 5_000);
});

// --- app discovery (sub-project 3): computer_app_enable ---

/** The fixture candidate, as `computer_apps` lists it (which also leaves it in the gateway's cache). */
async function listedFixture(device: Awaited<ReturnType<typeof pairedDevice>>) {
  const listed = (await device.call("computer_apps", {})) as {
    available?: { candidate: string; name: string; source: string }[];
  };
  const fixture = listed.available?.find((candidate) => candidate.name === "fixture");
  if (!fixture) throw new Error("The fixture candidate was not listed.");
  return fixture;
}

const UNKNOWN_CANDIDATE = "cand_abc123_AAAAAAAAAAAAAAAAAAAAAA";

test("computer_app_enable asks with 允许员工使用本机应用「fixture」？来源：Claude Desktop 的配置; after approve the app is written, tested and callable at once", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  expect(fixture.source).toBe("Claude Desktop 的配置");
  const held = await device
    .call("computer_app_enable", { candidate: fixture.candidate }, "enable-me")
    .catch((error: unknown) => error);
  expect(held).toBeInstanceOf(HeadlessToolSuspension);
  expect(device.sent("apps.enable")).toHaveLength(0);
  const request = await requestFor(device, "enable-me");
  expect(request.action.policy).toMatchObject({
    behaviour: "ask",
    source: "app_enable",
    reason: "允许员工使用本机应用「fixture」？来源：Claude Desktop 的配置",
  });
  expect(request.action.scope).toBe("fixture");
  // The card names the app and where it was found; never its command.
  const card = (
    await runAsTenant(device.tenant, () => device.service.inbox(device.tenant))
  ).requests.find((candidate) => candidate.id === request.id);
  expect(card?.action.args).toEqual({
    app: "fixture",
    source: "Claude Desktop 的配置",
  });

  const id = await approve(device, "enable-me");
  const told = await device.resume(id);
  expect(told).toHaveLength(1);
  expect(told[0]?.error).toBeUndefined();
  expect(told[0]?.content).toContain("现在可以用 computer_app_call 调用「fixture」的工具了。");
  expect(device.sent("apps.enable")).toHaveLength(1);
  expect(Object.keys(device.sent("apps.enable")[0]?.payload as object)).toEqual([
    "candidate",
  ]);
  // Written on the device, and on the server's record of it without waiting for a heartbeat.
  expect(device.registry.list().map((app) => app.name)).toEqual([
    "Notes",
    "fixture",
  ]);
  expect((await device.recordedApps()).map((app) => app.name)).toEqual([
    "Notes",
    "fixture",
  ]);
  // Callable at once, on the tool list the enable already brought back.
  const toolsAsked = device.sent("apps.tools").length;
  const echoed = (await device.call("computer_app_call", {
    app: "fixture",
    tool: "echo",
    args: { text: "启用了" },
  })) as { content: { text: string }[]; isError: boolean };
  expect(echoed.content[0]?.text).toBe("启用了");
  expect(echoed.isError).toBeFalse();
  expect(device.sent("apps.tools")).toHaveLength(toolsAsked);
  // Never through the device queue.
  expect(await device.queuedRows("apps.enable")).toBe(0);
  // Already enabled now: said so, nothing asked or sent.
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }),
  ).rejects.toThrow("「fixture」已经启用了，可以直接用 computer_app_call 调用。");
  expect(device.sent("apps.enable")).toHaveLength(1);
}, 30_000);

test("an app the owner switched off on the device after it was enabled is asked about again, not called already enabled", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "enable-me"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const id = await approve(device, "enable-me");
  const told = await device.resume(id);
  expect(told[0]?.error).toBeUndefined();
  expect(device.sent("apps.enable")).toHaveLength(1);
  // The owner switches it off in the device window; the gateway's cached listing still says enabled.
  device.registry.setEnabled("fixture", false);
  const again = await device
    .call("computer_app_enable", { candidate: fixture.candidate }, "enable-again")
    .catch((error: unknown) => error);
  expect(again).toBeInstanceOf(HeadlessToolSuspension);
}, 30_000);

test("rejected: nothing is written on the device", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "deny-me"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const request = await requestFor(device, "deny-me");
  await runAsTenant(device.tenant, () =>
    device.service.decide(device.tenant, request.id, "deny"),
  );
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "deny-me"),
  ).rejects.toThrow();
  expect(device.sent("apps.enable")).toHaveLength(0);
  expect(device.registry.list().map((app) => app.name)).toEqual(["Notes"]);
  expect((await device.recordedApps()).map((app) => app.name)).toEqual(["Notes"]);
}, 20_000);

test("offline device: 设备不在线, no approval card, nothing queued", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  await device.disconnect();
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }),
  ).rejects.toThrow("设备不在线，无法启用本机应用。请等主人的电脑连上后再试。");
  expect(await device.requests()).toEqual([]);
  expect(await device.queuedRows("apps.enable")).toBe(0);
  expect(device.sent("apps.enable")).toHaveLength(0);
}, 20_000);

test("approved, then the device went away before it ran: 设备不在线, nothing queued, the device is not paused", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "away"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  await approve(device, "away");
  await device.disconnect();
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "away"),
  ).rejects.toThrow("设备不在线");
  expect(await device.queuedRows("apps.enable")).toBe(0);
  expect(await device.queue.uncertain(device.target)).toBe(0);
  expect(device.sent("apps.enable")).toHaveLength(0);
  // Back again, the person's approval still holds and the app is enabled once.
  await device.connect();
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "away"),
  ).resolves.toMatchObject({ enabled: { name: "fixture" } });
  expect(device.sent("apps.enable")).toHaveLength(1);
}, 30_000);

test("an expired or unknown candidate: 请重新查看本机应用, no card", async () => {
  let clock = Date.now();
  const device = await pairedDevice({ now: () => clock });
  // Not listed here: the device is asked about it, and knows no such candidate.
  await expect(
    device.call("computer_app_enable", { candidate: UNKNOWN_CANDIDATE }),
  ).rejects.toThrow("这个候选应用已过期或不存在，请重新查看本机应用。");
  expect(device.sent("apps.discover")).toHaveLength(1);
  expect(device.sent("apps.discover")[0]?.payload).toEqual({
    candidate: UNKNOWN_CANDIDATE,
  });
  // Listed, then more than ten minutes pass: neither the cache nor the device takes it.
  const fixture = await listedFixture(device);
  clock += 601_000;
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }),
  ).rejects.toThrow("请重新查看本机应用");
  expect(device.sent("apps.discover")).toHaveLength(3);
  expect(await device.requests()).toEqual([]);
  expect(device.sent("apps.enable")).toHaveLength(0);
}, 20_000);

test("team cap never or the tool disabled: refused before any frame reaches the device", async () => {
  const capped = await pairedDevice({ hostCommandsCap: "never" });
  await expect(
    capped.call("computer_app_enable", { candidate: UNKNOWN_CANDIDATE }),
  ).rejects.toThrow("set to never run");
  expect(capped.sent("apps.discover")).toHaveLength(0);
  expect(capped.sent("apps.enable")).toHaveLength(0);
  expect(await capped.requests()).toEqual([]);
  // Refused before any frame, and on the trail.
  expect(enableRefusals(capped)).toEqual([HOST_COMMANDS_NEVER]);

  const disabled = await pairedDevice();
  await runAsTenant(disabled.tenant, () =>
    disabled.service.createRule(disabled.tenant, {
      botId: disabled.botId,
      toolRef: "computer_app_enable",
      effect: "*",
      scope: "*",
      behaviour: "deny",
    }),
  );
  await expect(
    disabled.call("computer_app_enable", { candidate: UNKNOWN_CANDIDATE }),
  ).rejects.toThrow(TOOL_DISABLED);
  expect(disabled.sent("apps.discover")).toHaveLength(0);
  expect(disabled.sent("apps.enable")).toHaveLength(0);
  expect(await disabled.requests()).toEqual([]);
  expect(enableRefusals(disabled)).toEqual([TOOL_DISABLED]);
}, 20_000);

/** The reasons on the refused rows `computer_app_enable` wrote. */
function enableRefusals(device: Awaited<ReturnType<typeof pairedDevice>>) {
  return device.audits
    .filter(
      (row) =>
        row.eventType === "computer.action_refused" &&
        (row.payload as { action?: string }).action === "computer_app_enable",
    )
    .map((row) => (row.payload as { refusal?: string }).refusal);
}

test("a deny rule on the app's name refuses a listed candidate before anything is sent, on the trail with its name and source", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  await runAsTenant(device.tenant, () =>
    device.service.createRule(device.tenant, {
      botId: device.botId,
      toolRef: "computer_app_enable",
      effect: "*",
      scope: "fixture",
      behaviour: "deny",
    }),
  );
  const discovered = device.sent("apps.discover").length;
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }),
  ).rejects.toThrow(TOOL_DISABLED);
  expect(device.sent("apps.discover")).toHaveLength(discovered);
  expect(device.sent("apps.enable")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
  expect(enableRefusals(device)).toEqual([TOOL_DISABLED]);
  const refused = device.audits.find(
    (row) =>
      row.eventType === "computer.action_refused" &&
      (row.payload as { action?: string }).action === "computer_app_enable",
  );
  expect((refused?.payload as { app?: unknown } | undefined)?.app).toEqual({
    name: "fixture",
    source: "Claude Desktop 的配置",
  });
  // Decided by the app's name, as the card and the gate name it; never by the candidate reference.
  const evaluated = await runAsTenant(device.tenant, () =>
    database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, device.tenant)),
  );
  const scopes = evaluated
    .map((row) => row.payload as { tool?: string; scope?: string })
    .filter((payload) => payload.tool === "computer_app_enable")
    .map((payload) => payload.scope);
  expect(scopes).toEqual(["fixture"]);
}, 20_000);

test("a teammate cannot enable the owner's apps", async () => {
  const device = await pairedDevice();
  const teammate = { id: `${device.tenant}-teammate`, userId: `${device.tenant}-teammate` };
  await expect(
    device.gateway.enableApp(device.botId, teammate, {
      candidate: UNKNOWN_CANDIDATE,
    }),
  ).rejects.toThrow("只有员工的主人本人");
  expect(device.sent("apps.discover")).toHaveLength(0);
  expect(device.sent("apps.enable")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("the enable's audit rows carry the app name and source and no command, path or env value", async () => {
  const device = await pairedDevice();
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "audited"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  await device.resume(await approve(device, "audited"));
  expect(device.sent("apps.enable")).toHaveLength(1);
  const rows = device.audits.filter(
    (row) => (row.payload as { action?: string }).action === "computer_app_enable",
  );
  // Asked once, then carried out on the approval.
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows)
    expect((row.payload as { app?: unknown }).app).toEqual({
      name: "fixture",
      source: "Claude Desktop 的配置",
    });
  expect(rows.map((row) => row.eventType)).not.toContain("computer.action_failed");
  // Nor does anything the approval wrote: the request, its card or the decision log.
  const decisions = await runAsTenant(device.tenant, () =>
    database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, device.tenant)),
  );
  const written = JSON.stringify([
    rows,
    decisions,
    await device.requests(),
    await runAsTenant(device.tenant, () => device.service.inbox(device.tenant)),
  ]);
  expect(written).toContain("fixture");
  for (const leak of FIXTURE_LEAKS) expect(written).not.toContain(leak);
}, 30_000);

test("a deployment rule about intent does not refuse an enable: it still reaches the card", async () => {
  // The documented "no shell" rule: it names `intent`, which an enable must have bound.
  const device = await pairedDevice({
    policy: { allow: ["true"], deny: ['intent == "run_command"'] },
  });
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "intent"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  expect((await requestFor(device, "intent")).action.policy?.source).toBe(
    "app_enable",
  );
  expect(
    device.audits.map((row) => row.eventType),
  ).not.toContain("computer.action_refused");
}, 20_000);

test("approved, then the device went away while it was being sent: 设备不在线, nothing queued, the device is not paused", async () => {
  // The gateway's own check still says reachable: only the send finds the machine gone.
  const device = await pairedDevice({ deviceReachable: () => true });
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "sent-away"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  await approve(device, "sent-away");
  await device.disconnect();
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "sent-away"),
  ).rejects.toThrow("设备不在线，无法启用本机应用。请等主人的电脑连上后再试。");
  expect(await device.queuedRows("apps.enable")).toBe(0);
  expect(await device.queue.uncertain(device.target)).toBe(0);
  expect(device.sent("apps.enable")).toHaveLength(0);
}, 20_000);

test("a runner that lists candidates but cannot enable them says the device app needs updating, in Chinese", async () => {
  const device = await pairedDevice({ enable: false });
  const fixture = await listedFixture(device);
  await expect(
    device.call("computer_app_enable", { candidate: fixture.candidate }, "old"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const id = await approve(device, "old");
  const told = await device.resume(id);
  expect(JSON.stringify(told)).toContain(
    "主人电脑上的设备端版本较旧，更新后才能启用本机应用。",
  );
  expect(JSON.stringify(told)).not.toContain("Nothing on this machine handles");
  expect(device.sent("apps.enable")).toHaveLength(1);
  expect(device.registry.list().map((app) => app.name)).toEqual(["Notes"]);
  expect(await device.queue.uncertain(device.target)).toBe(0);
}, 20_000);
// --- end app discovery ---

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
