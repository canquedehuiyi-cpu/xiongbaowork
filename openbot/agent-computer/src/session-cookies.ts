/**
 * Session cookies, kept across a restart of the computer.
 *
 * Chromium writes a cookie with an expiry into the profile and drops a cookie without one when it
 * exits, exactly as a desktop browser does. On a desktop that is a browser being closed. Here it is
 * a pod being deleted, which is what an idle computer being suspended, a node being drained and an
 * image being updated all are, so every site that signs a person in with a session cookie alone
 * asked the Bot to sign in again after each of them. A Bot's sign-ins are meant to persist between
 * tasks, and a suspended computer is meant to be hibernating rather than gone.
 *
 * So the session cookies are written to a file in the Bot's own profile directory, and put back
 * before the first navigation of the next launch. Only session cookies: the ones with an expiry are
 * already in the profile, and writing them twice would give two sources of truth for one cookie.
 *
 * WHERE IT LIVES IS THE ISOLATION AND THE RESET. The file is inside the Bot's profile directory, so
 * it is on the same volume as the rest of its logins, no other Bot's launch reads it, and a reset
 * that deletes the profile deletes it too. It is written 0600, the same protection the profile's
 * own Cookies database has on that volume.
 *
 * Imports Playwright's types only, so the rules here are testable without a browser installed.
 */

import { renameSync, statSync } from "node:fs";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Cookie } from "playwright";

/** In the profile directory, beside the Cookies database Chromium keeps there itself. */
export const SESSION_COOKIES_FILE = "xiongbao-session-cookies.json";

/**
 * The name the file had before L1-16, still on the volumes of computers that ran an earlier version,
 * and written again by an earlier version a computer is rolled back to. Renamed to
 * `SESSION_COOKIES_FILE` before the first read (`migrateSessionCookiesFile`), and read in place where
 * it cannot be renamed. Goes when the rename does (legacy-compat in the brand allowlist).
 */
export const LEGACY_SESSION_COOKIES_FILE = "openbot-session-cookies.json";

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Which of a profile's two names holds the cookies to restore: the one written last. Usually that is
 * the current name. It is the earlier name when only that file is there (written before the upgrade),
 * or when it was written after the current one: a computer upgraded, rolled back to a version that
 * writes only the earlier name, and upgraded again, whose sessions saved while rolled back are in it.
 * The current name wins a tie.
 */
function sessionCookiesSource(dir: string): string {
  const file = join(dir, SESSION_COOKIES_FILE);
  const legacy = join(dir, LEGACY_SESSION_COOKIES_FILE);
  const legacyAt = modifiedAt(legacy);
  if (legacyAt === undefined) return file;
  const fileAt = modifiedAt(file);
  return fileAt === undefined || legacyAt > fileAt ? legacy : file;
}

/**
 * Give a profile's session-cookie file its current name, once: when the file under the earlier name is
 * the one written last (`sessionCookiesSource`), it is renamed over the current name; otherwise both
 * are left as they are. A rename keeps the file's 0600. A volume that cannot be written keeps the
 * earlier name, and `restore` reads it there; nothing is thrown, because a Bot's browser must still start.
 */
export function migrateSessionCookiesFile(dir: string): void {
  const file = join(dir, SESSION_COOKIES_FILE);
  const source = sessionCookiesSource(dir);
  if (source === file) return;
  try {
    renameSync(source, file);
  } catch {
    // Read-only, or gone in between: `restore` reads whichever name holds the newer file.
  }
}

/** How often a running browser's session cookies are checked and, when they changed, written. */
export const SESSION_COOKIE_SAVE_MS = 30_000;

/** Playwright reports a cookie with no expiry as `expires: -1`. */
export function isSessionCookie(cookie: Cookie): boolean {
  return cookie.expires === -1 || cookie.expires === undefined;
}

