/**
 * `bun run port:assemble` — P2 落位器：把 P0 管道（`bun run port:capabilities`）的产出并入品牌包。
 *
 *   bun run port:assemble -- --from <管道产出目录> --source ~/.workbuddy --package examples/xiongbao
 *
 * 与管道的分工：`port:capabilities` 是唯一的转换器（正文化、slug 归一、审计、manifest），本模块
 * 不重新做任何判断，只做"落位"——把生成物按 §3 的落点映射放进包的正确位置，并把落位过程中才
 * 能决定的三件事补齐：
 *
 *   1. `agents/*.yaml` 目录式拆分（PackageAgentFile 约定：一个员工一个文件）；
 *   2. 技能附件（`skills/<slug>/references/**` + `assets:` 声明，走 P1 的 skillAssets 契约）；
 *   3. 品牌包既有的 5 员工 / 5 技能补 `_porting` 审计块与 manifest 行，使整个包都带 §6.4 的
 *      来源与许可字段，`--verify` 才能对整个包成立。
 *
 * 纯函数纪律与管道相同：不读时钟、不写绝对路径、列表排序，跑两次产出的字节完全一致。
 * 永远不写 `brand.yaml`、`channels.yaml`、`model.yaml`、`knowledge.yaml`、`theme.css` 与既有
 * `agents.yaml`——前四个是品牌与部署的事实源，最后一个的 5 条种子员工必须原样保留。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { auditCapability } from "./audit-toolrefs";
import {
  applyMissingAssetDowngrade,
  findMissingAssetReferences,
  formatMissingAssetEvidence,
  MISSING_ASSET_RULE_ID,
} from "./asset-reachability";
import { renderManifestYaml } from "./emit-package";
import { assertValidManifest, type ManifestEntry } from "./manifest";
import {
  auditRulesSha256,
  CONNECTOR_ALLOWLIST,
  type RunnableLevel,
} from "./mapping";
import { sha256Hex } from "./normalize";
import { readWorkBuddy } from "./read-workbuddy";

/** CLI exit codes, same convention as `index.ts`. */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

/**
 * 单个附件文件的入仓上限（§4c 阈值 24KB，按单文件执行）。
 *
 * 超过上限的文件不进仓（部署侧也没有它的来源），逐个记进该技能 `_porting.dropped`，理由写明
 * 字节数——"静默少一个文件"与"静默少一条技能"是同一种事故。
 */
export const MAX_ASSET_BYTES = 24 * 1024;

/** 允许作为技能附件入仓的扩展名白名单，与 server 侧 `MEDIA_TYPES` 的可读类型一一对应。 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "html",
]);

/**
 * 品牌包既有条目的来源常量。它们不是移植来的，但 §6.4 要求包里的每条内容都带来源与许可字段，
 * 所以给它们一组诚实值：来源就是包自己，许可是品牌自己的。
 */
export const PACKAGE_SOURCE = "xiongbao-package";
export const PACKAGE_SOURCE_VERSION = "1";
/** 固定时刻而非时钟：包的种子内容没有"抓取时间"，用方案定稿日充当稳定值，保证幂等。 */
export const PACKAGE_EPOCH = "2026-11-12T00:00:00Z";
export const PACKAGE_LICENSE = "proprietary-xiongbao";
export const PACKAGE_ATTRIBUTION = "© 熊宝数字员工";

/**
 * 连接器认证方式的落位覆写。
 *
 * server 侧 `unsupportedPerUserConnectors`（ad5b738c）会拒绝"声明 `user-oauth` 但构建目录里没有
 * 条目"的连接器——平台提供不了逐用户 OAuth，原样写入会让不同用户的调用打到同一个账号上。
 * `tencent-docs` 不在本构建目录（`server/src/plugins/catalogue.ts` 无该 key），按 server 拒绝
 * 信息里指明的发布路径降级为 `deployment-bearer`（明确共享凭据）。`github` 在目录里有条目
 * （key: "github"），保持 `user-oauth`。
 *
 * 这张表是"目录知识"在落位侧的唯一声明处；品牌包加载测试用真实的 server 拒绝逻辑把这里钉住。
 */
export const AUTH_OVERRIDES: Readonly<
  Record<string, "deployment-bearer" | "none">
> = {
  "tencent-docs": "deployment-bearer",
};

/**
 * Display names for ported coworkers whose source names them by the author's handle rather than by
 * what they are: a person summoning one on 人才市场 reads a name, not a handle (召唤员工 Task 10). The
 * id, the portrait, the persona and the author's attribution in the manifest stay as they are.
 */
export const AGENT_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "xtgxiso-windows-pc-care": "电脑管家",
};

/**
 * The pipeline's row with its `AGENT_NAME_OVERRIDES` name: `name:`, and the system prompt's opening
 * `# <name>` heading, which the pipeline writes from the same name. Any other row is returned as is.
 */
