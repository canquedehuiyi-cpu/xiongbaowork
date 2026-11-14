/**
 * `bun run port:verdict-refresh` — 按包内已记录的证据重算档位，并只改档位那几行。
 *
 * 为什么需要这个模式：`port:assemble` 的档位判定要用源目录。一旦源侧漂移（技能升级、缓存被清），
 * `buildAssetPlans` 就找不到 checksum 相符的 SKILL.md 而拒绝落位——整包重建被堵死，于是「正文引用了
 * 未入包附件」这类降级只存在于代码里，包内徽章照旧承诺读不到的文件。而在包已经装配好的情况下，
 * 判定所需的两份事实其实都写在包里：`_porting.dropped` 记着哪些附件没搬，`assets:` 记着实际搬了哪些。
 *
 * 本模块只做一件事：用这两份事实重算档位，然后**逐行**改 `_porting.runnable` 并紧随其后写
 * `reason`/`reason_ref`，manifest 同名行同步改 `runnable`。不做解析后整行重渲染——`refs_bytes` 会被
 * 解析成数字丢位、`reason_ref` 的引号风格会漂、`instructions: >-` 的折叠标量会被摊平，那样一次
 * 「改档位」会顺手重写 109 条正文。
 *
 * 三条不变量（都有测试钉住）：
 *   1. 只有档位行及其理由行会变，其余字节原样；
 *   2. 只往低处改：`blocked` 一律不碰，`degraded` 不重复降——后者抹掉的是许可理由，那是唯一记录；
 *   3. 声明的附件在包内不存在就报错，而不是降级：包不许自称有它没有的文件。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  findMissingAssetReferences,
  formatMissingAssetEvidence,
  MISSING_ASSET_RULE_ID,
} from "./asset-reachability";
import type { RunnableLevel } from "./mapping";

export { MISSING_ASSET_RULE_ID };

/** 规则 id：技能本体只对宿主自己的产品成立，换到本部署里无从执行。 */
export const HOST_SPECIFIC_RULE_ID = "host-specific-skill";

/**
 * 已确认「只对 WorkBuddy 宿主成立」的技能。
 *
 * 这不是通用规则，是一份需要逐条说明的名单：写在这里的每一项都必须能在 `reasonRef` 里指出正文
 * 究竟依赖了宿主的什么，否则它只是「我不喜欢这个技能」的另一种写法。
 */
export const HOST_SPECIFIC_SKILLS: readonly {
  slug: string;
  reasonRef: string;
}[] = [
  {
    slug: "workbuddy-market-export",
    reasonRef:
      '正文整篇只讲 WorkBuddy/CodeBuddy 三个市场（专家、技能、插件）怎么批量导出：官方市场的免鉴权整包接口、workbuddy_marketplace_* 工具、市场目录结构。openbot 没有这三个市场、没有这些接口与工具，每一步都落空。 ← "workbuddy_marketplace_skill"; "把 WorkBuddy 市场里的专家/技能/插件全下载下来"',
  },
];

/** Thrown when the package cannot be refreshed without lying about its own contents. */
export class VerdictRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictRefreshError";
  }
}

