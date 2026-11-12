/**
 * Turns the raw on-disk records into the named, deduplicated, provenance-carrying capabilities that
 * the emitters write out.
 *
 * This is where the three decisions that §3.2 of the plan calls out actually happen:
 *
 *   1. **Duplicate downloads collapse by content.** `engineering-workflow-skills` and
 *      `ex_eqoqYRT1NIwb` are the same package under two directory names; they are identical apart from
 *      line endings, so the check is over normalised text, and the readable directory name wins.
 *   2. **Same-name skills keep a provenance suffix.** Three `dev-expert` builds exist and the user has
 *      ruled that all three ship, so a bare `dev-expert` slug would silently drop two of them.
 *   3. **Chinese first.** Everything a person reads (`name`, `title`, `summary`) prefers `.zh` and
 *      falls back to English rather than showing an empty string.
 *
 * The module is pure: it takes a `WorkBuddySnapshot` and returns data, with no filesystem access. That
 * is what lets the tests below run against literal records instead of a fixture tree.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

import {
  CONNECTOR_PRESETS,
  DEFAULT_ATTRIBUTION,
  deriveCredentialEnv,
  isTenantSlug,
  openbotAuthFor,
  PERMISSIVE_LICENSES,
  TEAM_NAME_OVERRIDES,
  TENANT_SLUG_MAX,
  UNSPECIFIED_LICENSE,
} from "./mapping";
import { SourceLayoutError } from "./read-workbuddy";
import type {
  PluginJson,
  PluginMember,
  RawConnector,
  RawExpertPackage,
  RawSkill,
  SkillTier,
  WorkBuddySnapshot,
} from "./read-workbuddy";

/** Prefix used for every emitted source URL, so the package is not tied to one machine's paths. */
export const WORKBUDDY_HOME_TOKEN = "~/.workbuddy";

/** How a capability's origin is recorded. One per manifest entry. */
export interface Provenance {
  /** Human-readable source line, e.g. `workbuddy skill-marketplace:dev-expert@2.2.0`. */
  source: string;
  /** Where it came from on disk, relative to the WorkBuddy home. */
  sourceUrl: string;
  /** Declared version, or `unspecified`. */
  sourceVersion: string;
  /** When it arrived on this machine, ISO8601. Derived from sync metadata, never from the clock. */
  fetchedAt: string;
  /** SHA-256 over the normalised bytes of the file this entry was built from. */
  checksum: string;
  /** SPDX id, or `unspecified`. */
  license: string;
  /** Whether this pipeline believes the content may be redistributed inside openbot. */
  redistributable: boolean;
  /** Required attribution line. */
  attribution: string;
}

/** A ported agent: one openbot employee. */
export interface NormalizedAgent {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  type: "built-in";
  systemPrompt: string;
  /** Slugs of the skills this agent is granted. Always the package's declared skills. */
  skills: string[];
  /** Whether the package ships a `references/` directory this agent's body may point at. */
  hasBundledReferences: boolean;
  /** Set when the agent belongs to a team. */
  teamId: string | null;
  /** Which redactions touched `systemPrompt`; empty when the body was already clean. */
  sanitized: string[];
  provenance: Provenance;
}

/** One member row of a ported team. */
export interface NormalizedTeamMember {
  id: string;
  name: string;
  title: string;
  role: string;
}

/** A ported team: channel membership plus the lead→member handoff grants. */
export interface NormalizedTeam {
  id: string;
  name: string;
  description: string;
  channel: string;
  lead: string;
  members: NormalizedTeamMember[];
  address: { from: string; to: string[] }[];
  provenance: Provenance;
}

/** A ported skill. */
export interface NormalizedSkill {
  slug: string;
  /**
   * Which of the three slug rules produced `slug`.
   *
   * Recorded in the manifest because the rule that fired is the only evidence of *why* a slug looks the
   * way it does — `engineering-workflow` could have come from a bare directory name or from a prefix that
   * did not fit, and only the label tells them apart a year later.
   */
  slugSource: SlugSource;
  /** Slug before conflict resolution, kept so the conflict report can group rows. */
  baseSlug: string;
  title: string;
  summary: string;
  instructions: string;
  /** Always `[]` in P0; see the note on `declaredTools`. */
  tools: string[];
  /** Raw `allowed-tools` entries, for P3's mapping layer. Not consumed by openbot. */
  declaredTools: string[];
  /** Whether the source skill ships a `references/` directory. One audit rule depends on it. */
  hasBundledReferences: boolean;
  /** Total bytes under `references/`. Decides whether it can be inlined or needs the asset channel. */
  refsBytes: number;
  /** Sub-directories the source ships that P0 does not carry. */
  dropped: string[];
  /** Which redactions touched `instructions`; empty when the body was already clean. */
  sanitized: string[];
  tier: SkillTier;
  provenance: Provenance;
}

/** A ported connector. */
export interface NormalizedConnector {
  id: string;
  title: string;
  vendor: string;
  url: string;
  /** `url`'s authority, parsed rather than copied, and re-checked by the emitter. */
  host: string;
  auth: string;
  credentialEnv: string;
  dropped: string[];
  provenance: Provenance;
}

/** A slug that more than one source claimed. */
export interface SlugConflict {
  baseSlug: string;
  resolution: { slug: string; origin: string }[];
}

/** Something the pipeline read and deliberately did not port. */
export interface DroppedItem {
  kind: CapabilityKind;
  /** Slug of the surviving entry this belongs to, or the candidate's own name when nothing survived. */
  slug: string;
  /** What was dropped. */
  origin: string;
  reason: string;
}

/** The four kinds of capability. Order is the emit order and the manifest order. */
export type CapabilityKind = "agent" | "skill" | "team" | "connector";

/** Fixed kind order, so `capability-manifest.yaml` sorts the same way every run. */
export const KIND_ORDER: readonly CapabilityKind[] = ["agent", "skill", "team", "connector"];

/** Everything one normalisation produced. */
export interface NormalizedCapabilities {
  agents: NormalizedAgent[];
  teams: NormalizedTeam[];
  skills: NormalizedSkill[];
  connectors: NormalizedConnector[];
  conflicts: SlugConflict[];
  dropped: DroppedItem[];
  /** Things a human should look at but that do not stop the run. */
  warnings: string[];
}

/** A parsed `SKILL.md`: YAML front matter plus the body that becomes `instructions`. */
export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Normalise text before hashing or parsing: strip a byte-order mark and collapse CRLF to LF.
 *
 * This is what makes `engineering-workflow-skills` and `ex_eqoqYRT1NIwb` compare equal. They differ on
 * disk only by line endings, and a byte comparison would report them as two distinct packages.
 */
export function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** SHA-256 of normalised text, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(normalizeText(text), "utf8").digest("hex");
}

/** Recorded in `_porting.sanitized` when the author's own home directory was replaced. */
export const SANITIZED_LOCAL_USER_PATH = "local-user-path";

