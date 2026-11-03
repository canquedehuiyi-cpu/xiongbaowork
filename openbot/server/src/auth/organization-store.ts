import { ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { provisionTenant } from "../tenant/provisioning";
import { DEV_ACTOR } from "./dev-actor";
import type { AuthenticatedActor } from "./guards";
import { setRole } from "./roles";

/** Reconcile only an employee verified by the pinned authority; retain existing local history IDs. */
export function organizationUserStore(database: Database) {
  /*
   * Tenants already provisioned by this process. Materialization runs on every verified session, and
   * provisioning is idempotent but not free (a read and two conflict-ignoring inserts), so it runs
   * once per person per process rather than once per request.
   */
  const provisioned = new Set<string>();
  return async (user: AuthenticatedActor) => {
    const [local] = await database
      .insert(users)
      .values({
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      })
      .onConflictDoUpdate({
        target: users.email,
        setWhere: ne(users.id, DEV_ACTOR.id),
        set: {
          email: user.email,
          name: user.name,
          image: user.image,
          updatedAt: new Date(),
        },
      })
      .returning({ id: users.id });
    if (!local || local.id === DEV_ACTOR.id)
      throw new Error(
        "Organization sign-in cannot use the standalone account.",
      );
    await setRole(database, local.id, user.role);
    /*
     * This path never passes through Better Auth's user-create hook, so without it an organization
     * employee had no subscription row. Quota now fails closed to Free on an absent row (audit #7),
     * which is what they would get either way; provisioning makes it a real row an administrator can
     * switch with POST /api/quota/plan, plus the same 分身 every other arrival path gets.
     */
    if (!provisioned.has(local.id)) {
      await provisionTenant(database, {
        id: local.id,
        email: user.email,
        name: user.name,
      });
      provisioned.add(local.id);
    }
    return { ...user, id: local.id };
  };
}
