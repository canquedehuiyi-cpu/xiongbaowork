import type { ApprovalCandidate } from "./types";

/**
 * The floor for reading a desktop window (device-side desktop viewing §4.2). The title and the
 * sensitive word it matched come from the call site (`subject.desktop`, set by the gateway from the
 * window list), never from the model's arguments.
 */
export const DESKTOP_SNAPSHOT_TOOL = "computer_desktop_snapshot";
export const DESKTOP_WINDOW_UNKNOWN =
  "没能确认这个窗口的标题，读取它之前需要你批准。";

export function desktopWindowReason(title: string, word: string): string {
  return `窗口「${title}」的标题含「${word}」，读取它之前需要你批准。`;
}

export function desktopFloor(
  candidate: ApprovalCandidate,
): { source: "desktop_window"; reason: string } | undefined {
  if (candidate.toolRef !== DESKTOP_SNAPSHOT_TOOL) return undefined;
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

/** Every desktop floor, as one: what the policy's floor chain asks after its other floors. */
export type DesktopFloor = {
  source: "desktop_window" | "desktop_session" | "desktop_action";
  reason: string;
};

/**
 * The desktop floors in the order they are asked. ORDER FOR TASK 17 (coordinator ruling C1, design
 * decision 6): the per-action floor (`desktopActionFloor`) goes BEFORE the session floor, and when a
 * write both opens a session and hits the per-action floor, the result is ONE card with source
 * `desktop_action` and both reasons joined (the session's first). Add it here, not in the chain in
 * ./policy.ts, so the chain keeps a single desktop entry.
 */
export function desktopFloors(
  candidate: ApprovalCandidate,
): DesktopFloor | undefined {
  return desktopFloor(candidate) ?? desktopSessionFloor(candidate);
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
