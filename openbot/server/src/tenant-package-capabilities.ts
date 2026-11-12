import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "./db/client";
import { skillAssets } from "./db/schema";
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
