import { createHash, randomBytes } from "node:crypto";
import {
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_WORDS,
  type DesktopElement,
  type DesktopErrorCode,
  type DesktopImage,
  type DesktopPlatform,
  type DesktopSnapshot,
  type DesktopWaitPayload,
  type DesktopWindow,
  desktopMessage,
  sensitiveWord,
} from "../../../shared/desktop-control";
import type { ActionOutcome } from "../execute";
import { type AgentDesktopCli, AgentDesktopError } from "./agent-desktop";
import { DesktopHelperError } from "./host";
import { scalePngToMaxEdge } from "./png-scale";
import { scrub } from "./scrub";

/**
 * Reading the desktop through agent-desktop (plan docs/plans/2026-11-12-desktop-write.md, Task 8):
 * listing windows, and turning a snapshot's nested tree into phase 1's flat element list.
 *
 * WINDOW IDS ARE THE RUNNER'S OWN. agent-desktop's ids differ in shape on every platform (and on
 * Linux carry a D-Bus path), so each window gets `a` + the first 16 hex digits of
 * sha256(prefix, agent-desktop id, pid) (design decision 8). The prefix is six random hex digits
 * drawn for every reader, so an id from an earlier runner process never resolves. The latest
 * `DESKTOP_LIMITS.windowIdsKept` ids are remembered.
 *
 * REFS ARE STRICT. A control's ref is phase 1's `${prefix}-${n}:${index}`. Only the latest snapshot
 * of each window (for at most `snapshotsKept` windows) resolves; an older one, another reader's, and
 * one whose window was invalidated (after a write, after the idle wipe) are `"stale"`. A node that
 * agent-desktop gave no `ref_id` cannot be acted on: `"not_actionable"`.
 *
 * FAILURES are `DesktopHelperError`s whose message is already the Chinese copy the owner and the
 * model read (`readFailure` turns one into an outcome); an abort stays an `AbortError`. A read is
 * never `outcomeUnknown`: it changes nothing on the machine.
 *
 * WAITING (Task 24) is a read too: `wait` is a snapshot that agent-desktop holds back until the
 * control shows up (`--wait-for "<type>:<name>"`, `--wait-timeout`), under the same title rule. Its
 * refs replace the window's older ones, as any snapshot's do. Running out of time is a plain failure
 * (`waitTimedOut`), never `outcomeUnknown`.
 *
 * DISPLAYS. A window's `display` is the index of the display that holds its centre, with the primary
 * display first (0) and the others in the order agent-desktop lists them.
 *
 * Measured facts behind the conversion: runner/tests/fixtures/agent-desktop/FACTS.md.
 */

