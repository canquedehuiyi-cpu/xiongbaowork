/**
 * Decides, per instruction body, whether the ported capability can still run on an openbot employee.
 *
 * This is a deliverable, not a by-product: "how much of the port actually works" is answered by this
 * table and by nothing else. Counting files would report 100% for a corpus where half the skills tell
 * the model to run `bash scripts/x.sh` on a machine that has no shell.
 *
 * The verdict is the worst rule that fires, so a skill is `blocked` if anything in it needs a shell even
 * when other parts are fine. Rules and their severities live in `mapping.ts`; this module only applies
 * them, which keeps the policy reviewable in one table.
 */
import { AUDIT_RULE_TABLE, type AuditRule, LEADING_COMMAND_PATTERN, SEVERITY_ORDER, type RunnableLevel } from "./mapping";

/** One capability to judge. */
export interface AuditableCapability {
  /** Slug or agent id; the row label in the audit table. */
  slug: string;
  /** The body the model will read: a skill's `instructions` or an agent's `system_prompt`. */
  instructions: string;
  /** Whether the source ships the `references/` directory its body points at. */
  hasBundledReferences: boolean;
}

/**
 * Where a citation sits, best first. The number is the tier, so sorting is `a - b`.
 *
 * - 1: a command at the start of a line inside a fenced code block — this is a recipe, the reader sees it.
 * - 2: a command at the start of a line, inline-code ticks allowed.
 * - 3: a command inside inline code in the middle of a sentence — quoted, but part of an instruction.
 * - 4: a plain mention. Only used when 1–3 produced nothing, and the row is marked `incidental`.
 */
export type EvidenceTier = 1 | 2 | 3 | 4;

/** One rule that fired. */
export interface AuditHit {
  ruleId: string;
  level: RunnableLevel;
  /** The offending text, trimmed and shortened so the report is one line per hit. */
  sample: string;
  reason: string;
  /** How good this citation is; see {@link EvidenceTier}. */
  tier: EvidenceTier;
}

/** The verdict for one capability. */
export interface AuditFinding {
  slug: string;
  level: RunnableLevel;
  hits: AuditHit[];
  /**
   * `true` when the verdict rests on a weak citation — a bare mention rather than a command.
   *
   * Derived, never listed by hand: a slug allowlist here would be the exact shape the "no special cases"
   * gate greps for, and it would hide the next skill that has the same problem.
   */
  marginal: boolean;
}

/** Longest sample kept in a finding. The full text stays in the source; this is for a table cell. */
const SAMPLE_LIMIT = 60;

/** Shorten a matched excerpt for the report: one line, no markdown pipes, bounded length. */
export function shortenSample(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return collapsed.length <= SAMPLE_LIMIT ? collapsed : `${collapsed.slice(0, SAMPLE_LIMIT - 1)}…`;
}

/**
 * The whole line a match sits on, trimmed.
 *
 * A pattern that captures only the start of a command (`node j…`) proves nothing to a reviewer, while the
 * line it came from (`node scripts/collect.js --all`) shows exactly what cannot run.
 */
export function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", Math.max(index - 1, 0)) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * The matched text plus the rest of its line — what the audit table's "命中的引用" column shows.
 *
 * It starts *at the match* rather than at the start of the line. A cell that begins forty characters
 * before the interesting token makes the reviewer hunt for it, and the one question that column has to
 * answer is "which substring tripped this rule": `node junction` sitting in "用 node junction，不要用
 * mklink" is immediately recognisable as prose, while the same line truncated from the left is not.
 */
