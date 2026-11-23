import { describe, expect, test } from "bun:test";
import { sign } from "../src/auth/signed-value";
import {
  type ContentGrant,
  hostCodeOf,
  issueOpenToken,
  issueSessionToken,
  OPEN_TOKEN_TTL_MS,
  readOpenToken,
  readSessionToken,
  renewedGrant,
} from "../src/content/token";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const now = 1_800_000_000_000;
const grant: ContentGrant = {
  person: "person-1",
  bot: "bot-1",
  seat: "seat-1",
  target: { kind: "dir", path: "site/index.html" },
  exp: now + OPEN_TOKEN_TTL_MS,
};
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const signedOpen = (value: unknown) => sign(b64(value), KEY, "content-open");

describe("open token", () => {
  test("reads back until 30 minutes, then not", () => {
    const t = issueOpenToken(grant, KEY);
    expect(readOpenToken(t, KEY, now + OPEN_TOKEN_TTL_MS - 1)).toEqual(grant);
    expect(readOpenToken(t, KEY, now + OPEN_TOKEN_TTL_MS - 1)?.bot).toBe(
      "bot-1",
    );
    expect(readOpenToken(t, KEY, now + OPEN_TOKEN_TTL_MS)).toBeNull();
    expect(readOpenToken(t, KEY, now + OPEN_TOKEN_TTL_MS + 1)).toBeNull();
  });

  test("keeps optional fields and an app target", () => {
    const full: ContentGrant = {
      ...grant,
      channel: "c",
      run: "r",
      task: "t",
      target: { kind: "app", port: 5173, path: "/x" },
    };
    expect(readOpenToken(issueOpenToken(full, KEY), KEY, now)).toEqual(full);
  });

  test("another key, an edited body, or the session label is rejected", () => {
    const t = issueOpenToken(grant, KEY);
    expect(readOpenToken(t, `${KEY}x`, now)).toBeNull();
    const [body, signature] = t.split(".");
    const edited = b64({ ...grant, bot: "bot-2" });
    expect(readOpenToken(`${edited}.${signature}`, KEY, now)).toBeNull();
    expect(body).toBeTruthy();
    expect(readOpenToken(issueSessionToken(grant, KEY), KEY, now)).toBeNull();
  });

  test("the two labels are not interchangeable", () => {
    const s = issueSessionToken(grant, KEY);
    expect(readSessionToken(s, KEY, now)).toEqual(grant);
    expect(readSessionToken(issueOpenToken(grant, KEY), KEY, now)).toBeNull();
    expect(readSessionToken(s, KEY, now + OPEN_TOKEN_TTL_MS)).toBeNull();
  });

  test("anything unreadable is null and never throws", () => {
    const bad: unknown[] = [
      undefined,
      "",
      "garbage",
      ".",
      "a.b",
      sign("not-base64-json!!", KEY, "content-open"),
      sign(Buffer.from("{oops").toString("base64url"), KEY, "content-open"),
      signedOpen(null),
      signedOpen([]),
      signedOpen("text"),
      signedOpen({ ...grant, person: undefined }),
      signedOpen({ ...grant, bot: 1 }),
      signedOpen({ ...grant, seat: undefined }),
      signedOpen({ ...grant, exp: "soon" }),
      signedOpen({ ...grant, exp: undefined }),
      signedOpen({ ...grant, exp: Number.NaN }),
      signedOpen({ ...grant, channel: 5 }),
      signedOpen({ ...grant, target: undefined }),
      signedOpen({ ...grant, target: { kind: "file", path: "x" } }),
      signedOpen({ ...grant, target: { kind: "dir", path: 1 } }),
      signedOpen({ ...grant, target: { kind: "app", port: 80, path: "/" } }),
      signedOpen({ ...grant, target: { kind: "app", port: 70000, path: "/" } }),
      signedOpen({
        ...grant,
        target: { kind: "app", port: 3000.5, path: "/" },
      }),
      signedOpen({
        ...grant,
        target: { kind: "app", port: "3000", path: "/" },
      }),
      signedOpen({ ...grant, target: { kind: "app", port: 3000 } }),
    ];
    for (const value of bad) {
      expect(readOpenToken(value as string | undefined, KEY, now)).toBeNull();
    }
  });
});

describe("renewedGrant and hostCodeOf", () => {
  test("renews the expiry from now and nothing else", () => {
    const later = now + 5 * 60_000;
    expect(renewedGrant(grant, later)).toEqual({
      ...grant,
      exp: later + OPEN_TOKEN_TTL_MS,
    });
  });

  test("the host code is 16 lowercase hex, stable, and depends on person, bot and target only", () => {
    const code = hostCodeOf(grant);
    expect(code).toMatch(/^[0-9a-f]{16}$/);
    expect(hostCodeOf({ ...grant, exp: 1, seat: "other", run: "r" })).toBe(
      code,
    );
    expect(hostCodeOf({ ...grant, person: "p2" })).not.toBe(code);
    expect(hostCodeOf({ ...grant, bot: "b2" })).not.toBe(code);
    expect(
      hostCodeOf({ ...grant, target: { kind: "dir", path: "other" } }),
    ).not.toBe(code);
    expect(
      hostCodeOf({ ...grant, target: { kind: "app", port: 5173, path: "x" } }),
    ).not.toBe(code);
  });
});