export type DesktopControl = {
  type: string;
  name: string;
  password?: true;
  singleLine?: true;
};
export type ResolvedRef = {
  adRef: string;
  windowId: string;
  adWindowId: string;
  control: DesktopControl;
};
export type AgentDesktopReader = {
  /** Six hex digits, drawn afresh for every reader. */
  readonly prefix: string;
  windows(
    signal?: AbortSignal,
  ): Promise<{ platform: DesktopPlatform; windows: DesktopWindow[] }>;
  snapshot(
    body: {
      windowId: string;
      from?: string;
      screenshot?: boolean;
      allowSensitive?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<DesktopSnapshot & { platform: DesktopPlatform }>;
  /**
   * Waits up to `timeoutSec` for a control to show up in the window, then reads it as `snapshot`
   * does: the result's refs are the window's latest. Optional so a stand-in reader may leave it out.
   */
  wait?(
    body: DesktopWaitPayload,
    signal?: AbortSignal,
  ): Promise<DesktopSnapshot & { platform: DesktopPlatform }>;
  /** For write actions: only refs of this window's latest snapshot resolve; anything else is "stale"; a node with no ref_id is "not_actionable". */
  resolveRef(ref: string): ResolvedRef | "stale" | "not_actionable";
  /**
   * The whole name of a ref's control, as agent-desktop gave it, for the approval checks only: the
   * snapshot and every output carry it cut to `nameMax`, so a word past that point would otherwise
   * go unseen. Undefined for a ref that does not resolve. Optional so a stand-in may leave it out.
   */
  fullName?(ref: string): string | undefined;
  adWindow(windowId: string): { adWindowId: string; pid: number } | undefined;
  /**
   * The window's title as the latest read saw it (a listing or a snapshot), cut to `titleMax`; a
   * write compares it with the title now (spec §5). Optional so a stand-in reader may leave it out.
   */
  readTitle?(windowId: string): string | undefined;
  /**
   * The same title whole, as agent-desktop gave it, for the approval checks only: a word added past
   * `titleMax` changes the title without changing what is shown. Never passed on. Optional so a
   * stand-in reader may leave it out.
   */
  readFullTitle?(windowId: string): string | undefined;
  /** After a write succeeds, and after the idle wipe: this window's refs (or every window's) are void. */
  invalidate(windowId?: string): void;
};

type Node = Record<string, unknown>;
type AdWindow = { adWindowId: string; pid: number };
type Snap = {
  snapshotId: string;
  elements: DesktopElement[];
  adRefs: (string | undefined)[];
  /** Index → the whole name of a node whose name was cut for `elements`; never passed on. */
  longNames?: Map<number, string>;
};

/** agent-desktop's own qualified ref, `@<snapshot id>:e<N>`; nothing else is ever passed back to it. */
const AD_REF = /^@[A-Za-z0-9]{1,64}:e[1-9]\d{0,8}$/;

const TYPE_MAX = 60;

/** A control type to wait for: a role such as `button`, never a colon. */
const WAIT_TYPE = /^[A-Za-z][A-Za-z0-9_ -]{0,59}$/;

/** What a wait that ran out of time says. */
export function waitTimedOut(seconds: number): string {
  return `等了 ${seconds} 秒，没有等到这个控件。`;
}

const SCREENSHOT_UNSUPPORTED = "这张截图的格式无法缩小，没有附上。";
const SCREENSHOT_NO_PERMISSION = "没有屏幕录制权限，截不到图。";

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? text.slice(0, max) : text;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** A failure in the words the owner and the model read. */
function readError(
  code: DesktopErrorCode,
  detail?: string,
): DesktopHelperError {
  return new DesktopHelperError(code, desktopMessage(code, detail), false);
}

function codeFor(
  error: AgentDesktopError,
  platform: DesktopPlatform,
): DesktopErrorCode {
  switch (error.code) {
    case "WINDOW_NOT_FOUND":
    case "APP_NOT_FOUND":
      return "no_window";
    case "STALE_REF":
    case "SNAPSHOT_NOT_FOUND":
    case "ELEMENT_NOT_FOUND":
      return "stale";
    case "PERM_DENIED":
      if (platform === "macos") return "mac_permission";
      if (
        platform === "windows" &&
        /E_ACCESSDENIED|0x80070005/i.test(
          `${error.detail ?? ""} ${error.message}`,
        )
      )
        return "elevated";
      return "failed";
    case "AMBIGUOUS_TARGET":
      return "ambiguous";
    case "POLICY_DENIED":
    case "ACTION_NOT_SUPPORTED":
      return "policy_denied";
    case "PLATFORM_NOT_SUPPORTED":
      // Linux without a session bus (FACTS (k)).
      return platform === "linux" ? "linux_bus" : "failed";
    default:
      return "failed";
  }
}

/**
 * Whatever a CLI call threw, as the reader throws it: an abort as is, an agent-desktop error mapped
 * to its Chinese copy (details with paths and the account name taken out), the CLI layer's own
 * errors with paths taken out.
 */
export function toReadError(error: unknown, platform: DesktopPlatform): Error {
  if (isAbort(error)) return error as Error;
  if (error instanceof AgentDesktopError) {
    const code = codeFor(error, platform);
    return code === "failed"
      ? readError(
          "failed",
          scrub(`${error.code}：${error.message}`).slice(0, 300),
        )
      : readError(code);
  }
  if (error instanceof DesktopHelperError)
    return new DesktopHelperError(error.code, scrub(error.message), error.sent);
  return readError("failed");
}

/**
 * Whatever a write's CLI call threw, as the writer reports it (final review M3): an agent-desktop
 * error by its code and our own words, never its message, which could repeat what a control holds;
 * a helper that did not start without the detail it gave. The one exception is INVALID_ARGS, refused
 * while agent-desktop reads our own command line: it can only repeat what we passed there (a ref, a
 * window id, an app's name, a key), never typed text, which goes through stdin.
 */
export function toWriteError(error: unknown, platform: DesktopPlatform): Error {
  if (error instanceof AgentDesktopError && error.code !== "INVALID_ARGS") {
    const code = codeFor(error, platform);
    if (code !== "failed") return readError(code);
    const named = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : "UNKNOWN";
    return readError("failed", `错误码 ${named}`);
  }
  if (error instanceof DesktopHelperError && error.code === "start_failed")
    return new DesktopHelperError(
      "start_failed",
      desktopMessage("start_failed"),
      error.sent,
    );
  return toReadError(error, platform);
}

/** A failed read as an action outcome. Never `outcomeUnknown`. */
export function readFailure(error: unknown): ActionOutcome {
  if (isAbort(error)) return { ok: false, error: "已在设备上停止。" };
  if (error instanceof DesktopHelperError)
    return { ok: false, error: error.message };
  return { ok: false, error: desktopMessage("failed") };
}

/**
 * agent-desktop's nested tree as phase 1's flat element list (depth first, the root at depth 0),
 * with each index's agent-desktop ref (`undefined` for a static node).
 */
export function flattenTree(
  tree: unknown,
  snapshotId: string,
  limits: typeof DESKTOP_LIMITS,
): {
  elements: DesktopElement[];
  adRefs: (string | undefined)[];
  truncated: boolean;
  /** Index → the whole name, only for names cut to `nameMax`; absent when none was. */
  longNames?: Map<number, string>;
} {
  const elements: DesktopElement[] = [];
  const adRefs: (string | undefined)[] = [];
  const longNames = new Map<number, string>();
  let truncated = false;
  if (!isNode(tree)) return { elements, adRefs, truncated };
  const stack: Array<{ node: Node; depth: number; parentRole?: unknown }> = [
    { node: tree, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth, parentRole } = stack.pop() as (typeof stack)[number];
    if (elements.length >= limits.treeMaxNodes) {
      truncated = true;
      break;
    }
    const states = Array.isArray(node.states)
      ? node.states.filter((s): s is string => typeof s === "string")
      : [];
    if (typeof node.name === "string" && node.name.length > limits.nameMax)
      longNames.set(elements.length, node.name);
    const element: DesktopElement = {
      ref: `${snapshotId}:${elements.length}`,
      type: clip(node.role, TYPE_MAX),
      name: clip(node.name, limits.nameMax),
      depth,
    };
    // FACTS (a): a password box is a "secure" textfield. Any "secure" node is treated as one, and its
    // value is never passed on, whatever upstream sent.
    if (states.includes("secure")) element.password = true;
    else if (typeof node.value === "string")
      element.value = clip(node.value, limits.valueMax);
    // FACTS (c).
    if (states.includes("disabled")) element.disabled = true;
    // FACTS (b): only a textfield inside a scrollarea is known to be multi-line. Every other one is
    // treated as single-line, so a newline typed into it asks first.
    if (node.role === "textfield" && parentRole !== "scrollarea")
      element.singleLine = true;
    elements.push(element);
    adRefs.push(
      typeof node.ref_id === "string" && AD_REF.test(node.ref_id)
        ? node.ref_id
        : undefined,
    );
    // The depth is bounded by agent-desktop itself (`--max-depth`).
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (isNode(child))
        stack.push({ node: child, depth: depth + 1, parentRole: node.role });
    }
  }
  return {
    elements,
    adRefs,
    truncated,
    ...(longNames.size > 0 ? { longNames } : {}),
  };
}

function boundsOf(value: unknown): DesktopWindow["bounds"] {
  if (!isNode(value)) return undefined;
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite)
  )
    return undefined;
  return { x, y, width, height };
}

