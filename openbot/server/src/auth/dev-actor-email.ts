// Kept apart from dev-actor.ts, which pulls in the database and tenant modules: the computer and
// password routes only need to know whether an address is the demo account's, and must not depend
// on the authentication module's internals for that.

/** The single-user demo account's address. */
export const DEV_ACTOR_EMAIL = "admin@xiongbao.local";

/**
 * Addresses the demo account had before the rename. An upgraded database keeps its row until the
 * next start rewrites the email, and an actor minted by an older build can still carry one.
 */
export const LEGACY_DEV_ACTOR_EMAILS: readonly string[] = ["dev@openbot.local"];

/**
 * Whether `email` is the demo account, under its current or any earlier address. Takes a missing
 * address too: callers hold actors whose email was never set, and those are not the demo account.
 */
export function isDevActorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lowered = email.trim().toLowerCase();
  return (
    lowered === DEV_ACTOR_EMAIL || LEGACY_DEV_ACTOR_EMAILS.includes(lowered)
  );
}