/**
 * A user home directory inside prose: `C:/Users/<name>`, `C:\Users\<name>`, `/c/Users/<name>` (git bash)
 * or `/Users/<name>` (macOS). Group 1 is the prefix including the separator, group 2 the user name.
 *
 * The name segment is deliberately restricted to ASCII letters, digits, dot, dash and underscore. Anything
 * looser swallows prose: the source writes `C:/Users/canqu，不认 MSYS 路径` in one place, and a segment
 * class that allowed CJK would have redacted `canqu，不认 MSYS 路径` — deleting the sentence along with the
 * account name.
 */
const LOCAL_USER_PATH = /((?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|\/)Users[\\/])([A-Za-z0-9._-]+)/gi;

/**
 * Segments that are already placeholders. A source that ships `C:/Users/<user>/...` is correct as written,
 * and replacing `<user>` with `<user>` again would only make the redaction look like it did something.
 */
const USER_PATH_PLACEHOLDERS: ReadonlySet<string> = new Set(["<user>", "<username>", "~", "$home", "%userprofile%"]);

/**
 * Replace the author's home directory name with `<user>`, keeping the rest of the path.
 *
 * Ported instruction text ships to customers verbatim, and several skills quote the machine they were
 * written on — `C:/Users/canqu/AppData/Local/Temp/...`, `/c/Users/canqu/.workbuddy/binaries/...`. That is
 * the author's account name and the internal directory layout, neither of which belongs in a product.
 *
 * Only the segment directly after `Users` is touched: the structure below it (`AppData`, `.workbuddy`, a
 * script path) is what makes the instruction useful, so it stays. Already-placeholder text is left alone,
 * which also makes the function idempotent — a second pass over its own output changes nothing.
 */
export function sanitizeLocalUserPaths(text: string): { text: string; hits: number } {
  let hits = 0;
  const sanitized = text.replace(LOCAL_USER_PATH, (match: string, prefix: string, name: string) => {
    if (USER_PATH_PLACEHOLDERS.has(name.toLowerCase())) {
      return match;
    }
    hits += 1;
    return `${prefix}<user>`;
  });
  return { text: sanitized, hits };
}

/**
 * Split `---` front matter off a document.
 *
 * A file with no front matter, or with unparsable front matter, yields `{}` and the whole document as
 * the body: the instructions still work, and losing them because a `tags: [...]` line is malformed
 * would be a worse outcome than losing the metadata.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const normalized = normalizeText(text);
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) {
    return { data: {}, body: normalized.trim() };
  }
  const body = normalized.slice(match[0].length).trim();
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, body };
    }
    return { data: {}, body };
  } catch {
    return { data: {}, body };
  }
}

/** Coerce a scalar front-matter value into a trimmed string, or `undefined`. */
function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * Read a field that may be either a plain string or a `{ zh, en }` pair, preferring Chinese.
 *
 * Every display field in this ecosystem is bilingual and either half can be missing, so this is the
 * single place that decides "Chinese first, then English, then nothing".
 */
export function localizedText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asString(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return asString(record.zh) ?? asString(record.en);
  }
  return undefined;
}

/**
 * Convert arbitrary text into a slug: lowercase, kebab-cased, ASCII.
 *
 * Characters that survive neither step (Chinese names, for instance) are dropped, so callers must keep
 * a fallback; every call site here passes a directory name as that fallback.
 */
