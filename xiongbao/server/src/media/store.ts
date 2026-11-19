/**
 * The pictures and videos coworkers generated, kept in `generated_media` (migration 0230).
 *
 * In the caller's tenant frame, always: the tools save inside `runAsTenant(<the turn's person>)` and
 * the route reads inside the signed-in person's own frame (`requireUser`), so row security is what
 * keeps one person's pictures from another's. Nothing here takes a tenant argument to get wrong.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { generatedMedia } from "../db/schema";

export type MediaKind = "image" | "video";

export type StoredMedia = {
  mimeType: string;
  bytes: Uint8Array;
  kind: MediaKind;
};

export type MediaStore = {
  save(file: {
    agentId: string;
    kind: MediaKind;
    mimeType: string;
    bytes: Uint8Array;
    prompt: string;
    provider: string;
    model: string;
  }): Promise<string>;
  /** The file, in the caller's frame; null for one that is not there or not theirs. */
  read(id: string): Promise<StoredMedia | null>;
};

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prompt as the column keeps it: at most 4000 characters. */
const PROMPT_LIMIT = 4000;

export function createMediaStore(database: Database): MediaStore {
  return {
    async save(file) {
      const [row] = await database
        .insert(generatedMedia)
        .values({
          agentId: file.agentId,
          kind: file.kind,
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          bytes: Buffer.from(file.bytes),
          prompt: file.prompt.slice(0, PROMPT_LIMIT),
          provider: file.provider,
          model: file.model,
        })
        .returning({ id: generatedMedia.id });
      if (!row) throw new Error("generated_media insert returned no row");
      return row.id;
    },
    async read(id) {
      // Text that is not uuid-shaped would make Postgres raise rather than match nothing.
      if (!UUID_SHAPE.test(id)) return null;
      const [row] = await database
        .select({
          mimeType: generatedMedia.mimeType,
          bytes: generatedMedia.bytes,
          kind: generatedMedia.kind,
        })
        .from(generatedMedia)
        .where(eq(generatedMedia.id, id))
        .limit(1);
      if (!row) return null;
      return {
        mimeType: row.mimeType,
        bytes: new Uint8Array(row.bytes),
        kind: row.kind as MediaKind,
      };
    },
  };
}
