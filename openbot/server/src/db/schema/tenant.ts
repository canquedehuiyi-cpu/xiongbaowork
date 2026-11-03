import { sql } from "drizzle-orm";
import { text } from "drizzle-orm/pg-core";

/**
 * The tenant that owns a row. Tenants are 1:1 with users today (spec decision D12), so the value
 * equals the owning user's id; the separate column exists so the team-upgrade later moves the
 * mapping without touching a single query. Ids are text because Better Auth's are.
 *
 * The constant `system` names the platform's own tenant: catalogue rows, deployment skills and
 * anything the vendor stands behind. RLS lets a reader see its own tenant or `system`, never
 * another tenant's.
 *
 * The API layer sets `app.tenant_id` per transaction and background workers set it per claimed
 * row; the policy compares. No tenant-scoped table may be read without the GUC set.
 */
export const SYSTEM_TENANT = "system";

/**
 * Background work and admin questions that span tenants run as `platform`: a frame that belongs to
 * nobody and may read across tenants, never a stamp a person's row carries.
 */
export const PLATFORM_TENANT = "platform";

/**
 * The shared tenant (G01-E): rows that belong to the team as a whole -- governance, shared Bots,
 * group conversations. It is a stamp only, never a frame: nobody acts as `team`, and the tenant
 * context refuses to open one. Who may read or write a `team` row is decided by the row's own
 * ownership predicate, evaluated in the person frame of whoever asks.
 */
export const TEAM_TENANT = "team";

/** Tenants that name nobody: no person acts as one, and work stamped with one has no owner. */
export const NOBODY_TENANTS = [
  SYSTEM_TENANT,
  PLATFORM_TENANT,
  TEAM_TENANT,
] as const;

/**
 * The default reads the session's tenant, so an insert that names no tenant lands in the tenant
 * the connection is running as -- which the database client sets from AsyncLocalStorage on every
 * query. A connection with no context runs as `system`, the platform's own tenant.
 */
export const tenantId = () =>
  text("tenant_id")
    .notNull()
    .default(sql`current_setting('app.tenant_id', true)`);