export function kebab(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Split a directory name into the skill's own name and the source it came from.
 *
 * `dev-expert__indiv-weishui__skillhub` is the individual Weishui build of `dev-expert`; the trailing
 * `skillhub` names the channel rather than the author, so the middle segment is what distinguishes it.
 * A plain directory keeps an empty label, meaning "no source suffix unless a conflict forces one".
 */
export function splitDirectoryName(dirName: string): { base: string; sourceLabel: string } {
  const parts = dirName.split("__").filter((part) => part !== "");
  if (parts.length === 0) {
    return { base: dirName, sourceLabel: "" };
  }
  if (parts.length === 1) {
    return { base: parts[0], sourceLabel: "" };
  }
  const tail = parts[parts.length - 1];
  const middle = parts.slice(1, parts.length - 1);
  if (middle.length === 0 && tail.toLowerCase() === "skillhub") {
    return { base: parts[0], sourceLabel: tail };
  }
  return { base: parts[0], sourceLabel: middle.length > 0 ? middle.join("-") : tail };
}

/** Collapse whitespace to a single line and cut at `maxLength`, ellipsis included. */
export function oneLine(text: string, maxLength = 120): string {
  const collapsed = normalizeText(text).replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Read `allowed-tools` / `allowed_tools` off front matter as a list of raw tool refs. */
export function readDeclaredTools(data: Record<string, unknown>): string[] {
  const raw = data["allowed-tools"] ?? data.allowed_tools;
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter((entry) => entry !== "");
  }
  const text = asString(raw);
  if (!text) {
    return [];
  }
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** A licence the pipeline is willing to call redistributable. */
function isPermissiveLicense(license: string): boolean {
  return PERMISSIVE_LICENSES.includes(license.trim().toLowerCase());
}

/**
 * Whether a skill declares a paid pricing model in its front matter.
 *
 * Paid marketplace skills must not be marked redistributable however permissive the licence field says,
 * because the licence grants code rights while the price records a commercial term.
 */
export function isPaidSkill(data: Record<string, unknown>): boolean {
  const pricing = data.pricing;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    return false;
  }
  const record = pricing as Record<string, unknown>;
  const amount = record.amount_fen;
  if (typeof amount === "number" && amount > 0) {
    return true;
  }
  const model = asString(record.model);
  return model !== undefined && model !== "free";
}

/** Turn `plugin.json`'s author field, of either shape, into an attribution line. */
function attributionFromAuthor(author: PluginJson["author"]): string | undefined {
  if (typeof author === "string") {
    return asString(author) ? `© ${author.trim()}` : undefined;
  }
  if (author && typeof author === "object") {
    const name = asString(author.name);
    return name ? `© ${name}` : undefined;
  }
  return undefined;
}

/** Build the provenance block shared by every capability read out of one file. */
function buildProvenance(input: {
  source: string;
  relativePath: string;
  version: string | undefined;
  fetchedAt: string;
  checksum: string;
  license: string | undefined;
  paid: boolean;
  attribution: string | undefined;
}): Provenance {
  const license = input.license?.trim() ? input.license.trim() : UNSPECIFIED_LICENSE;
  return {
    source: input.source,
    sourceUrl: `${WORKBUDDY_HOME_TOKEN}/${input.relativePath}`,
    sourceVersion: input.version ?? UNSPECIFIED_LICENSE,
    fetchedAt: input.fetchedAt,
    checksum: input.checksum,
    license,
    redistributable: isPermissiveLicense(license) && !input.paid,
    attribution: input.attribution ?? DEFAULT_ATTRIBUTION,
  };
}

/**
 * Fingerprint the *agent identity* of a package: `plugin.json` plus every agent document.
 *
 * Checksums are taken over normalised text. This is what decides whether two downloads are the same
 * expert — the pair of things a human would compare before calling them duplicates.
 */
function agentIdentityFingerprint(pkg: RawExpertPackage): string {
  const parts = [pkg.pluginJson.text, ...[...pkg.agents].sort((a, b) => a.id.localeCompare(b.id)).map((a) => a.file.text)];
  return sha256Hex(parts.join("\u0000"));
}

/**
 * Fingerprint a whole expert package: agent identity **plus every bundled skill**.
 *
 * The skills are in because two builds of the same package can share `plugin.json` and agent documents
 * while carrying different `SKILL.md` contents — the capability payload itself. A fingerprint that
 * ignored them would discard the differing instructions as "a duplicate download" before the
 * skill-level comparison ever saw them, silently losing content while reporting the copies identical.
 * Skill paths and contents enter the digest so differing payloads keep the two downloads apart.
 */
export function packageFingerprint(pkg: RawExpertPackage): string {
  // `dirName` is the skill's path *inside the package* — the part plugin.json declares. The full
  // relative path would pin the fingerprint to the download directory, and two copies of the same
  // package installed under `engineering-workflow-skills` and `ex_eqoqYRT1NIwb` would never match.
  const skillParts = [...pkg.skills]
    .sort((a, b) => a.dirName.localeCompare(b.dirName))
    .map((skill) => `${skill.dirName}\u0000${skill.skillMd.text}`);
  return sha256Hex([agentIdentityFingerprint(pkg), ...skillParts].join("\u0000"));
}

/** Prefer a readable directory name over an opaque download id when both hold the same package. */
function readabilityRank(dirName: string): number {
  return /^ex_[A-Za-z0-9]{6,}$/.test(dirName) ? 1 : 0;
}

/**
 * The slug the package's agent (or team) will answer to, derived the same way {@link normalizePackage}
 * derives it. Used to report a collapsed twin download against the identity it merges into.
 */
function packageIdentitySlug(pkg: RawExpertPackage): string {
  const plugin = pkg.plugin;
  if (isTeamPackage(plugin)) {
    return kebab(asString(plugin.name) ?? pkg.dirName) || pkg.dirName;
  }
  const agentId = asString(plugin.agentName) ?? asString(plugin.name) ?? pkg.dirName;
  return kebab(agentId) || kebab(pkg.dirName) || agentId;
}

/** One skill as read, before slug resolution. */
interface SkillCandidate {
  raw: RawSkill;
  data: Record<string, unknown>;
  body: string;
  checksum: string;
  /** Slug from the front matter `name`, which is what the skill calls itself. */
  nameSlug: string;
  /** Slug from the directory name, which is what distinguishes two builds of the same skill. */
  dirSlug: string;
  /** Grouping key for the "same name, different source" report. */
  baseSlug: string;
  tier: SkillTier;
  packageDirName: string | null;
  /** Deterministic position in the candidate list, used only for stable ordering. */
  order: number;
}

/**
 * Slug from a WorkBuddy directory name: the skill's own name, plus the author namespace when the
 * directory carries one.
 *
 * `dev-expert__indiv-weishui__skillhub` → `dev-expert--indiv-weishui`. The trailing `skillhub` names the
 * *channel* the skill came through, and it is dropped rather than slugged: twelve of the 43 installed
 * skills arrived that way, and `code--skillhub` reads as noise in the `/` menu while telling a reader
 * nothing about the skill. The channel survives in the manifest's `source`, and a strip that would ever
 * collide is caught by the uniqueness pass.
 *
 * Double underscore becomes double hyphen so the result visibly is "name + source" rather than a skill
 * that happens to be called `dev-expert-skillhub`. Underscores are not an option at all — the
 * tenant-package loader rejects them.
 */
export function directorySlug(dirName: string): string {
  const { base, sourceLabel } = splitDirectoryName(dirName);
  const baseSlug = kebab(base);
  const labelSlug = kebab(sourceLabel);
  return labelSlug === "" ? baseSlug : `${baseSlug}--${labelSlug}`;
}

/** Read one `RawSkill` into a candidate. */
function toCandidate(raw: RawSkill, order: number): SkillCandidate {
  const frontmatter = splitFrontmatter(raw.skillMd.text);
  const dirNameParts = splitDirectoryName(raw.dirName);
  const declaredName = asString(frontmatter.data.name);
  const nameSlug = kebab(declaredName ?? dirNameParts.base);
  const dirSlug = directorySlug(raw.dirName) || nameSlug;
  const baseSlug = nameSlug || kebab(dirNameParts.base) || dirSlug || "unnamed-skill";
  return {
    raw,
    data: frontmatter.data,
    body: frontmatter.body,
    checksum: sha256Hex(raw.skillMd.text),
    nameSlug: nameSlug || dirSlug,
    dirSlug,
    baseSlug,
    tier: raw.tier,
    packageDirName: raw.packageDirName,
    order,
  };
}

/** Tier rank used when slugs have to be handed out: user-installed skills outrank package-bundled ones. */
function tierRank(tier: SkillTier): number {
  return tier === "user" ? 0 : 1;
}

/**
 * Shorten a slug to the loader's limit while keeping it recognizable.
 *
 * The four hex characters come from the full slug, so the shortened form is stable across runs and
 * distinct for distinct inputs.
 */
export function shortenSlug(slug: string, seed: string): string {
  const hash = sha256Hex(seed).slice(0, 4);
  const room = TENANT_SLUG_MAX - hash.length - 2;
  const stem = slug.slice(0, room).replace(/-+$/, "") || "skill";
  return `${stem}--${hash}`;
}

/** Force a string into a slug the tenant-package loader will accept. */
export function ensureTenantSlug(slug: string, seed: string): string {
  if (isTenantSlug(slug)) {
    return slug;
  }
  const cleaned = slug.replace(/[^a-z0-9-]+/g, "-").replace(/-{3,}/g, "--").replace(/^-+|-+$/g, "");
  if (isTenantSlug(cleaned)) {
    return cleaned;
  }
  return shortenSlug(cleaned || "skill", seed);
}

/** Title for a skill: an explicit display name first, then the declared name, then the directory. */
function skillTitle(candidate: SkillCandidate): string {
  const displayName = localizedText(candidate.data.display_name);
  const declaredName = asString(candidate.data.name);
  return displayName ?? declaredName ?? splitDirectoryName(candidate.raw.dirName).base;
}

/** First meaningful prose line of a `SKILL.md` body, ignoring markdown furniture. */
function bodyHeadline(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.replace(/^[#\s>*`|-]+/, "").trim();
    if (cleaned !== "") {
      return cleaned;
    }
  }
  return "";
}

/**
 * Summary for a skill: `description_zh` first, English second, one line, at most 120 characters.
 *
 * When the front matter declares neither, the first line of the body stands in: server-side
 * `parseTenantSkills` requires a non-empty `summary`, so an empty one would let `--verify` accept a
 * fragment the tenant package then refuses to load. Loading availability wins over a loud refusal, so
 * the summary is derived rather than the row rejected. A skill whose body is empty already fails
 * earlier with `SourceLayoutError`, so the derived fallback has real text to draw from.
 */
function skillSummary(candidate: SkillCandidate): string {
  const descriptionZh = asString(candidate.data.description_zh);
  const description = localizedText(candidate.data.description);
  const declared = oneLine(descriptionZh ?? description ?? "");
  if (declared !== "") {
    return declared;
  }
  return oneLine(bodyHeadline(candidate.body));
}

/** Version declared in front matter, if any. */
function frontmatterVersion(data: Record<string, unknown>): string | undefined {
  return asString(data.version);
}

/** Build the provenance for one skill candidate. */
function skillProvenance(candidate: SkillCandidate, packageLicense: string | undefined): Provenance {
  const version = frontmatterVersion(candidate.data);
  const source =
    candidate.tier === "package"
      ? `workbuddy expert-marketplace:${candidate.packageDirName}#skills/${candidate.raw.dirName}@${version ?? UNSPECIFIED_LICENSE}`
      : `workbuddy skill-marketplace:${candidate.baseSlug}@${version ?? UNSPECIFIED_LICENSE}`;
  return buildProvenance({
    source,
    relativePath: candidate.raw.skillMd.relativePath,
    version,
    fetchedAt: candidate.raw.fetchedAt,
    checksum: candidate.checksum,
    license: asString(candidate.data.license) ?? packageLicense,
    paid: isPaidSkill(candidate.data),
    attribution: attributionFromAuthor(candidate.data.author as PluginJson["author"]),
  });
}

/** Collapse the source's attachment directories into the list P0 did not carry. */
function droppedAttachments(raw: RawSkill): string[] {
  return raw.attachments.map((dir) => `${dir}/`).sort();
}

/**
 * Which rule produced a slug. Recorded in the manifest as `slug_source`.
 *
 * - `raw` — the user-level skill's front-matter `name`, used untouched.
 * - `dechannel` — the same, but the name was claimed by more than one installed skill, so the directory
 *   name was used instead. That name already carries author and channel (`dev-expert__indiv-weishui__skillhub`),
 *   minus the channel token, which is why the rule is called that.
 * - `package_prefix` — `<package>--<skill directory>`, the rule for skills bundled inside an expert.
 * - `bare` — a package slug that would not fit 40 characters, so the bare skill directory name was used.
 * - `hashed` — the last resort: {@link shortenSlug}. It has never fired on real input; if it does, the
 *   input changed rather than the rules, and the hash is the receipt.
 */
export type SlugSource = "raw" | "dechannel" | "package_prefix" | "bare" | "hashed";

/** A slug and the rule that produced it. */
interface SlugAssignment {
  slug: string;
  source: SlugSource;
}

/**
 * Stable seed for {@link shortenSlug}: the source's identity, never its content.
 *
 * Deliberately **not** the checksum and **not** the relative path: a seed that moves when the author fixes
 * a typo would rename the skill on the next run, which is the one thing §3.2 forbids. `<package>/<dir>` and
 * `user/<dir>` are the two things a ported skill is actually identified by on disk.
 */
function slugSeed(candidate: SkillCandidate): string {
  return candidate.tier === "package"
    ? `${candidate.packageDirName ?? ""}/${candidate.raw.dirName}`
    : `user/${candidate.raw.dirName}`;
}

/**
 * Hand every skill its slug.
 *
 * ## The rules
 *
 * Three levels, tried in this order, with no human in the loop — the alternative silently dropped two of
 * the three `dev-expert` builds:
 *
 *   1. **User-level**: the skill keeps the slug from its front-matter `name`. When more than one installed
 *      skill claims that name, all of them fall back to their directory name instead — which already
 *      carries author and channel (`dev-expert--skillhub`, `dev-expert--indiv-weishui`,
 *      `dev-expert--user-814dbe54`). Nobody is dropped and nobody wins; picking a "real" owner would make
 *      the other two permanently second-class for no reason the user could predict.
 *   2. **Package-level**: `<package>--<skill directory>`. A bundled skill is only meaningful as part of its
 *      expert, and this is what keeps `frontend-developer`'s and `senior-developer`'s `fullstack-dev` from
 *      colliding with each other or with the user's own copy.
 *   3. **Overflow**: a prefixed slug that the loader rejects (over 40 characters —
 *      `engineering-workflow-skills--engineering-workflow` is 49) falls back to the bare directory name if
 *      that is free, and only then to a hash suffix. Hash input is the source identity from
 *      {@link slugSeed}, never the truncated slug, so the same source produces the same output on any
 *      machine.
 *
 * ## slug 是用户契约，规则一经落地不许再改
 *
 * This is a hard constraint, not a preference, and it is why the levels are explicit rather than
 * "whatever fits":
 *
 *   1. `slug` is what a person types after `/`. Renaming it renames their muscle memory.
 *   2. `plugin_grants.ref` stores the slug. A rename leaves existing grants pointing at nothing, and a
 *      dangling ref **fails silently by design** — the employee simply stops being able to use that skill,
 *      with no error anyone can trace back.
 *   3. `skills.slug` is globally unique, so a rename frees the old slug for another package to take. The
 *      same string would then mean two different things in two deployments.
 *
 * So rule corrections must land before the first package reaches production; after that, only mappings
 * that leave existing output unchanged are allowed. {@link shortenSlug} is consequently a permanent
 * backstop rather than a rough edge to smooth later: if it fires, the input changed, and that deserves
 * attention rather than a quiet new slug.
 */
function resolveSlugs(candidates: SkillCandidate[]): {
  assignments: Map<SkillCandidate, SlugAssignment>;
  conflicts: SlugConflict[];
} {
  const assignments = new Map<SkillCandidate, SlugAssignment>();

  // How many user-level skills claim each name: more than one means the name alone cannot be the slug.
  const nameClaims = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.tier === "user") {
      nameClaims.set(candidate.nameSlug, (nameClaims.get(candidate.nameSlug) ?? 0) + 1);
    }
  }

  const ordered = [...candidates].sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.raw.dirName.localeCompare(b.raw.dirName) || a.order - b.order,
  );
  const taken = new Set<string>();
  for (const candidate of ordered) {
    const seed = slugSeed(candidate);
    const prefixed =
      candidate.tier === "package" ? `${directorySlug(candidate.packageDirName ?? "")}--${candidate.dirSlug}` : null;
    const named = candidate.tier === "user" && (nameClaims.get(candidate.nameSlug) ?? 0) === 1;

    let assignment: SlugAssignment;
    if (named) {
      // A name that fits is used as-is. A name that is merely *long* is shortened rather than fatal: the
      // hash is deterministic and seeded from the source identity, so the result is stable, and refusing to
      // load a whole package over one cosmetic overflow is a worse failure than a hash suffix. A name with
      // characters the loader forbids would still be a hard error, but `kebab()` cannot produce one, so in
      // practice length is the only case that lands here.
      assignment = isTenantSlug(candidate.nameSlug)
        ? { slug: candidate.nameSlug, source: "raw" }
        : { slug: ensureTenantSlug(candidate.nameSlug, seed), source: "hashed" };
    } else if (prefixed !== null && isTenantSlug(prefixed)) {
      assignment = { slug: prefixed, source: "package_prefix" };
    } else if (isTenantSlug(candidate.dirSlug)) {
      // Level 2 of the overflow rule: the bare directory name, which the package prefix was obscuring.
      // `dechannel` only describes a user-level name that fell back, where the directory name is the
      // de-channeled original.
      assignment = {
        slug: candidate.dirSlug,
        source: candidate.tier === "package" ? "bare" : "dechannel",
      };
    } else {
      assignment = { slug: ensureTenantSlug(candidate.dirSlug, seed), source: "hashed" };
    }

    // Uniqueness is the last word: two sources must never share one slug, whatever the rules produced.
    if (taken.has(assignment.slug)) {
      assignment = { slug: shortenSlug(assignment.slug, seed), source: "hashed" };
      let index = 2;
      while (taken.has(assignment.slug)) {
        assignment = { slug: shortenSlug(`${assignment.slug}-${index}`, `${seed}#${index}`), source: "hashed" };
        index += 1;
      }
    }
    taken.add(assignment.slug);
    assignments.set(candidate, assignment);
  }

  // Reporting: which names had more than one source. Under the rules above the resulting slugs are all
  // distinct by construction, so this is an inventory for a human, not a list of collisions.
  const groups = new Map<string, SkillCandidate[]>();
  for (const candidate of ordered) {
    const group = groups.get(candidate.baseSlug);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.baseSlug, [candidate]);
    }
  }
  const conflicts: SlugConflict[] = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([baseSlug, group]) => ({
      baseSlug,
      resolution: group
        .sort((a, b) => a.order - b.order)
        .map((candidate) => ({
          slug: assignments.get(candidate)?.slug ?? baseSlug,
          origin: candidate.raw.skillMd.relativePath,
        })),
    }))
    .sort((a, b) => a.baseSlug.localeCompare(b.baseSlug));

  return { assignments, conflicts };
}

