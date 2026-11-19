/*
 * The desktop probe (plan docs/plans/2026-11-12-desktop-write.md, Task 10): the runner's own
 * `desktop.windows` and `desktop.snapshot`, through the real pinned agent-desktop binary, against a
 * real editor on each hosted runner (Notepad on windows-latest, TextEdit on macos-latest, gedit under
 * Xvfb with an AT-SPI bus on ubuntu-latest).
 *
 * Then the writes (Task 23), through the runner's own session actions and the control channel, whose
 * device end the probe plays itself (it answers that the banner is up and the mouse check paused). On
 * macOS: Chinese typed into TextEdit and read back, a write voiding the window's refs, and a key
 * that needs the window in front; and (Task 25) text put on the clipboard and read back exactly, and
 * `desktop.wait` seeing TextEdit's save dialog after cmd+s in a new document. Windows, on the
 * agent-desktop engine (Task 28, `OPENBOT_DESKTOP_ENGINE=agent-desktop`): Chinese put into Notepad
 * with `set-value` and read back, a write voiding the window's refs, ctrl+s with Notepad in front
 * landing on disk, 1 2 × 3 4 = clicked in Calculator reading 408, and an append going through
 * `--headed` inside the device's begin, ack and end. Each write is sent once and never again: a write
 * that failed is reported as it came back, not retried, so nothing is typed twice. Linux and the
 * legacy Windows engine must refuse a write in their own words.
 *
 * On macOS agent-desktop finds its clipboard helper next to itself by its installed name, so the
 * probe copies the fetched pair (named with the target triple) into `<dir>/bin` under the names the
 * app installs them with, and drives that copy.
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
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";
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
  DESKTOP_TEXT_ROLES,
  type DesktopElement,
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

/**
 * The write checks' labels (Tasks 23, 25 and 28). macOS runs its five; Windows its four, the stale
 * one and the read-only one (the legacy engine, still what a Windows device runs by default); Linux
 * only the read-only one.
 */
export const DESKTOP_PROBE_WRITE_CHECKS = {
  typed: "macOS: typing Chinese reads back",
  staleAfterWrite: "a write makes the window's refs stale",
  foreground: "a key needs the window in front",
  clipboard: "macOS: text put on the clipboard reads back exactly",
  waited: "macOS: wait sees TextEdit's save dialog after cmd+s",
  winTyped: "Windows: Chinese put into Notepad with set-value reads back",
  winSaved: "Windows: ctrl+s with Notepad in front saves the text to disk",
  winCalculator: "Windows: clicking 1 2 × 3 4 = in Calculator reads 408",
  winHeaded:
    "Windows: appending goes through --headed with begin, ack and end in order",
  readOnly:
    "a write is refused in defined words where the desktop is read-only",
} as const;

/** Every label that must pass on `platform` for DESKTOP_PROBE_PASS. */
export function probeChecksFor(platform: DesktopPlatform): string[] {
  const writes = DESKTOP_PROBE_WRITE_CHECKS;
  return [
    ...Object.values(DESKTOP_PROBE_CHECKS),
    ...(platform === "macos"
      ? [
          writes.typed,
          writes.staleAfterWrite,
          writes.foreground,
          writes.clipboard,
          writes.waited,
        ]
      : platform === "windows"
        ? [
            writes.winTyped,
            writes.staleAfterWrite,
            writes.winSaved,
            writes.winCalculator,
            writes.winHeaded,
            writes.readOnly,
          ]
        : [writes.readOnly]),
  ];
}

const TEXT = "熊宝员工-桌面探针";
/** What the macOS write check types over the editor's text. */
const WRITE_TEXT = "熊宝员工 写入 abc 123";
/** What the Windows check appends to Notepad's text through `--headed`. */
const APPEND_TEXT = " 追加 xyz";
/** How long Notepad may take to write the file after ctrl+s. */
const SAVE_WAIT_MS = 10_000;
/** How long Calculator may take to show the result after `=`. */
const RESULT_WAIT_MS = 5_000;
/**
 * Calculator's buttons by the names either Calculator gives them: the classic one (`win32calc`, what
 * Windows Server ships) names them by their face and `Multiply`/`Equals`, the Store one `One`,
 * `Multiply by`, `Equals`.
 */
