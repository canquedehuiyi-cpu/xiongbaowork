import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { portraitMedia, portraits, wakerGroups } from "../db/schema";
import type { PortraitContentType } from "./image";
import type { PortraitVideoContentType } from "./video";

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
  // 宝小熊的 45 个角色脸 (migration 0204): one ready-made face per role, stored by its slug
  // exactly like an expression is; the picture itself lives in the app bundle.
  "doctor",
  "teacher",
  "chef",
  "tech-engineer",
  "financial-advisor",
  "lawyer",
  "construction-engineer",
  "farmer",
  "courier",
  "pilot",
  "firefighter",
  "tour-guide",
  "journalist",
  "creative-designer",
  "fitness-coach",
  "general-manager",
  "accountant",
  "operations-director",
  "designer",
  "director",
  "programmer",
  "social-media-operator",
  "actor",
  "singer",
  "product-manager",
  "data-analyst",
  "marketing-director",
  "hr-manager",
  "legal-advisor",
  "customer-service-manager",
  "founder-assistant",
  "project-manager",
  "admin-specialist",
  "sales-consultant",
  "business-development",
  "customer-success",
  "copywriter",
  "brand-planner",
  "ad-specialist",
  "store-manager",
  "live-stream-operator",
  "private-domain-operator",
  "automation-engineer",
  "test-engineer",
  "security-officer",
] as const;
export type PortraitPreset = (typeof PORTRAIT_PRESETS)[number];

/** 宝小熊的五套服装（migration 0203）。按服装出图是第二批；第一批只存这个字段。 */
export const PORTRAIT_OUTFITS = [
  "street",
  "guofeng",
  "casual",
  "tech",
  "lion",
] as const;
export type PortraitOutfit = (typeof PORTRAIT_OUTFITS)[number];

/** What a list carries: which face, never the picture's bytes. */
export type PortraitSummary = {
  kind: PortraitKind;
  id: string;
  preset: PortraitPreset | null;
  hasImage: boolean;
  /** The 宝小熊 outfit worn with this face, or null when none was picked. */
  outfit: PortraitOutfit | null;
  /** Whether somebody uploaded a video loop for this face. */
  hasVideo: boolean;
  /** When that video was last replaced, for the version on its URL; null when there is none. */
  videoUpdatedAt: Date | null;
  updatedAt: Date;
};

export type PortraitImage = {
  contentType: PortraitContentType;
  bytes: Uint8Array;
  updatedAt: Date;
};

/** An uploaded video loop: the face's picture is its poster. */
export type PortraitVideo = {
  contentType: PortraitVideoContentType;
  bytes: Uint8Array;
  updatedAt: Date;
};

export type PortraitChoice =
  | { preset: PortraitPreset }
  | { image: { contentType: PortraitContentType; bytes: Uint8Array } };

export type PortraitStore = {
  list(): Promise<PortraitSummary[]>;
  /** One face, or null when nobody chose one. */
  get(kind: PortraitKind, id: string): Promise<PortraitSummary | null>;
  image(kind: PortraitKind, id: string): Promise<PortraitImage | null>;
  set(
    kind: PortraitKind,
    id: string,
    choice: PortraitChoice,
    updatedBy: string,
    outfit?: PortraitOutfit | null,
  ): Promise<PortraitSummary>;
  remove(kind: PortraitKind, id: string): Promise<boolean>;
  /** The uploaded video loop for this face, if somebody uploaded one. */
  media(kind: PortraitKind, id: string): Promise<PortraitVideo | null>;
  setMedia(
    kind: PortraitKind,
    id: string,
    video: { contentType: PortraitVideoContentType; bytes: Uint8Array },
    updatedBy: string,
  ): Promise<PortraitVideo>;
  removeMedia(kind: PortraitKind, id: string): Promise<boolean>;
  /** Whether this workspace has a group by that id: a face is only kept for something that exists. */
  groupExists(id: string): Promise<boolean>;
};

