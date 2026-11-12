/**
 * Writes the tenant-package fragments and the two review reports.
 *
 * Five YAML files are the port's output contract (`agents.yaml`, `skills.yaml`, `teams.yaml`,
 * `connectors.yaml`, `capability-manifest.yaml`); two Markdown files are for the human who has to sign
 * off on it (`slug-conflicts.md`, `tool-ref-audit.md`).
 *
 * Two invariants are enforced here rather than trusted:
 *
 *   - A connector's `host` must equal the authority parsed out of its `url`. The compiler cannot see a
 *     typo in a hand-written host, and a wrong host in `mcp_servers` is an employee whose tools fail at
 *     call time instead of at load time.
 *   - Key order is fixed by building plain objects in order, never by sorting at serialise time, so a
 *     regenerated file differs only where a value differs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

import type { AuditFinding } from "./audit-toolrefs";
import { countByLevel } from "./audit-toolrefs";
import type { ManifestEntry } from "./manifest";
import type { NormalizedCapabilities } from "./normalize";

/** The five contract files, in the order they are written. */
export const EMITTED_YAML_FILES = [
  "agents.yaml",
  "skills.yaml",
  "teams.yaml",
  "connectors.yaml",
  "capability-manifest.yaml",
] as const;

/** The two review reports. */
export const EMITTED_REPORT_FILES = ["slug-conflicts.md", "tool-ref-audit.md"] as const;

/** Options for `emitPackage`. */
export interface EmitOptions {
  /** Directory to write into; created when missing. */
  outDir: string;
  capabilities: NormalizedCapabilities;
  manifest: readonly ManifestEntry[];
  skillFindings: readonly AuditFinding[];
  agentFindings: readonly AuditFinding[];
}

/** What one emit produced. */
export interface EmitResult {
  outDir: string;
  files: string[];
}

/** Serialise a document with no line folding, so regenerating does not rewrap prose. */
function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

/** Escape a cell for a Markdown table. */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Refuse to write a connector whose declared host disagrees with its URL.
 *
 * Throws rather than warns: `connectors.yaml` is consumed by the server, and a mismatch there means the
 * MCP server is registered under a host nobody can reach.
 */
export function assertConnectorHosts(capabilities: NormalizedCapabilities): void {
  const problems: string[] = [];
  for (const connector of capabilities.connectors) {
    let parsedHost: string;
    try {
      parsedHost = new URL(connector.url).host;
    } catch {
      problems.push(`${connector.id}: url 无法解析 (${connector.url})`);
      continue;
    }
    if (parsedHost !== connector.host) {
      problems.push(`${connector.id}: host="${connector.host}" 与 url 的 authority "${parsedHost}" 不一致`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`connectors.yaml 校验失败：\n${problems.map((line) => `  - ${line}`).join("\n")}`);
  }
}

/** `agents.yaml` — one entry per employee, key order fixed by the tenant-package contract. */
export function renderAgentsYaml(capabilities: NormalizedCapabilities): string {
  const agents = capabilities.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    title: agent.title,
    role_description: agent.roleDescription,
    avatar_seed: agent.avatarSeed,
    type: agent.type,
    system_prompt: agent.systemPrompt,
    skills: [...agent.skills],
  }));
  return toYaml({ agents });
}

/**
 * `skills.yaml` — instructions plus the `_porting` block.
 *
 * `tools` is always `[]` in P0. A WorkBuddy `allowed-tools` entry such as `Bash(git:*)` has no mechanical
 * equivalent in openbot's `<serverId>/<toolName>` namespace, and emitting a guess would create a tool
 * reference that resolves to nothing at turn time. The raw declarations are preserved under
 * `_porting.declared_tools` so P3's mapping layer has the input it needs.
 */
