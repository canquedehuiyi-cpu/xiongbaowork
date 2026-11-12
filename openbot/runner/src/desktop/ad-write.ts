import {
  classifyDesktopKeys,
  DESKTOP_APP_NAME,
  DESKTOP_APPROVAL_WORDS,
  DESKTOP_LIMITS,
  DESKTOP_SELF_WINDOW_REASON,
  DESKTOP_TEXT_ROLES,
  DESKTOP_WINDOW_WORDS,
  DESKTOP_WRITE_ACTIONS,
  type DesktopClipboardReadOutput,
  type DesktopClipboardWriteOutput,
  type DesktopKeyClass,
  type DesktopLaunchOutput,
  type DesktopPlatform,
  type DesktopWriteOutput,
  desktopActionWordHit,
  desktopActionWordsOf,
  desktopActivationKey,
  desktopMessage,
  desktopSelfOrTerminalProcess,
  desktopTextNeedsApproval,
  desktopWindowWordHits,
  desktopWordHits,
} from "../../../shared/desktop-control";
import type { ActionOutcome } from "../execute";
import {
  type AgentDesktopReader,
  type DesktopControl,
  toReadError,
  toWriteError,
} from "./ad-read";
import {
  type AdRunOptions,
  type AgentDesktopCli,
  AgentDesktopError,
} from "./agent-desktop";
import type { ControlChannel } from "./control";
import { DesktopHelperError } from "./host";
import type { DesktopSessions } from "./session";

/**
 * The four desktop writes on agent-desktop: click, type, key and focus (plan
 * docs/plans/2026-11-12-desktop-write.md, Task 21; spec docs/specs/2026-11-12-desktop-write-agent-desktop.md
 * §4, §5 and §8).
 *
 * IN ORDER, AND NOTHING REACHES THE BINARY BEFORE THE STEP THAT ALLOWS IT:
 *  1. The platform: Linux is read only (`read_only_linux`). The legacy Windows engine never builds a
 *     writer (`actions.ts` answers `read_only_windows`).
 *  2. The session: the device's own, for this coworker (the transport's, never the payload's) and
 *     this person. Stopped, expired and absent each have their copy.
 *  3. The target: a ref resolves only from its window's latest snapshot (`stale`, `not_actionable`);
 *     a window id only if this reader listed it.
 *  4. What can never go through, whatever was approved: a password field, a system key, a combination
 *     that does not parse, text over `textMaxBytes`.
 *  5. The check on the spot, against `list-windows`: a title that turned sensitive since the read (or
 *     since the owner approved it) is refused even when approved; without `approved`, a sensitive or
 *     unknown title, a control with no name or named with an action word (click), a submit or close
 *     key, Space alone or with Shift (`desktopActivationKey`), a target that is not a text box
 *     (`DESKTOP_TEXT_ROLES`), a newline into a single-line field and any other control character
 *     (`desktopTextNeedsApproval`, type) are each refused with `needs_approval`. Every check is a
 *     shared function; the server's policy uses the title, word and key ones today, and the device is
 *     the last gate for the rest (Space, non-text targets, control characters, unnamed controls).
 *  6. The action, under the session's signal and the caller's: headless first; a pointer
 *     (`--headed`, inside the device's headed-begin/ack/end) only when agent-desktop answers that the
 *     headless route was not delivered because it is unavailable, and only if nothing was stopped
 *     meanwhile (no headed-begin is sent then).
 *
 * THE FINAL REVIEW (final-fix-brief.md), each only asking more:
 *  - C1: a window of the product itself or of a terminal (`desktopSelfOrTerminalProcess`, by its
 *    process), or whose title holds one of the product's names the server sends (`selfWindowWords`),
 *    is asked about like a sensitive title; approving and refusing words (`DESKTOP_APPROVAL_WORDS`)
 *    are action words whatever the team's list.
 *  - I1: `approved` is no longer a pass for everything. Approved, the whole title and the whole
 *    control name (click) are still checked; a window or action word the owner did not see (not in
 *    `approvedTitle`, `approvedControlName`, or the device's own reason they approved,
 *    `approvedReason`) is asked about, every such word named at once.
 *  - I2: text with a new line that only a real keyboard would type (`--headed`) is asked about
 *    unless approved, before anything is cleared or typed: on a real keyboard a new line is Enter.
 *  - I3: deleting at once (`delete` keys) is asked about like closing; on Windows and Linux so is
 *    Alt with a letter or a digit (a button's mnemonic).
 *  - M3: a write that fails says agent-desktop's code and our words, never its message.
 *
 * OUTCOMES. Success voids the window's refs (the model reads again), renews the session and says so
 * in `note`. A failure agent-desktop marks `not_delivered`, or one before anything was sent, is mapped
 * to its copy as a read's is; so is INVALID_ARGS, refused while the arguments are parsed. A
 * timeout, an abort after the command started, a failure that may have been delivered, and ANY
 * failure after `clear` succeeded are `outcome_unknown`, with
 * `outcomeUnknown: true`, never retried, and the window's refs voided. INVALID_ARGS counts as not
 * delivered only while the envelope says `not_delivered` or nothing at all.
 *
 * THREE WRITES WITH NO WINDOW (Task 24): `desktop.launch`, `desktop.clipboard_read` and
 * `desktop.clipboard_write` take the same lock, platform and session steps and the same stops, then:
 *  - launch: only a name (`DESKTOP_APP_NAME`: no path, no flag) is ever passed, as `launch <app>`
 *    and nothing else; the server decides whether it is asked about. `APP_NOT_FOUND` that was not
 *    delivered is 「没有找到这个应用：<app>」.
 *  - clipboard_read: always needs `approved: true` on the device too; `clipboard-get --format text`,
 *    cut to `clipboardReadMaxChars` characters. Reading changes nothing, so it is never
 *    `outcome_unknown`.
 *  - clipboard_write: `clipboard-set --stdin` with at most `textMaxBytes`; never asked about here,
 *    since nothing is typed (the server decides).
 * No window's refs are voided by these.
 */

