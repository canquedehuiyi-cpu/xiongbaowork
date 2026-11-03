import type { ContinuationReceipt } from "./continuation-protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type Message,
  type RunAgentInput,
  RunAgentInputSchema,
} from "@ag-ui/client";
import type { AuditInitiator } from "../audit";

/** `handled` answers a hand-off: the person did it themselves, so it is never executed for them. */
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
/**
 * What a matching custom rule does, in Dot's four behaviours: take action without asking; take
 * action only when the person explicitly asked for that exact action in this run's request; ask
 * before taking action; hand it off to the person.
 */
export type RuleBehaviour =
  | "allow"
  | "pre_approved"
  | "ask"
  | "hand_off"
  /**
   * SEC1 (spec §4.1): the tool is disabled. A matching `deny` refuses the action at the gate with no
   * request to approve, and is the strictest behaviour of all. The gate read it before the database
   * accepted it (0131), so a row carrying it is never misread as allow.
   */
  | "deny";
/** The behaviours a rule may be saved with. `deny` (disable the tool) is accepted from 0131. */
export const RULE_BEHAVIOURS = [
  "allow",
  "pre_approved",
  "ask",
  "hand_off",
  "deny",
] as const satisfies readonly RuleBehaviour[];
/** The behaviours that only ever make the gate stricter: kept when custom rules are off (D6). */
export const TIGHTENING_BEHAVIOURS = [
  "ask",
  "hand_off",
  "deny",
] as const satisfies readonly RuleBehaviour[];
/** Commands on the person's own computer. */
export type HostCommandPolicy = "ask" | "allow" | "never";
/** Why the gate settled an action the way it did; stored on the request and in the audit row. */
export type ApprovalPolicyOutcome = {
  behaviour: "allow" | "ask" | "hand_off" | "deny";
  /** Which layer decided: a built-in safety requirement, a rule, auto-review, or the default. */
  source:
    | "safety"
    | "team_rule"
    /** A rule the Bot's owner saved, applied to another person using that Bot (SEC1 D9). */
    | "owner_rule"
    | "personal_rule"
    /** The deterministic dangerous-command floor (SEC1 §4.3). */
    | "dangerous_command"
    /** The sensitive-path floor (SEC1 §4.4). */
    | "sensitive_path"
    /** The team's host-command cap, applied to a command on a paired machine (SEC1 D5). */
    | "host_command_cap"
    | "auto_review"
    | "default"
    /** The person already declined this action, or an equivalent, earlier in this conversation. */
    | "person_declined";
  reason: string;
  ruleId?: string;
  review?: {
    verdict: "proceed" | "needs_approval" | "hand_off";
    preApproved: boolean;
    reason: string;
    /** The reviewer's safety classification; any value but `none` hands the action off. */
    safety?: "none" | "credentials" | "security_settings" | "payments";
    failedClosed?: boolean;
  };
};
export type ApprovalContinuation = {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  messages: Message[];
  state: unknown;
  context: RunAgentInput["context"];
  forwardedProps: unknown;
  initiator?: AuditInitiator;
};
const actionContext = new AsyncLocalStorage<ApprovalContinuation>();
export const withApprovalContext = <T>(
  context: ApprovalContinuation,
  run: () => Promise<T>,
): Promise<T> => actionContext.run(context, run);
export const currentApprovalContext = () => actionContext.getStore();

/**
 * What the action will actually run or touch, as the call site holds it rather than as the model
 * phrased its arguments: the command a shell call runs, the path a file call names, and whether the
 * command goes to a paired machine (a runner) rather than this deployment's container.
 *
 * Read by the deterministic floors (SEC1 §4.3, §4.4, D5) only. It is not part of the action's
 * identity or digest and is not saved with a request: the floors are asked again from the call site
 * whenever the gate is.
 */
export type ApprovalSubject = {
  command?: string;
  path?: string;
  runner?: boolean;
};
export type ApprovalCandidate = {
  actorId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  args: unknown;
  target?: unknown;
  subject?: ApprovalSubject;
  continuation?: ApprovalContinuation;
};
export type ApprovalAction = ApprovalCandidate & {
  runId: string;
  threadId: string;
  toolCallId: string;
  actionDigest: string;
  /** Set by the gate. Absent on a request opened by older code, which may still auto-approve. */
  policy?: ApprovalPolicyOutcome;
  /**
   * The same action with its volatile parts removed (snapshot ids, element refs), so a retry of a
   * declined or still-pending action is recognised as the same thing.
   */
  equivalence?: string;
  /** How many times the person had spoken in the conversation when this was asked. */
  userTurns?: number;
};
export type ApprovalRecord = {
  id: string;
  ownerUserId: string;
  action: ApprovalAction;
  status: "pending" | "approved" | "denied" | "consumed" | "completed";
  decision: ApprovalDecision | null;
  result: { content: string; error?: string } | null;
  createdAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
  completedAt: Date | null;
};
/**
 * An action class and what happens to it. `botId`, `toolRef`, `effect` and `scope` (the target) are
 * exact values or globs where `*` matches anything, so `mcp/gmail/*` names every Gmail tool.
 */