/** list-displays with the primary display first, the others in the order listed. */
function primaryFirst(displays: unknown[]): unknown[] {
  const index = displays.findIndex(
    (display) => isNode(display) && display.is_primary === true,
  );
  if (index <= 0) return displays;
  return [
    displays[index],
    ...displays.slice(0, index),
    ...displays.slice(index + 1),
  ];
}

/** The display (an index into list-displays, the primary first) that holds the centre of `bounds`. */
function displayOf(
  bounds: NonNullable<DesktopWindow["bounds"]>,
  displays: unknown[],
): number | undefined {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const index = displays.findIndex((display) => {
    const b = isNode(display) ? boundsOf(display.bounds) : undefined;
    return (
      b !== undefined &&
      cx >= b.x &&
      cx < b.x + b.width &&
      cy >= b.y &&
      cy < b.y + b.height
    );
  });
  return index >= 0 ? index : undefined;
}

function windowOf(
  raw: Node,
  windowId: string,
  displays?: unknown[],
): DesktopWindow {
  const window: DesktopWindow = {
    windowId,
    title: clip(raw.title, DESKTOP_LIMITS.titleMax),
    process: clip(raw.app_name, DESKTOP_LIMITS.titleMax),
    focused: raw.is_focused === true,
    // macOS has no `minimized` field (FACTS (j)).
    minimized: raw.minimized === true,
  };
  const bounds = boundsOf(raw.bounds);
  if (bounds) {
    window.bounds = bounds;
    const display = displays ? displayOf(bounds, displays) : undefined;
    if (display !== undefined) window.display = display;
  }
  return window;
}

