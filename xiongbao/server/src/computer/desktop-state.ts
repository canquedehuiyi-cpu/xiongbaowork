import {
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
  type DesktopSnapshot,
  type DesktopWindow,
} from "../../../shared/desktop-control";

/**
 * The window lists a machine last answered, per tenant, machine and Bot (device-side desktop viewing,
 * Phase 1). A read names a window by its id; the title the approval floor judges, the row records and
 * the gate shows is taken from here, never from the model's arguments. A list that is not here, or is
 * older than five minutes, counts as not known, and the gateway asks the machine again.
 */

export const DESKTOP_WINDOWS_TTL_MS = 300_000;
export const DESKTOP_WINDOWS_CACHE_LIMIT = 1000;

export function desktopCacheKey(
  machine: { tenantId: string; deviceId: string },
  botId: string,
): string {
  return `${machine.tenantId}/${machine.deviceId}/${botId}`;
}

export type DesktopWindowCache = {
  /** Replaces the whole list for `key`; the newest key is kept, the oldest dropped past the limit. */
  remember(key: string, windows: DesktopWindow[]): void;
  /** The window with this id in `key`'s list, or undefined when the list is absent or expired. */
  find(key: string, windowId: string): DesktopWindow | undefined;
};

export function createDesktopWindowCache(
  options: { now?: () => number; ttlMs?: number; limit?: number } = {},
): DesktopWindowCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DESKTOP_WINDOWS_TTL_MS;
  const limit = options.limit ?? DESKTOP_WINDOWS_CACHE_LIMIT;
  // A Map iterates in insertion order, so its first key is always the oldest list.
  const lists = new Map<string, { windows: DesktopWindow[]; at: number }>();
  return {
    remember(key, windows) {
      lists.delete(key);
      lists.set(key, { windows: [...windows], at: now() });
      while (lists.size > limit) {
        const oldest = lists.keys().next().value;
        if (oldest === undefined) break;
        lists.delete(oldest);
      }
    },
    find(key, windowId) {
      const entry = lists.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) {
        lists.delete(key);
        return undefined;
      }
      return entry.windows.find((window) => window.windowId === windowId);
    },
  };
}

/**
 * The controls a machine last showed in its windows, per tenant, machine and Bot (desktop write,
 * phase 2; plan Task 22): ref → which window it is in, its type and name, and whether it is a password
 * box or a single-line field. A write names a control by its ref; what the per-action floors judge
 * (the control's name, whether it is a text box) comes from here, never from the model's arguments.
 *
 * NOT AUTHORITATIVE, and only ever errs towards asking. Another replica may have read the window, so a
 * ref missing here is "the control could not be confirmed" and asks the owner; the device checks the
 * same again against its own snapshot. A window's refs are replaced by its next snapshot (the device
 * keeps only the latest one per window) and forgotten after a write in it, which may have changed it.
 */
export type DesktopControlEntry = {
  windowId: string;
  type: string;
  name: string;
  password?: true;
  singleLine?: true;
};

export type DesktopControlCache = {
  /** Replaces the refs of the snapshot's window with the snapshot's. */
  rememberSnapshot(key: string, snapshot: DesktopSnapshot): void;
  /** The control `ref` names in `key`, or undefined when unknown, replaced, forgotten or too old. */
  control(key: string, ref: string): DesktopControlEntry | undefined;
  /** Forgets every ref of one window in `key`. */
  forgetWindow(key: string, windowId: string): void;
};

export const DESKTOP_CONTROLS_TTL_MS = 300_000;
export const DESKTOP_CONTROLS_CACHE_LIMIT = 1000;

export function createDesktopControlCache(
  options: { now?: () => number; ttlMs?: number; limit?: number } = {},
): DesktopControlCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DESKTOP_CONTROLS_TTL_MS;
  const limit = options.limit ?? DESKTOP_CONTROLS_CACHE_LIMIT;
  type Window = { at: number; refs: Map<string, DesktopControlEntry> };
  // Per key, the windows read, oldest first; the keys themselves oldest first (a Map keeps order).
  const machines = new Map<string, Map<string, Window>>();
  return {
    rememberSnapshot(key, snapshot) {
      const windowId = snapshot?.window?.windowId;
      if (typeof windowId !== "string" || !DESKTOP_WINDOW_ID.test(windowId))
        return;
      const refs = new Map<string, DesktopControlEntry>();
      for (const element of Array.isArray(snapshot.elements)
        ? snapshot.elements
        : []) {
        // Untrusted input from the device: a malformed entry is left out, so it is asked about.
        if (
          !element ||
          typeof element.ref !== "string" ||
          !DESKTOP_REF.test(element.ref) ||
          typeof element.type !== "string" ||
          typeof element.name !== "string"
        )
          continue;
        refs.set(element.ref, {
          windowId,
          type: element.type,
          name: element.name,
          ...(element.password === true ? { password: true as const } : {}),
          ...(element.singleLine === true ? { singleLine: true as const } : {}),
        });
      }
      const windows = machines.get(key) ?? new Map<string, Window>();
      machines.delete(key);
      machines.set(key, windows);
      windows.delete(windowId);
      windows.set(windowId, { at: now(), refs });
      // As many windows as the device keeps a snapshot for; the oldest goes first.
      while (windows.size > DESKTOP_LIMITS.snapshotsKept) {
        const oldest = windows.keys().next().value;
        if (oldest === undefined) break;
        windows.delete(oldest);
      }
      while (machines.size > limit) {
        const oldest = machines.keys().next().value;
        if (oldest === undefined) break;
        machines.delete(oldest);
      }
    },
    control(key, ref) {
      const windows = machines.get(key);
      if (!windows || typeof ref !== "string") return undefined;
      for (const [windowId, window] of windows) {
        const entry = window.refs.get(ref);
        if (!entry) continue;
        if (now() - window.at > ttlMs) {
          windows.delete(windowId);
          return undefined;
        }
        return entry;
      }
      return undefined;
    },
    forgetWindow(key, windowId) {
      machines.get(key)?.delete(windowId);
    },
  };
}
