#!/usr/bin/env bun
/**
 * `bun run port:capabilities` — converts the WorkBuddy capabilities installed on this machine into the
 * fragments an openbot tenant package needs, plus the two reports a reviewer signs off on.
 *
 *   bun run port:capabilities -- --source ~/.workbuddy --only=l0 --out ./tmp/p1 [--verify]
 *
 * The run is a pure function of the source tree: no timestamps from the clock, no absolute paths in the
 * output, every list sorted. Two runs into two directories must produce a clean `diff -r`, and that is
 * what `--verify` is for — it re-reads what was written and checks it against the same rules, so a
 * package that parses but contradicts itself (an agent granting a skill that is not there) fails here
 * rather than at server boot.
 *
 * If `bun test` or even `import "./normalize.ts"` hangs and then dies on SIGTERM, the cause is a poisoned
 * Bun transpile cache, not the code: run with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`. Worth knowing before
 * spending an hour on the regexes.
 */
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  auditCapabilities,
  type AuditFinding,
  countByLevel,
  indexFindings,
} from "./audit-toolrefs";
import { buildCensus, type Census, CensusError, formatCensusCounts, renderCensus } from "./census";
import { EMITTED_REPORT_FILES, EMITTED_YAML_FILES, emitPackage } from "./emit-package";
import { CONNECTOR_ALLOWLIST, type RunnableLevel } from "./mapping";
import {
  assertValidManifest,
  buildManifest,
  validateManifest,
} from "./manifest";
import { normalizeCapabilities } from "./normalize";
import { readWorkBuddy, SourceLayoutError } from "./read-workbuddy";

/** CLI exit codes. `usage` is distinct so a script can tell a typo from a failed conversion. */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

/** The only porting scope that exists in P0. */
const SUPPORTED_SCOPES = ["l0"] as const;

type Scope = (typeof SUPPORTED_SCOPES)[number];

/** Parsed command line. */
export interface CliOptions {
  sourceRoot: string;
  outDir: string;
  scope: Scope;
  verify: boolean;
  /** Check an existing `--out` directory without re-reading the source or writing anything. */
  verifyOnly: boolean;
  /** Survey the connector marketplace instead of porting. */
  census: boolean;
  /** Where the census is written. Resolved even when `--census` is absent, so the type stays simple. */
  censusPath: string;
  help: boolean;
}

/** Default location of the census, anchored to the repo rather than to the caller's working directory. */
export const DEFAULT_CENSUS_PATH = resolve(import.meta.dir, "..", "..", "capability-census.yaml");

/** Thrown for a malformed command line; `main` turns it into exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `用法：
  bun run port:capabilities -- --out <目录> [--source <WorkBuddy 主目录>] [--only=l0] [--verify]
  bun run port:capabilities -- --census[=<路径>] [--source <WorkBuddy 主目录>]

选项：
  --source <路径>   WorkBuddy 主目录，默认 ~/.workbuddy
  --out <路径>      输出目录（必须显式给出；不会写到仓库里的默认位置）
  --only=<范围>     移植范围，P0 只支持 l0（本机已装：专家包 + 用户技能 + 已授权连接器）
  --verify          写完后回读输出目录，按同一套规则再校验一遍
  --verify-only     只回读 --out 里已有的产出，不重新生成（用于复核已生成的包）
  --census[=<路径>] 只做连接器市场普查，默认写到 openbot/capability-census.yaml（只读、不联网、不产出包）
  --help            打印本说明`;

/** Expand a leading `~` and make the path absolute. */
export function expandPath(input: string): string {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return resolve(expanded);
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
      verify: false,
      verifyOnly: false,
      census: false,
      censusPath: DEFAULT_CENSUS_PATH,
      help: true,
    };
  }
  let source: string | undefined;
  let out: string | undefined;
  let only: string | undefined;
  let censusPath: string | undefined;
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
    throw new UsageError(`--only=${scope} 不受支持；P0 只实现 ${SUPPORTED_SCOPES.join(" / ")}`);
  }
  return {
    sourceRoot: expandPath(source ?? join(homedir(), ".workbuddy")),
    outDir: out === undefined ? "" : expandPath(out),
    scope: scope as Scope,
    verify,
    verifyOnly,
    census,
    censusPath: censusPath === undefined ? DEFAULT_CENSUS_PATH : expandPath(censusPath),
    help: false,
  };
}

/** One problem found by `--verify`. */
export interface VerifyProblem {
  file: string;
  detail: string;
}

/** Cast a parsed YAML value to a record, or an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Cast a parsed YAML value to a list of records. */
function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((entry) => asRecord(entry)) : [];
}

