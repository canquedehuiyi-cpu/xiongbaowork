/**
 * `--census`: what the connector marketplace actually contains, and how much of it openbot could carry.
 *
 * This is the first acceptance artifact of P1 and it exists to stop a specific kind of dishonesty. The
 * port ships the three connectors authorised on this machine; the marketplace defines 298. "We ported
 * connectors" is true of 3 and false of 295, and neither number is visible in the package. The census
 * reads the catalogue and reports every row with the one field that decides its fate: how it is
 * transported and how it authenticates.
 *
 * Read-only by construction: it opens `connectors.json`, stats the per-connector directories, and writes
 * one YAML file. No network, no writes into the source tree, no package output.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";

import type { RunnableLevel } from "./mapping";
import { stripBom } from "./read-workbuddy";

/** How a catalogue entry is actually shipped, decided from the files on disk rather than from `type`. */
export type CensusTransport = "mcp-url" | "mcp-command" | "cli" | "missing";

/** openbot's three credential models, plus `unknown` for a row whose source value maps to none of them. */
export type CensusAuth =
  | "none"
  | "user-oauth"
  | "deployment-bearer"
  | "unknown";

/**
 * The three dispositions of §4a-3, which the plan makes the *only* accepted summary shape: "declarable /
 * not" flattens B and C into one bucket and reads as "72 connectors are dead" when 12 of them work the
 * moment a user brings a token.
 *
 *   A — endpoint exists + credentials self-serviceable: declarable, bind per connector. Its
 *       `auth-undeclared` members are counted separately, never silently inside "usable".
 *   B — endpoint exists + platform-held credential (`server-side`): declarable, user brings a token.
 *   C — no remote endpoint (`mcp-command` / `cli` / `missing`): structurally not portable, drop.
 */
export type CensusTier = "A" | "B" | "C";

/**
 * The reason code §4a-4 fixes now so the census does not get rewritten later. Verdict says whether the
 * connector can be declared; the reason code says what to do next, and each code maps to exactly one
 * action.
 */
export type CensusReasonCode =
  | "ok"
  | "auth-undeclared"
  | "platform-held-credential"
  | "no-remote-endpoint";

/** One catalogue row, after the survey. */
export interface CensusRow {
  /** Connector id — the marketplace's own key, not a slug: nothing here is deployed. */
  id: string;
  /** Posix path of the connector's directory, relative to the marketplace root. Never absolute. */
  directory: string;
  transport: CensusTransport;
  /** `type` as the catalogue declared it, or `(absent)`. Kept so a declared/shipped mismatch is visible. */
  declared_type: string;
  /** `auth_mode` verbatim, so the mapping below can be audited against the source. */
  auth_mode_raw: string;
  /** The same value after {@link AUTH_MODE_MAP}. One concept, one name. */
  auth_mode_mapped: CensusAuth;
  /** The §4a-3 disposition, derived from transport × raw auth mode — see {@link judgeTier}. */
  tier: CensusTier;
  /** The §4a-4 reason code; combined with `verdict` it pins the next action for this row. */
  reason_code: CensusReasonCode;
  verdict: RunnableLevel;
  /** Why the verdict, in one clause. `blocked` always names the missing piece. */
  reason: string;
}

/** The whole survey. Field order is the emitted order. */
export interface Census {
  /** Source metadata, not the clock: see {@link buildCensus}. */
  generated_at: string;
  /** sha256 of the catalogue file the rows came from, so a census is pinned to one index revision. */
  source_index_checksum: string;
  counts: {
    total: number;
    by_transport: Record<CensusTransport, number>;
    by_auth_mode: Record<CensusAuth, number>;
    /** Must equal the per-row tally; {@link assertCensusConsistent} fails the run when it does not. */
    by_verdict: Record<RunnableLevel, number>;
    /** The §4a-3 three dispositions. Hard rule from the plan: never emit only "declarable X / not Y". */
    by_tier: Record<CensusTier, number>;
    /** Rows in tier A whose `auth_mode` the source never declared. A standalone field, not folded into ok. */
    auth_undeclared: number;
    by_reason_code: Record<CensusReasonCode, number>;
  };
  /** transport × auth_mode, the table that makes "what is left to do" arguable. */
  cross_table: {
    transport: CensusTransport;
    none: number;
    "user-oauth": number;
    "deployment-bearer": number;
    unknown: number;
    total: number;
  }[];
  rows: CensusRow[];
}

