import { expect, test } from "bun:test";
import type { ScreencastFrameEvent } from "../../agent-computer/src/screencast-session";
import { createRunnerScreens } from "../../runner/src/screencast";
import { createDeviceChannel } from "../src/devices/channel";
import {
  createDeviceScreens,
  DEVICE_AWAY,
  NOT_YOUR_SCREEN,
  ScreenRefusedError,
  TAKE_CONTROL_FIRST,
} from "../src/devices/screen";
import { runnerMessage, runnerOpen } from "../src/devices/socket";

/**
 * The relay between a runner's screen and the people watching it (F2 stage 2, R-a).
 *
 * No database: what is pinned is whose frames reach whom. A viewer is admitted only for its own
 * tenant's device, a frame is keyed by the socket it came up rather than anything it says, and input
 * goes down only for the person holding the wheel.
 */

const deviceA = { tenantId: "tenant-a", deviceId: "laptop-1" };

function runnerSocket() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    socket: { send: (value: string) => sent.push(JSON.parse(value)) },
  };
}

function viewer(buffered = 0) {
  const got: Record<string, unknown>[] = [];
  return {
    got,
    socket: {
      send: (value: string) => got.push(JSON.parse(value)),
      getBufferedAmount: () => buffered,
    },
  };
}

function relay(holder: string | null = null) {
  const channel = createDeviceChannel();
  const runner = runnerSocket();
  const connection = channel.attach(deviceA, runner.socket);
  const gone: string[] = [];
  const screens = createDeviceScreens({
    notify: (target, frame) => channel.notify(target, frame),
    holderOf: () => holder,
    onViewerGone: (watch) => gone.push(watch.userId),
  });
  return { channel, runner, connection, screens, gone };
}

const watchA = {
  viewerTenant: "tenant-a",
  userId: "tenant-a",
  target: deviceA,
  botId: "bot-1",
};

const picture = {
  type: "screen.frame",
  botId: "bot-1",
  data: "SlBFRw==",
  width: 1280,
  height: 800,
};

test("a viewer of the device's own tenant starts the cast and receives its frames", () => {
  const { runner, screens } = relay();
  const v = viewer();
  screens.subscribe(v.socket, watchA);
  expect(runner.sent).toEqual([
    { type: "screen.start", tenantId: "tenant-a", botId: "bot-1" },
  ]);
  expect(screens.fromRunner(deviceA, picture)).toBeTrue();
  expect(v.got).toEqual([
    { type: "frame", data: "SlBFRw==", width: 1280, height: 800 },
  ]);
  screens.fromRunner(deviceA, {
    type: "screen.status",
    botId: "bot-1",
    state: "idle",
  });
  expect(v.got.at(-1)).toEqual({ type: "status", state: "idle" });
});

test("another tenant subscribing to the same deviceId's screen is refused, and nothing is cast", () => {
  const { runner, screens } = relay();
  const v = viewer();
  expect(() =>
    screens.subscribe(v.socket, {
      ...watchA,
      viewerTenant: "tenant-b",
      userId: "tenant-b",
    }),
  ).toThrow(new ScreenRefusedError(NOT_YOUR_SCREEN));
  expect(runner.sent).toEqual([]);
  // And the device's own frames never reach the refused socket.
  screens.fromRunner(deviceA, picture);
  expect(v.got).toEqual([]);
  expect(screens.viewers(deviceA, "bot-1")).toBe(0);
});

test("a frame is keyed by the runner it came from, never by what it says", () => {
  const { screens } = relay();
  const v = viewer();
  screens.subscribe(v.socket, watchA);
  // Same device id and Bot, another tenant's machine: not this viewer's screen.
  screens.fromRunner({ tenantId: "tenant-b", deviceId: "laptop-1" }, picture);
  // Same tenant, another machine.
  screens.fromRunner({ tenantId: "tenant-a", deviceId: "laptop-2" }, picture);
  // A frame naming a tenant inside it changes nothing.
  screens.fromRunner(
    { tenantId: "tenant-b", deviceId: "laptop-9" },
    { ...picture, tenantId: "tenant-a", deviceId: "laptop-1" },
  );
  // Another Bot on the right machine, which nobody is watching.
  screens.fromRunner(deviceA, { ...picture, botId: "bot-2" });
  expect(v.got).toEqual([]);
});

test("malformed runner frames are consumed and never relayed", () => {
  const { screens } = relay();
  const v = viewer();
  screens.subscribe(v.socket, watchA);
  expect(screens.fromRunner(deviceA, { ...picture, width: -1 })).toBeTrue();
  expect(screens.fromRunner(deviceA, { ...picture, data: 42 })).toBeTrue();
  expect(
    screens.fromRunner(deviceA, { ...picture, data: "x".repeat(4_200_000) }),
  ).toBeTrue();
  expect(screens.fromRunner(deviceA, { type: "result", id: "1" })).toBeFalse();
  expect(v.got).toEqual([]);
});

