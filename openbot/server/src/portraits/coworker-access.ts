import { canManageAgent } from "../agents/profile-policy";
import type { AgentProfileStore } from "../agents/profile-store";
import type { CoworkerFaceAccess } from "./routes";

/**
 * A coworker's face answers to the coworker's own rules, asked of the store that keeps them: seen by
 * whoever may see the coworker (`get` and `list` apply the same visibility filter as every other
 * coworker read), changed by whoever may manage it (`canManageAgent`, the rule the profile edit
 * uses).
 */
export function coworkerFaceAccess(
  profiles: Pick<AgentProfileStore, "list" | "get">,
): CoworkerFaceAccess {
  return {
    async visible(actor) {
      // Hidden coworkers are still the person's own; they hid them from a list, not from themselves.
      const [shown, hidden] = await Promise.all([
        profiles.list(actor, false),
        profiles.list(actor, true),
      ]);
      return new Set([...shown, ...hidden].map((profile) => profile.id));
    },
    async canSee(actor, id) {
      return (await profiles.get(actor, id)) !== null;
    },
    async canChange(actor, id) {
      const profile = await profiles.get(actor, id);
      return profile !== null && canManageAgent(actor, profile);
    },
  };
}
