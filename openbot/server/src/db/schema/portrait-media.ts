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
 * A portrait's video loop (migration 0203): the short MP4 or WebM somebody uploaded for a coworker
 * (员工) or a group (群组), played over the face that `portraits` holds for them.
 *
 * WHY A SEPARATE TABLE. A video does not fit the picture row's rules: `portraits.bytes` is capped
 * at 256 KiB and its `portraits_one_choice` check forces exactly one of a preset or a picture, so
 * a loop stored there would either break the cap or evict the poster. Here a loop is one row per
 * subject, at most 2 MiB, MP4 or WebM only, read from its magic number by the route. The picture
 * stays the poster: a list draws it, and the video only plays where a motion state is active.
 *
 * WHOSE IT IS. Keyed by the subject, not by a foreign key, like `portraits` itself: the route
 * checks the subject exists and that the caller may change it before writing, and clearing the
 * face clears its loop too, so a loop never outlives its poster.
 */
export const portraitMedia = pgTable(
  "portrait_media",
  {
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "portrait_media_pkey",
      columns: [table.tenantId, table.subjectKind, table.subjectId],
    }),
    check(
      "portrait_media_subject_kind",
      sql`${table.subjectKind} IN ('coworker', 'group')`,
    ),
    check(
      "portrait_media_subject_id_length",
      sql`char_length(${table.subjectId}) BETWEEN 1 AND 200`,
    ),
    check(
      "portrait_media_content_type",
      sql`${table.contentType} IN ('video/mp4', 'video/webm')`,
    ),
    check(
      "portrait_media_bytes_size",
      sql`octet_length(${table.bytes}) <= 2097152`,
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
