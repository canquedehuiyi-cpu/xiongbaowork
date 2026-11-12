/*
 * The desktop probe (plan docs/plans/2026-11-12-desktop-write.md, Task 10): the runner's own
 * `desktop.windows` and `desktop.snapshot`, through the real pinned agent-desktop binary, against a
 * real editor on each hosted runner (Notepad on windows-latest, TextEdit on macos-latest, gedit under
 * Xvfb with an AT-SPI bus on ubuntu-latest).
 *
 * Then the writes (Task 23), through the runner's own session actions and the control channel, whose
 * device end the probe plays itself (it answers that the banner is up and the mouse check paused). On
 * macOS only: Chinese typed into TextEdit and read back, a write voiding the window's refs, and a key
 * that needs the window in front. Each write is sent once and never again: a write that failed is
 * reported as it came back, not retried, so nothing is typed twice. Linux and the legacy Windows engine
 * must refuse a write in their own words.
 *
 *   bun scripts/ci/desktop-probe.ts <fresh empty dir> --helper <agent-desktop binary>
 *
 * Every check prints one JSON line, `{"check":…,"passed":true|false}`; a failed one also prints what
 * came back. `DESKTOP_PROBE_PASS` is the last line only when every check passed. A runner without
 * accessibility permission or without a session bus fails here (design decision 20): it is reported,
 * never skipped.
 *
 * Measured facts behind the setup: runner/tests/fixtures/agent-desktop/FACTS.md.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, win32 } from "node:path";
import {
  createDesktopActions,
  desktopEngineFor,
} from "../../runner/src/desktop/actions.ts";
import { agentDesktopEnv } from "../../runner/src/desktop/agent-desktop.ts";
import {
  CONTROL_LINE_PREFIX,
  type ControlChannel,
  createControlChannel,
} from "../../runner/src/desktop/control.ts";
import { createDesktopHost } from "../../runner/src/desktop/host.ts";
import {
  createRunnerExecutor,
  type RunnerExecutor,
} from "../../runner/src/execute.ts";
import {
  DESKTOP_REF,
  type DesktopPlatform,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
  desktopPlatformOf,
  isAgentWindowId,
} from "../../shared/desktop-control.ts";

type Assert = (ok: unknown, label: string, seen?: unknown) => void;
type Result = { ok: boolean; output?: unknown; error?: string };
type Run = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<Result>;

/** The read checks' labels, in the order they run. Every platform must pass all eight. */
export const DESKTOP_PROBE_CHECKS = {
  listed: "agent-desktop lists the editor with its Chinese title",
  read: "the editor's text reads back in Chinese",
  stale: "an older snapshot's ref is stale",
  restarted: "ids from an earlier runner process are refused",
  sensitive: "a sensitive title is read only when allowed",
  screenshot: "a window screenshot is a PNG within 1280 px, or says why not",
  from: "reading under a control with from works, or on Linux is refused in defined words",
  state: "the state directory is private, untraced and wiped on close",
} as const;

/** The write checks' labels (Task 23). macOS runs the first three; Linux and Windows the last. */
export const DESKTOP_PROBE_WRITE_CHECKS = {
  typed: "macOS: typing Chinese reads back",
  staleAfterWrite: "a write makes the window's refs stale",
  foreground: "a key needs the window in front",
  readOnly:
    "a write is refused in defined words where the desktop is read-only",
} as const;

/** Every label that must pass on `platform` for DESKTOP_PROBE_PASS. */
export function probeChecksFor(platform: DesktopPlatform): string[] {
  const writes = DESKTOP_PROBE_WRITE_CHECKS;
  return [
    ...Object.values(DESKTOP_PROBE_CHECKS),
    ...(platform === "macos"
      ? [writes.typed, writes.staleAfterWrite, writes.foreground]
      : [writes.readOnly]),
  ];
}

