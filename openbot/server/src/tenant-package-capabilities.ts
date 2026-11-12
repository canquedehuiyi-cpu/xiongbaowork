import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, notInArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { type CredentialStore, sealCredential } from "./credentials";
import type { Database } from "./db/client";
import { mcpServers, pluginGrants, skillAssets, skillTools } from "./db/schema";
import { SYSTEM_TENANT } from "./db/schema/tenant";
import { isSafeSkillAssetPath } from "./skills/assets-store";

/**
 * What a tenant package may declare BEYOND the five core files, and the code that turns each
 * declaration into rows (4c-C2 skill assets; 4a-A1 connectors and 4b-B1 teams follow).
 *
 * WHY THIS FILE EXISTS. `tenant-package.ts` is the package contract's spine and every suite in the
 * build reads it; its diff for each new capability is kept to wiring only. Parsing, validation and
 * the database writes for a capability live here, one module per contract family, so a capability can
 * be read — and refused — without walking a two-thousand-line synchroniser, and so a test of one
 * capability imports exactly that capability.
 *
 * Everything here runs inside the package sync's `system` transaction unless a function says
 * otherwise, for the same reason the sync itself does: the rows are the deployment's catalogue, not
 * anybody's workspace.
 */

/** One attached file a skill ships, as it is read from the package and written to `skill_assets`. */
export type SkillAssetFile = {
  /** The file's name inside the skill, e.g. `references/step-3.md`. */
  path: string;
  mediaType: string;
  content: string;
  /** UTF-8 byte length of `content`. */
  bytes: number;
  /** SHA-256 hex of `content`, so a redeploy can tell an unchanged file from a rewritten one. */
  checksum: string;
};

/**
 * The asset paths one `skills.yaml` entry declares, validated.
 *
 * `assets` is optional and absent means none, which is every package written before attachments
 * shipped. A path is relative to the skill's own directory (`skills/<slug>/`); one that escapes it —
 * an absolute path, a `..` segment, a backslash — is REFUSED rather than dropped, and the error names
 * the slug: a typo that silently attaches nothing is the failure mode package loading refuses
 * everywhere else (an unknown skill slug, an unknown agent id), and this is the same decision.
 *
 * A repeated path is refused too: both would map to one `skill_assets` row, so the second was
 * either a duplicate to delete or a shadowing the author did not mean.
 */
export function parseSkillAssetPaths(value: unknown, slug: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`skill "${slug}" assets must be an array of paths`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of value as string[]) {
    const path = raw.trim();
    if (!isSafeSkillAssetPath(path)) {
      throw new Error(
        `skill "${slug}" asset path "${path}" must be a relative path inside skills/${slug}/`,
      );
    }
    if (seen.has(path)) {
      throw new Error(`skill "${slug}" declares asset "${path}" twice`);
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** Extensions a skill attachment may carry, and the media type each reads as. */
const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  csv: "text/csv",
  html: "text/html",
});

function mediaTypeOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPES[extension] ?? "text/plain";
}

/**
 * Read every declared skill attachment off disk, keyed by skill slug.
 *
 * Called from `loadTenantPackage`, so the files land in the loaded package, in its checksum, and in
 * the sync's writes — a deployment runs the files its database holds, never whatever happens to sit
 * in the package directory this boot. A declared path that does not exist is an error naming both the
 * skill and the path, the same sentence shape a missing core file gets.
 */
export async function loadSkillAssetFiles(
  sourcePath: string,
  skills: readonly { slug: string; assets?: readonly string[] }[],
): Promise<Record<string, SkillAssetFile[]>> {
  const bySlug: Record<string, SkillAssetFile[]> = {};
  for (const skill of skills) {
    const declared = skill.assets ?? [];
    if (declared.length === 0) continue;
    const files = await Promise.all(
      declared.map(async (path) => {
        let content: string;
        try {
          content = await readFile(
            join(sourcePath, "skills", skill.slug, path),
            "utf8",
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === "ENOENT" || code === "EISDIR") {
            throw new Error(
              `skill "${skill.slug}" declares asset "${path}", which is missing from skills/${skill.slug}/`,
            );
          }
          throw error;
        }
        return {
          path,
          mediaType: mediaTypeOf(path),
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          checksum: createHash("sha256").update(content).digest("hex"),
        } satisfies SkillAssetFile;
      }),
    );
    bySlug[skill.slug] = files;
  }
  return bySlug;
}

