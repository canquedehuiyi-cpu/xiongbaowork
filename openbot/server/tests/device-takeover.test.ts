import { expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  HandoffRequestError,
  HumanHasControlError,
} from "../src/computer/client";
import {
  createComputerGateway,
  DEVICE_TAKEOVER_RULE,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createRunnerTransport } from "../src/computer/runner-transport";
import {
  createDeviceChannel,
  type DeviceChannel,
  type DispatchTarget,
} from "../src/devices/channel";
import { createDeviceScreens, TAKE_CONTROL_FIRST } from "../src/devices/screen";
import { createDeviceComputerProvider } from "../src/devices/selection";
import {
  createDeviceTakeovers,
  DEVICE_HUMAN_HAS_CONTROL,
} from "../src/devices/takeover";

/**
 * Human takeover of a coworker's browser on a tenant's own machine (F2 stage 2, acceptance 2).
 *
 * While a person holds the wheel, or has been asked to take it, the gateway refuses that Bot's actions
 * on that machine before anything is sent: an audit row says so, and the runner socket sees no frame.
 * Handing back, explicitly or by closing the last screen, lets the Bot act again.
 */

const OWNER = "tenant-a";
const ACTOR = { id: OWNER };
const PERMISSIVE: ActionPolicy = {
  mode: "enforce",
  deny: [],
  allow: ["true"],
};
const laptop: DispatchTarget = { tenantId: OWNER, deviceId: "laptop-1" };

/** A runner that answers every action, and remembers every frame it was written. */
function answeringSocket(
  channel: () => DeviceChannel,
  target: DispatchTarget,
  frames: Record<string, unknown>[],
) {
  return {
    send(value: string) {
      const frame = JSON.parse(value) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type !== "action" || typeof frame.id !== "string") return;
      const id = frame.id;
      queueMicrotask(() => {
        channel().settle(target, {
          type: "result",
          id,
          ok: true,
          output: {
            exitCode: 0,
            stdout: "",
            stderr: "",
            url: "https://example.test/",
            title: "Example",
            text: "",
          },
        });
      });
    },
  };
}

function harness(options: { now?: () => number; graceMs?: number } = {}) {
  const channel = createDeviceChannel();
  const frames: Record<string, unknown>[] = [];
  channel.attach(
    laptop,
    answeringSocket(() => channel, laptop, frames),
  );
  const rows: AuditEventInput[] = [];
  const audit: AuditStore = { insert: async (row) => void rows.push(row) };
  const released: string[] = [];
  const takeovers = createDeviceTakeovers({
    ...(options.now ? { now: options.now } : {}),
    releaseGraceMs: options.graceMs ?? 10,
    stillWatching: (target, botId, userId) =>
      screens.watching(target, botId, userId),
    onReleasedOnDisconnect: (release) => released.push(release.requestId),
  });
  const screens = createDeviceScreens({
    notify: (target, frame) => channel.notify(target, frame),
    holderOf: (target, botId) => takeovers.holder(target, botId),
    onViewerGone: (watch) => takeovers.viewerGone(watch),
  });
  let device: DispatchTarget = laptop;
  const gateway = createComputerGateway({
    provider: createDeviceComputerProvider(),
    auditStore: audit,
    policy: () => PERMISSIVE,
    transport: createRunnerTransport(channel),
    resolveDevice: async () => device,
    deviceTakeovers: takeovers,
  });
  const actions = () => frames.filter((frame) => frame.type === "action");
  return {
    channel,
    frames,
    actions,
    rows,
    released,
    takeovers,
    screens,
    gateway,
    moveTo: (target: DispatchTarget) => {
      device = target;
    },
  };
}

/** Take the wheel the way the surface does: ask, then take the request that was opened. */
async function take(h: ReturnType<typeof harness>, botId = "bot-1") {
  const asked = await h.gateway.requestHelp(botId, ACTOR, "接管");
  const id = asked.request?.id ?? "";
  const taken = await h.gateway.takeControl(botId, ACTOR, id);
  expect(taken.holder).toBe("human");
  return id;
}

