/**
 * Reads the three places WorkBuddy keeps a capability on this machine and returns them as plain
 * records. No normalisation, no judgement: this module only knows the on-disk layout.
 *
 * The layout, measured on a real install rather than assumed:
 *
 *   <home>/plugins/marketplaces/experts/plugins/<package>/
 *     .codebuddy-plugin/plugin.json     metadata: expertType, agents[], skills[], members[]
 *     .downloaded_at                    ISO8601, when the package was fetched
 *     agents/<id>.md                    the persona and workflow, becomes openbot's system_prompt
 *     skills/<name>/SKILL.md            bundled skills, only the ones plugin.json declares
 *     avatars/*.png                     not portable: openbot has no image avatars
 *
 *   <home>/skills/<dir>/SKILL.md        user-level skills; <dir> may carry a __<source> suffix
 *   <home>/connectors-marketplace/connectors/<id>/mcp.json
 *
 * Everything returned carries a path relative to the WorkBuddy home, never an absolute one, because
 * the emitted package must not depend on whose machine produced it. `fetched_at` comes from the sync
 * metadata (or the file mtime) rather than from the clock, which is what makes two runs byte-identical.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directory names below the WorkBuddy home. Kept here so every caller agrees on the layout. */
export const WORKBUDDY_LAYOUT = {
  skills: "skills",
  expertPackages: "plugins/marketplaces/experts/plugins",
  connectors: "connectors-marketplace/connectors",
  /** The marketplace index: titles, `auth_mode` and `visible_in` for all 298 connector definitions. */
  connectorIndex: "connectors-marketplace/.codebuddy-connector/connectors.json",
} as const;

/** A file read off disk, still unparsed. */
export interface SourceFile {
  /** Posix path relative to the WorkBuddy home, e.g. `skills/dev-expert__skillhub/SKILL.md`. */
  relativePath: string;
  /** Where it actually lives; diagnostics only, never emitted. */
  absolutePath: string;
  /** Decoded contents, exactly as stored apart from the byte-order mark. */
  text: string;
  /** File modification time as ISO8601, the last-resort `fetched_at`. */
  modifiedAt: string;
}

/** A skill directory that carries its own `SKILL.md`. */
export interface RawSkill {
  /** Directory name, e.g. `dev-expert__indiv-weishui__skillhub`. Source of the provenance suffix. */
  dirName: string;
  /** `SKILL.md` and its contents. */
  skillMd: SourceFile;
  /** Sub-directories shipped beside `SKILL.md` (`references`, `scripts`, `templates`, `assets`, …). */
  attachments: string[];
  /** Whether `references/` is present, which decides one audit rule. */
  hasReferencesDir: boolean;
  /** Total bytes under `references/`, recursively. 0 when the skill ships none. */
  referencesBytes: number;
  /** When the skill was installed, from `_skillhub_meta.json` when present. */
  fetchedAt: string;
  /** Which of the three inputs this came from; also the tier used to resolve slug conflicts. */
  tier: SkillTier;
  /** Set for skills bundled inside an expert package. */
  packageDirName: string | null;
}

/** Where a skill was found. Tier order is the conflict-resolution order. */
export type SkillTier = "user" | "package";

/** One `agents/<id>.md` inside an expert package. */
export interface RawAgentDoc {
  /** File name without `.md`; also the openbot agent id. */
  id: string;
  file: SourceFile;
}

/** The subset of `.codebuddy-plugin/plugin.json` this pipeline reads. */
export interface PluginJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  author?: { name?: string; email?: string } | string;
  homepage?: { url?: string; type?: string } | string;
  expertType?: "agent" | "team";
  agentName?: string;
  agents?: string[] | null;
  skills?: string[] | null;
  displayName?: { en?: string; zh?: string } | null;
  profession?: { en?: string; zh?: string } | null;
  displayDescription?: { en?: string; zh?: string } | null;
  avatar?: string;
  teamInfo?: { leadAgent?: string; memberAgents?: string[] } | null;
  members?: PluginMember[] | null;
}

/** One entry of `plugin.json`'s `members[]`. */
export interface PluginMember {
  id: string;
  name?: { en?: string; zh?: string } | null;
  profession?: { en?: string; zh?: string } | null;
  avatar?: string;
  role?: string;
}