/** One manifest line: the path, the size rounded the way a person reads it, and the type. */
function manifestLine(file: SkillAssetFile): string {
  return `- ${file.path}（${(file.bytes / 1024).toFixed(1)}KB，${file.mediaType}）`;
}

/**
 * The machine-generated attachment manifest for a skill's instructions.
 *
 * Empty when the skill ships no files, so a skill without attachments keeps instructions that read
 * exactly as it wrote them. Present, the manifest is APPENDED, never spliced: the author's text stays
 * byte-identical above the separator, and the tools are named by their full refs so a Bot that has
 * them can act and one that does not is told where they would come from.
 */
export function skillAssetManifest(files: readonly SkillAssetFile[]): string {
  if (files.length === 0) return "";
  return [
    "---",
    "本技能的附件（用 skills/list_skill_assets 与 skills/read_skill_asset 按步读取）：",
    ...files.map(manifestLine),
  ].join("\n");
}

/** A skill's instructions with its attachment manifest appended (empty manifest changes nothing). */
export function skillInstructions(
  instructions: string,
  files: readonly SkillAssetFile[],
): string {
  const manifest = skillAssetManifest(files);
  return manifest ? `${instructions}\n\n${manifest}` : instructions;
}

/**
 * The write half of a skill's attachments, run inside the sync transaction right after the skill row
 * is upserted (so the foreign key always has its skill).
 *
 * REPLACED WHOLESALE, like `skill_tools`: every row the skill held is deleted and the declared set
 * written, so a redeploy that drops or renames a file takes the old row with it and a same-slug
 * resync clears attachments the package stopped declaring. A package SWITCH needs no extra work here:
 * the other brand's skill rows are the retire sweep's to delete, and `skill_assets.skill_id` is
 * `ON DELETE CASCADE`, so their files go with them — which is why this function never deletes by
 * anything but the skill it was handed.
 *
 * The rows are stamped `system` by the frame (their `tenant_id` default), the same partition the sync
 * writes every other catalogue row to, which is what makes them readable from a person's frame.
 */
export async function writeSkillAssets(
  executor: Pick<Database, "delete" | "insert">,
  skillId: string,
  files: readonly SkillAssetFile[],
): Promise<void> {
  await executor.delete(skillAssets).where(eq(skillAssets.skillId, skillId));
  if (files.length > 0) {
    await executor.insert(skillAssets).values(
      files.map((file) => ({
        skillId,
        path: file.path,
        mediaType: file.mediaType,
        content: file.content,
        bytes: file.bytes,
        checksum: file.checksum,
      })),
    );
  }
}

/**
 * The attachment rows a set of skills holds, for tests and sweeps that ask "what is on file" without
 * going through the read tools.
 */
export async function skillAssetRows(
  database: Database,
  skillIds: readonly string[],
): Promise<{ skillId: string; path: string }[]> {
  if (skillIds.length === 0) return [];
  return await database
    .select({ skillId: skillAssets.skillId, path: skillAssets.path })
    .from(skillAssets)
    .where(inArray(skillAssets.skillId, [...skillIds]));
}

// --------------------------------------------------------------------------------------------------
// 4a-A1: connectors (`connectors.yaml`)

/**
 * The mark every row this capability writes carries, in `mcp_servers.added_by`.
 *
 * The same idea as the sync's {@link PACKAGE_GRANT} for grants: every other value there is who pressed
 * the button, so a package-shaped constant cannot collide with a person, and a redeploy can take back
 * exactly — and only — what the package wrote.
 */
