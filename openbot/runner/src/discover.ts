import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { APP_NAME_LIMIT, type AppEntry } from "./apps";
import {
  type ConfigSource,
  type DiscoveredSpec,
  readConfigServers,
  SOURCE_LABELS,
  SOURCE_SHORT,
} from "./discover-configs";
import { installedNames, type UninstallEntry } from "./discover-installed";

/**
 * The apps this Windows machine could offer the owner's 分身 (app discovery, spec §2): what other
 * AI tools already run, deduped, each with a status and an opaque reference, plus the names of the
 * installed programs. Scanned afresh on every call; nothing is remembered between calls.
 *
 * ONLY NAMES LEAVE. A candidate carries its name, where it was found (a fixed Chinese label), its
 * kind, its status with a fixed note, whether it is already registered, and a reference. The command,
 * its arguments, environment values, working folder and the config file's path stay here; the note
 * for a missing program does not even name the program.
 *
 * A REFERENCE IS SIGNED, NOT STORED. `cand_<issued seconds, base 36>_<mac>`, the mac being an
 * HMAC-SHA256 under a key only this machine holds (`runner-discover.key`) over the issue time, the
 * source, the app's identity and its environment and working folder. Any process on this machine
 * (the runner, the device window's command line) can check one by scanning again with the same issue
 * time: a reference older than ten minutes, forged, or for an entry whose environment changed since
 * is simply not found, and the owner is asked to look again.
 */

export const CANDIDATE_TTL_MS = 600_000;
export const MAX_CANDIDATES = 50;
export const CANDIDATE_REF: RegExp = /^cand_[0-9a-z]{1,10}_[A-Za-z0-9_-]{22}$/;
export const DISCOVER_KEY_FILE = "runner-discover.key";
export const CANDIDATE_EXPIRED =
  "这个候选应用已过期或不存在，请重新查看本机应用。";

export type CandidateStatus =
  | "ready"
  | "needs_uv"
  | "missing_command"
  | "unsupported";

export type Candidate = {
  ref: string;
  name: string;
  source: ConfigSource | "catalog";
  sourceLabel: string;
  kind: "stdio" | "http";
  enabled: boolean;
  /** The `app_` reference when an app with the same identity is already registered. */
  app?: string;
  status: CandidateStatus;
  note?: string;
};

export type DiscoverResult = {
  platform: NodeJS.Platform;
  candidates: Candidate[];
  installed: string[];
};

export type DiscoverDeps = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  dataDir: string;
  registry: { list(): AppEntry[] };
  readText: (path: string) => string | undefined;
  readInstalled: () => Promise<UninstallEntry[]>;
  /** The program a bare command runs, or undefined when it is not installed. */
  resolveCommand: (command: string) => string | undefined;
  now: () => number;
};

/** A reference may be at most this far ahead of the clock (another process's clock, a tick). */
const CLOCK_SKEW_MS = 60_000;
const MAC_LENGTH = 22;

const NOTE_VARIABLES = `配置里用到了变量（\${…}），请在设备端「高级：手动添加」里填写实际值`;
const NOTE_FLAGS = "启动参数无法改写为自带运行时，请在「高级：手动添加」里添加";
const NOTE_NEEDS_UV = "需要先安装 uv";
const NOTE_MISSING = "找不到启动这个应用的程序，请先安装它";

/** `npx`, `NPX.CMD` and `C:\…\npx.cmd` are one program. */
function programOf(command: string): string {
  return win32
    .basename(command.trim())
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/, "");
}

/** The arguments after `npx [-y|--yes]…`, `bunx` or `bun x`; undefined for any other command. */
function packageRunnerArgs(
  spec: Extract<DiscoveredSpec, { kind: "stdio" }>,
): string[] | undefined {
  const program = programOf(spec.command);
  if (program === "npx") {
    let i = 0;
    while (spec.args[i] === "-y" || spec.args[i] === "--yes") i += 1;
    return spec.args.slice(i);
  }
  if (program === "bunx") return spec.args;
  if (program === "bun" && spec.args[0] === "x") return spec.args.slice(1);
  return undefined;
}