/** An expert package: one agent, or a team of them. */
export interface RawExpertPackage {
  /** Directory name, e.g. `engineering-workflow-skills` or `ex_eqoqYRT1NIwb`. */
  dirName: string;
  pluginJson: SourceFile;
  plugin: PluginJson;
  /** Every `agents/*.md`, sorted by id. */
  agents: RawAgentDoc[];
  /** Bundled skills declared by `plugin.json`, in declaration order. */
  skills: RawSkill[];
  /**
   * Sub-directories at the package root (`references`, `examples`, `rules`, `avatars`, …).
   *
   * An agent's body can point at `<package>/references/…`, so whether the package ships that directory
   * decides one audit rule for the agent, exactly as `references/` beside `SKILL.md` does for a skill.
   */
  attachments: string[];
  /** When the package was downloaded, from `.downloaded_at`. */
  fetchedAt: string;
}

/** One `mcpServers` entry read from a connector's `mcp.json`. */
export interface RawConnector {
  /** Connector id — also `mcpServers` key and openbot's `serverId` (tool-ref prefix). */
  id: string;
  dirName: string;
  mcpJson: SourceFile;
  /** The single server spec under `mcpServers.<id>`. */
  server: {
    url?: string;
    command?: string;
    args?: string[];
    timeout?: number;
  };
  /** Whether the spec is a remote URL (portable) or a local stdio command (not portable). */
  transport: "url" | "command" | "unknown";
  /** A `SKILL.md` shipped beside `mcp.json`, if any. Not ported in P0, recorded so it is visible. */
  attachedSkillPaths: string[];
  /**
   * The connector's row in `connectors.json`, which is where the Chinese title and — more importantly —
   * the `auth_mode` live. `mcp.json` carries neither.
   */
  marketplace: MarketplaceEntry | null;
}

/** One row of `.codebuddy-connector/connectors.json`. */
export interface MarketplaceEntry {
  id: string;
  /** Chinese title. */
  name?: string;
  nameEn?: string;
  /** WorkBuddy's credential model for this connector; decides whether openbot can carry it at all. */
  authMode?: string;
  /** `mcp` for a server this file describes, `cli` for one that has no `mcp.json` at all. */
  type?: string;
}

/** Everything one run of the reader found. */
export interface WorkBuddySnapshot {
  /** Absolute path of the WorkBuddy home that was read. Diagnostics only. */
  sourceRoot: string;
  packages: RawExpertPackage[];
  userSkills: RawSkill[];
  connectors: RawConnector[];
}

/** Options for `readWorkBuddy`. */
export interface ReadWorkBuddyOptions {
  /** WorkBuddy home, normally `~/.workbuddy`. */
  sourceRoot: string;
  /** Connector ids to read. Connectors outside this list are not even opened. */
  connectorAllowlist?: readonly string[];
}

/** Thrown when the source tree does not look like a WorkBuddy home. */
export class SourceLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceLayoutError";
  }
}

/** Strip a UTF-8 BOM, which `JSON.parse` refuses and which several of these files carry. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;
}

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

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Total size of every file under a directory, recursively.
 *
 * This is the number that decides whether a skill's `references/` can be inlined into its instructions
 * (the 24KB threshold in §4c) or needs the `skill_assets` + `skills/read` channel. Counting it here, while
 * the directory is already open, keeps it out of the converter.
 */
export function directorySize(path: string): number {
  let total = 0;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(child);
      continue;
    }
    try {
      total += statSync(child).size;
    } catch {
      // A file that vanished mid-walk contributes nothing; the total stays a lower bound.
    }
  }
  return total;
}

/** Read one file and describe it relative to `sourceRoot`. */
function readSourceFile(sourceRoot: string, absolutePath: string): SourceFile {
  const text = stripBom(readFileSync(absolutePath, "utf8"));
  return {
    relativePath: toPosix(relative(sourceRoot, absolutePath)),
    absolutePath,
    text,
    modifiedAt: statSync(absolutePath).mtime.toISOString(),
  };
}