export function withDisplayName(agent: AgentRow): AgentRow {
  const id = typeof agent.id === "string" ? agent.id : "";
  const name = AGENT_NAME_OVERRIDES[id];
  if (name === undefined) return agent;
  const prompt = agent.system_prompt;
  return {
    ...agent,
    name,
    ...(typeof prompt === "string" && typeof agent.name === "string"
      ? {
          system_prompt: prompt.replace(
            new RegExp(`^# ${escapeRegExp(agent.name)}$`, "m"),
            `# ${name}`,
          ),
        }
      : {}),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parsed command line for the assembler. */
export interface AssembleCliOptions {
  fromDir: string;
  sourceRoot: string;
  packageDir: string;
  help: boolean;
}

const USAGE = `用法：
  bun run port:assemble -- --from <管道产出目录> --source <WorkBuddy 主目录> --package <品牌包目录>

说明：
  读取 \`port:capabilities --out\` 的产出与 WorkBuddy 源目录（定位技能附件），把生成物落位进
  品牌包：agents/*.yaml 拆分、skills.yaml 合并（含 assets 声明）、teams/connectors/manifest/
  两份评审报告。brand.yaml、channels.yaml、model.yaml、knowledge.yaml、theme.css 与既有
  agents.yaml 不动。幂等：跑两次字节一致。`;

/** Thrown for a malformed command line or a source layout the assembler cannot place. */
export class AssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssembleError";
  }
}