export type ApprovalRule = {
  id: string;
  ownerUserId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
  revokedAt: Date | null;
  createdAt: Date;
};
export type ApprovalTeamRule = Omit<ApprovalRule, "ownerUserId"> & {
  createdBy: string | null;
};
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalPreferences = {
  enabled: boolean;
  autoReview: boolean;
  hostCommands: HostCommandPolicy;
};
export type ApprovalTeamSettings = {
  enforceAutoReview: boolean;
  customRulesEnabled: boolean;
  hostCommandsCap: HostCommandPolicy;
  /** Every Bot asks before a dangerous command, whatever its own switch says (SEC1 D10). */
  enforceDangerousCommands: boolean;
};
/** A floor's switch on one Bot: off, or ask before acting. */
export type SecurityFloorMode = "off" | "ask";
/**
 * One Bot's own security floors (SEC1 §4.1 B1), set by its owner. Absent means every default: both
 * floors ask, no extra paths, every default path in force.
 */
export type EmployeeSecuritySettings = {
  dangerousCommands: SecurityFloorMode;
  sensitivePaths: SecurityFloorMode;
  /** Paths the owner added beside the defaults, in the same glob form. */
  extraSensitivePaths: string[];
  /** Default paths the owner switched off. A default can be switched off, never removed (D8). */
  disabledDefaultPaths: string[];
};
export const DEFAULT_EMPLOYEE_SECURITY: EmployeeSecuritySettings = {
  dangerousCommands: "ask",
  sensitivePaths: "ask",
  extraSensitivePaths: [],
  disabledDefaultPaths: [],
};
/**
 * What a Bot's owner has said about it, read in the owner's own frame: who the owner is (`null` for
 * nobody: a catalogue Bot or a team Bot whose profile names no person), the owner's saved rules, and
 * the Bot's security floors.
 */
