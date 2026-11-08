import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { portraits, wakerGroups } from "../db/schema";
import type { PortraitContentType } from "./image";

/**
 * 头像 storage: one row per coworker or group that somebody gave a face (migration 0144).
 *
 * Every read and write runs in the caller's tenant frame, which the auth middleware set, so row
 * security decides what is visible and nothing here names a tenant to stay inside one.
 */
export type PortraitKind = "coworker" | "group";

export const PORTRAIT_PRESETS = [
  "naughty",
  "cute",
  "cool",
  "happy",
  "sweet",
] as const;
export type PortraitPreset = (typeof PORTRAIT_PRESETS)[number];

/** What a list carries: which face, never the picture's bytes. */
export type PortraitSummary = {
  kind: PortraitKind;
  id: string;
  preset: PortraitPreset | null;
  hasImage: boolean;
  updatedAt: Date;
};

export type PortraitImage = {
  contentType: PortraitContentType;
  bytes: Uint8Array;
  updatedAt: Date;
};

export type PortraitChoice =
  | { preset: PortraitPreset }
  | { image: { contentType: PortraitContentType; bytes: Uint8Array } };

export type PortraitStore = {
  list(): Promise<PortraitSummary[]>;
  image(kind: PortraitKind, id: string): Promise<PortraitImage | null>;
  set(
    kind: PortraitKind,
    id: string,
    choice: PortraitChoice,
    updatedBy: string,
  ): Promise<PortraitSummary>;
  remove(kind: PortraitKind, id: string): Promise<boolean>;
  /** Whether this workspace has a group by that id: a face is only kept for something that exists. */
  groupExists(id: string): Promise<boolean>;
};

export function createPortraitStore(database: Database): PortraitStore {
  const summary = {
    kind: portraits.subjectKind,
    id: portraits.subjectId,
    preset: portraits.preset,
    hasImage: sql<boolean>`${portraits.bytes} IS NOT NULL`,
    updatedAt: portraits.updatedAt,
  };
  const shape = (row: {
    kind: string;
    id: string;
    preset: string | null;
    hasImage: boolean;
    updatedAt: Date;
  }): PortraitSummary => ({
    kind: row.kind as PortraitKind,
    id: row.id,
    preset: row.preset as PortraitPreset | null,
    hasImage: row.hasImage,
    updatedAt: row.updatedAt,
  });
  const subject = (kind: PortraitKind, id: string) =>
    and(eq(portraits.subjectKind, kind), eq(portraits.subjectId, id));

  return {
    async list() {
      const rows = await database
        .select(summary)
        .from(portraits)
        .orderBy(asc(portraits.subjectKind), asc(portraits.subjectId));
      return rows.map(shape);
    },

    async image(kind, id) {
      const [row] = await database
        .select({
          contentType: portraits.contentType,
          bytes: portraits.bytes,
          updatedAt: portraits.updatedAt,
        })
        .from(portraits)
        .where(subject(kind, id))
        .limit(1);
      if (!row?.bytes || !row.contentType) return null;
      return {
        contentType: row.contentType as PortraitContentType,
        bytes: new Uint8Array(row.bytes),
        updatedAt: row.updatedAt,
      };
    },

    async set(kind, id, choice, updatedBy) {
      const values =
        "preset" in choice
          ? { preset: choice.preset, contentType: null, bytes: null }
          : {
              preset: null,
              contentType: choice.image.contentType,
              bytes: Buffer.from(choice.image.bytes),
            };
      const [row] = await database
        .insert(portraits)
        .values({ subjectKind: kind, subjectId: id, updatedBy, ...values })
        .onConflictDoUpdate({
          target: [
            portraits.tenantId,
            portraits.subjectKind,
            portraits.subjectId,
          ],
          set: { ...values, updatedBy, updatedAt: sql`now()` },
        })
        .returning(summary);
      if (!row) throw new Error("The portrait was not saved.");
      return shape(row);
    },

    async remove(kind, id) {
      const removed = await database
        .delete(portraits)
        .where(subject(kind, id))
        .returning({ id: portraits.subjectId });
      return removed.length > 0;
    },

    async groupExists(id) {
      // A group id is a uuid; anything else names no group, and asking would be a database error.
      if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
      const [row] = await database
        .select({ id: wakerGroups.id })
        .from(wakerGroups)
        .where(eq(wakerGroups.id, id))
        .limit(1);
      return row !== undefined;
    },
  };
}
