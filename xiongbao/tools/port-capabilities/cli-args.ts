/**
 * 命令行面：把 argv 变成一个 `CliOptions`，或者一个 `UsageError`。
 *
 * 从 `index.ts` 拆出来（技术债 #25）。参数解析和管道执行是两件事：前者要能被单测直接驱动，
 * 也只在 `--help` 与拼错时才被想起；后者才是这个工具的本体。
 *
 * `DEFAULT_CENSUS_PATH` 用 `import.meta.dir` 定位仓库根，所以本文件必须与 `index.ts` 同目录——
 * 挪走它会静默改掉普查文件的落点。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** CLI exit codes. `usage` is distinct so a script can tell a typo from a failed conversion. */
export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

/** Porting scopes. `l0` is the machine-installed set; `l1` reads the fetch cache behind the lock gate. */
const SUPPORTED_SCOPES = ["l0", "l1"] as const;

type Scope = (typeof SUPPORTED_SCOPES)[number];

/** Which connectors the run reads. `l0` is the P0 allowlist; `all` is every id in the marketplace index. */
export type ConnectorScope = "l0" | "all";

/** Parsed command line. */
export interface CliOptions {
  sourceRoot: string;
  outDir: string;
  scope: Scope;
  /** Which connectors to read; default `l0` keeps the P0 behaviour byte-for-byte. */
  connectors: ConnectorScope;
  verify: boolean;
  /** Check an existing `--out` directory without re-reading the source or writing anything. */
  verifyOnly: boolean;
  /** Survey the connector marketplace instead of porting. */
  census: boolean;
  /** Where the census is written. Resolved even when `--census` is absent, so the type stays simple. */
  censusPath: string;
  /** `--lock`: the capability-lock file the l1 gate consults. Required for `--only=l1`, refused for `l0`. */
  lockPath: string | undefined;
  /** `--whitelist`: optional narrowing slug list (one per line, `#` comments). Only meaningful with `l1`. */
  whitelistPath: string | undefined;
  help: boolean;
}

/** Default location of the census, anchored to the repo rather than to the caller's working directory. */
export const DEFAULT_CENSUS_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "capability-census.yaml",
);

/** Thrown for a malformed command line; `main` turns it into exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `用法：
  bun run port:capabilities -- --out <目录> [--source <WorkBuddy 主目录>] [--only=l0] [--connectors=l0|all] [--verify]
  bun run port:capabilities -- --census[=<路径>] [--source <WorkBuddy 主目录>]

选项：
  --source <路径>     WorkBuddy 主目录或抓取缓存（fetch-capabilities 产物），默认 ~/.workbuddy
  --out <路径>        输出目录（必须显式给出；不会写到仓库里的默认位置）
  --only=<范围>       移植范围：l0（本机已装：专家包 + 用户技能 + 已授权连接器）或 l1（抓取缓存，经 capability-lock 白名单闸门）
  --lock <路径>       capability-lock 文件；--only=l1 必填，l0 下禁止（默认仓库根 capability-lock.yaml 可显式指定）
  --whitelist <路径>  可选白名单（每行一个 slug 或 slug/子路径，# 注释）：slug 收窄整包；slug/子路径 只放行官方插件包内该技能；仅 l1 有效
  --connectors=<档>   l0 = 仅已授权连接器（默认，P0 行为）；all = 市场索引里的全部连接器（L1 全量普查用）
  --verify            写完后回读输出目录，按同一套规则再校验一遍
  --verify-only       只回读 --out 里已有的产出，不重新生成（用于复核已生成的包）
  --census[=<路径>]   只做连接器市场普查，默认写到 openbot/capability-census.yaml（只读、不联网、不产出包）
  --help              打印本说明`;

/** Expand a leading `~` and make the path absolute. */
export function expandPath(input: string): string {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? join(homedir(), input.slice(2))
        : input;
  return resolve(expanded);
}

/**
 * Read the optional `--whitelist` file: one slug per line; blank lines and `#` comments are ignored.
 * The list narrows the gate; it can never widen one — a slug the licence rules refuse stays refused
 * even if it appears here.
 */
