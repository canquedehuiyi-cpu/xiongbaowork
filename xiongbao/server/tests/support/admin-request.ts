import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createAdminScope } from "../../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../../src/auth/guards";
import { setRole } from "../../src/auth/roles";
import type { Database } from "../../src/db/client";
import { users } from "../../src/db/schema";
import { runAsTenant } from "../../src/tenant/context";
import { bindTestRoleWriter } from "./role-writer";

/**
 * An administrator's request, for a suite that calls a store directly (G01-E I10).
 *
 * The admin's own frame, holding the capability that `adminCapability` grants after re-reading
 * `user_roles`, exactly as a request through the admin routes does. A suite cannot reach the
 * capability any other way, deliberately: `withCapability` is `admin-scope.ts`'s alone. The person
 * must be an administrator in `user_roles` ({@link seedAdministrator}); otherwise the work runs in
 * their frame without it, which is what a demoted administrator's request looks like.
 */
export function createAdminRequest(database: Database) {
  const scope = createAdminScope({
    roleRepository: createRoleRepository(database),
  });
  return async function asAdminRequest<T>(
    adminId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    let outcome: { value: T } | { error: unknown } | undefined;
    const app = new Hono<{ Variables: AppVariables }>();
    app.use(
      "*",
      async (context, next) => {
        context.set("actor", {
          id: adminId,
          email: `${adminId}@example.test`,
          role: "admin",
        });
        await runAsTenant(adminId, () => next());
      },
      scope.adminCapability,
    );
    app.get("/", async (context) => {
      outcome = await work().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      return context.body(null, 204);
    });
    await app.request("http://admin-request.test/");
    if (!outcome) throw new Error("The admin request never ran its work.");
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  };
}

/**
 * Make each of `ids` an administrator the way production does: a user row, and `admin` in
 * `user_roles` through the restricted role writer (bound once per database, so a suite names all its
 * administrators in one call). Role facts belong to no tenant, so both are written as `platform`.
 * Returns the cleanup, which removes the users (their roles follow by cascade) and releases the role
 * writer.
 */
export async function seedAdministrator(
  database: Database,
  ...ids: string[]
): Promise<() => Promise<void>> {
  const releaseRoleWriter = await bindTestRoleWriter(database);
  await runAsTenant("platform", async () => {
    for (const id of ids) {
      await database
        .insert(users)
        .values({ id, email: `${id}@example.test`, name: id })
        .onConflictDoNothing();
      await setRole(database, id, "admin");
    }
  });
  return async () => {
    try {
      await runAsTenant("platform", () =>
        database.delete(users).where(inArray(users.id, ids)),
      );
    } finally {
      await releaseRoleWriter();
    }
  };
}
