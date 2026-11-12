import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DESKTOP_LIMITS,
  type DesktopErrorCode,
  desktopMessage,
} from "../../shared/desktop-control";
import { createDesktopActions } from "../src/desktop/actions";
import type { AgentDesktopReader } from "../src/desktop/ad-read";
import type { AgentDesktopCli } from "../src/desktop/agent-desktop";
import {
  CONTROL_LINE_PREFIX,
  createControlChannel,
  NO_CONTROL,
} from "../src/desktop/control";
import { DesktopHelperError } from "../src/desktop/host";
import { createDesktopSessions } from "../src/desktop/session";
import { desktopControlFor, heartbeatFrame, parseArgs } from "../src/index";

/* The device-authoritative desktop session and the control channel to the device app (plan
   docs/plans/2026-11-12-desktop-write.md, Task 13, with the readiness handshake of ruling C5). The
   channel runs over an in-memory line queue standing in for the runner's stdin and stdout. */

const TOKEN = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const labelOf = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 8);

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** An in-memory stdin: lines pushed here reach the channel in order. */
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

type DeviceOptions = {
  /** How the device answers `session-started`: ready (default), failed, a wrong label, or nothing. */
  ready?: "ready" | "failed" | "wrong-label" | "none";
  /** Whether it answers `headed-begin` with an ack (default yes). */
  ack?: boolean;
  ackMs?: number;
  readyMs?: number;
};

/** A channel whose far end behaves like the device app; `out` is everything written to stdout. */
function device(options: DeviceOptions = {}) {
  const queue = lineQueue();
  const out: string[] = [];
  const events = (): Record<string, unknown>[] =>
    out
      .filter((line) => line.startsWith(CONTROL_LINE_PREFIX))
      .map((line) => JSON.parse(line.slice(CONTROL_LINE_PREFIX.length)));
  const control = createControlChannel({
    lines: queue.lines,
    write: (line) => {
      out.push(line);
      if (!line.startsWith(CONTROL_LINE_PREFIX)) return;
      const event = JSON.parse(line.slice(CONTROL_LINE_PREFIX.length));
      if (event.event === "session-started") {
        const ready = options.ready ?? "ready";
        if (ready === "ready")
          queue.push(
            JSON.stringify({ control: "session-ready", label: event.label }),
          );
        if (ready === "failed")
          queue.push(
            JSON.stringify({
              control: "session-failed",
              label: event.label,
              reason: "hotkey taken",
            }),
          );
        if (ready === "wrong-label")
          queue.push(
            JSON.stringify({ control: "session-ready", label: "00000000" }),
          );
      }
      if (event.event === "headed-begin" && options.ack !== false)
        queue.push(JSON.stringify({ control: "headed-ack", seq: event.seq }));
    },
    ...(options.ackMs === undefined ? {} : { ackMs: options.ackMs }),
    ...(options.readyMs === undefined ? {} : { readyMs: options.readyMs }),
  });
  return { control, queue, out, events };
}

function fakeReader(): AgentDesktopReader {
  return {
    prefix: "abc123",
    windows: async () => {
      throw new Error("unexpected windows");
    },
    snapshot: async () => {
      throw new Error("unexpected snapshot");
    },
    resolveRef: () => "stale",
    adWindow: () => undefined,
    invalidate: () => {},
  };
}

/** A CLI that only answers `permissions`, with the accessibility state given. */
function fakeCli(state: () => string): AgentDesktopCli & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push([...args]);
      if (args[0] !== "permissions") throw new Error(`unexpected ${args[0]}`);
      // FACTS: `permissions` answers { accessibility: { state }, automation, screen_recording }.
      return {
        accessibility: { state: state() },
        automation: { state: "unknown" },
        screen_recording: { state: "granted" },
      };
    },
    ensureReady: async () => {},
    wipeState: async () => {},
    close: async () => {},
  };
}

type Out = { ok: boolean; output?: unknown; error?: string };

function refused(code: DesktopErrorCode) {
  return { ok: false as const, error: desktopMessage(code) };
}

const roots = { reported: () => [] };