const CALCULATOR_KEYS: ReadonlyArray<{ face: string; names: string[] }> = [
  { face: "1", names: ["1", "one"] },
  { face: "2", names: ["2", "two"] },
  { face: "×", names: ["×", "*", "multiply", "multiply by"] },
  { face: "3", names: ["3", "three"] },
  { face: "4", names: ["4", "four"] },
  { face: "=", names: ["=", "equals", "equal"] },
];
/** 12 × 34, shown as a whole number in a name or a value ("408", "Display is 408"). */
const CALCULATOR_RESULT = /(^|[^\d])408([^\d]|$)/;
/** What the macOS clipboard check puts on the clipboard and reads back. */
const CLIPBOARD_TEXT = "熊宝员工 剪贴板 ✓ abc 123";
/** The save dialog's button, which only the dialog has (macos-latest runs in English). */
const SAVE_BUTTON = { type: "button", name: "Save" } as const;
/** How long the save dialog may take to show up, in seconds. */
const SAVE_DIALOG_WAIT_SEC = 15;
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
const TEXT_WAIT_MS = 10_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The device app's end of the runner's control channel, played by the probe: every new session's
 * banner is up and every `--headed` step's mouse check is paused, at once. The events are printed
 * for the log; they name a session by its label, never by its token.
 */
export function probeControl(): {
  control: ControlChannel;
  close(): void;
  /** Every `--headed` step so far, as the device saw it: `begin`, its `ack`, `end`, in order. */
  headed(): string[];
} {
  const pending: string[] = [];
  const headed: string[] = [];
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
      if (event.event === "headed-begin") {
        headed.push("begin");
        headed.push("ack");
        push({ control: "headed-ack", seq: event.seq });
      }
      if (event.event === "headed-end") headed.push("end");
    },
  });
  return {
    control,
    headed: () => [...headed],
    close() {
      closed = true;
      poke();
    },
  };
}

/**
 * macOS: the fetched CLI and its clipboard helper (`agent-desktop-<triple>`,
 * `agent-desktop-macos-helper-<triple>`), copied into `<root>/bin` as `agent-desktop` and
 * `agent-desktop-macos-helper`, the names the app installs them with: agent-desktop finds the helper
 * next to itself by that name. Returns the CLI to drive; the one given when there is no helper beside
 * it (the clipboard check then fails and says so).
 */
export function stageMacBinaries(helper: string, root: string): string {
  const triple = /^agent-desktop-(.+)$/.exec(basename(helper))?.[1];
  const clipboard = triple
    ? join(dirname(helper), `agent-desktop-macos-helper-${triple}`)
    : undefined;
  if (!clipboard || !existsSync(clipboard)) {
    console.log(
      JSON.stringify({ stage: "no clipboard helper beside the CLI", helper }),
    );
    return helper;
  }
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  const cli = join(bin, "agent-desktop");
  const helperCopy = join(bin, "agent-desktop-macos-helper");
  copyFileSync(helper, cli);
  copyFileSync(clipboard, helperCopy);
  // No group or other write: the helper is refused otherwise.
  chmodSync(cli, 0o755);
  chmodSync(helperCopy, 0o755);
  return cli;
}