/** Parse `--from/--source/--package`; every path is required, nothing is defaulted. */
export function parseAssembleArgs(argv: readonly string[]): AssembleCliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { fromDir: "", sourceRoot: "", packageDir: "", help: true };
  }
  const values: Record<string, string> = {};
  const known = new Set(["--from", "--source", "--package"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!known.has(flag)) {
      throw new AssembleError(`无法识别的参数：${flag}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new AssembleError(`${flag} 缺少取值`);
    }
    values[flag] = next;
    index += 1;
  }
  for (const flag of known) {
    if (!values[flag]) {
      throw new AssembleError(`缺少 ${flag}`);
    }
  }
  return {
    fromDir: values["--from"],
    sourceRoot: values["--source"],
    packageDir: values["--package"],
    help: false,
  };
}

/** One pipeline skill row as parsed from the emitted `skills.yaml`. */
type SkillRow = Record<string, unknown>;

/** One pipeline agent row as parsed from the emitted `agents.yaml`. */
type AgentRow = Record<string, unknown>;

/** What `readPipelineOutput` hands back. */
export interface PipelineOutput {
  agents: AgentRow[];
  skills: SkillRow[];
  teamsYaml: string;
  connectors: Record<string, unknown>[];
  manifestRows: ManifestEntry[];
  slugConflictsMd: string;
  toolRefAuditMd: string;
}

/** Cast a parsed YAML value to a record. */
function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssembleError(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** Cast a parsed YAML value to a list of records. */
function asRecordList(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new AssembleError(`${name} 必须是列表`);
  }
  return value.map((entry) => asRecord(entry, name));
}

/** Read and parse one emitted YAML file. */
function readYamlFile(path: string, name: string): Record<string, unknown> {
  return asRecord(parseYaml(readFileSync(path, "utf8")), name);
}

/** Read the pipeline's output directory. Nothing here judges; the emitter already did. */
export function readPipelineOutput(fromDir: string): PipelineOutput {
  const agentsDoc = readYamlFile(join(fromDir, "agents.yaml"), "agents.yaml");
  const skillsDoc = readYamlFile(join(fromDir, "skills.yaml"), "skills.yaml");
  const connectorsDoc = readYamlFile(
    join(fromDir, "connectors.yaml"),
    "connectors.yaml",
  );
  const manifestPath = join(fromDir, "capability-manifest.yaml");
  const manifestRaw = readFileSync(manifestPath, "utf8");
  const manifestParsed = parseYaml(manifestRaw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(manifestParsed)) {
    throw new AssembleError("capability-manifest.yaml 根节点必须是序列");
  }
  return {
    agents: asRecordList(agentsDoc.agents, "agents.yaml agents"),
    skills: asRecordList(skillsDoc.skills, "skills.yaml skills"),
    teamsYaml: readFileSync(join(fromDir, "teams.yaml"), "utf8"),
    connectors: asRecordList(
      connectorsDoc.connectors,
      "connectors.yaml connectors",
    ),
    manifestRows: manifestParsed as ManifestEntry[],
    slugConflictsMd: readFileSync(join(fromDir, "slug-conflicts.md"), "utf8"),
    toolRefAuditMd: readFileSync(join(fromDir, "tool-ref-audit.md"), "utf8"),
  };
}

/** One attachment a skill ships into the package, as `loadSkillAssetFiles` will re-read it. */
export interface ReferenceAsset {
  /** Path relative to `skills/<slug>/`, e.g. `references/patterns/step-3.md`. */
  path: string;
  content: string;
  bytes: number;
  checksum: string;
}

/** The attachment plan for one skill: what ships and what was refused, with reasons. */
export interface SkillAssetPlan {
  slug: string;
  assets: ReferenceAsset[];
  dropped: string[];
}

/** Recursively collect the text attachments under one `references/` directory. */
function collectReferenceFiles(
  directory: string,
  prefix: string,
  plan: { assets: ReferenceAsset[]; dropped: string[] },
): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectReferenceFiles(join(directory, entry.name), relative, plan);
      continue;
    }
    const extension = entry.name.includes(".")
      ? (entry.name.split(".").pop() ?? "").toLowerCase()
      : "";
    if (!TEXT_EXTENSIONS.has(extension)) {
      plan.dropped.push(
        `references/${relative}（非文本附件，skill_assets 无载体）`,
      );
      continue;
    }
    const content = readFileSync(join(directory, entry.name), "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_ASSET_BYTES) {
      plan.dropped.push(
        `references/${relative}（${(bytes / 1024).toFixed(1)}KB，超过单文件 ${MAX_ASSET_BYTES / 1024}KB 入仓上限）`,
      );
      continue;
    }
    plan.assets.push({
      path: `references/${relative}`,
      content,
      bytes,
      checksum: sha256Hex(content),
    });
  }
}

/**
 * Build the attachment plan for every pipeline skill that ships a `references/` directory.
 *
 * The pipeline does not carry file contents (its output must stay a pure function of the source
 * tree's shape), so the assembler re-locates each skill by its `checksum_sha256` — the same
 * `sha256Hex(SKILL.md text)` the pipeline recorded — and reads the files from there. A skill that
 * declares attachments but cannot be found is an error, not a silent empty plan: shipping a skill
 * whose `Read references/…` steps resolve to nothing is the "文件在、点了没反应" failure §1 forbids.
 */
export function buildAssetPlans(
  skills: readonly SkillRow[],
  sourceRoot: string,
): Map<string, SkillAssetPlan> {
  const snapshot = readWorkBuddy({
    sourceRoot,
    connectorAllowlist: CONNECTOR_ALLOWLIST,
  });
  const rawByChecksum = new Map<string, string>();
  for (const raw of [
    ...snapshot.userSkills,
    ...snapshot.packages.flatMap((pkg) => pkg.skills),
  ]) {
    const checksum = sha256Hex(raw.skillMd.text);
    if (!rawByChecksum.has(checksum)) {
      rawByChecksum.set(checksum, dirname(raw.skillMd.absolutePath));
    }
  }
  const plans = new Map<string, SkillAssetPlan>();
  for (const skill of skills) {
    const slug = typeof skill.slug === "string" ? skill.slug : "";
    const porting = asRecord(
      skill._porting ?? {},
      `skills.yaml ${slug} _porting`,
    );
    const refsBytes =
      typeof porting.refs_bytes === "number" ? porting.refs_bytes : 0;
    if (refsBytes <= 0) continue;
    const checksum =
      typeof porting.checksum_sha256 === "string"
        ? porting.checksum_sha256
        : "";
    const skillDirectory = rawByChecksum.get(checksum);
    if (!skillDirectory) {
      throw new AssembleError(
        `技能 ${slug} 声明附件（refs_bytes=${refsBytes}），但源目录里找不到 checksum 相符的 SKILL.md，无法落位附件`,
      );
    }
    const referencesDirectory = join(skillDirectory, "references");
    if (!existsSync(referencesDirectory)) {
      // The byte count said there were attachments; a missing directory would be a source
      // inconsistency. Refuse rather than ship a skill whose manifest promises files that do not exist.
      throw new AssembleError(
        `技能 ${slug} 的源目录缺 references/（refs_bytes=${refsBytes}）：${skillDirectory}`,
      );
    }
    const plan: SkillAssetPlan = { slug, assets: [], dropped: [] };
    collectReferenceFiles(referencesDirectory, "", plan);
    plans.set(slug, plan);
  }
  return plans;
}

/** The audit input for a package-seeded skill or agent: its prose, no bundled references. */
function auditLevel(
  slug: string,
  instructions: string,
  connectorIds: ReadonlySet<string>,
): RunnableLevel {
  return auditCapability(
    { slug, instructions, hasBundledReferences: false },
    connectorIds,
  ).level;
}

/**
 * The `_porting` block the assembler synthesises for a package-seeded skill, as YAML text at the
 * indentation the merged `skills.yaml` uses.
 *
 * Seeds are merged TEXTUALLY (their comments — licence attributions included — survive verbatim), so
 * the block is rendered as lines rather than serialised through a parsed object, and injected right
 * after the entry's `tools:` line: the same key order the generated rows use, one clean insertion,
 * nothing else in the seed text touched.
 */
export interface SeedPortingMeta {
  runnable: RunnableLevel;
  checksum: string;
}

export function renderSeedPortingLines(meta: SeedPortingMeta): string[] {
  return [
    "    _porting:",
    `      source: ${PACKAGE_SOURCE}`,
    `      source_url: ${PACKAGE_SOURCE}/skills.yaml`,
    `      source_version: "${PACKAGE_SOURCE_VERSION}"`,
    `      fetched_at: "${PACKAGE_EPOCH}"`,
    `      checksum_sha256: ${meta.checksum}`,
    `      license: ${PACKAGE_LICENSE}`,
    "      redistributable: true",
    `      attribution: ${PACKAGE_ATTRIBUTION}`,
    "      declared_tools: []",
    `      runnable: ${meta.runnable}`,
    "      dropped: []",
    "      refs_bytes: 0",
  ];
}

/**
 * Insert the synthesised `_porting` block into every seed entry that lacks one.
 *
 * Two passes so the skip-check sees the WHOLE entry before deciding: the first pass finds each
 * entry's boundaries and whether it already carries a `    _porting:` line (a previous assemble run
 * — skipping it is what makes the merge idempotent), and where its `tools:` line sits; the second
 * pass inserts the block directly after `tools:`, which every seed entry carries and which sits
 * before any inter-entry comment, so no existing line moves and no comment is re-attributed.
 */
export function insertSeedPortingBlocks(
  raw: string,
  metaBySlug: ReadonlyMap<string, SeedPortingMeta>,
): string {
  const lines = raw.split("\n");
  type Insertion = { afterLine: number; meta: SeedPortingMeta };
  const insertions: Insertion[] = [];
  let currentSlug = "";
  let entryHasPorting = false;
  let toolsLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const slugMatch = /^ {2}- slug: (.+)$/.exec(line);
    if (slugMatch) {
      currentSlug = slugMatch[1].trim();
      entryHasPorting = false;
      toolsLine = -1;
      continue;
    }
    if (currentSlug === "") continue;
    if (/^ {4}_porting:$/.test(line)) {
      entryHasPorting = true;
    }
    if (toolsLine === -1 && /^ {4}tools:/.test(line)) {
      toolsLine = index;
    }
    // The next entry's `  - slug:` closes this one; the meta lookup above already ran, so decide now.
    const next = lines[index + 1] ?? "";
    if (/^ {2}- slug: /.test(next) || index === lines.length - 1) {
      const meta = metaBySlug.get(currentSlug);
      if (meta !== undefined && !entryHasPorting && toolsLine !== -1) {
        insertions.push({ afterLine: toolsLine, meta });
      }
    }
  }
  if (insertions.length === 0) {
    return raw;
  }
  const byLine = new Map(
    insertions.map((insertion) => [insertion.afterLine, insertion.meta]),
  );
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    output.push(lines[index]);
    const meta = byLine.get(index);
    if (meta !== undefined) {
      output.push(...renderSeedPortingLines(meta));
    }
  }
  return output.join("\n");
}

/**
 * Remove the text blocks of previously generated entries from the package's `skills.yaml`.
 *
 * Re-runs are the norm, so the file already contains generated rows: a row whose `_porting.source`
 * is not {@link PACKAGE_SOURCE} is a previous run's output, and its whole block (from its
 * `  - slug:` line to the next one) goes before the fresh rows are appended — the pipeline output is
 * the sole source of truth for it. Seed blocks, comments included, are never touched.
 */
export function stripGeneratedSkillBlocks(
  raw: string,
  slugs: ReadonlySet<string>,
): string {
  if (slugs.size === 0) return raw;
  const lines = raw.split("\n");
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const match = /^ {2}- slug: (.+)$/.exec(line);
    if (match) {
      skipping = slugs.has(match[1].trim());
    }
    if (!skipping) {
      output.push(line);
    }
  }
  return output.join("\n");
}

/**
 * A verdict the assembler lowered because the body points at attachments that did not ship.
 *
 * Why this lives in the assembler and not in the audit: the audit runs in P0, before any attachment
 * decision exists. Only here are both refusals in hand — P0's directory list (inherited on the skill row)
 * and P1's per-file list (`SkillAssetPlan.dropped`). A verdict that ignores either one lies about what the
 * reader will find.
 */
export interface AssetDowngrade {
  slug: string;
  runnable: RunnableLevel;
  /** Rule id recorded as `_porting.reason`. */
  reason: string;
  /** Human-readable evidence recorded as `_porting.reason_ref`. */
  reasonRef: string;
}

/**
 * Lower `full` to `degraded` for every skill whose body names a path the package does not contain.
 *
 * Only `full` moves (see {@link applyMissingAssetDowngrade}): a `blocked` skill already tells the reader
 * not to rely on it, and rewriting it here would erase the licence reason it was blocked for.
 */
export function computeAssetDowngrades(input: {
  skills: readonly SkillRow[];
  plans: ReadonlyMap<string, SkillAssetPlan>;
}): Map<string, AssetDowngrade> {
  const downgrades = new Map<string, AssetDowngrade>();
  for (const skill of input.skills) {
    const slug = String(skill.slug);
    const instructions =
      typeof skill.instructions === "string" ? skill.instructions : "";
    if (instructions === "") continue;
    const porting = asRecord(
      skill._porting ?? {},
      `${slug} _porting`,
    );
    const inheritedDropped = Array.isArray(porting.dropped)
      ? (porting.dropped as string[])
      : [];
    const plan = input.plans.get(slug);
    // During assembly the plan is the truth; when this runs against an already-assembled package the
    // plan is absent and the row's own `assets:` field carries the same fact. Falling back keeps the
    // judgement identical in both directions instead of reporting every references/ as missing.
    const assets =
      plan !== undefined
        ? plan.assets.map((asset) => asset.path)
        : Array.isArray(skill.assets)
          ? skill.assets.map((asset) => String(asset))
          : [];
    const missing = findMissingAssetReferences({
      instructions,
      dropped: [...inheritedDropped, ...(plan?.dropped ?? [])],
      assets,
    });
    if (missing.length === 0) continue;
    const current = porting.runnable === "degraded" || porting.runnable === "blocked"
      ? porting.runnable
      : "full";
    const next = applyMissingAssetDowngrade(current, missing);
    if (next === current) continue;
    downgrades.set(slug, {
      slug,
      runnable: next,
      reason: MISSING_ASSET_RULE_ID,
      reasonRef: formatMissingAssetEvidence(missing),
    });
  }
  return downgrades;
}

/**
 * Apply a downgrade to a `_porting` record, keeping `reason`/`reason_ref` directly under `runnable`.
 *
 * The position matters only for readability, but the merge does too: a row that already carries a reason
 * keeps it, and this rule is appended rather than replacing the audit's own finding.
 */
function applyDowngrade(
  porting: Record<string, unknown>,
  downgrade: AssetDowngrade,
): Record<string, unknown> {
  const previousReason =
    typeof porting.reason === "string" && porting.reason !== ""
      ? porting.reason
      : undefined;
  const previousRef =
    typeof porting.reason_ref === "string" && porting.reason_ref !== ""
      ? porting.reason_ref
      : undefined;
  const reason =
    previousReason === undefined
      ? downgrade.reason
      : `${previousReason}+${downgrade.reason}`;
  const reasonRef =
    previousRef === undefined
      ? downgrade.reasonRef
      : `${previousRef}；${downgrade.reasonRef}`;

  const output: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(porting)) {
    if (key === "reason" || key === "reason_ref") continue;
    output[key] = key === "runnable" ? downgrade.runnable : value;
    if (key === "runnable") {
      output.reason = reason;
      output.reason_ref = reasonRef;
      placed = true;
    }
  }
  if (!placed) {
    output.runnable = downgrade.runnable;
    output.reason = reason;
    output.reason_ref = reasonRef;
  }
  return output;
}

/**
 * Apply the verdict downgrades to the manifest rows.
 *
 * The manifest and `skills.yaml` are read by different consumers, so they cannot disagree about a
 * verdict: a row that still says `full` while the YAML says `degraded` is the same lie told twice.
 * Only `skill` rows are touched — the map is keyed by skill slug.
 */
export function applyVerdictDowngrades(
  rows: readonly ManifestEntry[],
  downgrades: ReadonlyMap<string, AssetDowngrade>,
): ManifestEntry[] {
  if (downgrades.size === 0) return [...rows];
  return rows.map((row) => {
    if (row.kind !== "skill") return row;
    const downgrade = downgrades.get(row.slug);
    return downgrade === undefined
      ? row
      : { ...row, runnable: downgrade.runnable };
  });
}

/** One generated entry as list-item text, with its `assets:` and attachment refusals merged in. */
export function renderGeneratedSkillEntry(
  skill: SkillRow,
  plan: SkillAssetPlan | undefined,
  downgrade?: AssetDowngrade,
): string {
  const rawPorting = asRecord(
    { ...(skill._porting as Record<string, unknown>) },
    `${String(skill.slug)} _porting`,
  );
  const dropped = Array.isArray(rawPorting.dropped)
    ? [...(rawPorting.dropped as string[])]
    : [];
  if (plan) {
    dropped.push(...plan.dropped);
  }
  rawPorting.dropped = dropped;
  const porting =
    downgrade === undefined ? rawPorting : applyDowngrade(rawPorting, downgrade);
  const entry: Record<string, unknown> = {
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
    tools: Array.isArray(skill.tools) ? skill.tools : [],
    ...(plan && plan.assets.length > 0
      ? { assets: plan.assets.map((asset) => asset.path) }
      : {}),
    _porting: porting,
  };
  const text = stringifyYaml(entry, { lineWidth: 0 }).trimEnd();
  // The first line carries the list dash; every following line must align with the mapping's keys
  // (two extra spaces), or the entry stops being one mapping and stops parsing.
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`))
    .join("\n");
}