export function readWhitelistSlugs(path: string): string[] {
  const slugs: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    slugs.push(trimmed);
  }
  return slugs;
}

/** Split `--flag=value` into its two halves; leave bare flags alone. */
function splitFlag(arg: string): { flag: string; inline: string | undefined } {
  if (!arg.startsWith("--")) {
    return { flag: arg, inline: undefined };
  }
  const equals = arg.indexOf("=");
  if (equals === -1) {
    return { flag: arg, inline: undefined };
  }
  return { flag: arg.slice(0, equals), inline: arg.slice(equals + 1) };
}

/**
 * Parse the command line.
 *
 * `--out` is mandatory and has no default on purpose: writing a tenant-package fragment over a checked-in
 * one by accident is the failure this prevents, and a required flag costs the caller four characters.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      sourceRoot: join(homedir(), ".workbuddy"),
      outDir: "",
      scope: "l0",
      connectors: "l0",
      verify: false,
      verifyOnly: false,
      census: false,
      censusPath: DEFAULT_CENSUS_PATH,
      lockPath: undefined,
      whitelistPath: undefined,
      help: true,
    };
  }
  let source: string | undefined;
  let out: string | undefined;
  let only: string | undefined;
  let connectors: string | undefined;
  let censusPath: string | undefined;
  let lockPath: string | undefined;
  let whitelistPath: string | undefined;
  let verify = false;
  let verifyOnly = false;
  let census = false;
  const unknown: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const { flag, inline } = splitFlag(argv[index]);
    /** Value of a flag, either inline or the next word; throws when the flag was left dangling. */
    const value = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${flag} 缺少取值`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--source":
        source = value();
        break;
      case "--out":
        out = value();
        break;
      case "--only":
        only = value();
        break;
      case "--connectors":
        connectors = value();
        break;
      case "--lock":
        lockPath = value();
        break;
      case "--whitelist":
        whitelistPath = value();
        break;
      case "--verify":
        verify = true;
        break;
      case "--verify-only":
        verifyOnly = true;
        break;
      case "--census":
        // `--census` may stand alone or take a path, so an inline value is optional here in a way `--out`
        // is not: the default target is a fixed path inside the repo, which CI relies on.
        census = true;
        censusPath = inline ?? undefined;
        break;
      default:
        unknown.push(argv[index]);
    }
  }
  if (unknown.length > 0) {
    throw new UsageError(`无法识别的参数：${unknown.join(" ")}`);
  }
  if (!out && !census) {
    throw new UsageError("缺少 --out：输出目录必须显式给出（或改用 --census）");
  }
  const scope = (only ?? "l0").trim();
  if (!SUPPORTED_SCOPES.includes(scope as Scope)) {
    throw new UsageError(
      `--only=${scope} 不受支持；支持 ${SUPPORTED_SCOPES.join(" / ")}`,
    );
  }
  if (scope === "l1" && lockPath === undefined) {
    throw new UsageError(
      "--only=l1 需要 --lock <capability-lock.yaml>：闸门只放行锁内且许可放行的条目",
    );
  }
  if (scope === "l0" && (lockPath !== undefined || whitelistPath !== undefined)) {
    throw new UsageError(
      "--lock / --whitelist 只在 --only=l1 下有意义；l0 直读本机装量，不走闸门",
    );
  }
  const connectorScope = (connectors ?? "l0").trim();
  if (connectorScope !== "l0" && connectorScope !== "all") {
    throw new UsageError(
      `--connectors=${connectorScope} 不受支持；只支持 l0 / all`,
    );
  }
  return {
    sourceRoot: expandPath(source ?? join(homedir(), ".workbuddy")),
    outDir: out === undefined ? "" : expandPath(out),
    scope: scope as Scope,
    connectors: connectorScope as ConnectorScope,
    verify,
    verifyOnly,
    census,
    censusPath:
      censusPath === undefined ? DEFAULT_CENSUS_PATH : expandPath(censusPath),
    lockPath: lockPath === undefined ? undefined : expandPath(lockPath),
    whitelistPath:
      whitelistPath === undefined ? undefined : expandPath(whitelistPath),
    help: false,
  };
}