test("a viewer whose socket is backed up skips a frame instead of queueing it", () => {
  const { screens } = relay();
  const slow = viewer(10 * 1024 * 1024);
  const fast = viewer();
  screens.subscribe(slow.socket, watchA);
  screens.subscribe(fast.socket, watchA);
  screens.fromRunner(deviceA, picture);
  expect(slow.got.filter((m) => m.type === "frame")).toHaveLength(0);
  expect(fast.got.filter((m) => m.type === "frame")).toHaveLength(1);
});

test("the last viewer to leave stops the cast; a reconnecting runner is asked to start again", () => {
  const { runner, screens, channel, gone } = relay();
  const one = viewer();
  const two = viewer();
  screens.subscribe(one.socket, watchA);
  screens.subscribe(two.socket, { ...watchA, userId: "someone-else" });
  screens.unsubscribe(one.socket);
  expect(runner.sent.filter((f) => f.type === "screen.stop")).toHaveLength(0);
  expect(gone).toEqual(["tenant-a"]);

  // The runner reconnects: the cast somebody is still watching starts again on the new socket.
  const again = runnerSocket();
  channel.attach(deviceA, again.socket);
  screens.resume(deviceA);
  expect(again.sent).toEqual([
    { type: "screen.start", tenantId: "tenant-a", botId: "bot-1" },
  ]);

  screens.unsubscribe(two.socket);
  expect(again.sent.at(-1)).toEqual({ type: "screen.stop", botId: "bot-1" });
  expect(screens.viewers(deviceA, "bot-1")).toBe(0);
});

test("a viewer of a machine that is away is told so, and stays to get the screen when it is back", () => {
  const channel = createDeviceChannel();
  const screens = createDeviceScreens({
    notify: (target, frame) => channel.notify(target, frame),
  });
  const v = viewer();
  screens.subscribe(v.socket, watchA);
  expect(v.got).toEqual([{ type: "error", error: DEVICE_AWAY }]);
  const runner = runnerSocket();
  channel.attach(deviceA, runner.socket);
  screens.resume(deviceA);
  expect(runner.sent).toEqual([
    { type: "screen.start", tenantId: "tenant-a", botId: "bot-1" },
  ]);
});

test("watching is not driving: input goes down only for the person holding the wheel", () => {
  const watcher = relay(null);
  const v = viewer();
  watcher.screens.subscribe(v.socket, watchA);
  const key = JSON.stringify({ type: "text", text: "hello" });
  watcher.screens.input(v.socket, key);
  expect(v.got.at(-1)).toEqual({ type: "error", error: TAKE_CONTROL_FIRST });
  expect(
    watcher.runner.sent.filter((f) => f.type === "screen.input"),
  ).toHaveLength(0);

  const driver = relay("tenant-a");
  const d = viewer();
  driver.screens.subscribe(d.socket, watchA);
  driver.screens.input(d.socket, key);
  expect(driver.runner.sent.at(-1)).toEqual({
    type: "screen.input",
    botId: "bot-1",
    input: { type: "text", text: "hello" },
  });
  // Shape is checked before anything goes down.
  driver.screens.input(d.socket, JSON.stringify({ type: "text" }));
  driver.screens.input(d.socket, "not json");
  expect(
    driver.runner.sent.filter((f) => f.type === "screen.input"),
  ).toHaveLength(1);
  expect(d.got.slice(-2)).toEqual([
    { type: "error", error: "A text message needs text." },
    { type: "error", error: "Input is not JSON." },
  ]);
});

test("the runner socket relays screen frames only while it is the device's live connection", async () => {
  const { channel, connection, screens } = relay();
  const v = viewer();
  screens.subscribe(v.socket, watchA);
  // The database is never asked for a screen frame; a store that would throw proves it.
  const store = {
    isCurrent: async () => {
      throw new Error("asked the database for a frame");
    },
  } as never;
  const ws = {
    data: {
      runner: { ...deviceA, id: "row-1", credentialVersion: "v1" },
      connection,
    },
    send: () => undefined,
  };
  await runnerMessage(ws, store, channel, JSON.stringify(picture), screens);
  expect(v.got).toHaveLength(1);
  // Replaced by a reconnect: the old socket's frames are dropped.
  channel.attach(deviceA, runnerSocket().socket);
  await runnerMessage(ws, store, channel, JSON.stringify(picture), screens);
  expect(v.got).toHaveLength(1);
});

