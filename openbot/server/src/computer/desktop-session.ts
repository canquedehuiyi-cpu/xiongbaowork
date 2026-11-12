import { randomBytes } from "node:crypto";
import {
  DESKTOP_LIMITS,
  type DesktopPlatform,
} from "../../../shared/desktop-control";

/**
 * The desktop session as this server replica knows it (desktop write, phase 2; plan design
 * decision 5).
 *
 * THE DEVICE IS AUTHORITATIVE. The server mints a token once the owner approved opening a session,
 * hands it to the device with `desktop.session_start`, and every write carries it. The device keeps
 * exactly one session and ends it itself (15 minutes idle, 60 minutes in all, the owner's stop). Each
 * replica only remembers, in memory, the token it minted or learned from the device; a replica that
 * has none asks the device (`desktop.session_status`), and a device that has none means asking the
 * owner again. Nothing here is written to the database, a row or an approval.
 *
 * The token is a credential for the owner's screen: never logged, never put in an audit row, an
 * approval request or an error message.
 */

/** What `desktop.session_status` answers. `session` only when the device could be written to. */
export type DesktopSessionStatus = {
  writable: boolean;
  reason?: string;
  platform?: DesktopPlatform;
  session?: { token: string };
};

export type DesktopSessionCache = {
  /** The token for `key`, or undefined when there is none or it is past idle or total time. */
  get(key: string): string | undefined;
  /** A session just opened (or learned from the device): its clock starts now. */
  set(key: string, token: string): void;
  /** A write in the session: the idle clock starts again. The total clock does not. */
  touch(key: string): void;
  drop(key: string): void;
};

/** Sessions remembered per replica; the oldest is dropped beyond this. */
export const DESKTOP_SESSIONS_CACHE_LIMIT = 1000;

/** A session token as the device accepts it: `randomBytes(32)` in hex. */
export const DESKTOP_SESSION_TOKEN = /^[0-9a-f]{64}$/;

/** One session per owner's machine, Bot and person. */
export function desktopSessionKey(
  machine: { tenantId: string; deviceId: string },
  botId: string,
  actorId: string,
): string {
  return `${machine.tenantId}/${machine.deviceId}/${botId}/${actorId}`;
}

export function createDesktopSessionCache(
  opts: { now?: () => number } = {},
): DesktopSessionCache {
  const now = opts.now ?? Date.now;
  // A Map iterates in insertion order, so its first key is always the oldest session.
  const sessions = new Map<
    string,
    { token: string; started: number; used: number }
  >();
  const live = (key: string) => {
    const entry = sessions.get(key);
    if (!entry) return undefined;
    const at = now();
    if (
      at - entry.used > DESKTOP_LIMITS.sessionIdleMs ||
      at - entry.started > DESKTOP_LIMITS.sessionMaxMs
    ) {
      sessions.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    get: (key) => live(key)?.token,
    set(key, token) {
      const at = now();
      sessions.delete(key);
      sessions.set(key, { token, started: at, used: at });
      while (sessions.size > DESKTOP_SESSIONS_CACHE_LIMIT) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
    touch(key) {
      const entry = live(key);
      if (entry) entry.used = now();
    },
    drop(key) {
      sessions.delete(key);
    },
  };
}

/** A new session token: 32 random bytes, in hex. */
export function mintDesktopSessionToken(): string {
  return randomBytes(32).toString("hex");
}
