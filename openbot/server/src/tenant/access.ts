import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { revokedAccess, users } from "../db/schema";
import { runAsTenant } from "./context";

/**
 * Whether an administrator has taken this person's access away.
 *
 * Spec J5 says a ban does more than sign them out: it freezes the workspace's task queue and its
 * runner connections. The ban itself already existed — `revoked_access`, written by the platform
 * console and read by the auth layer and the People screens — but nothing on the device or routine
 * paths consulted it, so a banned workspace kept claiming queued actions and kept firing. A session
 * that cannot be opened is not the same thing as work that stops happening on that account.
 *
 * Keyed by email because that is how the ban is stored: `revoked_access` is a list of normalized
 * addresses rather than a list of user ids, which is what lets an administrator ban somebody who has
 * registered but never signed in. The tenant id IS the user id here (decision D12), so one join answers
 * the question about the person who owns a device or a routine.
 *
 * Read in the `platform` scope for the same reason `authenticateDeviceToken` is: the caller is a
 * machine holding a token, or a clock, and neither arrives inside a session.
 */
export async function isAccessRevoked(
  database: Database,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  const rows = await runAsTenant("platform", () =>
    database
      .select({ email: revokedAccess.email })
      .from(users)
      .innerJoin(
        revokedAccess,
        eq(revokedAccess.email, sql`lower(${users.email})`),
      )
      .where(eq(users.id, userId))
      .limit(1),
  );
  return rows.length > 0;
}
