#!/usr/bin/env bun
/**
 * L1 channel: locate the marketplace bundles, measure them, and record every package in
 * `capability-lock.yaml` — plus unpack what was found into `.cache/capabilities/` for the converter.
 *
 * L1 does not copy content into git, it copies the *ability to fetch* content (§2.2 of the plan). The
 * bundles are deployment artefacts, not source: unpacking the marketplaces into git would put ~140MB of
 * third-party content under licences nobody has cleared. What enters the repository instead is a lock
 * file: which package, from where, at which version, with which checksum, under what licence.
 *
 * Measured ground truth (2026-11-12, this machine):
 *
 *   - The three plan URLs under `https://download.codebuddy.cn/workbuddy/*.zip` answer 404. Nobody has
 *     observed them serve a bundle, so `--download` probes them and refuses, rather than pretending.
 *   - The official *plugin* marketplace, however, is a real observed channel: this machine holds a
 *     snapshot whose `.zip-metadata.json` records the URL, etag and download time of the bundle it was
 *     unpacked from (`https://download.codebuddy.cn/plugin-marketplace/codebuddy-plugins-official-…zip`).
 *     The expert and connector marketplaces have no recorded bundle URL — they are local snapshots.
 *
 * So `--from-local` is the working path: it surveys the local snapshots, hashes every package, applies
 * the licence rules (§6.4 nine fields, fail-closed; the owner's exclusion list), writes the lock file,
 * and materialises the fetch cache in a WorkBuddy-home-shaped layout so the converter can read it with
 * `--source <cache>`. Two runs over an unchanged home produce a byte-identical lock file — `fetched_at`
 * comes from source metadata, checksums from content, and nothing reads the clock.
 *
 *   bun scripts/fetch-capabilities.ts --dry-run
 *   bun scripts/fetch-capabilities.ts --download          # probes the official URLs, refuses on 404
 *   bun scripts/fetch-capabilities.ts --from-local        # cache + capability-lock.yaml
 */
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  applyLicenseExclusions,
  assertValidLockEntries,
  compareLockEntries,
  directorySha256,
  fileSha256,
  isPermissiveLockLicense,
  type LockChannel,
  type LockChannelProvenance,
  type LockDocument,
  type LockEntry,
  renderLockDocument,
  sha256Hex,
} from "../tools/port-capabilities/lockfile";

/** Repository-relative path of the lock file, resolved against the repo root (two levels up). */
export const LOCK_FILE = "capability-lock.yaml";

/** Repository-relative path of the fetch cache. Gitignored; the converter reads it with `--source`. */
export const CACHE_DIR = ".cache/capabilities";

/** The default WorkBuddy home the local snapshot is measured from. */
export const DEFAULT_WORKBUDDY_HOME = join(homedir(), ".workbuddy");

/** Provenance of one local channel: where it lives, what it claims, what pins it. */
export interface ChannelLocation {
  id: LockChannel;
  /** Directory under the WorkBuddy home that holds the channel snapshot. */
  homePath: string;
  /** The bundle URL the channel records, or `""` when none was ever recorded. */
  url: string;
  /** Whether a download from `url` has been observed (only the official plugin marketplace has). */
  url_verified: boolean;
  /** One-line note a reviewer of the lock file reads. */
  note: string;
}

/**
 * The three L1 channels as this machine actually holds them.
 *
 * Only the official plugin marketplace carries a recorded bundle URL — read from its
 * `.zip-metadata.json` at collection time, because that file is the channel's own download record, not
 * our claim. The plan's three `download.codebuddy.cn/workbuddy/*.zip` URLs stay in
 * {@link OFFICIAL_BUNDLE_URLS} for `--download` to probe, marked by the 404 they measured.
 */
export const CHANNELS: readonly ChannelLocation[] = [
  {
    id: "official-plugins",
    homePath: "plugins/marketplaces/codebuddy-plugins-official",
    url: "",
    // Filled from .zip-metadata.json at collection time; the snapshot exists because that URL served it.
    url_verified: true,
    note: "官方插件市场快照（206 个插件，含官方技能与 taskmaster）；bundle URL/etag 记录在 .zip-metadata.json",
  },
  {
    id: "experts",
    homePath: "plugins/marketplaces/experts",
    url: "",
    url_verified: false,
    note: "专家市场快照（本机已装 9 包，全量 428 包从未在本机出现）；无 bundle URL 记录",
  },
  {
    id: "connectors",
    homePath: "connectors-marketplace",
    url: "",
    url_verified: false,
    note: "连接器市场快照（298 条定义 + connectors.json 索引，63MB）；无 bundle URL 记录",
  },
];

