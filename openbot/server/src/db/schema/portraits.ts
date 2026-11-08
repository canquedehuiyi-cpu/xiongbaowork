import { sql } from "drizzle-orm";
import {
  check,
  customType,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantId } from "./tenant";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/* The two scopes every tenant table has had since 0072: the owner's frame, and the platform's. */
const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * 头像: the picture somebody chose for a coworker (员工) or a group (群组), drawn in place of the
 * abstract face its seed makes (recovery overlay 0144).
 *
 * Called a portrait because "avatar" in this schema already means a person's 分身.
 *
 * WHAT A ROW IS. Exactly one of: one of 熊宝's five expressions (`preset`), or a picture somebody
 * uploaded (`bytes` with its sniffed `content_type`). No row is the default face. A picture is a
 * small raster the browser has already squared and re-encoded; the database refuses anything over
 * 256 KiB and any type but PNG, JPEG, WebP and GIF, so a portrait can never be an SVG document.
 *
 * WHOSE IT IS. Keyed by the subject, not by a foreign key: a coworker id lives in `agents` and a group
 * id in `waker_groups`, and one table serves both. The route checks the subject exists and that the
 * caller may change it before writing; removing a coworker or a group leaves at most one small row
 * nothing draws.
 */
export const portraits = pgTable(
  "portraits",
  {
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    preset: text("preset"),
    contentType: text("content_type"),
    bytes: bytea("bytes"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "portraits_pkey",
      columns: [table.tenantId, table.subjectKind, table.subjectId],
    }),
    check(
      "portraits_subject_kind",
      sql`${table.subjectKind} IN ('coworker', 'group')`,
    ),
    check(
      "portraits_subject_id_length",
      sql`char_length(${table.subjectId}) BETWEEN 1 AND 200`,
    ),
    check(
      "portraits_preset",
      sql`${table.preset} IS NULL OR ${table.preset} IN ('naughty', 'cute', 'cool', 'happy', 'sweet')`,
    ),
    check(
      "portraits_content_type",
      sql`${table.contentType} IS NULL OR ${table.contentType} IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    ),
    check(
      "portraits_one_choice",
      sql`(${table.preset} IS NOT NULL AND ${table.bytes} IS NULL AND ${table.contentType} IS NULL) OR (${table.preset} IS NULL AND ${table.bytes} IS NOT NULL AND ${table.contentType} IS NOT NULL)`,
    ),
    check(
      "portraits_bytes_size",
      sql`${table.bytes} IS NULL OR octet_length(${table.bytes}) <= 262144`,
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