export const PACKAGE_MARK = "tenant-package";

/** How a package connector authenticates. A closed set: a package cannot name an auth the build does not know. */
export type PackageConnectorAuth = "user-oauth" | "deployment-bearer" | "none";

/** One connector a package declares, as `connectors.yaml` states it. */
export type PackageConnector = {
  /** The `mcp_servers` row id — and so the prefix of every tool ref it will ever be granted by. */
  id: string;
  title: string;
  vendor: string;
  url: string;
  /** The URL's hostname, restated and checked character for character (see {@link parseConnectors}). */
  host: string;
  auth: PackageConnectorAuth;
  /**
   * The NAME of the environment variable holding the credential, never the value.
   *
   * A package ships to many machines; the value belongs to the machine that runs it. A value written
   * into a package file would be a secret in a repository, so the contract carries the variable's name
   * and nothing else, and validation refuses a name no environment variable could have.
   */
  credentialEnv: string | null;
  docsUrl: string | null;
};

/**
 * The vault the connector writes need, when a deployment has one to hand.
 *
 * Optional because the sync must keep working for every caller that does not declare connectors and
 * for the tests that build packages in memory; a package that DOES declare a set credential while the
 * vault is absent is refused at sync rather than silently degraded (see `connectorCredentialId`).
 */
export type PackageVault = {
  encryptionKey: string;
  credentials: Pick<CredentialStore, "findLiveByKey" | "create">;
};

const CONNECTOR_AUTHS: readonly PackageConnectorAuth[] = [
  "user-oauth",
  "deployment-bearer",
  "none",
];

/** A variable name, not a value: the only shape `credential_env` may take. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The connectors one package document declares, validated.
 *
 * Absent (or empty) is a package that declares no connectors — every package written before this
 * contract shipped. `write_tools` is read and IGNORED on purpose: which of a connector's tools are
 * writes is a reviewed decision the catalogue owns (and, for a server added by URL, the tool rows'
 * own `effect`), and a package file must not be able to reclassify one — a P3 slice takes that over,
 * and until then a `write_tools` key in a package changes nothing.
 *
 * The `host` rule is the whole point of the field. The catalogue pins each vendor's host because a
 * URL this deployment hands a credential to is a reviewed contract; a package is a hand-written file
 * that arrives one step further from review, so the same control holds at load: `host` must equal the
 * URL's hostname CHARACTER FOR CHARACTER, and a mismatch refuses the package with the connector's id
 * in the sentence — a lookalike host (`api.github-copilot.com`) is exactly the mistake that must not
 * load quietly.
 */