/** Thrown when the census contradicts itself; `main` turns it into exit code 1. */
export class CensusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CensusError";
  }
}

/**
 * WorkBuddy's `auth_mode` → openbot's credential model.
 *
 * `server-side` maps to `deployment-bearer`, and its verdict is **degraded**, not full. The earlier
 * reading — "the server holds the credential, so the client injects nothing" — was wrong and cost a
 * reproducible measurement: three such connectors called bare with MCP `initialize` and no credentials
 * all answered 401 (`tdx-connector` "Missing Bearer authorization", `ezr-crm` "missing Bearer access
 * token", `fazhi-law` "Illegal authorization"). The real semantics is that the *platform* holds the
 * credential and injects a Bearer into every request on the caller's behalf. openbot can carry that, but
 * only by hosting a credential of its own, which is a deployment decision — hence `deployment-bearer`
 * with a degraded verdict (`platform-held-credential`). `token` and `oneid-token` are the deployment
 * holding one token for everyone, the same openbot name. Anything else, including a row whose
 * `auth_mode` holds a transport name (`mcp`), is `unknown` and must not be guessed. Absent means no
 * credential injection is declared, which is `none`.
 */
export const AUTH_MODE_MAP: Readonly<Record<string, CensusAuth>> = {
  "(absent)": "none",
  "server-side": "deployment-bearer",
  token: "deployment-bearer",
  "oneid-token": "deployment-bearer",
  oauth: "user-oauth",
};

/** Every transport in report order; also the key order of `counts.by_transport`. */
const TRANSPORTS: readonly CensusTransport[] = [
  "mcp-url",
  "mcp-command",
  "cli",
  "missing",
];

/** Every auth model in report order; also the key order of `counts.by_auth_mode`. */
const AUTHS: readonly CensusAuth[] = [
  "none",
  "user-oauth",
  "deployment-bearer",
  "unknown",
];

/** Every verdict in severity order, matching `SEVERITY_ORDER`. */
const VERDICTS: readonly RunnableLevel[] = ["full", "degraded", "blocked"];

/** Every tier in §4a-3 order; also the key order of `counts.by_tier`. */
const TIERS: readonly CensusTier[] = ["A", "B", "C"];

/** Every reason code in §4a-4 order; also the key order of `counts.by_reason_code`. */
const REASON_CODES: readonly CensusReasonCode[] = [
  "ok",
  "auth-undeclared",
  "platform-held-credential",
  "no-remote-endpoint",
];

/** A connector directory as it exists on disk. */
interface ShippedSpec {
  transport: CensusTransport;
  /** The spec file the transport was decided from, or `""` when the directory is absent. */
  file: string;
}

/** Where the catalogue lives, relative to the WorkBuddy home. */
const CATALOGUE_DIR = "connectors-marketplace";

/** The per-connector directories, relative to the marketplace root. */
const CONNECTOR_DIR = "connectors";

/** Inspect one connector directory. A directory without a spec is `missing`, not `full`. */
function readShippedSpec(marketplaceRoot: string, id: string): ShippedSpec {
  const dir = join(marketplaceRoot, CONNECTOR_DIR, id);
  if (!existsSync(dir)) {
    return { transport: "missing", file: "" };
  }
  const mcp = join(dir, "mcp.json");
  if (existsSync(mcp)) {
    return { transport: serverShape(mcp), file: "mcp.json" };
  }
  const cli = join(dir, "cli.json");
  if (existsSync(cli)) {
    return { transport: "cli", file: "cli.json" };
  }
  return { transport: "missing", file: "" };
}

/**
 * Whether an `mcp.json` describes a remote server or a local process.
 *
 * A `url` is a server openbot can call; a `command` is a process that has to start somewhere, and an
 * openbot employee has nowhere to start it. Unreadable JSON is reported as `mcp-command`, i.e. blocked,
 * because guessing "remote" would overstate what the port can carry.
 */
function serverShape(mcpPath: string): CensusTransport {
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(mcpPath, "utf8")));
    const record = isRecord(parsed) ? parsed : {};
    const servers = isRecord(record.mcpServers) ? record.mcpServers : record;
    const first = Object.values(servers)[0];
    if (isRecord(first) && typeof first.url === "string" && first.url !== "") {
      return "mcp-url";
    }
    return "mcp-command";
  } catch {
    return "mcp-command";
  }
}