export function renderSkillsYaml(
  capabilities: NormalizedCapabilities,
  skillFindings: ReadonlyMap<string, AuditFinding>,
): string {
  const skills = capabilities.skills.map((skill) => ({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
    tools: [] as string[],
    _porting: {
      source: skill.provenance.source,
      source_url: skill.provenance.sourceUrl,
      source_version: skill.provenance.sourceVersion,
      fetched_at: skill.provenance.fetchedAt,
      checksum_sha256: skill.provenance.checksum,
      license: skill.provenance.license,
      redistributable: skill.provenance.redistributable,
      attribution: skill.provenance.attribution,
      declared_tools: [...skill.declaredTools],
      runnable: skillFindings.get(skill.slug)?.level ?? "full",
      dropped: [...skill.dropped],
      /**
       * Bytes under `references/`. Not an openbot field: it is the number that decides whether P2 can
       * inline the references into `instructions` (the 24KB threshold in §4c) or has to ship the
       * `skill_assets` + `skills/read` channel first.
       */
      refs_bytes: skill.refsBytes,
      /**
       * Which redactions touched `instructions`. Absent on a clean row, so a reviewer can grep for the key
       * and get exactly the entries whose text was rewritten rather than every row in the file.
       */
      ...(skill.sanitized.length === 0 ? {} : { sanitized: [...skill.sanitized] }),
    },
  }));
  return toYaml({ skills });
}

/** `teams.yaml` — channel membership plus the lead→member handoff grants. */
export function renderTeamsYaml(capabilities: NormalizedCapabilities): string {
  const teams = capabilities.teams.map((team) => ({
    id: team.id,
    name: team.name,
    description: team.description,
    channel: team.channel,
    lead: team.lead,
    members: team.members.map((member) => ({
      id: member.id,
      name: member.name,
      title: member.title,
      role: member.role,
    })),
    address: team.address.map((grant) => ({ from: grant.from, to: [...grant.to] })),
  }));
  return toYaml({ teams });
}

/** `connectors.yaml` — remote MCP servers, with the host parsed from the url. */
export function renderConnectorsYaml(capabilities: NormalizedCapabilities): string {
  const connectors = capabilities.connectors.map((connector) => ({
    id: connector.id,
    title: connector.title,
    vendor: connector.vendor,
    url: connector.url,
    host: connector.host,
    auth: connector.auth,
    credential_env: connector.credentialEnv,
    source_url: connector.provenance.sourceUrl,
  }));
  return toYaml({ connectors });
}

/** `capability-manifest.yaml` — one row per capability, all licence fields present. */
export function renderManifestYaml(manifest: readonly ManifestEntry[]): string {
  const rows = manifest.map((entry) => ({
    kind: entry.kind,
    slug: entry.slug,
    ...(entry.slug_source === undefined ? {} : { slug_source: entry.slug_source }),
    source: entry.source,
    source_url: entry.source_url,
    source_version: entry.source_version,
    fetched_at: entry.fetched_at,
    checksum_sha256: entry.checksum_sha256,
    license: entry.license,
    redistributable: entry.redistributable,
    attribution: entry.attribution,
    runnable: entry.runnable,
    dropped: [...entry.dropped],
    ...(entry.sanitized === undefined ? {} : { sanitized: [...entry.sanitized] }),
  }));
  return toYaml(rows);
}

/**
 * `slug-conflicts.md` — the file a human reads before the package is merged.
 *
 * Same-name collisions are not errors, but they are the exact shape of accident this report exists to
 * prevent: "two dev-expert builds, one of them silently overwrote the other".
 */
