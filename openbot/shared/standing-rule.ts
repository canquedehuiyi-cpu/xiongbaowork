/**
 * Whether an approval may be answered with a standing answer: "Always allow here", or "Allow for
 * this conversation".
 *
 * Upstream (#1394) opens every kind of action that asks to standing answers by default. THIS
 * DEPLOYMENT KEEPS ITS FLOORS (#398): deleting, sending, sharing and posting ask every time with
 * Allow once and Deny only (`ONCE_ONLY_SOURCES` below), and paying or changing account settings is
 * handed to the person (server/src/approvals/policy.ts). An admin can close any other kind further
 * (Admin → Approvals); then it asks every time and only Allow once and Deny stay (`closed`).
 *
 * Not one a task started from a check-in raised: those ask before every change whatever the
 * person's rules say (`TASK_ASKS` in server/src/approvals/service.ts), so a standing answer saved from
 * one would be ignored the next time and only mislead.
 *
 * Not a hand-off: the person does that themselves, so there is nothing for the Bot to be allowed.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, so the two cannot drift apart. The server refuses such an
 * answer (server/src/approvals/store.ts) and leaves the button off a chat card
 * (server/src/delivery/opentag-agent.ts); the browser draws its approval cards from the same answer
 * (app/src/components/approvals).
 */
export function offersStandingRule(action: {
  policy?: { source: string; behaviour?: string; closed?: boolean } | undefined;
}): boolean {
  const policy = action.policy;
  return (
    !ONCE_ONLY_SOURCES.has(policy?.source ?? "") &&
    policy?.closed !== true &&
    policy?.behaviour !== "hand_off"
  );
}

/**
 * The sources answered only once. `task` as above; `safety` (a built-in requirement or the
 * reviewer's safety category, or a kind the admin closed); `destructive_tool` (deleting, archiving, a
 * tool its app marks destructive), `outbound_send` (an app tool sending something to other people, a
 * send button or a keyboard send on a web page), `share_access` (sharing, changing permissions,
 * adding collaborators) and `publish_post` (forwarding, going live, publishing a release, posting)
 * are the floors this deployment asks for after every rule, so a saved rule or a conversation answer
 * could never answer one either.
 */
export const ONCE_ONLY_SOURCES: ReadonlySet<string> = new Set([
  "task",
  "safety",
  "destructive_tool",
  "outbound_send",
  "share_access",
  "publish_post",
]);