/** Narrow to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map a raw `auth_mode` through {@link AUTH_MODE_MAP}, defaulting to `unknown`. */
export function mapAuthMode(raw: string): CensusAuth {
  return AUTH_MODE_MAP[raw] ?? "unknown";
}

/**
 * The §4a-3 disposition, from transport × raw auth mode.
 *
 * `rawAuthMode` (not the mapped value) decides tier B, because `server-side` shares its mapped model
 * with `token` while the two dispositions differ: `token` is "the user supplies a value" (tier A),
 * `server-side` is "the vendor holds the credential" (tier B). Everything that is not a remote URL is
 * tier C regardless of auth mode — a credential model cannot rescue a spec with no endpoint.
 */
export function judgeTier(
  transport: CensusTransport,
  rawAuthMode: string,
): CensusTier {
  if (transport !== "mcp-url") {
    return "C";
  }
  return rawAuthMode === "server-side" ? "B" : "A";
}

/**
 * The §4a-4 reason code for one row. Each code names exactly one next action:
 *
 *   ok                     → declare + fill header/URL per connector
 *   auth-undeclared        → declare + verify the auth mode one by one (65% of the remote set; first
 *                            call will fail, so it must stay a separate count, never folded into ok)
 *   platform-held-credential → declare + ask the user to bring a token
 *   no-remote-endpoint     → drop, and record why, until upstream ships a remote endpoint
 */
export function judgeReasonCode(
  tier: CensusTier,
  rawAuthMode: string,
): CensusReasonCode {
  if (tier === "C") {
    return "no-remote-endpoint";
  }
  if (tier === "B") {
    return "platform-held-credential";
  }
  return rawAuthMode === "(absent)" ? "auth-undeclared" : "ok";
}

/**
 * Decide whether openbot could carry this connector, and say why.
 *
 * The rule is the same one the auditor applies to instruction bodies: what runs on the employee, not what
 * exists on the author's machine. A remote MCP server with a known credential model is `full`; a remote
 * `server-side` connector is `degraded` — the transport works, but the credential is held by the platform
 * and injected per request (measured: bare `initialize` answers 401 on all three such connectors), so
 * openbot has to host its own Bearer before the connector is actually callable; a remote server whose
 * credential model is not mapped is `degraded` for the same "needs a human decision" reason; a stdio
 * server or a CLI wrapper is `blocked`, because openbot has no local runtime to start it in.
 *
 * `rawAuthMode` is the value before {@link AUTH_MODE_MAP}, needed because `server-side` and `token` map
 * to the same openbot model but only the former degrades the verdict.
 */
export function judgeConnector(
  transport: CensusTransport,
  auth: CensusAuth,
  rawAuthMode: string = "(absent)",
): { verdict: RunnableLevel; reason: string } {
  switch (transport) {
    case "missing":
      return {
        verdict: "blocked",
        reason: "目录里没有 mcp.json 也没有 cli.json，无 server 规格可移植",
      };
    case "cli":
      return {
        verdict: "blocked",
        reason:
          "cli.json：需要本机安装并运行 CLI 二进制，openbot 员工无本地运行时",
      };
    case "mcp-command":
      return {
        verdict: "blocked",
        reason:
          "mcp.json 用 command 启动本地进程（stdio），openbot 员工无本地运行时",
      };
    case "mcp-url":
      if (auth === "unknown") {
        return {
          verdict: "degraded",
          reason:
            "远端 server 可直连，但 auth_mode 无法映射到 openbot 的三种凭据模型，需人工定夺",
        };
      }
      if (rawAuthMode === "server-side") {
        return {
          verdict: "degraded",
          reason:
            "远端 server 可直连，但凭据由平台代持（platform-held-credential）：请求需注入平台 Bearer（实测无凭据调用 initialize 返回 401），openbot 侧需自行托管凭据后才能调用",
        };
      }
      return {
        verdict: "full",
        reason: `远端 server + 凭据模型 ${auth}，openbot 可直接托管`,
      };
    default:
      return { verdict: "blocked", reason: "未知 transport" };
  }
}

