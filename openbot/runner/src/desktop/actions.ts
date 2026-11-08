import { homedir } from "node:os";
import {
  DESKTOP_ACTIONS,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_WORDS,
  type DesktopElement,
  type DesktopErrorCode,
  type DesktopImage,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
  parseWindowId,
  windowIdOf,
} from "../../../shared/desktop-control";
import type { ActionOutcome } from "../execute";
import {
  createDesktopHost,
  DesktopHelperError,
  defaultHelperSpec,
} from "./host";

/**
 * `desktop.windows` and `desktop.snapshot` (docs/specs/2026-11-07-desktop-control.md, Phase 1: read
 * only; plan Task 4). Every other `desktop.*` action is answered `unsupported` here and never reaches
 * the helper.
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The names this account goes by on this machine: its user name and its home folder's last segment. */
function accountNames(): string[] {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const name = value?.trim();
    if (name && name.length >= 2) names.add(name);
  };
  add(process.env.USERNAME);
  add(process.env.USER);
  for (const home of [process.env.HOME, process.env.USERPROFILE]) {
    add(home?.split(/[\\/]/).filter(Boolean).pop());
  }
  try {
    add(homedir().split(/[\\/]/).filter(Boolean).pop());
  } catch {
    // No home folder to learn a name from.
  }
  return [...names];
}

/**
 * The helper's stderr tail with every file path and the account's name taken out, so neither leaves
 * the device in an error message.
 */
function scrub(text: string): string {
  let out = text
    // C:\dir\sub dir\file (folders may hold spaces; the last part ends at whitespace).
    .replace(
      /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\s\\/:*?"<>|]*/g,
      "<路径>",
    )
    // \\server\share\file
    .replace(/\\\\[^\s"'<>|]+/g, "<路径>")
    // /home/x/y, ~/x
    .replace(/(?<![\w.:])(?:~|\/)(?:[^\s/"'<>|:]+\/)*[^\s/"'<>|:]*/g, (hit) =>
      hit === "/" || hit === "~" ? hit : "<路径>",
    );
  for (const name of accountNames())
    out = out.replace(new RegExp(escapeRegExp(name), "gi"), "<用户>");
  return out;
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

export function createDesktopActions(
  opts: { platform?: string; host?: Host } = {},
): DesktopActions {
  const platform = opts.platform ?? process.platform;
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
    if (platform !== "win32") return fail(desktopMessage("not_windows"));
    if (!DESKTOP_ACTIONS.has(action))
      return fail(desktopMessage("unsupported"));
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
      await owned?.close();
    },
  });
}