export const DESKTOP_WRITE_NOTE =
  "The window may have changed: read it again before the next step.";

export const DESKTOP_LAUNCH_NOTE =
  "The app may have opened a new window: list the windows to find it.";

const BAD_APP = "应用名只能是应用的名字，不能带路径或参数";
const CLIPBOARD_READ_REASON = "读取剪贴板，里面可能有刚复制的密码或验证码";
/** I2: on a real keyboard a new line is Enter, which sends in a chat box and runs in a terminal. */
const HEADED_NEWLINE_REASON =
  "用真实键盘输入带换行的文字可能会直接发送，需要你先确认";
/** I1: how much of a control's whole name a reason shows, in code points. */
const REASON_NAME_MAX = 200;

export type AgentDesktopWriter = (
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  /** The coworker, from the transport; a `botId` in `body` is never read. */
  context?: { botId?: string },
) => Promise<ActionOutcome>;

type Node = Record<string, unknown>;

/** agent-desktop's answers that the headless route is unavailable: a real pointer may do it. */
const HEADED_FALLBACK: ReadonlySet<string> = new Set([
  "POLICY_DENIED",
  "ACTION_NOT_SUPPORTED",
]);

/** The text `clipboard-get --format text` answered: a string, or `text` (`content`, `value`) in an object. */
function clipboardTextOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (!isNode(data)) return undefined;
  for (const key of ["text", "content", "value"])
    if (typeof data[key] === "string") return data[key] as string;
  // An empty clipboard.
  if ("text" in data && data.text === null) return "";
  return undefined;
}

/** A headless attempt that was not delivered and may be made again with a real pointer. */
const FALL_BACK = Symbol("fall back to --headed");

const KIND_RANK: Record<DesktopKeyClass["kind"], number> = {
  plain: 0,
  submit: 1,
  delete: 2,
  close: 3,
  system: 4,
};

/** The shared names (design decision 10) as agent-desktop's `press` reads them (FACTS (g)). */
const AD_MODIFIER: Record<string, string> = { win: "meta" };
const AD_KEY: Record<string, string> = {
  enter: "return",
  backspace: "delete",
  delete: "forwarddelete",
};