describe("desktop sessions (runner)", () => {
  test("status is writable only on macOS (or Windows on agent-desktop) with a control channel", async () => {
    const status = async (
      actions: ReturnType<typeof createDesktopActions>,
    ): Promise<Out> =>
      actions("desktop.session_status", { botId: "bot-1", actorId: "u-1" });

    const linux = createDesktopActions({
      platform: "linux",
      engine: "agent-desktop",
      reader: fakeReader(),
      control: device().control,
    });
    expect(await status(linux)).toEqual({
      ok: true,
      output: {
        writable: false,
        reason: desktopMessage("read_only_linux"),
        platform: "linux",
      },
    });

    const legacy = createDesktopActions({
      platform: "win32",
      engine: "legacy",
      control: device().control,
    });
    expect(await status(legacy)).toEqual({
      ok: true,
      output: {
        writable: false,
        reason: desktopMessage("read_only_windows"),
        platform: "windows",
      },
    });

    const granted = fakeCli(() => "granted");
    const noChannel = createDesktopActions({
      platform: "darwin",
      engine: "agent-desktop",
      reader: fakeReader(),
      cli: granted,
    });
    expect(await status(noChannel)).toEqual({
      ok: true,
      output: {
        writable: false,
        reason: desktopMessage("no_control_channel"),
        platform: "macos",
      },
    });
    // Nothing is asked of agent-desktop when the answer is already no.
    expect(granted.calls).toEqual([]);

    let now = 1_000_000;
    let state = "denied";
    const denied = fakeCli(() => state);
    const mac = device();
    const macActions = createDesktopActions({
      platform: "darwin",
      engine: "agent-desktop",
      reader: fakeReader(),
      cli: denied,
      control: mac.control,
      now: () => now,
    });
    expect(await status(macActions)).toEqual({
      ok: true,
      output: {
        writable: false,
        reason: desktopMessage("mac_permission"),
        platform: "macos",
      },
    });
    // The device app is told, so it can bring its permission card up.
    expect(mac.events()).toEqual([{ event: "permission-needed" }]);
    expect(denied.calls).toEqual([["permissions"]]);
    // The answer is kept for ten seconds.
    state = "granted";
    now += 9_999;
    expect(
      ((await status(macActions)).output as { writable: boolean }).writable,
    ).toBe(false);
    expect(denied.calls).toHaveLength(1);
    now += 2;
    expect(await status(macActions)).toEqual({
      ok: true,
      output: { writable: true, platform: "macos" },
    });
    expect(denied.calls).toHaveLength(2);

    const windows = createDesktopActions({
      platform: "win32",
      engine: "agent-desktop",
      reader: fakeReader(),
      cli: fakeCli(() => {
        throw new Error("Windows needs no permission");
      }),
      control: device().control,
    });
    expect(await status(windows)).toEqual({
      ok: true,
      output: { writable: true, platform: "windows" },
    });

    // A refused start says the same as the status, and is never outcomeUnknown.
    for (const [actions, code] of [
      [linux, "read_only_linux"],
      [legacy, "read_only_windows"],
      [noChannel, "no_control_channel"],
    ] as const) {
      expect(
        await actions("desktop.session_start", {
          token: TOKEN,
          botId: "bot-1",
          actorId: "u-1",
        }),
      ).toEqual(refused(code));
    }
  });

  test("a started session checks ok, renews on use, expires after 15 idle minutes and after 60 minutes in all", async () => {
    let now = 0;
    const { control, events } = device();
    const sessions = createDesktopSessions({ control, now: () => now });
    const min = (m: number, s = 0) => (m * 60 + s) * 1000;

    expect(
      await sessions.start({ token: TOKEN, botId: "bot-1", actorId: "u-1" }),
    ).toBe(true);
    expect(sessions.status("bot-1", "u-1")).toEqual({ token: TOKEN });
    // Another bot or person does not see it, and cannot use it.
    expect(sessions.status("bot-2", "u-1")).toBeUndefined();
    expect(sessions.check(TOKEN, "bot-1", "u-2")).toBe("none");
    expect(sessions.check(OTHER, "bot-1", "u-1")).toBe("none");
    expect(sessions.check(42, "bot-1", "u-1")).toBe("none");

    now = min(14, 59);
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("ok");
    // Renewed at 14:59: idle again for 14:59 is still fine.
    now = min(29, 58);
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("ok");
    now = min(29, 58) + min(15, 1);
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("expired");
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("expired");
    expect(sessions.status("bot-1", "u-1")).toBeUndefined();
    expect(sessions.signal).toBeUndefined();
    expect(events().filter((e) => e.event === "session-ended")).toEqual([
      { event: "session-ended", reason: "expired" },
    ]);
    // Expiry is not a stop: nothing for the heartbeat.
    expect(sessions.takeStopped()).toBeUndefined();

    // Used every 14 minutes, it still ends at 60 minutes.
    now = 0;
    expect(
      await sessions.start({ token: OTHER, botId: "bot-1", actorId: "u-1" }),
    ).toBe(true);
    for (const m of [14, 28, 42, 56]) {
      now = min(m);
      expect(sessions.check(OTHER, "bot-1", "u-1")).toBe("ok");
    }
    now = min(59, 59);
    expect(sessions.check(OTHER, "bot-1", "u-1")).toBe("ok");
    now = min(60, 1);
    expect(sessions.check(OTHER, "bot-1", "u-1")).toBe("expired");
    expect(DESKTOP_LIMITS.sessionIdleMs as number).toBe(min(15));
    expect(DESKTOP_LIMITS.sessionMaxMs as number).toBe(min(60));
  });

  test("a stop from the channel ends the session, aborts its signal, and is reported once on the next heartbeat", async () => {
    let now = 5_000;
    const { control, queue, events } = device();
    const sessions = createDesktopSessions({ control, now: () => now });
    expect(
      await sessions.start({ token: TOKEN, botId: "bot-1", actorId: "u-1" }),
    ).toBe(true);
    const signal = sessions.signal;
    expect(signal?.aborted).toBe(false);
    // The runner beats again at once: a listener added after the sessions' sees the stop recorded.
    const beats: string[] = [];
    control.onStop(() =>
      beats.push(heartbeatFrame(roots, undefined, sessions.takeStopped())),
    );

    now = 7_000;
    queue.push(JSON.stringify({ control: "stop", reason: "hotkey" }));
    await tick();

    expect(signal?.aborted).toBe(true);
    expect(sessions.signal).toBeUndefined();
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("stopped");
    expect(sessions.status("bot-1", "u-1")).toBeUndefined();
    expect(events().at(-1)).toEqual({
      event: "session-ended",
      reason: "stopped",
    });
    expect(beats).toHaveLength(1);
    expect(JSON.parse(beats[0] as string)).toEqual({
      type: "heartbeat",
      roots: [],
      desktopStopped: {
        botId: "bot-1",
        actorId: "u-1",
        reason: "hotkey",
        at: 7_000,
      },
    });
    // Reported once: the next beat carries nothing.
    expect(sessions.takeStopped()).toBeUndefined();
    expect(
      JSON.parse(heartbeatFrame(roots, undefined, sessions.takeStopped())),
    ).toEqual({
      type: "heartbeat",
      roots: [],
    });
    // A stop with no session records nothing.
    queue.push(JSON.stringify({ control: "stop", reason: "mouse" }));
    await tick();
    expect(sessions.takeStopped()).toBeUndefined();
    expect(beats).toHaveLength(2);
    // Junk on stdin is ignored: no stop at all.
    queue.push("hello");
    queue.push(JSON.stringify({ control: "stop", reason: "elbow" }));
    await tick();
    expect(beats).toHaveLength(2);
  });

  test('a second start replaces the first, which then checks "none"', async () => {
    const { control, events } = device();
    const sessions = createDesktopSessions({ control });
    await sessions.start({ token: TOKEN, botId: "bot-1", actorId: "u-1" });
    const first = sessions.signal;
    await sessions.start({ token: OTHER, botId: "bot-2", actorId: "u-1" });
    expect(first?.aborted).toBe(true);
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("none");
    expect(sessions.check(OTHER, "bot-2", "u-1")).toBe("ok");
    expect(sessions.status("bot-1", "u-1")).toBeUndefined();
    expect(sessions.status("bot-2", "u-1")).toEqual({ token: OTHER });
    expect(events()).toEqual([
      { event: "session-started", label: labelOf(TOKEN) },
      { event: "session-ended", reason: "replaced" },
      { event: "session-started", label: labelOf(OTHER) },
    ]);
    sessions.end(OTHER);
    expect(sessions.check(OTHER, "bot-2", "u-1")).toBe("none");
    expect(events().at(-1)).toEqual({
      event: "session-ended",
      reason: "ended",
    });
    // Ending a token that is not the current session does nothing.
    sessions.end(TOKEN);
    expect(events()).toHaveLength(4);
  });

  test("stdout carries a short label, never the token", async () => {
    const mac = device();
    const actions = createDesktopActions({
      platform: "darwin",
      engine: "agent-desktop",
      reader: fakeReader(),
      cli: fakeCli(() => "granted"),
      control: mac.control,
    });
    const started = await actions("desktop.session_start", {
      token: TOKEN,
      botId: "bot-1",
      actorId: "u-1",
    });
    expect(started).toEqual({ ok: true, output: { started: true } });
    // The token goes back to the server over the socket, never to stdout.
    expect(
      await actions("desktop.session_status", {
        botId: "bot-1",
        actorId: "u-1",
      }),
    ).toEqual({
      ok: true,
      output: { writable: true, platform: "macos", session: { token: TOKEN } },
    });
    expect(await actions("desktop.session_end", { token: TOKEN })).toEqual({
      ok: true,
      output: { ended: true },
    });
    expect(mac.out.length).toBeGreaterThan(0);
    for (const line of mac.out) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toMatch(/[0-9a-f]{64}/);
    }
    expect(mac.events()).toEqual([
      { event: "session-started", label: labelOf(TOKEN) },
      { event: "session-ended", reason: "ended" },
    ]);
    // A token that is not 64 hex digits is refused before anything is said on stdout.
    const before = mac.out.length;
    for (const token of [TOKEN.toUpperCase(), "ab", 7, undefined])
      expect(
        (
          await actions("desktop.session_start", {
            token,
            botId: "bot-1",
            actorId: "u-1",
          })
        ).ok,
      ).toBe(false);
    expect(mac.out).toHaveLength(before);
  });

  test("headed waits for the ack; without one in 1 s nothing runs and the error is headed_unconfirmed", async () => {
    const quiet = device({ ack: false });
    let ran = 0;
    const started = Date.now();
    const error = await quiet.control
      .headed(async () => {
        ran += 1;
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    const waited = Date.now() - started;
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("headed_unconfirmed");
    expect((error as DesktopHelperError).message).toBe(
      "设备端没有确认暂停『动鼠标即停』，为安全起见没有执行这一步。",
    );
    expect(ran).toBe(0);
    expect(waited).toBeGreaterThanOrEqual(DESKTOP_LIMITS.headedAckMs - 50);
    expect(DESKTOP_LIMITS.headedAckMs).toBe(1_000);
    // The device is still told the pause is over.
    expect(quiet.events()).toEqual([
      { event: "headed-begin", seq: 1 },
      { event: "headed-end", seq: 1 },
    ]);

    const acked = device();
    expect(await acked.control.headed(async () => "done")).toBe("done");
    // headed-end goes out whether the run succeeds or not.
    await expect(
      acked.control.headed(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(acked.events()).toEqual([
      { event: "headed-begin", seq: 1 },
      { event: "headed-end", seq: 1 },
      { event: "headed-begin", seq: 2 },
      { event: "headed-end", seq: 2 },
    ]);

    // An ack for another step does not count.
    const wrong = lineQueue();
    const lines: string[] = [];
    const channel = createControlChannel({
      lines: wrong.lines,
      write: (line) => {
        lines.push(line);
        wrong.push(JSON.stringify({ control: "headed-ack", seq: 99 }));
      },
      ackMs: 100,
    });
    await expect(channel.headed(async () => 1)).rejects.toThrow(
      desktopMessage("headed_unconfirmed"),
    );

    await expect(NO_CONTROL.headed(async () => 1)).rejects.toThrow(
      desktopMessage("no_control_channel"),
    );
    expect(NO_CONTROL.available).toBe(false);
  });

  test("without --desktop-control every session_start is no_control_channel", async () => {
    const server = ["--server", "https://example.test"];
    const plain = parseArgs(server, {}, "/launch");
    if (typeof plain === "string") throw new Error(plain);
    expect(plain.desktop.control).toBeUndefined();
    expect(desktopControlFor(plain)).toBe(NO_CONTROL);
    const stdio = parseArgs(
      [...server, "--desktop-control", "stdio"],
      {},
      "/launch",
    );
    if (typeof stdio === "string") throw new Error(stdio);
    expect(stdio.desktop.control).toBe("stdio");
    expect(
      parseArgs([...server, "--desktop-control", "tcp"], {}, "/launch"),
    ).toBe("--desktop-control must be stdio.");

    for (const platform of ["darwin", "win32"]) {
      const cli = fakeCli(() => "granted");
      const actions = createDesktopActions({
        platform,
        engine: "agent-desktop",
        reader: fakeReader(),
        cli,
      });
      const outcome = await actions("desktop.session_start", {
        token: TOKEN,
        botId: "bot-1",
        actorId: "u-1",
      });
      expect(outcome).toEqual(refused("no_control_channel"));
      expect(cli.calls).toEqual([]);
    }
  });
});

describe("the device confirms its guard before a session is writable (ruling C5)", () => {
  function mac(options: DeviceOptions) {
    const far = device(options);
    const sessions = createDesktopSessions({ control: far.control });
    const actions = createDesktopActions({
      platform: "darwin",
      engine: "agent-desktop",
      reader: fakeReader(),
      cli: fakeCli(() => "granted"),
      control: far.control,
      sessions,
    });
    const start = () =>
      actions("desktop.session_start", {
        token: TOKEN,
        botId: "bot-1",
        actorId: "u-1",
      });
    return { ...far, sessions, actions, start };
  }

  test("a session-ready within 2 s makes the session writable", async () => {
    const { start, sessions, events } = mac({ ready: "ready" });
    expect(await start()).toEqual({ ok: true, output: { started: true } });
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("ok");
    expect(events()).toEqual([
      { event: "session-started", label: labelOf(TOKEN) },
    ]);
  });

  test("no session-ready in 2 s: guard_unready, the session is ended, and it checks none", async () => {
    const { start, sessions, events, control } = mac({ ready: "none" });
    const pending = start();
    await tick();
    // Not writable while the device has not confirmed.
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("none");
    expect(sessions.status("bot-1", "u-1")).toBeUndefined();
    const began = Date.now();
    const outcome = await pending;
    expect(Date.now() - began).toBeGreaterThan(
      DESKTOP_LIMITS.sessionReadyMs - 200,
    );
    expect(DESKTOP_LIMITS.sessionReadyMs).toBe(2_000);
    expect(outcome).toEqual({
      ok: false,
      error: "设备端没能显示提示条或注册停止键，为安全起见没有开始操作。",
    });
    expect(outcome).toEqual(refused("guard_unready"));
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("none");
    expect(sessions.signal).toBeUndefined();
    expect(events()).toEqual([
      { event: "session-started", label: labelOf(TOKEN) },
      { event: "session-ended", reason: "ended" },
    ]);
    expect(control.available).toBe(true);
  });

  test("a session-failed is the same refusal, at once", async () => {
    const { start, sessions, events } = mac({ ready: "failed" });
    const began = Date.now();
    expect(await start()).toEqual(refused("guard_unready"));
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("none");
    expect(events()).toEqual([
      { event: "session-started", label: labelOf(TOKEN) },
      { event: "session-ended", reason: "ended" },
    ]);
  });

  test("a session-ready with another label is ignored", async () => {
    const { start, sessions, events } = mac({
      ready: "wrong-label",
      readyMs: 200,
    });
    expect(await start()).toEqual(refused("guard_unready"));
    expect(sessions.check(TOKEN, "bot-1", "u-1")).toBe("none");
    expect(events().at(-1)).toEqual({
      event: "session-ended",
      reason: "ended",
    });
  });
});