/** The catalogue file and its bytes, so the checksum and the rows come from one read. */
interface Catalogue {
  marketplaceRoot: string;
  indexPath: string;
  checksum: string;
  /** Latest file timestamp of the catalogue, as ISO-8601 UTC. See {@link buildCensus}. */
  updatedAt: string;
  rows: CensusRow[];
}

/**
 * Read the catalogue and survey every row.
 *
 * `generated_at` comes from the catalogue file's own timestamp rather than from `Date.now()`, for the same
 * reason no other artifact here carries a clock timestamp: two runs over one source tree must be
 * byte-identical, and a wall clock would make `diff -r` fail every time. The value therefore means "the
 * catalogue as of the last time it was written", which is the honest thing to put in the file.
 */
function readCatalogue(sourceRoot: string): Catalogue {
  const marketplaceRoot = join(sourceRoot, CATALOGUE_DIR);
  const indexPath = join(
    marketplaceRoot,
    ".codebuddy-connector",
    "connectors.json",
  );
  if (!existsSync(indexPath)) {
    throw new CensusError(`找不到连接器清单：${indexPath}`);
  }
  const bytes = readFileSync(indexPath, "utf8");
  const parsed: unknown = JSON.parse(stripBom(bytes));
  const list =
    isRecord(parsed) && Array.isArray(parsed.connectors)
      ? parsed.connectors
      : null;
  if (list === null) {
    throw new CensusError(
      `连接器清单结构不符合预期（缺少 connectors 数组）：${indexPath}`,
    );
  }
  const seen = new Set<string>();
  const rows: CensusRow[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
      throw new CensusError(`连接器清单存在没有 id 的行：${indexPath}`);
    }
    const id = entry.id;
    if (seen.has(id)) {
      // A duplicate id would make the cross table double-count while looking plausible.
      throw new CensusError(`连接器清单存在重复 id：${id}`);
    }
    seen.add(id);
    const shipped = readShippedSpec(marketplaceRoot, id);
    const raw =
      typeof entry.auth_mode === "string" && entry.auth_mode !== ""
        ? entry.auth_mode
        : "(absent)";
    const mapped = mapAuthMode(raw);
    const { verdict, reason } = judgeConnector(shipped.transport, mapped, raw);
    const tier = judgeTier(shipped.transport, raw);
    rows.push({
      id,
      directory:
        shipped.file === ""
          ? `${CONNECTOR_DIR}/${id}（缺规格文件）`
          : `${CONNECTOR_DIR}/${id}/${shipped.file}`,
      transport: shipped.transport,
      declared_type:
        typeof entry.type === "string" && entry.type !== ""
          ? entry.type
          : "(absent)",
      auth_mode_raw: raw,
      auth_mode_mapped: mapped,
      tier,
      reason_code: judgeReasonCode(tier, raw),
      verdict,
      reason,
    });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return {
    marketplaceRoot,
    indexPath,
    checksum: createHash("sha256").update(bytes, "utf8").digest("hex"),
    updatedAt: statSync(indexPath).mtime.toISOString(),
    rows,
  };
}

/** Survey the marketplace under `sourceRoot` and return the census document. */
export function buildCensus(sourceRoot: string): Census {
  const catalogue = readCatalogue(sourceRoot);
  const by_transport: Record<CensusTransport, number> = {
    "mcp-url": 0,
    "mcp-command": 0,
    cli: 0,
    missing: 0,
  };
  const by_auth_mode: Record<CensusAuth, number> = {
    none: 0,
    "user-oauth": 0,
    "deployment-bearer": 0,
    unknown: 0,
  };
  const by_verdict: Record<RunnableLevel, number> = {
    full: 0,
    degraded: 0,
    blocked: 0,
  };
  const by_tier: Record<CensusTier, number> = { A: 0, B: 0, C: 0 };
  const by_reason_code: Record<CensusReasonCode, number> = {
    ok: 0,
    "auth-undeclared": 0,
    "platform-held-credential": 0,
    "no-remote-endpoint": 0,
  };
  for (const row of catalogue.rows) {
    by_transport[row.transport] += 1;
    by_auth_mode[row.auth_mode_mapped] += 1;
    by_verdict[row.verdict] += 1;
    by_tier[row.tier] += 1;
    by_reason_code[row.reason_code] += 1;
  }
  // The plan's hard rule: auth-undeclared is its own number. It is recomputed here from the rows rather
  // than read out of by_reason_code so the two tallies can disagree loudly in the consistency check.
  const auth_undeclared = catalogue.rows.filter(
    (row) => row.tier === "A" && row.auth_mode_raw === "(absent)",
  ).length;
  const cross_table = TRANSPORTS.map((transport) => {
    const bucket = {
      transport,
      none: 0,
      "user-oauth": 0,
      "deployment-bearer": 0,
      unknown: 0,
      total: 0,
    };
    for (const row of catalogue.rows) {
      if (row.transport !== transport) {
        continue;
      }
      bucket[row.auth_mode_mapped] += 1;
      bucket.total += 1;
    }
    return bucket;
  });
  const census: Census = {
    generated_at: catalogue.updatedAt,
    source_index_checksum: catalogue.checksum,
    counts: {
      total: catalogue.rows.length,
      by_transport,
      by_auth_mode,
      by_verdict,
      by_tier,
      auth_undeclared,
      by_reason_code,
    },
    cross_table,
    rows: catalogue.rows,
  };
  assertCensusConsistent(census);
  return census;
}