/** The editor's file: a Chinese name, Chinese text; the Windows save check reads it back. */
function editorFile(root: string): string {
  return join(root, "熊宝员工.txt");
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
    /** The device's view of `--headed` steps (`probeControl().headed`). */
    headed?: () => string[];
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
    await writeChecks(assert, run, platform, read.windowId, control, {
      file: editorFile(root),
      headed: opts.headed ?? (() => []),
    });
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
  const file = editorFile(root);
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

  // 2. Its text, read back, with every ref in the runner's own form. The window can be listed before
  // the editor has loaded the file (TextEdit on a cold runner), so read again until the text is there.
  const textIn = (snapshot: DesktopSnapshot | undefined) =>
    snapshot?.elements.findIndex((element) =>
      (element.value ?? "").includes(TEXT),
    ) ?? -1;
  const textDeadline = Date.now() + TEXT_WAIT_MS;
  let one = await run("desktop.snapshot", { windowId: firstId });
  let first = one.ok ? (one.output as DesktopSnapshot) : undefined;
  while (first && textIn(first) < 0 && Date.now() < textDeadline) {
    await Bun.sleep(500);
    one = await run("desktop.snapshot", { windowId: firstId });
    first = one.ok ? (one.output as DesktopSnapshot) : undefined;
  }
  const textAt = textIn(first);
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
 * macOS: the editor brought to the front, a new document (cmd+n in it), cmd+s in that, then one
 * `desktop.wait` for the save dialog's Save button. Each step is sent once; the first that fails ends
 * the check, with everything that came back.
 */
async function saveDialogCheck(
  run: Run,
  write: (action: string, body: Record<string, unknown>) => Promise<Result>,
  windowId: string,
): Promise<{ passed: boolean; seen: unknown }> {
  const before = await run("desktop.windows", {});
  const editor = windowsOf(before).find((w) => w.windowId === windowId);
  const known = new Set(windowsOf(before).map((w) => w.windowId));
  const focused = editor
    ? await write("desktop.focus", { windowId })
    : undefined;
  const front =
    focused?.ok === true && (await waitForFocus(run, windowId, true));
  const created = front
    ? await write("desktop.key", { windowId, keys: "cmd+n" })
    : undefined;
  if (!editor || created?.ok !== true)
    return { passed: false, seen: { editor, focused, front, created, before } };
  // The new document's window: one of the editor's that was not there before.
  const deadline = Date.now() + WINDOW_WAIT_MS;
  let untitled: DesktopWindow | undefined;
  for (;;) {
    const listed = await run("desktop.windows", {});
    // A new document's window, not one of the hidden helper windows macOS also lists for the app
    // (seen on CI: title equal to the app name, bounds 0,268 500x500, invisible): those cannot be
    // brought forward, so the check waited on a window no one can see.
    untitled = windowsOf(listed).find(
      (w) =>
        !known.has(w.windowId) &&
        w.process === editor.process &&
        w.title !== editor.process,
    );
    if (untitled || !listed.ok || Date.now() > deadline) break;
    await Bun.sleep(250);
  }
  if (!untitled) return { passed: false, seen: { created, untitled } };
  // A new document window is not always handed the focus on a CI runner (seen: focused false,
  // inFront false), so bring it forward explicitly. This is a new write to a different window,
  // sent once, not a retry of cmd+n.
  const raised = await write("desktop.focus", { windowId: untitled.windowId });
  const inFront =
    raised.ok === true && (await waitForFocus(run, untitled.windowId, true));
  const pressed = inFront
    ? await write("desktop.key", {
        windowId: untitled.windowId,
        keys: "cmd+s",
      })
    : undefined;
  const waited =
    pressed?.ok === true
      ? await run("desktop.wait", {
          windowId: untitled.windowId,
          ...SAVE_BUTTON,
          timeoutSec: SAVE_DIALOG_WAIT_SEC,
        })
      : undefined;
  const seen = waited?.ok ? (waited.output as DesktopSnapshot) : undefined;
  const button = seen?.elements.find(
    (element) =>
      element.type === SAVE_BUTTON.type && element.name === SAVE_BUTTON.name,
  );
  return {
    passed: button !== undefined,
    seen: {
      untitled,
      raised,
      inFront,
      pressed,
      waited: seen ? brief(seen) : waited,
    },
  };
}

/** What the Windows checks need besides the runner: the editor's file and the device's view. */
type WindowsWriteContext = {
  file: string;
  headed: () => string[];
};

/** The control holding `text` in a read, as the read checks found it. */
function holding(
  snapshot: DesktopSnapshot | undefined,
  text: string,
): DesktopElement | undefined {
  return snapshot?.elements.find((element) =>
    (element.value ?? "").includes(text),
  );
}

/**
 * A text control the writer types into without asking (`DESKTOP_TEXT_ROLES`) is sent unapproved, as
 * on macOS. Notepad's text area can also come back as a `document`, which the writer asks about;
 * there the probe sends what the server sends once the owner said yes. Either way it is sent once.
 */
function typeApproval(box: DesktopElement): boolean {
  return !DESKTOP_TEXT_ROLES.has(box.type);
}

/** The file as Notepad left it: decoded by its byte-order mark (UTF-8 or UTF-16 LE), the mark dropped. */
function savedText(file: string): {
  text?: string;
  head: string;
  error?: string;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return { head: "", error: String(error) };
  }
  const head = bytes.subarray(0, 16).toString("hex");
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: bytes.subarray(2).toString("utf16le"), head };
  const utf8 =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  return { text: utf8.toString("utf8"), head };
}

