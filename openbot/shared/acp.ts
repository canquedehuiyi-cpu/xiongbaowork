/**
 * External agents (Codex, Claude Code, Hermes, or the owner's own) hired as XiongBao employees and
 * run on the owner's computer through the Agent Client Protocol. Shared by the runner and the
 * server; the `acp.*` frames between them are added beside these types.
 */

/** Which agent an external employee is. `custom` is the owner's own registered app (`app_…`). */
export type AcpHarness = "codex" | "claude-code" | "hermes" | "custom";

/** The five things an external employee's rules decide. */
export type AcpRuleKey =
  | "editInside"
  | "touchOutside"
  | "runCommand"
  | "network"
  | "push";

/**
 * `direct`: done without asking. `ask`: the owner approves each time. `dangerous` (only
 * `runCommand`): asked only for commands judged dangerous.
 */
export type AcpRuleValue = "direct" | "ask" | "dangerous";

/** The rules a newly hired external employee starts with. */
export const ACP_RULE_DEFAULTS: Record<AcpRuleKey, AcpRuleValue> = {
  editInside: "direct",
  touchOutside: "ask",
  runCommand: "dangerous",
  network: "ask",
  push: "ask",
};
