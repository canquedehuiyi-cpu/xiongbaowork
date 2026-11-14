/**
 * `l1-gate.ts` — the whitelist consumer of `capability-lock.yaml` (plan §2.2, step 3).
 *
 * The fetch side (scripts/fetch-capabilities.ts) produces the lock and the cache; this module is the
 * gate the converter consults before any L1 unit enters a brand package. Three rules are enforced here,
 * in this order, and every refusal carries a reason code so the dropped report can state *why*:
 *
 *   1. **Identity** — the unit must be in the lock. A unit the lock never measured has no provenance,
 *      no checksum and no licence row: refusing it is the whole point of a lock file.
 *   2. **Licence** — the owner's exclusion list ({@link LICENSE_EXCLUSIONS}) is checked *before* the
 *      `redistributable` flag, so a lock file that mis-records an excluded slug as redistributable
 *      still cannot smuggle it through. Defence in depth, not redundancy: `validateLockEntries` refuses
 *      to *write* such a lock, and the gate refuses to *read* one past it.
 *   3. **Redistribution** — `redistributable: false` refuses. On the current lock (532 entries) only a
 *      handful carry a cleared licence; the default is closed.
 *   4. **Whitelist** — when a caller narrows the gate with an explicit slug list, anything outside it
 *      refuses even if it passed the licence rules. The whitelist never *widens* the gate: it can only
 *      subtract.
 *
 * The checksum assert is the bridge between lock and cache: a unit whose on-disk bytes no longer hash
 * to the locked value must never enter a package — the lock's integrity claim would be silently void.
 *
 * Everything here is a pure function of its inputs: no clock, no hostname, no absolute paths.
 */
import { existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  LICENSE_EXCLUSIONS,
  assertValidLockEntries,
  directorySha256,
  fileSha256,
  type LockChannel,
  type LockDocument,
  type LockEntry,
  type LockKind,
} from "./lockfile";
import type { WorkBuddySnapshot } from "./read-workbuddy";

/**
 * Channel id → the directory under the fetch cache that holds that channel's snapshot.
 *
 * Must stay in lockstep with `CHANNELS[].homePath` in scripts/fetch-capabilities.ts — the cache is
 * materialised in a WorkBuddy-home-shaped layout, so a channel's lock `origin` paths are relative to
 * exactly this root. A drift between the two tables would point the checksum assert at the wrong
 * bytes, so both sides carry the same literal and a test pins them together.
 */
export const CACHE_CHANNEL_ROOTS: Readonly<Record<LockChannel, string>> = {
  "official-plugins": "plugins/marketplaces/codebuddy-plugins-official",
  experts: "plugins/marketplaces/experts",
  connectors: "connectors-marketplace",
};

/** Why the gate allowed or refused one unit. Refusals carry a human-readable reason too. */
export type GateDecisionCode =
  | "ALLOWED"
  | "NOT_IN_LOCK"
  | "LICENSE_EXCLUDED"
  | "NOT_REDISTRIBUTABLE"
  | "NOT_WHITELISTED";

/** One gate verdict: the code, the prose reason (rule id included), and the lock row when known. */
export interface GateDecision {
  code: GateDecisionCode;
  reason: string;
  /** The matching lock entry; `undefined` only for `NOT_IN_LOCK`. */
  entry?: LockEntry;
}

/** The gate object: decide one unit, or count every decision at once. */
export interface L1Gate {
  decide(slug: string, kind: LockKind): GateDecision;
  /**
   * Decide one flattened official-plugin skill unit by its provenance-preserving name
   * (`<plugin>--skills--<subpath with "/" folded to "--">`, e.g. `all-skills--skills--artifacts-builder`).
   * The lock row is the plugin; the whitelist may narrow at skill level with `pkg/subpath` entries.
   */
  decideOfficialPluginSkill(
    unitName: string,
    parsed: { pluginSlug: string; subpath: string },
  ): GateDecision;
  /** `slug` → decision, for the dropped report. Only entries the caller asked about appear here. */
  decisions: ReadonlyMap<string, GateDecision>;
  /** How many units the caller asked about, and how many passed. */
  readonly stats: { asked: number; allowed: number; refused: number };
}