/** Read a package's members, falling back to `teamInfo.memberAgents` when `members[]` is absent. */
function packageMembers(plugin: PluginJson): PluginMember[] {
  if (Array.isArray(plugin.members) && plugin.members.length > 0) {
    return plugin.members;
  }
  const fromTeamInfo = plugin.teamInfo?.memberAgents ?? [];
  const leadId = plugin.teamInfo?.leadAgent;
  const ids = leadId ? [leadId, ...fromTeamInfo.filter((id) => id !== leadId)] : [...fromTeamInfo];
  return ids.map((id) => ({ id, role: id === leadId ? "lead" : "member" }));
}

/** Whether a package describes a team rather than a single expert. */
export function isTeamPackage(plugin: PluginJson): boolean {
  if (plugin.expertType === "team") {
    return true;
  }
  return Array.isArray(plugin.members) && plugin.members.length > 0;
}

/** The prompt text appended to a team lead's persona, naming every member and the handoff rule. */
export function buildTeamSection(teamName: string, members: NormalizedTeamMember[], leadId: string): string {
  const others = members.filter((member) => member.id !== leadId);
  const rows = others.map((member) => `- ${member.id}（${member.name}，${member.title}）`);
  return [
    "",
    "## 你的团队",
    "",
    `你是「${teamName}」的负责人。团队成员如下：`,
    "",
    ...rows,
    "",
    "需要谁做就叫谁：在群聊里用 @成员名字 交接，交接时写清要交付什么、验收标准是什么、什么时候要。",
    "不要替成员做他分内的事，也不要等成员反问你才补充信息；成员卡住时由你决定继续、换人还是收窄范围。",
    "",
  ].join("\n");
}

