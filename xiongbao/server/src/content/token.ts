import { createHash } from "node:crypto";
import { sign, verify } from "../auth/signed-value";

/**
 * How long an "open" link and a content session stay good: thirty minutes from when they were made.
 * A session is renewed (see {@link renewedWithinCap}) while somebody keeps using it.
 */
export const OPEN_TOKEN_TTL_MS = 30 * 60_000;

/**
 * The longest a chain of renewals may last, counted from the first time a link was issued
 * (`ContentGrant.born`). Renewal keeps an active session alive; it must never make one immortal.
 */
export const MAX_SESSION_AGE_MS = 12 * 60 * 60_000;

/** What a grant lets a browser look at: a folder of a Bot's files, or a web app on a local port. */
export type ContentTarget =
  | { kind: "dir"; path: string }
  | { kind: "app"; port: number; path: string };

/** Who may look at what, until when. The same shape travels in the open token and in the cookie. */
export type ContentGrant = {
  person: string;
  bot: string;
  seat: string;
  channel?: string;
  run?: string;
  task?: string;
  target: ContentTarget;
  /** Epoch milliseconds. A grant is dead at this instant, not after it. */
  exp: number;
  /**
   * Epoch milliseconds of the first issue, carried unchanged through every renewal; the absolute
   * lifetime ({@link MAX_SESSION_AGE_MS}) counts from here. Absent on a value made before the field
   * existed, which is then read as born one lifetime before it expires.
   */
  born?: number;
};

/** When this grant was first issued. */
export const bornOf = (grant: ContentGrant): number =>
  grant.born ?? grant.exp - OPEN_TOKEN_TTL_MS;

/*
 * Two labels, so a value made for one use is refused by the other: the one-time link a person
 * clicks must not double as the cookie that keeps them in, nor the cookie as a new link.
 */
const OPEN_LABEL = "content-open";
const SESSION_LABEL = "content-session";
// A third one, for the token inside a page's own path: it is visible in the address bar and in the
// history, so it must not also be a cookie (a copied path token would renew itself for ever).
const PATH_LABEL = "content-path";

function issue(grant: ContentGrant, key: string, label: string): string {
  return sign(
    Buffer.from(JSON.stringify(grant), "utf8").toString("base64url"),
    key,
    label,
  );
}

const isString = (value: unknown): value is string => typeof value === "string";

function readTarget(value: unknown): ContentTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const target = value as Record<string, unknown>;
  if (!isString(target.path)) return null;
  if (target.kind === "dir") return { kind: "dir", path: target.path };
  if (target.kind === "app") {
    const port = target.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535
    ) {
      return null;
    }
    return { kind: "app", port, path: target.path };
  }
  return null;
}

/** The grant a signed string carries, or null for any way of not being one. Never throws. */
function read(
  token: string | undefined,
  key: string,
  label: string,
  now: number,
): ContentGrant | null {
  try {
    const body = verify(token, key, label);
    if (body === null) return null;
    const parsed: unknown = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const raw = parsed as Record<string, unknown>;
    if (!isString(raw.person) || !isString(raw.bot) || !isString(raw.seat)) {
      return null;
    }
    for (const optional of [raw.channel, raw.run, raw.task]) {
      if (optional !== undefined && !isString(optional)) return null;
    }
    if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp)) return null;
    if (raw.exp <= now) return null;
    if (
      raw.born !== undefined &&
      (typeof raw.born !== "number" || !Number.isFinite(raw.born))
    ) {
      return null;
    }
    const target = readTarget(raw.target);
    if (target === null) return null;
    return {
      person: raw.person,
      bot: raw.bot,
      seat: raw.seat,
      ...(raw.channel !== undefined ? { channel: raw.channel as string } : {}),
      ...(raw.run !== undefined ? { run: raw.run as string } : {}),
      ...(raw.task !== undefined ? { task: raw.task as string } : {}),
      target,
      exp: raw.exp,
      ...(raw.born !== undefined ? { born: raw.born as number } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The one-time link value. `key` is the deployment's encryption key (`config.keyEncryptionKey`);
 * a signature here is derived under its own label and cannot be passed off as any other signed value.
 */
export function issueOpenToken(grant: ContentGrant, key: string): string {
  return issue(grant, key, OPEN_LABEL);
}

export function readOpenToken(
  token: string | undefined,
  key: string,
  now: number,
): ContentGrant | null {
  return read(token, key, OPEN_LABEL, now);
}

/** The cookie value that follows a successful open. Same shape, the other label. */
export function issueSessionToken(grant: ContentGrant, key: string): string {
  return issue(grant, key, SESSION_LABEL);
}

export function readSessionToken(
  token: string | undefined,
  key: string,
  now: number,
): ContentGrant | null {
  return read(token, key, SESSION_LABEL, now);
}

/** The cookie's twin for a page's own path: `/u/<token>/`. Its own label, so it is no cookie. */
export function issuePathToken(grant: ContentGrant, key: string): string {
  return issue(grant, key, PATH_LABEL);
}

export function readPathToken(
  token: string | undefined,
  key: string,
  now: number,
): ContentGrant | null {
  return read(token, key, PATH_LABEL, now);
}

/**
 * What a path token says even after it has expired, for one purpose: recognising the page a person
 * had open, so a still-valid cookie can carry them back to it. The signature is checked, the expiry is
 * not. Never a credential on its own.
 */
export function readExpiredPathToken(
  token: string | undefined,
  key: string,
): ContentGrant | null {
  return read(token, key, PATH_LABEL, Number.NEGATIVE_INFINITY);
}

/**
 * The grant renewed from `now`, or null when it has lived its absolute lifetime. The new expiry never
 * passes `born + MAX_SESSION_AGE_MS`, so the last renewal is a short one, not a long one.
 */
export function renewedWithinCap(
  grant: ContentGrant,
  now: number,
): ContentGrant | null {
  const born = bornOf(grant);
  if (now - born > MAX_SESSION_AGE_MS) return null;
  return {
    ...grant,
    born,
    exp: Math.min(now + OPEN_TOKEN_TTL_MS, born + MAX_SESSION_AGE_MS),
  };
}

/**
 * The subdomain a grant's pages are served from in domain mode: sixteen lowercase hex characters of
 * a hash over the JSON of [person, Bot, target] (not a joined string, so no choice of values can collide through a separator), so two people, two Bots or two sites never share an origin.
 * The target is written with a fixed key order, so equal targets always give equal codes.
 */
export function hostCodeOf(grant: ContentGrant): string {
  const target =
    grant.target.kind === "dir"
      ? { kind: "dir", path: grant.target.path }
      : { kind: "app", port: grant.target.port, path: grant.target.path };
  return createHash("sha256")
    .update(JSON.stringify([grant.person, grant.bot, target]))
    .digest("hex")
    .slice(0, 16);
}
