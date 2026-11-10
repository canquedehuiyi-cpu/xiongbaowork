/**
 * Whether an approval may be answered with a standing answer: "Always allow here", or "Allow for
 * this conversation".
 *
 * OPEN BY DEFAULT. Deleting, sending, sharing, posting, paying and changing account settings ask
 * (server/src/approvals/policy.ts), and the person can allow each of them once, for the conversation,
 * or always, as they can anything else that asks. An admin closes a kind of action for everybody
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
<<<<<<< 9772fc7e2b1ae57f9300ef67de28e9fefd5ee29e
  return !ONCE_ONLY_SOURCES.has(action.policy?.source ?? "");
=======
  const policy = action.policy;
  return (
    policy?.source !== "task" &&
    policy?.closed !== true &&
    policy?.behaviour !== "hand_off"
  );
>>>>>>> e4f4ac8578f5545794cad028b21ac396fa6c816b
}

/**
 * The sources answered only once. `task` and `safety` as above; `destructive_tool` (deleting,
 * archiving, a tool its app marks destructive), `outbound_send` (an app tool sending something to
 * other people, a send button or a keyboard send on a web page), `share_access` (sharing, changing
 * permissions, adding collaborators) and `publish_post` (forwarding, going live, publishing a
 * release, posting) are the floors this deployment asks for after every rule, so a saved rule could
 * never answer one either.
 */
export const ONCE_ONLY_SOURCES: ReadonlySet<string> = new Set([
  "task",
  "safety",
  "destructive_tool",
  "outbound_send",
  "share_access",
  "publish_post",
]);
