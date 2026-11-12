import { rm } from "node:fs/promises";
import {
  DESKTOP_ACTIONS,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_WORDS,
  DESKTOP_WRITE_ACTIONS,
  type DesktopElement,
  type DesktopEngine,
  type DesktopErrorCode,
  type DesktopImage,
  type DesktopPlatform,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
  desktopPlatformOf,
  parseWindowId,
  windowIdOf,
} from "../../../shared/desktop-control";
import type { ActionOutcome } from "../execute";
import {
  type AgentDesktopReader,
  createAgentDesktopReader,
  readFailure,
} from "./ad-read";
import { type AgentDesktopWriter, createAgentDesktopWriter } from "./ad-write";
import { type AgentDesktopCli, createAgentDesktopCli } from "./agent-desktop";
import { type ControlChannel, NO_CONTROL } from "./control";
import {
  createDesktopHost,
  DesktopHelperError,
  defaultHelperSpec,
} from "./host";
import { scrub } from "./scrub";
import { createDesktopSessions, type DesktopSessions } from "./session";

/**
 * `desktop.windows` and `desktop.snapshot` (docs/specs/2026-11-07-desktop-control.md, Phase 1: read
 * only; plan Task 4). Every other `desktop.*` action is answered `unsupported` here and never reaches
 * the helper.
 *
 * TWO ENGINES (plan docs/plans/2026-11-12-desktop-write.md, Task 9). macOS and Linux read through
 * agent-desktop (`ad-read.ts`); Windows keeps phase 1's PowerShell reader (`host.ts`) unless
 * agent-desktop is asked for (`desktopEngineFor`). Any other system is `unsupported_platform` and
 * starts nothing. `desktop.windows` names the platform either way.
 *
 * NO OUTCOME IS EVER `outcomeUnknown`. Listing windows, reading a tree and taking a picture change
 * nothing on the machine, so a call that timed out or was stopped must not pause the device.
 *
 * THE SESSION ACTIONS (Task 13). `desktop.session_status` says whether this device could be written
 * to now and, for that bot and person, which session is current; `desktop.session_start` takes the
 * server's token and waits for the device app's guard (`session.ts`); `desktop.session_end` ends
 * it. They change nothing on the screen either, so they are never `outcomeUnknown`.
 *
 * THE WRITES (Task 21): `desktop.click`, `desktop.type`, `desktop.key`, `desktop.focus` go to the
 * agent-desktop writer (`ad-write.ts`), the only outcomes here that may be `outcomeUnknown`. A runner
 * the device app did not start (`NO_CONTROL`: no banner, no stop key) offers no write at all, as
 * before they existed: `unsupported`. Linux is `read_only_linux` and the legacy Windows engine
 * `read_only_windows`, before anything is built or run. Task 24's `desktop.launch`,
 * `desktop.clipboard_read` and `desktop.clipboard_write` are writes the same way.
 *
 * `desktop.wait` (Task 24) is a read on agent-desktop (`ad-read.ts`); the legacy Windows reader
 * cannot wait and answers `unsupported`, starting nothing.
 */
export type DesktopActions = ((
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  context?: DesktopContext,
) => Promise<ActionOutcome>) & { close(): Promise<void> };

/**
 * What the transport, not the caller, says about an action: the coworker it runs for. The executor
 * strips `botId` from the caller's payload and hands the server's own here; a session is chosen by
 * this alone, never by a `botId` someone put in the payload.
 */
export type DesktopContext = { botId?: string };

type Host = ReturnType<typeof createDesktopHost>;

type HelperWindow = {
  hwnd: string;
  pid: number;
  title: string;
  process: string;
  focused: boolean;
  minimized: boolean;
};
type HelperElement = {
  type?: unknown;
  name?: unknown;
  depth?: unknown;
  value?: unknown;
  disabled?: unknown;
  password?: unknown;
};
type HelperTree = {
  window: HelperWindow;
  truncated?: boolean;
  elements?: HelperElement[];
};
type HelperShot = { base64: string; width: number; height: number };

const fail = (error: string): ActionOutcome => ({ ok: false, error });