/** A listed window agent-desktop can name: a string id and a process id. */
function adWindowOf(raw: unknown): AdWindow | undefined {
  if (!isNode(raw) || typeof raw.id !== "string" || raw.id === "")
    return undefined;
  const pid = raw.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0)
    return undefined;
  return { adWindowId: raw.id, pid };
}

function controlOf(element: DesktopElement): DesktopControl {
  const control: DesktopControl = { type: element.type, name: element.name };
  if (element.password) control.password = true;
  if (element.singleLine) control.singleLine = true;
  return control;
}

/** Moves `key` to the newest end of `map` and drops the oldest entries beyond `max`. */
function remember<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
  onDrop?: (key: K) => void,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
    onDrop?.(oldest);
  }
}

export function createAgentDesktopReader(opts: {
  cli: AgentDesktopCli;
  platform: DesktopPlatform;
}): AgentDesktopReader {
  const { cli, platform } = opts;
  const prefix = randomBytes(3).toString("hex");
  /** Runner window id → agent-desktop's window, the latest `windowIdsKept`. */
  const windowIds = new Map<string, AdWindow>();
  /** Runner window id → its latest snapshot, the latest `snapshotsKept` windows. */
  const snaps = new Map<string, Snap>();
  /** Runner window id → its title as last read; kept for the same windows as `windowIds`. */
  const titles = new Map<string, string>();
  /** The same titles whole, never cut and never passed on. */
  const fullTitles = new Map<string, string>();
  let counter = 0;
  /**
   * Invalidation generations, so a snapshot that was running while its window (or every window) was
   * invalidated does not store refs read before the change: `epoch` counts invalidations, and a
   * snapshot stores its ref map only if nothing it covers was invalidated after it started. The
   * per-window marks matter only while a snapshot runs, so they are dropped once none does.
   */
  let epoch = 0;
  let allInvalidatedAt = 0;
  const invalidatedAt = new Map<string, number>();
  let running = 0;

  const idOf = (w: AdWindow) =>
    `a${createHash("sha256")
      .update(`${prefix}\0${w.adWindowId}\0${w.pid}`)
      .digest("hex")
      .slice(0, 16)}`;

  const run = async (
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => {
    try {
      return await cli.run(args, {
        ...(signal ? { signal } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      throw toReadError(error, platform);
    }
  };

  const listRaw = async (signal?: AbortSignal): Promise<unknown[]> => {
    const data = await run(["list-windows"], signal);
    return Array.isArray(data) ? data : [];
  };

  async function windows(signal?: AbortSignal) {
    const raw = await listRaw(signal);
    if (platform === "linux" && raw.length === 0) {
      // No session bus: `status` still answers, with accessibility denied (FACTS (k)).
      const status = await run(["status"], signal);
      const permissions = isNode(status) ? status.permissions : undefined;
      const accessibility = isNode(permissions)
        ? permissions.accessibility
        : undefined;
      if (isNode(accessibility) && accessibility.state === "denied")
        throw readError("linux_bus");
    }
    const listed: Array<{ raw: Node; ad: AdWindow }> = [];
    for (const entry of raw) {
      if (listed.length >= DESKTOP_LIMITS.windowsMax) break;
      const ad = adWindowOf(entry);
      if (!ad || (entry as Node).accessible === false) continue;
      listed.push({ raw: entry as Node, ad });
    }
    let displays: unknown[] = [];
    if (listed.length > 0) {
      try {
        const data = await cli.run(
          ["list-displays"],
          signal ? { signal } : undefined,
        );
        if (Array.isArray(data)) displays = primaryFirst(data);
      } catch (error) {
        // Which display a window is on is a nicety; the listing stands without it.
        if (isAbort(error)) throw error;
      }
    }
    const result: DesktopWindow[] = [];
    for (const { raw: entry, ad } of listed) {
      const windowId = idOf(ad);
      remember(
        windowIds,
        windowId,
        ad,
        DESKTOP_LIMITS.windowIdsKept,
        (gone) => {
          snaps.delete(gone);
          titles.delete(gone);
          fullTitles.delete(gone);
        },
      );
      const window = windowOf(entry, windowId, displays);
      titles.set(windowId, window.title);
      fullTitles.set(
        windowId,
        typeof entry.title === "string" ? entry.title : "",
      );
      result.push(window);
    }
    return { platform, windows: result };
  }

  async function screenshot(
    adWindowId: string,
    signal?: AbortSignal,
  ): Promise<{ image?: DesktopImage; imageError?: string }> {
    let data: unknown;
    try {
      data = await cli.run(
        ["screenshot", "--window-id", adWindowId],
        signal ? { signal } : undefined,
      );
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof AgentDesktopError && error.code === "PERM_DENIED")
        return { imageError: SCREENSHOT_NO_PERMISSION };
      return { imageError: toReadError(error, platform).message };
    }
    // FACTS (e): data.data is the base64 PNG, with format, width, height and scale_factor beside it.
    const shot = isNode(data) ? data : {};
    if (typeof shot.data !== "string" || (shot.format ?? "png") !== "png")
      return { imageError: SCREENSHOT_UNSUPPORTED };
    const scaled = scalePngToMaxEdge(
      new Uint8Array(Buffer.from(shot.data, "base64")),
      DESKTOP_LIMITS.screenshotMaxEdge,
    );
    if (scaled === "unsupported") return { imageError: SCREENSHOT_UNSUPPORTED };
    return {
      image: {
        base64: Buffer.from(scaled.png).toString("base64"),
        width: scaled.width,
        height: scaled.height,
      },
    };
  }

  async function snapshot(
    body: {
      windowId: string;
      from?: string;
      screenshot?: boolean;
      allowSensitive?: boolean;
    },
    signal?: AbortSignal,
  ) {
    const windowId = body.windowId;
    const target =
      typeof windowId === "string" ? windowIds.get(windowId) : undefined;
    if (!target) throw readError("no_window");

    let root: string | undefined;
    if (body.from !== undefined) {
      const from = body.from;
      if (typeof from !== "string" || !DESKTOP_REF.test(from))
        throw readError("stale");
      const colon = from.indexOf(":");
      const snapshotId = from.slice(0, colon);
      const index = Number(from.slice(colon + 1));
      const latest = snaps.get(windowId);
      if (
        snapshotId.split("-")[0] !== prefix ||
        !latest ||
        latest.snapshotId !== snapshotId ||
        index >= latest.elements.length
      )
        throw readError("stale");
      root = latest.adRefs[index];
      if (root === undefined) throw readError("not_actionable");
    }

    return tracked((started) =>
      read(body, windowId, target, root, signal, started),
    );
  }

  /** Runs a read that may store refs, marking it as running for `invalidate`. */
  async function tracked<T>(task: (started: number) => Promise<T>) {
    const started = epoch;
    running++;
    try {
      return await task(started);
    } finally {
      running--;
      if (running === 0) invalidatedAt.clear();
    }
  }

  async function wait(body: DesktopWaitPayload, signal?: AbortSignal) {
    const seconds = body.timeoutSec;
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > DESKTOP_LIMITS.waitMaxSec
    )
      throw readError(
        "failed",
        `等待时间要在 1～${DESKTOP_LIMITS.waitMaxSec} 秒之间`,
      );
    const { name, type } = body;
    const nameOk =
      name === undefined ||
      (typeof name === "string" &&
        name.trim() !== "" &&
        name.length <= DESKTOP_LIMITS.nameMax &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
        !/[\u0000-\u001f\u007f]/.test(name));
    const typeOk =
      type === undefined || (typeof type === "string" && WAIT_TYPE.test(type));
    if (!nameOk || !typeOk || (name === undefined && type === undefined))
      throw readError("failed", "要等的控件写得不对");
    const windowId = body.windowId;
    const target =
      typeof windowId === "string" ? windowIds.get(windowId) : undefined;
    if (!target) throw readError("no_window");
    return tracked((started) =>
      read(
        { allowSensitive: body.allowSensitive === true },
        windowId,
        target,
        undefined,
        signal,
        started,
        { target: `${type ?? ""}:${name ?? ""}`, seconds },
      ),
    );
  }

  async function read(
    body: { screenshot?: boolean; allowSensitive?: boolean },
    windowId: string,
    target: AdWindow,
    root: string | undefined,
    signal: AbortSignal | undefined,
    started: number,
    /** A wait: the control to wait for and how long, in seconds. */
    waitFor?: { target: string; seconds: number },
  ) {
    // The title as it is now, before anything is read (spec §5).
    const live = (await listRaw(signal)).find((entry) => {
      const ad = adWindowOf(entry);
      return (
        ad !== undefined &&
        ad.adWindowId === target.adWindowId &&
        ad.pid === target.pid
      );
    }) as Node | undefined;
    if (!live) throw readError("no_window");
    if (body.allowSensitive !== true) {
      const word = sensitiveWord(
        clip(live.title, 10_000),
        DESKTOP_WINDOW_WORDS,
      );
      if (word !== undefined) throw readError("sensitive", word);
    }

    const data = waitFor
      ? await waitRun(target.adWindowId, waitFor, signal)
      : await run(
          [
            "snapshot",
            ...(root === undefined
              ? ["--window-id", target.adWindowId]
              : ["--root", root]),
            "--compact",
            "--max-depth",
            String(DESKTOP_LIMITS.treeMaxDepth),
            "--timeout-ms",
            String(DESKTOP_LIMITS.adSnapshotTimeoutMs),
          ],
          signal,
          // The CLI waits longer than agent-desktop's own budget, so a slow window comes back as a
          // partial tree (`complete: false`) rather than a killed process.
          DESKTOP_LIMITS.adCommandTimeoutMs,
        );
    const envelope = isNode(data) ? data : {};
    counter++;
    const snapshotId = `${prefix}-${counter}`;
    const flat = flattenTree(envelope.tree, snapshotId, DESKTOP_LIMITS);
    // Invalidated (or forgotten) while it ran: the result goes back, but its refs never resolve.
    if (
      allInvalidatedAt <= started &&
      (invalidatedAt.get(windowId) ?? 0) <= started &&
      windowIds.has(windowId)
    )
      remember(
        snaps,
        windowId,
        {
          snapshotId,
          elements: flat.elements,
          adRefs: flat.adRefs,
          ...(flat.longNames ? { longNames: flat.longNames } : {}),
        },
        DESKTOP_LIMITS.snapshotsKept,
      );
    const window = windowOf(live, windowId);
    if (windowIds.has(windowId)) {
      titles.set(windowId, window.title);
      fullTitles.set(
        windowId,
        typeof live.title === "string" ? live.title : "",
      );
    }
    const result: DesktopSnapshot & { platform: DesktopPlatform } = {
      platform,
      snapshotId,
      window,
      truncated: flat.truncated || envelope.complete === false,
      elements: flat.elements,
    };
    if (body.screenshot === true)
      Object.assign(result, await screenshot(target.adWindowId, signal));
    return result;
  }

  /** The wait's snapshot command; running out of time, agent-desktop's or the CLI's, is `waitTimedOut`. */
  async function waitRun(
    adWindowId: string,
    waitFor: { target: string; seconds: number },
    signal?: AbortSignal,
  ) {
    const ms = waitFor.seconds * 1000;
    try {
      return await cli.run(
        [
          "snapshot",
          "--window-id",
          adWindowId,
          "--compact",
          "--max-depth",
          String(DESKTOP_LIMITS.treeMaxDepth),
          "--wait-for",
          waitFor.target,
          "--wait-timeout",
          String(ms),
        ],
        {
          ...(signal ? { signal } : {}),
          // The whole wait, and then a command's budget for the snapshot itself.
          timeoutMs: ms + DESKTOP_LIMITS.adCommandTimeoutMs,
        },
      );
    } catch (error) {
      if (
        (error instanceof AgentDesktopError && error.code === "TIMEOUT") ||
        (error instanceof DesktopHelperError && error.code === "timeout")
      )
        throw new DesktopHelperError(
          "timeout",
          waitTimedOut(waitFor.seconds),
          false,
        );
      throw toReadError(error, platform);
    }
  }

  function fullName(ref: string): string | undefined {
    const resolved = resolveRef(ref);
    if (typeof resolved === "string") return undefined;
    const colon = ref.indexOf(":");
    const snapshotId = ref.slice(0, colon);
    const index = Number(ref.slice(colon + 1));
    for (const snap of snaps.values())
      if (snap.snapshotId === snapshotId)
        return snap.longNames?.get(index) ?? snap.elements[index]?.name;
    return undefined;
  }

  function resolveRef(ref: string): ResolvedRef | "stale" | "not_actionable" {
    if (typeof ref !== "string" || !DESKTOP_REF.test(ref)) return "stale";
    const colon = ref.indexOf(":");
    const snapshotId = ref.slice(0, colon);
    const index = Number(ref.slice(colon + 1));
    if (snapshotId.split("-")[0] !== prefix) return "stale";
    for (const [windowId, snap] of snaps) {
      if (snap.snapshotId !== snapshotId) continue;
      const target = windowIds.get(windowId);
      const element = snap.elements[index];
      if (!target || !element) return "stale";
      const adRef = snap.adRefs[index];
      if (adRef === undefined) return "not_actionable";
      return {
        adRef,
        windowId,
        adWindowId: target.adWindowId,
        control: controlOf(element),
      };
    }
    return "stale";
  }

  return {
    prefix,
    windows,
    snapshot,
    wait,
    resolveRef,
    fullName,
    adWindow(windowId) {
      const target = windowIds.get(windowId);
      return target ? { ...target } : undefined;
    },
    readTitle(windowId) {
      return titles.get(windowId);
    },
    readFullTitle(windowId) {
      return fullTitles.get(windowId);
    },
    invalidate(windowId) {
      epoch++;
      if (windowId === undefined) {
        allInvalidatedAt = epoch;
        invalidatedAt.clear();
        snaps.clear();
      } else {
        if (running > 0) invalidatedAt.set(windowId, epoch);
        snaps.delete(windowId);
      }
    },
  };
}
