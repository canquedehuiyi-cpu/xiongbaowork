/**
 * `capability-lock.yaml` — the lock file that expresses L1 completeness instead of git content (§2.2).
 *
 * One entry per capability package the L1 channels carry: the expert marketplace packages, the official
 * plugin marketplace packages, the skills bundled inside expert packages, and every connector definition.
 * What enters the repository is this file, not the ~140MB of marketplace content — so every entry must be
 * able to stand alone: where the content came from, which version, which bytes (sha256), under what
 * licence, and whether it may ever be redistributed.
 *
 * Two rules are enforced here, not by convention:
 *
 *   1. The nine licence fields (§6.4) must be present on every entry. A row missing one is refused —
 *      `validateLockEntries` returns a violation and the fetch script turns that into exit code 1. An
 *      optional field would equal a missing field, so nothing here defaults a licence field into
 *      existence.
 *   2. The exclusion list {@link LICENSE_EXCLUSIONS} is owner-decided and load-bearing: `guizang-ppt-skill`
 *      and `taskmaster` must never appear as `redistributable: true`, whichever licence text their bundled
 *      files happen to carry. The validator checks the invariant directly on the entries, so removing the
 *      applier from the pipeline cannot smuggle an excluded slug through — the check fires on the data,
 *      not on the code path that produced it.
 *
 * Everything in this module is a pure function of its inputs: rendering the same entries twice is
 * byte-identical, and the renderer never reads a clock, a hostname, or a platform path separator.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The granularity a lock entry talks about. */
export type LockKind =
  | "expert-package"
  | "official-plugin"
  | "skill"
  | "connector";

/** Which L1 channel an entry was found in. Also the directory name under the fetch cache. */
export type LockChannel = "official-plugins" | "experts" | "connectors";

/** One row of `capability-lock.yaml`. Field order here is the emitted order. */
export interface LockEntry {
  /** Identity of the unit. Unique within `kind` — the validator rejects duplicates. */
  slug: string;
  kind: LockKind;
  /** Which channel carried it; pins the entry to one fetchable source. */
  channel: LockChannel;
  /** Path of the unit inside the channel snapshot, posix, relative to the channel root. Never absolute. */
  origin: string;
  /** Prose provenance: the URL when one is recorded, otherwise the local snapshot it was measured from. */
  source: string;
  /** The bundle URL the channel was fetched from, or `""` when the channel records none. */
  source_url: string;
  /** Version as the source declares it; `unspecified` when it declares none. Never guessed. */
  source_version: string;
  /** sha256 over the unit's bytes, lowercase hex — see {@link directorySha256} / {@link fileSha256}. */
  checksum_sha256: string;
  license: string;
  redistributable: boolean;
  attribution: string;
  /** ISO8601 instant with `Z`, taken from the source's own metadata — never from the clock. */
  fetched_at: string;
}

/**
 * The nine licence fields §6.4 requires. `slug`, `kind`, `channel` and `origin` are identity and sit
 * outside this list on purpose; they are validated separately, just as strictly.
 */
export const REQUIRED_LOCK_FIELDS: readonly (keyof LockEntry)[] = [
  "source",
  "source_version",
  "checksum_sha256",
  "license",
  "redistributable",
  "attribution",
  "fetched_at",
];

/**
 * Slugs that may never be `redistributable: true`, with the licence the exclusion is based on.
 *
 * Both rows are owner decisions (拍板), not derivations from the bundled files:
 *
 * - `guizang-ppt-skill`: AGPL-3.0 per the owner's decision. The copy installed in
 *   `humanize-ppt-team/skills/guizang-ppt-skill` carries a `LICENSE` file and a README that both say
 *   "MIT © 2026 op7418" — recorded here so nobody rediscovers the contradiction and assumes it voids the
 *   rule. The bundled text does not override the decision; if the licence is ever to change, the owner
 *   changes this row, and the validator below makes the decision visible in every lock file it accepts.
 * - `taskmaster`: its `plugin.json` declares `MIT WITH Commons-Clause`. The MIT part does not lift the
 *   Commons Clause's sale restriction, so the effective licence is not redistributable. The verbatim
 *   string stays in `license`; the exclusion keys on the slug.
 */