const fail = (error: string): ActionOutcome => ({ ok: false, error });
const needs = (reason: string) =>
  fail(desktopMessage("needs_approval", reason));

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: unknown, max: number): string {
  const s = text(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** The strings in `value`, when it is a list; nothing otherwise. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** A name as a reason shows it: at most `REASON_NAME_MAX` code points, an ellipsis when cut. */
function shownName(name: string): string {
  const chars = Array.from(name);
  return chars.length > REASON_NAME_MAX
    ? `${chars.slice(0, REASON_NAME_MAX).join("")}…`
    : name;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** An abort before anything was sent, as the CLI layer reports one. */
function abortError(): Error & { sent: boolean } {
  const error = new Error("The desktop request was aborted.");
  error.name = "AbortError";
  return Object.assign(error, { sent: false });
}

/**
 * `classifyDesktopKeys`, and on Windows the stricter of it and the same combination with `cmd` read
 * as `win`: agent-desktop sends `cmd` to the Windows key there, so `cmd+r` is `win+r`.
 */
export function classifyKeysOn(
  keys: string,
  platform: DesktopPlatform,
): DesktopKeyClass | undefined {
  const base = classifyDesktopKeys(keys);
  if (!base || platform !== "windows") return base;
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop() as string;
  if (!parts.includes("cmd")) return base;
  const asWin = classifyDesktopKeys(
    [...parts.map((part) => (part === "cmd" ? "win" : part)), key].join("+"),
  );
  if (!asWin || KIND_RANK[asWin.kind] <= KIND_RANK[base.kind]) return base;
  return { kind: asWin.kind, normalized: base.normalized, force: false };
}

/** A normalized combination (`ctrl+alt+shift+cmd+win+key`) in agent-desktop's names. */
export function adCombo(normalized: string): string {
  const parts = normalized.split("+");
  const key = parts.pop() as string;
  return [
    ...parts.map((modifier) => AD_MODIFIER[modifier] ?? modifier),
    AD_KEY[key] ?? key,
  ].join("+");
}

/** `delivered_verified`, or a focus agent-desktop reports done, is verified; anything else is not. */
function deliveryOf(data: unknown): DesktopWriteOutput["delivery"] {
  if (!isNode(data)) return "unverified";
  const disposition = data.disposition;
  if (isNode(disposition) && disposition.delivery === "delivered_verified")
    return "verified";
  const focused = data.focused;
  if (isNode(focused) && focused.is_focused === true) return "verified";
  return "unverified";
}

/**
 * An error agent-desktop does not say was delivered: `not_delivered`, or no disposition at all. Only
 * for the codes that are refused before anything is done (INVALID_ARGS, APP_NOT_FOUND for launch).
 */
function saysNotSent(error: AgentDesktopError): boolean {
  return error.notDelivered || error.delivery === undefined;
}

/** Whether a write that failed this way may have changed something. */
function mayHaveChanged(error: unknown): boolean {
  // INVALID_ARGS is agent-desktop refusing its arguments as it parses them, before any action
  // (FACTS, 其它发现: a bare `@e1` ref; plan design decision 1: exit code 2 is an argument error),
  // unless its own disposition says the action may have been delivered.
  if (error instanceof AgentDesktopError)
    return !(
      error.notDelivered ||
      (error.code === "INVALID_ARGS" && saysNotSent(error))
    );
  if (isAbort(error)) return (error as { sent?: boolean }).sent !== false;
  if (error instanceof DesktopHelperError) return error.sent;
  return true;
}

type Target = {
  windowId: string;
  adWindowId: string;
  pid: number;
  adRef?: string;
  control?: DesktopControl;
};

export function createAgentDesktopWriter(opts: {
  cli: AgentDesktopCli;
  reader: AgentDesktopReader;
  sessions: DesktopSessions;
  control: ControlChannel;
  platform: DesktopPlatform;
  now?: () => number;
  /**
   * Whether a window's process is the product itself or a terminal (final review C1). Always
   * `desktopSelfOrTerminalProcess` in the product; a test of something else may stand in for it.
   */
  selfOrTerminal?: (process: string) => boolean;
}): AgentDesktopWriter {
  const { cli, reader, sessions, control, platform } = opts;
  const now = opts.now ?? Date.now;
  const selfOrTerminal = opts.selfOrTerminal ?? desktopSelfOrTerminalProcess;

  const write: AgentDesktopWriter = async (action, body, signal, context) => {
    const started = now();
    if (!DESKTOP_WRITE_ACTIONS.has(action))
      return fail(desktopMessage("unsupported"));

    // 1. The platform.
    if (platform === "linux") return fail(desktopMessage("read_only_linux"));

    // 2. The session. The coworker is the transport's.
    const token = body.session;
    const botId = text(context?.botId);
    const actorId = text(body.actorId);
    const state = sessions.check(token, botId, actorId);
    if (state === "stopped") return fail(desktopMessage("stopped"));
    if (state === "expired") return fail(desktopMessage("session_expired"));
    if (state !== "ok") return fail(desktopMessage("no_session"));
    // Taken now: a stop of this session aborts this very action.
    const sessionSignal = sessions.signal;
    const approved = body.approved === true;

    const signals = [sessionSignal, signal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const runSignal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    const run = (args: string[], o: AdRunOptions = {}) =>
      cli.run(args, { ...o, ...(runSignal ? { signal: runSignal } : {}) });

    /**
     * A failure as the owner and the model read it; `changed` once something may have been done,
     * which voids `windowId`'s refs when there is one.
     */
    const failureIn = (
      error: unknown,
      changed: boolean,
      windowId?: string,
      asRead = false,
    ): ActionOutcome => {
      if (changed) {
        if (windowId !== undefined) reader.invalidate(windowId);
        return {
          ok: false,
          error: desktopMessage("outcome_unknown"),
          outcomeUnknown: true,
        };
      }
      if (isAbort(error))
        return fail(
          sessionSignal?.aborted
            ? desktopMessage("stopped")
            : "已在设备上停止。",
        );
      const mapped = (asRead ? toReadError : toWriteError)(error, platform);
      if (mapped instanceof DesktopHelperError) {
        if (mapped.code === "mac_permission")
          control.emit({ event: "permission-needed" });
        return fail(mapped.message);
      }
      return fail(desktopMessage("failed"));
    };

    const succeeded = <T>(output: T): ActionOutcome => {
      sessions.check(token, botId, actorId);
      return { ok: true, output };
    };

    // The writes with no window.
    if (action === "desktop.launch") {
      const app = body.app;
      if (typeof app !== "string" || !DESKTOP_APP_NAME.test(app))
        return fail(desktopMessage("failed", BAD_APP));
      let data: unknown;
      try {
        data = await run(["launch", app]);
      } catch (error) {
        if (
          error instanceof AgentDesktopError &&
          error.code === "APP_NOT_FOUND" &&
          saysNotSent(error)
        )
          return fail(`没有找到这个应用：${app}`);
        return failureIn(error, mayHaveChanged(error));
      }
      return succeeded<DesktopLaunchOutput>({
        app,
        durationMs: Math.max(0, now() - started),
        delivery: deliveryOf(data),
        note: DESKTOP_LAUNCH_NOTE,
      });
    }
    if (action === "desktop.clipboard_read") {
      // Every time, whatever the session: the clipboard often holds a password just copied.
      if (!approved) return needs(CLIPBOARD_READ_REASON);
      let data: unknown;
      try {
        data = await run(["clipboard-get", "--format", "text"]);
      } catch (error) {
        // Reading changes nothing; and it fails as a read does (its wording pinned since Task 24).
        return failureIn(error, false, undefined, true);
      }
      const whole = clipboardTextOf(data);
      if (whole === undefined)
        return fail(desktopMessage("failed", "看不懂剪贴板里的内容"));
      // Cut on a character, never inside one.
      const chars = Array.from(whole);
      const truncated = chars.length > DESKTOP_LIMITS.clipboardReadMaxChars;
      return succeeded<DesktopClipboardReadOutput>({
        text: truncated
          ? chars.slice(0, DESKTOP_LIMITS.clipboardReadMaxChars).join("")
          : whole,
        truncated,
        durationMs: Math.max(0, now() - started),
      });
    }
    if (action === "desktop.clipboard_write") {
      const content = body.text;
      if (typeof content !== "string")
        return fail(desktopMessage("failed", "没有要写入剪贴板的文字"));
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > DESKTOP_LIMITS.textMaxBytes)
        return fail(desktopMessage("failed", "文字太长"));
      try {
        await run(["clipboard-set", "--stdin"], { stdin: content });
      } catch (error) {
        return failureIn(error, mayHaveChanged(error));
      }
      return succeeded<DesktopClipboardWriteOutput>({
        bytes,
        durationMs: Math.max(0, now() - started),
      });
    }

    // 3. The target.
    let target: Target;
    if (action === "desktop.click" || action === "desktop.type") {
      const resolved = reader.resolveRef(body.ref as string);
      if (resolved === "stale") return fail(desktopMessage("stale"));
      if (resolved === "not_actionable")
        return fail(desktopMessage("not_actionable"));
      const ad = reader.adWindow(resolved.windowId);
      if (!ad) return fail(desktopMessage("stale"));
      target = { ...resolved, pid: ad.pid };
    } else {
      const windowId = text(body.windowId);
      const ad = windowId === "" ? undefined : reader.adWindow(windowId);
      if (!ad) return fail(desktopMessage("no_window"));
      target = { windowId, ...ad };
    }
    const { windowId, adWindowId } = target;

    // 4. What no approval allows.
    let typed = "";
    let mode: "replace" | "append" = "replace";
    let keys: DesktopKeyClass | undefined;
    if (action === "desktop.type") {
      if (target.control?.password)
        return fail(desktopMessage("password_field"));
      if (typeof body.text !== "string")
        return fail(desktopMessage("failed", "没有要输入的文字"));
      if (body.mode !== "replace" && body.mode !== "append")
        return fail(desktopMessage("failed", "输入方式不对"));
      typed = body.text;
      mode = body.mode;
      if (Buffer.byteLength(typed, "utf8") > DESKTOP_LIMITS.textMaxBytes)
        return fail(desktopMessage("failed", "文字太长"));
    }
    const keysText = text(body.keys);
    if (action === "desktop.key") {
      keys = classifyKeysOn(keysText, platform);
      if (!keys) return fail(desktopMessage("failed", "按键格式不对"));
      if (keys.kind === "system")
        return fail(desktopMessage("system_keys", keysText));
    }

    /** A failure as the owner and the model read it; `changed` once something may have been done. */
    const failure = (error: unknown, changed: boolean): ActionOutcome =>
      failureIn(error, changed, windowId);

    // 5. The window as it is now.
    let live: Node | undefined;
    try {
      const listed = await run(["list-windows"]);
      live = (Array.isArray(listed) ? listed : []).find(
        (entry): entry is Node =>
          isNode(entry) && entry.id === adWindowId && entry.pid === target.pid,
      );
    } catch (error) {
      // Listing changes nothing.
      return failure(error, false);
    }
    if (!live) return fail(desktopMessage("no_window"));
    const liveTitle = text(live.title);
    const title = clip(liveTitle, DESKTOP_LIMITS.titleMax);
    // The product's own names (C1), from the server's brand, count as window words too.
    const selfWords = strings(body.selfWindowWords);
    const titleWords = desktopWindowWordHits(liveTitle, selfWords);
    const titleWord = titleWords[0];
    // The product itself or a terminal (C1), by its process or by its title.
    const selfWindow =
      selfOrTerminal(text(live.app_name)) ||
      titleWords.some((word) => !DESKTOP_WINDOW_WORDS.includes(word));
    const approvedTitle =
      typeof body.approvedTitle === "string" ? body.approvedTitle : undefined;
    const approvedReason =
      typeof body.approvedReason === "string" ? body.approvedReason : "";
    /*
     * I1 checks a name the card showed only when the server says which one (null: none). A server
     * from before says nothing, and could not ask again after an approval: the device then checks
     * as it did, rather than refusing every approved click on such a control.
     */
    const namesShown = "approvedControlName" in body;
    const approvedControlName =
      typeof body.approvedControlName === "string"
        ? body.approvedControlName
        : "";
    const words = desktopActionWordsOf(strings(body.actionWords));
    // The whole name: the one shown is cut to `nameMax`, and a word past that must not go unseen.
    const name =
      action === "desktop.click"
        ? (reader.fullName?.(body.ref as string) ?? target.control?.name ?? "")
        : "";
    // Compared whole: a word added past the `titleMax` characters shown still changes the title.
    // A stand-in reader without whole titles falls back to the cut ones.
    const readFull = reader.readFullTitle?.(windowId);
    const readTitle = reader.readTitle?.(windowId);
    const changedSinceRead =
      readFull !== undefined
        ? readFull !== liveTitle
        : readTitle !== undefined && readTitle !== title;
    // Approved or not: a title that is sensitive now (judged whole) and is not the one that was read,
    // or not the one approved (as shown, cut the same way).
    if (
      titleWord !== undefined &&
      (changedSinceRead ||
        (approvedTitle !== undefined && approvedTitle !== title))
    )
      return needs(`窗口标题刚刚变成含「${titleWord}」，请重新列出窗口`);
    if (approved) {
      /*
       * I1: approved for what the owner saw. A window word in the whole title, or an action word in
       * the whole name, that was not on the card (the title, the control's name, or the device's
       * own reason approved) is asked about, all of them at once.
       */
      const titleSeen = [
        ...desktopWindowWordHits(approvedTitle ?? "", selfWords),
        ...desktopWindowWordHits(approvedReason, selfWords),
      ];
      const unseenTitle =
        approvedTitle === undefined
          ? []
          : titleWords.filter((word) => !titleSeen.includes(word));
      const allWords = [...words, ...DESKTOP_APPROVAL_WORDS];
      const nameSeen = [
        ...desktopWordHits(approvedControlName, allWords),
        ...desktopWordHits(approvedReason, allWords),
      ];
      const unseenName = namesShown
        ? desktopWordHits(name, allWords).filter(
            (word) => !nameSeen.includes(word),
          )
        : [];
      const findings = [
        ...(unseenTitle.length > 0
          ? [`窗口标题含「${unseenTitle.join("」「")}」`]
          : []),
        ...(unseenName.length > 0
          ? [`控件名含「${unseenName.join("」「")}」：「${shownName(name)}」`]
          : []),
      ];
      if (findings.length > 0) return needs(findings.join("；"));
    }
    if (!approved) {
      if (liveTitle.trim() === "") return needs("没能确认窗口的标题");
      // C1: the product's own window or a terminal, every time.
      if (selfWindow) return needs(DESKTOP_SELF_WINDOW_REASON);
      if (titleWord !== undefined) return needs(`窗口标题含「${titleWord}」`);
      if (action === "desktop.click") {
        // A control with no name cannot be told apart from any other (round 1).
        if (name.trim() === "") return needs("没能确认要操作的控件");
        const word = desktopActionWordHit(name, words);
        if (word !== undefined) return needs(`控件名含「${word}」`);
      }
      if (keys?.kind === "submit")
        return needs(`按 ${keysText} 可能会把内容提交或发送出去`);
      if (keys?.kind === "close") return needs(`按 ${keysText} 会关闭程序`);
      if (keys?.kind === "delete")
        return needs(`按 ${keysText} 可能会直接删除文件或内容`);
      // Tab to a button and Space presses it: as good as an unasked click (round 1). On Windows and
      // Linux, Alt with a letter presses the button it names (I3).
      if (action === "desktop.key" && desktopActivationKey(keysText, platform))
        return needs("这个按键可能会按下当前选中的按钮，需要你先确认");
      if (action === "desktop.type") {
        const role = target.control?.type ?? "";
        if (!DESKTOP_TEXT_ROLES.has(role))
          return needs("目标不是输入框，需要你先确认");
        // FACTS (b) and round 1: a textarea, or a textfield inside a scrollarea, is multi-line.
        const multiline =
          role === "textarea" ||
          (role === "textfield" && target.control?.singleLine !== true);
        if (!multiline && /[\r\n]/.test(typed))
          return needs("往单行输入框里输入带换行的文字");
        if (desktopTextNeedsApproval(typed, multiline))
          return needs("输入的文字含控制字符或特殊的换行符");
      }
    }
    // A key press goes to the window in front, and only there.
    if (action === "desktop.key" && live.is_focused !== true)
      return fail(desktopMessage("not_foreground"));

    // 6. The action.
    let physical = false;
    /** Something on the screen may have changed already (`clear` succeeded). */
    let partial = false;
    /** Headless; `FALL_BACK` when agent-desktop says that route is unavailable and was not delivered. */
    const semantic = async (args: string[], stdin?: string) => {
      try {
        return await run(args, stdin === undefined ? {} : { stdin });
      } catch (error) {
        if (
          error instanceof AgentDesktopError &&
          error.notDelivered &&
          HEADED_FALLBACK.has(error.code)
        )
          return FALL_BACK;
        throw error;
      }
    };
    /** A real pointer, with the device's mouse check paused around it. */
    const headed = (args: string[], stdin?: string) => {
      // Stopped while the headless attempt ran: no pause is announced and nothing physical runs.
      if (runSignal?.aborted) return Promise.reject(abortError());
      physical = true;
      return control.headed(() =>
        run(args, { headed: true, ...(stdin === undefined ? {} : { stdin }) }),
      );
    };

    const adRef = target.adRef as string;
    // I2: only a real keyboard is left, and on it a new line is Enter.
    const keyboardNewline = !approved && /[\r\n]/.test(typed);
    let data: unknown;
    try {
      switch (action) {
        case "desktop.click":
          data = await semantic(["click", adRef]);
          if (data === FALL_BACK) data = await headed(["click", adRef]);
          break;
        case "desktop.type":
          if (mode === "replace") {
            data = await semantic(["set-value", adRef, "--stdin"], typed);
            if (data === FALL_BACK) {
              // Asked before the box is cleared: nothing has changed yet.
              if (keyboardNewline) return needs(HEADED_NEWLINE_REASON);
              await run(["clear", adRef]);
              partial = true;
              data = await headed(["type", adRef, "--stdin"], typed);
            }
          } else {
            data = await semantic(["type", adRef, "--stdin"], typed);
            if (data === FALL_BACK) {
              if (keyboardNewline) return needs(HEADED_NEWLINE_REASON);
              data = await headed(["type", adRef, "--stdin"], typed);
            }
          }
          break;
        case "desktop.key": {
          const combo = keys as DesktopKeyClass;
          // Real keyboard input, but no pointer: the mouse check stays on.
          physical = true;
          data = await run(
            ["press", adCombo(combo.normalized), "--window-id", adWindowId],
            combo.force && approved ? { force: true } : {},
          );
          break;
        }
        default: {
          // desktop.focus. FACTS (d): headless works; `--headed` only if it is ever refused.
          const args = ["focus-window", "--window-id", adWindowId];
          data = await semantic(args);
          if (data === FALL_BACK) data = await headed(args);
        }
      }
    } catch (error) {
      return failure(error, partial || mayHaveChanged(error));
    }

    reader.invalidate(windowId);
    sessions.check(token, botId, actorId);
    const output: DesktopWriteOutput = {
      physical,
      durationMs: Math.max(0, now() - started),
      delivery: deliveryOf(data),
      window: {
        windowId,
        title,
        process: clip(live.app_name, DESKTOP_LIMITS.titleMax),
      },
      ...(target.control && action !== "desktop.focus"
        ? {
            control: { type: target.control.type, name: target.control.name },
          }
        : {}),
      note: DESKTOP_WRITE_NOTE,
    };
    return { ok: true, output };
  };

  /**
   * ONE WRITE AT A TIME, from resolving its ref to voiding the refs afterwards. The CLI queue only
   * keeps commands from overlapping; without this, two writes on one snapshot would both resolve
   * their target before either ran, and the second would act on a window the first just changed.
   */
  let tail: Promise<void> = Promise.resolve();
  return async (action, body, signal, context) => {
    const prev = tail;
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next write waits for the one before this and for this one, even if this one gives up.
    tail = prev.then(() => mine);
    try {
      const sessionSignal = sessions.signal;
      const signals = [signal, sessionSignal].filter(
        (s): s is AbortSignal => s !== undefined,
      );
      if (!(await turn(prev, signals)))
        // Stopped while waiting: nothing was resolved, checked or sent.
        return fail(
          sessionSignal?.aborted
            ? desktopMessage("stopped")
            : "已在设备上停止。",
        );
      return await write(action, body, signal, context);
    } finally {
      release();
    }
  };
}

/** Waits for `prev`; false as soon as any of `signals` aborts (or already has). */
function turn(prev: Promise<void>, signals: AbortSignal[]): Promise<boolean> {
  if (signals.some((s) => s.aborted)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      for (const s of signals) s.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => done(false);
    for (const s of signals)
      s.addEventListener("abort", onAbort, { once: true });
    void prev.then(() => done(true));
  });
}
