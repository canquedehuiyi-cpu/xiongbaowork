import { useSyncExternalStore } from "react";

/**
 * Whether this browser may show OpenBot's notifications: the browser's own answer, never a guess.
 *
 * WHAT A NOTIFICATION IS HERE. The web app raises one when a Bot starts needing the person
 * (`AttentionNotifier` in `bot-profile/attention.tsx`), from the page itself. So it shows while
 * OpenBot is open in a tab, and not once the tab is closed: there is no web push. Onboarding's Get
 * notified step says so rather than promise more.
 *
 * ONE ANSWER FOR THE WHOLE PAGE. Onboarding's step and a Bot's page both offer to turn them on,
 * and a press on either has to show on the other, so the state lives here once and both read it
 * through `useNotificationPermission`.
 */
export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  /** No Notification API, as in Safari on iPhone outside a Home Screen app. */
  | "unsupported";

/** What the browser says now. A browser that throws on reading it is one that cannot show them. */
export function notificationPermission(): NotificationPermissionState {
  try {
    return typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission;
  } catch {
    return "unsupported";
  }
}

const listeners = new Set<() => void>();
let current: NotificationPermissionState | null = null;

function read(): NotificationPermissionState {
  if (current !== null) return current;
  current = notificationPermission();
  return current;
}

function set(next: NotificationPermissionState) {
  current = next;
  for (const listener of listeners) listener();
}

/** Asks the browser. */
async function ask(): Promise<NotificationPermissionState> {
  if (notificationPermission() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

/**
 * Asks the browser, which shows its own prompt the first time and answers at once after that.
 * Resolves with the answer; never throws.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (read() === "unsupported") return "unsupported";
  const answer = await ask();
  set(answer);
  return answer;
}

/**
 * Whether a notification may be shown now: the browser's answer, read afresh each time, so a site
 * setting changed meanwhile counts.
 */
export async function notificationsAllowed(): Promise<boolean> {
  return notificationPermission() === "granted";
}

/** Reads the browser's answer again, for a "Check again" after somebody changed a site setting. */
export function refreshNotificationPermission() {
  current = null;
  set(read());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The browser's answer, kept current across every component that draws it. */
export function useNotificationPermission(): NotificationPermissionState {
  return useSyncExternalStore(subscribe, read, () => "unsupported" as const);
}
