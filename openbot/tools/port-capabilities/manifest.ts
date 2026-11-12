/**
 * Builds and validates `capability-manifest.yaml`: one row per ported capability, carrying the licence
 * and provenance fields §6.4 of the plan requires.
 *
 * The validation here is the reason the manifest exists. A row missing `license` or `checksum_sha256`
 * is not a cosmetic gap — it is content in the repository that nobody can re-verify or take down, so the
 * rule is hard: a row that fails validation stops the run with exit code 1 rather than being written.
 */
import type { AuditFinding } from "./audit-toolrefs";
import type { RunnableLevel } from "./mapping";
import { isTenantSlug, SEVERITY_ORDER } from "./mapping";
import {
  type CapabilityKind,
  type DroppedItem,
  KIND_ORDER,
  type NormalizedCapabilities,
} from "./normalize";

/** One row of `capability-manifest.yaml`. */
export interface ManifestEntry {
  kind: CapabilityKind;
  slug: string;
  source: string;
  source_url: string;
  source_version: string;
  fetched_at: string;
  checksum_sha256: string;
  license: string;
  redistributable: boolean;
  attribution: string;
  runnable: RunnableLevel;
  /** What the port did not carry, or what collapsed into this row. */
  dropped: string[];
}

/**
 * The nine fields §6.4 requires on every row.
 *
 * `kind`, `slug` and `dropped` sit outside this list on purpose: two are the row's identity and the
 * third is a list whose emptiness is legitimate. They are validated separately, just as strictly.
 */
export const REQUIRED_MANIFEST_FIELDS: readonly (keyof ManifestEntry)[] = [
  "source",
  "source_url",
  "source_version",
  "fetched_at",
  "checksum_sha256",
  "license",
  "redistributable",
  "attribution",
  "runnable",
];

/** ISO8601 instant with a `Z` suffix — what `fetched_at` must look like. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Lowercase SHA-256, exactly 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One thing wrong with one row. */
export interface ManifestViolation {
  /** Row index in the manifest that was validated. */
  index: number;
  slug: string;
  field: string;
  problem: string;
}

/** Whether a level is one of the three this pipeline assigns. */
function isRunnableLevel(value: unknown): value is RunnableLevel {
  return value === "full" || value === "degraded" || value === "blocked";
}

/**
 * Check every row against every rule and return all violations.
 *
 * Returning a list rather than throwing on the first problem is deliberate: a reviewer wants the whole
 * bad set in one run, not one field per run.
 */