/** Build a metadata-derived prompt when a package lists an agent whose `.md` is missing. */
function fallbackPrompt(name: string, title: string, roleDescription: string): string {
  return [`# ${name}`, "", `你是${name}，岗位是${title}。`, "", roleDescription].join("\n");
}

/** Assemble the normalised skill list, its provenance, and the package→skill slug map agents need. */
function normalizeSkills(
  packages: RawExpertPackage[],
  userSkills: RawSkill[],
  droppedPackageSkills: Map<string, RawSkill[]>,
  twinPackages: RawExpertPackage[] = [],
): {
  skills: NormalizedSkill[];
  conflicts: SlugConflict[];
  dropped: DroppedItem[];
  slugBySkillPath: Map<string, string>;
} {
  const candidates: SkillCandidate[] = [];
  let order = 0;
  for (const raw of userSkills) {
    candidates.push(toCandidate(raw, order++));
  }
  for (const pkg of packages) {
    for (const raw of pkg.skills) {
      candidates.push(toCandidate(raw, order++));
    }
  }
  // Twin downloads (same plugin.json + agents, differing SKILL.md) compete on skill content like any
  // other candidate; their order keeps the whole candidate list deterministic.
  for (const pkg of twinPackages) {
    for (const raw of pkg.skills) {
      candidates.push(toCandidate(raw, order++));
    }
  }

  // Content-identical candidates collapse. The surviving one is the readable name at the best tier;
  // the rest are recorded against it so the manifest says what vanished.
  const byChecksum = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    const group = byChecksum.get(candidate.checksum);
    if (group) {
      group.push(candidate);
    } else {
      byChecksum.set(candidate.checksum, [candidate]);
    }
  }
  const survivors: SkillCandidate[] = [];
  const dropped: DroppedItem[] = [];
  const droppedBySurvivor = new Map<SkillCandidate, DroppedItem[]>();
  // Every candidate maps to the one that represents it, so an agent whose package shipped a collapsed
  // duplicate still gets granted the surviving skill rather than silently losing the grant.
  const representativeOf = new Map<SkillCandidate, SkillCandidate>();
  for (const group of byChecksum.values()) {
    const sorted = [...group].sort((a, b) => {
      const tierDelta = tierRank(a.tier) - tierRank(b.tier);
      if (tierDelta !== 0) {
        return tierDelta;
      }
      const readable = readabilityRank(a.raw.dirName) - readabilityRank(b.raw.dirName);
      if (readable !== 0) {
        return readable;
      }
      return a.raw.dirName.localeCompare(b.raw.dirName);
    });
    const survivor = sorted[0];
    survivors.push(survivor);
    for (const candidate of group) {
      representativeOf.set(candidate, survivor);
    }
    const items: DroppedItem[] = [];
    for (const duplicate of sorted.slice(1)) {
      items.push({
        kind: "skill",
        slug: survivor.baseSlug,
        origin: duplicate.raw.skillMd.relativePath,
        reason: `与 ${survivor.raw.skillMd.relativePath} 内容一致（sha256 ${duplicate.checksum.slice(0, 12)}…）`,
      });
    }
    if (items.length > 0) {
      droppedBySurvivor.set(survivor, items);
    }
  }
  survivors.sort((a, b) => a.order - b.order);

  const { assignments, conflicts } = resolveSlugs(survivors);

  const licenseByPackage = new Map<string, string | undefined>();
  for (const pkg of [...packages, ...twinPackages]) {
    licenseByPackage.set(pkg.dirName, pkg.plugin.license);
  }

  const skills: NormalizedSkill[] = [];
  const slugBySkillPath = new Map<string, string>();
  for (const candidate of survivors) {
    const assignment = assignments.get(candidate) ?? { slug: candidate.baseSlug, source: "raw" as SlugSource };
    const slug = assignment.slug;
    // A `SKILL.md` with an empty body is a broken source, not a skill with no content: shipped, it
    // becomes a capability whose `instructions` are zero bytes, which reads downstream as "the model
    // has nothing to do". `--verify` does catch it, but only after the package is on disk and the
    // message no longer says which source produced it. Fail here instead, naming both.
    if (candidate.body.trim() === "") {
      throw new SourceLayoutError(
        `技能 "${slug}" 的 SKILL.md 正文为空：${candidate.raw.skillMd.absolutePath}`,
      );
    }
    const packageLicense =
      candidate.tier === "package" && candidate.packageDirName
        ? licenseByPackage.get(candidate.packageDirName)
        : undefined;
    skills.push({
      slug,
      slugSource: assignment.source,
      baseSlug: candidate.baseSlug,
      title: skillTitle(candidate),
      summary: skillSummary(candidate),
      instructions: candidate.body,
      tools: [],
      declaredTools: readDeclaredTools(candidate.data),
      hasBundledReferences: candidate.raw.hasReferencesDir,
      refsBytes: candidate.raw.referencesBytes,
      dropped: droppedAttachments(candidate.raw),
      sanitized: [],
      tier: candidate.tier,
      provenance: skillProvenance(candidate, packageLicense),
    });
    slugBySkillPath.set(candidate.raw.skillMd.relativePath, slug);
    for (const item of droppedBySurvivor.get(candidate) ?? []) {
      dropped.push(item);
    }
  }

  // Collapsed duplicates answer to the same slug as the survivor, so a package that shipped one of them
  // still binds the skill it declared.
  for (const candidate of candidates) {
    const representative = representativeOf.get(candidate) ?? candidate;
    const slug = assignments.get(representative)?.slug;
    if (slug !== undefined) {
      slugBySkillPath.set(candidate.raw.skillMd.relativePath, slug);
    }
  }

  for (const [packageDirName, raws] of [...droppedPackageSkills.entries()].sort()) {
    for (const raw of raws) {
      dropped.push({
        kind: "skill",
        slug: kebab(raw.dirName) || raw.dirName,
        origin: raw.skillMd.relativePath,
        reason: `所属专家包 ${packageDirName} 是被丢弃的重复下载`,
      });
    }
  }

  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  conflicts.sort((a, b) => a.baseSlug.localeCompare(b.baseSlug));
  dropped.sort((a, b) => a.origin.localeCompare(b.origin));
  return { skills, conflicts, dropped, slugBySkillPath };
}

