import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Cookie } from "playwright";
import { OLD_PRODUCT_LOWER } from "../../scripts/brand/guard/words";
import * as sessionCookies from "../src/session-cookies";

/**
 * The session-cookie file was renamed, and the window in which both names were read has closed. So a
 * computer that ran a version before the rename still holds its sign-ins under that name, and nothing
 * here asks for them any more: they are not read, not compared by modification time, and not carried
 * across. What is asked for is that the dead file leaves the volume, because a credential-shaped file
 * that no code owns is nobody's to keep (L1-16; the reason of the allowlist entry says the disk file
 * goes with the code). The cases below say both halves — the file of the earlier name goes, its
 * contents restored to no one — and the one thing that must survive that: a volume that will not give
 * the file up, or a directory that cannot even be listed, is said through the log and the browser
 * starts anyway. A Bot's launch is not held up by a cleanup.
 */

const FILE = sessionCookies.SESSION_COOKIES_FILE;
const OLDER_FILE = `${OLD_PRODUCT_LOWER}-session-cookies.json`;

const cookie = (name: string, value: string): Cookie => ({
  name,
  value,
  domain: "example.test",
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
});

const saved = (value: string) =>
  sessionCookies.serialiseSessionCookies([cookie("sid", value)]);
const restored = (cookies: Cookie[]) =>
  cookies.map((c) => `${c.name}=${c.value}`);

/** Just enough of a browser context: what it holds, and what was put back into it. */
function fakeContext() {
  const held: Cookie[] = [];
  const context = {
    cookies: async () => [...held],
    addCookies: async (added: Cookie[]) => {
      held.push(...added);
    },
  } as unknown as BrowserContext;
  return { context, held };
}

const dirs: string[] = [];
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-cookies-rename-"));
  dirs.push(dir);
  return dir;
}

/** The permission bits of a file: the session cookies are credentials and must stay 0600. */
const modeOf = (path: string) => fs.statSync(path).mode & 0o777;