export function renderSlugConflicts(capabilities: NormalizedCapabilities): string {
  const lines: string[] = ["# slug 冲突与丢弃记录", ""];
  lines.push("本文件由 `bun run port:capabilities` 生成，用于人工复核同名与丢弃。", "");

  lines.push("## 同名冲突", "");
  if (capabilities.conflicts.length === 0) {
    lines.push("无。", "");
  } else {
    lines.push("| 基础 slug | 来源 | 最终 slug |");
    lines.push("| --- | --- | --- |");
    for (const conflict of capabilities.conflicts) {
      for (const resolution of conflict.resolution) {
        lines.push(
          `| ${mdCell(conflict.baseSlug)} | ${mdCell(resolution.origin)} | ${mdCell(resolution.slug)} |`,
        );
      }
    }
    lines.push("");
    lines.push(
      "规则：只有一个来源时保留裸 slug；有多个来源时，唯一处在最高优先层（用户级）的那个保留裸 slug，",
      "否则全部加 `--<来源>` 后缀。三条 `dev-expert` 都装在用户级，因此三个都带后缀，没有谁覆盖谁。",
      "",
    );
  }

  lines.push("## 丢弃", "");
  if (capabilities.dropped.length === 0) {
    lines.push("无。", "");
  } else {
    lines.push("| kind | 归属 | 丢弃物 | 原因 |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of capabilities.dropped) {
      lines.push(
        `| ${item.kind} | ${mdCell(item.slug)} | ${mdCell(item.origin)} | ${mdCell(item.reason)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 警告", "");
  if (capabilities.warnings.length === 0) {
    lines.push("无。", "");
  } else {
    for (const warning of capabilities.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Render one audit section as a Markdown table. */
function auditSection(title: string, findings: readonly AuditFinding[]): string[] {
  const counts = countByLevel(findings);
  const lines: string[] = [
    `## ${title}`,
    "",
    `合计 ${findings.length} 条：full ${counts.full} / degraded ${counts.degraded} / blocked ${counts.blocked}。`,
    "",
    "| slug | runnable | 命中的引用 | 原因 |",
    "| --- | --- | --- | --- |",
  ];
  for (const finding of findings) {
    if (finding.hits.length === 0) {
      lines.push(`| ${mdCell(finding.slug)} | ${finding.level} | — | 无命中 |`);
      continue;
    }
    const samples = finding.hits.map((hit) => `${hit.ruleId}:"${hit.sample}"`).join("; ");
    const reasons = [...new Set(finding.hits.map((hit) => hit.reason))].join(" ");
    lines.push(`| ${mdCell(finding.slug)} | ${finding.level} | ${mdCell(samples)} | ${mdCell(reasons)} |`);
  }
  lines.push("");
  return lines;
}

/**
 * `tool-ref-audit.md` — "到底移植成功了百分之几" 的唯一可信答案.
 *
 * Skills come first because they are the audited surface; the agent table follows because an employee
 * whose persona says `Bash(...)` degrades in exactly the same way, and leaving that out would make the
 * report look cleaner than the port is.
 */
export function renderToolRefAudit(
  skillFindings: readonly AuditFinding[],
  agentFindings: readonly AuditFinding[],
): string {
  const lines: string[] = ["# 工具引用审计", ""];
  lines.push("本文件由 `bun run port:capabilities` 按 `mapping.ts` 的规则表静态扫描生成。", "");
  lines.push("档位：`full` 可执行 / `degraded` 需改写后才能跑 / `blocked` 本环境不可执行。", "");
  lines.push(...auditSection("技能（skills.yaml 的 instructions）", skillFindings));
  lines.push(...auditSection("专家（agents.yaml 的 system_prompt）", agentFindings));
  return `${lines.join("\n")}\n`;
}

/**
 * Write every output file.
 *
 * Nothing is written until the connector hosts have been checked, so a failed run cannot leave a
 * half-written package behind for the server to load.
 */
export function emitPackage(options: EmitOptions): EmitResult {
  const { outDir, capabilities, manifest, skillFindings, agentFindings } = options;
  assertConnectorHosts(capabilities);
  const skillFindingIndex = new Map(skillFindings.map((finding) => [finding.slug, finding]));
  const files: { name: string; content: string }[] = [
    { name: "agents.yaml", content: renderAgentsYaml(capabilities) },
    { name: "skills.yaml", content: renderSkillsYaml(capabilities, skillFindingIndex) },
    { name: "teams.yaml", content: renderTeamsYaml(capabilities) },
    { name: "connectors.yaml", content: renderConnectorsYaml(capabilities) },
    { name: "capability-manifest.yaml", content: renderManifestYaml(manifest) },
    { name: "slug-conflicts.md", content: renderSlugConflicts(capabilities) },
    { name: "tool-ref-audit.md", content: renderToolRefAudit(skillFindings, agentFindings) },
  ];
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const path = join(outDir, file.name);
    writeFileSync(path, file.content, "utf8");
    written.push(path);
  }
  return { outDir, files: written };
}
