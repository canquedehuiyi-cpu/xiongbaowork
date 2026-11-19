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
import { tenantId } from "./tenant";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * A picture or a video a coworker generated (`generate_image`, `generate_video`; migration 0230).
 *
 * WHERE THE FILE LIVES. Here, in the deployment, and served at `/api/media/:id` to whoever is signed
 * in as the tenant it was made for: the person whose turn asked for it. A provider's own link is
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
      using: tenantScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: tenantScope,
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
