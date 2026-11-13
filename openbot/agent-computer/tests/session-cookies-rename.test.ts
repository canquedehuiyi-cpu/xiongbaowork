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
import {
  LEGACY_SESSION_COOKIES_FILE,
  migrateSessionCookiesFile,
  SESSION_COOKIES_FILE,
  serialiseSessionCookies,
  sessionCookieKeeper,
} from "../src/session-cookies";

/**
 * The session-cookie file is renamed once, on the first read after an upgrade (L1-16; spec 4.2: files on
 * disk are renamed once at start-up). A Bot's sign-ins saved under the old name are still there after the
 * upgrade, a file already under the new name wins, and a profile on a volume that cannot be written is
 * read under the old name rather than failing.
 */

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

const quiet = () => spyOn(console, "info").mockImplementation(() => undefined);

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the session-cookie file is renamed once", () => {
  test("the file names", () => {
    expect(SESSION_COOKIES_FILE).toBe("xiongbao-session-cookies.json");
    expect(LEGACY_SESSION_COOKIES_FILE).toBe("openbot-session-cookies.json");
  });

  test("only the old file: it is renamed, and its cookies come back", async () => {
    const dir = profile();
    const body = serialiseSessionCookies([cookie("sid", "from-before")]);
    writeFileSync(join(dir, LEGACY_SESSION_COOKIES_FILE), body, {
      mode: 0o600,
    });

    migrateSessionCookiesFile(dir);
    expect(existsSync(join(dir, LEGACY_SESSION_COOKIES_FILE))).toBe(false);
    expect(readFileSync(join(dir, SESSION_COOKIES_FILE), "utf8")).toBe(body);

    // And the keeper, which renames before its first read, puts them back.
    const again = profile();
    writeFileSync(join(again, LEGACY_SESSION_COOKIES_FILE), body, {
      mode: 0o600,
    });
    const { context, held } = fakeContext();
    const log = quiet();
    try {
      expect(await sessionCookieKeeper("bot", again, context).restore()).toBe(
        1,
      );
    } finally {
      log.mockRestore();
    }
    expect(held.map((c) => `${c.name}=${c.value}`)).toEqual([
      "sid=from-before",
    ]);
    expect(existsSync(join(again, LEGACY_SESSION_COOKIES_FILE))).toBe(false);
    expect(readFileSync(join(again, SESSION_COOKIES_FILE), "utf8")).toBe(body);
  });

  test("both files: the new one is used and the old one is left alone", async () => {
    const dir = profile();
    const before = serialiseSessionCookies([cookie("sid", "old")]);
    const now = serialiseSessionCookies([cookie("sid", "new")]);
    writeFileSync(join(dir, LEGACY_SESSION_COOKIES_FILE), before);
    writeFileSync(join(dir, SESSION_COOKIES_FILE), now);

    migrateSessionCookiesFile(dir);
    expect(readFileSync(join(dir, LEGACY_SESSION_COOKIES_FILE), "utf8")).toBe(
      before,
    );
    expect(readFileSync(join(dir, SESSION_COOKIES_FILE), "utf8")).toBe(now);

    const { context, held } = fakeContext();
    const log = quiet();
    try {
      await sessionCookieKeeper("bot", dir, context).restore();
    } finally {
      log.mockRestore();
    }
    expect(held.map((c) => `${c.name}=${c.value}`)).toEqual(["sid=new"]);
    expect(readFileSync(join(dir, LEGACY_SESSION_COOKIES_FILE), "utf8")).toBe(
      before,
    );
  });

  test("a directory that cannot be written: the old file is read, and nothing throws", async () => {
    const dir = profile();
    const body = serialiseSessionCookies([cookie("sid", "read-only")]);
    writeFileSync(join(dir, LEGACY_SESSION_COOKIES_FILE), body);
    chmodSync(dir, 0o500);
    /*
     * Root ignores the permission bits, so where the suite runs as root the refusal a read-only
     * volume gives is given here instead.
     */
    const refuse =
      process.getuid?.() === 0
        ? spyOn(fs, "renameSync").mockImplementation(() => {
            throw Object.assign(new Error("read-only file system"), {
              code: "EROFS",
            });
          })
        : undefined;
    const { context, held } = fakeContext();
    const log = quiet();
    try {
      expect(() => migrateSessionCookiesFile(dir)).not.toThrow();
      expect(await sessionCookieKeeper("bot", dir, context).restore()).toBe(1);
    } finally {
      refuse?.mockRestore();
      log.mockRestore();
    }
    expect(held.map((c) => `${c.name}=${c.value}`)).toEqual(["sid=read-only"]);
    expect(existsSync(join(dir, SESSION_COOKIES_FILE))).toBe(false);
    expect(readFileSync(join(dir, LEGACY_SESSION_COOKIES_FILE), "utf8")).toBe(
      body,
    );
  });

  test("neither file: nothing to restore, and nothing is created", async () => {
    const dir = profile();
    migrateSessionCookiesFile(dir);
    const { context } = fakeContext();
    expect(await sessionCookieKeeper("bot", dir, context).restore()).toBe(0);
    expect(existsSync(join(dir, SESSION_COOKIES_FILE))).toBe(false);
  });
});