export type EmployeePolicy = {
  ownerUserId: string | null;
  rules: ApprovalRule[];
  security: EmployeeSecuritySettings;
};
/** Rules, preferences and team settings. Optional on the store so older fakes keep working. */
export type ApprovalPolicyStore = {
  preferences(ownerUserId: string): Promise<ApprovalPreferences>;
  setPreferences(
    ownerUserId: string,
    input: Partial<ApprovalPreferences>,
  ): Promise<ApprovalPreferences>;
  teamSettings(): Promise<ApprovalTeamSettings>;
  setTeamSettings(
    by: string,
    input: Partial<ApprovalTeamSettings>,
  ): Promise<ApprovalTeamSettings>;
  teamRules(): Promise<ApprovalTeamRule[]>;
  createRule(
    ownerUserId: string,
    input: ApprovalRuleInput,
  ): Promise<ApprovalRule>;
  createTeamRule(
    by: string,
    input: ApprovalRuleInput,
  ): Promise<ApprovalTeamRule>;
  /** Owner-scoped: another person's rule id is not found. */
  updateRule(
    ownerUserId: string,
    id: string,
    input: Partial<ApprovalRuleInput>,
  ): Promise<ApprovalRule>;
  updateTeamRule(
    by: string,
    id: string,
    input: Partial<ApprovalRuleInput>,
  ): Promise<ApprovalTeamRule>;
  revokeTeamRule(by: string, id: string): Promise<void>;
  /** The newest request in this conversation for an equivalent action, other than this call. */
  findEquivalent(input: {
    ownerUserId: string;
    threadId: string;
    equivalence: string;
    excludeToolCallId: string;
  }): Promise<ApprovalRecord | undefined>;
  /**
   * Close this person's pending requests that `match` selects without executing them: the waiting
   * conversation is resumed with `reason` as the result, and each is audited.
   */
  withdrawPending(
    ownerUserId: string,
    reason: string,
    match: (action: ApprovalAction) => boolean,
  ): Promise<string[]>;
  /**
   * The owner's side of one Bot (SEC1 D9): its owner, the owner's rules and its security floors,
   * read in the owner's frame whoever asks. Optional so older fakes keep working; absent, no owner
   * rule applies and the floors are their defaults.
   */
  employee?(botId: string): Promise<EmployeePolicy>;
  /** The owner changes one of their Bots' floors, in their own frame. Another person's Bot is refused. */
  setEmployeeSecurity?(
    by: string,
    botId: string,
    input: Partial<EmployeeSecuritySettings>,
  ): Promise<EmployeeSecuritySettings>;
  /** One audit row per settled action, so every verdict can be read back. */
  recordDecision(input: {
    ownerUserId: string;
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    outcome: ApprovalPolicyOutcome;
    initiator?: AuditInitiator;
  }): Promise<void>;
};
export type ApprovalPermit = {
  replay?: unknown;
  complete(result: unknown): Promise<void>;
};
export type ApprovalGate = (
  candidate: ApprovalCandidate,
) => Promise<ApprovalPermit | undefined>;
export type ApprovalStore = {
  getRecoveryContext?(
    ownerUserId: string,
    id: string,
  ): Promise<ApprovalRecoveryContext>;
  enabled(ownerUserId: string): Promise<boolean>;
  setEnabled(ownerUserId: string, enabled: boolean): Promise<void>;
  open(action: ApprovalAction): Promise<ApprovalRecord>;
  get(ownerUserId: string, id: string): Promise<ApprovalRecord>;
  list(ownerUserId: string): Promise<ApprovalRecord[]>;
  decide(
    ownerUserId: string,
    id: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalRecord>;
  /** Atomically claim only approved rows whose result is SQL NULL; settled results revoke execution eligibility. */
  consume(ownerUserId: string, id: string, digest: string): Promise<boolean>;
  saveResult(
    ownerUserId: string,
    id: string,
    result: { content: string; error?: string },
  ): Promise<boolean>;
  finish(ownerUserId: string, id: string): Promise<void>;
  rules(ownerUserId: string): Promise<ApprovalRule[]>;
  revoke(ownerUserId: string, id: string): Promise<void>;
  policy?: ApprovalPolicyStore;
};
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}
export class ApprovalNotFoundError extends Error {
  constructor() {
    super("This approval could not be found.");
    this.name = "ApprovalNotFoundError";
  }
}
export function parseApprovalResult(value: unknown): {
  content: string;
  error?: string;
} {
  if (typeof value === "string") return { content: value };
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    typeof value.content === "string"
  ) {
    if (
      "error" in value &&
      value.error !== undefined &&
      typeof value.error !== "string"
    )
      throw new ApprovalRefusedError("The saved tool error is invalid.");
    return {
      content: value.content,
      ...("error" in value && typeof value.error === "string"
        ? { error: value.error }
        : {}),
    };
  }
  throw new ApprovalRefusedError("The saved tool result is invalid.");
}
export function parseApprovalContinuation(
  value: unknown,
): ApprovalContinuation {
  if (!value || typeof value !== "object")
    throw new ApprovalRefusedError(
      "The interrupted conversation is unavailable.",
    );
  const input = value as Partial<ApprovalContinuation>;
  if (
    typeof input.toolCallId !== "string" ||
    !input.toolCallId ||
    typeof input.toolName !== "string" ||
    !input.toolName
  )
    throw new ApprovalRefusedError(
      "The interrupted tool identity is unavailable.",
    );
  const parsed = RunAgentInputSchema.safeParse({ ...input, tools: [] });
  if (!parsed.success)
    throw new ApprovalRefusedError("The interrupted conversation is invalid.");
  return {
    runId: parsed.data.runId,
    threadId: parsed.data.threadId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args,
    messages: parsed.data.messages,
    state: parsed.data.state,
    context: parsed.data.context,
    forwardedProps: parsed.data.forwardedProps,
    ...(input.initiator ? { initiator: input.initiator } : {}),
  };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
export function approvalAction(candidate: ApprovalCandidate): ApprovalAction {
  const continuation = candidate.continuation ?? currentApprovalContext();
  if (
    !continuation?.runId ||
    !continuation.threadId ||
    !continuation.toolCallId
  )
    throw new ApprovalRefusedError(
      "This action needs your approval, but it was not started from a conversation that can ask you. Nothing was done. Ask for it in a chat with this Bot, or change your rules in Approvals.",
    );
  if (
    ![
      candidate.actorId,
      candidate.botId,
      candidate.toolRef,
      candidate.effect,
      candidate.scope,
    ].every((value) => typeof value === "string" && value.trim())
  )
    throw new ApprovalRefusedError("The action identity is incomplete.");
  // The call site's own view of the action is for the floors, never part of what is saved.
  const { subject: _subject, ...identity } = candidate;
  const actionDigest = createHash("sha256")
    .update(
      canonical({
        actorId: candidate.actorId,
        botId: candidate.botId,
        toolRef: candidate.toolRef,
        effect: candidate.effect,
        scope: candidate.scope,
        args: candidate.args,
        target: candidate.target,
      }),
    )
    .digest("hex");
  return {
    ...identity,
    continuation,
    runId: continuation.runId,
    threadId: continuation.threadId,
    toolCallId: continuation.toolCallId,
    actionDigest,
  };
}

export function approvalPreview(args: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (Array.isArray(args))
    return args.slice(0, 20).map((value) => approvalPreview(value, depth + 1));
  if (args && typeof args === "object")
    return Object.fromEntries(
      Object.entries(args)
        .slice(0, 20)
        .map(([key, value]) => [
          key,
          // Secrets by name. Not `text` or `content`: what is typed, written or sent is exactly
          // what the person is approving, and hiding it let a Bot get "Allow once" on a payload
          // nobody could see. Secret-looking values inside it are still masked below.
          /pass|secret|token|authorization|cookie|credential/i.test(key)
            ? "[private value]"
            : approvalPreview(value, depth + 1),
        ]),
    );
  if (typeof args === "string")
    return (args.length > 2000 ? `${args.slice(0, 1999)}…` : args)
      .replace(
        /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s;]+/gi,
        "$1[private value]",
      )
      .replace(/Bearer\s+\S+/gi, "Bearer [private value]");
  return args;
}

