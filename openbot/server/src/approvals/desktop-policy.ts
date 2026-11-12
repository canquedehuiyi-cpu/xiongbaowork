import {
  classifyDesktopKeys,
  desktopActivationKey,
  desktopWindowWordHit,
  desktopWordHit,
} from "../../../shared/desktop-control";
import type { ApprovalCandidate, DesktopWriteAction } from "./types";

/**
 * The floor for reading a desktop window (device-side desktop viewing §4.2). The title and the
 * sensitive word it matched come from the call site (`subject.desktop`, set by the gateway from the
 * window list), never from the model's arguments. Waiting for a control (plan Task 25) reads the
 * window as a snapshot does, under the same floor.
 */
export const DESKTOP_SNAPSHOT_TOOL = "computer_desktop_snapshot";
export const DESKTOP_WAIT_TOOL = "computer_desktop_wait";
export const DESKTOP_WINDOW_UNKNOWN =
  "没能确认这个窗口的标题，读取它之前需要你批准。";

export function desktopWindowReason(title: string, word: string): string {
  return `窗口「${title}」的标题含「${word}」，读取它之前需要你批准。`;
}

export function desktopFloor(
  candidate: ApprovalCandidate,
): { source: "desktop_window"; reason: string } | undefined {
  if (
    candidate.toolRef !== DESKTOP_SNAPSHOT_TOOL &&
    candidate.toolRef !== DESKTOP_WAIT_TOOL
  )
    return undefined;
  const desktop = candidate.subject?.desktop;
  if (!desktop)
    return { source: "desktop_window", reason: DESKTOP_WINDOW_UNKNOWN };
  if (desktop.sensitiveWord)
    return {
      source: "desktop_window",
      reason: desktopWindowReason(desktop.title, desktop.sensitiveWord),
    };
  return undefined;
}

/**
 * THE DESKTOP SESSION (desktop write, phase 2; plan design decisions 5 and 6). Every desktop write
 * carries `subject.desktopWrite`, set by the gateway from what the device says is current, never
 * from the model's arguments. With no session, the write first asks to open one (`desktop_session`,
 * once only); in a session, only the person's "ask before changes" default stops asking.
 *
 * `DESKTOP_SESSION_TOOL` is the permissions row for operating the desktop at all: disabling it
 * refuses every write at the gateway, before the device is asked anything.
 */
export const DESKTOP_SESSION_TOOL = "computer_desktop_session";

/**
 * The tools that write to the desktop: one per `DesktopWriteAction`, named `computer_desktop_<action>`.
 * With the session row disabled none of them is offered to the model (headless tools) and every one
 * is refused outright (`refusedOutright`).
 */
export const DESKTOP_WRITE_TOOLS: ReadonlySet<string> = new Set(
  (
    [
      "click",
      "type",
      "key",
      "focus",
      "launch",
      "clipboard_read",
      "clipboard_write",
    ] satisfies DesktopWriteAction[]
  ).map((action) => `computer_desktop_${action}`),
);
export const DESKTOP_SESSION_REASON =
  "员工要开始操作你的电脑（最长 60 分钟，15 分钟没有操作自动结束），必要时会移动你的鼠标。屏幕顶部会显示提示条，按 Ctrl+Alt+Esc（Mac 上 ⌃⌥⎋）或移动鼠标即可停止。";

/** A desktop write with no session on the device: asks to open one. */
export function desktopSessionFloor(
  candidate: ApprovalCandidate,
): { source: "desktop_session"; reason: string } | undefined {
  return candidate.subject?.desktopWrite?.session === "none"
    ? { source: "desktop_session", reason: DESKTOP_SESSION_REASON }
    : undefined;
}

/** A desktop write inside a session the device holds now. */
export function activeDesktopSession(candidate: ApprovalCandidate): boolean {
  return candidate.subject?.desktopWrite?.session === "active";
}

/**
 * PER-ACTION APPROVAL (desktop write, phase 2; plan Task 17, design decisions 10, 11 and 13). Inside
 * a session or not, these writes ask every time, once only, in this order, the first that applies:
 *
 *  1. any write in a window whose title has one of `DESKTOP_WINDOW_WORDS` (`desktopWindowWordHit`);
 *  2. reading the clipboard;
 *  3. a write whose control the gateway could not confirm (`control: null`), or a click, typing, key
 *     or focus whose window title it could not confirm;
 *  4. clicking a control whose name has one of the action words (the team's list, or the default);
 *  5. a key that closes a program or submits; a system key or one that cannot be read asks too (the
 *     gateway refuses those before asking, so one reaching here asks rather than slipping through);
 *     Space alone or with Shift (`desktopActivationKey`), which presses the focused button;
 *  6. typing into a control that is not a text box (`notTextTarget`), a newline into a single-line
 *     field, which submits it, and any other control character (`controlCharacters`).
 *
 * The device checks the same with the same shared functions (Task 21); when it still asks for
 * approval the server did not ask for, its reason (`deviceReason`) comes first, asked once.
 *
 * Everything here comes from `subject.desktopWrite`, set by the gateway, never from the model.
 */
const ACTION_VERB: Record<DesktopWriteAction, string> = {
  click: "点击",
  type: "输入文字",
  key: "按键",
  focus: "切换窗口",
  launch: "启动程序",
  clipboard_read: "读取剪贴板",
  clipboard_write: "写入剪贴板",
};
export const DESKTOP_CLIPBOARD_READ_REASON =
  "读取你的剪贴板（里面可能有刚复制的密码或验证码），需要你批准。";
