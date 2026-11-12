import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDesktopActions } from "../../runner/src/desktop/actions";
import { createAgentDesktopCli } from "../../runner/src/desktop/agent-desktop";
import {
  CONTROL_LINE_PREFIX,
  createControlChannel,
} from "../../runner/src/desktop/control";
import { createDesktopSessions } from "../../runner/src/desktop/session";
import { createRunnerDispatcher } from "../../runner/src/dispatch";
import { createRunnerExecutor } from "../../runner/src/execute";
import { createActionJournal } from "../../runner/src/journal";
import { DESKTOP_LIMITS, desktopMessage } from "../../shared/desktop-control";
import { DESKTOP_WRITE_TOOLS } from "../src/approvals/desktop-policy";
import { TOOL_DISABLED } from "../src/approvals/policy";
import {
  createApprovalService,
  DECLINED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalContinuation,
  ApprovalRefusedError,
  withApprovalContext,
} from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import {
  DESKTOP_CLICK_DESCRIPTION,
  DESKTOP_FOCUS_DESCRIPTION,
  DESKTOP_KEY_DESCRIPTION,
  DESKTOP_SNAPSHOT_DESCRIPTION,
  DESKTOP_TYPE_DESCRIPTION,
} from "../src/computer/desktop-tools";
import {
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
  users,
  workItems,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceQueue } from "../src/devices/queue";
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
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Operating the Bot owner's desktop (desktop control phase 2, plan Task 23): the four write tools end
 * to end.
 *
 * Real pieces throughout: a paired device in PostgreSQL, the server's runner socket handlers behind a
 * real WebSocket (heartbeats included, so a stop on the device reaches the gateway), the runner's own
 * dispatcher, journal and executor with the desktop actions on agent-desktop driving the fake CLI,
 * the runner's real session and control channel (its far end answers as the device app does: the
 * banner is up, the mouse check is paused), the real approval store and gate, and the tools as the
 * headless middleware calls them.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const FAKE_AD = new URL(
  "../../runner/tests/fixtures/fake-agent-desktop.ts",
  import.meta.url,
).pathname;
const SAMPLES = new URL(
  "../../runner/tests/fixtures/agent-desktop/",
  import.meta.url,
).pathname;
const WRITE_TOOLS = [
  "computer_desktop_click",
  "computer_desktop_type",
  "computer_desktop_key",
  "computer_desktop_focus",
];
/** agent-desktop's commands that act on the screen. */
const AD_WRITES: ReadonlySet<string> = new Set([
  "click",
  "type",
  "set-value",
  "clear",
  "press",
  "focus-window",
]);
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

/** An in-memory stdin for the control channel: lines pushed here reach it in order. */
function lineQueue() {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const lines: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length > 0) yield pending.shift() as string;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  const poke = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  return {
    lines,
    push(line: string) {
      pending.push(line);
      poke();
    },
    close() {
      closed = true;
      poke();
    },
  };
}

/** A name whose action word lies past the characters a snapshot shows (`nameMax`). */
const LONG_NAME = `${"x".repeat(DESKTOP_LIMITS.nameMax + 10)} 发送`;

/**
 * The macOS form sample, its Send button named 发送: one plain control and one sensitive one. Its
 * disabled button gets `LONG_NAME`, which only the device reads whole.
 */
function macForm(): unknown {
  const samples = JSON.parse(readFileSync(join(SAMPLES, "macos.json"), "utf8"));
  const data = structuredClone(samples["snapshot-password"].data);
  data.tree.children[4].name = "发送";
  data.tree.children[3].name = LONG_NAME;
  return { version: "2.6", ok: true, command: "snapshot", data };
}

