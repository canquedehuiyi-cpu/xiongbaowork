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

/** How a catalogue entry is actually shipped, decided from the files on disk rather than from `type`. */
export type CensusTransport = "mcp-url" | "mcp-command" | "cli" | "missing";

/** openbot's three credential models, plus `unknown` for a row whose source value maps to none of them. */
export type CensusAuth = "none" | "user-oauth" | "deployment-bearer" | "unknown";

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
  };
  /** transport × auth_mode, the table that makes "what is left to do" arguable. */
  cross_table: { transport: CensusTransport; none: number; "user-oauth": number; "deployment-bearer": number; unknown: number; total: number }[];
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
 * `server-side` is `none` because the *server* holds the credential: nothing is injected into the
 * employee. `token` and `oneid-token` are both the deployment holding one token for everyone, which is
 * what openbot calls `deployment-bearer` — the single name this repo keeps for that concept. Anything
 * else, including a row whose `auth_mode` holds a transport name (`mcp`), is `unknown` and must not be
 * guessed. Absent means no credential injection is declared, which is `none`.
 */
export const AUTH_MODE_MAP: Readonly<Record<string, CensusAuth>> = {
  "(absent)": "none",
  "server-side": "none",
  token: "deployment-bearer",
  "oneid-token": "deployment-bearer",
  oauth: "user-oauth",
};

/** Every transport in report order; also the key order of `counts.by_transport`. */
const TRANSPORTS: readonly CensusTransport[] = ["mcp-url", "mcp-command", "cli", "missing"];

/** Every auth model in report order; also the key order of `counts.by_auth_mode`. */
const AUTHS: readonly CensusAuth[] = ["none", "user-oauth", "deployment-bearer", "unknown"];

/** Every verdict in severity order, matching `SEVERITY_ORDER`. */
const VERDICTS: readonly RunnableLevel[] = ["full", "degraded", "blocked"];

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
    const parsed: unknown = JSON.parse(readFileSync(mcpPath, "utf8"));
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
 * Decide whether openbot could carry this connector, and say why.
 *
 * The rule is the same one the auditor applies to instruction bodies: what runs on the employee, not what
 * exists on the author's machine. A remote MCP server with a known credential model is `full`; a remote
 * server whose credential model is not mapped is `degraded`, because the transport works and only the
 * authorisation needs a human decision; a stdio server or a CLI wrapper is `blocked`, because openbot has
 * no local runtime to start it in.
 */
export function judgeConnector(transport: CensusTransport, auth: CensusAuth): { verdict: RunnableLevel; reason: string } {
  switch (transport) {
    case "missing":
      return { verdict: "blocked", reason: "目录里没有 mcp.json 也没有 cli.json，无 server 规格可移植" };
    case "cli":
      return { verdict: "blocked", reason: "cli.json：需要本机安装并运行 CLI 二进制，openbot 员工无本地运行时" };
    case "mcp-command":
      return { verdict: "blocked", reason: "mcp.json 用 command 启动本地进程（stdio），openbot 员工无本地运行时" };
    case "mcp-url":
      if (auth === "unknown") {
        return { verdict: "degraded", reason: "远端 server 可直连，但 auth_mode 无法映射到 openbot 的三种凭据模型，需人工定夺" };
      }
      return { verdict: "full", reason: `远端 server + 凭据模型 ${auth}，openbot 可直接托管` };
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
  const indexPath = join(marketplaceRoot, ".codebuddy-connector", "connectors.json");
  if (!existsSync(indexPath)) {
    throw new CensusError(`找不到连接器清单：${indexPath}`);
  }
  const bytes = readFileSync(indexPath, "utf8");
  const parsed: unknown = JSON.parse(bytes);
  const list = isRecord(parsed) && Array.isArray(parsed.connectors) ? parsed.connectors : null;
  if (list === null) {
    throw new CensusError(`连接器清单结构不符合预期（缺少 connectors 数组）：${indexPath}`);
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
    const raw = typeof entry.auth_mode === "string" && entry.auth_mode !== "" ? entry.auth_mode : "(absent)";
    const mapped = mapAuthMode(raw);
    const { verdict, reason } = judgeConnector(shipped.transport, mapped);
    rows.push({
      id,
      directory: shipped.file === "" ? `${CONNECTOR_DIR}/${id}（缺规格文件）` : `${CONNECTOR_DIR}/${id}/${shipped.file}`,
      transport: shipped.transport,
      declared_type: typeof entry.type === "string" && entry.type !== "" ? entry.type : "(absent)",
      auth_mode_raw: raw,
      auth_mode_mapped: mapped,
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
  const by_transport: Record<CensusTransport, number> = { "mcp-url": 0, "mcp-command": 0, cli: 0, missing: 0 };
  const by_auth_mode: Record<CensusAuth, number> = { none: 0, "user-oauth": 0, "deployment-bearer": 0, unknown: 0 };
  const by_verdict: Record<RunnableLevel, number> = { full: 0, degraded: 0, blocked: 0 };
  for (const row of catalogue.rows) {
    by_transport[row.transport] += 1;
    by_auth_mode[row.auth_mode_mapped] += 1;
    by_verdict[row.verdict] += 1;
  }
  const cross_table = TRANSPORTS.map((transport) => {
    const bucket = { transport, none: 0, "user-oauth": 0, "deployment-bearer": 0, unknown: 0, total: 0 };
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
    counts: { total: catalogue.rows.length, by_transport, by_auth_mode, by_verdict },
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
  const tally: Record<RunnableLevel, number> = { full: 0, degraded: 0, blocked: 0 };
  const transportTally: Record<CensusTransport, number> = { "mcp-url": 0, "mcp-command": 0, cli: 0, missing: 0 };
  const authTally: Record<CensusAuth, number> = { none: 0, "user-oauth": 0, "deployment-bearer": 0, unknown: 0 };
  for (const row of census.rows) {
    tally[row.verdict] += 1;
    transportTally[row.transport] += 1;
    authTally[row.auth_mode_mapped] += 1;
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
  const rowTotal = VERDICTS.reduce((sum, level) => sum + census.counts.by_verdict[level], 0);
  if (census.counts.total !== census.rows.length || census.counts.total !== rowTotal) {
    throw new CensusError(
      `counts.total = ${census.counts.total}，rows = ${census.rows.length}，by_verdict 合计 = ${rowTotal}`,
    );
  }
  const crossTotal = census.cross_table.reduce((sum, bucket) => sum + bucket.total, 0);
  if (crossTotal !== census.counts.total) {
    throw new CensusError(`cross_table 合计 ${crossTotal} ≠ counts.total ${census.counts.total}`);
  }
  for (const bucket of census.cross_table) {
    const rowSum = bucket.none + bucket["user-oauth"] + bucket["deployment-bearer"] + bucket.unknown;
    if (rowSum !== bucket.total) {
      throw new CensusError(`cross_table 的 ${bucket.transport} 行分项合计 ${rowSum} ≠ total ${bucket.total}`);
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
  return VERDICTS.map((level) => `${level} ${census.counts.by_verdict[level]}`).join(" / ");
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
    "",
  ].join("\n");
  return `${header}${toYaml(census, { lineWidth: 0 })}`;
}
