import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { APP_NAME_LIMIT, type AppEntry } from "./apps";
import { packageRunnerArgs, programOf, toBundledArgs } from "./bundled-runtime";
import {
  type CatalogEntry,
  type CatalogFound,
  defaultCatalogExists,
  defaultCatalogProbe,
  matchCatalog,
  SHIPPED_CATALOG,
} from "./discover-catalog";
import {
  type ConfigSource,
  type DiscoveredSpec,
  type FoundServer,
  readConfigServers,
  SOURCE_LABELS,
  SOURCE_SHORT,
} from "./discover-configs";
import {
  allInstalledNames,
  INSTALLED_LIMIT,
  type UninstallEntry,
} from "./discover-installed";

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
/** Why discovery could not run, without the folder it tried (the owner's name is in that path). */
export const DISCOVER_KEY_FAILED =
  "本机应用发现暂时无法使用（无法保存签名密钥）。";

/** A refusal whose message may be shown and sent as it stands: fixed Chinese, no local path. */
export class DiscoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverError";
  }
}

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
  /** The built-in catalogue; the one compiled into the runner unless a test brings its own. */
  catalog?: CatalogEntry[];
  /** Whether a file exists, for the catalogue's `paths`. */
  exists?: (path: string) => boolean;
  /** Whether a loopback url answers an MCP `initialize`, for the catalogue's `port`. */
  probe?: (url: string) => Promise<boolean>;
};

/** A reference may be at most this far ahead of the clock (another process's clock, a tick). */
const CLOCK_SKEW_MS = 60_000;
const MAC_LENGTH = 22;

const NOTE_VARIABLES = `配置里用到了变量（\${…}），请在设备端「高级：手动添加」里填写实际值`;
const NOTE_FLAGS = "启动参数无法改写为自带运行时，请在「高级：手动添加」里添加";
const NOTE_NEEDS_UV = "需要先安装 uv";
const NOTE_MISSING = "找不到启动这个应用的程序，请先安装它";

/** Switches cmd may take before `/c` that change nothing about what it runs. */
const CMD_QUIET_SWITCHES = new Set(["/d", "/s", "/q"]);

/**
 * The command `cmd [/d /s /q] /c|/k <command> <args…>` runs, which is how many Windows configs work
 * around `spawn npx ENOENT`. Looked through so `cmd /c npx -y pkg` is the same app as `npx -y pkg`:
 * deduped with it, judged by the same rules, and started with the bundled runtime when enabled.
 * Anything else, including `cmd` without `/c` or `/k`, is returned as it is.
 */
function unwrapShell(spec: DiscoveredSpec): DiscoveredSpec {
  let current = spec;
  while (current.kind === "stdio" && programOf(current.command) === "cmd") {
    let i = 0;
    while (CMD_QUIET_SWITCHES.has(current.args[i]?.toLowerCase() ?? "")) i += 1;
    const run = current.args[i]?.toLowerCase();
    const inner = current.args[i + 1]?.trim();
    if ((run !== "/c" && run !== "/k") || !inner) return current;
    current = { ...current, command: inner, args: current.args.slice(i + 2) };
  }
  return current;
}

/**
 * What an app is, for deduplication and for "already registered": a normalised url, or the program
 * and its arguments, with `cmd /c` looked through and the npm package runners made one. Environment
 * and working folder are not part of it.
 */