/** One verdict this mode wants the package to carry. */
export interface RefreshVerdict {
  slug: string;
  runnable: RunnableLevel;
  /** Rule id, recorded as `_porting.reason` in `skills.yaml`. */
  reason: string;
  /** Human-readable evidence, recorded as `_porting.reason_ref`. */
  reasonRef: string;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VerdictRefreshError(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** Read the verdict a row currently carries, treating anything unknown as the permissive default. */
function currentVerdict(porting: Record<string, unknown>): RunnableLevel {
  return porting.runnable === "blocked"
    ? "blocked"
    : porting.runnable === "degraded"
      ? "degraded"
      : "full";
}

/**
 * Recompute the verdict of every shipped skill from the package's own record.
 *
 * `assetExists` is the honesty check: when supplied, every path a row declares under `assets:` must be
 * on disk, or the run fails. Callers that only want the pure judgement (tests) omit it.
 */
export function computeRefreshVerdicts(input: {
  skills: readonly Record<string, unknown>[];
  assetExists?: (slug: string, path: string) => boolean;
}): Map<string, RefreshVerdict> {
  const verdicts = new Map<string, RefreshVerdict>();
  for (const row of input.skills) {
    const slug = typeof row.slug === "string" ? row.slug : "";
    if (slug === "") continue;
    const porting = asRecord(row._porting ?? {}, `${slug} _porting`);
    const assets = Array.isArray(row.assets)
      ? row.assets.map((asset) => String(asset))
      : [];
    if (input.assetExists) {
      for (const asset of assets) {
        if (!input.assetExists(slug, asset)) {
          throw new VerdictRefreshError(
            `技能 ${slug} 在 assets 里声明了 ${asset}，但包内 skills/${slug}/${asset} 不存在：先修包，别先改档位`,
          );
        }
      }
    }
    const current = currentVerdict(porting);
    // 只往低处改：blocked 的 reason 是许可拒绝的唯一记录，任何刷新都不许覆盖它。
    if (current === "blocked") continue;

    const hostSpecific = HOST_SPECIFIC_SKILLS.find(
      (entry) => entry.slug === slug,
    );
    if (hostSpecific !== undefined) {
      verdicts.set(slug, {
        slug,
        runnable: "blocked",
        reason: HOST_SPECIFIC_RULE_ID,
        reasonRef: hostSpecific.reasonRef,
      });
      continue;
    }
    // 已降过的不重复降：再跑一次不该把 reason_ref 越滚越长。
    if (current === "degraded") continue;

    const instructions =
      typeof row.instructions === "string" ? row.instructions : "";
    if (instructions === "") continue;
    const dropped = Array.isArray(porting.dropped)
      ? porting.dropped.map((entry) => String(entry))
      : [];
    const missing = findMissingAssetReferences({
      instructions,
      dropped,
      assets,
    });
    if (missing.length === 0) continue;
    verdicts.set(slug, {
      slug,
      runnable: "degraded",
      reason: MISSING_ASSET_RULE_ID,
      reasonRef: formatMissingAssetEvidence(missing),
    });
  }
  return verdicts;
}

/** Render extra `_porting` keys at the block's own indentation, in the assembler's quoting style. */
function renderPortingLines(fields: Record<string, string>): string[] {
  const text = stringifyYaml(fields, { lineWidth: 0 }).trimEnd();
  return text.split("\n").map((line) => `      ${line}`);
}

function findSingleLine(
  lines: readonly string[],
  start: number,
  end: number,
  match: (line: string) => boolean,
  what: string,
): number {
  const hits: number[] = [];
  for (let index = start; index < end; index += 1) {
    if (match(lines[index])) hits.push(index);
  }
  if (hits.length === 0) {
    throw new VerdictRefreshError(`${what}：块内找不到目标行`);
  }
  if (hits.length > 1) {
    throw new VerdictRefreshError(`${what}：块内目标行出现 ${hits.length} 次`);
  }
  return hits[0];
}

/** Locate one `- slug:` block; a duplicated slug means the file stopped being a map. */
function skillsBlock(
  lines: readonly string[],
  slug: string,
): { start: number; end: number } {
  const marker = `  - slug: ${slug}`;
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === marker) hits.push(index);
  }
  if (hits.length === 0) {
    throw new VerdictRefreshError(`skills.yaml 里没有 slug ${slug}`);
  }
  if (hits.length > 1) {
    throw new VerdictRefreshError(
      `skills.yaml 里 slug ${slug} 出现 ${hits.length} 次`,
    );
  }
  const start = hits[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("  - slug: ")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/**
 * Rewrite the verdict lines of the named skills, leaving every other byte alone.
 *
 * `runnable` is replaced in place and `reason`/`reason_ref` follow it directly — the same adjacency
 * `port:assemble` writes, so a reader (and `--check`) sees one shape regardless of who last touched it.
 */
export function applyVerdictsToSkillsYaml(
  text: string,
  verdicts: ReadonlyMap<string, RefreshVerdict>,
): string {
  if (verdicts.size === 0) return text;
  const lines = text.split("\n");
  const patches = [...verdicts.values()]
    .map((verdict) => ({ verdict, block: skillsBlock(lines, verdict.slug) }))
    .sort((left, right) => right.block.start - left.block.start);
  let output = lines;
  for (const { verdict, block } of patches) {
    const runnableAt = findSingleLine(
      output,
      block.start,
      block.end,
      (line) => line.startsWith("      runnable: "),
      `技能 ${verdict.slug}`,
    );
    let reasonEnd = runnableAt + 1;
    while (
      reasonEnd < block.end &&
      /^ {6}(reason|reason_ref):/.test(output[reasonEnd])
    ) {
      reasonEnd += 1;
    }
    const replacement = [
      `      runnable: ${verdict.runnable}`,
      ...renderPortingLines({ reason: verdict.reason }),
      ...renderPortingLines({ reason_ref: verdict.reasonRef }),
    ];
    output = [
      ...output.slice(0, runnableAt),
      ...replacement,
      ...output.slice(reasonEnd),
    ];
  }
  return output.join("\n");
}

/** The manifest row for one skill, as a `- kind:` block on the left margin. */
function manifestBlock(
  lines: readonly string[],
  slug: string,
): { start: number; end: number } | undefined {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("- kind: ")) starts.push(index);
  }
  for (const start of starts) {
    const next = starts.find((candidate) => candidate > start) ?? lines.length;
    const hasSlug = lines
      .slice(start, next)
      .some((line) => line.trimEnd() === `  slug: ${slug}`);
    if (hasSlug) return { start, end: next };
  }
  return undefined;
}