export const LICENSE_EXCLUSIONS: Readonly<Record<string, string>> = {
  "guizang-ppt-skill": "AGPL-3.0",
  taskmaster: "Commons-Clause",
};

/** Lowercase substring every excluded entry's `license` must mention, keyed by slug. */
export const EXCLUSION_LICENSE_MARKERS: Readonly<Record<string, string>> = {
  "guizang-ppt-skill": "agpl",
  taskmaster: "commons-clause",
};

/** The licence ids this pipeline is willing to derive `redistributable: true` from. */
export const PERMISSIVE_LOCK_LICENSES: readonly string[] = [
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
];

/** ISO8601 instant with a `Z` suffix — what `fetched_at` must look like. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Lowercase SHA-256, exactly 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One thing wrong with one lock entry. */
export interface LockViolation {
  /** Entry index in the list that was validated. */
  index: number;
  slug: string;
  field: string;
  problem: string;
}

/** sha256 over bytes, lowercase hex. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 over one file's bytes, lowercase hex. Throws when the file cannot be read. */
export function fileSha256(absolutePath: string): string {
  return sha256Hex(readFileSync(absolutePath));
}

/**
 * sha256 over a directory's content: one line per file, `${posixRelativePath}\t${fileSha256}`, sorted,
 * LF-joined, hashed. File metadata (mtime, mode) is deliberately excluded — two snapshots of the same
 * content must hash equal regardless of when they were written to disk.
 *
 * An empty directory hashes the empty string, which is a distinct value, not a skip: a package that
 * lost every file must not look like a package nobody measured.
 */
export function directorySha256(root: string, prefix = ""): string {
  const lines: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const childAbsolute = join(absolute, entry.name);
      const childRelative =
        relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      lines.push(`${childRelative}\t${fileSha256(childAbsolute)}`);
    }
  };
  walk(root, prefix);
  return sha256Hex(`${lines.join("\n")}\n`);
}

/**
 * Apply {@link LICENSE_EXCLUSIONS} to one entry, returning it unchanged when it is not excluded.
 *
 * `redistributable` is always forced to `false`. The `license` field is only rewritten when the entry's
 * own text contradicts the exclusion — `taskmaster` already declares `MIT WITH Commons-Clause` verbatim,
 * which mentions the marker and stays verbatim, while a `guizang-ppt-skill` whose bundled files say MIT
 * would otherwise record a licence the owner has explicitly overridden, so it is replaced by the
 * exclusion's id. Either way the validator's invariant (excluded licence family recorded + not
 * redistributable) holds on the returned entry.
 */
export function applyLicenseExclusions(entry: LockEntry): LockEntry {
  const excludedLicense = LICENSE_EXCLUSIONS[entry.slug];
  if (excludedLicense === undefined) {
    return entry;
  }
  const marker = EXCLUSION_LICENSE_MARKERS[entry.slug];
  const license = entry.license.toLowerCase().includes(marker)
    ? entry.license
    : excludedLicense;
  return { ...entry, license, redistributable: false };
}

/** Whether a licence id is one this pipeline derives `redistributable: true` from. */
export function isPermissiveLockLicense(license: string): boolean {
  return PERMISSIVE_LOCK_LICENSES.includes(license.trim().toLowerCase());
}

/**
 * Check every entry against every rule and return all violations.
 *
 * Returning a list rather than throwing on the first problem is deliberate: the fetch run wants the
 * whole bad set in one pass, and a lock file is reviewed as a whole. Rules checked here:
 *
 * - identity: non-empty `slug`, known `kind`, known `channel`, non-empty posix `origin`;
 * - the nine §6.4 fields present and well-formed (checksum shape, `fetched_at` shape, boolean);
 * - uniqueness of `kind:slug`;
 * - the exclusion invariant: a slug in {@link LICENSE_EXCLUSIONS} must carry the exclusion's licence id
 *   and must not be `redistributable: true` — whatever upstream pipeline produced the entry.
 */
