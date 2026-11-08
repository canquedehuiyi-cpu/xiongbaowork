import type { DesktopWindow } from "../../../shared/desktop-control";

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