/**
 * Mirror the verdicts onto the manifest.
 *
 * The manifest has no `reason` field — it exists so a consumer that never reads `skills.yaml` still
 * sees the same verdict. A slug the manifest does not list is skipped here; `refreshPackageVerdicts`
 * is the one that fails the run, because that disagreement is a package defect, not a patch detail.
 */
export function applyVerdictsToManifestYaml(
  text: string,
  verdicts: ReadonlyMap<string, RefreshVerdict>,
): string {
  if (verdicts.size === 0) return text;
  const lines = text.split("\n");
  const patches = [...verdicts.values()]
    .map((verdict) => ({ verdict, block: manifestBlock(lines, verdict.slug) }))
    .filter(
      (
        patch,
      ): patch is {
        verdict: RefreshVerdict;
        block: { start: number; end: number };
      } => patch.block !== undefined,
    )
    .sort((left, right) => right.block.start - left.block.start);
  let output = lines;
  for (const { verdict, block } of patches) {
    const runnableAt = findSingleLine(
      output,
      block.start,
      block.end,
      (line) => line.startsWith("  runnable: "),
      `manifest 行 ${verdict.slug}`,
    );
    output = [
      ...output.slice(0, runnableAt),
      `  runnable: ${verdict.runnable}`,
      ...output.slice(runnableAt + 1),
    ];
  }
  return output.join("\n");
}

/** One skill's block as text, used to tell whether a patch actually changed it. */
function skillBlockText(text: string, slug: string): string {
  const lines = text.split("\n");
  const { start, end } = skillsBlock(lines, slug);
  return lines.slice(start, end).join("\n");
}

/** Skills whose on-disk verdict still disagrees with the recomputed one. */
function disagreementsOf(
  skillsText: string,
  verdicts: ReadonlyMap<string, RefreshVerdict>,
): RefreshVerdict[] {
  const rows =
    (parseYaml(skillsText) as { skills?: Record<string, unknown>[] }).skills ??
    [];
  return [...verdicts.values()].filter((verdict) => {
    const row = rows.find(
      (candidate) => String(candidate.slug) === verdict.slug,
    );
    if (row === undefined) return true;
    const porting = asRecord(row._porting ?? {}, `${verdict.slug} _porting`);
    return currentVerdict(porting) !== verdict.runnable;
  });
}