export function parseConnectors(
  document: Record<string, unknown>,
  source = "connectors.yaml",
): PackageConnector[] {
  if (document.connectors === undefined || document.connectors === null) {
    return [];
  }
  const entries = document.connectors;
  if (!Array.isArray(entries)) {
    throw new Error(`${source} connectors must be a list`);
  }
  const connectors: PackageConnector[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source} connector must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`${source} connector.id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(`${source} declares connector "${id}" twice`);
    }
    seen.add(id);
    // `write_tools` is ignored: a package may not reclassify a tool (P3 takes that decision over).
    const urlText = entry.url;
    if (typeof urlText !== "string" || !urlText.trim()) {
      throw new Error(
        `${source} connector "${id}" url must be a non-empty string`,
      );
    }
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new Error(`${source} connector "${id}" url is not a valid URL`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`${source} connector "${id}" url must be https`);
    }
    const host = entry.host;
    if (typeof host !== "string" || !host.trim()) {
      throw new Error(
        `${source} connector "${id}" host must be a non-empty string`,
      );
    }
    if (host !== url.hostname) {
      throw new Error(
        `${source} connector "${id}" host "${host}" does not match its url hostname "${url.hostname}"`,
      );
    }
    const auth = entry.auth;
    if (
      typeof auth !== "string" ||
      !(CONNECTOR_AUTHS as readonly string[]).includes(auth)
    ) {
      throw new Error(
        `${source} connector "${id}" auth must be one of user-oauth, deployment-bearer, none`,
      );
    }
    const credentialEnv = entry.credential_env;
    if (credentialEnv !== undefined && credentialEnv !== null) {
      if (typeof credentialEnv !== "string" || !ENV_NAME.test(credentialEnv)) {
        throw new Error(
          `${source} connector "${id}" credential_env must be the NAME of an environment variable (uppercase letters, digits and underscores)`,
        );
      }
    }
    const docsUrl = entry.docs_url;
    if (docsUrl !== undefined && docsUrl !== null) {
      if (typeof docsUrl !== "string") {
        throw new Error(
          `${source} connector "${id}" docs_url must be a string`,
        );
      }
      let parsedDocs: URL;
      try {
        parsedDocs = new URL(docsUrl);
      } catch {
        throw new Error(
          `${source} connector "${id}" docs_url is not a valid URL`,
        );
      }
      if (parsedDocs.protocol !== "https:") {
        throw new Error(`${source} connector "${id}" docs_url must be https`);
      }
    }
    connectors.push({
      id,
      title:
        typeof entry.title === "string" && entry.title.trim()
          ? entry.title.trim()
          : id,
      vendor:
        typeof entry.vendor === "string" && entry.vendor.trim()
          ? entry.vendor.trim()
          : id,
      url: urlText.trim(),
      host,
      auth: auth as PackageConnectorAuth,
      credentialEnv: typeof credentialEnv === "string" ? credentialEnv : null,
      docsUrl: typeof docsUrl === "string" ? docsUrl : null,
    });
  }
  return connectors;
}

/**
 * Which declared connectors collide with `mcp_servers` rows this package does not own.
 *
 * ASKED IN THE PLATFORM FRAME, before the sync's transaction opens. Row security shows the `system`
 * frame only its own rows, and an administrator's hand-added server is stamped with the frame it was
 * added in — a collision the `system` frame could not see, and one the unique `id` would otherwise
 * turn into a silent skip or a bare SQL error. Refused here, with the id and a way out in the
 * sentence: the deployment does not come up on a package whose connector would fight a row somebody
 * created deliberately.
 */
export async function connectorConflicts(
  database: Pick<Database, "select">,
  connectors: readonly PackageConnector[],
): Promise<{ id: string; addedBy: string | null }[]> {
  const declaredIds = connectors.map(({ id }) => id);
  if (declaredIds.length === 0) return [];
  const rows = await database
    .select({ id: mcpServers.id, addedBy: mcpServers.addedBy })
    .from(mcpServers)
    .where(inArray(mcpServers.id, declaredIds));
  return rows.filter((row) => row.addedBy !== PACKAGE_MARK);
}

/**
 * The credential row for one connector, or null when it is still 待绑定.
 *
 * `credential_env` set in the environment → the value goes into the vault under the SAME key the
 * Plugins screen mints (`kind "mcp"`, keyId `mcp-<id>`), and the row points at it. The value itself
 * touches neither the package nor any log: it is read from the environment here and sealed into the
 * envelope in the same statement that mints it. A live credential for the key is REUSED, never
 * re-sealed — a redeploy that changes nothing would otherwise mint a new envelope on every boot, and
 * "two syncs in a row leave the same rows" is the idempotency this function is written for. A value
 * that later changes needs a deliberate rotate, the way every other deployment credential does.
 *
 * Unset or empty → null, which is how an unbound connector reads on the Plugins page: present,
 * waiting for whoever holds the value. Declared and set but NO vault handed to the sync is refused,
 * because "stored" would be a lie the Plugins page would repeat.
 */
async function connectorCredentialId(
  executor: Pick<Database, "select" | "insert" | "update" | "delete">,
  connector: PackageConnector,
  vault: PackageVault | undefined,
  environment: Record<string, string | undefined>,
): Promise<string | null> {
  const name = connector.credentialEnv;
  if (!name) return null;
  const plaintext = environment[name]?.trim();
  if (!plaintext) return null;
  if (!vault) {
    throw new Error(
      `connector "${connector.id}" names credential_env ${name}, which is set in this environment, but the synchroniser was given no vault to store it in`,
    );
  }
  const key = {
    kind: "mcp" as const,
    provider: connector.id,
    keyId: `mcp-${connector.id}`,
  };
  const live = await vault.credentials.findLiveByKey(key, executor);
  if (live) return live.id;
  const stored = await vault.credentials.create(
    {
      ...key,
      metadata: { server: connector.id },
      seal: (binding) =>
        sealCredential(vault.encryptionKey, binding, plaintext),
    },
    executor,
  );
  return stored.id;
}

/**
 * The package's connectors, written inside the sync transaction.
 *
 * WHY `provenance: "custom"` AND NOT FIRST-PARTY: a first-party row requires a catalogue entry
 * (`requireServer` refuses the alternative), and a package can name a connector the build has never
 * heard of — GitHub happens to be in this build's catalogue, TAPD and WeCom are not. `custom` is the
 * honest provenance for "a URL this deployment reached because a package said so", and every surface
 * that lists custom servers says so.
 *
 * NO MCP GRANT IS SEEDED — deliberately (see `plugins/store.ts`): a grant on a connector reaches the
 * account the deployment holds for it, so seeding one would hand every declared Bot a capability on
 * every boot. The server row is the package's to write; which Bots may call its tools stays with an
 * administrator, exactly as for a connector added by hand.
 *
 * Returns the ids RECYCLED by this call — rows the package owned and no longer declares — so the
 * caller can clear the plain-text refs (`plugin_grants`, `skill_tools`) that do not cascade, in the
 * frame that can see them (see `clearDanglingConnectorRefs`).
 */
export async function synchronizePackageConnectors(
  executor: Pick<Database, "select" | "insert" | "update" | "delete">,
  connectors: readonly PackageConnector[],
  vault: PackageVault | undefined,
  environment: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  for (const connector of connectors) {
    const credentialId = await connectorCredentialId(
      executor,
      connector,
      vault,
      environment,
    );
    await executor
      .insert(mcpServers)
      .values({
        tenantId: SYSTEM_TENANT,
        id: connector.id,
        title: connector.title,
        vendor: connector.vendor,
        url: connector.url,
        provenance: "custom",
        // Stated, not defaulted, so the row reads as the package's wherever it is read.
        addedBy: PACKAGE_MARK,
        ...(credentialId ? { credentialId } : {}),
      })
      .onConflictDoUpdate({
        target: mcpServers.id,
        // The conflict check before the transaction refused rows this package does not own; this is
        // that decision restated on the write, so a row created in between is skipped, not rewritten.
        setWhere: eq(mcpServers.addedBy, PACKAGE_MARK),
        set: {
          title: connector.title,
          vendor: connector.vendor,
          url: connector.url,
          provenance: "custom",
          addedBy: PACKAGE_MARK,
          ...(credentialId ? { credentialId } : {}),
        },
      });
  }

  // A brand that stops declaring a connector takes back its own — and only its own, by the mark.
  // The vault pointer is dropped BEFORE the delete: the column is `restrict`, and a credential the
  // deployment holds stays in the vault (revoke is an operator's act), while a dead server row may
  // not keep pointing at it.
  const recycledPredicate =
    connectors.length > 0
      ? and(
          eq(mcpServers.tenantId, SYSTEM_TENANT),
          eq(mcpServers.addedBy, PACKAGE_MARK),
          notInArray(
            mcpServers.id,
            connectors.map(({ id }) => id),
          ),
        )
      : and(
          eq(mcpServers.tenantId, SYSTEM_TENANT),
          eq(mcpServers.addedBy, PACKAGE_MARK),
        );
  const recycled = await executor
    .update(mcpServers)
    .set({ credentialId: null })
    .where(recycledPredicate)
    .returning({ id: mcpServers.id });
  const recycledIds = recycled.map(({ id }) => id);
  if (recycledIds.length > 0) {
    await executor
      .delete(mcpServers)
      .where(inArray(mcpServers.id, recycledIds));
  }
  return recycledIds;
}

/**
 * Escape the LIKE wildcards (`\`, `%`, `_`) in a connector id.
 *
 * The id is DATA, not a pattern: `clearDanglingConnectorRefs` matches refs by prefix, and an
 * unescaped id turned `_` into a single-character wildcard — recycling `my_app` then deleted
 * `my-app`'s grants too, on every tenant, because the delete runs across the sync's whole database.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The `ref LIKE '<escaped id>/%'` predicate, with an explicit ESCAPE so the escaped wildcards stay
 * literal. Exported beside {@link escapeLikePattern} so tests can pin the rendered SQL without a
 * database.
 */
export function refPrefixPredicate(column: AnyColumn, id: string): SQL {
  return sql`${column} like ${`${escapeLikePattern(id)}/%`} escape '\\'`;
}

/**
 * The plain-text refs a recycled connector leaves behind, cleared in the PLATFORM frame.
 *
 * `plugin_grants.ref` and `skill_tools.ref` are text on purpose (no foreign key — see
 * `skill_tools`), so deleting a server row cascades nothing: a grant naming `github/<tool>` would sit
 * there pointing at a server this deployment no longer has. The rows are stamped with whichever frame
 * granted them, so the `system` frame the sync transaction runs in could not reach the ones it did
 * not write; `platform` can, and this runs after the transaction, on the sync's own database, for
 * exactly the reason the per-person channel writes do.
 */
export async function clearDanglingConnectorRefs(
  database: Pick<Database, "delete">,
  recycledIds: readonly string[],
): Promise<void> {
  if (recycledIds.length === 0) return;
  for (const tableRef of [
    { table: pluginGrants, kind: "mcp" as const },
    { table: skillTools, kind: null },
  ]) {
    for (const id of recycledIds) {
      const predicate = tableRef.kind
        ? and(eq(tableRef.table.kind, tableRef.kind), refPrefixPredicate(tableRef.table.ref, id))
        : refPrefixPredicate(tableRef.table.ref, id);
      await database.delete(tableRef.table).where(predicate);
    }
  }
}

// --------------------------------------------------------------------------------------------------
// 4b-B1: expert teams (`teams.yaml`)

/** One member of a package team. `role` is prose for the lead's prompt, never a table. */
export type PackageTeamMember = {
  id: string;
  role: string | null;
};

/** One hand-off rule: `from` may @ the agents in `to`, which is a `plugin_grants` row of kind `bot`. */
export type PackageTeamAddress = {
  from: string;
  to: string[];
};

/** One expert team a package declares, as `teams.yaml` states it. */
export type PackageTeam = {
  /** The `channels` row id the team materializes into. */
  id: string;
  name: string;
  description: string;
  lead: string;
  members: PackageTeamMember[];
  address: PackageTeamAddress[];
};

/** A team member may name a role; anything longer is a prompt in the wrong file. */
const TEAM_ROLE_CHARS = 40;

/**
 * The teams one package document declares, shape-checked.
 *
 * Absent is a package with no teams — every package written before this contract shipped. Agent
 * references are checked LATER, against the agents the package actually declares (see
 * {@link validateTeamAgentRefs}), because this function sees only `teams.yaml` and the same team may
 * legally name a coworker declared beside it in `agents.yaml`.
 */
export function parseTeams(
  document: Record<string, unknown>,
  source = "teams.yaml",
): PackageTeam[] {
  if (document.teams === undefined || document.teams === null) return [];
  const entries = document.teams;
  if (!Array.isArray(entries)) {
    throw new Error(`${source} teams must be a list`);
  }
  const teams: PackageTeam[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source} team must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`${source} team.id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(`${source} declares team "${id}" twice`);
    }
    seen.add(id);
    const members: PackageTeamMember[] = (
      Array.isArray(entry.members) ? entry.members : []
    ).map((rawMember) => {
      if (
        !rawMember ||
        typeof rawMember !== "object" ||
        Array.isArray(rawMember)
      ) {
        throw new Error(`${source} team "${id}" member must be an object`);
      }
      const member = rawMember as Record<string, unknown>;
      if (typeof member.id !== "string" || !member.id.trim()) {
        throw new Error(
          `${source} team "${id}" member.id must be a non-empty string`,
        );
      }
      const role = member.role;
      if (role !== undefined && role !== null && typeof role !== "string") {
        throw new Error(`${source} team "${id}" member.role must be a string`);
      }
      return {
        id: member.id,
        role:
          typeof role === "string" && role.trim()
            ? [...role.trim()].slice(0, TEAM_ROLE_CHARS).join("")
            : null,
      };
    });
    const memberIds = new Set(members.map(({ id: memberId }) => memberId));
    if (memberIds.size !== members.length) {
      throw new Error(`${source} team "${id}" lists the same member twice`);
    }
    const lead = entry.lead;
    if (typeof lead !== "string" || !lead.trim()) {
      throw new Error(`${source} team "${id}" lead must be a non-empty string`);
    }
    const address: PackageTeamAddress[] = (
      Array.isArray(entry.address) ? entry.address : []
    ).map((rawRule) => {
      if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
        throw new Error(
          `${source} team "${id}" address entry must be an object`,
        );
      }
      const rule = rawRule as Record<string, unknown>;
      if (typeof rule.from !== "string" || !rule.from.trim()) {
        throw new Error(
          `${source} team "${id}" address.from must be a non-empty string`,
        );
      }
      if (!Array.isArray(rule.to) || rule.to.length === 0) {
        throw new Error(
          `${source} team "${id}" address.to must be a non-empty list of agent ids`,
        );
      }
      if (rule.to.some((agentId) => typeof agentId !== "string" || !agentId)) {
        throw new Error(
          `${source} team "${id}" address.to must name agent ids`,
        );
      }
      const targets = [...new Set(rule.to as string[])];
      if (targets.length !== (rule.to as string[]).length) {
        throw new Error(
          `${source} team "${id}" address names the same recipient twice for ${rule.from}`,
        );
      }
      return { from: rule.from, to: targets };
    });
    teams.push({
      id,
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : id,
      description:
        typeof entry.description === "string" ? entry.description.trim() : "",
      lead,
      members,
      address,
    });
  }
  return teams;
}