/**
 * The merged `skills.yaml`, built textually.
 *
 * The seed text survives verbatim — including the per-entry comments that carry licence
 * attributions and tooling guidance, which a parse-and-restringify would silently drop. Only two
 * kinds of lines are added: the synthesised `_porting` block under each seed entry, and the
 * generated entries after the seed ones. Deterministic, and byte-identical across runs.
 */
export function mergeSkillsYaml(options: {
  legacySkillsRaw: string;
  packageSkills: readonly SkillRow[];
  generatedSkills: readonly SkillRow[];
  plans: ReadonlyMap<string, SkillAssetPlan>;
  connectorIds: ReadonlySet<string>;
  /** Verdicts lowered because the body names attachments that did not ship. */
  downgrades?: ReadonlyMap<string, AssetDowngrade>;
}): string {
  const { legacySkillsRaw, packageSkills, generatedSkills, plans } = options;
  const generatedSlugs = new Set(
    generatedSkills.map((skill) => String(skill.slug)),
  );
  const seedRows = partitionSeedSkills(packageSkills);
  const seedSlugs = new Set(seedRows.map((skill) => String(skill.slug)));
  for (const slug of seedSlugs) {
    if (generatedSlugs.has(slug)) {
      throw new AssembleError(
        `技能 slug 冲突：既有种子技能 ${slug} 与管道产出重名`,
      );
    }
  }
  const previousGeneratedSlugs = packageSkills
    .filter((skill) => !seedSlugs.has(String(skill.slug)))
    .map((skill) => String(skill.slug));

  let merged = stripGeneratedSkillBlocks(
    legacySkillsRaw,
    new Set([...generatedSlugs, ...previousGeneratedSlugs]),
  );
  const seedMeta = new Map<string, SeedPortingMeta>();
  for (const skill of seedRows) {
    const slug = String(skill.slug);
    const instructions =
      typeof skill.instructions === "string" ? skill.instructions : "";
    seedMeta.set(slug, {
      runnable: auditLevel(slug, instructions, options.connectorIds),
      checksum: sha256Hex(instructions),
    });
  }
  merged = insertSeedPortingBlocks(merged, seedMeta);
  if (!merged.endsWith("\n")) {
    merged = `${merged}\n`;
  }
  const generatedText = generatedSkills
    .map((skill) =>
      renderGeneratedSkillEntry(
        skill,
        plans.get(String(skill.slug)),
        options.downgrades?.get(String(skill.slug)),
      ),
    )
    .join("\n");
  return generatedText === "" ? merged : `${merged}${generatedText}\n`;
}

