/**
 * The pictures and videos coworkers generated, kept in `generated_media` (migration 0230).
 *
 * In the caller's tenant frame, always: the tools save inside `runAsTenant(<the turn's person>)` and
 * the route reads inside the signed-in person's own frame (`requireUser`), so row security is what
 * keeps one person's pictures from another's. Nothing here takes a tenant argument to get wrong.
 *
 * A file made in a shared group carries that group's `channel_id` (migration 0231), and row security
 * then lets everyone in the group read it and nobody else, the same test every group row uses.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelMemberships,
  channels,
  generatedMedia,
  groupBotThreads,
} from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";

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
    /** The shared group it is made in, so the group reads it; absent for a chat of one. */
    channelId?: string;
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
          ...(file.channelId ? { channelId: file.channelId } : {}),
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

/**
 * The shared group a Bot's thread belongs to, for the person whose turn it is: asked in their own
 * frame, answering only while they are still in the group. Null for a thread that is not a group's
 * (a chat of one), a group that is not shared (only its maker is in it), or one they have left.
 */
export function mediaChannelOf(database: Database) {
  return async (
    ownerUserId: string,
    agentId: string,
    threadId: string,
  ): Promise<string | null> => {
    const [row] = await database
      .select({ channelId: groupBotThreads.channelId })
      .from(groupBotThreads)
      .innerJoin(channels, eq(channels.id, groupBotThreads.channelId))
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, groupBotThreads.channelId),
          eq(channelMemberships.userId, ownerUserId),
          eq(channelMemberships.tenantId, TEAM_TENANT),
        ),
      )
      .where(
        and(
          eq(groupBotThreads.threadId, threadId),
          eq(groupBotThreads.ownerUserId, ownerUserId),
          eq(groupBotThreads.agentId, agentId),
          eq(channels.tenantId, TEAM_TENANT),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    return row?.channelId ?? null;
  };
}