/**
 * Fail when the summary and the rows disagree.
 *
 * The counts are what the report is read for, and they are computed twice on purpose: once by tallying
 * rows and once by the same loop that fills the cross table. A silent disagreement here would put a wrong
 * number in front of a reviewer with no way to notice, so an inconsistency is a hard failure, not a warning.
 */
export function assertCensusConsistent(census: Census): void {
  const tally: Record<RunnableLevel, number> = {
    full: 0,
    degraded: 0,
    blocked: 0,
  };
  const transportTally: Record<CensusTransport, number> = {
    "mcp-url": 0,
    "mcp-command": 0,
    cli: 0,
    missing: 0,
  };
  const authTally: Record<CensusAuth, number> = {
    none: 0,
    "user-oauth": 0,
    "deployment-bearer": 0,
    unknown: 0,
  };
  const tierTally: Record<CensusTier, number> = { A: 0, B: 0, C: 0 };
  const reasonTally: Record<CensusReasonCode, number> = {
    ok: 0,
    "auth-undeclared": 0,
    "platform-held-credential": 0,
    "no-remote-endpoint": 0,
  };
  let authUndeclaredTally = 0;
  for (const row of census.rows) {
    tally[row.verdict] += 1;
    transportTally[row.transport] += 1;
    authTally[row.auth_mode_mapped] += 1;
    tierTally[row.tier] += 1;
    reasonTally[row.reason_code] += 1;
    if (row.tier === "A" && row.auth_mode_raw === "(absent)") {
      authUndeclaredTally += 1;
    }
  }
  for (const level of VERDICTS) {
    if (census.counts.by_verdict[level] !== tally[level]) {
      throw new CensusError(
        `counts.by_verdict.${level} = ${census.counts.by_verdict[level]}，但逐行统计是 ${tally[level]}`,
      );
    }
  }
  for (const transport of TRANSPORTS) {
    if (census.counts.by_transport[transport] !== transportTally[transport]) {
      throw new CensusError(
        `counts.by_transport.${transport} = ${census.counts.by_transport[transport]}，但逐行统计是 ${transportTally[transport]}`,
      );
    }
  }
  for (const auth of AUTHS) {
    if (census.counts.by_auth_mode[auth] !== authTally[auth]) {
      throw new CensusError(
        `counts.by_auth_mode.${auth} = ${census.counts.by_auth_mode[auth]}，但逐行统计是 ${authTally[auth]}`,
      );
    }
  }
  for (const tier of TIERS) {
    if (census.counts.by_tier[tier] !== tierTally[tier]) {
      throw new CensusError(
        `counts.by_tier.${tier} = ${census.counts.by_tier[tier]}，但逐行统计是 ${tierTally[tier]}`,
      );
    }
  }
  for (const code of REASON_CODES) {
    if (census.counts.by_reason_code[code] !== reasonTally[code]) {
      throw new CensusError(
        `counts.by_reason_code.${code} = ${census.counts.by_reason_code[code]}，但逐行统计是 ${reasonTally[code]}`,
      );
    }
  }
  if (census.counts.auth_undeclared !== authUndeclaredTally) {
    throw new CensusError(
      `counts.auth_undeclared = ${census.counts.auth_undeclared}，但逐行统计是 ${authUndeclaredTally}`,
    );
  }
  // The plan's arithmetic, checked instead of trusted: 227 + 12 + 59 = 298, and the tiers must line up
  // with the transport split they were derived from, or the two summaries contradict each other.
  const tierTotal = tierTally.A + tierTally.B + tierTally.C;
  if (tierTotal !== census.rows.length) {
    throw new CensusError(`三档合计 ${tierTotal} ≠ rows ${census.rows.length}`);
  }
  if (tierTally.A + tierTally.B !== transportTally["mcp-url"]) {
    throw new CensusError(
      `tier A(${tierTally.A}) + B(${tierTally.B}) = ${tierTally.A + tierTally.B} ≠ mcp-url ${transportTally["mcp-url"]}`,
    );
  }
  if (
    tierTally.C !==
    transportTally["mcp-command"] + transportTally.cli + transportTally.missing
  ) {
    throw new CensusError(
      `tier C(${tierTally.C}) ≠ 无远程端点全体 ${transportTally["mcp-command"] + transportTally.cli + transportTally.missing}`,
    );
  }
  const rowTotal = VERDICTS.reduce(
    (sum, level) => sum + census.counts.by_verdict[level],
    0,
  );
  if (
    census.counts.total !== census.rows.length ||
    census.counts.total !== rowTotal
  ) {
    throw new CensusError(
      `counts.total = ${census.counts.total}，rows = ${census.rows.length}，by_verdict 合计 = ${rowTotal}`,
    );
  }
  const crossTotal = census.cross_table.reduce(
    (sum, bucket) => sum + bucket.total,
    0,
  );
  if (crossTotal !== census.counts.total) {
    throw new CensusError(
      `cross_table 合计 ${crossTotal} ≠ counts.total ${census.counts.total}`,
    );
  }
  for (const bucket of census.cross_table) {
    const rowSum =
      bucket.none +
      bucket["user-oauth"] +
      bucket["deployment-bearer"] +
      bucket.unknown;
    if (rowSum !== bucket.total) {
      throw new CensusError(
        `cross_table 的 ${bucket.transport} 行分项合计 ${rowSum} ≠ total ${bucket.total}`,
      );
    }
    if (bucket.total !== census.counts.by_transport[bucket.transport]) {
      throw new CensusError(
        `cross_table 的 ${bucket.transport} 行 total ${bucket.total} ≠ by_transport ${census.counts.by_transport[bucket.transport]}`,
      );
    }
  }
}

