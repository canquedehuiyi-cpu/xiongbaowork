/**
 * Annotates an already-generated tenant package with per-skill "why not full" evidence.
 *
 * The full pipeline (`index.ts`) writes `reason`/`reason_ref` from its own audit pass, but
 * `examples/xiongbao` is not a one-shot artifact: it is a continuously maintained data file whose seed
 * entries and hand-applied fixes must survive verbatim, and the source tree it was assembled from has
 * drifted since. Re-running the whole assembler over it is not an option; dropping the reason fields
 * keeps R18's promise ("what exactly is missing, visible on every row") unmet. So this tool replays the
 * audit against the package's own text and writes the two fields into each entry's `_porting` block
 * in place.
 *
 * Contract, enforced rather than trusted:
 *
 *   - The replayed level must equal the recorded `_porting.runnable`. A mismatch means the body was
 *     edited after the last audit — that is exactly the stale-verdict failure mode R3 guards against,
 *     so the tool refuses instead of annotating a lie.
 *   - Idempotent: a second run over its own output produces a byte-identical file.
 *   - Text-level edit, following the assembler's own convention (`stripGeneratedSkillBlocks` &
 *     friends): the file is edited as lines, never parsed-and-restringified, so comments and key
 *     order survive.
 *
 * Usage:
 *
 *   bun tools/port-capabilities/annotate-package.ts --out ./examples/xiongbao
 *
 * Exits non-zero on any inconsistency, writing nothing on failure (all checks run before the write).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import { auditCapabilities } from "./audit-toolrefs";
import type { AuditFinding } from "./audit-toolrefs";
import { buildReasonRefs } from "./emit-package";

interface PackageSkill {
  slug: string;
  instructions: string;
  runnable: string;
  hasPorting: boolean;
}

interface SkillRecord {
  slug: unknown;
  instructions: unknown;
  _porting?: { runnable?: unknown };
}

/** Read the package's skills as (slug, body, recorded level) without touching the file text. */
function readSkills(outDir: string): { skills: PackageSkill[]; raw: string } {
  const raw = readFileSync(join(outDir, "skills.yaml"), "utf8");
  const parsed = parse(raw) as { skills?: SkillRecord[] };
  const skills: PackageSkill[] = [];
  for (const skill of parsed.skills ?? []) {
    if (typeof skill.slug !== "string" || typeof skill.instructions !== "string") {
      throw new Error(`skills.yaml 存在缺 slug/instructions 的条目`);
    }
    const runnable = skill._porting?.runnable;
    skills.push({
      slug: skill.slug,
      instructions: skill.instructions,
      runnable: typeof runnable === "string" ? runnable : "full",
      hasPorting: skill._porting !== undefined,
    });
  }
  return { skills, raw };
}

/** Connector ids declared by the package itself — the same set the assembler judged against. */
function readConnectorIds(outDir: string): Set<string> {
  const raw = readFileSync(join(outDir, "connectors.yaml"), "utf8");
  const parsed = parse(raw) as { connectors?: Array<{ id?: unknown }> };
  const ids = (parsed.connectors ?? [])
    .map((connector) => connector.id)
    .filter((id): id is string => typeof id === "string");
  return new Set(ids);
}

/** One YAML double-quoted scalar on one line — JSON escaping is a subset of YAML 1.2's. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/**
 * Insert or refresh the `reason`/`reason_ref` lines under this entry's `      runnable:` line.
 * Returns null when the entry has no `_porting` block with a `runnable:` line (seed rows that were
 * never audited are left alone — annotating them would imply a verdict that was never made).
 */
function annotateEntry(
  lines: readonly string[],
  slug: string,
  fields: { reason: string; reason_ref: string } | undefined,
): string[] | null {
  let inEntry = false;
  let inPorting = false;
  let runnableIndex = -1;
  let endIndex = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {2}- slug: /.test(line)) {
      if (inEntry) {
        endIndex = index;
        break;
      }
      inEntry = line === `  - slug: ${slug}`;
      inPorting = false;
      continue;
    }
    if (!inEntry) continue;
    if (/^ {4}_porting:$/.test(line)) {
      inPorting = true;
      continue;
    }
    if (inPorting && /^ {4}- slug: |^ {2}[a-z_-]+:/.test(line)) {
      inPorting = false;
    }
    if (inPorting && /^ {6}runnable: /.test(line)) {
      runnableIndex = index;
    }
  }
  if (runnableIndex === -1) return null;
  const output = [...lines];
  const existingReason = output.findIndex(
    (line, index) =>
      index > runnableIndex &&
      index < endIndex &&
      /^ {6}reason(_ref)?: /.test(line),
  );
  if (existingReason !== -1) {
    output.splice(existingReason, endIndex - existingReason > 0 ? 2 : 1);
  }
  if (fields) {
    output.splice(
      runnableIndex + 1,
      0,
      `      reason: ${fields.reason}`,
      `      reason_ref: ${quoted(fields.reason_ref)}`,
    );
  }
  return output;
}