async function pairedDevice(options: { platform?: "darwin" | "linux" } = {}) {
  const platform = options.platform ?? "darwin";
  const tenant = `dwrite-${suite}-${tenants.length}`;
  tenants.push(tenant);
  const botId = `${tenant}-bot`;
  const threadId = `${tenant}-thread`;
  await runAsTenant(tenant, () =>
    database
      .insert(users)
      .values({ id: tenant, email: `${tenant}@example.test`, name: "Owner" }),
  );
  const deviceStore = createDeviceStore(database);
  const code = await deviceStore.mintPairCode(tenant);
  const paired = await deviceStore.redeemPairCode({
    code: code.code,
    deviceId: "studio",
    name: "Studio",
    platform,
  });
  if (!paired) throw new Error("Pairing failed.");
  const target = { tenantId: tenant, deviceId: "studio" };

  // The runner: agent-desktop is the fake CLI, which logs every command it is started with.
  const root = mkdtempSync(join(tmpdir(), "desktop-write-tools-"));
  const log = join(root, "ad.log");
  writeFileSync(log, "");
  const script = {
    platform: platform === "darwin" ? "macos" : "linux",
    commands: {
      "list-windows": { sample: "list-windows" },
      permissions: { sample: "permissions" },
      ...(platform === "darwin"
        ? { snapshot: { envelope: macForm() } }
        : { snapshot: { sample: "snapshot-password" } }),
    },
  };
  const spawn = ((cmd: string[], opts: { env?: Record<string, string> }) =>
    Bun.spawn(["bun", FAKE_AD, ...cmd.slice(1)], {
      ...opts,
      env: {
        ...opts.env,
        FAKE_AD_SCRIPT: JSON.stringify(script),
        FAKE_AD_LOG: log,
      },
    } as never)) as unknown as typeof Bun.spawn;
  const cli = createAgentDesktopCli({
    binary: "agent-desktop",
    stateDir: join(root, "state"),
    spawn,
  });
  // The device app's end of the control channel: its banner comes up, its mouse check pauses.
  const stdin = lineQueue();
  const control = createControlChannel({
    lines: stdin.lines,
    write: (line) => {
      if (!line.startsWith(CONTROL_LINE_PREFIX)) return;
      const event = JSON.parse(line.slice(CONTROL_LINE_PREFIX.length));
      if (event.event === "session-started")
        stdin.push(
          JSON.stringify({ control: "session-ready", label: event.label }),
        );
      if (event.event === "headed-begin")
        stdin.push(JSON.stringify({ control: "headed-ack", seq: event.seq }));
    },
  });
  const sessions = createDesktopSessions({ control });
  const desktop = createDesktopActions({
    platform,
    engine: "agent-desktop",
    cli,
    control,
    sessions,
  });
  const execute = createRunnerExecutor(
    join(root, "ws"),
    undefined,
    undefined,
    undefined,
    undefined,
    { desktop },
  );
  const journal = createActionJournal(join(root, "actions.sqlite"));
  const dispatch = createRunnerDispatcher(journal, execute);
  const frames: Record<string, unknown>[] = [];
  /** Runs before an action frame is handed to the runner: a stop that lands just ahead of it. */
  let beforeAction:
    | ((frame: Record<string, unknown>) => Promise<void>)
    | undefined;

  // The server: socket handlers (a heartbeat's stop goes to the gateway) and the channel.
  const queue = createDeviceQueue(database);
  const channel = createDeviceChannel({ queue });
  const store = createApprovalStore(database);
  const service = createApprovalService(store, undefined, undefined, {
    settlement: "database",
  });
  const auditStore = createAuditStore(database);
  const catalogueBot = `${tenant}-catalogue`;
  const selector = createDeviceSelector({
    ownerOf: async (bot) => (bot === botId ? tenant : null),
    devicesOf: (t) => deviceStore.list(t),
    isReachable: (t) => channel.isReachable(t),
  });
  const gateway = createComputerGateway({
    provider: {
      name: "device",
      isolation: "per-person",
      locate: async () => {
        throw new Error(
          "A paired machine is never located through the provider.",
        );
      },
      status: async (seat) => ({ botId: seat.botId, state: "absent" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    },
    transport: createRunnerTransport(channel),
    resolveDevice: (bot) => selector.forBot(bot),
    auditStore,
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    approvalGate: service.gate,
    approvalRefusal: service.refusal,
    deviceTakeovers: createDeviceTakeovers(),
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
        void runnerMessage(ws, deviceStore, channel, value, undefined, {
          onDesktopStopped: (machine, info) =>
            gateway.desktopStopped?.(machine, info),
        }).catch(() => ws.close(1008));
      },
      close: (ws) => runnerClose(ws, channel),
    },
  });
  let socket: WebSocket | undefined;
  let acked: () => void = () => {};
  /** One heartbeat, carrying the device's latest stop as the runner's own beat does. */
  async function beat() {
    const ws = socket;
    if (!ws) throw new Error("Not connected.");
    const ack = new Promise<void>((resolve) => {
      acked = resolve;
    });
    const desktopStopped = sessions.takeStopped();
    ws.send(
      JSON.stringify({
        type: "heartbeat",
        roots: [],
        apps: [],
        ...(desktopStopped ? { desktopStopped } : {}),
      }),
    );
    await ack;
  }
  async function connect() {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/?token=${paired?.token}`,
    );
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type === "welcome") resolve();
        if (frame.type === "ack") acked();
        if (frame.type === "action") frames.push(frame);
        if (frame.type === "action" || frame.type === "cancel")
          void (async () => {
            if (frame.type === "action" && beforeAction)
              await beforeAction(frame);
            await dispatch("desktop-write-tools/studio", frame, (result) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify(result));
            });
          })().catch(() => undefined);
      });
      ws.addEventListener("error", () => reject(new Error("Socket failed")));
    });
    await beat();
  }

  const actor = { id: tenant, userId: tenant };
  /** The tools a run gets, as index.ts builds them: the desktop only for the owner's own run. */
  async function toolsFor(
    who: { id: string; userId: string } = actor,
    bot = botId,
  ) {
    return createHeadlessComputerTools({
      gateway,
      seat: personSeat(who.id, bot),
      actor: who,
      auditStore,
      machine: "device",
      apps: localAppsAllowed({
        machine: "device",
        owner: bot === botId ? tenant : null,
        actorId: who.id,
      }),
      disabled: await runAsTenant(tenant, () =>
        service.disabledTools(who.id, bot),
      ),
    });
  }
  /** One tool call, from inside the Bot's run in its thread, as the headless middleware makes it. */
  async function call(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string = randomUUID(),
  ) {
    const tool = (await toolsFor()).find(
      (candidate) => candidate.definition.name === name,
    );
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
  /** The window list and a fresh read of the first window; `ref(name)` is a control's ref. */
  async function read() {
    const listed = (await call("computer_desktop_windows", {})) as {
      windows: { windowId: string; title: string }[];
    };
    const window = listed.windows[0];
    if (!window) throw new Error("No window listed.");
    const snapshot = (await call("computer_desktop_snapshot", {
      windowId: window.windowId,
    })) as { elements: { name?: string; ref: string }[] };
    const ref = (name: string) => {
      const element = snapshot.elements.find((e) => e.name === name);
      if (!element) throw new Error(`No control named ${name}.`);
      return element.ref;
    };
    return { window, ref, elements: snapshot.elements };
  }
  /** The fake CLI's commands, as it was started with them. */
  const adLog = (): string[][] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { args: string[] }).args);
  /** The commands that act on the screen, in order. */
  const adWrites = () =>
    adLog().filter((args) =>
      AD_WRITES.has(args.find((arg) => arg !== "--headed") ?? ""),
    );
  const sent = (action: string) =>
    frames.filter((frame) => frame.action === action);
  /** The session and write actions the runner was sent, in order (reads left out). */
  const writeFrames = () =>
    frames
      .map((frame) => String(frame.action))
      .filter(
        (action) =>
          action !== "desktop.windows" && action !== "desktop.snapshot",
      );
  const requests = () => runAsTenant(tenant, () => store.list(tenant));
  /** Approves (or rejects) the one request a tool call is waiting on. */
  async function decide(toolCallId: string, decision: "allow_once" | "deny") {
    const request = (await requests()).find(
      (candidate) => candidate.action.toolCallId === toolCallId,
    );
    if (!request) throw new Error(`No request for ${toolCallId}.`);
    await runAsTenant(tenant, () =>
      service.decide(tenant, request.id, decision),
    );
    return request;
  }
  /** A click the owner is asked about and approves: the call waits, then runs once approved. */
  async function approvedCall(name: string, args: Record<string, unknown>) {
    const toolCallId = randomUUID();
    const held = await call(name, args, toolCallId).catch(
      (error: unknown) => error,
    );
    expect(held).toBeInstanceOf(HeadlessToolSuspension);
    const request = await decide(toolCallId, "allow_once");
    const result = await call(name, args, toolCallId);
    return { request, result, toolCallId };
  }
  cleanups.push(async () => {
    socket?.close();
    stdin.close();
    await execute.closeDesktop();
    journal.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  await connect();
  return {
    tenant,
    botId,
    catalogueBot,
    target,
    gateway,
    actor,
    service,
    sessions,
    stdin,
    toolsFor,
    call,
    read,
    decide,
    approvedCall,
    adLog,
    adWrites,
    sent,
    writeFrames,
    requests,
    beat,
    setBeforeAction(hook: typeof beforeAction) {
      beforeAction = hook;
    },
    /** The audit rows filed in this tenant for the Bot. */
    auditRows: () =>
      runAsTenant(tenant, () =>
        database
          .select({
            eventType: auditEvents.eventType,
            payload: auditEvents.payload,
          })
          .from(auditEvents)
          .where(eq(auditEvents.targetId, botId)),
      ),
  };
}

const names = (tools: { definition: { name: string } }[]) =>
  tools.map((tool) => tool.definition.name);

test("the owner's run gets the four write tools; a teammate's and a catalogue Bot's get none", async () => {
  const device = await pairedDevice();
  expect([...DESKTOP_WRITE_TOOLS]).toEqual(expect.arrayContaining(WRITE_TOOLS));
  const owners = await device.toolsFor();
  expect(names(owners)).toEqual(expect.arrayContaining(WRITE_TOOLS));
  const described = Object.fromEntries(
    owners.map((tool) => [tool.definition.name, tool.definition.description]),
  );
  expect(described).toMatchObject({
    computer_desktop_click: DESKTOP_CLICK_DESCRIPTION,
    computer_desktop_type: DESKTOP_TYPE_DESCRIPTION,
    computer_desktop_key: DESKTOP_KEY_DESCRIPTION,
    computer_desktop_focus: DESKTOP_FOCUS_DESCRIPTION,
  });
  // Every write tool says what a session is, that refs go stale, and that Linux only looks.
  for (const name of WRITE_TOOLS) {
    const words = String(described[name]);
    expect(words).toContain(
      "Needs a desktop session: the first call asks the person, who sees a banner and can stop it by moving the mouse or pressing Ctrl+Alt+Esc. A refusal or a stop is final for that step: do not retry it in other words.",
    );
    expect(words).toContain(
      "After any change, read the window again; refs from before are refused.",
    );
    expect(words).toContain("Linux computers are read-only.");
  }
  expect(DESKTOP_CLICK_DESCRIPTION).toContain(
    "Clicking a control named like Send, Delete or Pay asks every time.",
  );
  expect(DESKTOP_TYPE_DESCRIPTION).toContain(
    "Never types Enter for you; a newline into a one-line field counts as submitting. Password fields are refused: use computer_request_secret.",
  );
  expect(DESKTOP_TYPE_DESCRIPTION).toContain(
    "Tab and other control characters ask every time.",
  );
  expect(DESKTOP_KEY_DESCRIPTION).toContain(
    "Use cmd on macOS and ctrl on Windows. Enter and Ctrl+Enter ask every time; closing a program (Alt+F4, Cmd+Q) asks; system shortcuts (Win+R, Cmd+Space, Ctrl+Alt+Del, lock, log out) are refused. The window must be in front: call computer_desktop_focus first.",
  );
  expect(DESKTOP_KEY_DESCRIPTION).toContain(
    "Space alone, or with Shift, asks every time (it presses the focused button).",
  );
  // The read tool no longer says the desktop cannot be written to.
  expect(described.computer_desktop_snapshot).toBe(
    DESKTOP_SNAPSHOT_DESCRIPTION,
  );
  expect(DESKTOP_SNAPSHOT_DESCRIPTION).not.toContain("Read-only: you cannot");

  const params = Object.fromEntries(
    owners.map((tool) => [
      tool.definition.name,
      tool.definition.parameters as {
        properties?: Record<string, { pattern?: string; default?: unknown }>;
        additionalProperties?: boolean;
      },
    ]),
  );
  const keysOf = (name: string) =>
    Object.keys(params[name]?.properties ?? {}).sort();
  expect(keysOf("computer_desktop_click")).toEqual(["ref"]);
  expect(keysOf("computer_desktop_type")).toEqual(["mode", "ref", "text"]);
  expect(keysOf("computer_desktop_key")).toEqual(["keys", "windowId"]);
  expect(keysOf("computer_desktop_focus")).toEqual(["windowId"]);
  for (const name of WRITE_TOOLS)
    expect(params[name]?.additionalProperties).toBe(false);
  expect(params.computer_desktop_type?.properties?.mode?.default).toBe(
    "replace",
  );

  // Text over 9 000 UTF-8 bytes never leaves the tool: 3 000 Chinese characters do, one more does not.
  const typeTool = owners.find(
    (tool) => tool.definition.name === "computer_desktop_type",
  );
  if (!typeTool) throw new Error("No type tool.");
  const tooLong = await typeTool
    .execute(
      {
        ref: "abcdef-1:1",
        text: "字".repeat(DESKTOP_LIMITS.textMaxBytes / 3 + 1),
      },
      { toolCallId: randomUUID(), signal: new AbortController().signal },
    )
    .catch((error: unknown) => error);
  expect(tooLong).toBeInstanceOf(Error);
  expect((tooLong as Error).name).toBe("ZodError");
  expect(device.sent("desktop.session_status")).toHaveLength(0);

  const teammate = {
    id: `${device.tenant}-teammate`,
    userId: `${device.tenant}-teammate`,
  };
  const teammates = names(await device.toolsFor(teammate));
  const catalogue = names(
    await device.toolsFor(device.actor, device.catalogueBot),
  );
  for (const name of WRITE_TOOLS) {
    expect(teammates).not.toContain(name);
    expect(catalogue).not.toContain(name);
  }
  // A call that names the gateway anyway reaches no machine.
  await expect(
    device.gateway.clickDesktop(device.botId, teammate, { ref: "abcdef-1:1" }),
  ).rejects.toThrow("只有员工的主人本人");
  await expect(
    device.gateway.focusDesktopWindow(device.botId, teammate, {
      windowId: "a0123456789abcdef",
    }),
  ).rejects.toThrow("只有员工的主人本人");
  await expect(
    device.gateway.clickDesktop(device.catalogueBot, device.actor, {
      ref: "abcdef-1:1",
    }),
  ).rejects.toThrow(
    `${device.catalogueBot} does not belong to a tenant with machines of its own.`,
  );
  expect(device.sent("desktop.session_status")).toHaveLength(0);
  expect(device.adLog()).toEqual([]);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("操作桌面 disabled: no write tool is offered and a call anyway is refused before the device", async () => {
  const device = await pairedDevice();
  // The rule the permissions page writes for 操作桌面 → 禁用.
  await runAsTenant(device.tenant, () =>
    device.service.createRule(device.tenant, {
      botId: device.botId,
      toolRef: "computer_desktop_session",
      effect: "*",
      scope: "*",
      behaviour: "deny",
    }),
  );
  const offered = names(await device.toolsFor());
  for (const name of WRITE_TOOLS) expect(offered).not.toContain(name);
  // Looking stays: the read tools are still there.
  expect(offered).toEqual(
    expect.arrayContaining([
      "computer_desktop_windows",
      "computer_desktop_snapshot",
    ]),
  );
  const asOwner = <T>(run: () => Promise<T>) => runAsTenant(device.tenant, run);
  const { botId, actor, gateway } = device;
  await expect(
    asOwner(() => gateway.clickDesktop(botId, actor, { ref: "abcdef-1:1" })),
  ).rejects.toThrow(TOOL_DISABLED);
  await expect(
    asOwner(() =>
      gateway.typeDesktop(botId, actor, {
        ref: "abcdef-1:1",
        text: "你好",
        mode: "replace",
      }),
    ),
  ).rejects.toThrow(TOOL_DISABLED);
  await expect(
    asOwner(() =>
      gateway.pressDesktopKey(botId, actor, {
        windowId: "a0123456789abcdef",
        keys: "cmd+s",
      }),
    ),
  ).rejects.toThrow(TOOL_DISABLED);
  await expect(
    asOwner(() =>
      gateway.focusDesktopWindow(botId, actor, {
        windowId: "a0123456789abcdef",
      }),
    ),
  ).rejects.toThrow(TOOL_DISABLED);
  // The device was never asked anything, and nothing was put to the owner.
  expect(device.sent("desktop.session_status")).toHaveLength(0);
  expect(device.sent("desktop.session_start")).toHaveLength(0);
  expect(device.adLog()).toEqual([]);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("first click asks for a session; approve → session_start then click; the second click needs no card", async () => {
  const device = await pairedDevice();
  const first = await device.read();
  const ref = first.ref("Single line");
  const toolCallId = randomUUID();
  const held = await device
    .call("computer_desktop_click", { ref }, toolCallId)
    .catch((error: unknown) => error);
  expect(held).toBeInstanceOf(HeadlessToolSuspension);
  // Asked, and nothing done yet: no session on the device, no click.
  const [request] = await device.requests();
  expect(request?.action.policy).toMatchObject({
    behaviour: "ask",
    source: "desktop_session",
  });
  expect(request?.action.policy?.reason).toContain("必要时会移动你的鼠标");
  expect(device.sent("desktop.session_start")).toHaveLength(0);
  expect(device.adWrites()).toEqual([]);

  await device.decide(toolCallId, "allow_once");
  const done = (await device.call(
    "computer_desktop_click",
    { ref },
    toolCallId,
  )) as { ok: boolean; window: { title: string }; control?: unknown };
  expect(done).toMatchObject({
    ok: true,
    window: { title: first.window.title },
    control: { type: "textfield", name: "Single line" },
  });
  // Asked about the session once per call; opened only once approved, and before the click.
  expect(device.writeFrames()).toEqual([
    "desktop.session_status",
    "desktop.session_status",
    "desktop.session_start",
    "desktop.click",
  ]);
  expect(device.adWrites()).toHaveLength(1);
  expect(device.adWrites()[0]?.[0]).toBe("click");

  // The click changed the window: a fresh read, then a second click inside the same session.
  const second = await device.read();
  const again = (await device.call("computer_desktop_click", {
    ref: second.ref("Single line"),
  })) as { ok: boolean };
  expect(again.ok).toBeTrue();
  expect(await device.requests()).toHaveLength(1);
  expect(device.sent("desktop.session_start")).toHaveLength(1);
  expect(device.sent("desktop.click")).toHaveLength(2);
  expect(device.adWrites()).toHaveLength(2);
}, 30_000);

test("clicking 发送 in the session asks again, once only; reject → nothing reaches the fake binary", async () => {
  const device = await pairedDevice();
  // A session, opened by an approved plain click.
  const opening = await device.read();
  await device.approvedCall("computer_desktop_click", {
    ref: opening.ref("Single line"),
  });
  expect(device.adWrites()).toHaveLength(1);

  // In the session, a click on 发送 still asks: one card, which the owner approves.
  const send = await device.read();
  const approved = await device.approvedCall("computer_desktop_click", {
    ref: send.ref("发送"),
  });
  expect(approved.request.action.policy).toMatchObject({
    behaviour: "ask",
    source: "desktop_action",
  });
  expect(approved.request.action.policy?.reason).toContain("「发送」");
  expect(approved.result).toMatchObject({
    ok: true,
    control: { type: "button", name: "发送" },
  });
  // Once only: the device was told it was approved and did not ask a second time.
  const forThisCall = (await device.requests()).filter(
    (candidate) => candidate.action.toolCallId === approved.toolCallId,
  );
  expect(forThisCall).toHaveLength(1);
  expect(device.sent("desktop.click").at(-1)?.payload).toMatchObject({
    approved: true,
  });
  expect(device.adWrites()).toHaveLength(2);
  expect(device.sent("desktop.session_start")).toHaveLength(1);

  // Rejected: the click never reaches the binary.
  const reject = await device.read();
  const toolCallId = randomUUID();
  const args = { ref: reject.ref("发送") };
  await expect(
    device.call("computer_desktop_click", args, toolCallId),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const card = await device.decide(toolCallId, "deny");
  expect(card.action.policy?.source).toBe("desktop_action");
  const denied = await device
    .call("computer_desktop_click", args, toolCallId)
    .catch((error: unknown) => error);
  expect(denied).toBeInstanceOf(ApprovalRefusedError);
  expect((denied as Error).message).toBe(DECLINED_BY_PERSON);
  expect(device.adWrites()).toHaveLength(2);
  expect(device.sent("desktop.click")).toHaveLength(2);
}, 40_000);

test("a stop on the device makes the next write 用户已停止桌面操作…", async () => {
  const device = await pairedDevice();
  const opening = await device.read();
  await device.approvedCall("computer_desktop_click", {
    ref: opening.ref("Single line"),
  });
  expect(device.adWrites()).toHaveLength(1);

  // The owner presses the stop key just as the next write is on its way to the device.
  const next = await device.read();
  device.setBeforeAction(async (frame) => {
    if (frame.action !== "desktop.click") return;
    device.setBeforeAction(undefined);
    device.stdin.push(JSON.stringify({ control: "stop", reason: "hotkey" }));
    await poll(() => device.sessions.signal === undefined);
  });
  const stopped = await device
    .call("computer_desktop_click", { ref: next.ref("Single line") })
    .catch((error: unknown) => error);
  expect(stopped).toBeInstanceOf(Error);
  expect((stopped as Error).message).toBe(desktopMessage("stopped"));
  expect((stopped as Error).message.startsWith("用户已停止桌面操作")).toBe(
    true,
  );
  expect(device.adWrites()).toHaveLength(1);

  // The runner's next heartbeat carries the stop: the server records it with how it was stopped.
  await device.beat();
  await poll(async () =>
    (await device.auditRows()).some(
      (row) =>
        (row.payload as { reason?: string }).reason === "用户已停止桌面操作",
    ),
  );
  const stopRow = (await device.auditRows()).find(
    (row) =>
      (row.payload as { reason?: string }).reason === "用户已停止桌面操作",
  );
  expect(stopRow).toMatchObject({
    eventType: "computer.action_refused",
    payload: { action: "computer_desktop_session", stoppedBy: "hotkey" },
  });

  // The next write starts over: the owner is asked for a new session.
  const after = await device.read();
  const toolCallId = randomUUID();
  await expect(
    device.call(
      "computer_desktop_click",
      { ref: after.ref("Single line") },
      toolCallId,
    ),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const card = (await device.requests()).find(
    (candidate) => candidate.action.toolCallId === toolCallId,
  );
  expect(card?.action.policy?.source).toBe("desktop_session");
  expect(device.adWrites()).toHaveLength(1);
}, 40_000);

test("a click only the device sees is sensitive is asked once, then carried out once", async () => {
  const device = await pairedDevice();
  const opening = await device.read();
  await device.approvedCall("computer_desktop_click", {
    ref: opening.ref("Single line"),
  });
  // The server holds the name as shown, cut before 发送; the device reads it whole and asks.
  const { elements } = await device.read();
  const long = elements.find(
    (element) =>
      (element.name ?? "").length > 0 &&
      LONG_NAME.startsWith(element.name ?? ""),
  );
  if (!long) throw new Error("No control with the long name.");
  expect(long.name).not.toContain("发送");
  const toolCallId = randomUUID();
  const args = { ref: long.ref };
  await expect(
    device.call("computer_desktop_click", args, toolCallId),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const card = await device.decide(toolCallId, "allow_once");
  expect(card.action.policy?.reason).toContain(
    "设备端核对后认为这一步需要你批准",
  );
  expect(card.action.policy?.reason).toContain("「发送」");
  // Approved, the same tool call runs again: the device's earlier answer, then the approved resend.
  const done = await device.call("computer_desktop_click", args, toolCallId);
  expect(done).toMatchObject({ ok: true, control: { type: "button" } });
  const clicks = device
    .sent("desktop.click")
    .map((frame) => (frame.payload as { approved?: boolean }).approved);
  expect(clicks.slice(1)).toEqual([false, false, true]);
  // The binary clicked once for the opening and once, approved, for this.
  expect(device.adWrites()).toHaveLength(2);
  const forThisCall = (await device.requests()).filter(
    (candidate) => candidate.action.toolCallId === toolCallId,
  );
  expect(forThisCall).toHaveLength(1);
}, 40_000);

test("on a Linux device the write is refused before any card", async () => {
  const device = await pairedDevice({ platform: "linux" });
  const { window, elements } = await device.read();
  const ref = elements.find((element) => element.name === "OK")?.ref;
  if (!ref) throw new Error("No OK button on the Linux sample.");
  const readOnly = desktopMessage("read_only_linux");
  expect(readOnly).toBe("这台 Linux 电脑目前只能查看，不能操作界面。");
  await expect(device.call("computer_desktop_click", { ref })).rejects.toThrow(
    readOnly,
  );
  await expect(
    device.call("computer_desktop_type", { ref, text: "你好" }),
  ).rejects.toThrow(readOnly);
  await expect(
    device.call("computer_desktop_key", {
      windowId: window.windowId,
      keys: "ctrl+s",
    }),
  ).rejects.toThrow(readOnly);
  await expect(
    device.call("computer_desktop_focus", { windowId: window.windowId }),
  ).rejects.toThrow(readOnly);
  // The device said so when asked: no card, no session, nothing run.
  expect(device.sent("desktop.session_status")).toHaveLength(4);
  expect(device.sent("desktop.session_start")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
  expect(device.adWrites()).toEqual([]);
}, 30_000);

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  for (const tenant of tenants) {
    await runAsTenant(tenant, async () => {
      await database.delete(workItems).where(eq(workItems.tenantId, tenant));
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