/** The manifest row the assembler synthesises for a package-seeded entry. */
export function legacyManifestRow(input: {
  kind: "agent" | "skill";
  slug: string;
  sourceUrl: string;
  text: string;
  runnable: RunnableLevel;
}): ManifestEntry {
  return {
    kind: input.kind,
    slug: input.slug,
    ...(input.kind === "skill" ? { slug_source: "raw" as const } : {}),
    source: PACKAGE_SOURCE,
    source_url: input.sourceUrl,
    source_version: PACKAGE_SOURCE_VERSION,
    fetched_at: PACKAGE_EPOCH,
    checksum_sha256: sha256Hex(input.text),
    license: PACKAGE_LICENSE,
    redistributable: true,
    attribution: PACKAGE_ATTRIBUTION,
    runnable: input.runnable,
    dropped: [],
  };
}

/** The brand package's own declarations, as the assembler needs them. */
export interface LegacyPackage {
  /** Raw `skills.yaml` text — merged verbatim, seed comments and formatting included. */
  skillsRaw: string;
  /** Every row the file currently declares: seeds and any previous run's generated rows. */
  legacySkills: SkillRow[];
  legacyAgents: AgentRow[];
}

/**
 * The brand package's seed entries, separated from whatever a previous assemble run left behind.
 *
 * Re-runs are the norm (the package is regenerated whenever the pipeline output changes), so the
 * package's `skills.yaml` already contains generated rows when the assembler reads it. A row whose
 * `_porting.source` is {@link PACKAGE_SOURCE} is a seed (or a seed the assembler already stamped);
 * anything else with a `_porting` block is a previous run's generated row and is discarded — the
 * pipeline output is the sole source of truth for it. A row without `_porting` is a seed that has
 * never been assembled.
 */
