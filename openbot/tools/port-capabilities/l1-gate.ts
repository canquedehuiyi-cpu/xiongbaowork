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
 * Build the gate over a parsed lock document and an optional whitelist.
 *
 * The whitelist is a *narrowing* set of slugs: a unit must pass every rule above **and** appear in the
 * list when one is given. Passing `undefined` means "everything the licence rules allow".
 */
export function buildL1Gate(
  lock: LockDocument,
  whitelist?: readonly string[],
): L1Gate {
  const index = new Map<string, LockEntry>();
  for (const entry of lock.entries) {
    index.set(`${entry.kind}:${entry.slug}`, entry);
  }
  const allowedSlugs =
    whitelist === undefined ? undefined : new Set(whitelist);
  const decisions = new Map<string, GateDecision>();
  const stats = { asked: 0, allowed: 0, refused: 0 };
  const computeDecision = (slug: string, kind: LockKind): GateDecision => {
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
    if (allowedSlugs !== undefined && !allowedSlugs.has(slug)) {
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
  return { decide, decisions, stats };
}

/** Thrown when the cached bytes of a locked unit no longer match the lock's checksum. */
export class ChecksumMismatchError extends Error {}

/**
 * Verify that the cached copy of one locked unit still hashes to the lock's value, and return the
 * path that was verified.
 *
 * Directory units hash with the same canonicalisation the writer used ({@link directorySha256}), file
 * units with {@link fileSha256} — a mismatch means the cache drifted from the measured snapshot and
 * the unit must not enter a package.
 */
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
  const entry = decision.entry;
  const unitRoot = join(
    cacheRoot,
    CACHE_CHANNEL_ROOTS[entry.channel],
    ...entry.origin.split("/"),
  );
  if (!existsSync(unitRoot)) {
    throw new ChecksumMismatchError(
      `CHECKSUM_MISMATCH: ${kind}/${slug} 的缓存副本不存在：${posix.join(CACHE_CHANNEL_ROOTS[entry.channel], entry.origin)}`,
    );
  }
  const isDirectory = statSync(unitRoot).isDirectory();
  const actual = isDirectory
    ? directorySha256(unitRoot)
    : fileSha256(unitRoot);
  if (actual !== entry.checksum_sha256) {
    throw new ChecksumMismatchError(
      `CHECKSUM_MISMATCH: ${kind}/${slug} 缓存字节与锁不符（期望 ${entry.checksum_sha256.slice(0, 12)}…，实测 ${actual.slice(0, 12)}…）`,
    );
  }
  return unitRoot;
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
 * slug). Skills get a two-step kind probe — `skill`, then `official-plugin` — because official plugin
 * skill units are recorded at plugin granularity; anything neither record covers is `NOT_IN_LOCK`,
 * which is fail-closed by design: an unmeasured unit has no licence row, so it never enters a package.
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
      const first = gate.decide(skill.dirName, "skill");
      if (first.code !== "NOT_IN_LOCK") {
        return record(unit, first);
      }
      return record(unit, gate.decide(skill.dirName, "official-plugin"));
    }),
    connectors: snapshot.connectors.filter((connector) =>
      record(`connector:${connector.id}`, gate.decide(connector.id, "connector")),
    ),
  };
  return { snapshot: filtered, dropped, stats: { allowed, refused: dropped.length, byCode } };
}