/** A system key, or one that cannot be read, that reached the policy (coordinator's copy). */
export const DESKTOP_SYSTEM_KEY_REASON =
  "这个按键可能会触发系统操作，需要你先确认。";
/*
 * The device's further checks (plan Task 21, round 1), asked on the server too so the owner sees one
 * card rather than a refusal from the device: Space alone or with Shift presses the focused button;
 * typing into something that is not a text box; control characters or special line breaks.
 */
export const DESKTOP_ACTIVATION_KEY_REASON =
  "这个按键可能会按下当前选中的按钮，需要你先确认。";
export const DESKTOP_NOT_TEXT_TARGET_REASON = "目标不是输入框，需要你先确认。";
export const DESKTOP_CONTROL_CHARACTERS_REASON =
  "输入的文字含控制字符或特殊的换行符，需要你先确认。";
/** The device asked for approval the server had not asked for (`needs_approval`): its reason. */
export function desktopDeviceReason(reason: string): string {
  return `设备端核对后认为这一步需要你批准：${reason.replace(/[。.\s]+$/u, "")}。`;
}
/** The writes that happen in a window, so an unknown title is an unknown target. */
const IN_A_WINDOW: ReadonlySet<DesktopWriteAction> = new Set([
  "click",
  "type",
  "key",
  "focus",
]);

/** Why this desktop write asks on its own (design decision 13), or nothing when it does not. */
export function desktopActionReason(
  candidate: ApprovalCandidate,
  words: readonly string[],
): string | undefined {
  const write = candidate.subject?.desktopWrite;
  if (!write) return undefined;
  if (typeof write.deviceReason === "string" && write.deviceReason.trim())
    return desktopDeviceReason(write.deviceReason);
  const title = write.title ?? "";
  const windowWord = desktopWindowWordHit(title);
  if (windowWord)
    return `窗口「${title}」的标题含「${windowWord}」，在里面${ACTION_VERB[write.action] ?? "操作"}需要你批准。`;
  if (write.action === "clipboard_read") return DESKTOP_CLIPBOARD_READ_REASON;
  if (
    write.control === null ||
    (!write.title?.trim() && IN_A_WINDOW.has(write.action)) ||
    // A control with no name cannot be told apart from any other (Task 21, round 1).
    (write.action === "click" && !write.control?.name?.trim())
  )
    return `没能确认要操作的控件，在窗口「${title}」里执行前需要你批准。`;
  if (write.action === "click" && write.control) {
    const word = desktopWordHit(write.control.name, words);
    if (word)
      return `在窗口「${title}」里点击「${write.control.name}」：控件名含「${word}」，需要你批准。`;
  }
  if (write.action === "key") {
    const keys = write.keys ?? "";
    const kind = classifyDesktopKeys(keys)?.kind;
    if (kind === "close")
      return `在窗口「${title}」里按 ${keys}，会关闭程序，需要你批准。`;
    if (kind === "submit")
      return `在窗口「${title}」里按 ${keys}，可能会把内容提交或发送出去，需要你批准。`;
    if (kind !== "plain") return DESKTOP_SYSTEM_KEY_REASON;
    if (desktopActivationKey(keys)) return DESKTOP_ACTIVATION_KEY_REASON;
  }
  if (write.action === "type") {
    if (write.notTextTarget === true) return DESKTOP_NOT_TEXT_TARGET_REASON;
    if (write.newlineInSingleLine === true)
      return `往窗口「${title}」的单行输入框「${write.control?.name ?? ""}」里输入带换行的文字，相当于提交，需要你批准。`;
    if (write.controlCharacters === true)
      return DESKTOP_CONTROL_CHARACTERS_REASON;
  }
  return undefined;
}

/**
 * The per-action floor. With no session the same card also opens one (design decision 6): one card,
 * source `desktop_action`, the session's sentence first and this write's after it.
 */
export function desktopActionFloor(
  candidate: ApprovalCandidate,
  words: readonly string[],
): { source: "desktop_action"; reason: string } | undefined {
  const reason = desktopActionReason(candidate, words);
  if (reason === undefined) return undefined;
  return {
    source: "desktop_action",
    reason: desktopSessionFloor(candidate)
      ? `${DESKTOP_SESSION_REASON}${reason}`
      : reason,
  };
}

/** Every desktop floor, as one: what the policy's floor chain asks after its other floors. */
export type DesktopFloor = {
  source: "desktop_window" | "desktop_session" | "desktop_action";
  reason: string;
};

/**
 * The desktop floors in the order they are asked: reading a sensitive window, then the per-action
 * floor, then opening a session. The per-action floor goes BEFORE the session floor, so a write that
 * both opens a session and asks on its own gets ONE card with source `desktop_action` and both
 * reasons joined, the session's first (design decision 6). `words` is the team's action-word list,
 * or the default.
 */
export function desktopFloors(
  candidate: ApprovalCandidate,
  words: readonly string[],
): DesktopFloor | undefined {
  return (
    desktopFloor(candidate) ??
    desktopActionFloor(candidate, words) ??
    desktopSessionFloor(candidate)
  );
}

/**
 * The desktop floors that offer "Allow once" only. Like the once-only floors in ./policy.ts, a rule,
 * preference or reviewer that would ask anyway is restated as this floor, so the card never offers a
 * standing answer that could not apply (opening a session is asked every time there is none).
 */
export function desktopOnceOnly(floor: { source: string }): boolean {
  return (
    floor.source === "desktop_session" || floor.source === "desktop_action"
  );
}