const TEXT = "熊宝员工-桌面探针";
/** What the macOS write check types over the editor's text. */
const WRITE_TEXT = "熊宝员工 写入 abc 123";
/** The coworker and person the probe's desktop session is for. */
const PROBE_WHO = {
  botId: "desktop-probe-bot",
  actorId: "desktop-probe-owner",
};
/** How long a window may take to come to the front, or leave it. */
const FOCUS_WAIT_MS = 10_000;
/** What the agent-desktop reader says when macOS has not granted screen recording (Task 8). */
const NO_SCREEN_RECORDING = "没有屏幕录制权限，截不到图。";
/** How long an editor window may take to show up in the list (Windows needs about 8 s). */
const WINDOW_WAIT_MS = 30_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The device app's end of the runner's control channel, played by the probe: every new session's
 * banner is up and every `--headed` step's mouse check is paused, at once. The events are printed
 * for the log; they name a session by its label, never by its token.
 */
export function probeControl(): { control: ControlChannel; close(): void } {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const poke = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const push = (input: unknown) => {
    pending.push(JSON.stringify(input));
    poke();
  };
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
  const control = createControlChannel({
    lines,
    write: (line) => {
      if (!line.startsWith(CONTROL_LINE_PREFIX)) return;
      const event = JSON.parse(line.slice(CONTROL_LINE_PREFIX.length)) as {
        event?: string;
        label?: string;
        seq?: number;
      };
      console.log(JSON.stringify({ control: event }));
      if (event.event === "session-started")
        push({ control: "session-ready", label: event.label });
      if (event.event === "headed-begin")
        push({ control: "headed-ack", seq: event.seq });
    },
  });
  return {
    control,
    close() {
      closed = true;
      poke();
    },
  };
}

/** agent-desktop's state directory for a probe workspace; the executor and the probe agree on it. */
export function probeStateDir(root: string): string {
  return join(root, "agent-desktop-state");
}

/** A snapshot, short enough to print when a check fails. */
function brief(snapshot: DesktopSnapshot | undefined) {
  if (!snapshot) return snapshot;
  return {
    snapshotId: snapshot.snapshotId,
    window: snapshot.window,
    truncated: snapshot.truncated,
    count: snapshot.elements.length,
    elements: snapshot.elements.slice(0, 60).map((element) => ({
      ...element,
      ...(element.value === undefined
        ? {}
        : { value: element.value.slice(0, 80) }),
    })),
    image: snapshot.image && {
      width: snapshot.image.width,
      height: snapshot.image.height,
      bytes: snapshot.image.base64.length,
    },
    imageError: snapshot.imageError,
  };
}

function windowsOf(result: Result): DesktopWindow[] {
  return (
    (result.output as { windows?: DesktopWindow[] } | undefined)?.windows ?? []
  );
}

/** Every entry under `dir` whose name mentions a trace; nothing when the directory is not there. */
function traceEntries(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => /trace/i.test(name));
  } catch {
    return [];
  }
}

function isPng(base64: string, width: number, height: number): boolean {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24) return false;
  if (!PNG_SIGNATURE.every((byte, at) => bytes[at] === byte)) return false;
  // The first chunk is IHDR: its width and height must be the ones reported.
  return (
    bytes.toString("latin1", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) === width &&
    bytes.readUInt32BE(20) === height
  );
}