export function excerptAt(text: string, index: number): string {
  const rest = text.slice(index);
  const end = rest.indexOf("\n");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Pattern for an MCP tool reference. Group 1 is the server id, group 2 the tool name. */
const MCP_REFERENCE = /mcp__([\w-]+)__([\w-]+)/;

/**
 * 这里曾经有一条「否定语境护栏」（`findNegation` + `NEGATION_MARKERS`/`ALTERNATIVE_MARKERS`）：
 * 命中落在 `不要/禁止/never…` 之后时把该命中挪进 `excluded`，不计入判定。
 *
 * **整套撤掉的裁定（2026-11 评审）**：全语料实测，「禁止句被独立当成依赖」的假阳性为 0 例，而护栏
 * 产出了可复现的假阴性——`不要用 node -e 猜参数，改用 node run.js --selftest` 后半句是真依赖，被一起
 * 豁免成 full。假阳性会被发现，假阴性不会，所以方向宁可反向。
 *
 * 若将来出现某技能的**全部**命中都落在否定语境、导致本规则误判 blocked：届时再做护栏，且必须同时带
 * （1）替代标记兜底（`改用|而是|instead` 等，护栏止于替代标记处）和（2）反向反证单测（护栏缺席时用例
 * 必须变红）。两者缺一不可，缺了就是这次的教训重演。
 *
 * 撤掉护栏后，禁止句仍可能被引用为证据；误报靠 {@link evidenceTier} 的引文质量排序兜底
 * （代码块内命令 > 行首命令 > 散文片段 > 描述性提及），把最有说服力的证据排在报告首行。
 */

/**
 * Whether the offset sits inside a fenced code block.
 *
 * A fence is Markdown formatting, so this only needs to count fence lines before the offset. Getting it
 * wrong cannot change a verdict; it only decides whether a citation is quoted as a recipe (tier 1) or as a
 * line of prose (tier 2+).
 */
function insideFence(text: string, index: number): boolean {
  let fences = 0;
  let cursor = text.indexOf("\n");
  while (cursor !== -1 && cursor < index) {
    if (text.slice(cursor + 1, cursor + 4) === "```") {
      fences += 1;
    }
    cursor = text.indexOf("\n", cursor + 1);
  }
  if (text.slice(0, Math.min(3, text.length)) === "```") {
    fences += 1;
  }
  return fences % 2 === 1;
}

/**
 * Rank a citation by how well it shows the reader what cannot run.
 *
 * The reason this exists is a real report row: a skill whose body has twenty `git` command lines was cited
 * with the sentence `bash 的 mkdir/cp 认 /c/...`, because that happened to be the first match. The verdict
 * was right and the evidence was worthless, which for a document a customer reads is the same as wrong.
 */
export function evidenceTier(text: string, index: number): EvidenceTier {
  const line = lineAt(text, index);
  const leading = LEADING_COMMAND_PATTERN.test(line);
  if (leading && insideFence(text, index)) {
    return 1;
  }
  if (leading) {
    return 2;
  }
  const quoted = index > 0 && text[index - 1] === "`";
  return quoted ? 3 : 4;
}

/**
 * Prose notation for "some value goes here": `<user>`, `<file>`, `<git branch>`.
 *
 * The port itself writes one of these — redaction turns `C:/Users/alice/…` into `C:/Users/<user>/…` — so
 * the auditor has to treat them as literal text, not as syntax. It did not, once: the `>` closing the
 * placeholder read as a shell redirect and `Write(C:/Users/alice/a.json)` gained a `shell-command-prose`
 * hit purely from being redacted. A verdict may not depend on our own sanitising. Spaces are allowed
 * inside because templates write `<git branch>` as often as `<user>`.
 */
const ANGLE_PLACEHOLDER = /<[A-Za-z][A-Za-z0-9_.\- ]{0,23}>/g;

/**
 * Blank out placeholders while keeping every offset intact.
 *
 * Indices still address the original string, so `excerptAt` keeps quoting the body the reader will see.
 */
function maskPlaceholders(text: string): string {
  return text.replace(ANGLE_PLACEHOLDER, (placeholder) => "x".repeat(placeholder.length));
}

/** Collect every match of a pattern, cloned with `g` so a shared constant cannot carry `lastIndex`.
 *
 * No reporting cap here, on purpose: this function feeds the *judgement*, and a verdict may only be
 * computed from every match. A body whose first 20 references name shipped connectors and whose 21st
 * names one that does not ship must still be judged degraded/blocked — the old `found.length < 20`
 * stop silently hid exactly that 21st reference. Truncation for display happens at the report layer
 * (`emit-package.ts` shows the best citation per rule plus a total), never in the rule evaluation.
 */
function matchAll(text: string, source: RegExp): RegExpExecArray[] {
  const flags = source.flags.includes("g") ? source.flags : `${source.flags}g`;
  const pattern = new RegExp(source.source, flags);
  const found: RegExpExecArray[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    found.push(match);
    if (match.index === pattern.lastIndex) {
      pattern.lastIndex += 1;
    }
    match = pattern.exec(text);
  }
  return found;
}

/** Whether a rule applies to a capability, and the samples that prove it. */
function evaluateRule(
  rule: AuditRule,
  capability: AuditableCapability,
  connectorIds: ReadonlySet<string>,
): AuditHit[] {
  if (rule.kind === "mcp-server") {
    const unknown = new Set<string>();
    for (const match of matchAll(maskPlaceholders(capability.instructions), MCP_REFERENCE)) {
      const serverId = match[1];
      if (!connectorIds.has(serverId)) {
        unknown.add(match[0]);
      }
    }
    return [...unknown].sort().map((sample) => ({
      ruleId: rule.id,
      level: rule.level,
      sample: shortenSample(sample),
      reason: rule.reason,
      tier: 3 as EvidenceTier,
    }));
  }

  const pattern = rule.pattern;
  if (!pattern) {
    return [];
  }
  if (rule.kind === "references-without-assets" && capability.hasBundledReferences) {
    // The skill does ship references/: the body can reach them once P1 adds the asset channel, so this
    // is not a defect of the port. It is reported as a hit only when the files are genuinely absent.
    return [];
  }
  const hits: AuditHit[] = [];
  const seen = new Set<string>();
  const scanned = maskPlaceholders(capability.instructions);
  for (const match of matchAll(scanned, pattern)) {
    // A rule may match its leading whitespace (a command on the line after a fence), so the excerpt is
    // taken from where the interesting text starts rather than from where the match happens to begin.
    const leading = match[0].length - match[0].replace(/^\s+/, "").length;
    const start = match.index + leading;
    const sample = shortenSample(excerptAt(capability.instructions, start));
    // Dedupe on the matched text, not on the excerpt: the excerpt now runs to the end of its line, so two
    // hits on one line (`Bash(a). … Bash(a)`) would look different while being the same offence.
    const token = match[0].trim();
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    // No negation guard here on purpose — see the block comment above `insideFence` for the removal
    // ruling and the conditions under which one may be rebuilt.
    hits.push({
      ruleId: rule.id,
      level: rule.level,
      sample,
      reason: rule.reason,
      tier: evidenceTier(capability.instructions, start),
    });
  }
  return hits;
}

/**
 * Judge one capability.
 *
 * `connectorIds` is the set of `connectors.yaml` ids. A `mcp__<server>__<tool>` reference is only a
 * problem when the server does not ship, because that reference is how openbot names a remote tool.
 */
export function auditCapability(
  capability: AuditableCapability,
  connectorIds: ReadonlySet<string>,
): AuditFinding {
  const hits: AuditHit[] = [];
  for (const rule of AUDIT_RULE_TABLE) {
    hits.push(...evaluateRule(rule, capability, connectorIds));
  }
  let level: RunnableLevel = "full";
  for (const hit of hits) {
    if (SEVERITY_ORDER[hit.level] > SEVERITY_ORDER[level]) {
      level = hit.level;
    }
  }
  // Severity first, then citation quality, then id: the first row is the one the report quotes, so it must
  // be the best evidence for the worst verdict rather than whichever rule happened to run first.
  const ordered = [...hits].sort(
    (a, b) =>
      SEVERITY_ORDER[b.level] - SEVERITY_ORDER[a.level] ||
      a.tier - b.tier ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return {
    slug: capability.slug,
    level,
    hits: ordered,
    marginal: level === "blocked" && ordered.length > 0 && ordered[0].tier >= 3,
  };
}

/** Judge a batch, preserving the input order. */
export function auditCapabilities(
  capabilities: readonly AuditableCapability[],
  connectorIds: ReadonlySet<string>,
): AuditFinding[] {
  return capabilities.map((capability) => auditCapability(capability, connectorIds));
}

/** Index findings by slug, which is how the emitters look them up. */
export function indexFindings(findings: readonly AuditFinding[]): Map<string, AuditFinding> {
  return new Map(findings.map((finding) => [finding.slug, finding]));
}

/** Count findings by level, for the CLI summary line. */
export function countByLevel(findings: readonly AuditFinding[]): Record<RunnableLevel, number> {
  const counts: Record<RunnableLevel, number> = { full: 0, degraded: 0, blocked: 0 };
  for (const finding of findings) {
    counts[finding.level] += 1;
  }
  return counts;
}

/**
 * How many verdicts rest on a bare mention rather than on a command.
 *
 * Exported so a test can pin the number: the debt is only visible while its size is asserted, and a rising
 * count is the signal that the citation ranking stopped finding real commands.
 */
export function countMarginal(findings: readonly AuditFinding[]): number {
  return findings.filter((finding) => finding.marginal).length;
}