const SESSION_ACTIONS: ReadonlySet<string> = new Set([
  "desktop.session_start",
  "desktop.session_status",
  "desktop.session_end",
]);

/** A session token as the server mints it: `randomBytes(32)` in hex. */
const SESSION_TOKEN = /^[0-9a-f]{64}$/;

/** How long a macOS accessibility answer is trusted. */
const PERMISSION_CACHE_MS = 10_000;

/** `permissions` answers `{ accessibility: { state } }`; `status` nests the same under `permissions`. */
function accessibilityState(data: unknown): string | undefined {
  const node = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const root = node(data);
  const accessibility =
    node(root?.accessibility) ?? node(node(root?.permissions)?.accessibility);
  return typeof accessibility?.state === "string"
    ? accessibility.state
    : undefined;
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? text.slice(0, max) : text;
}

/** A helper failure in the words the owner and the model read. Never `outcomeUnknown`. */
function failure(error: unknown): ActionOutcome {
  if (error instanceof Error && error.name === "AbortError")
    return fail("已在设备上停止。");
  if (error instanceof DesktopHelperError) return fail(describe(error));
  return fail(desktopMessage("failed"));
}

function describe(error: DesktopHelperError): string {
  const code: DesktopErrorCode = error.code;
  switch (code) {
    case "timeout": {
      const ms = /within (\d+) ms/.exec(error.message)?.[1];
      return desktopMessage(
        "timeout",
        ms === undefined ? undefined : String(Number(ms) / 1000),
      );
    }
    case "start_failed":
      return desktopMessage(
        "start_failed",
        error.stderrTail ? scrub(error.stderrTail) : undefined,
      );
    case "sensitive":
      return desktopMessage("sensitive", scrub(error.message));
    case "failed":
      return desktopMessage("failed", scrub(error.message));
    default:
      return desktopMessage(code);
  }
}

function windowOf(window: HelperWindow): DesktopWindow {
  return {
    windowId: windowIdOf(String(window.hwnd), Number(window.pid)),
    title: clip(window.title, DESKTOP_LIMITS.titleMax),
    process: clip(window.process, DESKTOP_LIMITS.titleMax),
    focused: window.focused === true,
    minimized: window.minimized === true,
  };
}

function elementOf(
  row: HelperElement,
  snapshotId: string,
  index: number,
): DesktopElement {
  const element: DesktopElement = {
    ref: `${snapshotId}:${index}`,
    type: clip(row.type, 60),
    name: clip(row.name, DESKTOP_LIMITS.nameMax),
    depth: typeof row.depth === "number" ? row.depth : 0,
  };
  if (row.password === true) element.password = true;
  // A password box's value is never passed on, whatever the helper sent.
  else if (typeof row.value === "string")
    element.value = clip(row.value, DESKTOP_LIMITS.valueMax);
  if (row.disabled === true) element.disabled = true;
  return element;
}

/** Why there is no picture, in the words of the plan's design decision 8. */
function imageErrorOf(error: unknown): string {
  if (error instanceof DesktopHelperError) {
    if (error.code === "failed" && error.message === "minimized")
      return "窗口已最小化，截不到图。";
    if (error.code === "failed" && error.message === "not_visible")
      return "这个窗口截不到图（可能被遮挡或使用了硬件加速），请先把它切到前台。";
    return describe(error);
  }
  return desktopMessage("failed");
}

/**
 * The engine for a Node `process.platform` and the engine asked for (`--desktop-engine`): on Windows
 * the PowerShell reader unless agent-desktop is asked for; macOS and Linux only have agent-desktop;
 * any other system has none.
 */
export function desktopEngineFor(
  nodePlatform: string,
  asked: string | undefined,
): DesktopEngine | undefined {
  switch (desktopPlatformOf(nodePlatform)) {
    case "windows":
      return asked === "agent-desktop" ? "agent-desktop" : "legacy";
    case "macos":
    case "linux":
      return "agent-desktop";
    default:
      return undefined;
  }
}

