import type { MiddlewareHandler } from "hono";
import {
  asPlatform,
  assertPersonTenant,
  capabilityFor,
  currentTenant,
  runAsTenant,
  TenantContextError,
  withCapability,
} from "../tenant/context";
import type {
  AppVariables,
  AuthenticatedActor,
  RoleRepository,
} from "./guards";

/**
 * Where an administrator's powers are switched on, and the only two ways they leave the admin's own
 * frame (G01-E, I5, I6, I10).
 *
 * `adminCapability` grants the request the admin capability (`app.capability = 'admin'` on every
 * statement the request runs in its own frame), but only after re-reading the person's roles: the
 * actor's `role` was decided at sign-in, and a role removed since must not keep its powers. An
 * admin's routines, proactive work and Bot turns run as the same person without passing through it,
 * so they never hold the capability.
 *
 * `adminActAsOwner` is how an admin acts on another person's rows: the row is found under `platform`,
 * and the work runs in the OWNER's frame, so every trail row and transaction belongs to the owner.
 * `asAdminPlatform` is one admin read or write as `platform`. Both demand the capability, held by
 * the admin themself in the frame they are called from — a nested frame, a routine, or a member's
 * request is refused.
 */
export function createAdminScope({
  roleRepository,
}: {
  roleRepository: RoleRepository;
}) {
  const adminCapability: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context, next) => {
    const actor = context.get("actor") as AuthenticatedActor | undefined;
    if (actor?.role !== "admin") return next();
    const roles = await asPlatform(() => roleRepository.rolesForUser(actor.id));
    // Not an admin any more: the handler's own `requireAdmin` still decides what to answer.
    if (!roles.includes("admin")) return next();
    return withCapability(actor.id, () => next());
  };

  /** The capability check both doors share: held, for this frame, by exactly this admin. */
  const requireCapability = (actor: Pick<AuthenticatedActor, "id">) => {
    const frame = currentTenant();
    if (capabilityFor(frame) !== "admin")
      throw new TenantContextError("the admin capability is not held here");
    if (actor.id !== frame)
      throw new TenantContextError(
        "the admin capability is held by someone else",
      );
  };

  const adminActAsOwner = <T>(
    actor: Pick<AuthenticatedActor, "id">,
    ownerTenant: string,
    work: () => T,
  ): T => {
    requireCapability(actor);
    return asPlatform(() => {
      // Asserted from `platform`, which may hand work to anyone; from the admin's own frame the same
      // assertion would refuse every owner but the admin.
      const owner = assertPersonTenant(ownerTenant);
      console.info(
        JSON.stringify({
          type: "admin-act-as-owner",
          admin: actor.id,
          owner,
        }),
      );
      return runAsTenant(owner, work);
    });
  };

  const asAdminPlatform = <T>(
    actor: Pick<AuthenticatedActor, "id">,
    work: () => T,
  ): T => {
    requireCapability(actor);
    return asPlatform(work);
  };

  return { adminCapability, adminActAsOwner, asAdminPlatform };
}

export type AdminScope = ReturnType<typeof createAdminScope>;