/** Database parent columns, not HTTP claims or an owner-derived tenant. */
export type ApprovalRecoveryContext = {
  request: ApprovalRecord;
  tenantId: string;
  parentActionDigest: string;
  parentRunId: string;
  parentToolCallId: string;
};
export type ApprovalRecoveryOutcome =
  | { kind: "completed"; receipt: ContinuationReceipt }
  | { kind: "busy" }
  | { kind: "unknown"; reason: string; admissionId?: string }
  | { kind: "blocked"; reason: string };
export interface ApprovalRecoveryPort {
  recover(input: {
    context: ApprovalRecoveryContext;
    mode: "resume" | "abandon";
    result: NonNullable<ApprovalRecord["result"]>;
  }): Promise<ApprovalRecoveryOutcome>;
}
/** Both real store and service defend the parent/JSON/live-scope binding. */
export function validateApprovalRecoveryContext(
  context: ApprovalRecoveryContext,
  owner: string,
  id: string,
  tenant: string,
): void {
  const { request: row } = context;
  if (
    ![
      owner,
      id,
      tenant,
      context.tenantId,
      context.parentActionDigest,
      context.parentRunId,
      context.parentToolCallId,
    ].every((x) => typeof x === "string" && x.trim()) ||
    row.id !== id ||
    row.ownerUserId !== owner ||
    row.action.actorId !== owner ||
    context.tenantId !== tenant ||
    row.action.actionDigest !== context.parentActionDigest ||
    row.action.runId !== context.parentRunId ||
    row.action.toolCallId !== context.parentToolCallId ||
    row.action.continuation?.runId !== context.parentRunId ||
    row.action.continuation?.toolCallId !== context.parentToolCallId
  )
    throw new ApprovalRefusedError("approval_recovery_binding_invalid");
}

/**
 * Internal producer authority, never supplied by an HTTP request. An adapter must
 * freeze and persist its producer provenance/template BEFORE an action can run.
 * These interfaces are not PG, RLS, release or receipt proof; production has no
 * default adapter and remains blocked until those authorities are wired.
 */
export type ApprovalFreshSeed = {
  approvalId: string;
  ownerId: string;
  tenantId: string;
  actionDigest: string;
  runId: string;
  toolCallId: string;
  templateDigest: string;
  producerProofId: string;
};
export interface ApprovalFreshProducerPort {
  /** Load an existing immutable producer seed; never rebuild today's input. */
  prepare(context: ApprovalRecoveryContext): Promise<ApprovalFreshSeed>;
  /** Independently verify persisted provenance and the current release/authority. */
  verifySeed(
    seed: ApprovalFreshSeed,
    context: ApprovalRecoveryContext,
  ): Promise<boolean>;
  /**
   * Store-owned transaction: CAS the approval result AND immutable final/continue
   * disposition against the verified seed, expected status and SQL NULL result.
   * This CAS must serialize with consume on the same row. An unknown ACK never
   * permits replay.
   */
  commitResult(input: {
    seed: ApprovalFreshSeed;
    context: ApprovalRecoveryContext;
    result: NonNullable<ApprovalRecord["result"]>;
    disposition: "continue" | "final";
    expectedStatus: ApprovalRecord["status"];
  }): Promise<"committed" | "lost" | "unknown">;
  /**
   * Recover after result commit. Read only the frozen seed/result/disposition;
   * publish exact input + plan + ledger atomically and idempotently, with unique
   * keys. No tool/model/network effect in that transaction. A final disposition
   * instead commits approval completion WITHOUT a continuation receipt or model.
   * Return continue only after COMMIT; the separate receipt protocol still owns
   * target admission and atomic receipt + approval finish.
   */
  publishSaved(
    context: ApprovalRecoveryContext,
  ): Promise<"continue" | "final" | "blocked" | "unknown">;
}
