import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_CLIPBOARD_NOT_KEPT,
  DESKTOP_LIMITS,
  DESKTOP_SELF_WINDOW_REASON,
  type DesktopPlatform,
  desktopMessage,
  desktopSelfOrTerminalProcess,
} from "../../shared/desktop-control";
import { createDesktopActions } from "../src/desktop/actions";
import { createAgentDesktopReader } from "../src/desktop/ad-read";
import { createAgentDesktopWriter } from "../src/desktop/ad-write";
import {
  type AgentDesktopCli,
  createAgentDesktopCli,
} from "../src/desktop/agent-desktop";
import {
  CONTROL_LINE_PREFIX,
  createControlChannel,
} from "../src/desktop/control";
import { createDesktopHost } from "../src/desktop/host";
import { createDesktopSessions } from "../src/desktop/session";
import { createRunnerExecutor } from "../src/execute";
import { createActionJournal } from "../src/journal";

/* The four desktop writes on agent-desktop (plan docs/plans/2026-11-12-desktop-write.md, Task 21):
   the real CLI layer and reader over the fake binary, a real session over an in-memory channel whose
   far end behaves like the device app. */

const FAKE = join(import.meta.dir, "fixtures", "fake-agent-desktop.ts");
const SAMPLES = join(import.meta.dir, "fixtures", "agent-desktop");

const TOKEN = "ab".repeat(32);
const BOT = "bot-1";
const ACTOR = "u-1";
const NOTE = "The window may have changed: read it again before the next step.";
const UNKNOWN = desktopMessage("outcome_unknown");
const WRITES: ReadonlySet<string> = new Set([
  "click",
  "type",
  "set-value",
  "clear",
  "press",
  "focus-window",
]);

const sample = (platform: string, key: string) =>
  JSON.parse(readFileSync(join(SAMPLES, `${platform}.json`), "utf8"))[key];

const fail = (error: string) => ({ ok: false as const, error });
const unknown = { ok: false as const, error: UNKNOWN, outcomeUnknown: true };

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(check: () => boolean, ms = 5_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await tick();
  }
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

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

/*
 * The Windows samples measured on CI are a form hosted by powershell.exe and Windows Terminal's own
 * windows: terminals to the final review's rule (C1), so every write there is asked about. The tests
 * of everything else read them as the plain windows they were measured as; the C1 tests use the
 * real rule (`desktopSelfOrTerminalProcess`).
 */
const SAMPLE_HOSTS: ReadonlySet<string> = new Set([
  "powershell.exe",
  "WindowsTerminal.exe",
]);
const SAMPLE_RULE = (process: string) =>
  !SAMPLE_HOSTS.has(process) && desktopSelfOrTerminalProcess(process);

type Command = Record<string, unknown>;
type Script = { platform?: string; commands?: Record<string, Command> };
type Entry = { args: string[]; stdin?: string; prevAlive: number[] };

/**
 * A writer on the real CLI layer and reader, driving the fake binary, with a session whose clock the
 * test moves. `trace` is the headed handshake as the device saw it: begin, its ack, end.
 */
function setup(
  platform: DesktopPlatform,
  commands: Record<string, Command> = {},
  options: {
    ack?: boolean;
    ackMs?: number;
    /** Stands between the writer and the CLI, for an event no binary can time (an abort just so). */
    wrapCli?: (cli: AgentDesktopCli) => AgentDesktopCli;
    /** The writer's process rule (default: `SAMPLE_RULE`). */
    selfOrTerminal?: (process: string) => boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ad-write-"));
  const logPath = join(root, "log.jsonl");
  writeFileSync(logPath, "");
  const script: Script = {
    platform,
    commands: {
      "list-windows": { sample: "list-windows" },
      "list-displays": { sample: "list-displays" },
      snapshot: { sample: "snapshot-password" },
      ...commands,
    },
  };
  const spawn = ((cmd: string[], opts: { env?: Record<string, string> }) =>
    Bun.spawn(["bun", FAKE, ...cmd.slice(1)], {
      ...opts,
      env: {
        ...opts.env,
        FAKE_AD_SCRIPT: JSON.stringify(script),
        FAKE_AD_LOG: logPath,
      },
    } as never)) as unknown as typeof Bun.spawn;
  const cli = createAgentDesktopCli({
    binary: "agent-desktop",
    stateDir: join(root, "state"),
    spawn,
  });
  const reader = createAgentDesktopReader({ cli, platform });

  const queue = lineQueue();
  const trace: string[] = [];
  const control = createControlChannel({
    lines: queue.lines,
    write: (line) => {
      if (!line.startsWith(CONTROL_LINE_PREFIX)) return;
      const event = JSON.parse(line.slice(CONTROL_LINE_PREFIX.length));
      if (event.event === "session-started")
        queue.push(
          JSON.stringify({ control: "session-ready", label: event.label }),
        );
      if (event.event === "headed-begin") {
        trace.push("begin");
        if (options.ack !== false) {
          trace.push("ack");
          queue.push(JSON.stringify({ control: "headed-ack", seq: event.seq }));
        }
      }
      if (event.event === "headed-end") trace.push("end");
    },
    ...(options.ackMs === undefined ? {} : { ackMs: options.ackMs }),
  });
  let time = 1_000_000;
  const now = () => time;
  const sessions = createDesktopSessions({ control, now });
  const writer = createAgentDesktopWriter({
    cli: options.wrapCli ? options.wrapCli(cli) : cli,
    reader,
    sessions,
    control,
    platform,
    now,
    selfOrTerminal: options.selfOrTerminal ?? SAMPLE_RULE,
  });
  cleanup.push(async () => {
    sessions.end(TOKEN);
    queue.close();
    await cli.close();
    rmSync(root, { recursive: true, force: true });
  });

  const entries = (): Entry[] =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry);
  const log = () => entries().map((entry) => entry.args);
  /** The write commands that reached the binary, in order, `--headed` kept. */
  const writes = () =>
    log().filter((args) =>
      WRITES.has(args.find((arg) => arg !== "--headed") ?? ""),
    );
  const set = (name: string, command: Command) => {
    script.commands = { ...script.commands, [name]: command };
  };
  const start = async () => {
    expect(
      await sessions.start({ token: TOKEN, botId: BOT, actorId: ACTOR }),
    ).toBe(true);
  };
  const write = (
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    botId = BOT,
  ) =>
    writer(
      action,
      {
        session: TOKEN,
        actorId: ACTOR,
        approved: false,
        actionWords: [],
        ...body,
      },
      signal,
      { botId },
    );
  const advance = (ms: number) => {
    time += ms;
  };
  return {
    cli,
    reader,
    control,
    sessions,
    queue,
    trace,
    entries,
    log,
    writes,
    set,
    start,
    write,
    advance,
  };
}

type Setup = ReturnType<typeof setup>;

/** Lists the windows and reads the first one (or `index`). */
async function read(t: Setup, index = 0) {
  const { windows } = await t.reader.windows();
  const window = windows[index];
  if (!window) throw new Error("no window listed");
  const snap = await t.reader.snapshot({ windowId: window.windowId });
  const el = (name: string) => {
    const element = snap.elements.find((e) => e.name === name);
    if (!element) throw new Error(`no element ${name}`);
    return element;
  };
  return { windows, window, snap, el };
}

/** The agent-desktop ref a runner ref resolves to. */
function adRef(t: Setup, ref: string): string {
  const resolved = t.reader.resolveRef(ref);
  if (typeof resolved === "string") throw new Error(resolved);
  return resolved.adRef;
}