/**
 * A team's channel, as the ordinary `channels.yaml` machinery expects it.
 *
 * A team IS a channel plus two grants, so it materializes as a channel row under the team's id and
 * rides every path a declared channel already rides: the upsert, the `channel_agents` write, the
 * per-person copies, and the retire sweep when a package stops declaring it. Nothing team-specific
 * is added to any of those paths — that reuse IS the design.
 */
export function teamChannels(teams: readonly PackageTeam[]): {
  id: string;
  name: string;
  description: string;
  permittedAgents: string[];
  allowedGroups: string[];
}[] {
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    description: team.description,
    permittedAgents: [
      ...new Set([team.lead, ...team.members.map(({ id }) => id)]),
    ],
    allowedGroups: [],
  }));
}

/**
 * Every agent id a team names, checked against the agents the package declares.
 *
 * The same rule `channels.yaml` gets, and for the same reason: a team whose members are typos would
 * silently build a channel with nobody in it and a lead whose prompt names coworkers that do not
 * exist — the silent gap package loading refuses everywhere else. The error names the team.
 */
export function validateTeamAgentRefs(
  teams: readonly PackageTeam[],
  declaredAgentIds: ReadonlySet<string>,
): void {
  for (const team of teams) {
    const named = [team.lead, ...team.members.map(({ id }) => id)];
    for (const rule of team.address) named.push(rule.from, ...rule.to);
    for (const agentId of new Set(named)) {
      if (!declaredAgentIds.has(agentId)) {
        throw new Error(
          `team "${team.id}" references unknown agent "${agentId}"`,
        );
      }
    }
  }
}

