import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { desktopMessage } from "../../shared/desktop-control";
import { createDesktopActions } from "../../runner/src/desktop/actions";
import { createDesktopHost } from "../../runner/src/desktop/host";
import { createRunnerDispatcher } from "../../runner/src/dispatch";
import { createRunnerExecutor } from "../../runner/src/execute";
import { createActionJournal } from "../../runner/src/journal";
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
import {
  DESKTOP_SNAPSHOT_DESCRIPTION,
  DESKTOP_WINDOWS_DESCRIPTION,
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
import {
  createDeviceChannel,
  DeviceOfflineError,
} from "../src/devices/channel";
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
 * Looking at the Bot owner's desktop, read only (device-side desktop viewing, Phase 1): the Bot's two
 * desktop tools end to end.
 *
 * Real pieces throughout: a paired device in PostgreSQL, the server's runner socket handlers behind a
 * real WebSocket, the runner's own dispatcher, journal and executor with the desktop actions driving
 * the fake helper process, the real device channel and queue, the real approval store and gate, the
 * real audit store, and the two tools as the headless middleware calls them.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const FAKE_DESKTOP = new URL(
  "../../runner/tests/fixtures/fake-desktop-helper.ts",
  import.meta.url,
).pathname;
const NOTEPAD = "w4242-77";
const BANK = "w5151-88";
const DESKTOP_TOOLS = ["computer_desktop_windows", "computer_desktop_snapshot"];
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
    /** The platform the runner's desktop actions believe they are on; Windows unless told. */
    platform?: string;
  } = {},
) {
  const tenant = `ddesk-${suite}-${tenants.length}`;
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
    platform: "win32",
  });
  if (!paired) throw new Error("Pairing failed.");
  const target = { tenantId: tenant, deviceId: "studio" };

  // The runner: its executor's desktop actions drive the fake helper, which logs every request.
  const root = await mkdtemp(join(tmpdir(), "desktop-tools-"));
  await mkdir(join(root, "ws"));
  const log = join(root, "helper.log");
  const desktop =
    options.platform && options.platform !== "win32"
      ? createDesktopActions({ platform: options.platform })
      : createDesktopActions({
          platform: "win32",
          host: createDesktopHost({
            spec: () => ({
              command: process.execPath,
              args: [FAKE_DESKTOP],
              env: { FAKE_DESKTOP_MODE: "ok", FAKE_DESKTOP_LOG: log },
            }),
          }),
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

  // The server: socket handlers and the channel with its durable queue.
  const queue = createDeviceQueue(database);
  const channel = createDeviceChannel({ queue });
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
  /** The runner dials in, says hello on a heartbeat, and runs what it is sent. */
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
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type === "welcome") resolve();
        if (frame.type === "ack") acked();
        if (frame.type === "action") frames.push(frame);
        if (frame.type === "action" || frame.type === "cancel")
          void dispatch("desktop-tools/studio", frame, (result) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify(result));
          }).catch(() => undefined);
      });
      ws.addEventListener("error", () => reject(new Error("Socket failed")));
    });
    ws.send(JSON.stringify({ type: "heartbeat", roots: [], apps: [] }));
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
      isolation: "per-bot",
      locate: async () => {
        throw new Error(
          "A paired machine is never located through the provider.",
        );
      },
      status: async (id) => ({ botId: id, state: "absent" }),
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
  const actor = { id: tenant, userId: tenant };
  /** The tools a run gets, as index.ts builds them: apps only for the owner's own run on a device. */
  async function toolsFor(
    who: { id: string; userId: string } = actor,
    bot = botId,
  ) {
    return createHeadlessComputerTools({
      gateway,
      botId: bot,
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
    toolCallId = randomUUID(),
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
  /** Every request line the fake helper received, as it arrived. */
  const helperLog = (): Record<string, unknown>[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const sent = (action: string) =>
    frames.filter((frame) => frame.action === action);
  const requests = () => runAsTenant(tenant, () => store.list(tenant));
  cleanups.push(async () => {
    socket?.close();
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
    queue,
    service,
    toolsFor,
    call,
    helperLog,
    /** The `tree` requests the fake helper received: what was actually read. */
    trees: () => helperLog().filter((line) => line.op === "tree"),
    sent,
    requests,
    disconnect,
    /** The device-queue rows written for this machine, whatever the action. */
    queuedRows: () =>
      runAsTenant(
        tenant,
        async () =>
          (
            await database
              .select({ payload: workItems.payload })
              .from(workItems)
              .where(eq(workItems.tenantId, tenant))
          ).length,
      ),
    /** The audit rows the gateway wrote for this tenant's actions on the computer. */
    computerAudit: () =>
      runAsTenant(tenant, () =>
        database
          .select({
            eventType: auditEvents.eventType,
            payload: auditEvents.payload,
          })
          .from(auditEvents)
          .where(eq(auditEvents.actorUserId, tenant)),
      ),
  };
}

test("the owner's run gets both desktop tools; a teammate and a catalogue Bot get neither, and the gateway refuses them too", async () => {
  const device = await pairedDevice();
  const names = (tools: { definition: { name: string } }[]) =>
    tools.map((tool) => tool.definition.name);
  const owners = await device.toolsFor();
  expect(names(owners)).toEqual(expect.arrayContaining(DESKTOP_TOOLS));
  const described = Object.fromEntries(
    owners.map((tool) => [tool.definition.name, tool.definition.description]),
  );
  expect(described.computer_desktop_windows).toBe(DESKTOP_WINDOWS_DESCRIPTION);
  expect(described.computer_desktop_snapshot).toBe(
    DESKTOP_SNAPSHOT_DESCRIPTION,
  );
  // Read only: neither tool takes anything that could act on the desktop.
  const params = Object.fromEntries(
    owners.map((tool) => [
      tool.definition.name,
      Object.keys(
        (tool.definition.parameters as { properties?: object }).properties ??
          {},
      ).sort(),
    ]),
  );
  expect(params.computer_desktop_windows).toEqual([]);
  expect(params.computer_desktop_snapshot).toEqual(
    ["from", "screenshot", "windowId"].sort(),
  );

  const teammate = {
    id: `${device.tenant}-teammate`,
    userId: `${device.tenant}-teammate`,
  };
  for (const name of DESKTOP_TOOLS) {
    expect(names(await device.toolsFor(teammate))).not.toContain(name);
    expect(
      names(await device.toolsFor(device.actor, device.catalogueBot)),
    ).not.toContain(name);
  }
  // A call that names the gateway anyway reaches no machine.
  await expect(
    device.gateway.listDesktopWindows(device.botId, teammate),
  ).rejects.toThrow("只有员工的主人本人");
  await expect(
    device.gateway.snapshotDesktop(device.botId, teammate, {
      windowId: NOTEPAD,
    }),
  ).rejects.toThrow("只有员工的主人本人");
  // A catalogue Bot has no owner, so no machine to find: refused before anything is sent.
  const noMachine = `${device.catalogueBot} does not belong to a tenant with machines of its own.`;
  await expect(
    device.gateway.listDesktopWindows(device.catalogueBot, device.actor),
  ).rejects.toThrow(noMachine);
  await expect(
    device.gateway.snapshotDesktop(device.catalogueBot, device.actor, {
      windowId: NOTEPAD,
    }),
  ).rejects.toThrow(noMachine);
  expect(device.sent("desktop.windows")).toHaveLength(0);
  expect(device.sent("desktop.snapshot")).toHaveLength(0);
  expect(device.helperLog()).toEqual([]);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("computer_desktop_windows lists the owner's windows, marked untrusted", async () => {
  const device = await pairedDevice();
  const listed = (await device.call("computer_desktop_windows", {})) as {
    ok: boolean;
    untrusted?: string;
    windows: { windowId: string; title: string; process: string }[];
  };
  expect(listed.ok).toBeTrue();
  expect(listed.windows.map((window) => window.windowId)).toEqual([
    NOTEPAD,
    BANK,
  ]);
  expect(listed.windows[0]).toMatchObject({
    title: "无标题 - 记事本",
    process: "notepad",
  });
  // Titles come from other programs: outside content, marked as such.
  expect(listed.untrusted).toContain("untrusted");
  expect(device.sent("desktop.windows")).toHaveLength(1);
  expect(await device.requests()).toEqual([]);
  // Read straight off the socket: no device-queue row.
  expect(await device.queuedRows()).toBe(0);
}, 20_000);

test("computer_desktop_snapshot reads a listed window without approval and records title and process, never the elements", async () => {
  const device = await pairedDevice();
  await device.call("computer_desktop_windows", {});
  const read = (await device.call("computer_desktop_snapshot", {
    windowId: NOTEPAD,
  })) as {
    ok: boolean;
    untrusted?: string;
    window: { title: string };
    elements: { name?: string; ref: string }[];
  };
  expect(read.ok).toBeTrue();
  expect(read.window.title).toBe("无标题 - 记事本");
  expect(read.elements.map((element) => element.name)).toContain("文本编辑器");
  expect(read.untrusted).toContain("untrusted");
  expect(await device.requests()).toEqual([]);
  // A plain title: the helper is still told to refuse sensitive windows itself.
  expect(device.trees()).toHaveLength(1);
  expect(device.trees()[0]?.refuseWords).not.toEqual([]);

  const rows = await device.computerAudit();
  const snapshotRow = rows.find(
    (row) =>
      (row.payload as { action?: string }).action ===
        "computer_desktop_snapshot" &&
      row.eventType === "computer.action_allowed",
  );
  expect(snapshotRow).toBeDefined();
  expect(
    (snapshotRow?.payload as { desktop?: unknown } | undefined)?.desktop,
  ).toMatchObject({
    windowId: NOTEPAD,
    title: "无标题 - 记事本",
    process: "notepad",
  });
  const everything = JSON.stringify(
    await runAsTenant(device.tenant, () =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, device.botId)),
    ),
  );
  expect(everything).toContain("无标题 - 记事本");
  expect(everything).not.toContain("文本编辑器");
  expect(everything).not.toContain("熊宝员工");
}, 20_000);

test("a window titled 招商银行 waits for approval; approve reads it once, reject never sends the read", async () => {
  const device = await pairedDevice();
  const held = await device
    .call("computer_desktop_snapshot", { windowId: BANK }, "approve-bank")
    .catch((error: unknown) => error);
  expect(held).toBeInstanceOf(HeadlessToolSuspension);
  expect(device.trees()).toHaveLength(0);
  const [request] = await device.requests();
  expect(request?.action.policy).toMatchObject({
    behaviour: "ask",
    source: "desktop_window",
  });
  expect(request?.action.policy?.reason).toContain("招商银行");
  await runAsTenant(device.tenant, () =>
    device.service.decide(device.tenant, request?.id as string, "allow_once"),
  );
  const read = (await device.call(
    "computer_desktop_snapshot",
    { windowId: BANK },
    "approve-bank",
  )) as { window: { title: string } };
  expect(read.window.title).toContain("招商银行");
  expect(device.trees()).toHaveLength(1);
  // Approved: the one read that may tell the helper not to refuse the sensitive title.
  expect(device.trees()[0]?.refuseWords).toEqual([]);

  // Rejected: the read is never sent.
  await expect(
    device.call("computer_desktop_snapshot", { windowId: BANK }, "reject-bank"),
  ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  const rejected = (await device.requests()).find(
    (candidate) => candidate.action.toolCallId === "reject-bank",
  );
  expect(rejected?.action.policy?.source).toBe("desktop_window");
  await runAsTenant(device.tenant, () =>
    device.service.decide(device.tenant, rejected?.id as string, "deny"),
  );
  const denied = await device
    .call("computer_desktop_snapshot", { windowId: BANK }, "reject-bank")
    .catch((error: unknown) => error);
  // Told it was declined, not left waiting for an answer that has already come.
  expect(denied).not.toBeInstanceOf(HeadlessToolSuspension);
  expect(denied).toBeInstanceOf(ApprovalRefusedError);
  expect((denied as Error).message).toBe(DECLINED_BY_PERSON);
  expect(device.trees()).toHaveLength(1);
}, 30_000);

test("a windowId the device never listed is refused with 找不到这个窗口 and never read", async () => {
  const device = await pairedDevice();
  await expect(
    device.call("computer_desktop_snapshot", { windowId: "w9999-11" }),
  ).rejects.toThrow("找不到这个窗口");
  expect(desktopMessage("no_window")).toContain("找不到这个窗口");
  expect(device.trees()).toHaveLength(0);
  expect(device.sent("desktop.snapshot")).toHaveLength(0);
  expect(await device.requests()).toEqual([]);
}, 20_000);

test("offline device: desktop reads are refused at once, never queued", async () => {
  const device = await pairedDevice();
  await device.disconnect();
  const offline = new DeviceOfflineError("studio").message;
  await expect(device.call("computer_desktop_windows", {})).rejects.toThrow(
    offline,
  );
  await expect(
    device.call("computer_desktop_snapshot", { windowId: NOTEPAD }),
  ).rejects.toThrow(offline);
  expect(await device.queuedRows()).toBe(0);
  expect(await device.queue.uncertain(device.target)).toBe(0);
  expect(device.helperLog()).toEqual([]);
}, 20_000);

test("with 查看桌面 set to 禁用 the tool is not offered, and a call anyway starts no helper", async () => {
  const device = await pairedDevice();
  // The rule the permissions page writes for 禁用: the owner's own deny for this Bot and tool.
  await runAsTenant(device.tenant, () =>
    device.service.createRule(device.tenant, {
      botId: device.botId,
      toolRef: "computer_desktop_snapshot",
      effect: "*",
      scope: "*",
      behaviour: "deny",
    }),
  );
  const names = (await device.toolsFor()).map((tool) => tool.definition.name);
  expect(names).not.toContain("computer_desktop_snapshot");
  expect(names).toContain("computer_desktop_windows");
  await expect(
    runAsTenant(device.tenant, () =>
      device.gateway.snapshotDesktop(device.botId, device.actor, {
        windowId: NOTEPAD,
      }),
    ),
  ).rejects.toThrow(TOOL_DISABLED);
  expect(device.helperLog()).toEqual([]);
  expect(device.sent("desktop.windows")).toHaveLength(0);
  expect(device.sent("desktop.snapshot")).toHaveLength(0);
}, 20_000);

test("a device that is not Windows answers 这台设备不是 Windows", async () => {
  const device = await pairedDevice({ platform: "linux" });
  await expect(device.call("computer_desktop_windows", {})).rejects.toThrow(
    "这台设备不是 Windows",
  );
  await expect(
    device.call("computer_desktop_snapshot", { windowId: NOTEPAD }),
  ).rejects.toThrow("这台设备不是 Windows");
  expect(device.sent("desktop.snapshot")).toHaveLength(0);
}, 20_000);

test("the team's host-command cap at never does not stop desktop reads", async () => {
  const device = await pairedDevice({ hostCommandsCap: "never" });
  const listed = (await device.call("computer_desktop_windows", {})) as {
    windows: { windowId: string }[];
  };
  expect(listed.windows).toHaveLength(2);
  const read = (await device.call("computer_desktop_snapshot", {
    windowId: NOTEPAD,
  })) as { window: { title: string } };
  expect(read.window.title).toBe("无标题 - 记事本");
  expect(device.trees()).toHaveLength(1);
  expect(await device.requests()).toEqual([]);
}, 20_000);

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
