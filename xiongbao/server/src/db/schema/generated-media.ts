import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { channels } from "./core";
import { tenantId } from "./tenant";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/* The platform's frame alone. */
const platformScope = sql`current_setting('app.tenant_id', true) = 'platform'`;

/*
 * A shared group's own test: the frame's person is in the channel now. Migration 0231 spells it with
 * the function every group row uses (0122, a membership check run as the definer); it is written out
 * here as the membership lookup that function makes, and false once the membership row is gone.
 */
const inChannel = sql`EXISTS (SELECT 1 FROM public.channel_memberships m WHERE m.channel_id = generated_media.channel_id AND m.tenant_id = 'team' AND m.user_id = current_setting('app.tenant_id', true))`;

/*
 * Who reads a row (0231). One made in a chat of one (no channel) is read by the person it was made for.
 * One made in a shared group is read by whoever is in the group now, whichever tenant it was stamped
 * with, and by nobody who is not, the person who made it included once they have left.
 */
const readScope = sql`${platformScope} OR (channel_id IS NULL AND tenant_id = current_setting('app.tenant_id', true)) OR (channel_id IS NOT NULL AND ${inChannel})`;

/* A row may be filed into a group only by somebody in it. */
const writeScope = sql`(${tenantScope}) AND (channel_id IS NULL OR ${platformScope} OR ${inChannel})`;

/**
 * A picture or a video a coworker generated (`generate_image`, `generate_video`; migration 0230).
 *
 * WHERE THE FILE LIVES. Here, in the deployment, and served at `/api/media/:id` to the person whose
 * turn asked for it, and, for one made in a shared group, to everyone in the group now (`channel_id`,
 * migration 0231; row security does the asking, with the function every group row uses). A provider's own link is
 * temporary and on somebody else's CDN, and a coworker's computer may not exist at all, so neither is
 * a place a picture the chat shows can be kept.
 *
 * WHAT IS KEPT. The bytes, what they are (read from their magic number, never from the provider's
 * word, because the route serves this as `Content-Type`), the coworker that made it and the prompt it
 * was made from (for the person and for a later gallery). Capped at 50 MiB a row, the video limit.
 */
export const generatedMedia = pgTable(
  "generated_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    bytes: bytea("bytes").notNull(),
    prompt: text("prompt").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** The shared group it was made in, or null for a chat of one: who else may read it. */
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("generated_media_tenant_idx").on(
      table.tenantId,
      table.agentId,
      table.createdAt,
    ),
    index("generated_media_channel_idx")
      .on(table.channelId)
      .where(sql`${table.channelId} IS NOT NULL`),
    check("generated_media_kind", sql`${table.kind} IN ('image', 'video')`),
    check(
      "generated_media_mime_type",
      sql`${table.mimeType} IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm')`,
    ),
    check(
      "generated_media_bytes_size",
      sql`octet_length(${table.bytes}) <= 52428800 AND ${table.sizeBytes} = octet_length(${table.bytes})`,
    ),
    check(
      "generated_media_prompt_length",
      sql`char_length(${table.prompt}) <= 4000`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "select",
      to: "public",
      using: readScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: writeScope,
    }),
    pgPolicy("tenant_isolation_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: tenantScope,
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: tenantScope,
    }),
  ],
);