/**
 * The lead's `system_prompt`, with the team appended.
 *
 * The prompt is where the lead learns WHO it leads and HOW work moves: the members with their roles,
 * and the hand-off rule — @ a member with the request, take the result back, and do not invent a
 * member's completion. Only built-in leads are touched (a remote lead runs on its own server and has
 * no `system_prompt` here to append to); a package with no teams changes nothing, and the author's
 * text stays byte-identical above the separator.
 */
export function teamLeadPrompts<
  AgentShape extends {
    id: string;
    type: string;
    configuration: Record<string, unknown>;
  },
>(agents: readonly AgentShape[], teams: readonly PackageTeam[]): AgentShape[] {
  if (teams.length === 0) return [...agents];
  const ledBy = new Map<string, PackageTeam[]>();
  for (const team of teams) {
    ledBy.set(team.lead, [...(ledBy.get(team.lead) ?? []), team]);
  }
  return agents.map((agent) => {
    const teamsLed = ledBy.get(agent.id);
    if (!teamsLed || agent.type !== "built_in") return agent;
    const systemPrompt = agent.configuration.systemPrompt;
    if (typeof systemPrompt !== "string") return agent;
    return {
      ...agent,
      configuration: {
        ...agent.configuration,
        systemPrompt: [
          systemPrompt,
          ...teamsLed.map((team) =>
            [
              "---",
              `你的团队（${team.name}）：`,
              ...team.members.map(
                ({ id, role }) => `- ${id}${role ? `（${role}）` : ""}`,
              ),
              "交接规则：需要成员做的事，直接 @ 成员的 id 并把要求写清；成员完成后会回报，由你汇总与把关。不要替成员编造结果，成员没有响应时如实告诉用户。",
            ].join("\n"),
          ),
        ].join("\n\n"),
      },
    };
  });
}