/** Build the agents and teams of one surviving package. */
function normalizePackage(
  pkg: RawExpertPackage,
  skillSlugs: string[],
  warnings: string[],
): { agents: NormalizedAgent[]; team: NormalizedTeam | null } {
  const plugin = pkg.plugin;
  const packageVersion = asString(plugin.version);
  const packageLicense = asString(plugin.license);
  const packageAttribution = attributionFromAuthor(plugin.author);
  const agentDocById = new Map(pkg.agents.map((doc) => [doc.id, doc]));
  const provenanceFor = (relativePath: string, checksum: string): Provenance =>
    buildProvenance({
      source: `workbuddy expert-marketplace:${pkg.dirName}@${packageVersion ?? UNSPECIFIED_LICENSE}`,
      relativePath,
      version: packageVersion,
      fetchedAt: pkg.fetchedAt,
      checksum,
      license: packageLicense,
      paid: false,
      attribution: packageAttribution,
    });
  const promptFor = (id: string, name: string, title: string, roleDescription: string): string => {
    const doc = agentDocById.get(id);
    if (!doc) {
      warnings.push(`${pkg.dirName}: 成员 ${id} 没有 agents/${id}.md，system_prompt 用元数据兜底`);
      return fallbackPrompt(name, title, roleDescription);
    }
    const { body } = splitFrontmatter(doc.file.text);
    return body === "" ? fallbackPrompt(name, title, roleDescription) : body;
  };

  if (!isTeamPackage(plugin)) {
    const agentId = asString(plugin.agentName) ?? asString(plugin.name) ?? pkg.dirName;
    const name = localizedText(plugin.displayName) ?? agentId;
    const title = localizedText(plugin.profession) ?? "";
    const roleDescription =
      localizedText(plugin.displayDescription) ??
      (title === "" ? `${name} 是 WorkBuddy 专家市场里的独立专家。` : `${name} 是${title}。`);
    const doc = agentDocById.get(agentId);
    const provenance = provenanceFor(
      doc?.file.relativePath ?? pkg.pluginJson.relativePath,
      doc ? sha256Hex(doc.file.text) : sha256Hex(pkg.pluginJson.text),
    );
    return {
      agents: [
        {
          id: kebab(agentId) || kebab(pkg.dirName) || agentId,
          name,
          title,
          roleDescription,
          avatarSeed: kebab(agentId) || kebab(pkg.dirName) || agentId,
          type: "built-in",
          systemPrompt: promptFor(agentId, name, title, roleDescription),
          skills: skillSlugs,
          hasBundledReferences: pkg.attachments.includes("references"),
          teamId: null,
          sanitized: [],
          provenance,
        },
      ],
      team: null,
    };
  }

  const teamId = kebab(asString(plugin.name) ?? pkg.dirName) || kebab(pkg.dirName);
  const teamName =
    TEAM_NAME_OVERRIDES[teamId] ?? localizedText(plugin.displayName) ?? asString(plugin.name) ?? pkg.dirName;
  const members = packageMembers(plugin);
  const leadId =
    asString(plugin.teamInfo?.leadAgent) ??
    members.find((member) => member.role === "lead")?.id ??
    members[0]?.id ??
    asString(plugin.agentName) ??
    teamId;

  const normalizedMembers: NormalizedTeamMember[] = members.map((member) => ({
    id: kebab(member.id) || member.id,
    name: localizedText(member.name) ?? member.id,
    title: localizedText(member.profession) ?? "",
    role: asString(member.role) ?? (member.id === leadId ? "lead" : "member"),
  }));
  // Persona documents are keyed by the ORIGINAL member id (`agents/<id>.md` names the file), while the
  // output uses the normalized id. A source id like `Demo_Lead` normalizes to `demo-lead`, so a lookup
  // by the normalized value silently misses the document and the persona degrades to metadata. Keep the
  // original id for every document/provenance lookup; the normalized id is output-only.
  const originalIdOfMember = new Map(
    members.map((member) => [kebab(member.id) || member.id, member.id] as const),
  );
  const normalizedLeadId = kebab(leadId) || leadId;
  const teamDescription =
    asString(plugin.description) ?? localizedText(plugin.displayDescription) ?? `${teamName}（WorkBuddy 专家团）`;
  const leadMember = normalizedMembers.find((member) => member.id === normalizedLeadId);
  const teamSection = buildTeamSection(teamName, normalizedMembers, normalizedLeadId);

  const agents: NormalizedAgent[] = normalizedMembers.map((member) => {
    const isLead = member.id === normalizedLeadId;
    const roleDescription = isLead
      ? `${teamName}的负责人，负责调度与交付。专业方向：${member.title}。`
      : `${teamName}成员。专业方向：${member.title}。团队角色：${member.role}。`;
    const originalId = originalIdOfMember.get(member.id) ?? member.id;
    const prompt = promptFor(originalId, member.name, member.title, roleDescription);
    const doc = agentDocById.get(originalId);
    return {
      id: member.id,
      name: member.name,
      title: member.title === "" ? (isLead ? "负责人" : "成员") : member.title,
      roleDescription,
      avatarSeed: member.id,
      type: "built-in" as const,
      systemPrompt: isLead ? `${prompt}\n${teamSection}` : prompt,
      skills: skillSlugs,
      hasBundledReferences: pkg.attachments.includes("references"),
      teamId,
      sanitized: [],
      provenance: provenanceFor(
        doc?.file.relativePath ?? pkg.pluginJson.relativePath,
        doc ? sha256Hex(doc.file.text) : sha256Hex(pkg.pluginJson.text),
      ),
    };
  });

  const team: NormalizedTeam = {
    id: teamId,
    name: teamName,
    description: teamDescription,
    channel: teamId,
    lead: normalizedLeadId,
    members: normalizedMembers,
    address: [
      {
        from: normalizedLeadId,
        to: normalizedMembers.filter((member) => member.id !== normalizedLeadId).map((member) => member.id),
      },
    ],
    provenance: provenanceFor(pkg.pluginJson.relativePath, sha256Hex(pkg.pluginJson.text)),
  };
  if (!leadMember) {
    warnings.push(`${pkg.dirName}: 团队负责人 ${normalizedLeadId} 不在 members[] 里`);
  }
  return { agents, team };
}