/**
 * Read the ISO8601 timestamp in `.downloaded_at`, falling back to a file's mtime.
 *
 * Using the file's own timestamp instead of the clock is what makes `--out ./tmp/p1` and
 * `--out ./tmp/p2` diff clean.
 */
function readDownloadedAt(absolutePath: string, fallbackIso: string): string {
  if (!isFile(absolutePath)) {
    return fallbackIso;
  }
  const raw = stripBom(readFileSync(absolutePath, "utf8")).trim();
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? fallbackIso : new Date(parsed).toISOString();
}

/**
 * Read `installedAt` out of `_skillhub_meta.json` (epoch milliseconds), falling back to the mtime.
 *
 * SkillHub installs record when the skill arrived; skills installed by hand only have their mtime.
 */
function readSkillhubInstalledAt(dirAbsolutePath: string, fallbackIso: string): string {
  const metaPath = join(dirAbsolutePath, "_skillhub_meta.json");
  if (!isFile(metaPath)) {
    return fallbackIso;
  }
  try {
    const meta = JSON.parse(stripBom(readFileSync(metaPath, "utf8"))) as { installedAt?: unknown };
    const installedAt = meta.installedAt;
    if (typeof installedAt === "number" && Number.isFinite(installedAt)) {
      return new Date(installedAt).toISOString();
    }
    return fallbackIso;
  } catch {
    return fallbackIso;
  }
}

/**
 * Read one skill directory.
 *
 * Returns `null` when the directory has no `SKILL.md`, which is how the two stray migration JSON files
 * in `~/.workbuddy/skills` are skipped without special-casing their names.
 */
function readSkill(
  sourceRoot: string,
  dirAbsolutePath: string,
  tier: SkillTier,
  packageDirName: string | null,
): RawSkill | null {
  const skillMdPath = join(dirAbsolutePath, "SKILL.md");
  if (!isFile(skillMdPath)) {
    return null;
  }
  const skillMd = readSourceFile(sourceRoot, skillMdPath);
  const attachments = listDirectories(dirAbsolutePath);
  const hasReferencesDir = attachments.includes("references");
  return {
    dirName: dirAbsolutePath.slice(dirAbsolutePath.lastIndexOf(sep) + 1),
    skillMd,
    attachments,
    hasReferencesDir,
    referencesBytes: hasReferencesDir ? directorySize(join(dirAbsolutePath, "references")) : 0,
    fetchedAt: readSkillhubInstalledAt(dirAbsolutePath, skillMd.modifiedAt),
    tier,
    packageDirName,
  };
}

/**
 * Read every user-level skill directory.
 *
 * Sorted by directory name so the emitted package does not depend on directory enumeration order.
 */
export function readUserSkills(sourceRoot: string): RawSkill[] {
  const skillsRoot = join(sourceRoot, WORKBUDDY_LAYOUT.skills);
  if (!isDirectory(skillsRoot)) {
    return [];
  }
  const skills: RawSkill[] = [];
  for (const dirName of listDirectories(skillsRoot)) {
    const skill = readSkill(sourceRoot, join(skillsRoot, dirName), "user", null);
    if (skill) {
      skills.push(skill);
    }
  }
  return skills;
}

