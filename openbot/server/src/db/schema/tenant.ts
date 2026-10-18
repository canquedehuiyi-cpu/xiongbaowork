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
 * The default reads the session's tenant, so an insert that names no tenant lands in the tenant
 * the connection is running as -- which the database client sets from AsyncLocalStorage on every
 * query. A connection with no context runs as `system`, the platform's own tenant.
 */
export const tenantId = () =>
  text("tenant_id")
    .notNull()
    .default(sql`current_setting('app.tenant_id', true)`);