/**
 * What an app is, for deduplication and for "already registered": a normalised url, or the program
 * and its arguments, with the npm package runners made one. Environment and working folder are not
 * part of it.
 */
export function identityOf(spec: DiscoveredSpec): string {
  if (spec.kind === "http") {
    try {
      return `url:${new URL(spec.url).href}`;
    } catch {
      return `url:${spec.url}`;
    }
  }
  const packaged = packageRunnerArgs(spec);
  if (packaged) return `x:${JSON.stringify(packaged)}`;
  return `cmd:${JSON.stringify([programOf(spec.command), ...spec.args])}`;
}

export function identityOfEntry(entry: AppEntry): string {
  return entry.kind === "http"
    ? identityOf({ kind: "http", url: entry.url })
    : identityOf({
        kind: "stdio",
        command: entry.command,
        args: entry.args,
        env: entry.env,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      });
}

function statusOf(
  spec: DiscoveredSpec,
  resolveCommand: (command: string) => string | undefined,
): { status: CandidateStatus; note?: string } {
  if (spec.kind === "http") return { status: "ready" };
  const strings = [
    spec.command,
    ...spec.args,
    ...Object.values(spec.env),
    ...(spec.cwd === undefined ? [] : [spec.cwd]),
  ];
  if (strings.some((value) => value.includes("${"))) {
    return { status: "unsupported", note: NOTE_VARIABLES };
  }
  const packaged = packageRunnerArgs(spec);
  if (packaged) {
    // Started with the bundled runtime on enable, which only knows the package and its arguments.
    return packaged.length > 0 && !packaged[0]?.startsWith("-")
      ? { status: "ready" }
      : { status: "unsupported", note: NOTE_FLAGS };
  }
  const found = safeResolve(resolveCommand, spec.command);
  const program = programOf(spec.command);
  if (program === "uv" || program === "uvx") {
    return found
      ? { status: "ready" }
      : { status: "needs_uv", note: NOTE_NEEDS_UV };
  }
  return found
    ? { status: "ready" }
    : { status: "missing_command", note: NOTE_MISSING };
}

function safeResolve(
  resolveCommand: (command: string) => string | undefined,
  command: string,
): string | undefined {
  try {
    return resolveCommand(command);
  } catch {
    return undefined;
  }
}

/** Sorted keys, so the same environment always signs the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function macOf(
  key: Buffer,
  issued: number,
  source: string,
  identity: string,
  spec: DiscoveredSpec,
): string {
  const settings =
    spec.kind === "stdio"
      ? canonicalJson({ cwd: spec.cwd ?? null, env: spec.env })
      : "";
  return createHmac("sha256", key)
    .update(`${issued}\n${source}\n${identity}\n${settings}`)
    .digest("base64url")
    .slice(0, MAC_LENGTH);
}

/**
 * This machine's signing key: 32 random bytes beside the token, made on first use and private like
 * it (written to a temporary file renamed into place). Checking a reference only reads
 * (`readKey`): it never makes a key, since no reference could match a new one.
 */
function readKey(dataDir: string): Buffer | undefined {
  try {
    const key = readFileSync(join(dataDir, DISCOVER_KEY_FILE));
    if (key.length === 32) return key;
  } catch {
    // No key yet.
  }
  return undefined;
}