/** The URLs the plan cites for the L1 bundles. `--download` probes them; all three measured 404. */
export const OFFICIAL_BUNDLE_URLS: readonly { id: LockChannel; url: string }[] =
  [
    {
      id: "official-plugins",
      url: "https://download.codebuddy.cn/workbuddy/skill-marketplace.zip",
    },
    {
      id: "experts",
      url: "https://download.codebuddy.cn/workbuddy/expert-marketplace.zip",
    },
    {
      id: "connectors",
      url: "https://download.codebuddy.cn/workbuddy/connector-marketplace.zip",
    },
  ];

/** Thrown when the local snapshot does not look like the layout this script measures. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

// ---------------------------------------------------------------------------
// small filesystem / metadata helpers
// ---------------------------------------------------------------------------

/** Convert a platform path to the posix form used in every emitted field. */
function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Directory names under `path`, sorted. Absent directory is an empty list; other errors surface. */
function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw new SnapshotError(
      `读取目录失败：${toPosix(resolve(path))}（${code}）`,
    );
  }
}

/** Parse a JSON file, stripping the BOM several of these files carry. */
function readJson<T>(absolutePath: string): T {
  const text = readFileSync(absolutePath, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text) as T;
}

/** ISO8601 `Z` instant from an epoch-ms value; `null` when the value is not a finite number. */
function isoFromMs(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

/** ISO8601 `Z` instant from a file's mtime — a source-side timestamp, never the clock. */
function isoFromMtime(absolutePath: string): string {
  return statSync(absolutePath).mtime.toISOString();
}

/**
 * Read `.downloaded_at` (epoch ms or ISO text) next to a package, falling back to the file's mtime.
 *
 * Same rule as the P0 reader: the source's own timestamp is what makes two runs byte-identical.
 */
function readDownloadedAt(packageRoot: string, fallbackPath: string): string {
  const marker = join(packageRoot, ".downloaded_at");
  if (isFile(marker)) {
    const raw = readFileSync(marker, "utf8").trim();
    const asNumber = Number(raw);
    const fromNumber = isoFromMs(asNumber);
    if (fromNumber !== null) {
      return fromNumber;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return isoFromMtime(fallbackPath);
}

/**
 * Read the `license:` line out of a `SKILL.md` front matter block, if it declares one.
 *
 * Only the front matter counts — a licence mentioned in the body prose is not a licence declaration.
 * Missing or empty yields `undefined`, and the caller falls through to the LICENSE file, then to
 * `unspecified`. The pipeline never guesses a licence id it did not read.
 */
export function readFrontMatterLicense(
  skillMdPath: string,
): string | undefined {
  const text = readFileSync(skillMdPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    return undefined;
  }
  const line = /^license:\s*(\S.*?)\s*$/m.exec(match[1]);
  const value = line?.[1].replace(/^["']|["']$/g, "").trim();
  return value ? value : undefined;
}

/**
 * Identify a licence from the first lines of a bundled `LICENSE`/`LICENSE.*` file.
 *
 * Deliberately coarse: it returns one of a handful of SPDX ids it can actually recognise, and
 * `undefined` for anything else. A wrong "unspecified" costs a human look; a wrong "MIT" would grant a
 * right nobody asked for.
 */
export function sniffLicenseFile(absolutePath: string): string | undefined {
  const head = readFileSync(absolutePath, "utf8").slice(0, 2000);
  if (/gnu\s+affero\s+general\s+public\s+license/i.test(head)) {
    return "AGPL-3.0";
  }
  if (/gnu\s+(lesser\s+)?general\s+public\s+license/i.test(head)) {
    return "GPL-3.0";
  }
  if (/apache\s+license/i.test(head)) {
    return "Apache-2.0";
  }
  if (/mozilla\s+public\s+license/i.test(head)) {
    return "MPL-2.0";
  }
  if (/bsd\s+\d-clause|redistribution\s+and\s+use\s+in\s+source/i.test(head)) {
    return "BSD-3-Clause";
  }
  if (/permission\s+is\s+hereby\s+granted,\s+free\s+of\s+charge/i.test(head)) {
    return "MIT";
  }
  return undefined;
}

/** Find a `LICENSE`/`LICENSE.md`/`LICENSE.txt` directly inside a directory, if one is there. */
function findLicenseFile(directory: string): string | undefined {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    const candidate = join(directory, name);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** The licence a unit declares: plugin.json first, then front matter, then a LICENSE file, then unspecified. */
function declaredLicense(
  meta: PluginJsonMeta,
  frontMatterPath: string | undefined,
  directory: string,
): string {
  const fromMeta = metaString(meta, "license");
  if (fromMeta !== undefined) {
    return fromMeta;
  }
  if (frontMatterPath !== undefined) {
    const fromFrontMatter = readFrontMatterLicense(frontMatterPath);
    if (fromFrontMatter !== undefined) {
      return fromFrontMatter;
    }
  }
  const licenseFile = findLicenseFile(directory);
  if (licenseFile !== undefined) {
    const sniffed = sniffLicenseFile(licenseFile);
    if (sniffed !== undefined) {
      return sniffed;
    }
  }
  return "unspecified";
}

/** Attribution line from a `plugin.json` author field of either shape. */
function attributionFromAuthor(author: unknown): string {
  if (typeof author === "string" && author.trim() !== "") {
    return `© ${author.trim()}`;
  }
  if (author && typeof author === "object") {
    const name = (author as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") {
      return `© ${name.trim()}`;
    }
  }
  return "© WorkBuddy 能力市场";
}

/** The single base every entry's `source` prose is built on. */
function sourceDescription(channel: ChannelLocation): string {
  return channel.url !== ""
    ? channel.url
    : `local snapshot ~/.workbuddy/${channel.homePath}`;
}

// ---------------------------------------------------------------------------
// channel collectors — each returns the lock entries for one channel
// ---------------------------------------------------------------------------

/** What one collector produced, before the entries are merged and sorted. */
export interface ChannelCollection {
  id: LockChannel;
  entries: LockEntry[];
  /** sha256 of the channel's index file — the catalogue revision the entries were measured against. */
  indexChecksum: string;
  /** Latest source-side timestamp across the channel's entries. */
  latestFetchedAt: string;
  /** The bundle URL recorded by the channel itself, if any (promotes into the provenance header). */
  recordedUrl: string;
  recordedVersion: string;
}

interface PluginJsonMeta {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  author?: unknown;
  skills?: unknown;
}

/** Read one package's plugin.json metadata; absent or unparsable yields an empty record. */
function readPluginMeta(packageRoot: string): PluginJsonMeta {
  const path = join(packageRoot, ".codebuddy-plugin", "plugin.json");
  if (!isFile(path)) {
    return {};
  }
  try {
    return readJson<PluginJsonMeta>(path);
  } catch {
    return {};
  }
}

/** A string field of a metadata record, or `undefined`. */
function metaString(
  meta: PluginJsonMeta,
  key: keyof PluginJsonMeta,
): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Collect the expert marketplace channel: one entry per installed package, one per bundled skill.
 *
 * Package slugs are the directory names — the marketplace's own identity, not a derived one. Bundled
 * skills take their directory name as slug and get a package prefix only on collision. The official
 * marketplace's default (`redistributable: false`) falls out of the licence logic here rather than a
 * channel-wide override: every package that declares no licence hashes to `unspecified`, which is not
 * permissive — the only entries that end up `true` are ones whose authors wrote a licence id down.
 */
export function collectExpertChannel(
  expertsRoot: string,
  channel: ChannelLocation,
): ChannelCollection {
  const pluginsRoot = join(expertsRoot, "plugins");
  if (!isDirectory(pluginsRoot)) {
    throw new SnapshotError(
      `专家市场快照缺少 plugins/：${toPosix(resolve(pluginsRoot))}`,
    );
  }
  const entries: LockEntry[] = [];
  const indexFile = join(expertsRoot, ".codebuddy-plugin", "marketplace.json");
  const indexChecksum = isFile(indexFile)
    ? fileSha256(indexFile)
    : sha256Hex("(absent)");
  let latestFetchedAt = "";
  /** First pass: count skill directory names, so collisions get a package prefix deterministically. */
  const skillNameCounts = new Map<string, number>();
  interface PendingSkill {
    slugBase: string;
    skillRoot: string;
    origin: string;
    packageDir: string;
    fetchedAt: string;
    version: string;
    attribution: string;
  }
  const pendingSkills: PendingSkill[] = [];
  for (const dirName of listDirectories(pluginsRoot)) {
    const packageRoot = join(pluginsRoot, dirName);
    const meta = readPluginMeta(packageRoot);
    if (!isFile(join(packageRoot, ".codebuddy-plugin", "plugin.json"))) {
      continue;
    }
    const fetchedAt = readDownloadedAt(
      packageRoot,
      join(packageRoot, ".codebuddy-plugin", "plugin.json"),
    );
    latestFetchedAt = latestFetchedAt > fetchedAt ? latestFetchedAt : fetchedAt;
    const license = declaredLicense(meta, undefined, packageRoot);
    entries.push({
      slug: dirName,
      kind: "expert-package",
      channel: "experts",
      origin: `plugins/${dirName}`,
      source: sourceDescription(channel),
      source_url: channel.url,
      source_version: metaString(meta, "version") ?? "unspecified",
      checksum_sha256: directorySha256(packageRoot),
      license,
      // Permissive only when the package itself declares a permissive id; anything unstated stays false.
      redistributable: isPermissiveLockLicense(license),
      attribution: attributionFromAuthor(meta.author),
      fetched_at: fetchedAt,
    });
    const declaredSkills = Array.isArray(meta.skills)
      ? meta.skills.map((entry) => String(entry))
      : [];
    for (const reference of declaredSkills) {
      const skillRoot = join(packageRoot, reference.replace(/^\.\//, ""));
      if (!isFile(join(skillRoot, "SKILL.md"))) {
        continue;
      }
      pendingSkills.push({
        slugBase: skillRoot.slice(skillRoot.lastIndexOf(sep) + 1),
        skillRoot,
        origin: `plugins/${dirName}/${reference.replace(/^\.\//, "")}`,
        packageDir: dirName,
        fetchedAt,
        version: metaString(meta, "version") ?? "unspecified",
        attribution: attributionFromAuthor(meta.author),
      });
      const dir = skillRoot.slice(skillRoot.lastIndexOf(sep) + 1);
      skillNameCounts.set(dir, (skillNameCounts.get(dir) ?? 0) + 1);
    }
  }
  for (const pending of pendingSkills) {
    const slug =
      (skillNameCounts.get(pending.slugBase) ?? 0) > 1
        ? `${pending.packageDir}--${pending.slugBase}`
        : pending.slugBase;
    const license = declaredLicense(
      {},
      join(pending.skillRoot, "SKILL.md"),
      pending.skillRoot,
    );
    entries.push({
      slug,
      kind: "skill",
      channel: "experts",
      origin: pending.origin,
      source: sourceDescription(channel),
      source_url: channel.url,
      source_version: pending.version,
      checksum_sha256: directorySha256(pending.skillRoot),
      license,
      redistributable: isPermissiveLockLicense(license),
      attribution: pending.attribution,
      fetched_at: pending.fetchedAt,
    });
  }
  return {
    id: "experts",
    entries: entries.map(applyLicenseExclusions),
    indexChecksum,
    latestFetchedAt,
    recordedUrl: "",
    recordedVersion: "unspecified",
  };
}

/**
 * Collect the official plugin marketplace channel: one entry per plugin in its own marketplace.json.
 *
 * The 206 rows of `.codebuddy-plugin/marketplace.json` are the authority — the directories on disk that
 * the index does not mention are not entries. Every entry stays `redistributable: false`: this is the
 * WorkBuddy official channel, redistribution is undeclared, and the lock records the licence each
 * plugin claims (taskmaster's `MIT WITH Commons-Clause` among them) without deriving a grant from it.
 */
export function collectOfficialPluginChannel(
  channelRoot: string,
  channel: ChannelLocation,
): ChannelCollection {
  const indexFile = join(channelRoot, ".codebuddy-plugin", "marketplace.json");
  if (!isFile(indexFile)) {
    throw new SnapshotError(
      `官方插件市场快照缺少 .codebuddy-plugin/marketplace.json：${toPosix(resolve(channelRoot))}`,
    );
  }
  const index = readJson<{
    plugins?: { name?: unknown; version?: unknown; source?: unknown }[];
  }>(indexFile);
  const rows = index.plugins ?? [];
  if (rows.length === 0) {
    throw new SnapshotError(
      `官方插件市场索引没有 plugins 行：${toPosix(resolve(indexFile))}`,
    );
  }
  // The channel's own download record: the one place a bundle URL and etag exist as observed facts.
  const zipMetaPath = join(channelRoot, ".zip-metadata.json");
  const zipMeta = isFile(zipMetaPath)
    ? readJson<{ url?: unknown; etag?: unknown; downloadedAt?: unknown }>(
        zipMetaPath,
      )
    : {};
  const recordedUrl =
    typeof zipMeta.url === "string" && zipMeta.url !== "" ? zipMeta.url : "";
  const versionFile = join(channelRoot, ".marketplace-version");
  const recordedVersion =
    typeof zipMeta.etag === "string" && zipMeta.etag !== ""
      ? zipMeta.etag
      : isFile(versionFile)
        ? readFileSync(versionFile, "utf8").trim()
        : "unspecified";
  const channelFetchedAt =
    typeof zipMeta.downloadedAt === "string" &&
    !Number.isNaN(Date.parse(zipMeta.downloadedAt))
      ? new Date(Date.parse(zipMeta.downloadedAt)).toISOString()
      : isoFromMtime(indexFile);
  const entries: LockEntry[] = [];
  for (const row of rows) {
    const name =
      typeof row.name === "string" && row.name !== "" ? row.name : null;
    const source =
      typeof row.source === "string" && row.source !== "" ? row.source : null;
    if (name === null || source === null) {
      throw new SnapshotError(
        `官方插件市场索引存在缺 name/source 的行（共 ${rows.length} 行）`,
      );
    }
    const pluginRoot = join(channelRoot, source.replace(/^\.\//, ""));
    const meta = readPluginMeta(pluginRoot);
    const license = declaredLicense(meta, undefined, pluginRoot);
    entries.push({
      slug: name,
      kind: "official-plugin",
      channel: "official-plugins",
      origin: source.replace(/^\.\//, ""),
      source: sourceDescription(channel),
      source_url: channel.url !== "" ? channel.url : recordedUrl,
      source_version:
        metaString(meta, "version") ??
        (typeof row.version === "string" ? row.version : "unspecified"),
      checksum_sha256: isDirectory(pluginRoot)
        ? directorySha256(pluginRoot)
        : sha256Hex("(missing)"),
      license,
      // 官方通道默认 false（再分发权未声明，部署时抓取）；许可原文照录，不推导授权。
      redistributable: false,
      attribution: attributionFromAuthor(meta.author),
      fetched_at: channelFetchedAt,
    });
  }
  return {
    id: "official-plugins",
    entries: entries.map(applyLicenseExclusions),
    indexChecksum: fileSha256(indexFile),
    latestFetchedAt: channelFetchedAt,
    recordedUrl,
    recordedVersion,
  };
}

/**
 * Collect the connector marketplace channel: one entry per catalogue row, checksummed over its spec.
 *
 * The lock carries the connector *definitions* — the same descriptive `mcp.json` configs that §6.2
 * allows into the repository — with a checksum per row so a changed definition is visible in a diff.
 * Connectors declare no version and no licence; both stay `unspecified`, both stay `false`, and every
 * entry points at the channel the definition came from.
 */
export function collectConnectorChannel(
  channelRoot: string,
  channel: ChannelLocation,
): ChannelCollection {
  const indexFile = join(
    channelRoot,
    ".codebuddy-connector",
    "connectors.json",
  );
  if (!isFile(indexFile)) {
    throw new SnapshotError(
      `连接器市场快照缺少 .codebuddy-connector/connectors.json：${toPosix(resolve(channelRoot))}`,
    );
  }
  const index = readJson<{ connectors?: { id?: unknown }[] }>(indexFile);
  const rows = index.connectors ?? [];
  if (rows.length === 0) {
    throw new SnapshotError(
      `连接器清单没有 connectors 行：${toPosix(resolve(indexFile))}`,
    );
  }
  const fetchedAt = isoFromMtime(indexFile);
  const entries: LockEntry[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" && row.id !== "" ? row.id : null;
    if (id === null) {
      throw new SnapshotError(
        `连接器清单存在没有 id 的行：${toPosix(resolve(indexFile))}`,
      );
    }
    const mcpJson = join(channelRoot, "connectors", id, "mcp.json");
    const cliJson = join(channelRoot, "connectors", id, "cli.json");
    const spec = isFile(mcpJson) ? mcpJson : isFile(cliJson) ? cliJson : null;
    entries.push({
      slug: id,
      kind: "connector",
      channel: "connectors",
      origin:
        spec === null
          ? `connectors/${id}`
          : `connectors/${id}/${spec.slice(spec.lastIndexOf(sep) + 1)}`,
      source: sourceDescription(channel),
      source_url: channel.url,
      source_version: "unspecified",
      checksum_sha256:
        spec === null ? sha256Hex("(missing)") : fileSha256(spec),
      license: "unspecified",
      // mcp.json 是描述性配置（§6.2），声明与收录不需要再分发权；正文内容不随锁入仓。
      redistributable: false,
      attribution: "© 各连接器厂商（经 WorkBuddy 连接器市场收录）",
      fetched_at: fetchedAt,
    });
  }
  return {
    id: "connectors",
    entries,
    indexChecksum: fileSha256(indexFile),
    latestFetchedAt: fetchedAt,
    recordedUrl: "",
    recordedVersion: "unspecified",
  };
}

// ---------------------------------------------------------------------------
// lock document assembly
// ---------------------------------------------------------------------------

/** Resolve the openbot root: this script lives one level below it, and the lock + cache belong there. */
export function repoRoot(): string {
  return resolve(import.meta.dir, "..");
}

/** The parsed `.zip-metadata.json` URL of a channel, when its snapshot records one. */
export function readRecordedUrl(
  home: string,
  channel: ChannelLocation,
): string {
  const zipMetaPath = join(home, channel.homePath, ".zip-metadata.json");
  if (!isFile(zipMetaPath)) {
    return channel.url;
  }
  try {
    const meta = readJson<{ url?: unknown }>(zipMetaPath);
    return typeof meta.url === "string" && meta.url !== ""
      ? meta.url
      : channel.url;
  } catch {
    return channel.url;
  }
}

/**
 * Survey every channel under `home` and assemble the lock document.
 *
 * Each channel is checked to exist before it is hashed — a home where one channel is missing produces a
 * lock that silently under-reports L1, so a missing channel stops the run instead. The entries are
 * validated here (§6.4 nine fields, exclusion invariant) so a caller cannot assemble an invalid
 * document; `renderLockDocument` re-validates for the same reason a second lock on the same door is not
 * paranoia.
 */
export function buildLockFromLocal(home: string): {
  lock: LockDocument;
  collections: ChannelCollection[];
} {
  const collections: ChannelCollection[] = [];
  for (const channel of CHANNELS) {
    const channelRoot = join(home, channel.homePath);
    if (!isDirectory(channelRoot)) {
      throw new SnapshotError(
        `通道快照不存在：${toPosix(resolve(channelRoot))}（${channel.id}）`,
      );
    }
    const located: ChannelLocation = {
      ...channel,
      url: readRecordedUrl(home, channel),
    };
    if (channel.id === "official-plugins") {
      collections.push(collectOfficialPluginChannel(channelRoot, located));
    } else if (channel.id === "experts") {
      collections.push(collectExpertChannel(channelRoot, located));
    } else {
      collections.push(collectConnectorChannel(channelRoot, located));
    }
  }
  const entries = collections
    .flatMap((collection) => collection.entries)
    .sort(compareLockEntries);
  assertValidLockEntries(entries);
  const channels: LockChannelProvenance[] = collections.map((collection) => {
    const channel = CHANNELS.find(
      (candidate) => candidate.id === collection.id,
    ) as ChannelLocation;
    const locatedUrl =
      collection.recordedUrl !== "" ? collection.recordedUrl : channel.url;
    return {
      id: collection.id,
      source:
        locatedUrl !== ""
          ? locatedUrl
          : `local snapshot ~/.workbuddy/${channel.homePath}`,
      url: locatedUrl,
      url_verified: locatedUrl !== "" && channel.url_verified,
      version: collection.recordedVersion,
      index_checksum_sha256: collection.indexChecksum,
      note: channel.note,
    };
  });
  const fetchedAt = collections
    .map((collection) => collection.latestFetchedAt)
    .reduce((latest, current) => (current > latest ? current : latest), "");
  const lock: LockDocument = {
    version: 2,
    phase: "p1-5",
    cache_dir: CACHE_DIR,
    generated_from: "local-snapshot",
    fetched_at: fetchedAt,
    channels,
    entries,
  };
  return { lock, collections };
}

// ---------------------------------------------------------------------------
// fetch cache — the WorkBuddy-home-shaped layout the converter reads with --source
// ---------------------------------------------------------------------------

/** One official skill unit: a directory carrying a `SKILL.md`, with its provenance-preserving name. */
export interface OfficialSkillUnit {
  /** Cache directory name: the plugin name, or `<plugin>--skills--<…>` for nested skills. */
  unitName: string;
  /** Posix path of the unit directory, relative to the official channel root. */
  origin: string;
}

/**
 * Walk the official channel for skill units — every directory with a `SKILL.md`, whether at a plugin's
 * root or nested under its `skills/` tree.
 *
 * The official bundle stores skills at several depths (some plugins are collections of collections), so
 * the walk recurses through `skills/` subtrees only — it never mistakes a plugin's own sub-package for a
 * sibling. Names keep the plugin prefix so a unit from `all-skills` cannot collide with a user skill of
 * the same name.
 */
export function discoverOfficialSkillUnits(
  channelRoot: string,
): OfficialSkillUnit[] {
  const units: OfficialSkillUnit[] = [];
  const walkSkills = (
    absolute: string,
    relativeToPlugin: string,
    pluginName: string,
    group: string,
  ): void => {
    if (isFile(join(absolute, "SKILL.md"))) {
      const suffix =
        relativeToPlugin === ""
          ? ""
          : `--${relativeToPlugin.split("/").join("--")}`;
      units.push({
        unitName: `${pluginName}${suffix}`,
        origin: `${group}/${pluginName}/${relativeToPlugin}`,
      });
      return;
    }
    for (const child of listDirectories(absolute)) {
      walkSkills(
        join(absolute, child),
        relativeToPlugin === "" ? child : `${relativeToPlugin}/${child}`,
        pluginName,
        group,
      );
    }
  };
  for (const group of ["plugins", "external_plugins"]) {
    for (const pluginName of listDirectories(join(channelRoot, group))) {
      const pluginRoot = join(channelRoot, group, pluginName);
      if (isFile(join(pluginRoot, "SKILL.md"))) {
        units.push({ unitName: pluginName, origin: `${group}/${pluginName}` });
        continue;
      }
      const skillsRoot = join(pluginRoot, "skills");
      if (isDirectory(skillsRoot)) {
        walkSkills(skillsRoot, "skills", pluginName, group);
      }
    }
  }
  units.sort((a, b) => a.unitName.localeCompare(b.unitName));
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.unitName)) {
      throw new SnapshotError(`官方技能单元重名：${unit.unitName}`);
    }
    seen.add(unit.unitName);
  }
  return units;
}

/**
 * Materialise the fetch cache at `cacheRoot` from the local snapshot at `home`.
 *
 * The layout mirrors a WorkBuddy home — `skills/`, `plugins/marketplaces/experts/`,
 * `connectors-marketplace/` — so `bun run port:capabilities -- --source <cache>` reads the L1 corpus
 * with no converter changes; the official channel is additionally copied whole (raw, for audit) and the
 * official skill units are flattened into `skills/` with provenance-preserving names. A stale cache is
 * removed first: a cache is a snapshot of one run, not an accumulator of several.
 */
export function writeCacheFromLocal(
  home: string,
  cacheRoot: string,
): { skillUnits: number } {
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot, { recursive: true });
  const officialRoot = join(
    home,
    "plugins/marketplaces/codebuddy-plugins-official",
  );
  const expertsRoot = join(home, "plugins/marketplaces/experts");
  const connectorsRoot = join(home, "connectors-marketplace");
  for (const [from, to] of [
    [
      officialRoot,
      join(cacheRoot, "plugins/marketplaces/codebuddy-plugins-official"),
    ],
    [expertsRoot, join(cacheRoot, "plugins/marketplaces/experts")],
    [connectorsRoot, join(cacheRoot, "connectors-marketplace")],
  ] as const) {
    if (!isDirectory(from)) {
      throw new SnapshotError(
        `通道快照不存在，缓存不完整：${toPosix(resolve(from))}`,
      );
    }
    cpSync(from, to, { recursive: true });
  }
  const units = discoverOfficialSkillUnits(officialRoot);
  for (const unit of units) {
    cpSync(
      join(officialRoot, unit.origin),
      join(cacheRoot, "skills", unit.unitName),
      { recursive: true },
    );
  }
  return { skillUnits: units.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Command line for this script. */
export interface FetchCliOptions {
  dryRun: boolean;
  fromLocal: boolean;
  writeLock: boolean;
  download: boolean;
  home: string;
}

/** Parse the arguments this script accepts. Throws on anything else. */
export function parseArgs(argv: readonly string[]): FetchCliOptions {
  const options: FetchCliOptions = {
    dryRun: false,
    fromLocal: false,
    writeLock: false,
    download: false,
    home: DEFAULT_WORKBUDDY_HOME,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--from-local") {
      options.fromLocal = true;
    } else if (arg === "--write-lock") {
      options.writeLock = true;
    } else if (arg === "--download") {
      options.download = true;
    } else if (arg === "--home") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--home 缺少取值");
      }
      options.home = resolve(
        next === "~"
          ? homedir()
          : next.startsWith("~/")
            ? join(homedir(), next.slice(2))
            : next,
      );
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.dryRun = true;
    } else {
      throw new Error(`无法识别的参数：${arg}`);
    }
  }
  if (
    !options.dryRun &&
    !options.fromLocal &&
    !options.writeLock &&
    !options.download
  ) {
    options.dryRun = true;
  }
  return options;
}

/** Render the human-readable plan `--dry-run` prints. No hashing, no network. */
export function renderPlan(
  home: string,
  recordedUrls: ReadonlyMap<LockChannel, string>,
): string {
  const lines: string[] = [
    "fetch-capabilities 计划（L1：本机快照普查）",
    "",
    `home：${home}`,
    "",
    "| 通道 | bundle URL | 已观测 | 快照路径 |",
    "| --- | --- | --- | --- |",
  ];
  for (const channel of CHANNELS) {
    const url = recordedUrls.get(channel.id) ?? "";
    lines.push(
      `| ${channel.id} | ${url === "" ? "（无记录）" : url} | ${url !== "" && channel.url_verified ? "是" : "否"} | ~/.workbuddy/${channel.homePath} |`,
    );
  }
  lines.push(
    "",
    "官方全量包 URL（方案引用，实测 404，--download 会先探测）：",
    ...OFFICIAL_BUNDLE_URLS.map((entry) => `  - ${entry.url}`),
    "",
    "动作：--from-local 普查本机三通道并写锁+缓存；--write-lock 只写锁；--download 只探测官方 URL。",
    `锁文件：${LOCK_FILE}；缓存：${CACHE_DIR}（gitignore，converter 用 --source 读）`,
  );
  return `${lines.join("\n")}\n`;
}

/** Probe the official bundle URLs; returns one measured status per URL. */
export async function probeOfficialUrls(): Promise<
  { url: string; status: number | string }[]
> {
  const results: { url: string; status: number | string }[] = [];
  for (const entry of OFFICIAL_BUNDLE_URLS) {
    try {
      const response = await fetch(entry.url, { method: "HEAD" });
      results.push({ url: entry.url, status: response.status });
    } catch (error) {
      results.push({
        url: entry.url,
        status: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Format the probe table `--download` prints. */
export function renderProbeReport(
  results: readonly { url: string; status: number | string }[],
): { report: string; anyServed: boolean } {
  const lines: string[] = ["官方 bundle URL 探测结果："];
  for (const result of results) {
    lines.push(`  - ${String(result.status)}  ${result.url}`);
  }
  const anyServed = results.some((result) => result.status === 200);
  if (!anyServed) {
    lines.push(
      "",
      "以上地址都没有观测到可直取的全量包。L1 用本机快照普查：",
      "  bun scripts/fetch-capabilities.ts --from-local",
    );
  } else {
    lines.push(
      "",
      "发现可服务的地址。解压布局与逐包校验尚未对真实包定稿——请把实际包落到一个目录后接入通道表，",
      "不要让本脚本直接解压未知布局。",
    );
  }
  return { report: `${lines.join("\n")}\n`, anyServed };
}

/** Run the script; returns a process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let options: FetchCliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.download) {
    const { report } = renderProbeReport(await probeOfficialUrls());
    process.stdout.write(report);
    return 1;
  }
  if (options.dryRun && !options.fromLocal && !options.writeLock) {
    const recordedUrls = new Map<LockChannel, string>();
    for (const channel of CHANNELS) {
      const url = readRecordedUrl(options.home, channel);
      if (url !== "") {
        recordedUrls.set(channel.id, url);
      }
    }
    process.stdout.write(renderPlan(options.home, recordedUrls));
    return 0;
  }
  try {
    const { lock, collections } = buildLockFromLocal(options.home);
    const root = repoRoot();
    const cacheRoot = join(root, CACHE_DIR);
    let skillUnits = 0;
    if (options.fromLocal) {
      const cache = writeCacheFromLocal(options.home, cacheRoot);
      skillUnits = cache.skillUnits;
      // The cache's own provenance record, so the snapshot on disk can be identified without the lock.
      writeFileSync(
        join(cacheRoot, "channel-provenance.json"),
        `${JSON.stringify({ generated_from: lock.generated_from, fetched_at: lock.fetched_at, channels: lock.channels }, null, 2)}\n`,
        "utf8",
      );
    }
    if (options.writeLock || options.fromLocal) {
      const lockPath = join(root, LOCK_FILE);
      writeFileSync(lockPath, renderLockDocument(lock), "utf8");
      console.log(`已写出锁文件：${lockPath}`);
    }
    for (const collection of collections) {
      const kinds = new Map<string, number>();
      for (const entry of collection.entries) {
        kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
      }
      const breakdown = [...kinds.entries()]
        .map(([kind, count]) => `${kind} ${count}`)
        .join(" / ");
      console.log(
        `[fetch] ${collection.id}: ${collection.entries.length} 条（${breakdown}）`,
      );
    }
    console.log(
      `[fetch] 合计 ${lock.entries.length} 条，redistributable ${lock.entries.filter((entry) => entry.redistributable).length} 条；fetched_at ${lock.fetched_at}`,
    );
    if (options.fromLocal) {
      console.log(
        `[fetch] 缓存已物化：${cacheRoot}（官方技能单元 ${skillUnits} 个）`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof SnapshotError) {
      console.error(`[fetch] 本机快照不符合预期：${error.message}`);
      return 2;
    }
    console.error(
      `[fetch] 失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