export interface RefreshResult {
  /** Disagreements left after this run: read mode reports them, write mode resolves them all. */
  pending: RefreshVerdict[];
  /** Verdicts whose lines this run actually rewrote (empty in read mode). */
  changed: RefreshVerdict[];
}

/**
 * Recompute and (optionally) write the verdicts of a package in place.
 *
 * `write: false` is the `--check` path: it reports what disagrees without touching disk, so CI can
 * assert the shipped package tells the truth about itself.
 */
export function refreshPackageVerdicts(input: {
  packageDir: string;
  write: boolean;
}): RefreshResult {
  const skillsPath = join(input.packageDir, "skills.yaml");
  const manifestPath = join(input.packageDir, "capability-manifest.yaml");
  const skillsText = readFileSync(skillsPath, "utf8");
  const manifestText = readFileSync(manifestPath, "utf8");
  const parsed = parseYaml(skillsText) as {
    skills?: Record<string, unknown>[];
  };
  const rows = parsed.skills ?? [];
  const manifestRows =
    (parseYaml(manifestText) as Record<string, unknown>[]) ?? [];

  const verdicts = computeRefreshVerdicts({
    skills: rows,
    assetExists: (slug, asset) =>
      existsSync(join(input.packageDir, "skills", slug, asset)),
  });

  const pending = input.write ? [] : disagreementsOf(skillsText, verdicts);
  for (const verdict of verdicts.values()) {
    const listed = manifestRows.some(
      (row) => row.kind === "skill" && String(row.slug) === verdict.slug,
    );
    if (!listed) {
      throw new VerdictRefreshError(
        `manifest 缺技能行 ${verdict.slug}：两份文件不一致时先修包，不要只改一半`,
      );
    }
  }

  const nextSkills = applyVerdictsToSkillsYaml(skillsText, verdicts);
  const nextManifest = applyVerdictsToManifestYaml(manifestText, verdicts);

  const changed = [...verdicts.values()].filter(
    (verdict) =>
      skillBlockText(skillsText, verdict.slug) !==
      skillBlockText(nextSkills, verdict.slug),
  );

  if (input.write) {
    if (nextSkills !== skillsText)
      writeFileSync(skillsPath, nextSkills, "utf8");
    if (nextManifest !== manifestText) {
      writeFileSync(manifestPath, nextManifest, "utf8");
    }
  }
  return { pending, changed: input.write ? changed : [] };
}

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;

const USAGE = `用法：
  bun run port:verdict-refresh -- --package <品牌包目录> [--check]

说明：
  按包内 _porting.dropped 与 assets 重算每个技能的档位，只改 _porting.runnable 及其
  reason/reason_ref 三行，manifest 同名行同步。--check 只报告不写盘：包与重算不一致时退出码 1。`;

/** CLI entry point; returns a process exit code so tests can drive `main` directly. */
export function main(argv: readonly string[]): number {
  let packageDir = "";
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      check = true;
      continue;
    }
    if (flag !== "--package") {
      console.error(
        `[port:verdict-refresh] 无法识别的参数：${flag}\n\n${USAGE}`,
      );
      return EXIT_USAGE;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      console.error(`[port:verdict-refresh] --package 缺少取值\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    packageDir = next;
    index += 1;
  }
  if (packageDir === "") {
    console.error(`[port:verdict-refresh] 缺少 --package\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const result = refreshPackageVerdicts({ packageDir, write: !check });
    if (result.pending.length > 0) {
      for (const verdict of result.pending) {
        console.error(
          `[port:verdict-refresh] 待改：${verdict.slug} → ${verdict.runnable}（${verdict.reason}）`,
        );
      }
      return EXIT_MISMATCH;
    }
    if (result.changed.length > 0) {
      console.log(
        `[port:verdict-refresh] 改写 ${result.changed.length} 项：${result.changed
          .map((verdict) => `${verdict.slug}→${verdict.runnable}`)
          .join("、")}`,
      );
    } else {
      console.log("[port:verdict-refresh] 档位与包内证据一致，未改动");
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof VerdictRefreshError) {
      console.error(`[port:verdict-refresh] 失败：${error.message}`);
      return EXIT_MISMATCH;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