const keyOf = (cookie: Pick<Cookie, "name" | "domain" | "path">) =>
  `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;

/**
 * The saved session cookies that should go back into a browser that has just started.
 *
 * Never one the browser already holds: a cookie with the same name, domain and path came from the
 * profile, and the profile is the more recent of the two. Never one with an expiry that has passed,
 * which cannot come from this file's own writes but can come from a file written by hand.
 */
export function cookiesToRestore(
  saved: Cookie[],
  present: Cookie[],
  nowSeconds: number,
): Cookie[] {
  const held = new Set(present.map(keyOf));
  return saved.filter(
    (cookie) =>
      !held.has(keyOf(cookie)) &&
      (isSessionCookie(cookie) || cookie.expires > nowSeconds),
  );
}

/** What the file holds for a set of cookies, stable so an unchanged set compares equal. */
export function serialiseSessionCookies(cookies: Cookie[]): string {
  const session = cookies
    .filter(isSessionCookie)
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return JSON.stringify({ version: 1, cookies: session });
}

function parseSaved(raw: string): Cookie[] {
  const parsed = JSON.parse(raw) as { cookies?: unknown };
  if (!Array.isArray(parsed.cookies)) return [];
  return parsed.cookies.filter(
    (cookie): cookie is Cookie =>
      typeof cookie === "object" &&
      cookie !== null &&
      typeof (cookie as Cookie).name === "string" &&
      typeof (cookie as Cookie).value === "string" &&
      typeof (cookie as Cookie).domain === "string" &&
      typeof (cookie as Cookie).path === "string",
  );
}

/** Counts and a reason only. A cookie's value is a credential and never reaches a log. */
function report(type: string, botId: string, detail: Record<string, unknown>) {
  console.info(JSON.stringify({ type, botId, ...detail }));
}

/**
 * Save and restore for one Bot's running browser.
 *
 * `save` is safe to call from a timer, a close and a shutdown at once: writes are chained, so two
 * never interleave into one file, and one that finds nothing changed writes nothing.
 */
export function sessionCookieKeeper(
  botId: string,
  profileDir: string,
  context: BrowserContext,
) {
  const file = join(profileDir, SESSION_COOKIES_FILE);
  let lastWritten: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  const writeNow = async (): Promise<void> => {
    let cookies: Cookie[];
    try {
      cookies = await context.cookies();
    } catch {
      // The browser has gone. What it last had is what the file already holds.
      return;
    }
    const body = serialiseSessionCookies(cookies);
    if (body === lastWritten) return;
    /*
     * Written beside the file and renamed over it, so a pod killed mid-write leaves the previous
     * file rather than half of one. Created 0600 and set 0600 again, because `mode` only applies to
     * a file that did not exist and a rename keeps the temporary file's permissions.
     */
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      lastWritten = body;
    } catch (error) {
      // A profile deleted by a reset lands here, and that is the reset working.
      await rm(temporary, { force: true }).catch(() => undefined);
      report("computer-session-cookies-not-saved", botId, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const save = (): Promise<void> => {
    chain = chain.then(writeNow, writeNow);
    return chain;
  };

  return {
    /**
     * Put the saved session cookies back. Called before the first navigation, so the first request
     * a site sees from this launch already carries them.
     */
    async restore(): Promise<number> {
      migrateSessionCookiesFile(profileDir);
      let saved: Cookie[];
      try {
        // The current name, or the earlier one where it is newer and could not be renamed.
        saved = parseSaved(
          await readFile(sessionCookiesSource(profileDir), "utf8"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          report("computer-session-cookies-not-restored", botId, {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        return 0;
      }
      const restoring = cookiesToRestore(
        saved,
        await context.cookies(),
        Date.now() / 1000,
      );
      if (restoring.length > 0) await context.addCookies(restoring);
      // What the browser now holds is what the file says, so the first timer tick has nothing to do.
      lastWritten = serialiseSessionCookies(await context.cookies());
      if (restoring.length > 0) {
        report("computer-session-cookies-restored", botId, {
          count: restoring.length,
        });
      }
      return restoring.length;
    },

    save,

    /** Check every interval while the browser runs. The timer never holds the process open. */
    start(intervalMs = SESSION_COOKIE_SAVE_MS): void {
      if (timer) return;
      timer = setInterval(() => {
        void save();
      }, intervalMs);
      timer.unref?.();
    },

    /** Stop the timer and wait for any write in flight, so nothing is written after a reset's delete. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}

export type SessionCookieKeeper = ReturnType<typeof sessionCookieKeeper>;
