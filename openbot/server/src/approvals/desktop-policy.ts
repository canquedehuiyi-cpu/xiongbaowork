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