export function createPortraitStore(database: Database): PortraitStore {
  const summary = {
    kind: portraits.subjectKind,
    id: portraits.subjectId,
    preset: portraits.preset,
    outfit: portraits.outfit,
    hasImage: sql<boolean>`${portraits.bytes} IS NOT NULL`,
    updatedAt: portraits.updatedAt,
  };
  const shape = (
    row: {
      kind: string;
      id: string;
      preset: string | null;
      outfit: string | null;
      hasImage: boolean;
      updatedAt: Date;
    },
    videoUpdatedAt: Date | null,
  ): PortraitSummary => ({
    kind: row.kind as PortraitKind,
    id: row.id,
    preset: row.preset as PortraitPreset | null,
    outfit: row.outfit as PortraitOutfit | null,
    hasImage: row.hasImage,
    hasVideo: videoUpdatedAt !== null,
    videoUpdatedAt,
    updatedAt: row.updatedAt,
  });
  const subject = (kind: PortraitKind, id: string) =>
    and(eq(portraits.subjectKind, kind), eq(portraits.subjectId, id));
  const mediaSubject = (kind: PortraitKind, id: string) =>
    and(
      eq(portraitMedia.subjectKind, kind),
      eq(portraitMedia.subjectId, id),
    );
  async function mediaUpdatedAt(
    kind: PortraitKind,
    id: string,
  ): Promise<Date | null> {
    const [row] = await database
      .select({ updatedAt: portraitMedia.updatedAt })
      .from(portraitMedia)
      .where(mediaSubject(kind, id))
      .limit(1);
    return row?.updatedAt ?? null;
  }

  return {
    async list() {
      const [rows, mediaRows] = await Promise.all([
        database
          .select(summary)
          .from(portraits)
          .orderBy(asc(portraits.subjectKind), asc(portraits.subjectId)),
        database
          .select({
            kind: portraitMedia.subjectKind,
            id: portraitMedia.subjectId,
            updatedAt: portraitMedia.updatedAt,
          })
          .from(portraitMedia),
      ]);
      const mediaBySubject = new Map(
        mediaRows.map((row) => [`${row.kind}:${row.id}`, row.updatedAt]),
      );
      return rows.map((row) =>
        shape(row, mediaBySubject.get(`${row.kind}:${row.id}`) ?? null),
      );
    },

    async get(kind, id) {
      const [row] = await database
        .select(summary)
        .from(portraits)
        .where(subject(kind, id))
        .limit(1);
      if (!row) return null;
      return shape(row, await mediaUpdatedAt(kind, id));
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

    async set(kind, id, choice, updatedBy, outfit) {
      const values =
        "preset" in choice
          ? { preset: choice.preset, contentType: null, bytes: null }
          : {
              preset: null,
              contentType: choice.image.contentType,
              bytes: Buffer.from(choice.image.bytes),
            };
      // An outfit is only worn with a face; without one there is nowhere to put it.
      const outfitValues = outfit === undefined ? {} : { outfit };
      const [row] = await database
        .insert(portraits)
        .values({
          subjectKind: kind,
          subjectId: id,
          updatedBy,
          ...values,
          ...outfitValues,
        })
        .onConflictDoUpdate({
          target: [
            portraits.tenantId,
            portraits.subjectKind,
            portraits.subjectId,
          ],
          set: { ...values, ...outfitValues, updatedBy, updatedAt: sql`now()` },
        })
        .returning(summary);
      if (!row) throw new Error("The portrait was not saved.");
      return shape(row, await mediaUpdatedAt(kind, id));
    },

    async remove(kind, id) {
      const removed = await database
        .delete(portraits)
        .where(subject(kind, id))
        .returning({ id: portraits.subjectId });
      return removed.length > 0;
    },

    async media(kind, id) {
      const [row] = await database
        .select({
          contentType: portraitMedia.contentType,
          bytes: portraitMedia.bytes,
          updatedAt: portraitMedia.updatedAt,
        })
        .from(portraitMedia)
        .where(mediaSubject(kind, id))
        .limit(1);
      if (!row?.bytes || !row.contentType) return null;
      return {
        contentType: row.contentType as PortraitVideoContentType,
        bytes: new Uint8Array(row.bytes),
        updatedAt: row.updatedAt,
      };
    },

    async setMedia(kind, id, video, updatedBy) {
      const [row] = await database
        .insert(portraitMedia)
        .values({
          subjectKind: kind,
          subjectId: id,
          contentType: video.contentType,
          bytes: Buffer.from(video.bytes),
          updatedBy,
        })
        .onConflictDoUpdate({
          target: [
            portraitMedia.tenantId,
            portraitMedia.subjectKind,
            portraitMedia.subjectId,
          ],
          set: {
            contentType: video.contentType,
            bytes: Buffer.from(video.bytes),
            updatedBy,
            updatedAt: sql`now()`,
          },
        })
        .returning({
          contentType: portraitMedia.contentType,
          bytes: portraitMedia.bytes,
          updatedAt: portraitMedia.updatedAt,
        });
      if (!row?.bytes || !row.contentType) {
        throw new Error("The portrait video was not saved.");
      }
      return {
        contentType: row.contentType as PortraitVideoContentType,
        bytes: new Uint8Array(row.bytes),
        updatedAt: row.updatedAt,
      };
    },

    async removeMedia(kind, id) {
      const removed = await database
        .delete(portraitMedia)
        .where(mediaSubject(kind, id))
        .returning({ id: portraitMedia.subjectId });
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