/** One line per verdict with its count, for the CLI summary. */
export function formatCensusCounts(census: Census): string {
  return VERDICTS.map(
    (level) => `${level} ${census.counts.by_verdict[level]}`,
  ).join(" / ");
}

/**
 * The §4a-3 summary line: the three dispositions with the auth-undeclared count standing alone.
 *
 * This exists because the plan forbids the two-number summary ("declarable X / not Y") that flattens
 * tiers B and C into one bucket. A reader of the CLI output gets the same shape the plan mandates:
 * `A 227（其中 auth-undeclared 156）/ B 12 / C 59`.
 */
export function formatCensusTiers(census: Census): string {
  const { by_tier, auth_undeclared } = census.counts;
  return `A ${by_tier.A}（其中 auth-undeclared ${auth_undeclared}）/ B ${by_tier.B} / C ${by_tier.C}`;
}

/**
 * Render the census as YAML.
 *
 * The header comment states what the file is and what `generated_at` means, because a reader who assumes
 * it is "when the census ran" will draw the wrong conclusion about freshness.
 */
export function renderCensus(census: Census): string {
  const header = [
    "# capability-census — 连接器市场的全量普查（`bun run port:capabilities -- --census`）",
    "# 只读：读 connectors.json 与每个连接器目录，不联网、不写源目录、不产出包。",
    "# generated_at 取清单文件自身的写入时间，不是本次运行时间；两次运行对同一份清单必须完全一致。",
    "# 三档（§4a-3）：A=端点存在+凭据可自备，B=端点存在+凭据平台代持（server-side），C=无远程端点。",
    "# counts.auth_undeclared 单列（§4a-4）：156 条认证方式未声明不许默默算进可用。",
    "",
  ].join("\n");
  return `${header}${toYaml(census, { lineWidth: 0 })}`;
}
