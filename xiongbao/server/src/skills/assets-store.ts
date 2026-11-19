import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { skillAssets } from "../db/schema";

/**
 * Reading a skill's attached files out of the database (4c-C2).
 *
 * The store half of the `skills` builtin server. Package sync writes the rows
 * (`tenant-package-capabilities.ts`); this module is what the read tools call, so the one query that
 * turns a skill id into its files lives in exactly one place. Every read is a plain SELECT over
 * `skill_assets`, whose row-level security admits `system` rows — where the sync writes them — to
 * every frame, so a Bot running in a person's partition reads its deployment's files the same way it
 * reads the deployment's catalogue.
 *
 * Authorization is NOT here. Listing or reading by itself answers no question a grant has not already
 * answered: the caller (the builtin transport, and behind it the plugin call path) decides whether
 * this Bot may touch this skill, and `read-tool.ts` re-checks that per call. Keeping the check out of
 * the store keeps the store answerable to tests that only ask what is on file.
 */

/** What a listing shows: the file's name, type and size, never its content. */
export type SkillAssetMeta = {
  path: string;
  mediaType: string;
  bytes: number;
};

/**
 * The two read tools' names, defined HERE rather than in `read-tool.ts` because the catalogue reads
 * them at import time and `read-tool` reaches `plugins/mcp`, which reaches the catalogue: a constant
 * both ends of that cycle need has to live below it. One list for the transport, the catalogue's read
 * review and the tests, so the three cannot drift apart.
 */
export const SKILL_ASSET_TOOL_NAMES = [
  "list_skill_assets",
  "read_skill_asset",
] as const;

/** A listing entry plus the body, which only `readSkillAsset` returns. */
export type SkillAsset = SkillAssetMeta & { content: string };

/** The attachments one skill ships, ordered by path so a manifest is stable across redeploys. */
export async function listSkillAssets(
  database: Database,
  skillId: string,
): Promise<SkillAssetMeta[]> {
  const rows = await database
    .select({
      path: skillAssets.path,
      mediaType: skillAssets.mediaType,
      bytes: skillAssets.bytes,
    })
    .from(skillAssets)
    .where(eq(skillAssets.skillId, skillId))
    .orderBy(asc(skillAssets.path));
  return rows;
}

/** One file by name, or null when the skill does not ship it. */
export async function readSkillAsset(
  database: Database,
  skillId: string,
  path: string,
): Promise<SkillAsset | null> {
  const [row] = await database
    .select({
      path: skillAssets.path,
      mediaType: skillAssets.mediaType,
      bytes: skillAssets.bytes,
      content: skillAssets.content,
    })
    .from(skillAssets)
    .where(and(eq(skillAssets.skillId, skillId), eq(skillAssets.path, path)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether one relative path stays inside the skill directory it names.
 *
 * Shared by the package loader — which refuses a package declaring a path that escapes — and by the
 * read tool, which refuses a model asking for one. The rules are the same both places on purpose: a
 * path accepted here is a path `skills/<slug>/<path>` can be resolved to without leaving the skill.
 * An absolute path, a Windows drive, a `..` segment and a backslash (Windows' other separator, so a
 * package author cannot smuggle one past a POSIX check) are all refused; so is an empty path.
 */
export function isSafeSkillAssetPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}