test("a runner opening asks for the screens still being watched", async () => {
  const v = viewer();
  const channel = createDeviceChannel();
  const reopened = runnerSocket();
  const store = {
    isCurrent: async () => true,
    heartbeat: async () => undefined,
  } as never;
  const fresh = createDeviceScreens({
    notify: (target, frame) => channel.notify(target, frame),
  });
  fresh.subscribe(v.socket, watchA);
  await runnerOpen(
    {
      data: { runner: { ...deviceA, id: "row-1", credentialVersion: "v1" } },
      send: reopened.socket.send,
    },
    store,
    channel,
    fresh,
  );
  expect(reopened.sent).toContainEqual({
    type: "screen.start",
    tenantId: "tenant-a",
    botId: "bot-1",
  });
});

/**
 * Loopback latency, end to end through real sockets: the runner's own screen module with a fake CDP
 * session, its frames up a real WebSocket to this relay, and out of a second real WebSocket to a
 * viewer. Evidence for acceptance criterion 1 on one machine; the LAN figure is measured by hand (G5).
 */
test("loopback frame latency P95 is under one second", async () => {
  const channel = createDeviceChannel();
  const screens = createDeviceScreens({
    notify: (target, frame) => channel.notify(target, frame),
  });
  type Data = { role: "runner" | "viewer"; connection?: string };
  const server = Bun.serve<Data>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      const role =
        new URL(request.url).pathname === "/runner" ? "runner" : "viewer";
      return srv.upgrade(request, { data: { role } })
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.role === "runner") {
          ws.data.connection = channel.attach(deviceA, ws);
          screens.resume(deviceA);
        } else screens.subscribe(ws, watchA);
      },
      message(ws, raw) {
        if (ws.data.role !== "runner") return;
        const frame = JSON.parse(String(raw));
        if (ws.data.connection && channel.isAttached(ws.data.connection))
          screens.fromRunner(deviceA, frame);
      },
      close(ws) {
        if (ws.data.role === "viewer") screens.unsubscribe(ws);
        else if (ws.data.connection) channel.detach(ws.data.connection);
      },
    },
  });
  const base = `ws://127.0.0.1:${server.port}`;
  const opened = (socket: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("socket failed"));
    });

  // The device: the runner's real screen module, casting a page whose CDP session is a fake.
  let emit: ((event: ScreencastFrameEvent) => void) | undefined;
  const page = {
    isClosed: () => false,
    screencastClient: async () => ({
      on: (_: string, listener: (event: ScreencastFrameEvent) => void) => {
        emit = listener;
      },
      send: async () => undefined,
      detach: async () => undefined,
    }),
  };
  const runnerWs = new WebSocket(`${base}/runner`);
  const runnerScreens = createRunnerScreens({
    source: { livePage: () => page },
    send: (frame) => runnerWs.send(JSON.stringify(frame)),
    buffered: () => runnerWs.bufferedAmount,
    followMs: 60_000,
  });
  const casting = new Promise<void>((resolve) => {
    runnerWs.onmessage = (event) => {
      void runnerScreens.handle(JSON.parse(String(event.data))).then(() => {
        if (emit) resolve();
      });
    };
  });
  await opened(runnerWs);

  // A frame about the size of a real 1280x800 JPEG, with its sequence number up front.
  const padding = "x".repeat(90_000);
  const sentAt = new Map<number, number>();
  const latencies: number[] = [];
  const FRAMES = 120;
  const viewerWs = new WebSocket(`${base}/viewer`);
  const all = new Promise<void>((resolve) => {
    viewerWs.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== "frame") return;
      const seq = Number(
        Buffer.from(message.data, "base64").toString("utf8").split("|")[0],
      );
      const at = sentAt.get(seq);
      if (at !== undefined) latencies.push(performance.now() - at);
      if (latencies.length === FRAMES) resolve();
    };
  });
  await opened(viewerWs);
  await casting;

  try {
    for (let seq = 0; seq < FRAMES; seq += 1) {
      sentAt.set(seq, performance.now());
      emit?.({
        data: Buffer.from(`${seq}|${padding}`).toString("base64"),
        sessionId: seq,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      });
      // Roughly a page that is changing all the time: 30 frames a second.
      await Bun.sleep(33);
    }
    await Promise.race([all, Bun.sleep(15_000)]);
    // Every frame got through: at this rate on loopback nothing should have been dropped.
    expect(latencies.length).toBe(FRAMES);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
    console.info(
      JSON.stringify({
        type: "device-screen-loopback-latency",
        frames: sorted.length,
        p50Ms: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2)),
        p95Ms: Number(p95.toFixed(2)),
      }),
    );
    expect(p95).toBeLessThan(1000);
  } finally {
    await runnerScreens.stopAll();
    runnerWs.close();
    viewerWs.close();
    server.stop(true);
  }
}, 30_000);
