import type { MiddlewareHandler } from "hono";
import type { SingleUserAccess } from "../config";
import type { Database } from "../db/client";
import { callerOf, singleUserRefusal } from "../request-trust";
import { users } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { provisionTenant } from "../tenant/provisioning";
import type { AppVariables, AuthenticatedActor } from "./guards";
import { setRole } from "./roles";

/**
 * A signed-in person, without signing in.
 *
 * A deployment with no identity provider is one administrator and no sign-in, so `bun run dev`
 * reaches the product without registering an OAuth client first. Nobody should have to set up Entra
 * to look at a Bot. `.env.example` ships that line switched on, so a clone still runs with no
 * configuration at all.
 *
 * The lock is the flag and nothing else. It used to be `NODE_ENV`, which is exactly backwards:
 * `NODE_ENV` is unset by default, so the one case it had to catch was the one it let through. A
 * container run on a VM with a hand-written env file and no provider served every visitor on the
 * internet as an administrator, and said nothing, because it looked like it was working. Now the
 * deployment refuses to start unless somebody wrote down that they meant it.
 *
 * The actor is an administrator so admin surfaces can be reached too, and its id is fixed so
 * Intelligence threads and memory stay attached to the same person across restarts.
 */

export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@openbot.local",
  role: "admin",
};

type UserWriter = Pick<Database, "insert">;

export async function initializeDevActorUser(
  database: UserWriter,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;

  const name = DEV_ACTOR.name ?? DEV_ACTOR.email;
  // `users` is an identity row, not a tenant's: written at boot as `platform` (G01-E P3), never
  // through the legacy unframed fallback. A caller already inside a transaction keeps that
  // transaction's connection; only the frame read by the client changes.
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({
        id: DEV_ACTOR.id,
        email: DEV_ACTOR.email,
        name,
        emailVerified: false,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: DEV_ACTOR.email,
          name,
          updatedAt: new Date(),
        },
      }),
  );

  return true;
}

/**
 * The single-user actor's administrator role, in `user_roles`.
 *
 * `DEV_ACTOR.role` says "admin" to the request guard, but row-level security recognises an
 * administrator only through `user_roles` (G01-E I10): the ADMIN predicate on team governance rows
 * needs that row, and `adminCapability` re-reads it before granting the capability. Without it the
 * one person a single-user deployment has could not change team approval rules or settings, which
 * live in the shared `team` tenant. So the actor gets the same row any other administrator has,
 * through the role writer, at boot, as `platform` (role facts belong to no tenant).
 *
 * Separate from {@link initializeDevActorUser} because the role writer is bound to the application
 * `Database`, not to a transaction a caller may hand that function. Idempotent: called on every start,
 * after the user row exists (the role row references it).
 */
export async function seedDevActorRole(
  database: Database,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  await runAsTenant("platform", () =>
    setRole(database, DEV_ACTOR.id, DEV_ACTOR.role),
  );
  return true;
}

/**
 * The single-user actor's tenant: a Free subscription row and its 分身.
 *
 * The actor is written at start-up, not by Better Auth's user-create hook, so it never got a
 * subscription. Quota fails closed to Free on an absent row (audit #7), so the limits are the same
 * either way -- including `customModels: false`, which refuses POST /api/models until the plan is
 * switched -- but with the row in place the administrator can switch it with POST /api/quota/plan.
 *
 * Separate from {@link initializeDevActorUser} because provisioning writes tenant-scoped rows and has
 * to run in the actor's own tenant scope, which a transaction already opened as `system` cannot give
 * it. Idempotent: called on every start.
 */
export async function provisionDevActorTenant(
  database: Database,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  await provisionTenant(database, {
    id: DEV_ACTOR.id,
    email: DEV_ACTOR.email,
    name: DEV_ACTOR.name ?? DEV_ACTOR.email,
  });
  return true;
}

/**
 * Whether this deployment admits everybody as one administrator.
 *
 * Only ever true when no identity provider is configured: a provider always wins, so a deployment
 * cannot half sign people in.
 *
 * @param hasProvider whether any identity provider is configured
 */
export function singleUserEnabled(
  environment: Record<string, string | undefined>,
  hasProvider: boolean,
): boolean {
  if (hasProvider) return false;

  // Said explicitly, which is the only way to run with no sign-in at all. Not a default, and not
  // inferred from anything: every signal that could stand in for "this is only my laptop" is absent
  // by default on a server too, which is what made the previous NODE_ENV check useless.
  const asked =
    environment.OPENBOT_SINGLE_USER?.trim() === "true" ||
    // The name this had before. Still honoured so an existing .env keeps working.
    environment.OPENBOT_DEV_NO_AUTH?.trim() === "true";
  if (asked) return true;

  throw new Error(
    "No identity provider is configured. Set GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or set OPENBOT_SINGLE_USER=true to run with one administrator and no sign-in. Refusing to start rather than serving a deployment where every visitor is an administrator.",
  );
}

/**
 * A guard that admits as {@link DEV_ACTOR} every request this machine's own person could have made: from
 * this machine where the server runs on it, addressed to one of its own names (`singleUserRefusal`).
 * Only ever mounted when singleUserEnabled().
 *
 * `access` is the deployment's (`config.singleUserAccess`). Absent, the strictest: this machine only.
 */
export function createDevRequireUser(
  access?: SingleUserAccess,
): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    const refused = singleUserRefusal(
      context.req.raw,
      callerOf(context),
      access,
    );
    if (refused) return context.json({ error: refused }, 403);
    context.set("actor", DEV_ACTOR);
    await runAsTenant(DEV_ACTOR.id, () => next());
  };
}