/** Read `agents.yaml` and return the ids and skill grants. */
function readAgents(filePath: string, problems: VerifyProblem[]): { ids: string[]; grantCount: number; skills: string[] } {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.agents);
  // 空列表不算问题：只带技能或只带连接器的合法包，agents 就是空的。三类全空的判定在 verifyOutDir。
  const ids: string[] = [];
  const skills: string[] = [];
  let grantCount = 0;
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    if (id === "") {
      problems.push({ file: "agents.yaml", detail: "存在没有 id 的 agent" });
      continue;
    }
    ids.push(id);
    if (typeof row.system_prompt !== "string" || row.system_prompt.trim() === "") {
      problems.push({ file: "agents.yaml", detail: `${id} 的 system_prompt 为空` });
    }
    for (const skill of Array.isArray(row.skills) ? row.skills : []) {
      skills.push(String(skill));
      grantCount += 1;
    }
  }
  return { ids, grantCount, skills };
}

/** Read `skills.yaml` and return the slugs plus any row whose `_porting` block is incomplete. */
function readSkills(filePath: string, problems: VerifyProblem[]): { slugs: string[] } {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.skills);
  // 空列表不算问题：只带专家的合法包，skills 就是空的。三类全空的判定在 verifyOutDir。
  const slugs: string[] = [];
  for (const row of rows) {
    const slug = typeof row.slug === "string" ? row.slug : "";
    if (slug === "") {
      problems.push({ file: "skills.yaml", detail: "存在没有 slug 的 skill" });
      continue;
    }
    slugs.push(slug);
    if (typeof row.instructions !== "string" || row.instructions.trim() === "") {
      problems.push({ file: "skills.yaml", detail: `${slug} 的 instructions 为空` });
    }
    if (!Array.isArray(row.tools) || (row.tools as unknown[]).length !== 0) {
      problems.push({ file: "skills.yaml", detail: `${slug} 的 tools 在 P0 必须是空数组` });
    }
    const porting = asRecord(row._porting);
    const runnable = porting.runnable;
    if (runnable !== "full" && runnable !== "degraded" && runnable !== "blocked") {
      problems.push({ file: "skills.yaml", detail: `${slug} 的 _porting.runnable 非法：${String(runnable)}` });
    }
    for (const field of ["source", "source_url", "checksum_sha256"]) {
      if (typeof porting[field] !== "string" || String(porting[field]).trim() === "") {
        problems.push({ file: "skills.yaml", detail: `${slug} 的 _porting.${field} 缺失` });
      }
    }
  }
  return { slugs };
}

/** Read `teams.yaml` and check every referenced agent exists. */
function readTeams(filePath: string, agentIds: ReadonlySet<string>, problems: VerifyProblem[]): number {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.teams);
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const lead = typeof row.lead === "string" ? row.lead : "";
    if (lead === "" || !agentIds.has(lead)) {
      problems.push({ file: "teams.yaml", detail: `${id} 的 lead "${lead}" 不在 agents.yaml 里` });
    }
    const members = asRecordList(row.members);
    if (members.length === 0) {
      problems.push({ file: "teams.yaml", detail: `${id} 没有 members` });
    }
    for (const member of members) {
      const memberId = typeof member.id === "string" ? member.id : "";
      if (!agentIds.has(memberId)) {
        problems.push({ file: "teams.yaml", detail: `${id} 的成员 "${memberId}" 不在 agents.yaml 里` });
      }
    }
    for (const grant of asRecordList(row.address)) {
      const from = typeof grant.from === "string" ? grant.from : "";
      if (!agentIds.has(from)) {
        problems.push({ file: "teams.yaml", detail: `${id} 的 address.from "${from}" 不在 agents.yaml 里` });
      }
      for (const to of Array.isArray(grant.to) ? grant.to : []) {
        if (!agentIds.has(String(to))) {
          problems.push({ file: "teams.yaml", detail: `${id} 的 address.to "${String(to)}" 不在 agents.yaml 里` });
        }
      }
    }
  }
  return rows.length;
}

/** Read `connectors.yaml` and check each host against its url. */
function readConnectors(filePath: string, problems: VerifyProblem[]): string[] {
  const doc = asRecord(parseYaml(readFileSync(filePath, "utf8")));
  const rows = asRecordList(doc.connectors);
  const ids: string[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const url = typeof row.url === "string" ? row.url : "";
    const host = typeof row.host === "string" ? row.host : "";
    ids.push(id);
    let parsedHost: string;
    try {
      parsedHost = new URL(url).host;
    } catch {
      problems.push({ file: "connectors.yaml", detail: `${id} 的 url 无法解析：${url}` });
      continue;
    }
    if (parsedHost !== host) {
      problems.push({ file: "connectors.yaml", detail: `${id} 的 host "${host}" 与 url 的 "${parsedHost}" 不一致` });
    }
    for (const field of ["title", "vendor", "auth", "credential_env", "source_url"]) {
      if (typeof row[field] !== "string" || String(row[field]).trim() === "") {
        problems.push({ file: "connectors.yaml", detail: `${id} 的 ${field} 缺失` });
      }
    }
  }
  return ids;
}

