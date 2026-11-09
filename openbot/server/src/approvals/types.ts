import type { ContinuationReceipt } from "./continuation-protocol";
import { createHash } from "node:crypto";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import {
  type ApprovalContinuation,
  currentApprovalContext,
  withApprovalContext,
} from "@openbot/toolkit/continuation";
import type { AuditEventInput, AuditInitiator } from "../audit";
import { cutAtCodeUnits } from "../channels/text";

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
    /** A local app's tool the device does not list as read-only (device MCP bridge §4.4). */
    | "app_tool"
    // --- app discovery (sub-project 3) ---
    /** Enabling a discovered local app: always asked. */
    | "app_enable"
    // --- end app discovery ---
    // --- desktop control (sub-project 2) ---
    /** 标题含敏感词的桌面窗口，读之前要问（设备端桌面查看 §4.2）。 */
    | "desktop_window"
    // --- end desktop control ---
    /**
     * 删除、归档，或应用标为破坏性的工具：总是先问，且只能「允许一次」（见 `offersStandingRule`）。
     */
    | "destructive_tool"
    /**
     * 应用工具要把内容发给别人（发信、回复、发帖等）：总是先问，且只能「允许一次」
     * （见 `offersStandingRule`）。
     */
    | "outbound_send"
    | "auto_review"
    | "default"
    /** The person already declined this action, or an equivalent, earlier in this conversation. */
    | "person_declined"
    /**
     * A task started from a check-in item: every change it makes asks first, whatever the person's
     * "Ask before making changes" says (tasks/turn.ts). Kept apart from `default` so turning that
     * switch off, or saving an allow rule, never withdraws what a task is waiting on.
     */
    | "task";
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
export {
  type ApprovalContinuation,
  currentApprovalContext,
  withApprovalContext,
};

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
  /**
   * A local app's tool on a paired machine (device MCP bridge): whether the device's own tool list,
   * fetched by the gateway, says it is read-only and not destructive. Never from the model's
   * arguments; absent means unknown, which is not read-only.
   */
  appTool?: { readOnly: boolean };
  /**
   * 这次调用经插件仓库的调用路径而来（MCP、Composio 授予的工具），由那里设置。删除类底线据此
   * 认定它是应用工具：服务器 id 由管理员起名，可以叫 `host` 或 `memory`，不能靠 ref 前缀判断。
   */
  connector?: true;
  // --- desktop control (sub-project 2) ---
  /**
   * 要读的桌面窗口（设备端桌面查看第 1 期）：网关从窗口列表里拿到的标题，以及它命中的敏感词。
   * 只来自调用处，从不来自模型的参数；读窗口时缺了它，按「没能确认标题」处理，要审批。
   */
  desktop?: { title: string; sensitiveWord?: string };
  // --- end desktop control ---
};
export type ApprovalCandidate = {
  actorId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  args: unknown;
  target?: unknown;
  /**
   * What the card shows besides the action and is not part of it: saved with the request, never in
   * its digest or its equivalence. A local app tool's description lives here, because the device
   * reports it afresh each time (or not at all while it is away), and an approved call must still
   * be the same action when it runs.
   */
  display?: { description?: string };
  subject?: ApprovalSubject;
  /**
   * 应用把这个工具标为会删除或覆盖内容：MCP 的 `destructiveHint`，或 Composio 的破坏性标签，在列出
   * 应用时记进 `mcp_tools.destructive`。不管工具叫什么，都按删除处理，总是先问（见 ./policy 的
   * `destructiveFloor`）。这是工具本身的事实，不是这次调用的，所以不进动作摘要。
   */
  destructive?: true;
  continuation?: ApprovalContinuation;
  /**
   * A reviewed read of the person's own app: a tool on an app they connected with their own account,
   * named on a reviewed read list (`reviewedRead` in plugins/catalogue.ts). Chat goes on judging a
   * call by `effect`; in a task's conversation this is the one kind of call that runs without asking.
   * Not part of what the person approves, so not in the action's digest.
   */
  ownConnectionRead?: true;
  /**
   * The app marks this tool as destroying something: MCP's `destructiveHint`, or a broker's
   * destructive flag, as recorded when the app was listed (`mcpTools.destructive`). It asks as
   * deleting does, whatever the tool is called (see `safetyRequirement` in ./policy). A fact about
   * the tool, not about this call, so not in the action's digest.
   */
  destructive?: true;
  /**
   * The row the trail records for this action if the person denies it, built by the code that would
   * have carried it out, so a denial reads like that surface's other refusals and lands in the
   * Blocked view. Written once, with the decision, in the transaction that saves it. Not part of what
   * the person approves, so not in the action's digest.
   */
  declined?: AuditEventInput;
  /**
   * Which of the person's accounts at an app the call runs in, by the address the person knows it
   * by, where they hold more than one. Part of what makes two actions the same action: a call to one
   * mailbox is never answered by an approval, a denial or a saved rule about another.
   */
  account?: string;
};