/** Build one connector, resolving `host` from `url` instead of trusting a copied field.
 *
 * `survey` is the L1 full-marketplace mode (`--connectors=all`): a connector with no reviewed preset in
 * `mapping.ts` gets a survey fallback instead of a refusal — vendor and title from its own catalogue
 * row, `auth` mapped from the row's `auth_mode` and `unknown` whenever it does not map (§4a-4: 推导不出
 * 的写 unknown，不猜), `credentialEnv` from the standard derivation. The reviewed presets stay the only
 * path an L0 brand package can take: the default (`survey: false`) still refuses, because a preset is
 * a human decision and a missing one must be filled in, not improvised.
 */
function normalizeConnector(
  raw: RawConnector,
  dropped: DroppedItem[],
  survey = false,
): NormalizedConnector | null {
  const preset = CONNECTOR_PRESETS[raw.id];
  if (!preset && !survey) {
    throw new Error(
      `connector ${raw.id} has no preset in mapping.ts: add vendor/auth/credentialEnv before porting it`,
    );
  }
  const vendor = preset?.vendor ?? raw.marketplace?.name ?? raw.marketplace?.nameEn ?? raw.id;
  const auth = preset?.auth ?? openbotAuthFor(raw.marketplace?.authMode ?? "") ?? "unknown";
  const credentialEnv = preset?.credentialEnv || deriveCredentialEnv(raw.id);
  const url = raw.server.url;
  if (!url) {
    throw new Error(`connector ${raw.id} has no url; only remote MCP servers are portable`);
  }
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    // Survey mode reads the whole marketplace, so one connector whose url is a shell-style template
    // (measured: tdengine ships `${SCHEMA}://${HOST}:…`) must be dropped with a reason rather than
    // stop the survey. L0 keeps the hard throw — a preset-approved connector with a bad url is a bug.
    if (survey) {
      dropped.push({
        kind: "connector",
        slug: raw.id,
        origin: raw.mcpJson.relativePath,
        reason: `mcp.json 的 url 不是可解析的端点（疑似模板变量）：${url}`,
      });
      return null;
    }
    throw new Error(`connector ${raw.id} has an unparsable url: ${url}`);
  }
  const connectorDropped: string[] = raw.attachedSkillPaths.map(
    (path) => `${path}（连接器自带的安装说明，openbot 侧由 connectors.yaml 直接声明，不移植）`,
  );
  const connectorDir = raw.mcpJson.relativePath.replace(/\/mcp\.json$/, "");
  for (const path of raw.attachedSkillPaths) {
    dropped.push({
      kind: "connector",
      slug: raw.id,
      origin: `${connectorDir}/${path}`,
      reason: "连接器附带的 SKILL.md 只是教模型如何安装该连接器",
    });
  }
  // WorkBuddy's `server-side` and `oneid-token` modes have no openbot carrier: a platform gateway holds
  // the credential and nobody on our side does. The port keeps the contract's `auth` value, so the fact
  // that the platform used to hold it has to be written down where a reviewer will see it.
  const marketAuthMode = raw.marketplace?.authMode;
  if (marketAuthMode !== undefined && openbotAuthFor(marketAuthMode) === null) {
    const note = `WorkBuddy auth_mode=${marketAuthMode} 无 openbot 等价物（平台代持凭证），本包按 ${auth} 声明，凭证需自行提供`;
    connectorDropped.push(note);
    dropped.push({
      kind: "connector",
      slug: raw.id,
      origin: `${connectorDir}/mcp.json`,
      reason: note,
    });
  }
  if (raw.transport === "command") {
    dropped.push({
      kind: "connector",
      slug: raw.id,
      origin: raw.mcpJson.relativePath,
      reason: "本地 stdio MCP（command 形态），openbot 只接远程 URL",
    });
  }
  return {
    id: raw.id,
    title: raw.marketplace?.name ?? raw.marketplace?.nameEn ?? raw.id,
    vendor,
    url,
    host,
    auth,
    credentialEnv,
    dropped: connectorDropped,
    provenance: buildProvenance({
      source: `workbuddy connector-marketplace:${raw.id}`,
      relativePath: raw.mcpJson.relativePath,
      version: undefined,
      fetchedAt: raw.mcpJson.modifiedAt,
      checksum: sha256Hex(raw.mcpJson.text),
      license: undefined,
      paid: false,
      attribution: undefined,
    }),
  };
}

/**
 * Normalise a whole snapshot.
 *
 * Order matters: packages are deduplicated before their skills are collected, so a duplicate download
 * does not present its skills as conflict candidates; slugs are resolved before agents are built,
 * because an agent's `skills[]` holds the resolved slugs.
 */
