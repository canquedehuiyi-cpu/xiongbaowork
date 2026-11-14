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
 * 编排（`main`）留在这里；命令行面在 `cli-args.ts`，`--verify` 在 `verify-out-dir.ts`，
 * `--census` 在 `census-run.ts`（技术债 #25：这个文件曾有一千行，四种职责混在一起）。
 *
 * If `bun test` or even `import "./normalize.ts"` hangs and then dies on SIGTERM, the cause is a poisoned
 * Bun transpile cache, not the code: run with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`. Worth knowing before
 * spending an hour on the regexes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AuditFinding,
  auditCapabilities,
  countByLevel,
  indexFindings,
} from "./audit-toolrefs";
import { formatCounts, runCensus } from "./census-run";
import {
  type CliOptions,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  parseArgs,
  readWhitelistSlugs,
  USAGE,
  UsageError,
} from "./cli-args";
import { emitPackage } from "./emit-package";
import {
  buildL1Gate,
  filterSnapshotByGate,
  parseLockDocument,
  verifyAllowedUnits,
} from "./l1-gate";
import { assertValidManifest, buildManifest } from "./manifest";
import { CONNECTOR_ALLOWLIST } from "./mapping";
import { normalizeCapabilities } from "./normalize";
import {
  readConnectorIndex,
  readWorkBuddy,
  SourceLayoutError,
  type WorkBuddySnapshot,
} from "./read-workbuddy";
import { rewriteInstructions } from "./rewrite-toolrefs";
import { verifyOutDir } from "./verify-out-dir";

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
      console.error(
        `[port:capabilities] verify 失败（${problems.length} 处）：`,
      );
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

    // `l0` keeps the P0 allowlist so the audited tool-ref set cannot grow behind the audit's back; `all`
    // is the L1 survey mode, reading every id the marketplace index declares (normalize still drops the
    // ones with no remote endpoint, so the manifest only ever gains declarable connectors).
    const connectorAllowlist =
      options.connectors === "all"
        ? [...readConnectorIndex(options.sourceRoot).keys()]
        : CONNECTOR_ALLOWLIST;
    let snapshot: WorkBuddySnapshot = readWorkBuddy({
      sourceRoot: options.sourceRoot,
      connectorAllowlist,
    });
    console.log(
      `[port:capabilities] 读取 专家包 ${snapshot.packages.length} / 用户技能 ${snapshot.userSkills.length} / 连接器 ${snapshot.connectors.length}`,
    );

    // `l1` runs every read unit through the capability-lock gate (§2.2 step 3): identity first, then
    // the owner's exclusion list, then the redistributable flag, then the optional whitelist. What
    // never measured never enters; what the licence rules refuse never enters; what the caller
    // narrows away never enters. The filtered snapshot is what the rest of the pipeline sees.
    if (options.scope === "l1") {
      const lock = parseLockDocument(
        readFileSync(options.lockPath as string, "utf8"),
      );
      const whitelist =
        options.whitelistPath === undefined
          ? undefined
          : readWhitelistSlugs(options.whitelistPath);
      const gate = buildL1Gate(lock, whitelist);
      const gated = filterSnapshotByGate(snapshot, gate);
      const codeSummary = Object.entries(gated.stats.byCode)
        .map(([code, count]) => `${code} ${count}`)
        .join(" / ");
      console.log(
        `[port:capabilities] L1 闸门  放行 ${gated.stats.allowed} / 拒绝 ${gated.stats.refused}${codeSummary === "" ? "" : `（${codeSummary}）`}`,
      );
      // Grouped preview so a dominant code cannot drown the others: each refusal kind shows its
      // first few units, which is usually enough to spot the interesting outliers.
      const previewGroups = new Map<string, string[]>();
      for (const dropped of gated.dropped) {
        const group = previewGroups.get(dropped.code) ?? [];
        if (group.length < 3) {
          group.push(dropped.unit);
          previewGroups.set(dropped.code, group);
        }
      }
      if (previewGroups.size > 0) {
        console.log("[port:capabilities] 闸门拒绝（按类别各取前 3 条）：");
        for (const [code, units] of previewGroups) {
          for (const unit of units) {
            console.log(`  - ${code}  ${unit}`);
          }
        }
      }
      // Byte-level closure of the gate: every allowed unit's cached bytes must still hash to the
      // lock's value. A fetch cache (channel-provenance.json present) must contain every origin the
      // lock records — a missing one is fatal there; a live home may legitimately lack the
      // marketplace bundle, so missing roots are skipped with a warning in that case only.
      const strictCache = existsSync(
        join(options.sourceRoot, "channel-provenance.json"),
      );
      const verification = verifyAllowedUnits(gated, gate, options.sourceRoot, {
        strict: strictCache,
      });
      console.log(
        `[port:capabilities] L1 锁校验  字节比对 ${verification.verified} 个锁行${verification.warnings.length > 0 ? `（本机缺失跳过 ${verification.warnings.length} 个单元根，已警告）` : ""}`,
      );
      for (const warning of verification.warnings) {
        console.log(`  - VERIFY_WARN  ${warning}`);
      }
      snapshot = gated.snapshot;
    }

    const capabilities = normalizeCapabilities(snapshot, {
      connectorSurvey: options.connectors === "all",
    });
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
      console.log(
        `[port:capabilities] 丢弃 ${capabilities.dropped.length} 项（见 slug-conflicts.md）`,
      );
    }

    const connectorIds = new Set(
      capabilities.connectors.map((connector) => connector.id),
    );
    let skillFindings = auditCapabilities(
      capabilities.skills.map((skill) => ({
        slug: skill.slug,
        instructions: skill.instructions,
        hasBundledReferences: skill.hasBundledReferences,
      })),
      connectorIds,
    );

    // P3 改写层（§5.2）：只作用于 skill 的 instructions。agent 的 system_prompt 有 1000 字符
    // 上限（shipped-bot 合同，P2 的 persona 短指针版就贴着这条线），插入环境事实段会把它顶爆；
    // agent 侧的降级说明由 persona 技能承载——改写层改的正是那份技能正文。
    const skillFindingIndex0 = indexFindings(skillFindings);
    let rewrittenSkillCount = 0;
    capabilities.skills = capabilities.skills.map((skill) => {
      const finding = skillFindingIndex0.get(skill.slug);
      if (!finding || finding.level === "full") return skill;
      const result = rewriteInstructions(skill, finding.level);
      if (result.changed) rewrittenSkillCount += 1;
      return { ...skill, instructions: result.instructions };
    });
    // 改写后重审计：manifest.runnable 以改写后的正文为准（G3——档位变动必须可全文证明）。
    // 契约：blocked 不许变好（改写保留原调用、只插散文段）；degraded 升 full 仅当 file-tool-call
    // 的命中全部被映射改写（§「degraded 为 0 是改写层完成度的标志位」）。
    const rewrittenFindings = auditCapabilities(
      capabilities.skills.map((skill) => ({
        slug: skill.slug,
        instructions: skill.instructions,
        hasBundledReferences: skill.hasBundledReferences,
      })),
      connectorIds,
    );
    const SEVERITY = { full: 0, degraded: 1, blocked: 2 } as const;
    const rewrittenIndex = indexFindings(rewrittenFindings);
    for (const before of skillFindings) {
      const after = rewrittenIndex.get(before.slug);
      if (!after) throw new Error(`改写后丢失审计条目：${before.slug}`);
      if (SEVERITY[after.level] < SEVERITY[before.level]) {
        throw new Error(
          `改写层契约违约：${before.slug} ${before.level}→${after.level}，blocked/degraded 不许被改写成更好的档位`,
        );
      }
    }
    if (rewrittenSkillCount > 0) {
      const beforeCounts = formatCounts(countByLevel(skillFindings));
      const afterCounts = formatCounts(countByLevel(rewrittenFindings));
      console.log(
        `[port:capabilities] 改写层：${rewrittenSkillCount} 条技能正文已插入环境事实段/映射改写（审计 ${beforeCounts} → ${afterCounts}）`,
      );
    }
    // manifest/emit 的审计口径 = 改写后的正文（档位以最终形态计，G3）。
    skillFindings = rewrittenFindings;

    const agentFindings = auditCapabilities(
      capabilities.agents.map((agent) => ({
        slug: agent.id,
        instructions: agent.systemPrompt,
        hasBundledReferences: agent.hasBundledReferences,
      })),
      connectorIds,
    );
    console.log(
      `[port:capabilities] 审计 skill ${formatCounts(countByLevel(skillFindings))}`,
    );
    console.log(
      `[port:capabilities] 审计 agent ${formatCounts(countByLevel(agentFindings))}`,
    );

    const skillFindingIndex = indexFindings(skillFindings);
    const agentFindingIndex: Map<string, AuditFinding> =
      indexFindings(agentFindings);
    const manifest = buildManifest(capabilities, {
      skillFindings: skillFindingIndex,
      agentFindings: agentFindingIndex,
    });
    assertValidManifest(manifest);
    console.log(
      `[port:capabilities] manifest ${manifest.length} 条，9 字段齐备`,
    );

    const emitted = emitPackage({
      outDir: options.outDir,
      capabilities,
      manifest,
      skillFindings,
      agentFindings,
    });
    console.log(
      `[port:capabilities] 写出 ${emitted.files.length} 个文件 → ${emitted.outDir}`,
    );

    if (options.verify) {
      const problems = verifyOutDir(options.outDir);
      if (problems.length > 0) {
        console.error(
          `[port:capabilities] verify 失败（${problems.length} 处）：`,
        );
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