/** 只能「允许一次」的底线：它们在任何规则之后仍然要问。 */
const ONCE_ONLY_SOURCES: ReadonlySet<string> = new Set([
  "destructive_tool",
  "outbound_send",
]);

/**
 * 这条审批能不能用「在这里总是允许」来回答，也就是存一条长期规则。
 *
 * 删除、归档和应用标为破坏性的操作不行：它们在任何规则之后仍然要问（`destructive_tool` 底线），
 * 存下的规则下次根本用不上，只会误导人。应用工具把内容发给别人（`outbound_send` 底线）同理。
 * 「允许一次」和「拒绝」照常提供。
 *
 * 服务端据此拒绝这种规则（./store 的 `decide`），聊天卡片据此不画这个按钮
 * （delivery/opentag-agent.ts）；网页的审批卡片按同一条件判断（app/src/components/approvals）。
 */
export function offersStandingRule(action: {
  policy?: { source: string } | undefined;
}): boolean {
  return !ONCE_ONLY_SOURCES.has(action.policy?.source ?? "");
}
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
  /** The one account the rule is for, or null for the app whichever account; see `ruleMatches`. */
  account?: string | null;
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
/** The three modes a Bot's tool can be set to on its permissions page (SEC1 §4.5). */
export type EmployeeToolMode = "direct" | "ask" | "disabled";
/** Each mode is one rule behaviour: 直接 is allow, 询问 is ask, 禁用 is deny. */
export const EMPLOYEE_TOOL_BEHAVIOUR: Record<EmployeeToolMode, RuleBehaviour> = {
  direct: "allow",
  ask: "ask",
  disabled: "deny",
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
   *
   * `resume: false` closes them and carries nothing on, for a run that has already ended and been
   * answered another way: a subagent's, which handed its action back to the Bot that started it.
   */
  withdrawPending(
    ownerUserId: string,
    reason: string,
    match: (action: ApprovalAction) => boolean,
    options?: { resume?: boolean },
  ): Promise<string[]>;
  /**
   * The owner's side of one Bot (SEC1 D9): its owner, the owner's rules and its security floors,
   * read in the owner's frame whoever asks. Optional so older fakes keep working; absent, no owner
   * rule applies and the floors are their defaults.
   */
  employee?(botId: string): Promise<EmployeePolicy>;
  /** Whether the current frame can see this Bot at all (its own, a team Bot it may use, the catalogue). */
  botVisible?(botId: string): Promise<boolean>;
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
    /** What the action was aimed at, so the row can name the file or page it was about. */
    target?: unknown;
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
  /**
   * Whether this thread is the conversation of a task the person started from a check-in item,
   * where every change asks first. Absent where there are no tasks.
   */
  asksEveryChange?(ownerUserId: string, threadId: string): Promise<boolean>;
  policy?: ApprovalPolicyStore;
};
/** Whether an approval may be answered with "Always allow here". Shared with the browser. */
export { offersStandingRule } from "@openbot/shared/standing-rule";
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}
/**
 * The policy wants to ask, and the call arrived with no conversation to ask in.
 *
 * A browser sends a Bot's look at a page (a navigation, a snapshot) straight to the computer; only its
 * changes travel through the approval route that carries the conversation. A rule can still ask about
 * a look. Marked apart from other refusals so the computer routes can say so, and the browser can send
 * the same call again through that route, where the person is asked, instead of handing the Bot a
 * refusal it can only apologise for.
 */
export class ApprovalNeedsConversationError extends ApprovalRefusedError {
  constructor() {
    super(
      "This action needs your approval, but it was not started from a conversation that can ask you. Nothing was done. Ask for it in a chat with this Bot, or change your rules in Settings → Approvals.",
    );
    this.name = "ApprovalNeedsConversationError";
  }
}
/**
 * This same call was answered already: it was denied, it failed, or its approval was used. What it
 * got then is what it gets now. Nothing new was turned away, so the action's code records nothing new.
 */