test("while a person holds the wheel, every Bot action is refused with a row and no runner frame", async () => {
  const h = harness();
  await h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" });
  expect(h.actions()).toHaveLength(1);

  const requestId = await take(h);
  const before = h.actions().length;
  const rowsBefore = h.rows.length;

  const attempts: [string, () => Promise<unknown>][] = [
    [
      "computer_navigate",
      () => h.gateway.navigate("bot-1", ACTOR, "https://example.test/next"),
    ],
    [
      "computer_run_command",
      () => h.gateway.runCommand("bot-1", ACTOR, { command: "rm -rf ./out" }),
    ],
    [
      "computer_write_file",
      () =>
        h.gateway.writeFile("bot-1", ACTOR, {
          path: "notes.txt",
          content: "x",
        }),
    ],
    [
      "computer_scroll",
      () => h.gateway.scroll("bot-1", ACTOR, { deltaY: 400 }),
    ],
    ["computer_key", () => h.gateway.key("bot-1", ACTOR, { key: "Enter" })],
  ];
  for (const [, attempt] of attempts) {
    const error = await attempt().catch((caught) => caught);
    expect(error).toBeInstanceOf(HumanHasControlError);
    expect((error as HumanHasControlError).message).toBe(
      DEVICE_HUMAN_HAS_CONTROL,
    );
    // The Bot is told which handback to wait for, which is how its turn suspends and resumes.
    expect((error as HumanHasControlError).requestId).toBe(requestId);
  }

  // Nothing reached the machine.
  expect(h.actions()).toHaveLength(before);
  // One refusal row per attempt, naming the takeover and the device, and no allowed or failed rows.
  const written = h.rows.slice(rowsBefore);
  expect(written.map((row) => row.eventType)).toEqual(
    attempts.map(() => "computer.action_refused"),
  );
  expect(written.map((row) => row.payload.action)).toEqual(
    attempts.map(([tool]) => tool),
  );
  for (const row of written) {
    expect(row.payload.device).toBe("laptop-1");
    expect(row.payload.decision).toMatchObject({
      allowed: false,
      rule: DEVICE_TAKEOVER_RULE,
      carriedOut: false,
    });
  }
  // The command a Bot tried to run is on the row; the file body never is.
  expect(written[1]?.payload.command).toBe("rm -rf ./out");
  expect(JSON.stringify(written[2]?.payload)).not.toContain('"x"');
});

test("handing back lets the Bot act again, and the trail records both ends", async () => {
  const h = harness();
  const requestId = await take(h);
  const released = await h.gateway.releaseControl("bot-1", ACTOR, requestId);
  expect(released.holder).toBe("bot");
  // The surface is told this is the tenant's own machine, and which one.
  expect(released.device).toEqual({ deviceId: "laptop-1" });
  expect(released.request).toBeUndefined();
  expect((await h.gateway.control("bot-1", requestId)).request?.status).toBe(
    "completed",
  );

  await h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" });
  expect(h.actions().map((frame) => frame.action)).toEqual(["exec"]);
  const kinds = h.rows.map((row) => row.eventType);
  expect(kinds).toContain("computer.help_requested");
  expect(kinds).toContain("computer.control_taken");
  expect(kinds).toContain("computer.control_released");
  expect(kinds.at(-1)).toBe("computer.action_allowed");
});

test("a takeover is one Bot on one machine: another Bot, or the same Bot elsewhere, still acts", async () => {
  const h = harness();
  await take(h, "bot-1");
  await h.gateway.runCommand("bot-2", ACTOR, { command: "pwd" });
  expect(h.actions()).toHaveLength(1);

  const desktop = { tenantId: OWNER, deviceId: "desktop-2" };
  h.channel.attach(
    desktop,
    answeringSocket(() => h.channel, desktop, h.frames),
  );
  h.moveTo(desktop);
  await h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" });
  expect(h.actions()).toHaveLength(2);
});