/** Resolve a `plugin.json` relative reference such as `./agents/x.md` against the package root. */
function resolvePackagePath(packageRoot: string, reference: string): string {
  return join(packageRoot, reference.replace(/^\.\//, ""));
}

/**
 * Read the agent documents of a package.
 *
 * `plugin.json` usually lists them, but `software-company` ships five `agents/*.md` with no `agents`
 * key at all, so the directory is scanned and the declared list only decides ordering.
 */
function readAgentDocs(sourceRoot: string, packageRoot: string, plugin: PluginJson): RawAgentDoc[] {
  const declared = (plugin.agents ?? []).map((reference) => resolvePackagePath(packageRoot, reference));
  const agentsDir = join(packageRoot, "agents");
  const discovered = isDirectory(agentsDir)
    ? readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => join(agentsDir, entry.name))
        .sort()
    : [];
  const paths = new Set<string>([...declared, ...discovered]);
  const docs: RawAgentDoc[] = [];
  for (const absolutePath of [...paths].sort()) {
    if (!isFile(absolutePath)) {
      continue;
    }
    const fileName = absolutePath.slice(absolutePath.lastIndexOf(sep) + 1);
    docs.push({
      id: fileName.replace(/\.md$/, ""),
      file: readSourceFile(sourceRoot, absolutePath),
    });
  }
  return docs;
}

/**
 * Read the skills a package declares.
 *
 * Only declared skills are read: `code-architect-expert` ships a `skills/architecture-reference`
 * directory that `plugin.json` never mentions, and porting it would grant an employee a skill its
 * author deliberately kept unbound.
 *
 * A declared skill whose directory is missing is an error, not a skip: it is the only signal that a
 * package arrived incomplete, and skipping it would port an expert whose declared capability silently
 * does not exist.
 */
function readPackageSkills(
  sourceRoot: string,
  packageRoot: string,
  packageDirName: string,
  plugin: PluginJson,
): RawSkill[] {
  const declaredPaths = plugin.skills ?? [];
  const skills: RawSkill[] = [];
  for (const reference of declaredPaths) {
    const skillDir = resolvePackagePath(packageRoot, reference);
    const skill = readSkill(sourceRoot, skillDir, "package", packageDirName);
    if (!skill) {
      throw new SourceLayoutError(
        `${packageDirName}/.codebuddy-plugin/plugin.json declares skills entry "${reference}" but ${reference}/SKILL.md does not exist`,
      );
    }
    skills.push(skill);
  }
  return skills;
}

/** Read one expert package directory. */
export function readExpertPackage(sourceRoot: string, packageDirName: string): RawExpertPackage | null {
  const packageRoot = join(sourceRoot, WORKBUDDY_LAYOUT.expertPackages, packageDirName);
  const pluginJsonPath = join(packageRoot, ".codebuddy-plugin", "plugin.json");
  if (!isFile(pluginJsonPath)) {
    return null;
  }
  const pluginJson = readSourceFile(sourceRoot, pluginJsonPath);
  let plugin: PluginJson;
  try {
    plugin = JSON.parse(pluginJson.text) as PluginJson;
  } catch (error) {
    throw new SourceLayoutError(
      `${pluginJson.relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const agents = readAgentDocs(sourceRoot, packageRoot, plugin);
  return {
    dirName: packageDirName,
    pluginJson,
    plugin,
    agents,
    skills: readPackageSkills(sourceRoot, packageRoot, packageDirName, plugin),
    attachments: listDirectories(packageRoot),
    fetchedAt: readDownloadedAt(join(packageRoot, ".downloaded_at"), pluginJson.modifiedAt),
  };
}

/** Read every expert package, sorted by directory name. */
export function readExpertPackages(sourceRoot: string): RawExpertPackage[] {
  const packagesRoot = join(sourceRoot, WORKBUDDY_LAYOUT.expertPackages);
  if (!isDirectory(packagesRoot)) {
    return [];
  }
  const packages: RawExpertPackage[] = [];
  for (const dirName of listDirectories(packagesRoot)) {
    const read = readExpertPackage(sourceRoot, dirName);
    if (read) {
      packages.push(read);
    }
  }
  return packages;
}

/** Find a `SKILL.md` anywhere under a connector directory, at a fixed shallow depth. */
function findAttachedSkillPaths(dirAbsolutePath: string): string[] {
  const found: string[] = [];
  for (const child of ["skill", "skills"]) {
    const candidate = join(dirAbsolutePath, child, "SKILL.md");
    if (isFile(candidate)) {
      found.push(`${child}/SKILL.md`);
      continue;
    }
    const nestedRoot = join(dirAbsolutePath, child);
    if (!isDirectory(nestedRoot)) {
      continue;
    }
    for (const skillDirName of listDirectories(nestedRoot)) {
      if (isFile(join(nestedRoot, skillDirName, "SKILL.md"))) {
        found.push(`${child}/${skillDirName}/SKILL.md`);
      }
    }
  }
  return found.sort();
}

/**
 * Read the connector marketplace index into a map keyed by connector id.
 *
 * Missing or unparsable is not fatal: the index is metadata, and a port that loses its Chinese titles
 * should still produce connectors rather than nothing.
 */
export function readConnectorIndex(sourceRoot: string): Map<string, MarketplaceEntry> {
  const indexPath = join(sourceRoot, WORKBUDDY_LAYOUT.connectorIndex);
  const index = new Map<string, MarketplaceEntry>();
  if (!isFile(indexPath)) {
    return index;
  }
  try {
    const parsed = JSON.parse(stripBom(readFileSync(indexPath, "utf8"))) as {
      connectors?: { id?: unknown; name?: unknown; name_en?: unknown; auth_mode?: unknown; type?: unknown }[];
    };
    for (const entry of parsed.connectors ?? []) {
      const id = typeof entry.id === "string" ? entry.id : undefined;
      if (!id) {
        continue;
      }
      index.set(id, {
        id,
        name: typeof entry.name === "string" ? entry.name : undefined,
        nameEn: typeof entry.name_en === "string" ? entry.name_en : undefined,
        authMode: typeof entry.auth_mode === "string" ? entry.auth_mode : undefined,
        type: typeof entry.type === "string" ? entry.type : undefined,
      });
    }
    return index;
  } catch {
    return index;
  }
}

/**
 * Read one connector.
 *
 * A connector whose only spec is a local `command` is not portable: openbot connects to remote MCP
 * servers by URL and has no way to run a stdio child process per employee. Those are returned with
 * `transport: "command"` so the caller can drop them with a reason instead of silently skipping.
 */
export function readConnector(
  sourceRoot: string,
  id: string,
  index: Map<string, MarketplaceEntry> = new Map(),
): RawConnector | null {
  const connectorRoot = join(sourceRoot, WORKBUDDY_LAYOUT.connectors, id);
  const mcpJsonPath = join(connectorRoot, "mcp.json");
  if (!isFile(mcpJsonPath)) {
    return null;
  }
  const mcpJson = readSourceFile(sourceRoot, mcpJsonPath);
  let parsed: { mcpServers?: Record<string, RawConnector["server"]> };
  try {
    parsed = JSON.parse(mcpJson.text) as { mcpServers?: Record<string, RawConnector["server"]> };
  } catch (error) {
    throw new SourceLayoutError(
      `${mcpJson.relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const servers = parsed.mcpServers ?? {};
  const server = servers[id] ?? servers[Object.keys(servers).sort()[0] ?? ""];
  if (!server) {
    return null;
  }
  const transport: RawConnector["transport"] = server.url ? "url" : server.command ? "command" : "unknown";
  return {
    id,
    dirName: id,
    mcpJson,
    server,
    transport,
    attachedSkillPaths: findAttachedSkillPaths(connectorRoot),
    marketplace: index.get(id) ?? null,
  };
}

/**
 * Read a WorkBuddy home.
 *
 * Throws `SourceLayoutError` when none of the three inputs exist, because a run that reads nothing and
 * writes an empty package is worse than a run that stops: the caller would commit a package that
 * silently deletes every capability on the next sync.
 */
export function readWorkBuddy(options: ReadWorkBuddyOptions): WorkBuddySnapshot {
  const { sourceRoot, connectorAllowlist = [] } = options;
  if (!existsSync(sourceRoot)) {
    throw new SourceLayoutError(`WorkBuddy home not found: ${sourceRoot}`);
  }
  const packages = readExpertPackages(sourceRoot);
  const userSkills = readUserSkills(sourceRoot);
  const connectors: RawConnector[] = [];
  const connectorIndex = connectorAllowlist.length > 0 ? readConnectorIndex(sourceRoot) : new Map<string, MarketplaceEntry>();
  for (const id of [...connectorAllowlist].sort()) {
    const connector = readConnector(sourceRoot, id, connectorIndex);
    if (connector) {
      connectors.push(connector);
    }
  }
  if (packages.length === 0 && userSkills.length === 0 && connectors.length === 0) {
    throw new SourceLayoutError(
      `nothing to port under ${sourceRoot}: expected ${WORKBUDDY_LAYOUT.expertPackages}, ` +
        `${WORKBUDDY_LAYOUT.skills} or ${WORKBUDDY_LAYOUT.connectors}`,
    );
  }
  return { sourceRoot, packages, userSkills, connectors };
}