export function createDesktopActions(
  opts: {
    platform?: string;
    /**
     * Callers pass one (`main` passes `desktopEngineFor`'s). The inference without one exists only
     * for the executor's own fallback (`createDesktopActions()` with no options): what
     * `desktopEngineFor` picks when there is an agent-desktop to run (a `reader` or a `helper`),
     * otherwise the PowerShell reader, which is all that fallback has.
     */
    engine?: DesktopEngine;
    /** The PowerShell reader (legacy engine). */
    host?: Host;
    /** The agent-desktop reader; a test hook. Built from `helper` and `stateDir` when absent. */
    reader?: AgentDesktopReader;
    /** The agent-desktop binary. */
    helper?: string;
    /** agent-desktop's private state directory, wiped on close even if nothing ever ran. */
    stateDir?: string;
    /** The agent-desktop CLI; a test hook. Built from `helper` and `stateDir` when absent. */
    cli?: AgentDesktopCli;
    /** The device app's channel; `NO_CONTROL` when the runner was not started by it. */
    control?: ControlChannel;
    /** The device's desktop session; built on `control` when absent. */
    sessions?: DesktopSessions;
    now?: () => number;
  } = {},
): DesktopActions {
  const platform = opts.platform ?? process.platform;
  const desktopPlatform = desktopPlatformOf(platform);
  const engine: DesktopEngine =
    opts.engine ??
    ((opts.reader || opts.helper
      ? desktopEngineFor(platform, undefined)
      : undefined) ||
      "legacy");

  const control = opts.control ?? NO_CONTROL;
  const sessions = opts.sessions ?? createDesktopSessions({ control });
  const now = opts.now ?? Date.now;

  // agent-desktop: built on first use, like the host below.
  let cli: AgentDesktopCli | undefined;
  let reader: AgentDesktopReader | undefined = opts.reader;
  const adCli = (): AgentDesktopCli => {
    if (opts.cli) return opts.cli;
    if (cli) return cli;
    if (!opts.helper || !opts.stateDir)
      throw new DesktopHelperError(
        "start_failed",
        desktopMessage("start_failed", "没有找到 agent-desktop"),
        false,
      );
    cli = createAgentDesktopCli({
      binary: opts.helper,
      stateDir: opts.stateDir,
      platform,
      // The wiped state held the refs: every window's are void.
      onIdleWipe: () => reader?.invalidate(),
    });
    return cli;
  };
  const adReader = (desktopPlatform: DesktopPlatform): AgentDesktopReader => {
    if (reader) return reader;
    reader = createAgentDesktopReader({
      cli: adCli(),
      platform: desktopPlatform,
    });
    return reader;
  };
  let writer: AgentDesktopWriter | undefined;
  const adWriter = (desktopPlatform: DesktopPlatform): AgentDesktopWriter => {
    writer ??= createAgentDesktopWriter({
      cli: adCli(),
      reader: adReader(desktopPlatform),
      sessions,
      control,
      platform: desktopPlatform,
      now,
    });
    return writer;
  };

  /** The device app is told, so it can bring its permission card up. */
  const permissionNeeded = (error: unknown) => {
    if (error instanceof DesktopHelperError && error.code === "mac_permission")
      control.emit({ event: "permission-needed" });
  };

  // macOS accessibility, as `permissions` last answered, for `PERMISSION_CACHE_MS`.
  let accessibility: { granted: boolean; at: number } | undefined;
  async function macGranted(signal?: AbortSignal): Promise<boolean> {
    if (accessibility && now() - accessibility.at < PERMISSION_CACHE_MS)
      return accessibility.granted;
    const data = await adCli().run(
      ["permissions"],
      signal ? { signal } : undefined,
    );
    accessibility = {
      granted: accessibilityState(data) === "granted",
      at: now(),
    };
    return accessibility.granted;
  }

  /** Whether this device could be written to now; the reason in the owner's words when not. */
  async function writability(
    desktopPlatform: DesktopPlatform,
    signal?: AbortSignal,
  ): Promise<{ writable: true } | { writable: false; reason: string }> {
    const no = (code: DesktopErrorCode) => ({
      writable: false as const,
      reason: desktopMessage(code),
    });
    if (desktopPlatform === "linux") return no("read_only_linux");
    if (desktopPlatform === "windows" && engine === "legacy")
      return no("read_only_windows");
    if (!control.available) return no("no_control_channel");
    if (desktopPlatform === "macos") {
      let granted: boolean;
      try {
        granted = await macGranted(signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        permissionNeeded(error);
        return {
          writable: false,
          reason:
            error instanceof DesktopHelperError
              ? scrub(error.message)
              : desktopMessage("failed"),
        };
      }
      if (!granted) {
        control.emit({ event: "permission-needed" });
        return no("mac_permission");
      }
    }
    return { writable: true };
  }

  async function sessionAct(
    desktopPlatform: DesktopPlatform,
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    context?: DesktopContext,
  ): Promise<ActionOutcome> {
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    if (action === "desktop.session_end") {
      sessions.end(text(body.token));
      return { ok: true, output: { ended: true } };
    }
    // The transport's coworker only; `body.botId` is the caller's and is never read.
    const botId = text(context?.botId);
    const actorId = text(body.actorId);
    if (action === "desktop.session_status") {
      const state = await writability(desktopPlatform, signal);
      const session = state.writable
        ? sessions.status(botId, actorId)
        : undefined;
      return {
        ok: true,
        output: {
          ...state,
          platform: desktopPlatform,
          ...(session ? { session } : {}),
        },
      };
    }
    // desktop.session_start
    const token = body.token;
    if (typeof token !== "string" || !SESSION_TOKEN.test(token))
      return fail(desktopMessage("failed", "会话令牌无效"));
    if (botId === "" || actorId === "")
      return fail(desktopMessage("failed", "缺少员工或使用者"));
    const state = await writability(desktopPlatform, signal);
    if (!state.writable) return fail(state.reason);
    if (!(await sessions.start({ token, botId, actorId }, signal)))
      // Stopped while waiting for the device: the session is already ended either way.
      return fail(
        signal?.aborted ? "已在设备上停止。" : desktopMessage("guard_unready"),
      );
    return { ok: true, output: { started: true } };
  }

  async function adAct(
    desktopPlatform: DesktopPlatform,
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    try {
      if (action === "desktop.windows")
        return {
          ok: true,
          output: await adReader(desktopPlatform).windows(signal),
        };
      if (action === "desktop.wait") {
        const r = adReader(desktopPlatform);
        if (!r.wait) return fail(desktopMessage("unsupported"));
        const output = await r.wait(
          {
            windowId: body.windowId as string,
            ...(body.name === undefined ? {} : { name: body.name as string }),
            ...(body.type === undefined ? {} : { type: body.type as string }),
            timeoutSec: body.timeoutSec as number,
            allowSensitive: body.allowSensitive === true,
          },
          signal,
        );
        return { ok: true, output };
      }
      const output = await adReader(desktopPlatform).snapshot(
        {
          windowId: body.windowId as string,
          ...(body.from === undefined ? {} : { from: body.from as string }),
          screenshot: body.screenshot === true,
          allowSensitive: body.allowSensitive === true,
        },
        signal,
      );
      return { ok: true, output };
    } catch (error) {
      permissionNeeded(error);
      // Already the Chinese copy: never through `describe` again.
      return readFailure(error);
    }
  }

  // Built on first use: constructing a host starts nothing, but a machine that never sees a desktop
  // action should not build one at all.
  let owned: Host | undefined = opts.host;
  const host = (): Host => {
    owned ??= createDesktopHost({ spec: defaultHelperSpec });
    return owned;
  };

  async function windows(signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await host().request<{ windows?: HelperWindow[] }>(
      { op: "windows", max: DESKTOP_LIMITS.windowsMax },
      signal ? { signal } : undefined,
    );
    return {
      ok: true,
      output: {
        platform: "windows",
        windows: (result.windows ?? []).map(windowOf),
      },
    };
  }

  async function snapshot(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    const target = parseWindowId(body.windowId);
    if (!target) return fail(desktopMessage("no_window"));
    const from = body.from;
    if (from !== undefined) {
      if (typeof from !== "string" || !DESKTOP_REF.test(from))
        return fail(desktopMessage("stale"));
      // A ref from an earlier helper process (or with no helper running) can never match.
      const prefix = owned?.prefix;
      if (prefix === undefined || from.split("-")[0] !== prefix)
        return fail(desktopMessage("stale"));
    }
    const refuseWords =
      body.allowSensitive === true ? [] : [...DESKTOP_WINDOW_WORDS];
    const h = host();
    await h.ensure(signal ? { signal } : undefined);
    const snapshotId = h.nextSnapshotId();
    const tree = await h.request<HelperTree>(
      {
        op: "tree",
        hwnd: target.hwnd,
        pid: target.pid,
        snapshot: snapshotId,
        ...(from === undefined ? {} : { from }),
        maxDepth: DESKTOP_LIMITS.treeMaxDepth,
        maxNodes: DESKTOP_LIMITS.treeMaxNodes,
        nameMax: DESKTOP_LIMITS.nameMax,
        valueMax: DESKTOP_LIMITS.valueMax,
        budgetMs: DESKTOP_LIMITS.walkBudgetMs,
        refuseWords,
      },
      signal ? { signal } : undefined,
    );
    const result: DesktopSnapshot = {
      snapshotId,
      window: windowOf(tree.window),
      truncated: tree.truncated === true,
      elements: (tree.elements ?? []).map((row, index) =>
        elementOf(row, snapshotId, index),
      ),
    };
    if (body.screenshot === true) {
      try {
        const shot = await h.request<HelperShot>(
          {
            op: "screenshot",
            hwnd: target.hwnd,
            pid: target.pid,
            maxEdge: DESKTOP_LIMITS.screenshotMaxEdge,
            refuseWords,
          },
          signal ? { signal } : undefined,
        );
        const image: DesktopImage = {
          base64: shot.base64,
          width: shot.width,
          height: shot.height,
        };
        result.image = image;
      } catch (error) {
        // Stopped means stopped; any other picture failure still returns the tree that was read.
        if (error instanceof Error && error.name === "AbortError") throw error;
        result.imageError = imageErrorOf(error);
      }
    }
    return { ok: true, output: result };
  }

  const act = async (
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    context?: DesktopContext,
  ): Promise<ActionOutcome> => {
    if (!desktopPlatform) return fail(desktopMessage("unsupported_platform"));
    if (engine === "legacy" && platform !== "win32")
      return fail(desktopMessage("not_windows"));
    if (!DESKTOP_ACTIONS.has(action))
      return fail(desktopMessage("unsupported"));
    if (DESKTOP_WRITE_ACTIONS.has(action)) {
      if (control === NO_CONTROL) return fail(desktopMessage("unsupported"));
      if (desktopPlatform === "linux")
        return fail(desktopMessage("read_only_linux"));
      if (engine === "legacy") return fail(desktopMessage("read_only_windows"));
      try {
        return await adWriter(desktopPlatform)(action, body, signal, context);
      } catch (error) {
        // Building the writer failed (no agent-desktop): nothing was sent.
        return readFailure(error);
      }
    }
    if (SESSION_ACTIONS.has(action)) {
      try {
        return await sessionAct(desktopPlatform, action, body, signal, context);
      } catch (error) {
        return readFailure(error);
      }
    }
    if (engine === "agent-desktop")
      return adAct(desktopPlatform, action, body, signal);
    // The PowerShell reader lists and reads; it cannot wait for a control.
    if (action === "desktop.wait") return fail(desktopMessage("unsupported"));
    try {
      return action === "desktop.windows"
        ? await windows(signal)
        : await snapshot(body, signal);
    } catch (error) {
      return failure(error);
    }
  };

  return Object.assign(act, {
    close: async () => {
      // Wipes agent-desktop's state: through the CLI when one ran (it empties the directory after
      // its last command), and directly when none did, so a leftover from a crashed run never
      // outlives a runner that stops. A later action starts afresh, with a new prefix, so no ref
      // from before resolves.
      const closing = cli;
      if (closing) {
        cli = undefined;
        reader = opts.reader;
        writer = undefined;
      }
      const stateDir = opts.stateDir;
      await Promise.all([
        owned?.close(),
        closing
          ? closing.close()
          : stateDir
            ? // Best effort: the next start wipes it again.
              rm(stateDir, { recursive: true, force: true }).catch(() => {})
            : undefined,
      ]);
    },
  });
}