/** Annotate one skills.yaml; returns the new text (byte-identical on a second run). */
export function annotateSkillsYaml(raw: string, connectorIds: ReadonlySet<string>): string {
  const parsed = parse(raw) as { skills?: SkillRecord[] };
  const slugs: string[] = [];
  const levels = new Map<string, string>();
  const bodies = new Map<string, string>();
  for (const skill of parsed.skills ?? []) {
    if (typeof skill.slug !== "string" || typeof skill.instructions !== "string") {
      throw new Error(`skills.yaml 存在缺 slug/instructions 的条目`);
    }
    slugs.push(skill.slug);
    levels.set(
      skill.slug,
      typeof skill._porting?.runnable === "string" ? skill._porting.runnable : "full",
    );
    bodies.set(skill.slug, skill.instructions);
  }
  const findings = auditCapabilities(
    slugs.map((slug) => {
      const body = bodies.get(slug);
      if (body === undefined) {
        throw new Error(`skills.yaml 内部不一致：${slug} 有 slug 无正文`);
      }
      return { slug, instructions: body, hasBundledReferences: true };
    }),
    connectorIds,
  );
  const bySlug = new Map<string, AuditFinding>();
  for (const finding of findings as AuditFinding[]) {
    bySlug.set(finding.slug, finding);
  }
  const annotations = new Map<string, { reason: string; reason_ref: string } | undefined>();
  for (const slug of slugs) {
    const finding = bySlug.get(slug);
    if (!finding) {
      throw new Error(`skills.yaml 内部不一致：${slug} 审计后丢失条目`);
    }
    if (finding.level !== levels.get(slug)) {
      throw new Error(
        `${slug}：包内档位 ${levels.get(slug)} ≠ 重放审计 ${finding.level}（正文在最近一次审计后被改过，先重新审计再注记）`,
      );
    }
    const refs = buildReasonRefs(finding);
    annotations.set(
      slug,
      refs.length === 0
        ? undefined
        : {
            reason: refs.map((entry) => entry.ruleId).join("+"),
            reason_ref: refs.map((entry) => entry.text).join("；"),
          },
    );
  }
  let lines = raw.split("\n");
  for (const slug of slugs) {
    const annotated = annotateEntry(lines, slug, annotations.get(slug));
    if (annotated === null) {
      if (annotations.get(slug) !== undefined) {
        throw new Error(`${slug}：审计判 ${levels.get(slug)} 但条目没有 _porting.runnable 可注记`);
      }
      continue;
    }
    lines = annotated;
  }
  return lines.join("\n");
}

function main(argv: readonly string[]): number {
  let outDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      outDir = argv[index + 1];
      index += 1;
    } else if (argument?.startsWith("--out=")) {
      outDir = argument.slice("--out=".length);
    }
  }
  if (!outDir) {
    console.error("用法：bun tools/port-capabilities/annotate-package.ts --out <包目录>");
    return 2;
  }
  try {
    const { raw } = readSkills(outDir);
    const connectorIds = readConnectorIds(outDir);
    const annotated = annotateSkillsYaml(raw, connectorIds);
    if (annotated !== raw) {
      writeFileSync(join(outDir, "skills.yaml"), annotated, "utf8");
      const annotatedCount = (annotated.match(/^ {6}reason: /gm) ?? []).length;
      console.log(
        `[port:annotate] ${annotatedCount} 条已注记 reason/reason_ref → ${join(outDir, "skills.yaml")}`,
      );
    } else {
      console.log("[port:annotate] 无变化（幂等重跑）");
    }
    return 0;
  } catch (error) {
    console.error(`[port:annotate] 失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