/**
 * The team's bot-to-bot grants, written inside the sync transaction.
 *
 * DIRECTION IS THE CONTRACT (verified against the only reader): a row says `from` may reach `to`,
 * and `botsReachableFrom` reads it as agentId = the initiator, ref = the recipient. A row reversed is
 * a member who can summon its lead and a lead who cannot dispatch — so the test asserts the columns
 * by name, not just the row count.
 *
 * Replaced wholesale under the package's mark, like the skill grants: every `kind = 'bot'` grant the
 * package made last time is removed first, so a team whose hand-off changed takes the old rows back.
 * Nothing else writes this kind with this mark, so the sweep cannot reach a grant a person or an
 * administrator made.
 */
export async function synchronizeTeamGrants(
  executor: Pick<Database, "delete" | "insert">,
  teams: readonly PackageTeam[],
): Promise<void> {
  await executor
    .delete(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "bot"),
        eq(pluginGrants.grantedBy, PACKAGE_MARK),
      ),
    );
  const pairs = teams.flatMap((team) =>
    team.address.flatMap((rule) =>
      rule.to.map((to) => ({ agentId: rule.from, ref: to })),
    ),
  );
  if (pairs.length > 0) {
    // A grant an administrator happened to make for the same pair keeps their credit: the package
    // adds what is missing and retracts only what it wrote, exactly as the skill grants do.
    await executor
      .insert(pluginGrants)
      .values(
        pairs.map((pair) => ({
          kind: "bot" as const,
          ref: pair.ref,
          agentId: pair.agentId,
          grantedBy: PACKAGE_MARK,
          tenantId: SYSTEM_TENANT,
        })),
      )
      .onConflictDoNothing();
  }
}