export function validateManifest(entries: readonly ManifestEntry[]): ManifestViolation[] {
  const violations: ManifestViolation[] = [];
  const push = (index: number, slug: string, field: string, problem: string) => {
    violations.push({ index, slug, field, problem });
  };
  entries.forEach((entry, index) => {
    if (!KIND_ORDER.includes(entry.kind)) {
      push(index, entry.slug, "kind", `未知 kind: ${String(entry.kind)}`);
    }
    if (!isTenantSlug(entry.slug)) {
      push(index, entry.slug, "slug", "slug 必须通过 tenant-package 的校验（小写字母/数字/连字符，2–40 字符）");
    }
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      const value = entry[field];
      if (typeof value === "string" && value.trim() === "") {
        push(index, entry.slug, field, "缺失或为空");
      }
      if (value === undefined || value === null) {
        push(index, entry.slug, field, "缺失");
      }
    }
    if (typeof entry.redistributable !== "boolean") {
      push(index, entry.slug, "redistributable", "必须是布尔值");
    }
    if (typeof entry.fetched_at === "string" && !ISO_INSTANT.test(entry.fetched_at)) {
      push(index, entry.slug, "fetched_at", `不是 ISO8601 时刻: ${entry.fetched_at}`);
    }
    if (typeof entry.checksum_sha256 === "string" && !SHA256_HEX.test(entry.checksum_sha256)) {
      push(index, entry.slug, "checksum_sha256", "必须是 64 位小写十六进制");
    }
    if (!isRunnableLevel(entry.runnable)) {
      push(index, entry.slug, "runnable", `未知档位: ${String(entry.runnable)}`);
    }
    if (!Array.isArray(entry.dropped) || entry.dropped.some((item) => typeof item !== "string")) {
      push(index, entry.slug, "dropped", "必须是字符串数组");
    }
  });
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = `${entry.kind}:${entry.slug}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      push(index, entry.slug, "slug", `与第 ${previous + 1} 行重复（${key}）`);
      return;
    }
    seen.set(key, index);
  });
  return violations;
}

/** Format violations for a fatal CLI message. */
export function formatViolations(violations: readonly ManifestViolation[]): string {
  return violations
    .map((violation) => `  - 第 ${violation.index + 1} 行 ${violation.slug}: ${violation.field} — ${violation.problem}`)
    .join("\n");
}

/** Throw when any row fails validation, so nothing is written from an invalid manifest. */
export function assertValidManifest(entries: readonly ManifestEntry[]): void {
  const violations = validateManifest(entries);
  if (violations.length > 0) {
    throw new Error(`capability-manifest 校验失败（${violations.length} 处）：\n${formatViolations(violations)}`);
  }
}

/** Sort helper: kind order first, then slug, so the manifest diff is stable. */
export function compareManifestEntries(a: ManifestEntry, b: ManifestEntry): number {
  const kindDelta = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  return kindDelta !== 0 ? kindDelta : a.slug.localeCompare(b.slug);
}

/** Index dropped records by `kind:slug` so each row can pick up the ones that belong to it. */
function indexDropped(dropped: readonly DroppedItem[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const item of dropped) {
    const key = `${item.kind}:${item.slug}`;
    const bucket = index.get(key);
    const line = `${item.origin} — ${item.reason}`;
    if (bucket) {
      bucket.push(line);
    } else {
      index.set(key, [line]);
    }
  }
  for (const bucket of index.values()) {
    bucket.sort();
  }
  return index;
}

/** Worst level across several findings; used to give a team the level of its least runnable member. */
export function worstLevel(levels: readonly RunnableLevel[]): RunnableLevel {
  let worst: RunnableLevel = "full";
  for (const level of levels) {
    if (SEVERITY_ORDER[level] > SEVERITY_ORDER[worst]) {
      worst = level;
    }
  }
  return worst;
}

/** Options for `buildManifest`. */
export interface BuildManifestOptions {
  /** Audit verdicts for skills, keyed by slug. */
  skillFindings: ReadonlyMap<string, AuditFinding>;
  /** Audit verdicts for agents, keyed by agent id. */
  agentFindings: ReadonlyMap<string, AuditFinding>;
}

/**
 * Build the manifest from a normalised capability set.
 *
 * Every kind gets a `runnable` verdict. Skills and agents get theirs from the auditor. A team gets the
 * worst verdict of its members, because a team whose lead can run but whose only renderer cannot is not a
 * team that delivers. Connectors are `full` when they ship as a remote URL, which is the only shape that
 * reaches this point (`normalizeCapabilities` drops stdio ones before they get here).
 */
export function buildManifest(
  capabilities: NormalizedCapabilities,
  options: BuildManifestOptions,
): ManifestEntry[] {
  const droppedIndex = indexDropped(capabilities.dropped);
  const entry = (
    kind: CapabilityKind,
    slug: string,
    provenance: {
      source: string;
      sourceUrl: string;
      sourceVersion: string;
      fetchedAt: string;
      checksum: string;
      license: string;
      redistributable: boolean;
      attribution: string;
    },
    runnable: RunnableLevel,
    extraDropped: readonly string[] = [],
  ): ManifestEntry => ({
    kind,
    slug,
    source: provenance.source,
    source_url: provenance.sourceUrl,
    source_version: provenance.sourceVersion,
    fetched_at: provenance.fetchedAt,
    checksum_sha256: provenance.checksum,
    license: provenance.license,
    redistributable: provenance.redistributable,
    attribution: provenance.attribution,
    runnable,
    dropped: [...(droppedIndex.get(`${kind}:${slug}`) ?? []), ...extraDropped].sort(),
  });

  const entries: ManifestEntry[] = [];
  for (const agent of capabilities.agents) {
    entries.push(
      entry("agent", agent.id, agent.provenance, options.agentFindings.get(agent.id)?.level ?? "full"),
    );
  }
  for (const skill of capabilities.skills) {
    entries.push(
      entry("skill", skill.slug, skill.provenance, options.skillFindings.get(skill.slug)?.level ?? "full", skill.dropped),
    );
  }
  for (const team of capabilities.teams) {
    const memberLevels = team.members.map(
      (member) => options.agentFindings.get(member.id)?.level ?? "full",
    );
    entries.push(entry("team", team.id, team.provenance, worstLevel(memberLevels)));
  }
  for (const connector of capabilities.connectors) {
    entries.push(entry("connector", connector.id, connector.provenance, "full", connector.dropped));
  }
  return entries.sort(compareManifestEntries);
}