export function normalizeCapabilities(
  snapshot: WorkBuddySnapshot,
  options: { connectorSurvey?: boolean } = {},
): NormalizedCapabilities {
  const warnings: string[] = [];
  const dropped: DroppedItem[] = [];

  // Step 1: collapse duplicate package downloads by fingerprint.
  const byFingerprint = new Map<string, RawExpertPackage[]>();
  for (const pkg of snapshot.packages) {
    const fingerprint = packageFingerprint(pkg);
    const group = byFingerprint.get(fingerprint);
    if (group) {
      group.push(pkg);
    } else {
      byFingerprint.set(fingerprint, [pkg]);
    }
  }
  const keptPackages: RawExpertPackage[] = [];
  const droppedPackageSkills = new Map<string, RawSkill[]>();
  const packageDrops = new Map<string, { origin: string; reason: string }[]>();
  for (const group of byFingerprint.values()) {
    const sorted = [...group].sort((a, b) => {
      const readable = readabilityRank(a.dirName) - readabilityRank(b.dirName);
      if (readable !== 0) {
        return readable;
      }
      const lengthDelta = a.dirName.length - b.dirName.length;
      if (lengthDelta !== 0) {
        return lengthDelta;
      }
      return a.dirName.localeCompare(b.dirName);
    });
    const survivor = sorted[0];
    keptPackages.push(survivor);
    const items: { origin: string; reason: string }[] = [];
    for (const duplicate of sorted.slice(1)) {
      items.push({
        origin: duplicate.pluginJson.relativePath,
        reason: `与 ${survivor.dirName} 同名同版本且内容一致（按 plugin.json + agents/*.md + skills 的 sha256 去重）`,
      });
      droppedPackageSkills.set(duplicate.dirName, duplicate.skills);
    }
    if (items.length > 0) {
      packageDrops.set(survivor.dirName, items);
    }
  }
  keptPackages.sort((a, b) => a.dirName.localeCompare(b.dirName));

  // Step 1b: identical agent identity, differing skill payloads.
  //
  // Two downloads of the same package whose `plugin.json` and agent documents match but whose
  // `SKILL.md` contents differ are one expert carrying two versions of its skills. Emitting both
  // would clash on the agent id (a primary key in openbot); dropping one wholesale would lose the
  // differing instructions. So one copy produces the agent, and every copy's skills — twin copies
  // included — go into the skill-level content comparison, which is the layer that can actually
  // tell same-content from different-content.
  const byAgentIdentity = new Map<string, RawExpertPackage[]>();
  for (const pkg of keptPackages) {
    const identity = agentIdentityFingerprint(pkg);
    const group = byAgentIdentity.get(identity);
    if (group) {
      group.push(pkg);
    } else {
      byAgentIdentity.set(identity, [pkg]);
    }
  }
  const rankPackageDirs = (a: RawExpertPackage, b: RawExpertPackage): number => {
    const readable = readabilityRank(a.dirName) - readabilityRank(b.dirName);
    if (readable !== 0) {
      return readable;
    }
    const lengthDelta = a.dirName.length - b.dirName.length;
    if (lengthDelta !== 0) {
      return lengthDelta;
    }
    return a.dirName.localeCompare(b.dirName);
  };
  const agentPackages: RawExpertPackage[] = [];
  const twinPackages: RawExpertPackage[] = [];
  for (const group of byAgentIdentity.values()) {
    const sorted = [...group].sort(rankPackageDirs);
    agentPackages.push(sorted[0]);
    for (const twin of sorted.slice(1)) {
      twinPackages.push(twin);
      dropped.push({
        kind: "agent",
        slug: packageIdentitySlug(twin),
        origin: twin.pluginJson.relativePath,
        reason: `与 ${sorted[0].dirName} 的 plugin.json 与 agents/*.md 一致、仅随包技能内容不同；人设并入同一包，技能按内容逐份比较保留`,
      });
    }
  }
  agentPackages.sort((a, b) => a.dirName.localeCompare(b.dirName));
  twinPackages.sort((a, b) => a.dirName.localeCompare(b.dirName));

  // Step 2: skills, including slug conflict resolution. Twin downloads contribute their skills too,
  // so differing payloads are compared at the content level instead of being discarded.
  const skillResult = normalizeSkills(agentPackages, snapshot.userSkills, droppedPackageSkills, twinPackages);
  dropped.push(...skillResult.dropped);

  // Step 3: agents and teams, which need the resolved skill slugs. Twin downloads emit nothing here:
  // their agent identity is identical to the surviving copy's, and openbot's agent id is a primary key.
  const agents: NormalizedAgent[] = [];
  const teams: NormalizedTeam[] = [];
  for (const pkg of agentPackages) {
    const slugs = pkg.skills
      .map((raw) => skillResult.slugBySkillPath.get(raw.skillMd.relativePath))
      .filter((slug): slug is string => slug !== undefined);
    const built = normalizePackage(pkg, slugs, warnings);
    agents.push(...built.agents);
    if (built.team) {
      teams.push(built.team);
    }
    // A dropped duplicate download is reported on every entry the surviving package produces, so the
    // manifest row a reviewer is looking at is the row that says what vanished beside it.
    for (const item of packageDrops.get(pkg.dirName) ?? []) {
      for (const agent of built.agents) {
        dropped.push({ kind: "agent", slug: agent.id, origin: item.origin, reason: item.reason });
      }
      if (built.team) {
        dropped.push({ kind: "team", slug: built.team.id, origin: item.origin, reason: item.reason });
      }
    }
  }

  // Step 4: connectors.
  const connectors: NormalizedConnector[] = [];
  for (const raw of snapshot.connectors) {
    if (raw.transport !== "url") {
      dropped.push({
        kind: "connector",
        slug: raw.id,
        origin: raw.mcpJson.relativePath,
        reason: `transport=${raw.transport}，openbot 只接远程 URL 的 MCP server`,
      });
      continue;
    }
    const connector = normalizeConnector(raw, dropped, options.connectorSurvey === true);
    if (connector !== null) {
      connectors.push(connector);
    }
  }

  // Step 5: uniqueness. An agent id is a primary key in openbot, so a clash must stop the run.
  const seenAgentIds = new Set<string>();
  for (const agent of agents) {
    if (seenAgentIds.has(agent.id)) {
      throw new Error(`duplicate agent id: ${agent.id}`);
    }
    seenAgentIds.add(agent.id);
  }
  const seenSkillSlugs = new Set<string>();
  for (const skill of skillResult.skills) {
    if (seenSkillSlugs.has(skill.slug)) {
      throw new Error(`duplicate skill slug: ${skill.slug}`);
    }
    seenSkillSlugs.add(skill.slug);
  }

  agents.sort((a, b) => a.id.localeCompare(b.id));
  teams.sort((a, b) => a.id.localeCompare(b.id));
  connectors.sort((a, b) => a.id.localeCompare(b.id));
  dropped.sort((a, b) => `${a.kind}:${a.slug}:${a.origin}`.localeCompare(`${b.kind}:${b.slug}:${b.origin}`));

  // Step 6: redaction, after every body has been assembled and before anything leaves this function.
  // Instruction text ships to customers verbatim, and several sources quote the author's own machine.
  for (const skill of skillResult.skills) {
    const { text, hits } = sanitizeLocalUserPaths(skill.instructions);
    if (hits > 0) {
      skill.instructions = text;
      skill.sanitized = [SANITIZED_LOCAL_USER_PATH];
    }
  }
  for (const agent of agents) {
    const { text, hits } = sanitizeLocalUserPaths(agent.systemPrompt);
    if (hits > 0) {
      agent.systemPrompt = text;
      agent.sanitized = [SANITIZED_LOCAL_USER_PATH];
    }
  }

  return {
    agents,
    teams,
    skills: skillResult.skills,
    connectors,
    conflicts: skillResult.conflicts,
    dropped,
    warnings: [...warnings].sort(),
  };
}
