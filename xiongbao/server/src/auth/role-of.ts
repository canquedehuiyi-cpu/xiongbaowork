import { DEV_ACTOR } from "./dev-actor";
import type { RoleRepository } from "./guards";

export type ActingRole = "admin" | "user";

/**
 * The role a person acts in when nobody is at the keyboard: a routine, a group turn, the boot-time
 * group upgrade. One person in single-user mode, and they are an administrator; anyone else acts as
 * an administrator or a user when they hold that role, and not at all (null) when they hold neither.
 *
 * `actorFor` (index.ts) refuses a null; the group upgrade records such an owner as `no_owner`. Both
 * ask here, so the two can never disagree about who may act.
 */
export function createRoleOf(deps: {
  singleUser: boolean;
  roles: Pick<RoleRepository, "rolesForUser">;
}): (userId: string) => Promise<ActingRole | null> {
  return async (userId) => {
    if (deps.singleUser) return DEV_ACTOR.role;
    const held = await deps.roles.rolesForUser(userId);
    if (held.includes("admin")) return "admin";
    if (held.includes("user")) return "user";
    return null;
  };
}