function output<T = Record<string, unknown>>(outcome: {
  ok: boolean;
  output?: unknown;
  error?: string;
}): T {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error}`);
  return outcome.output as T;
}

const stdinOf = (entry: Entry | undefined) =>
  entry?.stdin === undefined
    ? undefined
    : Buffer.from(entry.stdin, "base64").toString("utf8");

const FOUR: Array<[string, Record<string, unknown>]> = [
  ["desktop.click", { ref: "abc123-1:1" }],
  ["desktop.type", { ref: "abc123-1:1", text: "x", mode: "append" }],
  ["desktop.key", { windowId: "a0123456789abcdef", keys: "ctrl+s" }],
  ["desktop.focus", { windowId: "a0123456789abcdef" }],
];

describe("desktop writes: refusals before anything runs", () => {
  test("linux and legacy windows refuse without running anything", async () => {
    const t = setup("linux");
    await t.start();
    for (const [action, body] of FOUR)
      expect(await t.write(action, body)).toEqual(
        fail(desktopMessage("read_only_linux")),
      );

    // Through the actions too, with the device app's channel.
    const linux = createDesktopActions({
      platform: "linux",
      engine: "agent-desktop",
      cli: t.cli,
      reader: t.reader,
      control: t.control,
      sessions: t.sessions,
    });
    const legacy = createDesktopActions({
      platform: "win32",
      control: t.control,
      sessions: t.sessions,
      host: createDesktopHost({
        spec: () => {
          throw new Error("must not start a helper");
        },
      }),
    });
    cleanup.push(() => legacy.close());
    for (const [action, body] of FOUR) {
      const payload = { session: TOKEN, actorId: ACTOR, ...body };
      expect(await linux(action, payload, undefined, { botId: BOT })).toEqual(
        fail(desktopMessage("read_only_linux")),
      );
      expect(await legacy(action, payload, undefined, { botId: BOT })).toEqual(
        fail(desktopMessage("read_only_windows")),
      );
    }
    expect(t.log()).toEqual([]);
  });

  test("no session, a stopped one or an expired one is refused with its copy", async () => {
    const t = setup("windows");
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const ran = t.log().length;

    expect(await t.write("desktop.click", { ref })).toEqual(
      fail(desktopMessage("no_session")),
    );
    await t.start();
    // Another coworker's write, or no token at all, is no session either.
    expect(await t.write("desktop.click", { ref }, undefined, "bot-2")).toEqual(
      fail(desktopMessage("no_session")),
    );
    expect(
      await t.write("desktop.focus", { session: undefined, windowId: "x" }),
    ).toEqual(fail(desktopMessage("no_session")));

    t.queue.push(JSON.stringify({ control: "stop", reason: "hotkey" }));
    await waitFor(() => t.sessions.signal === undefined);
    expect(await t.write("desktop.click", { ref })).toEqual(
      fail(desktopMessage("stopped")),
    );

    await t.start();
    t.advance(DESKTOP_LIMITS.sessionIdleMs + 1);
    expect(
      await t.write("desktop.type", { ref, text: "x", mode: "append" }),
    ).toEqual(fail(desktopMessage("session_expired")));
    expect(t.log().length).toBe(ran);
  });

  test("a ref from an older snapshot is stale and never reaches the binary", async () => {
    const t = setup("windows");
    await t.start();
    const first = await read(t);
    const latest = await t.reader.snapshot({ windowId: first.window.windowId });
    const ran = t.log().length;

    expect(
      await t.write("desktop.click", {
        ref: first.el("Send").ref,
        approved: true,
      }),
    ).toEqual(fail(desktopMessage("stale")));
    expect(
      await t.write("desktop.type", {
        ref: first.el("Single line").ref,
        text: "x",
        mode: "replace",
      }),
    ).toEqual(fail(desktopMessage("stale")));
    expect(await t.write("desktop.click", { ref: "nonsense" })).toEqual(
      fail(desktopMessage("stale")),
    );
    // The window itself (index 0) has no ref of agent-desktop's.
    expect(
      await t.write("desktop.click", { ref: latest.elements[0]?.ref }),
    ).toEqual(fail(desktopMessage("not_actionable")));
    // A window id that was never listed.
    expect(
      await t.write("desktop.focus", { windowId: "a0123456789abcdef" }),
    ).toEqual(fail(desktopMessage("no_window")));
    expect(t.log().length).toBe(ran);
  });
});

describe("desktop writes: the device checks again", () => {
  test("the device refuses a sensitive click it was not told was approved", async () => {
    const data = structuredClone(sample("windows", "snapshot-password").data);
    data.tree.children[4].name = "发送";
    const t = setup("windows", {
      snapshot: {
        envelope: { version: "2.6", ok: true, command: "snapshot", data },
      },
    });
    await t.start();
    const { el } = await read(t);
    const ref = el("发送").ref;

    expect(
      await t.write("desktop.click", {
        ref,
        approved: false,
        actionWords: ["发送"],
      }),
    ).toEqual(fail(desktopMessage("needs_approval", "控件名含「发送」")));
    // Blank words are dropped and nothing left means the default list, which has 发送 too.
    expect(
      await t.write("desktop.click", { ref, actionWords: ["", "  "] }),
    ).toEqual(fail(desktopMessage("needs_approval", "控件名含「发送」")));
    expect(t.writes()).toEqual([]);

    const done = await t.write("desktop.click", {
      ref,
      approved: true,
      actionWords: ["发送"],
    });
    expect(output(done).control).toEqual({ type: "button", name: "发送" });
    expect(t.writes()).toEqual([["click", "@snuvkeejknool:e5"]]);
  });

  test("a title that turned sensitive since the read is refused", async () => {
    const t = setup("windows");
    await t.start();
    const { el, window } = await read(t);
    const ref = el("Single line").ref;
    const turned = desktopMessage(
      "needs_approval",
      "窗口标题刚刚变成含「银行」，请重新列出窗口",
    );
    const listing = structuredClone(sample("windows", "list-windows"));
    listing.data[0].title = "XB Sample Form - 网上银行";
    t.set("list-windows", { envelope: listing });

    for (const approved of [false, true]) {
      expect(await t.write("desktop.click", { ref, approved })).toEqual(
        fail(turned),
      );
      expect(
        await t.write("desktop.key", {
          windowId: window.windowId,
          keys: "ctrl+s",
          approved,
        }),
      ).toEqual(fail(turned));
    }
    // The server approved the new title, but this device read the old one.
    expect(
      await t.write("desktop.focus", {
        windowId: window.windowId,
        approved: true,
        approvedTitle: "XB Sample Form - 网上银行",
      }),
    ).toEqual(fail(turned));
    expect(t.writes()).toEqual([]);

    // Listed again: the read knows the title now. Unapproved, the title is asked about; approved for
    // another title, it is refused; approved for this one, it goes through.
    await t.reader.windows();
    expect(
      await t.write("desktop.key", {
        windowId: window.windowId,
        keys: "ctrl+s",
      }),
    ).toEqual(fail(desktopMessage("needs_approval", "窗口标题含「银行」")));
    expect(
      await t.write("desktop.key", {
        windowId: window.windowId,
        keys: "ctrl+s",
        approved: true,
        approvedTitle: "XB Sample Form",
      }),
    ).toEqual(fail(turned));
    expect(t.writes()).toEqual([]);
    const done = await t.write("desktop.key", {
      windowId: window.windowId,
      keys: "ctrl+s",
      approved: true,
      approvedTitle: "XB Sample Form - 网上银行",
    });
    expect(output(done).window).toEqual({
      windowId: window.windowId,
      title: "XB Sample Form - 网上银行",
      process: "powershell.exe",
    });
  });

  test("a missing or blank live title needs approval; approved, it goes through", async () => {
    const t = setup("windows");
    await t.start();
    const { window } = await read(t);
    for (const title of ["", "   ", undefined]) {
      const listing = structuredClone(sample("windows", "list-windows"));
      listing.data[0].title = title;
      t.set("list-windows", { envelope: listing });
      expect(
        await t.write("desktop.focus", { windowId: window.windowId }),
      ).toEqual(fail(desktopMessage("needs_approval", "没能确认窗口的标题")));
    }
    expect(t.writes()).toEqual([]);
    const done = await t.write("desktop.focus", {
      windowId: window.windowId,
      approved: true,
    });
    expect(done.ok).toBe(true);
  });

  test("a password field is refused for type", async () => {
    for (const platform of ["windows", "macos"] as const) {
      const t = setup(platform);
      await t.start();
      const { snap } = await read(t);
      const password = snap.elements.find((e) => e.password);
      if (!password) throw new Error("no password field");
      for (const approved of [false, true])
        for (const mode of ["replace", "append"])
          expect(
            await t.write("desktop.type", {
              ref: password.ref,
              text: "secret",
              mode,
              approved,
            }),
          ).toEqual(fail(desktopMessage("password_field")));
      expect(t.writes()).toEqual([]);
    }
  });
});

describe("desktop writes: click", () => {
  test("click falls back to --headed only after not_delivered, inside headed-begin/ack/end", async () => {
    const t = setup("windows", {
      click: { error: "POLICY_DENIED" },
      "--headed click": { write: { delivery: "delivered_verified" } },
    });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);

    const done = output(await t.write("desktop.click", { ref }));
    expect(done.physical).toBe(true);
    expect(done.delivery).toBe("verified");
    expect(t.writes()).toEqual([
      ["click", target],
      ["--headed", "click", target],
    ]);
    expect(t.trace).toEqual(["begin", "ack", "end"]);
  });

  test("a device that does not confirm the pause runs nothing physical", async () => {
    const t = setup(
      "windows",
      {
        click: { error: "POLICY_DENIED" },
        "--headed click": { write: { delivery: "delivered_verified" } },
      },
      { ack: false, ackMs: 50 },
    );
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(await t.write("desktop.click", { ref })).toEqual(
      fail(desktopMessage("headed_unconfirmed")),
    );
    expect(t.writes()).toEqual([["click", target]]);
    expect(t.trace).toEqual(["begin", "end"]);
  });

  test("a not-delivered failure that is not about delivery itself is not tried again headed", async () => {
    const t = setup("windows", { click: { error: "STALE_REF" } });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(await t.write("desktop.click", { ref })).toEqual(
      fail(desktopMessage("stale")),
    );
    expect(t.writes()).toEqual([["click", target]]);
    expect(t.trace).toEqual([]);
  });

  test("click after a delivered-but-unverified failure is outcome_unknown and never retried", async () => {
    const t = setup("windows", {
      click: {
        write: { delivery: "delivered_unverified", error: "ACTION_FAILED" },
      },
    });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(await t.write("desktop.click", { ref })).toEqual(unknown);
    expect(t.writes()).toEqual([["click", target]]);
    expect(t.trace).toEqual([]);
    // What it did is unknown, so the window's refs are void.
    expect(t.reader.resolveRef(ref)).toBe("stale");
  });
});

describe("desktop writes: type", () => {
  test("type replace uses set-value --stdin with the exact bytes; append uses type then --headed type", async () => {
    const text = "héllo 熊宝 ✓ \t end";
    const t = setup("windows", {
      type: { error: "POLICY_DENIED" },
      "--headed type": { write: { delivery: "delivered_verified" } },
    });
    await t.start();

    let { el } = await read(t);
    let target = adRef(t, el("Single line").ref);
    // The tab is a control character, asked about since round 1: approved, so the bytes go as they are.
    const replaced = output(
      await t.write("desktop.type", {
        ref: el("Single line").ref,
        text,
        mode: "replace",
        approved: true,
      }),
    );
    expect(replaced.physical).toBe(false);
    expect(replaced.control).toEqual({
      type: "textfield",
      name: "Single line",
    });
    let writes = t.entries().filter((e) => WRITES.has(e.args[0] ?? ""));
    expect(writes.map((e) => e.args)).toEqual([
      ["set-value", target, "--stdin"],
    ]);
    expect(stdinOf(writes[0])).toBe(text);
    // Nothing of the text is on the command line.
    expect(JSON.stringify(t.log())).not.toContain("熊宝");

    ({ el } = await read(t));
    target = adRef(t, el("Single line").ref);
    const appended = output(
      await t.write("desktop.type", {
        ref: el("Single line").ref,
        text,
        mode: "append",
        approved: true,
      }),
    );
    expect(appended.physical).toBe(true);
    writes = t
      .entries()
      .filter((e) => WRITES.has(e.args.find((a) => a !== "--headed") ?? ""))
      .slice(1);
    expect(writes.map((e) => e.args)).toEqual([
      ["type", target, "--stdin"],
      ["--headed", "type", target, "--stdin"],
    ]);
    expect(writes.map(stdinOf)).toEqual([text, text]);
    expect(t.trace).toEqual(["begin", "ack", "end"]);
  });

  test("type replace falls back to clear and --headed type only after not_delivered", async () => {
    const t = setup("windows", {
      "set-value": { error: "POLICY_DENIED" },
      "--headed type": { write: { delivery: "delivered_verified" } },
    });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    const done = output(
      await t.write("desktop.type", { ref, text: "abc", mode: "replace" }),
    );
    expect(done.physical).toBe(true);
    expect(t.writes()).toEqual([
      ["set-value", target, "--stdin"],
      ["clear", target],
      ["--headed", "type", target, "--stdin"],
    ]);
  });

  test("clear succeeds, headed type fails: the outcome is unknown and the refs are void", async () => {
    const t = setup("windows", {
      "set-value": { error: "POLICY_DENIED" },
      "--headed type": {
        write: { delivery: "not_delivered", error: "POLICY_DENIED" },
      },
    });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(
      await t.write("desktop.type", { ref, text: "abc", mode: "replace" }),
    ).toEqual(unknown);
    expect(t.writes()).toEqual([
      ["set-value", target, "--stdin"],
      ["clear", target],
      ["--headed", "type", target, "--stdin"],
    ]);
    expect(t.reader.resolveRef(ref)).toBe("stale");
  });

  test("clear succeeds and the device does not confirm the pause: unknown as well", async () => {
    const t = setup(
      "windows",
      { "set-value": { error: "POLICY_DENIED" } },
      { ack: false, ackMs: 50 },
    );
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(
      await t.write("desktop.type", { ref, text: "abc", mode: "replace" }),
    ).toEqual(unknown);
    expect(t.writes()).toEqual([
      ["set-value", target, "--stdin"],
      ["clear", target],
    ]);
    expect(t.reader.resolveRef(ref)).toBe("stale");
  });

  test("a failed clear is not delivered and nothing is typed", async () => {
    const t = setup("windows", {
      "set-value": { error: "POLICY_DENIED" },
      clear: { error: "POLICY_DENIED" },
    });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(
      await t.write("desktop.type", { ref, text: "abc", mode: "replace" }),
    ).toEqual(fail(desktopMessage("policy_denied")));
    expect(t.writes()).toEqual([
      ["set-value", target, "--stdin"],
      ["clear", target],
    ]);
  });

  test("macOS types without a pointer: append is headless", async () => {
    const t = setup("macos");
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    const done = output(
      await t.write("desktop.type", { ref, text: "abc", mode: "append" }),
    );
    expect(done.physical).toBe(false);
    expect(t.writes()).toEqual([["type", target, "--stdin"]]);
    expect(t.trace).toEqual([]);
  });

  test("type with CR LF into a single-line field needs approval; approved, it goes through", async () => {
    const t = setup("windows");
    await t.start();
    let { el } = await read(t);
    const newline = desktopMessage(
      "needs_approval",
      "往单行输入框里输入带换行的文字",
    );
    for (const text of ["a\r\nb", "a\nb", "a\rb"])
      for (const mode of ["replace", "append"])
        expect(
          await t.write("desktop.type", {
            ref: el("Single line").ref,
            text,
            mode,
          }),
        ).toEqual(fail(newline));
    // Windows cannot tell a multi-line box apart: it is single-line here too.
    expect(
      await t.write("desktop.type", {
        ref: el("Multi line").ref,
        text: "a\nb",
        mode: "replace",
      }),
    ).toEqual(fail(newline));
    expect(t.writes()).toEqual([]);

    const done = await t.write("desktop.type", {
      ref: el("Single line").ref,
      text: "a\r\nb",
      mode: "replace",
      approved: true,
    });
    expect(done.ok).toBe(true);
    expect(stdinOf(t.entries().find((e) => e.args[0] === "set-value"))).toBe(
      "a\r\nb",
    );

    // A textfield inside a scrollarea (macOS) is multi-line: a newline goes in unasked.
    const mac = setup("macos");
    await mac.start();
    ({ el } = await read(mac));
    const multi = await mac.write("desktop.type", {
      ref: el("Multi line").ref,
      text: "a\nb",
      mode: "replace",
    });
    expect(multi.ok).toBe(true);
  });

  test("text longer than 9 000 bytes is refused; 9 000 bytes go through", async () => {
    const t = setup("windows");
    await t.start();
    let { el } = await read(t);
    expect(
      await t.write("desktop.type", {
        ref: el("Single line").ref,
        text: "熊".repeat(3_001),
        mode: "replace",
      }),
    ).toEqual(fail(desktopMessage("failed", "文字太长")));
    expect(
      await t.write("desktop.type", {
        ref: el("Single line").ref,
        text: "x",
        mode: "overwrite",
      }),
    ).toEqual(fail(desktopMessage("failed", "输入方式不对")));
    expect(t.writes()).toEqual([]);
    ({ el } = await read(t));
    const done = await t.write("desktop.type", {
      ref: el("Single line").ref,
      text: "熊".repeat(3_000),
      mode: "replace",
    });
    expect(done.ok).toBe(true);
  });
});

describe("desktop writes: key and focus", () => {
  test("key: enter without approval is needs_approval; alt+f4 approved carries --force; ctrl+s never does; win+r is system_keys", async () => {
    const t = setup("windows");
    await t.start();
    const { window } = await read(t);
    const windowId = window.windowId;
    const key = (keys: string, approved = false) =>
      t.write("desktop.key", { windowId, keys, approved });

    expect(await key("enter")).toEqual(
      fail(
        desktopMessage("needs_approval", "按 enter 可能会把内容提交或发送出去"),
      ),
    );
    expect(await key("alt+f4")).toEqual(
      fail(desktopMessage("needs_approval", "按 alt+f4 会关闭程序")),
    );
    for (const approved of [false, true]) {
      expect(await key("win+r", approved)).toEqual(
        fail(desktopMessage("system_keys", "win+r")),
      );
      // On Windows agent-desktop's cmd is the Windows key: cmd+r is win+r.
      expect(await key("cmd+r", approved)).toEqual(
        fail(desktopMessage("system_keys", "cmd+r")),
      );
    }
    expect(await key("ctrl+")).toEqual(
      fail(desktopMessage("failed", "按键格式不对")),
    );
    expect(t.writes()).toEqual([]);

    const pressed = output(await key("alt+f4", true));
    expect(pressed.physical).toBe(true);
    expect(await key("ctrl+s")).toMatchObject({ ok: true });
    expect(await key("ctrl+s", true)).toMatchObject({ ok: true });
    expect(await key("ctrl+w", true)).toMatchObject({ ok: true });
    expect(await key("Enter", true)).toMatchObject({ ok: true });
    expect(await key("win+up", true)).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([
      ["press", "alt+f4", "--window-id", "w-66058", "--force"],
      ["press", "ctrl+s", "--window-id", "w-66058"],
      ["press", "ctrl+s", "--window-id", "w-66058"],
      ["press", "ctrl+w", "--window-id", "w-66058"],
      ["press", "return", "--window-id", "w-66058"],
      ["press", "meta+up", "--window-id", "w-66058"],
    ]);
    // A key press is real keyboard input, but the pointer is not paused for it.
    expect(t.trace).toEqual([]);
  });

  test("key to a window that is not in front is not_foreground and nothing is pressed", async () => {
    const t = setup("windows");
    await t.start();
    const { windows } = await read(t);
    const behind = windows[1];
    if (!behind) throw new Error("no second window");
    expect(
      await t.write("desktop.key", {
        windowId: behind.windowId,
        keys: "ctrl+s",
      }),
    ).toEqual(fail(desktopMessage("not_foreground")));
    expect(t.writes()).toEqual([]);
  });

  test("focus brings a window to the front, through --headed only after POLICY_DENIED", async () => {
    const t = setup("windows");
    await t.start();
    const { windows } = await read(t);
    const behind = windows[1];
    if (!behind) throw new Error("no second window");
    const done = output(
      await t.write("desktop.focus", { windowId: behind.windowId }),
    );
    expect(done).toEqual({
      physical: false,
      durationMs: expect.any(Number),
      delivery: "verified",
      window: {
        windowId: behind.windowId,
        title: "Administrator: Windows PowerShell",
        process: "WindowsTerminal.exe",
      },
      note: NOTE,
    });
    expect(t.writes()).toEqual([["focus-window", "--window-id", "w-524752"]]);

    const h = setup("windows", {
      "focus-window": { error: "POLICY_DENIED" },
      "--headed focus-window": {
        envelope: {
          version: "2.6",
          ok: true,
          command: "focus-window",
          data: { focused: { is_focused: true } },
        },
      },
    });
    await h.start();
    const listed = await read(h);
    const target = listed.windows[1];
    if (!target) throw new Error("no second window");
    const headed = output(
      await h.write("desktop.focus", { windowId: target.windowId }),
    );
    expect(headed.physical).toBe(true);
    expect(h.writes()).toEqual([
      ["focus-window", "--window-id", "w-524752"],
      ["--headed", "focus-window", "--window-id", "w-524752"],
    ]);
    expect(h.trace).toEqual(["begin", "ack", "end"]);
  });
});

describe("desktop writes: stops, success and the queue", () => {
  test("a stop during the action aborts it and the outcome is unknown", async () => {
    const t = setup("windows", { click: { delayMs: 3_000 } });
    await t.start();
    let { el } = await read(t);
    const clicks = () => t.writes().filter((a) => a[0] === "click").length;

    const pending = t.write("desktop.click", { ref: el("Single line").ref });
    await waitFor(() => clicks() === 1);
    t.queue.push(JSON.stringify({ control: "stop", reason: "mouse" }));
    expect(await pending).toEqual(unknown);

    // The caller's own signal does the same.
    await t.start();
    ({ el } = await read(t));
    const controller = new AbortController();
    const second = t.write(
      "desktop.click",
      { ref: el("Single line").ref },
      controller.signal,
    );
    await waitFor(() => clicks() === 2);
    controller.abort();
    expect(await second).toEqual(unknown);
    expect(clicks()).toBe(2);
  }, 20_000);

  test("success invalidates that window's refs", async () => {
    const t = setup("windows");
    await t.start();
    const { el, window, windows } = await read(t);
    const other = windows[1];
    if (!other) throw new Error("no second window");
    const otherSnap = await t.reader.snapshot({ windowId: other.windowId });
    const otherRef = otherSnap.elements.find((e) => e.name === "Send")?.ref;
    const ref = el("Send").ref;

    t.advance(DESKTOP_LIMITS.sessionIdleMs - 1_000);
    const done = await t.write("desktop.click", { ref, approved: true });
    expect(done).toEqual({
      ok: true,
      output: {
        physical: false,
        durationMs: expect.any(Number),
        delivery: "verified",
        window: {
          windowId: window.windowId,
          title: "XB Sample Form",
          process: "powershell.exe",
        },
        control: { type: "button", name: "Send" },
        note: NOTE,
      },
    });
    expect(t.reader.resolveRef(ref)).toBe("stale");
    expect(typeof t.reader.resolveRef(otherRef as string)).toBe("object");
    expect(await t.write("desktop.click", { ref, approved: true })).toEqual(
      fail(desktopMessage("stale")),
    );
    // The write kept the session alive.
    t.advance(DESKTOP_LIMITS.sessionIdleMs - 1_000);
    expect(t.sessions.check(TOKEN, BOT, ACTOR)).toBe("ok");
  });

  test("writes are serial with reads", async () => {
    const t = setup("windows", {
      click: { delayMs: 300 },
      press: { delayMs: 300 },
      snapshot: { sample: "snapshot-password", delayMs: 300 },
    });
    await t.start();
    const { el, window } = await read(t);
    const outcomes = await Promise.all([
      t.write("desktop.click", { ref: el("Single line").ref }),
      t.reader.snapshot({ windowId: window.windowId }),
      t.write("desktop.key", { windowId: window.windowId, keys: "ctrl+s" }),
      t.reader.windows(),
    ]);
    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(outcomes[2]).toMatchObject({ ok: true });
    const entries = t.entries();
    expect(entries.filter((e) => WRITES.has(e.args[0] ?? ""))).toHaveLength(2);
    for (const entry of entries) expect(entry.prevAlive).toEqual([]);
  }, 20_000);

  test("the actions route the four writes to the writer with the transport's coworker", async () => {
    const t = setup("windows");
    const actions = createDesktopActions({
      platform: "win32",
      engine: "agent-desktop",
      cli: t.cli,
      reader: t.reader,
      control: t.control,
      sessions: t.sessions,
      selfOrTerminal: SAMPLE_RULE,
    });
    await t.start();
    const { window } = await read(t);
    const payload = {
      session: TOKEN,
      actorId: ACTOR,
      approved: false,
      actionWords: [],
      windowId: window.windowId,
    };
    // The coworker is the transport's, never the payload's.
    expect(
      await actions("desktop.focus", { ...payload, botId: BOT }, undefined, {
        botId: "bot-2",
      }),
    ).toEqual(fail(desktopMessage("no_session")));
    const done = await actions("desktop.focus", payload, undefined, {
      botId: BOT,
    });
    expect(done).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([["focus-window", "--window-id", "w-66058"]]);
  });
});

describe("desktop writes: round 1", () => {
  /** The Windows sample form with a textarea, a searchfield and a combobox added, and `name` for Send. */
  function form(send = "Send") {
    const data = structuredClone(sample("windows", "snapshot-password").data);
    data.tree.children[4].name = send;
    data.tree.children.push(
      { role: "textarea", name: "Notes", ref_id: "@snuvkeejknool:e11" },
      { role: "searchfield", name: "Search", ref_id: "@snuvkeejknool:e12" },
      { role: "combobox", name: "Pick", ref_id: "@snuvkeejknool:e13" },
    );
    return {
      snapshot: {
        envelope: { version: "2.6", ok: true, command: "snapshot", data },
      },
    };
  }

  test("space alone or with shift may press the selected button: asked unless approved", async () => {
    const t = setup("windows");
    await t.start();
    const { window } = await read(t);
    const key = (keys: string, approved = false) =>
      t.write("desktop.key", { windowId: window.windowId, keys, approved });
    const asked = fail(
      desktopMessage(
        "needs_approval",
        "这个按键可能会按下当前选中的按钮，需要你先确认",
      ),
    );
    expect(await key("space")).toEqual(asked);
    expect(await key("shift+space")).toEqual(asked);
    expect(await key("SPACE")).toEqual(asked);
    expect(t.writes()).toEqual([]);
    expect(await key("ctrl+space")).toMatchObject({ ok: true });
    expect(await key("space", true)).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([
      ["press", "ctrl+space", "--window-id", "w-66058"],
      ["press", "space", "--window-id", "w-66058"],
    ]);
  });

  test("control characters in the text are asked about; a multi-line box takes CR and LF", async () => {
    const t = setup("windows", form());
    await t.start();
    let { el } = await read(t);
    const controls = desktopMessage(
      "needs_approval",
      "输入的文字含控制字符或特殊的换行符",
    );
    for (const text of [
      "a\tb",
      "a\u0000b",
      "a\u001bb",
      "a\u007fb",
      "a\u0085b",
      "a b",
      "a b",
    ]) {
      expect(
        await t.write("desktop.type", {
          ref: el("Single line").ref,
          text,
          mode: "replace",
        }),
      ).toEqual(fail(controls));
      // A textarea is multi-line, and only CR and LF are let through there.
      expect(
        await t.write("desktop.type", {
          ref: el("Notes").ref,
          text,
          mode: "append",
        }),
      ).toEqual(fail(controls));
    }
    expect(t.writes()).toEqual([]);
    const notes = await t.write("desktop.type", {
      ref: el("Notes").ref,
      text: "a\r\nb\nc\rd",
      mode: "replace",
    });
    expect(notes).toMatchObject({ ok: true });

    ({ el } = await read(t));
    const approved = await t.write("desktop.type", {
      ref: el("Single line").ref,
      text: "a b\u0000",
      mode: "replace",
      approved: true,
    });
    expect(approved).toMatchObject({ ok: true });
    const typed = t.entries().filter((e) => e.args[0] === "set-value");
    expect(typed.map(stdinOf)).toEqual(["a\r\nb\nc\rd", "a b\u0000"]);

    // macOS: a textfield inside a scrollarea is multi-line, but a tab is still asked about.
    const mac = setup("macos");
    await mac.start();
    ({ el } = await read(mac));
    expect(
      await mac.write("desktop.type", {
        ref: el("Multi line").ref,
        text: "a\tb",
        mode: "replace",
      }),
    ).toEqual(fail(controls));
  });

  test("type only writes into a text box unless approved; a searchfield and a combobox are single-line", async () => {
    const t = setup("windows", form());
    await t.start();
    let { el } = await read(t);
    expect(
      await t.write("desktop.type", {
        ref: el("Send").ref,
        text: "abc",
        mode: "replace",
      }),
    ).toEqual(
      fail(desktopMessage("needs_approval", "目标不是输入框，需要你先确认")),
    );
    const newline = fail(
      desktopMessage("needs_approval", "往单行输入框里输入带换行的文字"),
    );
    for (const name of ["Search", "Pick"])
      expect(
        await t.write("desktop.type", {
          ref: el(name).ref,
          text: "a\nb",
          mode: "append",
        }),
      ).toEqual(newline);
    expect(t.writes()).toEqual([]);
    for (const name of ["Search", "Pick"]) {
      ({ el } = await read(t));
      expect(
        await t.write("desktop.type", {
          ref: el(name).ref,
          text: "abc",
          mode: "replace",
        }),
      ).toMatchObject({ ok: true });
    }
    ({ el } = await read(t));
    const approved = await t.write("desktop.type", {
      ref: el("Send").ref,
      text: "abc",
      mode: "replace",
      approved: true,
    });
    expect(approved).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([
      ["set-value", "@snuvkeejknool:e12", "--stdin"],
      ["set-value", "@snuvkeejknool:e13", "--stdin"],
      ["set-value", "@snuvkeejknool:e5", "--stdin"],
    ]);
  });

  test("a click on a control with no name is asked about unless approved", async () => {
    const t = setup("windows", form("   "));
    await t.start();
    let { snap } = await read(t);
    const asked = fail(
      desktopMessage("needs_approval", "没能确认要操作的控件"),
    );
    const blank = snap.elements.find(
      (e) => e.type === "button" && e.name.trim() === "",
    );
    const titleBar = snap.elements.find(
      (e) => e.type === "group" && e.name === "",
    );
    if (!blank || !titleBar) throw new Error("no nameless control");
    expect(await t.write("desktop.click", { ref: blank.ref })).toEqual(asked);
    expect(await t.write("desktop.click", { ref: titleBar.ref })).toEqual(
      asked,
    );
    expect(t.writes()).toEqual([]);
    ({ snap } = await read(t));
    const again = snap.elements.find(
      (e) => e.type === "button" && e.name.trim() === "",
    );
    expect(
      await t.write("desktop.click", { ref: again?.ref, approved: true }),
    ).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([["click", "@snuvkeejknool:e5"]]);
  });

  test("an abort between the headless attempt and the pointer sends no headed-begin", async () => {
    const controller = new AbortController();
    const t = setup(
      "windows",
      {
        click: { error: "POLICY_DENIED" },
        "--headed click": { write: { delivery: "delivered_verified" } },
      },
      {
        wrapCli: (cli) => ({
          ...cli,
          run: async (args, o) => {
            try {
              return await cli.run(args, o);
            } catch (error) {
              // The headless click came back not delivered: stop right then.
              if (args[0] === "click" && !o?.headed) controller.abort();
              throw error;
            }
          },
        }),
      },
    );
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    expect(await t.write("desktop.click", { ref }, controller.signal)).toEqual(
      fail("已在设备上停止。"),
    );
    expect(t.trace).toEqual([]);
    expect(t.writes()).toEqual([["click", target]]);
  });

  test("INVALID_ARGS is refused while the arguments are read: not delivered, not unknown", async () => {
    const message = "Invalid ref_id '@e1': expected @<snapshot_id>:e<N>";
    const t = setup("windows", {
      click: {
        envelope: {
          version: "2.6",
          ok: false,
          command: "click",
          error: { code: "INVALID_ARGS", message },
        },
        exitCode: 1,
      },
      press: { exitCode: 2, raw: "usage: agent-desktop press <COMBO>" },
    });
    await t.start();
    const { el, window } = await read(t);
    const ref = el("Single line").ref;
    expect(await t.write("desktop.click", { ref })).toEqual(
      fail(desktopMessage("failed", `INVALID_ARGS：${message}`)),
    );
    // Not unknown: the window's refs stay good.
    expect(typeof t.reader.resolveRef(ref)).toBe("object");
    expect(
      await t.write("desktop.key", {
        windowId: window.windowId,
        keys: "ctrl+s",
      }),
    ).toEqual(fail(desktopMessage("failed", "INVALID_ARGS")));
  });

  test("the executor hands a write's outcomeUnknown back exactly as it is", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ad-write-ws-"));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    const seen: unknown[] = [];
    const desktop = Object.assign(
      async (...args: unknown[]) => {
        seen.push(args[3]);
        return unknown;
      },
      { close: async () => {} },
    );
    const execute = createRunnerExecutor(
      workspace,
      undefined,
      undefined,
      undefined,
      undefined,
      { desktop },
    );
    expect(
      await execute({
        action: "desktop.click",
        payload: { botId: BOT, session: TOKEN, ref: "abc123-1:1" },
      }),
    ).toEqual(unknown);
    expect(seen).toEqual([{ botId: BOT }]);
  });
});

describe("desktop writes: review fixes", () => {
  test("two writes on the same snapshot run one after the other: the second ref is stale", async () => {
    const t = setup("windows", { click: { delayMs: 300 } });
    await t.start();
    const { el } = await read(t);
    const ref = el("Single line").ref;
    const target = adRef(t, ref);
    const [first, second] = await Promise.all([
      t.write("desktop.click", { ref }),
      t.write("desktop.click", { ref }),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(fail(desktopMessage("stale")));
    expect(t.writes()).toEqual([["click", target]]);
    // Each write's listing and action go together, never interleaved.
    expect(
      t
        .log()
        .map((args) => args[0])
        .slice(-2),
    ).toEqual(["list-windows", "click"]);
  }, 20_000);

  test("a write stopped while it waits for the one before runs nothing", async () => {
    const t = setup("windows", { click: { delayMs: 500 } });
    await t.start();
    const { el, window } = await read(t);
    const target = adRef(t, el("Single line").ref);
    const controller = new AbortController();
    const first = t.write("desktop.click", { ref: el("Single line").ref });
    const second = t.write(
      "desktop.focus",
      { windowId: window.windowId },
      controller.signal,
    );
    await waitFor(() => t.writes().length === 1);
    controller.abort();
    expect(await second).toEqual(fail("已在设备上停止。"));
    expect(await first).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([["click", target]]);
  }, 20_000);

  test("action words are checked against the whole control name, not the 120 characters shown", async () => {
    const name = `${"x".repeat(120)}删除`;
    const data = structuredClone(sample("windows", "snapshot-password").data);
    data.tree.children[4].name = name;
    const t = setup("windows", {
      snapshot: {
        envelope: { version: "2.6", ok: true, command: "snapshot", data },
      },
    });
    await t.start();
    const { snap } = await read(t);
    const send = snap.elements.find(
      (e) => e.type === "button" && e.name.startsWith("x"),
    );
    if (!send) throw new Error("no long button");
    // What is shown is cut as before.
    expect(send.name).toBe("x".repeat(DESKTOP_LIMITS.nameMax));
    expect(
      await t.write("desktop.click", { ref: send.ref, approved: false }),
    ).toEqual(fail(desktopMessage("needs_approval", "控件名含「删除」")));
    expect(t.writes()).toEqual([]);
    // Nor does the whole name reach the output.
    const done = await t.write("desktop.click", {
      ref: send.ref,
      approved: true,
    });
    expect(output(done).control).toEqual({
      type: "button",
      name: "x".repeat(DESKTOP_LIMITS.nameMax),
    });
  });
});

describe("desktop writes: review fixes 2", () => {
  test("a word added past the 200 characters shown still makes the title one that turned sensitive", async () => {
    const before = "a".repeat(200);
    const listing = structuredClone(sample("windows", "list-windows"));
    listing.data[0].title = before;
    const t = setup("windows", { "list-windows": { envelope: listing } });
    await t.start();
    const { el, window } = await read(t);
    // What is shown is the same 200 characters before and after.
    expect(window.title).toBe(before);
    const turned = fail(
      desktopMessage(
        "needs_approval",
        "窗口标题刚刚变成含「银行」，请重新列出窗口",
      ),
    );
    const live = structuredClone(listing);
    live.data[0].title = `${before}银行`;
    t.set("list-windows", { envelope: live });
    const ref = el("Single line").ref;
    for (const approved of [true, false])
      expect(await t.write("desktop.click", { ref, approved })).toEqual(turned);
    // Approved for the title as shown (cut the same way), it is still the change that counts.
    expect(
      await t.write("desktop.focus", {
        windowId: window.windowId,
        approved: true,
        approvedTitle: before,
      }),
    ).toEqual(turned);
    expect(t.writes()).toEqual([]);

    // Listed again, the read knows the whole title: approved, it goes through.
    await t.reader.windows();
    // Final review I1: approved for the title as shown, the word past it was never seen; the
    // device's own reason, approved, shows it.
    expect(
      await t.write("desktop.focus", {
        windowId: window.windowId,
        approved: true,
        approvedTitle: before,
      }),
    ).toEqual(fail(desktopMessage("needs_approval", "窗口标题含「银行」")));
    const done = await t.write("desktop.focus", {
      windowId: window.windowId,
      approved: true,
      approvedTitle: before,
      approvedReason: "窗口标题含「银行」",
    });
    expect(output(done).window).toMatchObject({ title: before });
  });
});

describe("desktop writes: launch and the clipboard (Task 24)", () => {
  const BAD_APP = desktopMessage(
    "failed",
    "应用名只能是应用的名字，不能带路径或参数",
  );
  const commandsOf = (t: Setup, name: string) =>
    t.log().filter((args) => args[0] === name);

  test("launch refuses paths and flags (/bin/sh, -x, ../a) without running anything", async () => {
    const t = setup("windows", {
      launch: {
        envelope: {
          version: "2.6",
          ok: false,
          command: "launch",
          error: {
            code: "APP_NOT_FOUND",
            message: "No application named 'nosuchapp'",
            disposition: { delivery: "not_delivered", retry: "safe" },
          },
        },
        exitCode: 1,
      },
    });
    // No session: nothing runs, whatever the name.
    expect(await t.write("desktop.launch", { app: "notepad" })).toEqual(
      fail(desktopMessage("no_session")),
    );
    await t.start();
    for (const app of [
      "/bin/sh",
      "-x",
      "../a",
      "--cdp",
      "C:\\Windows\\System32\\cmd.exe",
      "",
      undefined,
      42,
    ])
      expect(await t.write("desktop.launch", { app, approved: true })).toEqual(
        fail(BAD_APP),
      );
    expect(t.log()).toEqual([]);

    // A plain name goes as one argument, with no --headed, --activate, --arg, --env or --cdp.
    expect(await t.write("desktop.launch", { app: "nosuchapp" })).toEqual(
      fail("没有找到这个应用：nosuchapp"),
    );
    t.set("launch", {
      envelope: {
        version: "2.6",
        ok: true,
        command: "launch",
        data: { app: "notepad", pid: 4242 },
      },
    });
    const done = await t.write("desktop.launch", { app: "notepad" });
    expect(output(done)).toMatchObject({ app: "notepad" });
    expect(t.log()).toEqual([
      ["version"],
      ["launch", "nosuchapp"],
      ["launch", "notepad"],
    ]);

    // A name with a space is one argument; a flag after a space is no name at all.
    expect(
      output(await t.write("desktop.launch", { app: "Microsoft Edge" })),
    ).toMatchObject({ app: "Microsoft Edge" });
    expect(t.log().at(-1)).toEqual(["launch", "Microsoft Edge"]);
    const ran = t.log().length;
    for (const app of ["notepad -x", "notepad --arg", "a - b"])
      expect(await t.write("desktop.launch", { app })).toEqual(fail(BAD_APP));
    expect(t.log()).toHaveLength(ran);

    // Linux is read only: launch never reaches the binary there either.
    const linux = setup("linux");
    await linux.start();
    expect(await linux.write("desktop.launch", { app: "gedit" })).toEqual(
      fail(desktopMessage("read_only_linux")),
    );
    expect(linux.log()).toEqual([]);
  });

  test("clipboard read without approval is needs_approval; approved returns text cut to 8000", async () => {
    const long = `${"剪".repeat(7_999)}😀tail`;
    const t = setup("macos", {
      "clipboard-get": {
        envelope: {
          version: "2.6",
          ok: true,
          command: "clipboard-get",
          data: { format: "text", text: long },
        },
      },
    });
    expect(await t.write("desktop.clipboard_read", { approved: true })).toEqual(
      fail(desktopMessage("no_session")),
    );
    await t.start();
    expect(await t.write("desktop.clipboard_read", {})).toEqual(
      fail(
        desktopMessage(
          "needs_approval",
          "读取剪贴板，里面可能有刚复制的密码或验证码",
        ),
      ),
    );
    expect(
      await t.write("desktop.clipboard_read", { approved: "true" }),
    ).toEqual(
      fail(
        desktopMessage(
          "needs_approval",
          "读取剪贴板，里面可能有刚复制的密码或验证码",
        ),
      ),
    );
    expect(commandsOf(t, "clipboard-get")).toEqual([]);

    const read = output<{ text: string; truncated: boolean }>(
      await t.write("desktop.clipboard_read", { approved: true }),
    );
    expect(read.truncated).toBe(true);
    expect([...read.text]).toHaveLength(DESKTOP_LIMITS.clipboardReadMaxChars);
    // Cut on a character, never inside one.
    expect(read.text).toBe(`${"剪".repeat(7_999)}😀`);
    expect(commandsOf(t, "clipboard-get")).toEqual([
      ["clipboard-get", "--format", "text"],
    ]);

    t.set("clipboard-get", {
      envelope: {
        version: "2.6",
        ok: true,
        command: "clipboard-get",
        data: { format: "text", text: "短的" },
      },
    });
    expect(
      output(await t.write("desktop.clipboard_read", { approved: true })),
    ).toMatchObject({ text: "短的", truncated: false });

    // Reading changes nothing: a failure is a plain failure, never unknown.
    t.set("clipboard-get", {
      envelope: {
        version: "2.6",
        ok: false,
        command: "clipboard-get",
        error: { code: "INTERNAL", message: "pasteboard unavailable" },
      },
      exitCode: 1,
    });
    const failed = await t.write("desktop.clipboard_read", { approved: true });
    expect(failed).toEqual(
      fail(desktopMessage("failed", "INTERNAL：pasteboard unavailable")),
    );
  });

  test("clipboard write sends the exact bytes through stdin", async () => {
    const t = setup("windows");
    const text = "熊宝员工 😀\r\nline two\ttab";
    expect(await t.write("desktop.clipboard_write", { text })).toEqual(
      fail(desktopMessage("no_session")),
    );
    await t.start();
    // No approval needed on the device; the text never goes on the command line.
    const done = await t.write("desktop.clipboard_write", { text });
    expect(output(done)).toMatchObject({
      bytes: Buffer.byteLength(text, "utf8"),
    });
    const sets = t
      .entries()
      .filter((entry) => entry.args[0] === "clipboard-set");
    expect(sets.map((entry) => entry.args)).toEqual([
      ["clipboard-set", "--stdin"],
    ]);
    expect(stdinOf(sets[0])).toBe(text);

    // 9 000 bytes go through; one more is refused before anything runs.
    const max = "字".repeat(3_000);
    expect(Buffer.byteLength(max, "utf8")).toBe(DESKTOP_LIMITS.textMaxBytes);
    expect(
      await t.write("desktop.clipboard_write", { text: max }),
    ).toMatchObject({ ok: true });
    expect(
      await t.write("desktop.clipboard_write", { text: `${max}a` }),
    ).toEqual(fail(desktopMessage("failed", "文字太长")));
    expect(
      await t.write("desktop.clipboard_write", { text: undefined }),
    ).toEqual(fail(desktopMessage("failed", "没有要写入剪贴板的文字")));
    expect(
      t.entries().filter((entry) => entry.args[0] === "clipboard-set"),
    ).toHaveLength(2);

    // A write that may have landed is unknown, as any write is.
    t.set("clipboard-set", {
      write: { delivery: "unknown", error: "INTERNAL" },
    });
    expect(await t.write("desktop.clipboard_write", { text })).toEqual(unknown);
  });

  test("the actions route launch, both clipboard actions and wait", async () => {
    const t = setup("windows", {
      snapshot: { sample: "snapshot-password" },
    });
    const actions = createDesktopActions({
      platform: "win32",
      engine: "agent-desktop",
      cli: t.cli,
      reader: t.reader,
      control: t.control,
      sessions: t.sessions,
    });
    await t.start();
    const payload = {
      session: TOKEN,
      actorId: ACTOR,
      approved: false,
      actionWords: [],
    };
    const context = { botId: BOT };
    expect(
      await actions("desktop.clipboard_read", payload, undefined, context),
    ).toEqual(
      fail(
        desktopMessage(
          "needs_approval",
          "读取剪贴板，里面可能有刚复制的密码或验证码",
        ),
      ),
    );
    expect(
      await actions(
        "desktop.clipboard_write",
        { ...payload, text: "x" },
        undefined,
        context,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await actions(
        "desktop.launch",
        { ...payload, app: "-x" },
        undefined,
        context,
      ),
    ).toEqual(fail(BAD_APP));

    // wait is a read: no session needed.
    const { window } = await read(t);
    t.sessions.end(TOKEN);
    const waited = await actions(
      "desktop.wait",
      {
        windowId: window.windowId,
        name: "Send",
        type: "button",
        timeoutSec: 3,
      },
      undefined,
      context,
    );
    expect(output(waited)).toMatchObject({
      window: { windowId: window.windowId },
    });

    // The legacy engine cannot wait; it starts nothing.
    const legacy = createDesktopActions({
      platform: "win32",
      control: t.control,
      sessions: t.sessions,
      host: createDesktopHost({
        spec: () => {
          throw new Error("must not start a helper");
        },
      }),
    });
    cleanup.push(() => legacy.close());
    expect(
      await legacy(
        "desktop.wait",
        { windowId: "w123-45", name: "Send", timeoutSec: 3 },
        undefined,
        context,
      ),
    ).toEqual(fail(desktopMessage("unsupported")));
    for (const action of [
      "desktop.launch",
      "desktop.clipboard_read",
      "desktop.clipboard_write",
    ])
      expect(
        await legacy(
          action,
          { ...payload, app: "notepad", text: "x" },
          undefined,
          context,
        ),
      ).toEqual(fail(desktopMessage("read_only_windows")));
  });
});

describe("desktop writes: review fixes 3", () => {
  test("INVALID_ARGS that agent-desktop says may have been delivered is outcome_unknown", async () => {
    const message = "Invalid ref_id '@e1': expected @<snapshot_id>:e<N>";
    const invalid = (disposition?: Record<string, string>) => ({
      envelope: {
        version: "2.6",
        ok: false,
        command: "click",
        error: {
          code: "INVALID_ARGS",
          message,
          ...(disposition ? { disposition } : {}),
        },
      },
      exitCode: 1,
    });
    const t = setup("windows", {
      click: invalid({ delivery: "not_delivered", retry: "safe" }),
    });
    await t.start();
    let { el } = await read(t);
    let ref = el("Single line").ref;
    // Not delivered, or nothing said: refused as the arguments were read.
    expect(await t.write("desktop.click", { ref })).toEqual(
      fail(desktopMessage("failed", `INVALID_ARGS：${message}`)),
    );
    expect(typeof t.reader.resolveRef(ref)).toBe("object");

    for (const delivery of ["delivered_unverified", "unknown"]) {
      t.set("click", invalid({ delivery, retry: "unsafe" }));
      ({ el } = await read(t));
      ref = el("Single line").ref;
      expect(await t.write("desktop.click", { ref })).toEqual(unknown);
      // Unknown voids the window's refs.
      expect(t.reader.resolveRef(ref)).toBe("stale");
    }
    // Never tried again, headed or not.
    expect(t.writes().filter((args) => args.includes("--headed"))).toEqual([]);
  });
});

describe("desktop writes: review fixes 4", () => {
  test("a clipboard read is journaled as its length only; a replay says it was not kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ad-write-journal-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "actions.sqlite");
    const journal = createActionJournal(file);
    cleanup.push(() => journal.close());
    const secret = "验证码 123456 😀";
    const action = {
      action: "desktop.clipboard_read",
      payload: { session: TOKEN, actorId: ACTOR, approved: true },
    };
    const live = await journal.execute("scope", "k1", action, async () => ({
      ok: true,
      output: { text: secret, truncated: false, durationMs: 4 },
    }));
    // The live answer carries the text.
    expect(live).toEqual({
      ok: true,
      output: { text: secret, truncated: false, durationMs: 4 },
    });

    const database = new Database(file, { readonly: true });
    const rows = database
      .query<{ outcome: string }, []>("SELECT outcome FROM actions")
      .all()
      .map((row) => row.outcome);
    database.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain("验证码");
    expect(rows[0]).not.toContain("123456");
    expect(JSON.parse(rows[0] ?? "{}")).toEqual({
      ok: true,
      output: { chars: [...secret].length, truncated: false },
    });

    // A replay cannot give the text back, and says so rather than pass off an empty clipboard.
    const replay = await journal.execute("scope", "k1", action, async () => {
      throw new Error("a replay must not run again");
    });
    expect(replay).toEqual({ ok: false, error: DESKTOP_CLIPBOARD_NOT_KEPT });
    expect(DESKTOP_CLIPBOARD_NOT_KEPT).toBe(
      "剪贴板内容不会被保存，请重新读取。",
    );

    // A failed read holds no text and replays as it was.
    const failed = { ok: false as const, error: desktopMessage("failed") };
    await journal.execute("scope", "k2", action, async () => failed);
    expect(
      await journal.execute("scope", "k2", action, async () => {
        throw new Error("a replay must not run again");
      }),
    ).toEqual(failed);
  });
});

/*
 * The final whole-branch review (final-fix-brief.md). Every check here only asks more; the device is
 * the last gate, approved or not.
 */
describe("desktop writes: the final review", () => {
  const SELF = ["熊宝数字员工", "熊宝", "XiongBao Work"];
  const selfReason = fail(
    desktopMessage("needs_approval", DESKTOP_SELF_WINDOW_REASON),
  );
  /** The macOS sample form with `name` on its Send button. */
  const macForm = (send: string) => {
    const data = structuredClone(sample("macos", "snapshot-password").data);
    data.tree.children[4].name = send;
    return {
      snapshot: {
        envelope: { version: "2.6", ok: true, command: "snapshot", data },
      },
    };
  };
  /** The macOS windows with the first one titled `title`. */
  const macTitled = (title: string) => {
    const listing = structuredClone(sample("macos", "list-windows"));
    listing.data[0].title = title;
    return { "list-windows": { envelope: listing } };
  };

  test("C1: a terminal or the product's own process is asked about every time, whatever the write", async () => {
    // The real rule: the Windows samples are a form hosted by powershell.exe and Windows Terminal.
    const t = setup(
      "windows",
      {},
      { selfOrTerminal: desktopSelfOrTerminalProcess },
    );
    await t.start();
    const { el, windows } = await read(t);
    const [form, terminal] = windows;
    if (!form || !terminal) throw new Error("no windows");
    expect(await t.write("desktop.focus", { windowId: form.windowId })).toEqual(
      selfReason,
    );
    expect(
      await t.write("desktop.key", { windowId: form.windowId, keys: "ctrl+s" }),
    ).toEqual(selfReason);
    expect(
      await t.write("desktop.click", { ref: el("Single line").ref }),
    ).toEqual(selfReason);
    expect(
      await t.write("desktop.type", {
        ref: el("Single line").ref,
        text: "dir",
        mode: "append",
      }),
    ).toEqual(selfReason);
    expect(
      await t.write("desktop.focus", { windowId: terminal.windowId }),
    ).toEqual(selfReason);
    expect(t.writes()).toEqual([]);
    // The owner saw the card that said so: approved, it goes through.
    expect(
      await t.write("desktop.focus", {
        windowId: terminal.windowId,
        approved: true,
        approvedTitle: terminal.title,
      }),
    ).toMatchObject({ ok: true });
    // TextEdit is neither.
    const mac = setup(
      "macos",
      {},
      { selfOrTerminal: desktopSelfOrTerminalProcess },
    );
    await mac.start();
    const { window } = await read(mac);
    expect(
      await mac.write("desktop.focus", { windowId: window.windowId }),
    ).toMatchObject({ ok: true });
  });

  test("C1: a title with the product's name the server sends is the product's own window", async () => {
    const title = "待审批 - 熊宝数字员工 - Google Chrome";
    const t = setup("macos", macTitled(title));
    await t.start();
    const { window, el } = await read(t);
    for (const write of [
      () =>
        t.write("desktop.focus", {
          windowId: window.windowId,
          selfWindowWords: SELF,
        }),
      () =>
        t.write("desktop.key", {
          windowId: window.windowId,
          keys: "tab",
          selfWindowWords: SELF,
        }),
      () =>
        t.write("desktop.click", {
          ref: el("Single line").ref,
          selfWindowWords: SELF,
        }),
    ])
      expect(await write()).toEqual(selfReason);
    expect(t.writes()).toEqual([]);
    // Approved for this very title, it goes through.
    expect(
      await t.write("desktop.focus", {
        windowId: window.windowId,
        selfWindowWords: SELF,
        approved: true,
        approvedTitle: title,
      }),
    ).toMatchObject({ ok: true });
    // A title that turned into the product's own since it was read is refused, approved or not.
    const turned = setup("macos");
    await turned.start();
    const listed = await read(turned);
    turned.set("list-windows", macTitled(title)["list-windows"]);
    for (const approved of [false, true])
      expect(
        await turned.write("desktop.focus", {
          windowId: listed.window.windowId,
          selfWindowWords: SELF,
          approved,
          approvedTitle: listed.window.title,
        }),
      ).toEqual(
        fail(
          desktopMessage(
            "needs_approval",
            "窗口标题刚刚变成含「熊宝数字员工」，请重新列出窗口",
          ),
        ),
      );
    // Without the words (a server from before), the title is an ordinary one.
    expect(
      await t.write("desktop.focus", { windowId: window.windowId }),
    ).toMatchObject({ ok: true });
  });

  test("C1: 允许一次, Approve and the like are asked about whatever the team's words", async () => {
    for (const [name, word] of [
      ["允许一次", "允许"],
      ["批准", "批准"],
      ["Approve", "approve"],
      ["Deny", "deny"],
    ]) {
      const t = setup("macos", macForm(name));
      await t.start();
      const { el } = await read(t);
      expect(
        await t.write("desktop.click", {
          ref: el(name).ref,
          actionWords: ["zzz"],
        }),
      ).toEqual(fail(desktopMessage("needs_approval", `控件名含「${word}」`)));
      expect(t.writes()).toEqual([]);
    }
  });

  test("I1: approved, the whole control name is checked against the name the owner saw", async () => {
    const shown = "x".repeat(DESKTOP_LIMITS.nameMax);
    const t = setup("macos", macForm(`${shown}删除`));
    await t.start();
    let { snap } = await read(t);
    const long = () => {
      const found = snap.elements.find((e) => e.name === shown);
      if (!found) throw new Error("no long button");
      return found.ref;
    };
    const asked = fail(
      desktopMessage("needs_approval", `控件名含「删除」：「${shown}删除」`),
    );
    // The card named the cut name, or no control at all.
    for (const approvedControlName of [shown, null])
      expect(
        await t.write("desktop.click", {
          ref: long(),
          approved: true,
          approvedTitle: "sample.txt",
          approvedControlName,
        }),
      ).toEqual(asked);
    expect(t.writes()).toEqual([]);
    // The device's own reason approved: the word is seen.
    const done = await t.write("desktop.click", {
      ref: long(),
      approved: true,
      approvedTitle: "sample.txt",
      approvedControlName: shown,
      approvedReason: `控件名含「删除」：「${shown}删除」`,
    });
    expect(output(done).control).toEqual({ type: "button", name: shown });
    // A name the card showed whole goes through as before.
    const send = setup("macos", macForm("发送"));
    await send.start();
    ({ snap } = await read(send));
    const ref = snap.elements.find((e) => e.name === "发送")?.ref as string;
    expect(
      await send.write("desktop.click", {
        ref,
        approved: true,
        approvedTitle: "sample.txt",
        approvedControlName: null,
      }),
    ).toEqual(
      fail(desktopMessage("needs_approval", "控件名含「发送」：「发送」")),
    );
    expect(
      await send.write("desktop.click", {
        ref,
        approved: true,
        approvedTitle: "sample.txt",
        approvedControlName: "发送",
      }),
    ).toMatchObject({ ok: true });
    // A server from before this check says no name at all: checked as before, since it could not
    // ask again after an approval.
    ({ snap } = await read(send));
    expect(
      await send.write("desktop.click", {
        ref: snap.elements.find((e) => e.name === "发送")?.ref as string,
        approved: true,
      }),
    ).toMatchObject({ ok: true });
  });

  test("I1: a long name is shown cut to 200 characters, its words first", async () => {
    const name = `${"y".repeat(250)}发送`;
    const t = setup("macos", macForm(name));
    await t.start();
    const { snap } = await read(t);
    const ref = snap.elements.find((e) => e.name.startsWith("y"))
      ?.ref as string;
    expect(
      await t.write("desktop.click", {
        ref,
        approved: true,
        approvedTitle: "sample.txt",
        approvedControlName: "y".repeat(DESKTOP_LIMITS.nameMax),
      }),
    ).toEqual(
      fail(
        desktopMessage(
          "needs_approval",
          `控件名含「发送」：「${"y".repeat(200)}…」`,
        ),
      ),
    );
  });

  test("I1: approved, the whole title is checked against the title the owner saw", async () => {
    const before = "a".repeat(DESKTOP_LIMITS.titleMax);
    for (const [word, words] of [
      ["银行", undefined],
      ["熊宝", SELF],
    ] as const) {
      const t = setup("macos", macTitled(`${before}${word}`));
      await t.start();
      // Listed, not read: a sensitive window is not read without approval.
      const window = (await t.reader.windows()).windows[0];
      if (!window) throw new Error("no window");
      expect(window.title).toBe(before);
      const base = {
        windowId: window.windowId,
        approved: true,
        approvedTitle: before,
        ...(words ? { selfWindowWords: [...words] } : {}),
      };
      expect(await t.write("desktop.focus", base)).toEqual(
        fail(desktopMessage("needs_approval", `窗口标题含「${word}」`)),
      );
      expect(t.writes()).toEqual([]);
      expect(
        await t.write("desktop.focus", {
          ...base,
          approvedReason: `窗口标题含「${word}」`,
        }),
      ).toMatchObject({ ok: true });
    }
  });

  test("I2: a new line typed with a real keyboard is asked about before anything is typed or cleared", async () => {
    const data = structuredClone(sample("windows", "snapshot-password").data);
    data.tree.children.push({
      role: "textarea",
      name: "Notes",
      ref_id: "@snuvkeejknool:e11",
    });
    const snapshot = {
      envelope: { version: "2.6", ok: true, command: "snapshot", data },
    };
    const asked = fail(
      desktopMessage(
        "needs_approval",
        "用真实键盘输入带换行的文字可能会直接发送，需要你先确认",
      ),
    );
    // Append: headless typing is refused on Windows, so a real keyboard would type it.
    const t = setup("windows", {
      snapshot,
      type: { error: "POLICY_DENIED" },
      "set-value": { error: "POLICY_DENIED" },
      "--headed type": { write: { delivery: "delivered_verified" } },
    });
    await t.start();
    let { el } = await read(t);
    let target = adRef(t, el("Notes").ref);
    for (const text of ["好的\n", "a\r\nb", "\r"])
      expect(
        await t.write("desktop.type", {
          ref: el("Notes").ref,
          text,
          mode: "append",
        }),
      ).toEqual(asked);
    // Replace: asked before the box is cleared.
    expect(
      await t.write("desktop.type", {
        ref: el("Notes").ref,
        text: "好的\n",
        mode: "replace",
      }),
    ).toEqual(asked);
    expect(t.writes()).toEqual([
      ["type", target, "--stdin"],
      ["type", target, "--stdin"],
      ["type", target, "--stdin"],
      ["set-value", target, "--stdin"],
    ]);
    expect(t.trace).toEqual([]);
    // Without a new line, or approved, the real keyboard types it.
    expect(
      await t.write("desktop.type", {
        ref: el("Notes").ref,
        text: "好的",
        mode: "append",
      }),
    ).toMatchObject({ ok: true });
    ({ el } = await read(t));
    target = adRef(t, el("Notes").ref);
    expect(
      await t.write("desktop.type", {
        ref: el("Notes").ref,
        text: "好的\n",
        mode: "replace",
        approved: true,
      }),
    ).toMatchObject({ ok: true });
    expect(t.writes().slice(-3)).toEqual([
      ["set-value", target, "--stdin"],
      ["clear", target],
      ["--headed", "type", target, "--stdin"],
    ]);
    // Typed without a keyboard (macOS, headless), a new line in a multi-line box is not asked about.
    const mac = setup("macos");
    await mac.start();
    ({ el } = await read(mac));
    expect(
      await mac.write("desktop.type", {
        ref: el("Multi line").ref,
        text: "好的\n",
        mode: "append",
      }),
    ).toMatchObject({ ok: true });
    expect(mac.trace).toEqual([]);
  });

  test("I3: deleting at once, and alt with a letter on Windows, are asked about", async () => {
    const t = setup("windows");
    await t.start();
    const { window } = await read(t);
    const key = (keys: string, approved = false) =>
      t.write("desktop.key", { windowId: window.windowId, keys, approved });
    for (const keys of [
      "shift+delete",
      "shift+forwarddelete",
      "ctrl+shift+delete",
    ])
      expect(await key(keys)).toEqual(
        fail(
          desktopMessage(
            "needs_approval",
            `按 ${keys} 可能会直接删除文件或内容`,
          ),
        ),
      );
    for (const keys of ["alt+s", "alt+y", "alt+1"])
      expect(await key(keys)).toEqual(
        fail(
          desktopMessage(
            "needs_approval",
            "这个按键可能会按下当前选中的按钮，需要你先确认",
          ),
        ),
      );
    expect(t.writes()).toEqual([]);
    // Approved: pressed, never forced.
    expect(await key("shift+delete", true)).toMatchObject({ ok: true });
    expect(await key("alt+s", true)).toMatchObject({ ok: true });
    expect(t.writes()).toEqual([
      ["press", "shift+forwarddelete", "--window-id", "w-66058"],
      ["press", "alt+s", "--window-id", "w-66058"],
    ]);
    // On a Mac alt with a letter types a character; cmd+backspace deletes in Finder.
    const mac = setup("macos");
    await mac.start();
    const listed = await read(mac);
    const press = (keys: string) =>
      mac.write("desktop.key", { windowId: listed.window.windowId, keys });
    expect(await press("alt+s")).toMatchObject({ ok: true });
    for (const keys of ["cmd+backspace", "cmd+alt+backspace"])
      expect(await press(keys)).toEqual(
        fail(
          desktopMessage(
            "needs_approval",
            `按 ${keys} 可能会直接删除文件或内容`,
          ),
        ),
      );
  });

  test("M3: a write that fails says its code and our words, never agent-desktop's message", async () => {
    const secret = "value 'hunter2' of control 'Password'";
    const failing = {
      envelope: {
        version: "2.6",
        ok: false,
        command: "click",
        error: {
          code: "INTERNAL",
          message: secret,
          disposition: { delivery: "not_delivered" },
        },
      },
      exitCode: 1,
    };
    const t = setup("windows", {
      click: failing,
      "clipboard-set": {
        ...failing,
        envelope: { ...failing.envelope, command: "clipboard-set" },
      },
      "clipboard-get": {
        ...failing,
        envelope: { ...failing.envelope, command: "clipboard-get" },
      },
    });
    await t.start();
    const { el } = await read(t);
    const said = fail(desktopMessage("failed", "错误码 INTERNAL"));
    expect(
      await t.write("desktop.click", { ref: el("Single line").ref }),
    ).toEqual(said);
    expect(await t.write("desktop.clipboard_write", { text: "x" })).toEqual(
      said,
    );
    // Reading the clipboard changes nothing and fails as a read does (pinned since Task 24).
    expect(await t.write("desktop.clipboard_read", { approved: true })).toEqual(
      fail(desktopMessage("failed", `INTERNAL：${secret}`)),
    );
    // A code that is not a plain code is not repeated either.
    t.set("click", {
      ...failing,
      envelope: {
        ...failing.envelope,
        error: { ...failing.envelope.error, code: "BAD hunter2" },
      },
    });
    expect(
      await t.write("desktop.click", { ref: el("Single line").ref }),
    ).toEqual(fail(desktopMessage("failed", "错误码 UNKNOWN")));
    // A read says what it said before.
    t.set("list-windows", {
      envelope: { ...failing.envelope, command: "list-windows" },
      exitCode: 1,
    });
    await expect(t.reader.windows()).rejects.toThrow(secret.slice(0, 10));
  });
});

/*
 * The final review, round 2 (Important-2, Minor-1, Minor-2): the process on the approved path, every
 * finding at once, and a device reason read by its words, title and control apart.
 */
describe("desktop writes: the final review, round 2", () => {
  const SELF = desktopMessage("needs_approval", DESKTOP_SELF_WINDOW_REASON);
  const macTitled = (title: string) => {
    const listing = structuredClone(sample("macos", "list-windows"));
    listing.data[0].title = title;
    return { "list-windows": { envelope: listing } };
  };

  test("Important-2: approved, a terminal is checked against the process the card showed", async () => {
    const t = setup(
      "windows",
      {},
      { selfOrTerminal: desktopSelfOrTerminalProcess },
    );
    await t.start();
    const { window } = await read(t);
    const focus = (more: Record<string, unknown>) =>
      t.write("desktop.focus", {
        windowId: window.windowId,
        approved: true,
        approvedTitle: window.title,
        ...more,
      });
    // The card showed no process (a control this replica never saw), or another one.
    expect(await focus({ approvedProcess: null })).toEqual(fail(SELF));
    expect(await focus({ approvedProcess: "notepad.exe" })).toEqual(fail(SELF));
    expect(t.writes()).toEqual([]);
    // The card showed the terminal, or the owner approved the device's own reason that said so.
    expect(await focus({ approvedProcess: "powershell.exe" })).toMatchObject({
      ok: true,
    });
    expect(
      await focus({
        approvedProcess: null,
        approvedReason: DESKTOP_SELF_WINDOW_REASON,
      }),
    ).toMatchObject({ ok: true });
    // A server from before says nothing of the process: checked as before.
    expect(await focus({})).toMatchObject({ ok: true });
  });

  test("Important-2: typed with a new line into a terminal after a card with no control, it asks again", async () => {
    const data = structuredClone(sample("windows", "snapshot-password").data);
    data.tree.children.push({
      role: "textarea",
      name: "Notes",
      ref_id: "@snuvkeejknool:e11",
    });
    const t = setup(
      "windows",
      {
        snapshot: {
          envelope: { version: "2.6", ok: true, command: "snapshot", data },
        },
      },
      { selfOrTerminal: desktopSelfOrTerminalProcess },
    );
    await t.start();
    const { el, window } = await read(t);
    expect(
      await t.write("desktop.type", {
        ref: el("Notes").ref,
        text: "rm -rf ~\n",
        mode: "append",
        approved: true,
        approvedTitle: window.title,
        approvedControlName: null,
        approvedProcess: null,
      }),
    ).toEqual(fail(SELF));
    expect(t.writes()).toEqual([]);
  });

  test("Minor-1: unapproved, every finding is named at once", async () => {
    const listing = structuredClone(sample("windows", "list-windows"));
    listing.data[0].title = "XB Sample Form - 网上银行";
    const t = setup("windows", { "list-windows": { envelope: listing } });
    await t.start();
    const window = (await t.reader.windows()).windows[0];
    if (!window) throw new Error("no window");
    expect(
      await t.write("desktop.key", {
        windowId: window.windowId,
        keys: "enter",
      }),
    ).toEqual(
      fail(
        desktopMessage(
          "needs_approval",
          "窗口标题含「银行」；按 enter 可能会把内容提交或发送出去",
        ),
      ),
    );
    // A terminal too: its reason first.
    const real = setup(
      "windows",
      { "list-windows": { envelope: listing } },
      {
        selfOrTerminal: desktopSelfOrTerminalProcess,
      },
    );
    await real.start();
    const listed = (await real.reader.windows()).windows[0];
    if (!listed) throw new Error("no window");
    expect(
      await real.write("desktop.key", {
        windowId: listed.windowId,
        keys: "alt+s",
      }),
    ).toEqual(
      fail(
        desktopMessage(
          "needs_approval",
          `${DESKTOP_SELF_WINDOW_REASON}；窗口标题含「银行」；这个按键可能会按下当前选中的按钮，需要你先确认`,
        ),
      ),
    );
    expect(t.writes()).toEqual([]);
    expect(real.writes()).toEqual([]);
  });

  test("Minor-2: a reason's words count only where it put them, title or control", async () => {
    const before = "a".repeat(DESKTOP_LIMITS.titleMax);
    const t = setup("macos", macTitled(`${before}银行`));
    await t.start();
    const window = (await t.reader.windows()).windows[0];
    if (!window) throw new Error("no window");
    const focus = (approvedReason: string) =>
      t.write("desktop.focus", {
        windowId: window.windowId,
        approved: true,
        approvedTitle: before,
        approvedReason,
      });
    const asked = fail(desktopMessage("needs_approval", "窗口标题含「银行」"));
    for (const reason of [
      // The word under the control, not the title.
      "控件名含「银行」：「x」",
      // In the free text, not between the marks.
      "这里提到了银行",
      // After the control's name, which is free text a page chooses.
      "控件名含「发送」：「x；窗口标题含「银行」」",
    ])
      expect({ reason, out: await focus(reason) }).toEqual({
        reason,
        out: asked,
      });
    expect(t.writes()).toEqual([]);
    expect(await focus("窗口标题含「银行」")).toMatchObject({ ok: true });

    // And the other way round: a title's word does not count for the control.
    const shown = "x".repeat(DESKTOP_LIMITS.nameMax);
    const data = structuredClone(sample("macos", "snapshot-password").data);
    data.tree.children[4].name = `${shown}删除`;
    const c = setup("macos", {
      snapshot: {
        envelope: { version: "2.6", ok: true, command: "snapshot", data },
      },
    });
    await c.start();
    const { snap } = await read(c);
    const ref = snap.elements.find((e) => e.name === shown)?.ref as string;
    const click = (approvedReason: string) =>
      c.write("desktop.click", {
        ref,
        approved: true,
        approvedTitle: "sample.txt",
        approvedControlName: shown,
        approvedReason,
      });
    expect(await click("窗口标题含「删除」")).toEqual(
      fail(
        desktopMessage("needs_approval", `控件名含「删除」：「${shown}删除」`),
      ),
    );
    expect(await click("控件名含「删除」：「随便」")).toMatchObject({
      ok: true,
    });
  });
});

/*
 * Reads (final review, round 2: Qoder P1 on #494). A wait can take 30 seconds and a snapshot a
 * while too: the title is read again after them, with the same words, and a window that turned
 * sensitive meanwhile throws away what was read.
 */
describe("desktop reads: the title after the read", () => {
  const titled = (title: string | undefined) => {
    const listing = structuredClone(sample("macos", "list-windows"));
    if (title === undefined) listing.data.splice(0, 1);
    else listing.data[0].title = title;
    return { envelope: listing };
  };
  const listings = (t: Setup) =>
    t.log().filter((args) => args[0] === "list-windows").length;

  async function during(
    t: Setup,
    read: () => Promise<unknown>,
    then: () => void,
  ) {
    const before = t.log().filter((args) => args.includes("snapshot")).length;
    const pending = read().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitFor(
      () => t.log().filter((args) => args.includes("snapshot")).length > before,
    );
    then();
    return pending;
  }

  test("a window that turned sensitive during a wait or a snapshot is refused, and none of its refs are kept", async () => {
    const t = setup("macos", {
      snapshot: { sample: "snapshot-password", delayMs: 400 },
    });
    await t.start();
    const { window, snap } = await read(t);
    const [prefix, counter] = snap.snapshotId.split("-");
    t.set("list-windows", titled(window.title));
    const waited = (await during(
      t,
      () =>
        (t.reader.wait as NonNullable<typeof t.reader.wait>)({
          windowId: window.windowId,
          name: "Send",
          timeoutSec: 5,
        }),
      () => t.set("list-windows", titled("网上银行 - 登录")),
    )) as { error?: { code?: string; message?: string } };
    expect(waited.error?.code).toBe("sensitive");
    expect(waited.error?.message).toBe(desktopMessage("sensitive", "银行"));
    // The wait's snapshot was the next one: none of its refs resolve.
    expect(t.reader.resolveRef(`${prefix}-${Number(counter) + 1}:0`)).toBe(
      "stale",
    );

    // A plain snapshot, the same.
    t.set("list-windows", titled(window.title));
    const read2 = (await during(
      t,
      () => t.reader.snapshot({ windowId: window.windowId }),
      () => t.set("list-windows", titled("PayPal checkout")),
    )) as { error?: { code?: string } };
    expect(read2.error?.code).toBe("sensitive");
    expect(t.reader.resolveRef(`${prefix}-${Number(counter) + 2}:0`)).toBe(
      "stale",
    );
  });

  test("a window gone during a wait is no_window", async () => {
    const t = setup("macos", {
      snapshot: { sample: "snapshot-password", delayMs: 400 },
    });
    await t.start();
    const { window } = await read(t);
    const waited = (await during(
      t,
      () =>
        (t.reader.wait as NonNullable<typeof t.reader.wait>)({
          windowId: window.windowId,
          name: "Send",
          timeoutSec: 5,
        }),
      () => t.set("list-windows", titled(undefined)),
    )) as { error?: { code?: string } };
    expect(waited.error?.code).toBe("no_window");
  });

  test("allowSensitive (approved): the title is not read again", async () => {
    const t = setup("macos", {
      snapshot: { sample: "snapshot-password", delayMs: 400 },
    });
    await t.start();
    const { window } = await read(t);
    const before = listings(t);
    const waited = (await during(
      t,
      () =>
        (t.reader.wait as NonNullable<typeof t.reader.wait>)({
          windowId: window.windowId,
          name: "Send",
          timeoutSec: 5,
          allowSensitive: true,
        }),
      () => t.set("list-windows", titled("网上银行 - 登录")),
    )) as { value?: { snapshotId?: string } };
    expect(waited.value?.snapshotId).toBeDefined();
    // Only the listing before it.
    expect(listings(t) - before).toBe(1);
  });
});

describe("desktop writes: the final review, round 3", () => {
  test("several reasons approved at once: what each says counts, still title and control apart", async () => {
    const before = "a".repeat(DESKTOP_LIMITS.titleMax);
    const shown = "x".repeat(DESKTOP_LIMITS.nameMax);
    const listing = structuredClone(sample("macos", "list-windows"));
    listing.data[0].title = `${before}银行`;
    const data = structuredClone(sample("macos", "snapshot-password").data);
    data.tree.children[4].name = `${shown}删除`;
    const t = setup("macos", {
      "list-windows": { envelope: listing },
      snapshot: {
        envelope: { version: "2.6", ok: true, command: "snapshot", data },
      },
    });
    await t.start();
    // Read with approval: a sensitive window is read only so.
    const window = (await t.reader.windows()).windows[0];
    if (!window) throw new Error("no window");
    const snap = await t.reader.snapshot({
      windowId: window.windowId,
      allowSensitive: true,
    });
    const ref = snap.elements.find((e) => e.name === shown)?.ref as string;
    const click = (approvedReason: unknown) =>
      t.write("desktop.click", {
        ref,
        approved: true,
        approvedTitle: before,
        approvedControlName: shown,
        approvedReason,
      });
    expect(await click(["窗口标题含「银行」"])).toEqual(
      fail(
        desktopMessage("needs_approval", `控件名含「删除」：「${shown}删除」`),
      ),
    );
    expect(
      await click(["控件名含「删除」：「…」", "控件名含「银行」：「…」"]),
    ).toEqual(fail(desktopMessage("needs_approval", "窗口标题含「银行」")));
    expect(t.writes()).toEqual([]);
    expect(
      await click(["窗口标题含「银行」", "控件名含「删除」：「…」"]),
    ).toMatchObject({ ok: true });
  });
});