export function partitionSeedSkills(skills: readonly SkillRow[]): SkillRow[] {
  return skills.filter((skill) => {
    const porting = skill._porting;
    if (porting === undefined || porting === null) return true;
    if (typeof porting !== "object" || Array.isArray(porting)) return true;
    return (porting as Record<string, unknown>).source === PACKAGE_SOURCE;
  });
}

/**
 * Read the brand package's own declarations: the verbatim `skills.yaml` text (seed comments and
 * formatting included), its parsed rows (seeds AND any previous run's generated rows — callers
 * partition with {@link partitionSeedSkills}), and the seed agents in `agents.yaml`.
 *
 * Only these two files are read; `brand.yaml`, `channels.yaml`, `model.yaml`, `knowledge.yaml` and
 * `theme.css` are never touched.
 */
export function readLegacyPackage(packageDir: string): LegacyPackage {
  const skillsRaw = readFileSync(join(packageDir, "skills.yaml"), "utf8");
  const skillsDoc = readYamlFile(
    join(packageDir, "skills.yaml"),
    "skills.yaml",
  );
  const agentsDoc = readYamlFile(
    join(packageDir, "agents.yaml"),
    "agents.yaml",
  );
  return {
    skillsRaw,
    legacySkills: asRecordList(skillsDoc.skills, "skills.yaml skills"),
    legacyAgents: asRecordList(agentsDoc.agents, "agents.yaml agents"),
  };
}