/** What the keeper logged, parsed, with silence meanwhile: counts and a code, never a value. */
function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const spy = spyOn(console, "info").mockImplementation(
    (...args: unknown[]) => {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    },
  );
  return {
    lines,
    of(type: string) {
      return lines.filter((line) => line.type === type);
    },
    stop() {
      spy.mockRestore();
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the renamed file, once its window has closed", () => {
  test("the module names this file alone", () => {
    expect(FILE).toBe("xiongbao-session-cookies.json");
    // No name for the earlier file, and no route to it: what read both went with its window.
    const exported = Object.keys(sessionCookies);
    expect(exported).not.toContain("LEGACY_SESSION_COOKIES_FILE");
    expect(exported).not.toContain("migrateSessionCookiesFile");
    expect(exported).not.toContain("sessionCookiesSource");
  });

  test("cookies saved under the earlier name are not restored, and the file goes", async () => {
    const dir = profile();
    writeFileSync(join(dir, OLDER_FILE), saved("from-before"), {
      mode: 0o600,
    });

    const { context, held } = fakeContext();
    const keeper = sessionCookies.sessionCookieKeeper("bot", dir, context);
    const log = captureLogs();
    let count = -1;
    try {
      count = await keeper.restore();
    } finally {
      log.stop();
    }
    expect(count).toBe(0);
    expect(restored(held)).toEqual([]);
    expect(existsSync(join(dir, OLDER_FILE))).toBe(false);
    // Taken away, not carried forward: nothing was written under this name from it.
    expect(existsSync(join(dir, FILE))).toBe(false);
    expect(log.of("computer-session-cookies-old-file-removed")).toEqual([
      {
        type: "computer-session-cookies-old-file-removed",
        botId: "bot",
        removed: 1,
      },
    ]);
  });

  test("this name is what is read, even when the earlier one was written last", async () => {
    const dir = profile();
    writeFileSync(join(dir, FILE), saved("current"), { mode: 0o600 });
    writeFileSync(join(dir, OLDER_FILE), saved("rollback"), { mode: 0o600 });

    const { context, held } = fakeContext();
    const keeper = sessionCookies.sessionCookieKeeper("bot", dir, context);
    const log = captureLogs();
    let count = -1;
    try {
      count = await keeper.restore();
    } finally {
      log.stop();
    }
    // No modification time is compared: which of the two is newer is nobody's call any more.
    expect(count).toBe(1);
    expect(restored(held)).toEqual(["sid=current"]);
    expect(existsSync(join(dir, OLDER_FILE))).toBe(false);
    expect(readFileSync(join(dir, FILE), "utf8")).toBe(saved("current"));
  });

  test("the earlier file goes, this profile's other files stay", () => {
    const dir = profile();
    writeFileSync(join(dir, OLDER_FILE), saved("from-before"), { mode: 0o600 });
    writeFileSync(join(dir, FILE), saved("current"), { mode: 0o600 });
    /*
     * Two neighbours the ending does not answer to: another file of the profile, and this name with
     * more written after it. The cleanup takes the ending it was given, not a substring of it.
     */
    writeFileSync(join(dir, "xiongbao-storage-state.json"), '{"cookies":[]}');
    writeFileSync(join(dir, `${FILE}.bak`), saved("spare"));

    const log = captureLogs();
    try {
      sessionCookies.removeOlderSessionCookieFiles(dir, "bot");
    } finally {
      log.stop();
    }
    expect(existsSync(join(dir, OLDER_FILE))).toBe(false);
    expect(readFileSync(join(dir, FILE), "utf8")).toBe(saved("current"));
    expect(modeOf(join(dir, FILE))).toBe(0o600);
    expect(existsSync(join(dir, "xiongbao-storage-state.json"))).toBe(true);
    expect(existsSync(join(dir, `${FILE}.bak`))).toBe(true);
    expect(log.of("computer-session-cookies-old-file-not-removed")).toEqual([]);
  });

  test("a profile with nothing stored: nothing is created, and nothing is said", () => {
    const dir = profile();
    const log = captureLogs();
    try {
      expect(() =>
        sessionCookies.removeOlderSessionCookieFiles(dir, "bot"),
      ).not.toThrow();
    } finally {
      log.stop();
    }
    expect(log.lines).toEqual([]);
    expect(existsSync(join(dir, FILE))).toBe(false);
    // A directory that is not there yet has nothing to take: the first launch has no profile.
    expect(() =>
      sessionCookies.removeOlderSessionCookieFiles(
        join(dir, "no-such-profile"),
        "bot",
      ),
    ).not.toThrow();
  });

  test("a volume that refuses the delete is said by its code, and the launch goes on", async () => {
    const dir = profile();
    writeFileSync(join(dir, OLDER_FILE), saved("from-before"), { mode: 0o600 });
    writeFileSync(join(dir, FILE), saved("current"), { mode: 0o600 });
    /*
     * The refusal is given here rather than through permission bits, so the case says the same thing
     * wherever the suite runs: what a read-only volume answers is EROFS, and the bits mean nothing to
     * a suite that runs as root.
     */
    const refused = spyOn(fs, "rmSync").mockImplementation(() => {
      const error = new Error("read-only file system") as NodeJS.ErrnoException;
      error.code = "EROFS";
      throw error;
    });
    const { context, held } = fakeContext();
    const keeper = sessionCookies.sessionCookieKeeper("bot", dir, context);
    const log = captureLogs();
    let count = -1;
    try {
      count = await keeper.restore();
    } finally {
      log.stop();
      refused.mockRestore();
    }
    // The kept file keeps its cookies to itself, and the ones under this name still come back.
    expect(count).toBe(1);
    expect(restored(held)).toEqual(["sid=current"]);
    expect(existsSync(join(dir, OLDER_FILE))).toBe(true);
    expect(log.of("computer-session-cookies-old-file-not-removed")).toEqual([
      {
        type: "computer-session-cookies-old-file-not-removed",
        botId: "bot",
        code: "EROFS",
      },
    ]);
    // Nothing removed, so nothing said of a removal; and one line for the code, not one per file.
    expect(log.of("computer-session-cookies-old-file-removed")).toEqual([]);
  });

  test("a directory that cannot be listed is not a reason to fail the launch", async () => {
    const dir = profile();
    writeFileSync(join(dir, FILE), saved("current"), { mode: 0o600 });
    const unreadable = spyOn(fs, "readdirSync").mockImplementation(() => {
      const error = new Error("input/output error") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });
    const { context, held } = fakeContext();
    const keeper = sessionCookies.sessionCookieKeeper("bot", dir, context);
    const log = captureLogs();
    let count = -1;
    try {
      count = await keeper.restore();
    } finally {
      log.stop();
      unreadable.mockRestore();
    }
    expect(count).toBe(1);
    expect(restored(held)).toEqual(["sid=current"]);
    // Nothing to say about a file it never got as far as looking for.
    expect(log.of("computer-session-cookies-old-file-not-removed")).toEqual([]);
    expect(log.of("computer-session-cookies-old-file-removed")).toEqual([]);
  });

  test("what is saved is written under this name only, still 0600", async () => {
    const dir = profile();
    writeFileSync(join(dir, OLDER_FILE), saved("from-before"), { mode: 0o600 });
    const { context, held } = fakeContext();
    const log = captureLogs();
    const keeper = sessionCookies.sessionCookieKeeper("bot", dir, context);
    try {
      expect(await keeper.restore()).toBe(0);
      held.push(cookie("cart", "two"));
      await keeper.save();
    } finally {
      log.stop();
    }
    expect(readFileSync(join(dir, FILE), "utf8")).toContain("cart");
    expect(modeOf(join(dir, FILE))).toBe(0o600);
    // The one file of the earlier name is gone, so nothing can be read back into it.
    expect(existsSync(join(dir, OLDER_FILE))).toBe(false);
  });
});