/**
 * Re-read an emitted directory and check it against the contract.
 *
 * Checks the things a schema cannot: that an agent's skill grants resolve, that a team's members exist,
 * that a connector's host matches its url, and that the manifest row count equals what the four lists
 * actually contain.
 */
export function verifyOutDir(outDir: string): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  for (const file of [...EMITTED_YAML_FILES, ...EMITTED_REPORT_FILES]) {
    if (!existsSync(join(outDir, file))) {
      problems.push({ file, detail: "文件不存在" });
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  const agents = readAgents(join(outDir, "agents.yaml"), problems);
  const skills = readSkills(join(outDir, "skills.yaml"), problems);
  const teamCount = readTeams(join(outDir, "teams.yaml"), new Set(agents.ids), problems);
  const connectorIds = readConnectors(join(outDir, "connectors.yaml"), problems);

  // 只要求“三类不全空”：读取端（readWorkBuddy）本来就允许任何一类缺席，只带专家或只带技能的
  // 包是合法产物；三类全空才说明这份输出什么能力都没有，等于什么都没移植。
  if (agents.ids.length === 0 && skills.slugs.length === 0 && connectorIds.length === 0) {
    problems.push({
      file: "agents.yaml",
      detail: "agents/skills/connectors 三类条目全空——这份输出没有任何能力，等于什么都没移植",
    });
  }

  const skillSlugs = new Set(skills.slugs);
  for (const slug of agents.skills) {
    if (!skillSlugs.has(slug)) {
      problems.push({ file: "agents.yaml", detail: `skills[] 引用了不存在的技能：${slug}` });
    }
  }

  const manifestDoc = parseYaml(readFileSync(join(outDir, "capability-manifest.yaml"), "utf8"));
  const manifestRows = asRecordList(manifestDoc);
  if (!Array.isArray(manifestDoc)) {
    problems.push({ file: "capability-manifest.yaml", detail: "根节点必须是序列" });
  }
  const violations = validateManifest(
    manifestRows.map((row) => row as unknown as Parameters<typeof validateManifest>[0][number]),
  );
  for (const violation of violations) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: `第 ${violation.index + 1} 行 ${violation.slug}.${violation.field}：${violation.problem}`,
    });
  }
  const expectedRows = agents.ids.length + skills.slugs.length + teamCount + connectorIds.length;
  if (manifestRows.length !== expectedRows) {
    problems.push({
      file: "capability-manifest.yaml",
      detail: `条目数 ${manifestRows.length} 与清单合计 ${expectedRows} 不一致`,
    });
  }
  const kinds = new Map<string, number>();
  for (const row of manifestRows) {
    const kind = String(row.kind);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const expectation: [string, number][] = [
    ["agent", agents.ids.length],
    ["skill", skills.slugs.length],
    ["team", teamCount],
    ["connector", connectorIds.length],
  ];
  for (const [kind, count] of expectation) {
    if ((kinds.get(kind) ?? 0) !== count) {
      problems.push({
        file: "capability-manifest.yaml",
        detail: `kind=${kind} 的条目数 ${kinds.get(kind) ?? 0} 与 ${count} 不一致`,
      });
    }
  }
  return problems;
}

/** Print a level breakdown as `full 12 / degraded 9 / blocked 2`. */
function formatCounts(counts: Record<RunnableLevel, number>): string {
  return `full ${counts.full} / degraded ${counts.degraded} / blocked ${counts.blocked}`;
}

/**
 * Survey the connector marketplace and write the census.
 *
 * Nothing here touches the source tree: one file is read, the directories are stat-ed, one YAML file is
 * written. That is what makes it safe to run in CI on every push.
 */
function runCensus(options: CliOptions): number {
  try {
    console.log(`[port:capabilities] census ${options.sourceRoot}`);
    const census = buildCensus(options.sourceRoot);
    mkdirSync(dirname(options.censusPath), { recursive: true });
    writeFileSync(options.censusPath, renderCensus(census), "utf8");
    console.log(`[port:capabilities] 普查 ${census.counts.total} 条：${formatCensusCounts(census)}`);
    console.log(
      `[port:capabilities] transport ${TRANSPORT_SUMMARY(census)}`,
    );
    console.log(`[port:capabilities] 写出 ${options.censusPath}`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CensusError) {
      console.error(`[port:capabilities] 普查失败：${error.message}`);
      return EXIT_INVALID;
    }
    throw error;
  }
}

