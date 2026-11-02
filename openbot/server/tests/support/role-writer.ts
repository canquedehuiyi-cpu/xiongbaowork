import { initializeRoleWriter, stopRoleWriter } from "../../src/auth/roles";
import { createDatabase, type Database } from "../../src/db/client";

/**
 * Bind the real restricted role writer to a test pool, the way `src/index.ts` does in production.
 *
 * `setRole` (and through it Better Auth's `user.create.after` hook) refuses to write without one, and
 * the binding is per `Database` instance, so each suite that reaches it binds its own. The writer is
 * `openbot_role_writer` on the same database as `TEST_DATABASE_URL`; `initializeRoleWriter` checks
 * both roles against its restricted-authority contract, so no fake facts are involved. Returns the
 * release, which joins the admitted writes and closes the writer's connection.
 */
export async function bindTestRoleWriter(
  application: Database,
): Promise<() => Promise<void>> {
  const url = process.env.TEST_ROLE_WRITER_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "TEST_ROLE_WRITER_DATABASE_URL must connect to the TEST_DATABASE_URL database as openbot_role_writer.",
    );
  }
  const writer = createDatabase(url, { max: 1 });
  try {
    await initializeRoleWriter(application, writer);
  } catch (error) {
    await writer.$client.close();
    throw error;
  }
  return async () => {
    try {
      await stopRoleWriter(application);
    } finally {
      await writer.$client.close();
    }
  };
}