function textEditPids(): Set<number> {
  const listed = spawnSync("pgrep", ["-x", "TextEdit"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return new Set(
    String(listed.stdout ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map(Number),
  );
}

/**
 * Opens `file` in the platform's own editor; returns the process to end afterwards, if any. With
 * `own`, the window gets a process of its own, so ending that process closes exactly this window
 * (Notepad always has one; gedit --standalone and a second TextEdit instance are asked for).
 */
async function openEditor(
  platform: DesktopPlatform,
  file: string,
  own = false,
): Promise<number | undefined> {
  if (platform === "macos") {
    const before = own ? textEditPids() : new Set<number>();
    // `open` hands the file to TextEdit and returns; -n starts another instance.
    const opened = spawnSync(
      "open",
      [...(own ? ["-n"] : []), "-a", "TextEdit", file],
      { stdio: "ignore", timeout: 30_000 },
    );
    if (opened.status !== 0)
      console.log(JSON.stringify({ openTextEdit: opened.status }));
    if (!own) return undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const added = [...textEditPids()].find((pid) => !before.has(pid));
      if (added !== undefined) return added;
      await Bun.sleep(250);
    }
    return undefined;
  }
  // gedit hands a second file to the instance that runs; --new-window keeps it out of the first
  // window's tabs, so the first window's title stays the same. --standalone keeps it in a process
  // of its own instead.
  const command =
    platform === "windows"
      ? ["notepad.exe", file]
      : ["gedit", own ? "--standalone" : "--new-window", file];
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  return child.pid;
}

function endEditors(
  platform: DesktopPlatform,
  pids: number[],
  all = true,
): void {
  if (platform === "windows") {
    const root =
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    for (const pid of pids)
      spawnSync(
        win32.join(root, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 15_000 },
      );
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (!all) return;
  spawnSync("pkill", ["-x", platform === "macos" ? "TextEdit" : "gedit"], {
    stdio: "ignore",
    timeout: 15_000,
  });
}

/**
 * What agent-desktop itself says about its permissions, run once on its own with a separate state
 * directory (so the runner's stays as the runner left it). Printed for the log; on macOS it decides
 * whether a screenshot is owed.
 */
function permissionsOf(
  helper: string,
  root: string,
): Record<string, { state?: string }> | undefined {
  const home = join(root, "permissions-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    const answered = spawnSync(helper, ["permissions"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_DESKTOP_HOME: home },
      timeout: 30_000,
      windowsHide: true,
    });
    const envelope = JSON.parse(String(answered.stdout ?? "").trim()) as {
      ok?: boolean;
      data?: Record<string, { state?: string }>;
    };
    console.log(JSON.stringify({ permissions: envelope }));
    return envelope.ok === true ? envelope.data : undefined;
  } catch (error) {
    console.log(JSON.stringify({ permissions: String(error) }));
    return undefined;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Lists windows until one matches, for up to `WINDOW_WAIT_MS`; a failed listing ends the wait. */
async function waitForWindow(
  run: Run,
  match: (window: DesktopWindow) => boolean,
): Promise<{ window?: DesktopWindow; platform?: unknown; seen: unknown }> {
  const deadline = Date.now() + WINDOW_WAIT_MS;
  let seen: unknown;
  for (;;) {
    const result = await run("desktop.windows", {});
    const output = result.output as { platform?: unknown } | undefined;
    seen = result.ok
      ? {
          platform: output?.platform,
          windows: windowsOf(result).map(({ windowId, title, process }) => ({
            windowId,
            title,
            process,
          })),
        }
      : result;
    const window = windowsOf(result).find(match);
    if (window) return { window, platform: output?.platform, seen };
    // No permission, no bus, no binary: nothing to wait for (design decision 20).
    if (!result.ok || Date.now() > deadline) return { seen };
    await Bun.sleep(500);
  }
}

export async function probeAgentDesktop(
  assert: Assert,
  opts: {
    root: string;
    helper: string;
    platform: DesktopPlatform;
    execute: RunnerExecutor;
    /** The channel the executor's desktop actions were built with (`probeControl`). */
    control: ControlChannel;
  },
): Promise<void> {
  const { root, helper, platform, execute, control } = opts;
  const stateDir = probeStateDir(root);
  const traces = new Set<string>();
  const run: Run = async (action, payload) => {
    const outcome = await execute({ action, payload });
    // A trace directory must never appear, at any point of the run.
    for (const entry of traceEntries(stateDir)) traces.add(entry);
    return outcome.ok
      ? { ok: true, output: outcome.output }
      : { ok: false, error: outcome.error };
  };
  const editors: number[] = [];
  const opened = (pid: number | undefined) => {
    if (pid !== undefined) editors.push(pid);
  };
  const permissions = permissionsOf(helper, root);
  let snapshotWorked = false;
  try {
    const read = await readChecks(
      assert,
      run,
      root,
      platform,
      execute,
      permissions,
      opened,
    );
    snapshotWorked = read.worked;
    await writeChecks(assert, run, platform, read.windowId, control);
  } finally {
    if (!snapshotWorked) diagnose(helper, root);
    // 7. Private (0700, or on Windows the protected DACL a working snapshot proves), never traced,
    // and empty once the desktop actions are closed.
    let mode: number | undefined;
    try {
      mode = statSync(stateDir).mode & 0o777;
    } catch {
      mode = undefined;
    }
    for (const entry of traceEntries(stateDir)) traces.add(entry);
    await execute.closeDesktop();
    let left: string[];
    try {
      left = readdirSync(stateDir);
    } catch {
      left = [];
    }
    const isPrivate = platform === "windows" ? snapshotWorked : mode === 0o700;
    assert(
      isPrivate && traces.size === 0 && left.length === 0,
      DESKTOP_PROBE_CHECKS.state,
      {
        mode: mode?.toString(8),
        snapshotWorked,
        traces: [...traces],
        left,
      },
    );
    endEditors(platform, editors);
  }
}

/**
 * When the reads fail, what agent-desktop itself says: `list-windows` and `status` run directly,
 * once with the runner's restricted environment and once with the job's full one, so a failure
 * caused by a variable the runner does not pass shows up as a difference between the two.
 */
function diagnose(helper: string, root: string): void {
  const state = join(root, "diagnose-state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const envs = {
    restricted: agentDesktopEnv(process.env, state),
    full: { ...process.env, AGENT_DESKTOP_HOME: state } as Record<
      string,
      string
    >,
  };
  for (const [name, env] of Object.entries(envs)) {
    for (const command of ["list-windows", "status"]) {
      const out = spawnSync(helper, [command], {
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      console.log(
        JSON.stringify({
          diagnose: `${command} (${name} env)`,
          exit: out.status,
          stdout: (out.stdout ?? "").slice(0, 3000),
          stderr: (out.stderr ?? "").slice(-1500),
        }),
      );
    }
  }
  console.log(
    JSON.stringify({
      diagnose: "restricted env keys",
      keys: Object.keys(envs.restricted),
    }),
  );
}

/**
 * Checks 1 to 6 and 8. Returns whether a snapshot ever worked (on Windows, proof of the DACL) and the
 * editor's window id once the runner was built again, for the write checks.
 */
async function readChecks(
  assert: Assert,
  run: Run,
  root: string,
  platform: DesktopPlatform,
  execute: RunnerExecutor,
  permissions: Record<string, { state?: string }> | undefined,
  opened: (pid: number | undefined) => void,
): Promise<{ worked: boolean; windowId?: string }> {
  // 1. An editor with a Chinese file name and Chinese text, in the runner's window list. The BOM
  // keeps every editor from guessing another encoding.
  const file = join(root, "熊宝员工.txt");
  writeFileSync(file, `\uFEFF${TEXT}`, "utf8");
  opened(await openEditor(platform, file));
  const editor = (window: DesktopWindow) => window.title.includes("熊宝员工");
  const listed = await waitForWindow(run, editor);
  assert(
    listed.window &&
      isAgentWindowId(listed.window.windowId) &&
      listed.platform === platform,
    DESKTOP_PROBE_CHECKS.listed,
    listed.seen,
  );
  if (!listed.window) return { worked: false };
  const firstId = listed.window.windowId;

  // 2. Its text, read back, with every ref in the runner's own form.
  const one = await run("desktop.snapshot", { windowId: firstId });
  const first = one.ok ? (one.output as DesktopSnapshot) : undefined;
  const textAt =
    first?.elements.findIndex((element) =>
      (element.value ?? "").includes(TEXT),
    ) ?? -1;
  assert(
    first &&
      first.elements.length > 0 &&
      textAt >= 0 &&
      first.elements.every((element) => DESKTOP_REF.test(element.ref)),
    DESKTOP_PROBE_CHECKS.read,
    first ? brief(first) : one,
  );
  if (!first) return { worked: false };

  // 3. Once a second snapshot is read, a ref from the first is stale.
  const oldRef = first.elements[Math.max(textAt, 0)]?.ref;
  const two = await run("desktop.snapshot", { windowId: firstId });
  const old = await run("desktop.snapshot", {
    windowId: firstId,
    from: oldRef,
  });
  assert(
    two.ok && !old.ok && old.error === desktopMessage("stale"),
    DESKTOP_PROBE_CHECKS.stale,
    { second: two.ok || two, oldRef, old },
  );

  // 4. Closed and built again (as a runner that restarts): the same editor gets a new id, and the
  // old one is refused.
  await execute.closeDesktop();
  const again = await waitForWindow(run, editor);
  const gone = await run("desktop.snapshot", { windowId: firstId });
  assert(
    again.window &&
      again.window.windowId !== firstId &&
      !gone.ok &&
      gone.error === desktopMessage("no_window"),
    DESKTOP_PROBE_CHECKS.restarted,
    { firstId, again: again.window ?? again.seen, gone },
  );
  if (!again.window) return { worked: true };
  const windowId = again.window.windowId;

  // 5. A window whose title has a sensitive word is read only when allowed.
  const bankFile = join(root, "银行-探针.txt");
  writeFileSync(bankFile, `\uFEFF${TEXT}`, "utf8");
  const bankPid = await openEditor(platform, bankFile, true);
  opened(bankPid);
  const bank = await waitForWindow(run, (window) =>
    window.title.includes("银行-探针"),
  );
  const refused = bank.window
    ? await run("desktop.snapshot", { windowId: bank.window.windowId })
    : undefined;
  const allowed = bank.window
    ? await run("desktop.snapshot", {
        windowId: bank.window.windowId,
        allowSensitive: true,
      })
    : undefined;
  assert(
    refused &&
      !refused.ok &&
      refused.error === desktopMessage("sensitive", "银行") &&
      allowed?.ok === true,
    DESKTOP_PROBE_CHECKS.sensitive,
    {
      bank: bank.window ?? bank.seen,
      refused,
      allowed: allowed && (allowed.ok ? { ok: true } : allowed),
    },
  );

  // The sensitive window is closed again before the screenshot: on Linux it was drawn over the
  // editor, and agent-desktop cannot read the pixels of a covered window there (ACTION_FAILED
  // "Another window is drawn over this window…"). Waits up to 10 s for it to leave the list.
  if (bankPid !== undefined) endEditors(platform, [bankPid], false);
  const bankGoneBy = Date.now() + 10_000;
  let bankGone = false;
  for (;;) {
    const listedNow = await run("desktop.windows", {});
    bankGone =
      listedNow.ok &&
      !windowsOf(listedNow).some((window) =>
        window.title.includes("银行-探针"),
      );
    if (bankGone || Date.now() > bankGoneBy) break;
    await Bun.sleep(500);
  }

  // 6. A screenshot of the editor: a PNG no longer than 1280 px on its long side. On macOS without
  // screen recording, the reason instead.
  const shot = await run("desktop.snapshot", { windowId, screenshot: true });
  const pictured = shot.ok ? (shot.output as DesktopSnapshot) : undefined;
  const image = pictured?.image;
  const screenRecording = permissions?.screen_recording?.state;
  const owesReason = platform === "macos" && screenRecording !== "granted";
  const imageOk = owesReason
    ? image === undefined && pictured?.imageError === NO_SCREEN_RECORDING
    : image !== undefined &&
      image.width > 0 &&
      image.height > 0 &&
      Math.max(image.width, image.height) <= 1280 &&
      isPng(image.base64, image.width, image.height);
  assert(pictured && imageOk, DESKTOP_PROBE_CHECKS.screenshot, {
    bankPid,
    bankGone,
    screenRecording,
    snapshot: pictured ? brief(pictured) : shot,
  });

  // 8. Reading under a container (agent-desktop's --root): after a fresh snapshot, `from` a control
  // that has children. A node agent-desktop gave no ref is "not actionable", so the next one is tried.
  const fresh = await run("desktop.snapshot", { windowId });
  const whole = fresh.ok ? (fresh.output as DesktopSnapshot) : undefined;
  const containers = (whole?.elements ?? []).flatMap((element, at, all) =>
    at > 0 && (all[at + 1]?.depth ?? -1) > element.depth ? [at] : [],
  );
  const tried: unknown[] = [];
  let under: Result | undefined;
  let container: DesktopSnapshot["elements"][number] | undefined;
  for (const at of containers) {
    container = whole?.elements[at];
    const result = await run("desktop.snapshot", {
      windowId,
      from: container?.ref,
    });
    tried.push({
      at,
      type: container?.type,
      name: container?.name,
      ok: result.ok,
      error: result.error,
    });
    if (!result.ok && result.error === desktopMessage("not_actionable"))
      continue;
    under = result;
    break;
  }
  const part = under?.ok ? (under.output as DesktopSnapshot) : undefined;
  if (part)
    console.log(
      JSON.stringify({
        from: {
          container: { type: container?.type, name: container?.name },
          wholeCount: whole?.elements.length,
          partCount: part.elements.length,
          partRoot: part.elements[0]?.type,
        },
      }),
    );
  const worked =
    part !== undefined &&
    part.elements.length > 0 &&
    part.elements.every((element) => DESKTOP_REF.test(element.ref));
  // Linux is a read-only trial here: AT-SPI cannot prove a control's identity, so group containers
  // carry no ref (every one "not actionable") and --root on a ref'd node answers AMBIGUOUS_TARGET.
  // There the check also passes when `from` is refused in exactly one of those two defined copies;
  // any other answer still fails. macOS and Windows must read the subtree.
  const lastTried = tried.at(-1) as { ok: boolean; error?: string } | undefined;
  const refusedInDefinedWords =
    platform === "linux" &&
    lastTried !== undefined &&
    !lastTried.ok &&
    (lastTried.error === desktopMessage("ambiguous") ||
      lastTried.error === desktopMessage("not_actionable"));
  if (!worked && refusedInDefinedWords)
    console.log(
      JSON.stringify({ from: { linuxRefused: lastTried?.error, tried } }),
    );
  assert(worked || refusedInDefinedWords, DESKTOP_PROBE_CHECKS.from, {
    outcome: worked
      ? "read"
      : refusedInDefinedWords
        ? "refused in defined words"
        : "failed",
    fresh: whole ? { count: whole.elements.length } : fresh,
    containers: containers.length,
    tried,
    part: brief(part),
  });
  return { worked: true, windowId };
}

/** Lists windows until `windowId` is (or is not) the one in front, for up to `FOCUS_WAIT_MS`. */
async function waitForFocus(
  run: Run,
  windowId: string,
  inFront: boolean,
): Promise<boolean> {
  const deadline = Date.now() + FOCUS_WAIT_MS;
  for (;;) {
    const listed = await run("desktop.windows", {});
    const window = windowsOf(listed).find((w) => w.windowId === windowId);
    if (window && window.focused === inFront) return true;
    if (!listed.ok || Date.now() > deadline) return false;
    await Bun.sleep(250);
  }
}

/**
 * The write checks (Task 23). Linux, and Windows on the legacy engine, refuse every write before
 * anything runs. macOS writes to the editor through a session the probe opens with the runner's own
 * `desktop.session_start`. EVERY WRITE IS SENT ONCE: one that failed is reported as it came back and
 * never sent again, so a write the machine may have carried out is not repeated (the second type
 * below is sent only after the first succeeded, when its ref must already be void).
 */
async function writeChecks(
  assert: Assert,
  run: Run,
  platform: DesktopPlatform,
  windowId: string | undefined,
  control: ControlChannel,
): Promise<void> {
  const writes: Array<[string, Record<string, unknown>]> = [
    ["desktop.click", { ref: "abcdef-1:1" }],
    ["desktop.type", { ref: "abcdef-1:1", text: WRITE_TEXT, mode: "replace" }],
    ["desktop.key", { windowId: "a0123456789abcdef", keys: "cmd+s" }],
    ["desktop.focus", { windowId: "a0123456789abcdef" }],
  ];
  if (platform !== "macos") {
    // Windows: the legacy engine, which is what a Windows device runs until its writes are accepted.
    const legacy =
      platform === "windows"
        ? createDesktopActions({
            platform: "win32",
            engine: "legacy",
            control,
            host: createDesktopHost({
              spec: () => {
                throw new Error("A refused write must not start the helper.");
              },
            }),
          })
        : undefined;
    const expected = desktopMessage(
      platform === "linux" ? "read_only_linux" : "read_only_windows",
    );
    const answers: Result[] = [];
    for (const [action, body] of writes) {
      const payload = { session: "0".repeat(64), ...PROBE_WHO, ...body };
      const outcome = legacy
        ? await legacy(action, payload, undefined, { botId: PROBE_WHO.botId })
        : await run(action, payload);
      answers.push(
        outcome.ok
          ? { ok: true, output: outcome.output }
          : { ok: false, error: outcome.error },
      );
    }
    await legacy?.close();
    assert(
      answers.every((answer) => !answer.ok && answer.error === expected),
      DESKTOP_PROBE_WRITE_CHECKS.readOnly,
      { expected, answers },
    );
    return;
  }

  // macOS. Without the editor's window nothing is written, and the three checks are reported missing.
  if (!windowId) return;
  const token = randomBytes(32).toString("hex");
  const started = await run("desktop.session_start", { token, ...PROBE_WHO });
  const write = (action: string, body: Record<string, unknown>) =>
    run(action, {
      session: token,
      ...PROBE_WHO,
      approved: false,
      actionWords: [],
      ...body,
    });
  try {
    // Typed over the editor's text (its text box is the one holding it), then a second time with
    // the same ref before any new read: refused as stale. Then read back.
    const before = await run("desktop.snapshot", { windowId });
    const snapshot = before.ok ? (before.output as DesktopSnapshot) : undefined;
    const box = snapshot?.elements.find((element) =>
      (element.value ?? "").includes(TEXT),
    );
    const typed =
      started.ok && box
        ? await write("desktop.type", {
            ref: box.ref,
            text: WRITE_TEXT,
            mode: "replace",
          })
        : undefined;
    const again =
      typed?.ok === true && box
        ? await write("desktop.type", {
            ref: box.ref,
            text: WRITE_TEXT,
            mode: "replace",
          })
        : undefined;
    const after = await run("desktop.snapshot", { windowId });
    const reread = after.ok ? (after.output as DesktopSnapshot) : undefined;
    const readBack = reread?.elements.find(
      (element) => (element.value ?? "").trim() === WRITE_TEXT,
    );
    assert(
      started.ok && typed?.ok === true && readBack !== undefined,
      DESKTOP_PROBE_WRITE_CHECKS.typed,
      {
        started,
        box: box && { ref: box.ref, type: box.type },
        typed,
        reread: reread ? brief(reread) : after,
      },
    );
    assert(
      again !== undefined &&
        !again.ok &&
        again.error === desktopMessage("stale"),
      DESKTOP_PROBE_WRITE_CHECKS.staleAfterWrite,
      { typed: typed?.ok, again },
    );

    // A key: pressed with the editor in front; refused, never pressed, once Finder is in front.
    const focused = started.ok
      ? await write("desktop.focus", { windowId })
      : undefined;
    const inFront =
      focused?.ok === true && (await waitForFocus(run, windowId, true));
    const saved = inFront
      ? await write("desktop.key", { windowId, keys: "cmd+s" })
      : undefined;
    // Through Launch Services, not an Apple event: no Automation permission to ask for.
    const finder = spawnSync("open", ["-a", "Finder"], {
      stdio: "ignore",
      timeout: 30_000,
    });
    const behindNow = await waitForFocus(run, windowId, false);
    const behind =
      saved?.ok === true && behindNow
        ? await write("desktop.key", { windowId, keys: "cmd+s" })
        : undefined;
    assert(
      saved?.ok === true &&
        behind !== undefined &&
        !behind.ok &&
        behind.error === desktopMessage("not_foreground"),
      DESKTOP_PROBE_WRITE_CHECKS.foreground,
      { focused, inFront, saved, finder: finder.status, behindNow, behind },
    );
  } finally {
    await run("desktop.session_end", { token });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--helper");
  const helperArg = at === -1 ? undefined : args[at + 1];
  const rootArg = args[0];
  if (!rootArg || rootArg.startsWith("--") || !helperArg)
    throw new Error(
      "Usage: bun scripts/ci/desktop-probe.ts <fresh empty dir> --helper <agent-desktop binary>",
    );
  const platform = desktopPlatformOf(process.platform);
  if (!platform) throw new Error(`No desktop engine on ${process.platform}.`);
  const engine = desktopEngineFor(
    process.platform,
    process.env.OPENBOT_DESKTOP_ENGINE,
  );
  if (engine !== "agent-desktop")
    throw new Error(
      "This probe drives agent-desktop; on Windows set OPENBOT_DESKTOP_ENGINE=agent-desktop.",
    );
  const root = resolve(rootArg);
  const helper = resolve(helperArg);
  if (!existsSync(helper)) throw new Error(`No agent-desktop at ${helper}.`);
  if (existsSync(root) && readdirSync(root).length > 0)
    throw new Error("Use a fresh, empty directory for each run.");
  mkdirSync(root, { recursive: true });

  const probe = probeControl();
  const execute = createRunnerExecutor(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      desktop: createDesktopActions({
        platform: process.platform,
        engine,
        helper,
        stateDir: probeStateDir(root),
        control: probe.control,
      }),
    },
  );
  const passed = new Set<string>();
  let failed = 0;
  const assert: Assert = (ok, label, seen) => {
    if (ok) {
      passed.add(label);
      console.log(JSON.stringify({ check: label, passed: true }));
      return;
    }
    failed++;
    // Say what came back, so a red probe names its cause instead of only its check.
    console.log(JSON.stringify({ check: label, passed: false, seen }));
  };
  console.log(
    JSON.stringify({ runtime: `Bun ${Bun.version}`, platform, engine }),
  );
  try {
    await probeAgentDesktop(assert, {
      root,
      helper,
      platform,
      execute,
      control: probe.control,
    });
  } catch (error) {
    failed++;
    console.log(
      JSON.stringify({
        check: "the probe runs to the end",
        passed: false,
        seen: error instanceof Error ? (error.stack ?? error.message) : error,
      }),
    );
  }
  probe.close();
  const missing = probeChecksFor(platform).filter(
    (label) => !passed.has(label),
  );
  if (failed === 0 && missing.length === 0) console.log("DESKTOP_PROBE_PASS");
  else console.log(JSON.stringify({ failed, missing }));
  process.exit(failed === 0 && missing.length === 0 ? 0 : 1);
}
