// Kept apart from dev-actor.ts, which pulls in the database and tenant modules: the computer and
// password routes only need to know whether an address is the demo account's, and must not depend
// on the authentication module's internals for that.

/** The single-user demo account's address. */
export const DEV_ACTOR_EMAIL = "admin@xiongbao.local";

/**
 * Whether `email` is the demo account. Takes a missing address too: callers hold actors whose email
 * was never set, and those are not the demo account.
 */
export function isDevActorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  // Trim and case-insensitive on purpose: an address typed or stored with stray spaces or capitals is still the same account.
  const lowered = email.trim().toLowerCase();
  return lowered === DEV_ACTOR_EMAIL;
}