/** Serialise a document the same way the emitter does, so regeneration does not rewrap prose. */
function toYaml(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

/**
 * The hand-written fields of an existing `agents/<id>.yaml` -- `portrait:` and `persona:` -- merged
 * into the pipeline's row. The pipeline knows neither, so without this a re-run silently drops them
 * and the next package sync clears the preset portrait and persona. Placed where the committed files
 * keep them (portrait after avatar_seed, persona after system_prompt) so a second run is byte-identical.
 */
export function keepAuthoredAgentFields(
  agent: AgentRow,
  existingText: string | null,
): AgentRow {
  if (existingText === null) return agent;
  const existing = parseYaml(existingText) as Record<string, unknown> | null;
  const kept: Record<string, unknown> = {};
  for (const key of ["portrait", "persona"]) {
    if (existing?.[key] !== undefined && agent[key] === undefined) {
      kept[key] = existing[key];
    }
  }
  if (Object.keys(kept).length === 0) return agent;
  const after: Record<string, string> = {
    portrait: "avatar_seed",
    persona: "system_prompt",
  };
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent)) {
    merged[key] = value;
    for (const [field, anchor] of Object.entries(after)) {
      if (key === anchor && field in kept) merged[field] = kept[field];
    }
  }
  for (const [field, value] of Object.entries(kept)) {
    if (!(field in merged)) merged[field] = value;
  }
  return merged as AgentRow;
}

/** One `agents/<id>.yaml` file: the single-coworker form the PackageAgentFile contract accepts. */
export function renderAgentFile(agent: AgentRow): string {
  const id = typeof agent.id === "string" ? agent.id : "";
  if (!id) {
    throw new AssembleError(
      "管道产出的 agent 缺少 id，无法落位为 agents/<id>.yaml",
    );
  }
  return `# 由 bun run port:assemble 落位；来源与许可见 capability-manifest.yaml。\n${toYaml(agent)}`;
}

/**
 * The package's `connectors.yaml`: the pipeline's rows with `AUTH_OVERRIDES` applied.
 *
 * The override is stated as a comment beside the connector it touches, so a reviewer reading the
 * file sees the decision and its reason without opening the assembler.
 */