/** Reads the file until it holds `expected` (Notepad writes it a moment after ctrl+s). Only reads. */
async function waitForSaved(file: string, expected: string) {
  const deadline = Date.now() + SAVE_WAIT_MS;
  for (;;) {
    const saved = savedText(file);
    if (saved.text === expected || Date.now() > deadline)
      return { matches: saved.text === expected, ...saved };
    await Bun.sleep(250);
  }
}

/** Calculator's button for `names`, in a read: a button whose whole name is one of them, any case. */
function calculatorButton(
  snapshot: DesktopSnapshot | undefined,
  names: string[],
): DesktopElement | undefined {
  return snapshot?.elements.find(
    (element) =>
      element.type.toLowerCase() === "button" &&
      names.includes(element.name.trim().toLowerCase()),
  );
}

/** Where Calculator shows 408, in a read: a name or a value holding it as a whole number. */
function calculatorShows(snapshot: DesktopSnapshot | undefined) {
  return snapshot?.elements.find(
    (element) =>
      CALCULATOR_RESULT.test(element.name) ||
      CALCULATOR_RESULT.test(element.value ?? ""),
  );
}

/** Ends Calculator: the process started (a stub may be gone already) and the window's own. */
function endCalculator(pid: number | undefined, image: string | undefined) {
  const root =
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const taskkill = win32.join(root, "System32", "taskkill.exe");
  const run = (args: string[]) =>
    spawnSync(taskkill, args, {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
    });
  if (pid !== undefined) run(["/PID", String(pid), "/T", "/F"]);
  // Only a process that is plainly a calculator, never the shell hosting other windows.
  if (image && /calc/i.test(image))
    run([
      "/IM",
      image.toLowerCase().endsWith(".exe") ? image : `${image}.exe`,
      "/F",
    ]);
}

/**
 * Calculator: started fresh, then for each of 1 2 × 3 4 = one read and one click on that button (a
 * click voids the window's refs, so every button is found on a read made after the previous click).
 * Then the result is read until it shows 408. The first step that fails ends the check, with what
 * came back.
 */
