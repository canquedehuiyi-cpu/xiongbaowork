import { createHash } from "node:crypto";
import { sign, verify } from "../auth/signed-value";

/**
 * How long an "open" link and a content session stay good: thirty minutes from when they were made.
 * A session is renewed (see {@link renewedGrant}) while somebody keeps using it.
 */
export const OPEN_TOKEN_TTL_MS = 30 * 60_000;

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
};

/*
 * Two labels, so a value made for one use is refused by the other: the one-time link a person
 * clicks must not double as the cookie that keeps them in, nor the cookie as a new link.
 */
const OPEN_LABEL = "content-open";
const SESSION_LABEL = "content-session";

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

/** The same grant, good for another {@link OPEN_TOKEN_TTL_MS} from `now`. */
export function renewedGrant(grant: ContentGrant, now: number): ContentGrant {
  return { ...grant, exp: now + OPEN_TOKEN_TTL_MS };
}

/**
 * The subdomain a grant's pages are served from in domain mode: sixteen lowercase hex characters of
 * a hash over person, Bot and target, so two people, two Bots or two sites never share an origin.
 * The target is written with a fixed key order, so equal targets always give equal codes.
 */
export function hostCodeOf(grant: ContentGrant): string {
  const target =
    grant.target.kind === "dir"
      ? { kind: "dir", path: grant.target.path }
      : { kind: "app", port: grant.target.port, path: grant.target.path };
  return createHash("sha256")
    .update(`${grant.person}|${grant.bot}|${JSON.stringify(target)}`)
    .digest("hex")
    .slice(0, 16);
}