export function identityOf(given: DiscoveredSpec): string {
  const spec = unwrapShell(given);
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
  if (packageRunnerArgs(spec)) {
    // Stored with the bundled runtime on enable, which only knows the package and its arguments.
    return toBundledArgs(spec)
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
  // The command as written, folder included: the identity keeps only its file name, and a ref must
  // not survive the program being swapped for another of the same name.
  const settings =
    spec.kind === "stdio"
      ? canonicalJson({
          command: spec.command,
          args: spec.args,
          cwd: spec.cwd ?? null,
          env: spec.env,
        })
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
  try {
    // On Windows the mode means little: the file takes the data folder's ACL, like the token's.
    writeFileSync(temporary, randomBytes(32), { mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // A filesystem without modes still got a file it created private.
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // Two processes making a key at once: both use whichever landed last.
  return readFileSync(file);
}

/** A name not yet taken (case-insensitively), within the 40 characters an app's name may have. */
function uniqueName(
  name: string,
  source: ConfigSource | "catalog",
  taken: Set<string>,
): string {
  if (!taken.has(name.toLowerCase())) return name;
  const short = source === "catalog" ? "内置清单" : SOURCE_SHORT[source];
  for (let n = 1; ; n += 1) {
    const suffix = `（${short}${n === 1 ? "" : ` ${n}`}）`;
    const room = Math.max(1, APP_NAME_LIMIT - [...suffix].length);
    const candidate = `${[...name].slice(0, room).join("")}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The installed programs (all of them, uncapped) and what the catalogue makes of this machine. */
async function surveyMachine(
  deps: DiscoverDeps,
  readInstalledNames: boolean,
): Promise<{
  installed: string[];
  catalog: CatalogFound[];
  matched: Set<string>;
}> {
  let installed: string[] = [];
  try {
    if (readInstalledNames) {
      installed = allInstalledNames(await deps.readInstalled());
    }
  } catch {
    // No list of installed programs: the catalogue can still find what runs or sits at a known path.
  }
  let found: CatalogFound[] = [];
  let matchedNames: string[] = [];
  try {
    const matched = await matchCatalog(deps.catalog ?? SHIPPED_CATALOG, {
      env: deps.env,
      installed,
      installedNotRead: !readInstalledNames,
      exists: deps.exists ?? defaultCatalogExists,
      probe: deps.probe ?? defaultCatalogProbe,
    });
    found = matched.found;
    matchedNames = matched.matchedInstalled;
  } catch {
    // A broken catalogue must not take the config sources down with it.
  }
  return { installed, catalog: found, matched: new Set(matchedNames) };
}

/** Every candidate as issued at `issued` (seconds), with the spec it stands for. */
function scan(
  deps: DiscoverDeps,
  key: Buffer,
  issued: number,
  fromCatalog: CatalogFound[],
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
  // The configs come first, so an app one of them already runs keeps that source.
  const everything: (FoundServer | CatalogFound)[] = [
    ...readConfigServers({ env: deps.env, readText: deps.readText }),
    ...fromCatalog,
  ];
  for (const found of everything) {
    if (out.length >= MAX_CANDIDATES) break;
    const spec = unwrapShell(found.spec);
    const identity = identityOf(spec);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const name = uniqueName(found.name, found.source, taken);
    taken.add(name.toLowerCase());
    const mac = macOf(key, issued, found.source, identity, spec);
    const app = registered.get(identity);
    out.push({
      candidate: {
        ref: `cand_${issued.toString(36)}_${mac}`,
        name,
        source: found.source,
        sourceLabel:
          found.source === "catalog"
            ? found.sourceLabel
            : SOURCE_LABELS[found.source],
        kind: spec.kind,
        enabled: app?.enabled ?? false,
        ...(app ? { app: app.ref } : {}),
        ...statusOf(spec, deps.resolveCommand),
      },
      spec,
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
  let key: Buffer;
  try {
    key = ensureKey(deps.dataDir);
  } catch {
    // The fs error names the data folder, and with it the owner's account: it must not leave.
    throw new DiscoverError(DISCOVER_KEY_FAILED);
  }
  const survey = await surveyMachine(deps, true);
  const issued = Math.floor(deps.now() / 1000);
  const candidates = scan(deps, key, issued, survey.catalog).map(
    ({ candidate }) => candidate,
  );
  // What the catalogue recognised is offered as an app now, so it leaves the plain list.
  const installed = survey.installed
    .filter((name) => !survey.matched.has(name))
    .slice(0, INSTALLED_LIMIT);
  return { platform: deps.platform, candidates, installed };
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
  // A lookup by reference never reads the installed programs.
  const survey = await surveyMachine(deps, false);
  for (const item of scan(deps, key, issued, survey.catalog)) {
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
