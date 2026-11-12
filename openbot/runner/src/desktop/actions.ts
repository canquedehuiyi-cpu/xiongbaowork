import { rm } from "node:fs/promises";
import {
  DESKTOP_ACTIONS,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_WORDS,
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
import { type AgentDesktopCli, createAgentDesktopCli } from "./agent-desktop";
import {
  createDesktopHost,
  DesktopHelperError,
  defaultHelperSpec,
} from "./host";
import { scrub } from "./scrub";

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
 */
export type DesktopActions = ((
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ActionOutcome>) & { close(): Promise<void> };

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

  // agent-desktop: built on first use, like the host below.
  let cli: AgentDesktopCli | undefined;
  let reader: AgentDesktopReader | undefined = opts.reader;
  const adReader = (desktopPlatform: DesktopPlatform): AgentDesktopReader => {
    if (reader) return reader;
    if (!opts.helper || !opts.stateDir)
      throw new DesktopHelperError(
        "start_failed",
        desktopMessage("start_failed", "没有找到 agent-desktop"),
        false,
      );
    const built = createAgentDesktopCli({
      binary: opts.helper,
      stateDir: opts.stateDir,
      platform,
      // The wiped state held the refs: every window's are void.
      onIdleWipe: () => reader?.invalidate(),
    });
    cli = built;
    reader = createAgentDesktopReader({
      cli: built,
      platform: desktopPlatform,
    });
    return reader;
  };

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
  ): Promise<ActionOutcome> => {
    if (!desktopPlatform) return fail(desktopMessage("unsupported_platform"));
    if (engine === "legacy" && platform !== "win32")
      return fail(desktopMessage("not_windows"));
    if (!DESKTOP_ACTIONS.has(action))
      return fail(desktopMessage("unsupported"));
    if (engine === "agent-desktop")
      return adAct(desktopPlatform, action, body, signal);
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