export function renderPackageConnectorsYaml(
  connectors: readonly Record<string, unknown>[],
): string {
  const lines: string[] = [
    "# 由 bun run port:assemble 从管道产出落位。auth 的取值以本构建的目录为准：",
    "# 声明 user-oauth 的连接器必须在 server/src/plugins/catalogue.ts 有条目（ad5b738c 的拒绝逻辑），",
    "# 否则平台无法提供逐用户 OAuth，会在包加载时拒绝。降级一律写明原因。",
    "connectors:",
  ];
  for (const connector of connectors) {
    const id = typeof connector.id === "string" ? connector.id : "";
    const override = AUTH_OVERRIDES[id];
    const row: Record<string, unknown> = { ...connector };
    if (override !== undefined) {
      row.auth = override;
      lines.push(
        `  # ${id} 不在本构建目录（无逐用户 OAuth），按 server 拒绝信息指明的发布路径降级为 ${override}（明确共享凭据）。`,
      );
    }
    const rowText = stringifyYaml(row, { lineWidth: 0 }).trimEnd();
    lines.push(
      rowText
        .split("\n")
        .map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`))
        .join("\n"),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Everything the assembler wrote, for the run log and the tests. */
export interface AssembleResult {
  agentFiles: string[];
  mergedSkills: number;
  assetFiles: number;
  assetDropped: number;
  /** Skills whose verdict dropped from `full` to `degraded` because the body cites absent attachments. */
  assetDowngraded: number;
  connectors: number;
  teams: number;
  manifestRows: number;
  files: string[];
}

/**
 * Place the pipeline output into the brand package.
 *
 * Fails before writing anything when the two halves disagree (a slug or agent id collision, an
 * attachment whose source cannot be found), so a failed run cannot leave a half-merged package.
 */
export function assemblePackage(options: {
  fromDir: string;
  sourceRoot: string;
  packageDir: string;
}): AssembleResult {
  const pipeline = readPipelineOutput(options.fromDir);
  const legacy = readLegacyPackage(options.packageDir);
  const seedSkills = partitionSeedSkills(legacy.legacySkills);
  const connectorIds = new Set(
    pipeline.connectors.map((connector) => String(connector.id)),
  );

  const generatedAgentIds = pipeline.agents.map((agent) => String(agent.id));
  const legacyAgentIds = legacy.legacyAgents.map((agent) => String(agent.id));
  const duplicatedAgent = generatedAgentIds.find((id) =>
    legacyAgentIds.includes(id),
  );
  if (duplicatedAgent !== undefined) {
    throw new AssembleError(
      `agent id 冲突：既有种子员工 ${duplicatedAgent} 与管道产出重名`,
    );
  }

  const plans = buildAssetPlans(pipeline.skills, options.sourceRoot);
  // The pipeline's verdict knew nothing about attachment refusals — P0 ran before P1 decided what to
  // carry. Both lists only meet here, so this is the one place the final verdict can be honest.
  const downgrades = computeAssetDowngrades({ skills: pipeline.skills, plans });
  const skillsYaml = mergeSkillsYaml({
    legacySkillsRaw: legacy.skillsRaw,
    packageSkills: legacy.legacySkills,
    generatedSkills: pipeline.skills,
    plans,
    connectorIds,
    downgrades,
  });

  // The manifest covers the WHOLE package, not just the port: `--verify` cross-checks its row count
  // against what the package declares, and §6.4 wants every shipped row to carry its licence fields.
  const legacyRows: ManifestEntry[] = [];
  for (const agent of legacy.legacyAgents) {
    const id = String(agent.id);
    const systemPrompt =
      typeof agent.system_prompt === "string" ? agent.system_prompt : "";
    legacyRows.push(
      legacyManifestRow({
        kind: "agent",
        slug: id,
        sourceUrl: `${PACKAGE_SOURCE}/agents.yaml`,
        text: systemPrompt,
        runnable: auditLevel(id, systemPrompt, connectorIds),
      }),
    );
  }
  for (const skill of seedSkills) {
    const slug = String(skill.slug);
    const instructions =
      typeof skill.instructions === "string" ? skill.instructions : "";
    legacyRows.push(
      legacyManifestRow({
        kind: "skill",
        slug,
        sourceUrl: `${PACKAGE_SOURCE}/skills.yaml`,
        text: instructions,
        runnable: auditLevel(slug, instructions, connectorIds),
      }),
    );
  }
  // The manifest and `skills.yaml` must not disagree about a verdict: a reader who trusts the manifest
  // would see `full` for a skill the YAML already downgraded, which is the same lie in a second place.
  const manifestRows = applyVerdictDowngrades(
    [...legacyRows, ...pipeline.manifestRows],
    downgrades,
  );
  assertValidManifest(manifestRows);

  const written: string[] = [];
  const write = (relativePath: string, content: string): void => {
    const path = join(options.packageDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    written.push(relativePath);
  };

  const agentFiles: string[] = [];
  for (const agent of pipeline.agents) {
    const id = String(agent.id);
    const agentPath = join(options.packageDir, "agents", `${id}.yaml`);
    const existing = existsSync(agentPath)
      ? readFileSync(agentPath, "utf8")
      : null;
    write(
      join("agents", `${id}.yaml`),
      renderAgentFile(
        keepAuthoredAgentFields(withDisplayName(agent), existing),
      ),
    );
    agentFiles.push(id);
  }
  write("skills.yaml", skillsYaml);
  write("teams.yaml", pipeline.teamsYaml);
  write("connectors.yaml", renderPackageConnectorsYaml(pipeline.connectors));
  write("capability-manifest.yaml", renderManifestYaml(manifestRows));
  write("slug-conflicts.md", pipeline.slugConflictsMd);
  write("tool-ref-audit.md", pipeline.toolRefAuditMd);
  let assetFiles = 0;
  let assetDropped = 0;
  for (const plan of plans.values()) {
    for (const asset of plan.assets) {
      write(join("skills", plan.slug, asset.path), asset.content);
      assetFiles += 1;
    }
    assetDropped += plan.dropped.length;
  }
  return {
    agentFiles,
    mergedSkills: pipeline.skills.length + seedSkills.length,
    assetFiles,
    assetDropped,
    assetDowngraded: downgrades.size,
    connectors: pipeline.connectors.length,
    teams: asRecordList(
      asRecord(parseYaml(pipeline.teamsYaml), "teams.yaml").teams,
      "teams.yaml teams",
    ).length,
    manifestRows: manifestRows.length,
    files: written,
  };
}

/** CLI entry point; returns a process exit code so tests can drive `main` directly. */
export function main(argv: readonly string[]): number {
  let options: AssembleCliOptions;
  try {
    options = parseAssembleArgs(argv);
  } catch (error) {
    if (error instanceof AssembleError) {
      console.error(`[port:assemble] ${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  try {
    const result = assemblePackage({
      fromDir: options.fromDir,
      sourceRoot: options.sourceRoot,
      packageDir: options.packageDir,
    });
    console.log(
      `[port:assemble] 落位 agent 文件 ${result.agentFiles.length} / 合并技能 ${result.mergedSkills} / ` +
        `附件 ${result.assetFiles} 个（丢弃 ${result.assetDropped}）/ 团 ${result.teams} / ` +
        `连接器 ${result.connectors} / manifest ${result.manifestRows} 行`,
    );
    if (result.assetDowngraded > 0) {
      console.log(
        `[port:assemble] 档位下调 ${result.assetDowngraded} 项（full→degraded：正文引用未入包附件）`,
      );
    }
    console.log(
      `[port:assemble] 写出 ${result.files.length} 个文件 → ${options.packageDir}`,
    );
    console.log(
      `[port:assemble] 规则集 audit_rules_sha256: ${auditRulesSha256()}`,
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof AssembleError) {
      console.error(`[port:assemble] 失败：${error.message}`);
      return EXIT_INVALID;
    }
    if (error instanceof Error) {
      console.error(`[port:assemble] 失败：${error.message}`);
      return EXIT_INVALID;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