/** `mcp-url 239 / mcp-command 15 / cli 44`, in report order. */
function TRANSPORT_SUMMARY(census: Census): string {
  return Object.entries(census.counts.by_transport)
    .map(([transport, count]) => `${transport} ${count}`)
    .join(" / ");
}

/**
 * Run the pipeline.
 *
 * Returns a process exit code instead of calling `process.exit`, so the tests can drive `main` directly
 * and a failure inside one stage still lets the caller see the message it printed.
 */
export function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[port:capabilities] ${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (options.verifyOnly) {
    const problems = verifyOutDir(options.outDir);
    if (problems.length > 0) {
      console.error(`[port:capabilities] verify 失败（${problems.length} 处）：`);
      for (const problem of problems) {
        console.error(`  - ${problem.file}: ${problem.detail}`);
      }
      return EXIT_INVALID;
    }
    console.log(`[port:capabilities] verify OK（${options.outDir}）`);
    return EXIT_OK;
  }
  if (options.census) {
    return runCensus(options);
  }

  try {
    console.log(`[port:capabilities] source ${options.sourceRoot}`);
    console.log(`[port:capabilities] only   ${options.scope}`);
    console.log(`[port:capabilities] out    ${options.outDir}`);

    const snapshot = readWorkBuddy({
      sourceRoot: options.sourceRoot,
      connectorAllowlist: CONNECTOR_ALLOWLIST,
    });
    console.log(
      `[port:capabilities] 读取 专家包 ${snapshot.packages.length} / 用户技能 ${snapshot.userSkills.length} / 连接器 ${snapshot.connectors.length}`,
    );

    const capabilities = normalizeCapabilities(snapshot);
    console.log(
      `[port:capabilities] 归一 agent ${capabilities.agents.length} / team ${capabilities.teams.length} / skill ${capabilities.skills.length} / connector ${capabilities.connectors.length}`,
    );
    if (capabilities.conflicts.length > 0) {
      console.log(
        `[port:capabilities] 同名冲突 ${capabilities.conflicts.length} 组：${capabilities.conflicts
          .map((conflict) => conflict.baseSlug)
          .join(", ")}`,
      );
    }
    if (capabilities.dropped.length > 0) {
      console.log(`[port:capabilities] 丢弃 ${capabilities.dropped.length} 项（见 slug-conflicts.md）`);
    }

    const connectorIds = new Set(capabilities.connectors.map((connector) => connector.id));
    const skillFindings = auditCapabilities(
      capabilities.skills.map((skill) => ({
        slug: skill.slug,
        instructions: skill.instructions,
        hasBundledReferences: skill.hasBundledReferences,
      })),
      connectorIds,
    );
    const agentFindings = auditCapabilities(
      capabilities.agents.map((agent) => ({
        slug: agent.id,
        instructions: agent.systemPrompt,
        hasBundledReferences: agent.hasBundledReferences,
      })),
      connectorIds,
    );
    console.log(`[port:capabilities] 审计 skill ${formatCounts(countByLevel(skillFindings))}`);
    console.log(`[port:capabilities] 审计 agent ${formatCounts(countByLevel(agentFindings))}`);

    const skillFindingIndex = indexFindings(skillFindings);
    const agentFindingIndex: Map<string, AuditFinding> = indexFindings(agentFindings);
    const manifest = buildManifest(capabilities, {
      skillFindings: skillFindingIndex,
      agentFindings: agentFindingIndex,
    });
    assertValidManifest(manifest);
    console.log(`[port:capabilities] manifest ${manifest.length} 条，9 字段齐备`);

    const emitted = emitPackage({
      outDir: options.outDir,
      capabilities,
      manifest,
      skillFindings,
      agentFindings,
    });
    console.log(`[port:capabilities] 写出 ${emitted.files.length} 个文件 → ${emitted.outDir}`);

    if (options.verify) {
      const problems = verifyOutDir(options.outDir);
      if (problems.length > 0) {
        console.error(`[port:capabilities] verify 失败（${problems.length} 处）：`);
        for (const problem of problems) {
          console.error(`  - ${problem.file}: ${problem.detail}`);
        }
        return EXIT_INVALID;
      }
      console.log("[port:capabilities] verify OK");
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof SourceLayoutError) {
      console.error(`[port:capabilities] 源目录不符合预期：${error.message}`);
      return EXIT_USAGE;
    }
    if (error instanceof Error) {
      console.error(`[port:capabilities] 失败：${error.message}`);
      return EXIT_INVALID;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