export function validateLockEntries(
  entries: readonly LockEntry[],
): LockViolation[] {
  const violations: LockViolation[] = [];
  const push = (
    index: number,
    slug: string,
    field: string,
    problem: string,
  ) => {
    violations.push({ index, slug, field, problem });
  };
  const kinds: readonly LockKind[] = [
    "expert-package",
    "official-plugin",
    "skill",
    "connector",
  ];
  const channels: readonly LockChannel[] = [
    "official-plugins",
    "experts",
    "connectors",
  ];
  entries.forEach((entry, index) => {
    if (
      entry.slug === undefined ||
      entry.slug === null ||
      String(entry.slug).trim() === ""
    ) {
      push(index, String(entry.slug), "slug", "缺失或为空");
    }
    if (!kinds.includes(entry.kind)) {
      push(index, entry.slug, "kind", `未知 kind: ${String(entry.kind)}`);
    }
    if (!channels.includes(entry.channel)) {
      push(
        index,
        entry.slug,
        "channel",
        `未知 channel: ${String(entry.channel)}`,
      );
    }
    if (typeof entry.origin !== "string" || entry.origin.trim() === "") {
      push(index, entry.slug, "origin", "缺失或为空");
    } else if (entry.origin.startsWith("/") || entry.origin.includes("\\")) {
      // Emitted origins are always posix relative, on every platform: an absolute path or a backslash
      // means an absolute path leaked into the lock, which is exactly what the format exists to prevent.
      push(
        index,
        entry.slug,
        "origin",
        `必须是通道内 posix 相对路径: ${entry.origin}`,
      );
    }
    for (const field of REQUIRED_LOCK_FIELDS) {
      const value = (entry as unknown as Record<string, unknown>)[field];
      if (value === undefined || value === null) {
        push(index, entry.slug, field, "缺失");
        continue;
      }
      if (typeof value === "string" && value.trim() === "") {
        push(index, entry.slug, field, "缺失或为空");
      }
    }
    if (typeof entry.redistributable !== "boolean") {
      push(index, entry.slug, "redistributable", "必须是布尔值");
    }
    if (
      typeof entry.fetched_at === "string" &&
      !ISO_INSTANT.test(entry.fetched_at)
    ) {
      push(
        index,
        entry.slug,
        "fetched_at",
        `不是 ISO8601 时刻: ${entry.fetched_at}`,
      );
    }
    if (
      typeof entry.checksum_sha256 === "string" &&
      !SHA256_HEX.test(entry.checksum_sha256)
    ) {
      push(index, entry.slug, "checksum_sha256", "必须是 64 位小写十六进制");
    }
    const excludedLicense = LICENSE_EXCLUSIONS[entry.slug];
    if (excludedLicense !== undefined) {
      const marker = EXCLUSION_LICENSE_MARKERS[entry.slug];
      if (
        typeof entry.license === "string" &&
        !entry.license.toLowerCase().includes(marker)
      ) {
        push(
          index,
          entry.slug,
          "license",
          `被排除条目必须记录排除依据的许可 ${excludedLicense}，当前是 ${entry.license}`,
        );
      }
      if (entry.redistributable === true) {
        push(
          index,
          entry.slug,
          "redistributable",
          `被排除条目（${excludedLicense}）不得标记为可再分发`,
        );
      }
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
export function formatLockViolations(
  violations: readonly LockViolation[],
): string {
  return violations
    .map(
      (violation) =>
        `  - 第 ${violation.index + 1} 行 ${violation.slug}: ${violation.field} — ${violation.problem}`,
    )
    .join("\n");
}

/** Throw when any entry fails validation, so no lock file is written from an invalid set. */
export function assertValidLockEntries(entries: readonly LockEntry[]): void {
  const violations = validateLockEntries(entries);
  if (violations.length > 0) {
    throw new Error(
      `capability-lock 校验失败（${violations.length} 处）：\n${formatLockViolations(violations)}`,
    );
  }
}

/** Per-channel provenance, recorded once in the header instead of repeating it on every entry. */
export interface LockChannelProvenance {
  id: LockChannel;
  /** Prose: where the snapshot was measured from. */
  source: string;
  /** The bundle URL, when the channel records one; `""` otherwise. */
  url: string;
  /** Whether the URL has been observed to serve the bundle (`true` for a channel with a recorded download). */
  url_verified: boolean;
  /** Upstream version marker: an etag, a bundle timestamp, or `unspecified`. */
  version: string;
  /** sha256 of the channel's index file, pinning the entries to one catalogue revision. */
  index_checksum_sha256: string;
  note: string;
}

/** The whole lock document, as `capability-lock.yaml` is shaped. */
export interface LockDocument {
  version: number;
  phase: string;
  cache_dir: string;
  /** How the entries were produced. `local-snapshot` is the honest value until a URL serves a bundle. */
  generated_from: string;
  /** Latest source-side timestamp across the channels; never the run clock. */
  fetched_at: string;
  channels: LockChannelProvenance[];
  entries: LockEntry[];
}

/** Sort helper: channel, then kind, then slug, so two runs diff clean. */
export function compareLockEntries(a: LockEntry, b: LockEntry): number {
  return (
    a.channel.localeCompare(b.channel) ||
    a.kind.localeCompare(b.kind) ||
    a.slug.localeCompare(b.slug) ||
    a.origin.localeCompare(b.origin)
  );
}

/**
 * Render one entry as a single YAML flow mapping on one line.
 *
 * A five-hundred-entry lock file in block style would be seven thousand lines of punctuation between the
 * fields a reviewer actually reads; one line per entry keeps `git diff` on the lock readable — one
 * changed package is one changed line. Strings are emitted with `JSON.stringify`, whose double-quoted
 * escapes are a subset of YAML's double-quoted scalars, so the output parses back to the same values.
 */
function renderEntryLine(entry: LockEntry): string {
  const parts: string[] = [];
  const push = (key: string, value: string | boolean) => {
    parts.push(
      `${key}: ${typeof value === "boolean" ? String(value) : JSON.stringify(value)}`,
    );
  };
  push("slug", entry.slug);
  push("kind", entry.kind);
  push("channel", entry.channel);
  push("origin", entry.origin);
  push("source", entry.source);
  push("source_url", entry.source_url);
  push("source_version", entry.source_version);
  push("checksum_sha256", entry.checksum_sha256);
  push("license", entry.license);
  push("redistributable", entry.redistributable);
  push("attribution", entry.attribution);
  push("fetched_at", entry.fetched_at);
  return `  - { ${parts.join(", ")} }`;
}

/**
 * Render the lock document as YAML.
 *
 * The header comment carries the two facts a reader needs before trusting the file: that the entries
 * were measured from a local snapshot (the official bundle URLs returned 404 when probed), and that
 * `fetched_at` is source metadata, not a run clock. Rendering must be deterministic — the idempotence
 * guarantee (`run twice, diff clean`) is tested, not hoped for.
 */
export function renderLockDocument(lock: LockDocument): string {
  assertValidLockEntries(lock.entries);
  const header = [
    "# capability-lock — L1 市场全量通道的锁文件（`bun scripts/fetch-capabilities.ts --from-local`）。",
    "# L1 的完整性由本文件表达，不由 git 内容表达：锁外的语料在 .cache/capabilities/（gitignore），",
    "# 部署时按 channels 里记录的来源抓取。generated_from = local-snapshot 表示条目测自本机市场快照——",
    "# 官方 bundle URL（download.codebuddy.cn）实测 404，尚未观测到可直取的全量包。",
    "# fetched_at 取源侧元数据（.downloaded_at / .zip-metadata.json / 清单 mtime），不是运行时钟。",
    "",
  ].join("\n");
  const body = [
    `version: ${lock.version}`,
    `phase: ${lock.phase}`,
    `cache_dir: ${lock.cache_dir}`,
    `generated_from: ${lock.generated_from}`,
    `fetched_at: ${lock.fetched_at}`,
    "channels:",
    ...lock.channels.map((channel) =>
      [
        `  - id: ${channel.id}`,
        `    source: ${JSON.stringify(channel.source)}`,
        `    url: ${JSON.stringify(channel.url)}`,
        `    url_verified: ${channel.url_verified}`,
        `    version: ${JSON.stringify(channel.version)}`,
        `    index_checksum_sha256: ${channel.index_checksum_sha256}`,
        `    note: ${JSON.stringify(channel.note)}`,
      ].join("\n"),
    ),
    `entries_count: ${lock.entries.length}`,
    "entries:",
    ...lock.entries.map(renderEntryLine),
  ];
  return `${header}${body.join("\n")}\n`;
}