async function calculatorCheck(
  run: Run,
  write: (action: string, body: Record<string, unknown>) => Promise<Result>,
): Promise<{ passed: boolean; seen: unknown }> {
  const before = await run("desktop.windows", {});
  const known = new Set(windowsOf(before).map((w) => w.windowId));
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(["calc.exe"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    return {
      passed: false,
      seen: { step: "starting calc.exe", error: String(error) },
    };
  }
  child.unref();
  let image: string | undefined;
  try {
    const opened = await waitForWindow(
      run,
      (w) => !known.has(w.windowId) && /calculator|计算器/i.test(w.title),
    );
    if (!opened.window)
      return {
        passed: false,
        seen: { step: "Calculator's window", seen: opened.seen },
      };
    const windowId = opened.window.windowId;
    image = opened.window.process;
    const clicks: unknown[] = [];
    for (const key of CALCULATOR_KEYS) {
      const read = await run("desktop.snapshot", { windowId });
      const snapshot = read.ok ? (read.output as DesktopSnapshot) : undefined;
      const button = calculatorButton(snapshot, key.names);
      if (!button)
        return {
          passed: false,
          seen: {
            step: `the ${key.face} button`,
            window: opened.window,
            clicks,
            read: snapshot ? brief(snapshot) : read,
          },
        };
      const clicked = await write("desktop.click", { ref: button.ref });
      clicks.push({ face: key.face, name: button.name, clicked });
      if (!clicked.ok)
        return {
          passed: false,
          seen: { step: `clicking ${key.face}`, clicks },
        };
    }
    const deadline = Date.now() + RESULT_WAIT_MS;
    let last: Result | undefined;
    for (;;) {
      last = await run("desktop.snapshot", { windowId });
      const snapshot = last.ok ? (last.output as DesktopSnapshot) : undefined;
      const shown = calculatorShows(snapshot);
      if (shown)
        return {
          passed: true,
          seen: {
            shown: { type: shown.type, name: shown.name, value: shown.value },
          },
        };
      if (!last.ok || Date.now() > deadline)
        return {
          passed: false,
          seen: {
            step: "reading 408",
            clicks,
            read: snapshot ? brief(snapshot) : last,
          },
        };
      await Bun.sleep(250);
    }
  } finally {
    endCalculator(child.pid, image);
  }
}

/**
 * Windows on agent-desktop (Task 28), in one session the probe opens: Chinese put into Notepad over
 * its text (`desktop.type` replace, which goes through `set-value`: headless, so `physical` is false)
 * and read back, the same ref refused afterwards; Notepad brought to the front, checked to be there,
 * then ctrl+s, and the file on disk holding exactly that text; Calculator clicked to 408; and a few
 * words appended to Notepad's text (`desktop.type` append: headless `type` is refused on Windows, so
 * it goes through `--headed`), with the device seeing begin, ack and end in that order.
 */
async function windowsWriteChecks(
  assert: Assert,
  run: Run,
  windowId: string,
  win: WindowsWriteContext,
): Promise<void> {
  const checks = DESKTOP_PROBE_WRITE_CHECKS;
  const token = randomBytes(32).toString("hex");
  const started = await run("desktop.session_start", { token, ...PROBE_WHO });
  if (!started.ok)
    console.log(
      JSON.stringify({
        sessionStart: "the desktop session did not start; no write was sent",
        seen: started,
      }),
    );
  const write = (action: string, body: Record<string, unknown>) =>
    run(action, {
      session: token,
      ...PROBE_WHO,
      approved: false,
      actionWords: [],
      ...body,
    });
  try {
    // 1. Replace through set-value, read back; the same ref again is stale.
    const before = await run("desktop.snapshot", { windowId });
    const snapshot = before.ok ? (before.output as DesktopSnapshot) : undefined;
    const box = holding(snapshot, TEXT);
    const typed =
      started.ok && box
        ? await write("desktop.type", {
            ref: box.ref,
            text: WRITE_TEXT,
            mode: "replace",
            approved: typeApproval(box),
          })
        : undefined;
    const again =
      typed?.ok === true && box
        ? await write("desktop.type", {
            ref: box.ref,
            text: WRITE_TEXT,
            mode: "replace",
            approved: typeApproval(box),
          })
        : undefined;
    const after = await run("desktop.snapshot", { windowId });
    const reread = after.ok ? (after.output as DesktopSnapshot) : undefined;
    const readBack = reread?.elements.find(
      (element) => (element.value ?? "").trim() === WRITE_TEXT,
    );
    const typedOutput = typed?.ok
      ? (typed.output as { physical?: unknown })
      : undefined;
    assert(
      started.ok &&
        typed?.ok === true &&
        typedOutput?.physical === false &&
        readBack !== undefined,
      checks.winTyped,
      {
        started,
        box: box && {
          ref: box.ref,
          type: box.type,
          approved: typeApproval(box),
        },
        typed,
        reread: reread ? brief(reread) : after,
        before: snapshot ? undefined : before,
      },
    );
    assert(
      again !== undefined &&
        !again.ok &&
        again.error === desktopMessage("stale"),
      checks.staleAfterWrite,
      { typed: typed?.ok, again },
    );

    // 2. Notepad in front (checked, never assumed), then ctrl+s, then the file on disk.
    const focused =
      typed?.ok === true
        ? await write("desktop.focus", { windowId })
        : undefined;
    const inFront =
      focused?.ok === true && (await waitForFocus(run, windowId, true));
    const saved = inFront
      ? await write("desktop.key", { windowId, keys: "ctrl+s" })
      : undefined;
    const disk =
      saved?.ok === true ? await waitForSaved(win.file, WRITE_TEXT) : undefined;
    assert(saved?.ok === true && disk?.matches === true, checks.winSaved, {
      typed: typed?.ok,
      focused,
      inFront,
      saved,
      disk,
      expected: WRITE_TEXT,
    });

    // 3. Calculator.
    const calculator = started.ok
      ? await calculatorCheck(run, write)
      : { passed: false, seen: { started } };
    assert(calculator.passed, checks.winCalculator, calculator.seen);

    // 4. Append through --headed: the device sees begin, its ack, then end, and nothing else.
    const fresh = await run("desktop.snapshot", { windowId });
    const current = fresh.ok ? (fresh.output as DesktopSnapshot) : undefined;
    const target = holding(current, WRITE_TEXT);
    const mark = win.headed().length;
    const appended =
      started.ok && target
        ? await write("desktop.type", {
            ref: target.ref,
            text: APPEND_TEXT,
            mode: "append",
            approved: typeApproval(target),
          })
        : undefined;
    const steps = win.headed().slice(mark);
    const last = await run("desktop.snapshot", { windowId });
    const ended = last.ok ? (last.output as DesktopSnapshot) : undefined;
    const appendedOutput = appended?.ok
      ? (appended.output as { physical?: unknown })
      : undefined;
    assert(
      appended?.ok === true &&
        appendedOutput?.physical === true &&
        steps.join(",") === "begin,ack,end" &&
        holding(ended, APPEND_TEXT.trim()) !== undefined,
      checks.winHeaded,
      {
        target: target && { ref: target.ref, type: target.type },
        appended,
        steps,
        read: ended ? brief(ended) : last,
        fresh: current ? undefined : fresh,
      },
    );
  } finally {
    await run("desktop.session_end", { token });
  }
}

/**
 * The write checks (Tasks 23 and 28). Linux, and Windows on the legacy engine, refuse every write
 * before anything runs. macOS and Windows on agent-desktop then write to the editor through a session
 * the probe opens with the runner's own `desktop.session_start`. EVERY WRITE IS SENT ONCE: one that
 * failed is reported as it came back and never sent again, so a write the machine may have carried
 * out is not repeated (the second type below is sent only after the first succeeded, when its ref
 * must already be void).
 */
async function writeChecks(
  assert: Assert,
  run: Run,
  platform: DesktopPlatform,
  windowId: string | undefined,
  control: ControlChannel,
  win: WindowsWriteContext,
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
    // Windows on agent-desktop (this probe's engine there): the writes themselves.
    if (platform === "windows" && windowId)
      await windowsWriteChecks(assert, run, windowId, win);
    return;
  }

  // macOS. Without the editor's window nothing is written, and the three checks are reported missing.
  if (!windowId) return;
  const token = randomBytes(32).toString("hex");
  const started = await run("desktop.session_start", { token, ...PROBE_WHO });
  // No session, no write: say why at once (the token is never printed, only what came back).
  if (!started.ok)
    console.log(
      JSON.stringify({
        sessionStart: "the desktop session did not start; no write was sent",
        seen: started,
      }),
    );
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

    // The clipboard (Task 25): put on it once, read back once (approved, as the server always sends
    // it), and the very same text.
    const put = started.ok
      ? await write("desktop.clipboard_write", { text: CLIPBOARD_TEXT })
      : undefined;
    const got =
      put?.ok === true
        ? await write("desktop.clipboard_read", { approved: true })
        : undefined;
    const held = got?.ok
      ? (got.output as { text?: unknown; truncated?: unknown })
      : undefined;
    assert(
      put?.ok === true &&
        held?.text === CLIPBOARD_TEXT &&
        held?.truncated === false,
      DESKTOP_PROBE_WRITE_CHECKS.clipboard,
      { put, got },
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

    /*
     * Waiting (Task 25), after the foreground check, so that only Finder put the editor behind there:
     * the editor brought to the front again, then cmd+s in a new, never saved document opens the save
     * dialog, which has a Save button the document alone does not. One focus, one cmd+n, one cmd+s
     * and one wait, none sent again.
     */
    const dialog = started.ok
      ? await saveDialogCheck(run, write, windowId)
      : { passed: false, seen: { started } };
    assert(dialog.passed, DESKTOP_PROBE_WRITE_CHECKS.waited, dialog.seen);
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
  const fetched = resolve(helperArg);
  if (!existsSync(fetched)) throw new Error(`No agent-desktop at ${fetched}.`);
  if (existsSync(root) && readdirSync(root).length > 0)
    throw new Error("Use a fresh, empty directory for each run.");
  mkdirSync(root, { recursive: true });
  const helper =
    platform === "macos" ? stageMacBinaries(fetched, root) : fetched;

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
      headed: probe.headed,
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
