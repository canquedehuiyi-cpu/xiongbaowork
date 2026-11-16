import { sql } from "drizzle-orm";
import {
  check,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/*
 * Who may read a listing, and who may write one (recovery overlay 0118).
 *
 * A listing is the platform's catalogue, so every workspace reads it: the 装配页 has to know what an
 * owner may install. Only the platform frame writes it. No write clause names 'system' as a row a
 * session may reach, so no tenant writer (and no unscoped `system` connection) can create, rewrite or
 * delete a listing; the CHECK constraint below is what keeps every row stamped 'system'.
 */
const readScope = sql`tenant_id = 'system'`;
const writeScope = sql`current_setting('app.tenant_id', true) = 'platform'`;

/**
 * Spec E3 / D11: an administrator lists (上架) a catalogue entry, and from then on the owner of a Waker
 * may install it on that Waker and uninstall it again without asking anybody.
 *
 * `ref` is the catalogue key: an app's key for `mcp` (a grant names `<key>/<tool>`), a deployment
 * skill's slug for `skill`. `tenant_id` has no default: the store stamps `system` explicitly, under
 * the platform frame, so a listing can never land in whatever tenant a connection was running as.
 */
export const pluginInstallListings = pgTable(
  "plugin_install_listings",
  {
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    listedBy: text("listed_by").notNull(),
    listedAt: timestamp("listed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.ref] }),
    check(
      "plugin_install_listings_tenant_check",
      sql`${table.tenantId} = 'system'`,
    ),
    check(
      "plugin_install_listings_kind_check",
      sql`${table.kind} IN ('mcp', 'skill')`,
    ),
    check(
      "plugin_install_listings_ref_check",
      sql`length(${table.ref}) > 0 AND ${table.ref} = btrim(${table.ref})`,
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
      using: writeScope,
      withCheck: writeScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: writeScope,
    }),
  ],
).enableRLS();

export type InstallListingKind = "mcp" | "skill";