/** The four `LockKind` values, so parse-side validation and callers agree on the set. */
const LOCK_KINDS: readonly LockKind[] = [
  "expert-package",
  "official-plugin",
  "skill",
  "connector",
];

const LOCK_CHANNELS: readonly LockChannel[] = [
  "official-plugins",
  "experts",
  "connectors",
];

const SHA256_HEX = /^[0-9a-f]{64}$/;

const ISO8601_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A lock `origin` must be a relative posix path: no absolute, no drive, no traversal, no backslash.
 * Trailing slashes are tolerated (the fetch script emits some origins that way) and are stripped
 * before the segment check — they are harmless to path joins downstream. */
export function isSafeLockOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string" || origin === "") {
    return false;
  }
  const trimmed = origin.replace(/\/+$/, "");
  if (trimmed === "") {
    return false;
  }
  return (
    !trimmed.startsWith("/") &&
    !/^[A-Za-z]:/.test(trimmed) &&
    !trimmed.includes("\\") &&
    trimmed
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/**
 * Split an official-plugin skill unit's provenance-preserving name into its plugin slug and the
 * skill's sub-path inside the plugin.
 *
 * The fetch script flattens official skill units into `skills/<unitName>` with
 * `<plugin>--skills--<subpath with "/" folded to "--">` names (see `discoverOfficialSkillUnits` in
 * `scripts/fetch-capabilities.ts`) — the lock records the plugin, so the unit maps to the plugin row
 * plus this sub-path. Returns `undefined` for names without the marker: those are plain skills or
 * whole plugins and match lock rows directly.
 *
 * The first `--skills--` marker wins. A plugin whose own name contains the marker would be ambiguous
 * at the fetch layer already (the unit name grammar cannot express it), so none can exist.
 */
export function parseOfficialSkillUnitName(
  unitName: string,
): { pluginSlug: string; subpath: string } | undefined {
  const marker = "--skills--";
  const markerIndex = unitName.indexOf(marker);
  if (markerIndex <= 0 || markerIndex + marker.length >= unitName.length) {
    return undefined;
  }
  return {
    pluginSlug: unitName.slice(0, markerIndex),
    subpath: unitName
      .slice(markerIndex + marker.length)
      .split("--")
      .join("/"),
  };
}

/** Thrown when a lock document does not parse back into the shape the gate trusts. */
export class LockParseError extends Error {}

/**
 * Parse `capability-lock.yaml` text into a {@link LockDocument}, fail-closed.
 *
 * Beyond the YAML shape, every entry goes through `assertValidLockEntries` — the same §6.4 nine-field
 * validation the writer side runs — so a hand-edited lock cannot slip a licence field past the gate.
 * The `version` field is pinned to 2: the gate refuses a lock whose format it was not built for, rather
 * than guessing at unknown fields.
 */
export function parseLockDocument(text: string): LockDocument {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new LockParseError(
      `capability-lock.yaml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LockParseError("capability-lock.yaml 顶层必须是映射");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 2) {
    throw new LockParseError(
      `capability-lock version 必须是 2（gate 不认识其他格式），当前 ${String(doc.version)}`,
    );
  }
  for (const field of ["phase", "cache_dir", "generated_from", "fetched_at"] as const) {
    if (typeof doc[field] !== "string" || (doc[field] as string) === "") {
      throw new LockParseError(`capability-lock.${field} 必须是非空字符串`);
    }
  }
  if (!ISO8601_Z.test(doc.fetched_at as string)) {
    throw new LockParseError("capability-lock.fetched_at 必须是 ISO8601 Z 时刻");
  }
  if (!Array.isArray(doc.channels) || doc.channels.length === 0) {
    throw new LockParseError("capability-lock.channels 必须是非空数组");
  }
  const channelIds = new Set<string>();
  for (const channel of doc.channels as Record<string, unknown>[]) {
    if (typeof channel !== "object" || channel === null) {
      throw new LockParseError("capability-lock.channels 元素必须是映射");
    }
    if (
      typeof channel.id !== "string" ||
      !LOCK_CHANNELS.includes(channel.id as LockChannel)
    ) {
      throw new LockParseError(
        `capability-lock.channels[].id 必须是 ${LOCK_CHANNELS.join(" / ")}，当前 ${String(channel.id)}`,
      );
    }
    channelIds.add(channel.id);
    if (typeof channel.url !== "string" || typeof channel.note !== "string") {
      throw new LockParseError(`capability-lock.channels[${String(channel.id)}] 的 url/note 必须是字符串`);
    }
    if (typeof channel.url_verified !== "boolean") {
      throw new LockParseError(`capability-lock.channels[${String(channel.id)}].url_verified 必须是布尔`);
    }
    if (
      typeof channel.index_checksum_sha256 !== "string" ||
      !SHA256_HEX.test(channel.index_checksum_sha256)
    ) {
      throw new LockParseError(
        `capability-lock.channels[${String(channel.id)}].index_checksum_sha256 必须是 64 位小写十六进制`,
      );
    }
  }
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    throw new LockParseError("capability-lock.entries 必须是非空数组");
  }
  if (
    doc.entries_count !== undefined &&
    doc.entries_count !== doc.entries.length
  ) {
    throw new LockParseError(
      `capability-lock.entries_count（${String(doc.entries_count)}）与 entries 实际条数（${doc.entries.length}）不一致——文件可能被手改残缺`,
    );
  }
  for (const entry of doc.entries as Record<string, unknown>[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new LockParseError("capability-lock.entries 元素必须是映射");
    }
    if (typeof entry.slug !== "string" || entry.slug === "") {
      throw new LockParseError("capability-lock.entries[].slug 必须是非空字符串");
    }
    if (typeof entry.kind !== "string" || !LOCK_KINDS.includes(entry.kind as LockKind)) {
      throw new LockParseError(
        `capability-lock.entries[${String(entry.slug)}].kind 必须是 ${LOCK_KINDS.join(" / ")}`,
      );
    }
    if (typeof entry.channel !== "string" || !LOCK_CHANNELS.includes(entry.channel as LockChannel)) {
      throw new LockParseError(
        `capability-lock.entries[${String(entry.slug)}].channel 必须是 ${LOCK_CHANNELS.join(" / ")}`,
      );
    }
    if (!channelIds.has(entry.channel as string)) {
      throw new LockParseError(
        `capability-lock.entries[${String(entry.slug)}].channel 指向未声明的通道 ${String(entry.channel)}`,
      );
    }
    if (!isSafeLockOrigin(entry.origin)) {
      throw new LockParseError(
        `capability-lock.entries[${String(entry.slug)}].origin 必须是相对 posix 路径（禁绝对/穿越/反斜杠）：${String(entry.origin)}`,
      );
    }
    if (
      typeof entry.checksum_sha256 !== "string" ||
      !SHA256_HEX.test(entry.checksum_sha256)
    ) {
      throw new LockParseError(
        `capability-lock.entries[${String(entry.slug)}].checksum_sha256 必须是 64 位小写十六进制`,
      );
    }
    if (typeof entry.redistributable !== "boolean") {
      throw new LockParseError(
        `capability-lock.entries[${String(entry.slug)}].redistributable 必须是布尔`,
      );
    }
  }
  // The §6.4 nine licence fields, re-checked with the writer-side validator: one door, two locks.
  assertValidLockEntries(doc.entries as LockEntry[]);
  return doc as unknown as LockDocument;
}

/**
 * Split whitelist entries into whole-package slugs and per-package skill sub-paths.
 *
 * `pkg` means "the whole package may enter"; `pkg/skill/sub` means "only that skill of the package".
 * A package that appears only through sub-path entries is narrowed at skill level: its flattened
 * skill units need their own listed sub-path, and the package as a unit (an `expert-package` row, a
 * connector, or a plugin whose whole directory is one skill) still needs a plain entry to enter.
 */
function parseWhitelistEntries(
  whitelist: readonly string[] | undefined,
): { plain: Set<string> | undefined; sub: Map<string, Set<string>> } {
  if (whitelist === undefined) {
    return { plain: undefined, sub: new Map() };
  }
  const plain = new Set<string>();
  const sub = new Map<string, Set<string>>();
  for (const raw of whitelist) {
    const entry = raw.trim();
    if (entry === "") {
      throw new Error("白名单条目不能为空字符串");
    }
    if (!/^[^\s/]+(\/[^\s/]+)*$/.test(entry)) {
      throw new Error(
        `白名单条目格式非法（应为 slug 或 slug/skill 子路径，禁空白与空路径段）：${JSON.stringify(raw)}`,
      );
    }
    const slashIndex = entry.indexOf("/");
    if (slashIndex === -1) {
      plain.add(entry);
    } else {
      const pkg = entry.slice(0, slashIndex);
      const rest = entry.slice(slashIndex + 1);
      const set = sub.get(pkg) ?? new Set<string>();
      set.add(rest);
      sub.set(pkg, set);
    }
  }
  return { plain, sub };
}

/**
 * Build the gate over a parsed lock document and an optional whitelist.
 *
 * The whitelist is a *narrowing* set of slugs: a unit must pass every rule above **and** appear in the
 * list when one is given. Passing `undefined` means "everything the licence rules allow". Entries of
 * the form `pkg/skill` narrow at skill level for flattened official-plugin units (see
 * {@link parseOfficialSkillUnitName}); plain `pkg` entries keep the whole-package meaning.
 */
export function buildL1Gate(
  lock: LockDocument,
  whitelist?: readonly string[],
): L1Gate {
  const index = new Map<string, LockEntry>();
  for (const entry of lock.entries) {
    index.set(`${entry.kind}:${entry.slug}`, entry);
  }
  const { plain: allowedSlugs, sub: whitelistSub } =
    parseWhitelistEntries(whitelist);
  const decisions = new Map<string, GateDecision>();
  const stats = { asked: 0, allowed: 0, refused: 0 };
  const computeDecision = (
    slug: string,
    kind: LockKind,
    whitelistOk: (slug: string) => boolean = (candidate) =>
      allowedSlugs === undefined || allowedSlugs.has(candidate),
  ): GateDecision => {
    const entry = index.get(`${kind}:${slug}`);
    if (entry === undefined) {
      return {
        code: "NOT_IN_LOCK",
        reason: `NOT_IN_LOCK: ${kind}/${slug} 不在 capability-lock 内（无来源、无校验和、无许可记录）`,
      };
    }
    const exclusion = LICENSE_EXCLUSIONS[slug];
    if (exclusion !== undefined) {
      return {
        code: "LICENSE_EXCLUDED",
        reason: `LICENSE_EXCLUDED: ${slug} 在 owner 排除清单内（${exclusion}），无论锁内标记如何均不得进入品牌包`,
        entry,
      };
    }
    if (entry.redistributable !== true) {
      return {
        code: "NOT_REDISTRIBUTABLE",
        reason: `NOT_REDISTRIBUTABLE: ${slug} 锁内标记 redistributable: false（license=${entry.license}）`,
        entry,
      };
    }
    if (allowedSlugs !== undefined && !whitelistOk(slug)) {
      return {
        code: "NOT_WHITELISTED",
        reason: `NOT_WHITELISTED: ${slug} 通过许可规则但不在本次白名单内`,
        entry,
      };
    }
    return {
      code: "ALLOWED",
      reason: `ALLOWED: ${slug}（${entry.channel}/${entry.kind}，license=${entry.license}）`,
      entry,
    };
  };
  const decide = (slug: string, kind: LockKind): GateDecision => {
    const key = `${kind}:${slug}`;
    const cached = decisions.get(key);
    if (cached !== undefined) {
      return cached;
    }
    stats.asked += 1;
    const decision = computeDecision(slug, kind);
    if (decision.code === "ALLOWED") {
      stats.allowed += 1;
    } else {
      stats.refused += 1;
    }
    decisions.set(key, decision);
    return decision;
  };
  /**
   * Decide one flattened official-plugin skill unit. The licence/exclusion/redistributable rules run
   * against the plugin row; the whitelist passes when the plugin has a plain entry, or when the
   * unit's own sub-path is listed under `plugin/subpath` — a package listed only through sub-paths
   * never lets a unit through whose sub-path is missing.
   */
  const decideOfficialPluginSkill = (
    unitName: string,
    parsed: { pluginSlug: string; subpath: string },
  ): GateDecision => {
    const key = `official-plugin:${parsed.pluginSlug}#${parsed.subpath}`;
    const cached = decisions.get(key);
    if (cached !== undefined) {
      return cached;
    }
    stats.asked += 1;
    const pluginDecision = computeDecision(
      parsed.pluginSlug,
      "official-plugin",
      (candidate) =>
        allowedSlugs === undefined ||
        allowedSlugs.has(candidate) ||
        (whitelistSub.get(candidate)?.size ?? 0) > 0,
    );
    let decision: GateDecision;
    if (pluginDecision.code === "NOT_WHITELISTED") {
      decision = {
        code: "NOT_WHITELISTED",
        reason: `NOT_WHITELISTED: ${unitName}（官方插件 ${parsed.pluginSlug}）不在本次白名单内`,
        entry: pluginDecision.entry,
      };
    } else if (pluginDecision.code !== "ALLOWED") {
      decision = pluginDecision;
    } else {
      // A plain `pkg` entry admits the whole package, so a `pkg/sub` entry must not re-narrow it:
      // the sub-path set only bites when the package is listed *exclusively* through sub-paths.
      const subs =
        allowedSlugs !== undefined && allowedSlugs.has(parsed.pluginSlug)
          ? undefined
          : whitelistSub.get(parsed.pluginSlug);
      decision =
        subs !== undefined && !subs.has(parsed.subpath)
          ? {
              code: "NOT_WHITELISTED",
              reason: `NOT_WHITELISTED: ${unitName} 通过许可规则，但白名单对 ${parsed.pluginSlug} 只放行 [${[...subs].sort().join(", ")}]，不含 ${parsed.subpath}`,
              entry: pluginDecision.entry,
            }
          : pluginDecision;
    }
    if (decision.code === "ALLOWED") {
      stats.allowed += 1;
    } else {
      stats.refused += 1;
    }
    decisions.set(key, decision);
    return decision;
  };
  return { decide, decideOfficialPluginSkill, decisions, stats };
}

/** Thrown when the cached bytes of a locked unit no longer match the lock's checksum. */
export class ChecksumMismatchError extends Error {}

/**
 * Verify that the cached copy of one lock entry still hashes to the entry's checksum, and return the
 * path that was verified.
 *
 * Directory units hash with the same canonicalisation the writer used ({@link directorySha256}), file
 * units with {@link fileSha256} — a mismatch means the cache drifted from the measured snapshot and
 * the unit must not enter a package.
 */
export function assertEntryBytesMatchesLock(
  cacheRoot: string,
  entry: LockEntry,
): string {
  const unitRoot = join(
    cacheRoot,
    CACHE_CHANNEL_ROOTS[entry.channel],
    ...entry.origin.split("/"),
  );
  if (!existsSync(unitRoot)) {
    throw new ChecksumMismatchError(
      `CHECKSUM_MISMATCH: ${entry.kind}/${entry.slug} 的缓存副本不存在：${posix.join(CACHE_CHANNEL_ROOTS[entry.channel], entry.origin)}`,
    );
  }
  const isDirectory = statSync(unitRoot).isDirectory();
  const actual = isDirectory
    ? directorySha256(unitRoot)
    : fileSha256(unitRoot);
  if (actual !== entry.checksum_sha256) {
    throw new ChecksumMismatchError(
      `CHECKSUM_MISMATCH: ${entry.kind}/${entry.slug} 缓存字节与锁不符（期望 ${entry.checksum_sha256.slice(0, 12)}…，实测 ${actual.slice(0, 12)}…）`,
    );
  }
  return unitRoot;
}

/** Verify that the cached copy of one locked unit still hashes to the lock's value. */
export function assertCacheEntryMatchesLock(
  gate: L1Gate,
  cacheRoot: string,
  slug: string,
  kind: LockKind,
): string {
  const decision = gate.decide(slug, kind);
  if (decision.entry === undefined) {
    throw new Error(decision.reason);
  }
  return assertEntryBytesMatchesLock(cacheRoot, decision.entry);
}

/** One snapshot unit the gate refused, ready for the dropped report. */
export interface GateDroppedUnit {
  /** Source-unit identity as the snapshot knows it, e.g. `expert-package:frontend-developer`. */
  unit: string;
  code: GateDecisionCode;
  reason: string;
}

/** The snapshot with gate-refused units removed, plus the refusal record. */
export interface GateFilterResult {
  snapshot: WorkBuddySnapshot;
  dropped: GateDroppedUnit[];
  /** Counts per decision code, in first-seen order. */
  stats: { allowed: number; refused: number; byCode: Record<string, number> };
}

/**
 * Filter a snapshot through the gate at source-unit granularity.
 *
 * Expert packages and connectors match the lock directly (package dir name / connector id is the lock
 * slug). Skill units get a three-step probe — `skill`, then the flattened official-plugin mapping
 * (`<plugin>--skills--<sub>` → the plugin row + skill-level whitelist narrowing), then
 * `official-plugin` for whole-plugin units — because official plugin skill units are recorded at
 * plugin granularity; anything no probe covers is `NOT_IN_LOCK`, which is fail-closed by design: an
 * unmeasured unit has no licence row, so it never enters a package.
 */
export function filterSnapshotByGate(
  snapshot: WorkBuddySnapshot,
  gate: L1Gate,
): GateFilterResult {
  const dropped: GateDroppedUnit[] = [];
  const byCode: Record<string, number> = {};
  let allowed = 0;
  const record = (unit: string, decision: GateDecision): boolean => {
    byCode[decision.code] = (byCode[decision.code] ?? 0) + 1;
    if (decision.code === "ALLOWED") {
      allowed += 1;
      return true;
    }
    dropped.push({ unit, code: decision.code, reason: decision.reason });
    return false;
  };
  const filtered: WorkBuddySnapshot = {
    sourceRoot: snapshot.sourceRoot,
    packages: snapshot.packages.filter((pkg) =>
      record(`expert-package:${pkg.dirName}`, gate.decide(pkg.dirName, "expert-package")),
    ),
    userSkills: snapshot.userSkills.filter((skill) => {
      const unit = `skill:${skill.dirName}`;
      const direct = gate.decide(skill.dirName, "skill");
      if (direct.code !== "NOT_IN_LOCK") {
        return record(unit, direct);
      }
      const parsed = parseOfficialSkillUnitName(skill.dirName);
      if (parsed !== undefined) {
        return record(unit, gate.decideOfficialPluginSkill(skill.dirName, parsed));
      }
      return record(unit, gate.decide(skill.dirName, "official-plugin"));
    }),
    connectors: snapshot.connectors.filter((connector) =>
      record(`connector:${connector.id}`, gate.decide(connector.id, "connector")),
    ),
  };
  return { snapshot: filtered, dropped, stats: { allowed, refused: dropped.length, byCode } };
}

/** Outcome of the batch byte verification of every unit the gate allowed. */
export interface GateVerification {
  /** Distinct lock rows whose cached bytes were hashed and matched. */
  verified: number;
  /**
   * Units skipped because their cache root does not exist. Only possible in non-strict mode — a live
   * WorkBuddy home may not ship the marketplace bundle a lock row was measured from, while a fetch
   * cache must contain every origin the lock records.
   */
  warnings: string[];
}

/**
 * Batch-verify the cached bytes of every unit the gate allowed against the lock's checksums.
 *
 * Flattened official-plugin skill units verify their *plugin* directory once per plugin — the lock
 * row measures the plugin, so one hash covers all of its skills. `strict` (a fetch cache: the
 * `channel-provenance.json` marker file is present) turns a missing unit root into an error; in a
 * live home the root may legitimately be absent and the unit is skipped with a warning instead.
 * Present-but-drifted bytes throw in both modes: the lock is the measured truth.
 */
export function verifyAllowedUnits(
  gated: GateFilterResult,
  gate: L1Gate,
  cacheRoot: string,
  options: { strict: boolean },
): GateVerification {
  const verified = new Set<string>();
  const warned = new Set<string>();
  const warnings: string[] = [];
  const verifyDecision = (decision: GateDecision, unit: string): void => {
    if (decision.code !== "ALLOWED") {
      throw new Error(
        `verifyAllowedUnits: ${unit} 未被放行（${decision.code}）——闸门与校验状态不一致`,
      );
    }
    const entry = decision.entry;
    if (entry === undefined) {
      throw new Error(`verifyAllowedUnits: ${unit} 无锁行——闸门与校验状态不一致`);
    }
    const rowKey = `${entry.channel}:${entry.origin}`;
    if (verified.has(rowKey) || warned.has(rowKey)) {
      return;
    }
    const unitRoot = join(
      cacheRoot,
      CACHE_CHANNEL_ROOTS[entry.channel],
      ...entry.origin.split("/"),
    );
    if (!existsSync(unitRoot)) {
      if (options.strict) {
        throw new ChecksumMismatchError(
          `CHECKSUM_MISMATCH: ${entry.kind}/${entry.slug} 的缓存副本不存在：${posix.join(CACHE_CHANNEL_ROOTS[entry.channel], entry.origin)}`,
        );
      }
      warned.add(rowKey);
      warnings.push(
        `${entry.kind}/${entry.slug}：锁行来源 ${posix.join(CACHE_CHANNEL_ROOTS[entry.channel], entry.origin)} 在本机不存在，跳过字节校验`,
      );
      return;
    }
    assertEntryBytesMatchesLock(cacheRoot, entry);
    verified.add(rowKey);
  };
  for (const pkg of gated.snapshot.packages) {
    verifyDecision(
      gate.decide(pkg.dirName, "expert-package"),
      `expert-package:${pkg.dirName}`,
    );
  }
  for (const connector of gated.snapshot.connectors) {
    verifyDecision(gate.decide(connector.id, "connector"), `connector:${connector.id}`);
  }
  for (const skill of gated.snapshot.userSkills) {
    const parsed = parseOfficialSkillUnitName(skill.dirName);
    if (parsed !== undefined) {
      verifyDecision(
        gate.decideOfficialPluginSkill(skill.dirName, parsed),
        `skill:${skill.dirName}`,
      );
      continue;
    }
    const direct = gate.decide(skill.dirName, "skill");
    verifyDecision(
      direct.code !== "NOT_IN_LOCK" ? direct : gate.decide(skill.dirName, "official-plugin"),
      `skill:${skill.dirName}`,
    );
  }
  return { verified: verified.size, warnings };
}