function ensureKey(dataDir: string): Buffer {
  const existing = readKey(dataDir);
  if (existing) return existing;
  const file = join(dataDir, DISCOVER_KEY_FILE);
  mkdirSync(dataDir, { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, randomBytes(32), { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // A filesystem without modes still got a file it created private.
  }
  renameSync(temporary, file);
  // Two processes making a key at once: both use whichever landed last.
  return readFileSync(file);
}

/** A name not yet taken (case-insensitively), within the 40 characters an app's name may have. */
function uniqueName(
  name: string,
  source: ConfigSource,
  taken: Set<string>,
): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 1; ; n += 1) {
    const suffix = `（${SOURCE_SHORT[source]}${n === 1 ? "" : ` ${n}`}）`;
    const room = Math.max(1, APP_NAME_LIMIT - [...suffix].length);
    const candidate = `${[...name].slice(0, room).join("")}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Every candidate as issued at `issued` (seconds), with the spec it stands for. */
function scan(
  deps: DiscoverDeps,
  key: Buffer,
  issued: number,
): { candidate: Candidate; spec: DiscoveredSpec; mac: string }[] {
  const registered = new Map<string, AppEntry>();
  let apps: AppEntry[] = [];
  try {
    apps = deps.registry.list();
  } catch {
    // An unreadable registry: nothing is shown as registered.
  }
  for (const app of apps) {
    const identity = identityOfEntry(app);
    if (!registered.has(identity)) registered.set(identity, app);
  }

  const seen = new Set<string>();
  const taken = new Set<string>();
  const out: { candidate: Candidate; spec: DiscoveredSpec; mac: string }[] = [];
  for (const found of readConfigServers({
    env: deps.env,
    readText: deps.readText,
  })) {
    if (out.length >= MAX_CANDIDATES) break;
    const identity = identityOf(found.spec);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const name = uniqueName(found.name, found.source, taken);
    taken.add(name.toLowerCase());
    const mac = macOf(key, issued, found.source, identity, found.spec);
    const app = registered.get(identity);
    out.push({
      candidate: {
        ref: `cand_${issued.toString(36)}_${mac}`,
        name,
        source: found.source,
        sourceLabel: SOURCE_LABELS[found.source],
        kind: found.spec.kind,
        enabled: app?.enabled ?? false,
        ...(app ? { app: app.ref } : {}),
        ...statusOf(found.spec, deps.resolveCommand),
      },
      spec: found.spec,
      mac,
    });
  }
  return out;
}

export async function discoverApps(
  deps: DiscoverDeps,
): Promise<DiscoverResult> {
  if (deps.platform !== "win32") {
    return { platform: deps.platform, candidates: [], installed: [] };
  }
  const installed = (async () => {
    try {
      return installedNames(await deps.readInstalled());
    } catch {
      return [];
    }
  })();
  const key = ensureKey(deps.dataDir);
  const issued = Math.floor(deps.now() / 1000);
  const candidates = scan(deps, key, issued).map(({ candidate }) => candidate);
  return { platform: deps.platform, candidates, installed: await installed };
}

/** The candidate a reference was issued for, as this machine's config says now, or why not. */
export async function findCandidate(
  deps: DiscoverDeps,
  ref: string,
): Promise<{ candidate: Candidate; spec: DiscoveredSpec } | { error: string }> {
  const expired = { error: CANDIDATE_EXPIRED };
  if (deps.platform !== "win32" || !CANDIDATE_REF.test(ref)) return expired;
  // The mac is base64url and may itself hold `_`: it is the last 22 characters, after one `_`.
  const encoded = ref.slice("cand_".length, -(MAC_LENGTH + 1));
  const mac = ref.slice(-MAC_LENGTH);
  const issued = Number.parseInt(encoded, 36);
  // One spelling per second, so a reference cannot be re-dated by writing the same time differently.
  if (!Number.isSafeInteger(issued) || issued.toString(36) !== encoded) {
    return expired;
  }
  const now = deps.now();
  if (
    issued * 1000 < now - CANDIDATE_TTL_MS ||
    issued * 1000 > now + CLOCK_SKEW_MS
  ) {
    return expired;
  }
  const key = readKey(deps.dataDir);
  if (!key) return expired;
  const wanted = Buffer.from(mac);
  let match: { candidate: Candidate; spec: DiscoveredSpec } | undefined;
  for (const item of scan(deps, key, issued)) {
    const actual = Buffer.from(item.mac);
    if (
      actual.length === wanted.length &&
      timingSafeEqual(actual, wanted) &&
      !match
    ) {
      match = { candidate: item.candidate, spec: item.spec };
    }
  }
  return match ?? expired;
}