export class ApprovalAlreadyAnsweredError extends ApprovalRefusedError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalAlreadyAnsweredError";
  }
}
export class ApprovalNotFoundError extends Error {
  constructor() {
    super("This approval could not be found.");
    this.name = "ApprovalNotFoundError";
  }
}
/**
 * The file or page an action was aimed at, for its approval rows on the trail: without it a decision
 * names a tool and a folder, and nobody can tell which of the actions beside it it was about.
 */
export function targetSubject(target: unknown): {
  file?: string;
  page?: string;
  command?: string;
  folder?: string;
} {
  if (!target || typeof target !== "object") return {};
  const { filePath, pageUrl, grantId, displayName, relativePath, command } =
    target as {
      filePath?: unknown;
      pageUrl?: unknown;
      grantId?: unknown;
      displayName?: unknown;
      relativePath?: unknown;
      command?: unknown;
    };
  /*
   * A folder on the person's computer (`host-access/broker.ts`): the file in it, the command, and
   * the folder by its name. Without them the row named only its scope, the grant's id, and Activity
   * read "Save a file  host-grant-15407-1794112361547002000".
   */
  const folder = typeof grantId === "string";
  return {
    ...(typeof filePath === "string" && filePath ? { file: filePath } : {}),
    ...(folder &&
    typeof relativePath === "string" &&
    relativePath &&
    relativePath !== "."
      ? { file: relativePath }
      : {}),
    ...(typeof pageUrl === "string" && pageUrl ? { page: pageUrl } : {}),
    ...(folder && typeof command === "string" && command ? { command } : {}),
    ...(folder && typeof displayName === "string" && displayName
      ? { folder: displayName }
      : {}),
  };
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
/** The tool that calls a local app's MCP tool on a paired machine (device MCP bridge). */
const APP_CALL_TOOL = "computer_app_call";
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
    throw new ApprovalNeedsConversationError();
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
        /*
         * A local app's tool is read or write by what its device lists at the moment (device MCP
         * bridge §3.4): unknown while the device is away or its list is older than five minutes,
         * known again once it is back. The action approved is which tool of which app with which
         * arguments, so its effect is not part of what it is; otherwise an approval asked while the
         * device was away could never run once it returned.
         */
        effect:
          candidate.toolRef === APP_CALL_TOOL ? APP_CALL_TOOL : candidate.effect,
        scope: candidate.scope,
        args: candidate.args,
        target: candidate.target,
        // Only where there is one, so a request opened before accounts were named keeps its digest.
        ...(candidate.account ? { account: candidate.account } : {}),
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
    return (args.length > 2000 ? `${cutAtCodeUnits(args, 1999)}…` : args)
      .replace(
        /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s;]+/gi,
        "$1[private value]",
      )
      .replace(/Bearer\s+\S+/gi, "Bearer [private value]");
  return args;
}

/** How much of a local app call's arguments its card shows (device MCP bridge §4.5). */
const APP_ARGS_PREVIEW_BYTES = 2048;

/**
 * An action's arguments as a card shows them: {@link approvalPreview}, except for a local app's
 * call, which shows the app and tool (the gateway's own names), the tool's description from the
 * device's list (`display`), and the tool's arguments masked by `approvalPreview` first and then as
 * JSON cut to 2 KB. Display only: what is approved and run is the whole call, bound by the action
 * digest.
 */
export function approvalArgsPreview(action: {
  toolRef: string;
  args: unknown;
  target?: unknown;
  display?: unknown;
}): unknown {
  const field = (value: unknown, key: string) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  // --- app discovery (sub-project 3) ---
  if (action.toolRef === "computer_app_enable")
    return {
      app: approvalPreview(field(action.target, "name")),
      source: approvalPreview(field(action.display, "description")),
    };
  // --- end app discovery ---
  if (action.toolRef !== APP_CALL_TOOL)
    return approvalPreview(action.args);
  // Masked as an object, so secrets by name are hidden before the JSON is cut.
  const json =
    JSON.stringify(approvalPreview(field(action.args, "args") ?? {})) ?? "{}";
  const bytes = new TextEncoder().encode(json);
  const shown =
    bytes.length > APP_ARGS_PREVIEW_BYTES
      ? `${new TextDecoder()
          .decode(bytes.slice(0, APP_ARGS_PREVIEW_BYTES - 3))
          .replace(/\uFFFD+$/, "")}…`
      : json;
  const description =
    field(action.display, "description") ?? field(action.target, "description");
  return {
    app: approvalPreview(field(action.target, "app") ?? field(action.args, "app")),
    tool: approvalPreview(
      field(action.target, "tool") ?? field(action.args, "tool"),
    ),
    ...(typeof description === "string"
      ? { description: approvalPreview(description) }
      : {}),
    args: shown,
  };
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
