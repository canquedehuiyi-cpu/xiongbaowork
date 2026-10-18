import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  revokedAccess,
  routines,
  sessions,
  subscriptions,
  users,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";

/**
 * The operator's view of the tenants this deployment serves, and the two
 * levers over one: suspend (sign-in blocked, sessions dropped, scheduled work
 * frozen) and restore. Reads run under the `platform` session tenant, which
 * the RLS policies admit in full; the routes that call these check `admin`
 * first, and nothing else in the product ever sets that scope.
 */
export type TenantRow = {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  wakers: number;
  activeRoutines: number;
  suspended: boolean;
  createdAt: Date;
};

const normalize = (email: string) => email.toLowerCase();

export async function listTenants(database: Database): Promise<TenantRow[]> {
  return runAsTenant("platform", async () => {
    const rows = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
        plan: subscriptions.planId,
        suspended: sql<boolean>`${revokedAccess.email} is not null`,
        wakers: sql<number>`(select count(*)::int from agent_profiles ap
          where ap.tenant_id = ${users.id} and ap.deleted_at is null)`,
        activeRoutines: sql<number>`(select count(*)::int from routines r
          where r.tenant_id = ${users.id} and r.enabled)`,
      })
      .from(users)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, users.id))
      .leftJoin(revokedAccess, eq(revokedAccess.email, sql`lower(${users.email})`))
      .orderBy(desc(users.createdAt));
    return rows.map((row) => ({ ...row, plan: row.plan ?? "free" }));
  });
}

export async function suspendTenant(
  database: Database,
  userId: string,
  operator: { id: string; email: string },
): Promise<boolean> {
  return runAsTenant("platform", async () => {
    const [user] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return false;
    await database
      .insert(revokedAccess)
      .values({ email: normalize(user.email), revokedBy: operator.id })
      .onConflictDoNothing();
    await database.delete(sessions).where(eq(sessions.userId, userId));
    // Frozen here, not merely blocked at sign-in: a suspended tenant's
    // schedule must not keep spending model credit while nobody is watching.
    await database
      .update(routines)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(routines.tenantId, userId));
    return true;
  });
}

export async function restoreTenant(
  database: Database,
  userId: string,
): Promise<boolean> {
  return runAsTenant("platform", async () => {
    const [user] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return false;
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, normalize(user.email)));
    return true;
  });
}