test("a Bot asking for help is refused until the request is taken, cancelled or expires", async () => {
  let clock = Date.parse("2026-11-04T08:00:00Z");
  const h = harness({ now: () => clock });
  const asked = await h.gateway.requestHelp(
    "bot-1",
    ACTOR,
    "请帮我登录",
    "call-1",
  );
  expect(asked).toMatchObject({ holder: "bot", requested: true });
  expect(asked.request?.source).toBe("model");
  await expect(
    h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" }),
  ).rejects.toBeInstanceOf(HumanHasControlError);

  const id = asked.request?.id ?? "";
  await h.gateway.cancelControl("bot-1", ACTOR, id);
  await h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" });
  expect(h.actions()).toHaveLength(1);

  const again = await h.gateway.requestHelp("bot-1", ACTOR, "再帮一次");
  clock += 11 * 60 * 1000;
  expect(
    (await h.gateway.control("bot-1", again.request?.id)).request?.status,
  ).toBe("expired");
  await h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" });
  expect(h.actions()).toHaveLength(2);
});

test("a handback names its own request: an unknown one is 404, a finished one 409", async () => {
  const h = harness();
  await expect(
    h.gateway.takeControl("bot-1", ACTOR, "nope"),
  ).rejects.toMatchObject({ status: 404 });
  const requestId = await take(h);
  await h.gateway.releaseControl("bot-1", ACTOR, requestId);
  const error = await h.gateway
    .takeControl("bot-1", ACTOR, requestId)
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(HandoffRequestError);
  expect((error as HandoffRequestError).status).toBe(409);
  // Releasing twice is the same release.
  expect(
    (await h.gateway.releaseControl("bot-1", ACTOR, requestId)).holder,
  ).toBe("bot");
});

test("only the person holding the wheel drives through the live screen", async () => {
  const h = harness();
  const holder = { send: () => undefined };
  const sent: Record<string, unknown>[] = [];
  const other = { send: (value: string) => sent.push(JSON.parse(value)) };
  h.screens.subscribe(holder, {
    viewerTenant: OWNER,
    userId: OWNER,
    target: laptop,
    botId: "bot-1",
  });
  h.screens.subscribe(other, {
    viewerTenant: OWNER,
    userId: "a-colleague",
    target: laptop,
    botId: "bot-1",
  });
  const click = JSON.stringify({ type: "mouse", event: "pressed", x: 1, y: 2 });
  const inputs = () => h.frames.filter((f) => f.type === "screen.input");

  h.screens.input(holder, click);
  expect(inputs()).toHaveLength(0);

  await take(h);
  h.screens.input(holder, click);
  expect(inputs()).toHaveLength(1);
  h.screens.input(other, click);
  expect(inputs()).toHaveLength(1);
  expect(sent.at(-1)).toEqual({ type: "error", error: TAKE_CONTROL_FIRST });
});

test("closing the holder's last screen hands the wheel back after the grace, and a quick reconnect keeps it", async () => {
  const h = harness({ graceMs: 20 });
  const watch = {
    viewerTenant: OWNER,
    userId: OWNER,
    target: laptop,
    botId: "bot-1",
  };
  const first = { send: () => undefined };
  h.screens.subscribe(first, watch);
  const requestId = await take(h);

  // A dropped connection that comes back inside the grace keeps the wheel where it was.
  h.screens.unsubscribe(first);
  const second = { send: () => undefined };
  h.screens.subscribe(second, watch);
  await Bun.sleep(60);
  expect(h.takeovers.holder(laptop, "bot-1")).toBe(OWNER);
  expect(h.released).toEqual([]);

  // Closed for good: the Bot gets its browser back and may act.
  h.screens.unsubscribe(second);
  await Bun.sleep(60);
  expect(h.takeovers.holder(laptop, "bot-1")).toBeNull();
  expect(h.released).toEqual([requestId]);
  expect((await h.gateway.control("bot-1", requestId)).request?.status).toBe(
    "completed",
  );
  await h.gateway.runCommand("bot-1", ACTOR, { command: "pwd" });
  expect(h.actions()).toHaveLength(1);
});

test("a gateway without a takeover registry keeps posting handovers to the transport", async () => {
  const channel = createDeviceChannel();
  const frames: Record<string, unknown>[] = [];
  channel.attach(
    laptop,
    answeringSocket(() => channel, laptop, frames),
  );
  const gateway = createComputerGateway({
    provider: createDeviceComputerProvider(),
    auditStore: { insert: async () => undefined },
    policy: () => PERMISSIVE,
    transport: createRunnerTransport(channel),
    resolveDevice: async () => laptop,
  });
  await gateway.control("bot-1");
  expect(frames.map((frame) => frame.action)).toEqual(["control"]);
});
