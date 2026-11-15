import {
  ACP_RULE_DEFAULTS,
  type AcpPermissionOptionFrame,
  type AcpRuleKey,
  type AcpRuleValue,
} from "@openbot/shared/acp";
import {
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
} from "@openbot/shared/approval-outcomes";
import {
  ONCE_ONLY_SOURCES,
  offersStandingRule,
} from "@openbot/shared/standing-rule";
import { eq, sql } from "drizzle-orm";
import { safetyRequirement } from "../../approvals/policy";
import {
  type ApprovalAction,
  type ApprovalCandidate,
  type ApprovalContinuation,
  type ApprovalDecision,
  type ApprovalPolicyOutcome,
  type ApprovalRecord,
  type ApprovalStore,
  approvalAction,
  isAcpAction,
} from "../../approvals/types";
import type { Database } from "../../db/client";
import { agents, approvalRequests } from "../../db/schema";
import type { TaskProjector } from "../../tasks/projector";
import { asPlatform, runAsTenant } from "../../tenant/context";
import { ownerTenantOfBot } from "../bot-owner";
import type { AcpPermissionRequest } from "./agent";
import { commandAllowlisted } from "./command-allowlist";
import {
  analyseCommand,
  type CommandAnalysis,
  commandKey,
} from "./command-analysis";
import type { AcpRelay } from "./relay";
import { type AcpTurnStore, isFinalAcpTurnStatus } from "./turns";

/**
 * The permission bridge of an external employee (spec §4): what XiongBao answers when the agent on
 * the owner's computer asks before it acts (`acp.permission.request`, handed over by the run in
 * agent.ts).
 *
 * THE SAME POLICY ENGINE, FIVE LAYERS, STRICTEST FIRST (spec「和现有审批层的关系」):
 *  1. Every floor this deployment has: deleting asks every time and only "allow once" (#398); paying,
 *     credentials and security settings; sending to people; sharing and publishing. A floor the
 *     engine would hand to the person is asked here instead (the agent cannot be "done by you"),
 *     and the built-in floors are read here again, not only from the engine's answer. A command
 *     line has no app name for the engine to go by, so it is taken apart (command-analysis.ts:
 *     wrappers and shells off, every simple command judged, the whole line read again) and its
 *     deletes, sends, shares and publishes are the same floors. A command that does not come
 *     apart, inline interpreter code, a download run straight away, `eval`, anything piped into a
 *     shell, a runner of other commands: asked, once at a time.
 *  2. The admin's action kinds left to people themselves, a disabled tool (SEC1), a custom rule
 *     saying no: refused outright, the rule named in the conversation.
 *  3. A custom rule that asks (or hands off): asks.
 *  4. The employee's own five rules (`AcpRuleKey`); several matched, the strictest wins. Running
 *     commands "dangerous ones only" is an allowlist (command-allowlist.ts): only a clean line of
 *     listed read-only and everyday development commands that the SEC1 tables pass goes through;
 *     "directly" still asks about a line that does not come apart cleanly. Not a sandbox.
 *  5. The hirer's global approvals switch (off by default) relaxes none of this: the five rules
 *     were set for this employee at hiring, so what they ask is always asked.
 * A kind XiongBao does not know (`other`, a misspelling) is asked every time; `switch_mode` is
 * refused outright (the agent may not leave the mode that makes it ask). With no answer from the
 * engine, a request is asked.
 *
 * "ALLOW FOR THIS CONVERSATION" is never offered for a floor, layer 2, a kind XiongBao does not
 * know, a file outside the working folder, a command line that is not clean (command-analysis.ts:
 * substitutions, a variable as the program, writing a file by `>`/`>>`, control structures, script
 * blocks, here-docs, continuations, a variable in front that decides what runs), or a command the
 * SEC1 tables call dangerous (or that names a file that may hold secrets). A command is let through again only as exactly the same
 * command (`acpAllowKey`: the command line as sent, trimmed, runs of spaces outside quotes made
 * one); a file request inside the working folder by its kind.
 *
 * ASKING. An approval is opened in the hirer's tenant, for the hirer (a group's other members
 * neither see nor answer it: the approval service refuses them, `externalAgentHirer`), with what the
 * card shows (`AcpApprovalCard`). The turn's one board card (`runRef`, the card the queueing run left
 * open) parks on it, and the store's `resumed` moves it back when it is answered.
 *
 * ANSWERING. XiongBao's three choices become the request's own options: allow once → `allow_once`,
 * allow for this conversation → `allow_always`, deny → `reject_once`; an option the agent did not
 * offer falls back to the closest stricter one, never to a looser one. Each `(tenant, device,
 * requestId)` is opened once however often the device reports it; a report of one already answered
 * (the device reconnected before the answer reached it) is answered again. An answer the agent does
 * not recognise (`acp.error` `bad_option`) marks the approval failed and is not tried again.
 *
 * EXPIRING. A turn that ends (done, cancelled, interrupted, `ask_mode_lost`) takes its open
 * approvals with it, and its card is not left parked.
 */

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** What each rule is called on the hire settings page. */
export const ACP_RULE_LABELS: Record<AcpRuleKey, string> = {
  editInside: "改工作文件夹里的文件",
  touchOutside: "动工作文件夹以外的文件",
  runCommand: "运行命令",
  network: "联网下载、装依赖",
  push: "提交并推送代码",
};

const ACP_RULE_KEYS = Object.keys(ACP_RULE_DEFAULTS) as AcpRuleKey[];

/** The ACP tool kinds XiongBao knows; anything else is `other`. */
const KNOWN_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
]);

/** What each kind of request is, in the card's one sentence. */
const VERBS: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  delete: "删除文件",
  move: "移动文件",
  search: "搜索文件",
  execute: "运行命令",
  think: "思考",
  fetch: "联网获取内容",
  switch_mode: "切换工作模式",
  other: "执行一个操作",
};

/** Said where a request is refused, expired, or its answer went astray. */
export const ACP_PERMISSION_EXPIRED = "这一轮已经结束，这条许可请求作废了。";
export const ACP_EMPLOYEE_GONE = "这位外部员工已不在了，许可请求已拒绝。";
export const ACP_BAD_OPTION =
  "外部员工没有认出这个回答，已按取消处理。请让它再试一次。";

/**
 * A request's kind, lower case: one XiongBao knows, `switch_mode`, or else `other` (a kind it does
 * not know, misspelt, or not a kind at all), which is asked about every time.
 */
export function kindOfRequest(value: unknown): string {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KNOWN_KINDS.has(kind) || kind === "switch_mode" ? kind : "other";
}

/** A permission request as the rules read it. */
export type AcpPermissionAsk = {
  kind: string;
  title: string;
  rawInput: unknown;
  facts: { insideWorkdir: boolean | null; paths?: string[] };
  /** Whose request it is, for the policy engine: the hirer and the employee. */
  actorId?: string;
  botId?: string;
  continuation?: ApprovalContinuation;
};

/** The shells whose `-c` argument is the command an argv runs. */
const SHELLS =
  /^(?:.*[\\/])?(bash|sh|zsh|dash|fish|pwsh|powershell|cmd)(\.exe)?$/i;
const SHELL_FLAG = /^(-c|-lc|-ic|-command|\/c)$/i;

/**
 * The command line an `execute` request runs: `rawInput.command` as a string (Claude Code, Hermes)
 * or an argv (Codex; a shell wrapper unwrapped to what it runs). Null when there is none to read.
 */
export function commandOf(rawInput: unknown): string | null {
  if (typeof rawInput === "string") return str(rawInput);
  const raw = record(rawInput);
  const command = raw?.command ?? raw?.cmd ?? raw?.commandLine;
  if (typeof command === "string") return str(command);
  if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === "string")
  ) {
    const argv = command as string[];
    const flag = argv.findIndex(
      (part, index) => index > 0 && SHELL_FLAG.test(part),
    );
    if (SHELLS.test(argv[0] as string) && flag > 0 && flag === argv.length - 2)
      return str(argv[flag + 1]);
    return str(argv.join(" "));
  }
  return null;
}

const urlOf = (rawInput: unknown): string | null => {
  const raw = record(rawInput);
  return str(raw?.url) ?? str(raw?.uri);
};

export type AcpClassified = {
  /** The rules the request falls under, in name order. */
  rules: AcpRuleKey[];
  candidate: ApprovalCandidate;
  kind: string;
  /** For `execute`: the command line, or null when it could not be read. */
  command: string | null;
  /** For `execute`: what the command line does. */
  analysis?: CommandAnalysis;
  url: string | null;
  paths: string[];
  /** A kind XiongBao does not know (`other`, a misspelling): asked every time. */
  unrecognised: boolean;
};

const PATH_KINDS = new Set(["read", "edit", "move", "delete", "search"]);

/**
 * Which of the five rules a request falls under, and the action the policy engine weighs: the tool
 * `acp/<kind>`, the command in `args.command` (as `computer_run_command` carries it), a path
 * request's paths (relative to the working folder; a file name only, outside it) or a fetch's URL.
 * A path the device could not place (`insideWorkdir: null`) is outside. An `execute` request's
 * `scope` names its exact command (`<rules>:<commandKey of the line>`), so "allow for this
 * conversation" covers that command and no other.
 */
export function classifyRequest(req: AcpPermissionAsk): AcpClassified {
  const kind = kindOfRequest(req.kind);
  const inside = req.facts.insideWorkdir === true;
  const paths = (req.facts.paths ?? []).filter(
    (path): path is string => typeof path === "string",
  );
  const command = kind === "execute" ? commandOf(req.rawInput) : null;
  const analysis = kind === "execute" ? analyseCommand(command) : undefined;
  const url = kind === "fetch" ? urlOf(req.rawInput) : null;
  const rules = new Set<AcpRuleKey>();
  if (kind === "edit" || kind === "move" || kind === "delete")
    rules.add(inside ? "editInside" : "touchOutside");
  else if ((kind === "read" || kind === "search") && !inside)
    rules.add("touchOutside");
  else if (kind === "execute") {
    rules.add("runCommand");
    if (analysis?.network) rules.add("network");
    if (analysis?.push) rules.add("push");
    if (req.facts.insideWorkdir === false) rules.add("touchOutside");
  } else if (kind === "fetch") rules.add("network");
  const unrecognised = !KNOWN_KINDS.has(kind);
  const sorted = [...rules].sort();
  const ruleScope = sorted.join("+") || "none";
  const args: Loose =
    kind === "execute"
      ? command === null
        ? {}
        : { command }
      : kind === "fetch"
        ? url === null
          ? { title: req.title }
          : { url }
        : PATH_KINDS.has(kind)
          ? { paths }
          : { title: req.title };
  return {
    rules: sorted,
    kind,
    command,
    ...(analysis ? { analysis } : {}),
    url,
    paths,
    unrecognised,
    candidate: {
      actorId: req.actorId ?? "",
      botId: req.botId ?? "",
      toolRef: `acp/${kind}`,
      effect:
        kind === "read" || kind === "search" || kind === "think"
          ? "read"
          : "write",
      scope: unrecognised
        ? "other"
        : analysis
          ? `${ruleScope}:${command === null ? "unreadable" : commandKey(command)}`
          : ruleScope,
      args,
      ...(kind === "delete" ? { destructive: true as const } : {}),
      ...(req.continuation ? { continuation: req.continuation } : {}),
    },
  };
}

/**
 * The kind of request "allow for this conversation" lets through for the rest of a thread: the same
 * tool under the same rules. Stored as a conversation answer (`approval_conversation_grants`), whose
 * `toolRef` and `scope` are exactly these.
 */
export function acpAllowKey(candidate: {
  toolRef: string;
  scope: string;
}): string {
  return `${candidate.toolRef}|${candidate.scope}`;
}

/** An employee's saved rules (`agents.configuration.permissions`): defaults where missing, ask where unreadable. */
export function acpRulesOf(
  configuration: unknown,
): Record<AcpRuleKey, AcpRuleValue> {
  const saved = record(record(configuration)?.permissions) ?? {};
  const rules = { ...ACP_RULE_DEFAULTS };
  for (const key of ACP_RULE_KEYS) {
    if (!(key in saved)) continue;
    const value = saved[key];
    rules[key] =
      value === "direct" ||
      value === "ask" ||
      (value === "dangerous" && key === "runCommand")
        ? value
        : "ask";
  }
  return rules;
}

export type AcpPermissionDecision =
  | { kind: "allow"; because: string }
  | { kind: "deny"; reason: string }
  | {
      kind: "ask";
      offerConversation: boolean;
      /** Stored with the approval: why it asks, and whether a standing answer is offered. */
      policy: ApprovalPolicyOutcome;
      /** The rule or floor it hit, for the card. */
      because: string;
    };

/** Who a refusal came from, as the conversation names it. */
const REFUSED_BY: Record<string, string> = {
  team_rule: "管理员的规则",
  owner_rule: "员工主人的规则",
  personal_rule: "你的规则",
  host_command_cap: "团队的电脑命令设置",
};

/** The floors the engine names: asked every time, never answered for the conversation. */
const FLOOR_SOURCES = new Set([
  "safety",
  "destructive_tool",
  "outbound_send",
  "share_access",
  "publish_post",
]);

const FLOOR_NAMES: Record<string, string> = {
  safety: "底线：付款、凭据或安全设置",
  destructive_tool: "底线：删除",
  outbound_send: "底线：对外发消息或邮件",
  share_access: "底线：分享或改变谁能访问",
  publish_post: "底线：公开发布",
};

/** Asked every time with allow once and deny only, whatever the source. */
function onceOnly(policy: ApprovalPolicyOutcome): ApprovalPolicyOutcome {
  const { kind, review, ruleId, reason, source } = policy;
  return {
    behaviour: "ask",
    source,
    reason,
    ...(kind ? { kind } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(review ? { review } : {}),
    ...(ONCE_ONLY_SOURCES.has(source) ? {} : { closed: true as const }),
  };
}

/**
 * Why the rule for running commands asks about this command line, or undefined when it does not.
 * `direct`: only a line that does not come apart cleanly (floors and risky lines are asked before
 * this). `dangerous`: everything but a clean line of allowlisted commands the SEC1 tables pass
 * (command-allowlist.ts). `ask`, and anything that is not a choice: always.
 */
function runCommandAsks(
  value: string | undefined,
  analysis: CommandAnalysis,
): string | undefined {
  if (value === "direct")
    return analysis.clean
      ? undefined
      : `这条命令${analysis.unclean ?? "拆不干净"}，先问你。`;
  if (value === "dangerous") {
    if (analysis.danger) return analysis.danger;
    if (commandAllowlisted(analysis)) return undefined;
    return analysis.clean
      ? "这条命令不在常见只读和开发命令的名单里，先问你。"
      : `这条命令${analysis.unclean ?? "拆不干净"}，先问你。`;
  }
  return `「${ACP_RULE_LABELS.runCommand}」设成了先问你。`;
}

/** Said when a request is refused because it would leave the ask-first mode. */
export const ACP_SWITCH_MODE_REFUSED =
  "外部员工不能自己离开「先请求许可」的模式，已拒绝。";

/**
 * What XiongBao does with one permission request, layer by layer (see the top of this file).
 * `policy` is the deployment's engine for the hirer (`approvalService.policyOutcome`), which reads
 * the team's and the hirer's rules, the admin's settings and the employee's tool permissions; with
 * no answer from it, the request is asked about, once.
 */
export async function resolvePermission(input: {
  request: AcpPermissionAsk;
  employeeRules: Record<AcpRuleKey, string>;
  threadAllows: Set<string>;
  policy: (
    candidate: ApprovalCandidate,
  ) => Promise<ApprovalPolicyOutcome | undefined>;
  /** `classifyRequest(request)`, when the caller already has it: a request is classified once. */
  classified?: AcpClassified;
}): Promise<AcpPermissionDecision> {
  const classified = input.classified ?? classifyRequest(input.request);
  const { candidate, analysis } = classified;
  // The agent may not leave the mode that makes it ask: refused, whoever would have said yes.
  if (classified.kind === "switch_mode")
    return { kind: "deny", reason: ACP_SWITCH_MODE_REFUSED };
  const outcome = await input.policy(candidate);
  const once = (
    policy: ApprovalPolicyOutcome,
    because: string,
  ): AcpPermissionDecision => ({
    kind: "ask",
    offerConversation: false,
    policy: onceOnly(policy),
    because,
  });

  // Layer 2: refused outright, the rule named.
  if (outcome?.behaviour === "deny") {
    const by = REFUSED_BY[outcome.source] ?? "管理员的设置";
    return {
      kind: "deny",
      reason: `已按${by}自动拒绝${outcome.ruleId ? `（规则 ${outcome.ruleId}）` : ""}。`,
    };
  }
  const floor = safetyRequirement(candidate);
  if (outcome?.behaviour === "hand_off") {
    // The admin left this kind of action to people themselves: an agent cannot do it for them.
    if (
      outcome.source === "safety" &&
      outcome.kind !== undefined &&
      !outcome.review &&
      floor?.behaviour === "ask"
    )
      return {
        kind: "deny",
        reason: `已按管理员的设置自动拒绝：${outcome.reason}`,
      };
    // Layer 1 (paying, credentials, security settings), or a rule or the reviewer handing it to
    // the person: the person decides, once.
    return once(
      outcome,
      outcome.source === "safety"
        ? (FLOOR_NAMES.safety as string)
        : (REFUSED_BY[outcome.source] ?? "审查"),
    );
  }
  // Layer 1: the engine's floors, then the same floors read here again, and the command's own.
  if (outcome?.behaviour === "ask" && FLOOR_SOURCES.has(outcome.source))
    return once(outcome, FLOOR_NAMES[outcome.source] ?? "底线");
  if (floor) {
    const source = floor.behaviour === "hand_off" ? "safety" : floor.id;
    return once(
      { behaviour: "ask", source, reason: floor.reason },
      FLOOR_NAMES[source] ?? "底线",
    );
  }
  if (analysis?.floor)
    return once(
      {
        behaviour: "ask",
        source: analysis.floor.source,
        reason: analysis.floor.reason,
      },
      FLOOR_NAMES[analysis.floor.source] as string,
    );
  if (analysis?.risky)
    return once(
      { behaviour: "ask", source: "acp_rule", reason: analysis.risky },
      "危险命令",
    );
  // No answer from the engine: asked, never let through.
  if (!outcome)
    return once(
      {
        behaviour: "ask",
        source: "acp_rule",
        reason: "拿不到审批策略，先问你。",
      },
      "审批策略",
    );
  // A kind XiongBao does not know may be anything, a floor included: asked, every time.
  if (classified.unrecognised)
    return once(
      {
        behaviour: "ask",
        source: "acp_rule",
        reason: "这个操作不在五项规则里，每次都先问你。",
      },
      "其他操作",
    );
  /*
   * "Allow for this conversation": a command only as exactly this command, only a clean one, and
   * never one the SEC1 tables call dangerous or that names a file that may hold secrets; a file
   * request only inside the working folder.
   */
  const standing = analysis
    ? analysis.clean && !analysis.danger
    : !classified.rules.includes("touchOutside");
  const allowed = standing && input.threadAllows.has(acpAllowKey(candidate));
  // Layer 3: a custom rule, or the reviewer, asks. The engine's own "ask before changes" default
  // is not one: the employee's five rules decide instead.
  if (outcome.behaviour === "ask" && outcome.source !== "default") {
    const offerConversation =
      standing && offersStandingRule({ policy: outcome });
    if (offerConversation && allowed)
      return { kind: "allow", because: "这次对话里已允许" };
    return {
      kind: "ask",
      offerConversation,
      policy: offerConversation ? outcome : onceOnly(outcome),
      because: REFUSED_BY[outcome.source] ?? "审查",
    };
  }
  // Layer 4: the employee's own rules, strictest first. The hirer's global approvals switch does
  // not relax them (spec layer 5).
  const asking: { label: string; reason: string }[] = [];
  for (const key of classified.rules) {
    const value = input.employeeRules[key];
    if (key === "runCommand" && analysis) {
      const why = runCommandAsks(value, analysis);
      if (why) asking.push({ label: ACP_RULE_LABELS.runCommand, reason: why });
      continue;
    }
    if (value === "direct") continue;
    // `ask`, and anything that is not a choice, asks.
    asking.push({
      label: ACP_RULE_LABELS[key],
      reason: `「${ACP_RULE_LABELS[key]}」设成了先问你。`,
    });
  }
  if (asking.length === 0) return { kind: "allow", because: "规则允许" };
  if (allowed) return { kind: "allow", because: "这次对话里已允许" };
  const labels = [...new Set(asking.map((entry) => entry.label))];
  return {
    kind: "ask",
    offerConversation: standing,
    policy: {
      behaviour: "ask",
      source: "acp_rule",
      reason: [...new Set(asking.map((entry) => entry.reason))].join(""),
      ...(standing ? {} : { closed: true as const }),
    },
    because: labels.join("、"),
  };
}

/**
 * Who may answer an approval, for `createApprovalService`'s `externalAgentHirer`: undefined when it
 * is not an external employee's; its employee's hirer when that is whom it was opened for; null
 * (nobody) otherwise. Read as `platform`: the approval lives in the hirer's tenant, and whoever is
 * refused must learn it is not theirs (403), not that it is missing. Only the answer leaves.
 */
export function createAcpApprovalHirer(
  database: Database,
): (approvalId: string) => Promise<string | null | undefined> {
  return async (approvalId) => {
    const [row] = await asPlatform(() =>
      database
        .select({
          ownerUserId: approvalRequests.ownerUserId,
          toolRef: sql<string | null>`${approvalRequests.action}->>'toolRef'`,
          botId: sql<string | null>`${approvalRequests.action}->>'botId'`,
        })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalId))
        .limit(1),
    );
    if (!row || !isAcpAction({ toolRef: row.toolRef ?? "" })) return undefined;
    if (!row.botId) return null;
    const hirer = await ownerTenantOfBot(database, row.botId);
    return hirer !== null && hirer === row.ownerUserId ? hirer : null;
  };
}

/** What an external employee's approval card shows, beside the command or paths in its `args`. */
export type AcpApprovalCard = {
  employee: string;
  computer: string;
  /** One sentence, made here from the request's kind and title. */
  action: string;
  /** The rule or floor it hit. */
  hit: string;
  reason: string;
  /** What this turn has done so far. */
  summary: string;
  /** The files this turn has changed so far. */
  files: string[];
  offerConversation: boolean;
  deviceId: string;
  requestId: string;
  turnId: string;
  /** The tool call the request is about, as the transcript names it (`<runId>:<agent's id>`). */
  toolCallId?: string;
  /** The device's options, to answer from the approval alone on any server. */
  options: AcpPermissionOptionFrame[];
};

/** The card of an external employee's approval, or null for any other approval. */
export function acpCardOf(
  action: Pick<ApprovalAction, "toolRef" | "target">,
): AcpApprovalCard | null {
  if (!isAcpAction(action)) return null;
  const card = record(record(action.target)?.acp);
  return card ? (card as AcpApprovalCard) : null;
}

const OPTION_ORDER: Record<
  "allow_once" | "allow_always" | "reject_once",
  string[]
> = {
  // Never a looser answer than the one given: an agent told "always" stops asking.
  allow_once: ["allow_once", "reject_once", "reject_always"],
  allow_always: ["allow_always", "allow_once", "reject_once", "reject_always"],
  reject_once: ["reject_once", "reject_always"],
};

/** The request's own option for an answer; null (`cancelled`) when it offered nothing close. */
export function optionFor(
  options: readonly AcpPermissionOptionFrame[],
  want: keyof typeof OPTION_ORDER,
): string | null {
  for (const kind of OPTION_ORDER[want]) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  return null;
}

/** What a settled approval answers the agent. */
function answerOf(
  request: Pick<ApprovalRecord, "status" | "decision" | "result">,
): "allow_once" | "allow_always" | "reject_once" | null {
  if (request.status === "pending") return null;
  if (request.decision === "deny") return "reject_once";
  if (request.decision === "allow_conversation") return "allow_always";
  if (request.decision) return "allow_once";
  // Closed without a decision: withdrawn because the person's rules or switch now let it through,
  // or expired (its turn is over, and nothing is waiting for it).
  const content = request.result?.content;
  return content === WITHDRAWN_RULE_ALLOWS ||
    content === WITHDRAWN_APPROVALS_OFF
    ? "allow_once"
    : "reject_once";
}

const parseOptions = (value: unknown): AcpPermissionOptionFrame[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const option = record(entry);
        const optionId = str(option?.optionId);
        return optionId
          ? [
              {
                optionId,
                kind: typeof option?.kind === "string" ? option.kind : "",
                name: typeof option?.name === "string" ? option.name : "",
              },
            ]
          : [];
      })
    : [];

export type AcpEmployeeForPermission = {
  name: string;
  /** The computer's name, as the hirer paired it. */
  computer: string;
  rules: Record<AcpRuleKey, AcpRuleValue>;
};

/**
 * The employee a permission request is from, read in its hirer's tenant (the bridge's frame): its
 * name, its rules (`agents.configuration.permissions`), and the computer's name. Null when it is no
 * longer an external employee there.
 */
export function createAcpEmployeeLoader(
  database: Database,
  devices: {
    list(tenantId: string): Promise<{ deviceId: string; name: string }[]>;
  },
): (request: AcpPermissionRequest) => Promise<AcpEmployeeForPermission | null> {
  return async (request) => {
    const [row] = await database
      .select({
        name: agents.name,
        type: agents.type,
        configuration: agents.configuration,
      })
      .from(agents)
      .where(eq(agents.id, request.agentId))
      .limit(1);
    if (row?.type !== "device_acp") return null;
    const device = (await devices.list(request.tenantId)).find(
      (entry) => entry.deviceId === request.deviceId,
    );
    return {
      name: row.name,
      computer: device?.name ?? "这台电脑",
      rules: acpRulesOf(row.configuration),
    };
  };
}

export type AcpPermissionBridgeDeps = {
  relay: Pick<AcpRelay, "send" | "subscribe">;
  turns: Pick<AcpTurnStore, "get">;
  /** The approval store as the approval service holds it (`approvalService.store`). */
  approvals: ApprovalStore;
  /** `approvalService.onDecided`. */
  onDecided: (
    listener: (request: ApprovalRecord, decision: ApprovalDecision) => void,
  ) => () => void;
  /** `approvalService.policyOutcome`: the engine for one action, audited, nothing opened. */
  policy: (
    candidate: ApprovalCandidate,
  ) => Promise<ApprovalPolicyOutcome | undefined>;
  board: Pick<TaskProjector, "needsAction" | "resumed">;
  /** The employee as its hirer's tenant has it, or null when it is gone. */
  employee: (
    request: AcpPermissionRequest,
  ) => Promise<AcpEmployeeForPermission | null>;
  /** Calls `tick` every `ms` until stopped. Injected for a test's clock. */
  every?: (ms: number, tick: () => void) => () => void;
  /** How often settled approvals, unsent answers and ended turns are looked for. */
  pollMs?: number;
  log?: (message: string) => void;
};

export type AcpPermissionBridge = {
  /** A permission request of a run (`AcpPermissionHook`). Never throws. */
  onRequest(request: AcpPermissionRequest): Promise<void>;
  /** One pass of what the timer does: answers decided elsewhere, unsent answers, ended turns. */
  poll(): Promise<void>;
  dispose(): void;
};

type Entry = {
  key: string;
  request: AcpPermissionRequest;
  requestId: string;
  options: AcpPermissionOptionFrame[];
  /**
   * `resolving`: being decided. `retry`: deciding failed, tried again on the next poll.
   * `waiting`: an approval is open. `unsent` / `answered`: the answer could not be / was written.
   * `over`: nothing more is done (the turn ended, or the answer was refused).
   */
  state: "resolving" | "retry" | "waiting" | "unsent" | "answered" | "over";
  approvalId?: string;
  toolCallId?: string;
  runId?: string;
  /** The board card was parked on the approval. */
  parked: boolean;
  /** The option answered, `null` for cancelled; undefined until there is one. */
  answer?: string | null;
};

type WatchedTurn = {
  tenantId: string;
  turnId: string;
  entries: Set<Entry>;
  /** The request answered last: the one an `acp.error` `bad_option` is about. */
  lastAnswered?: Entry;
  ended: boolean;
  unsubscribe: () => void;
};

const defaultEvery = (ms: number, tick: () => void) => {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export function createAcpPermissionBridge(
  deps: AcpPermissionBridgeDeps,
): AcpPermissionBridge {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const entries = new Map<string, Entry>();
  const byApproval = new Map<string, Entry>();
  const watched = new Map<string, WatchedTurn>();

  const keyOf = (request: AcpPermissionRequest, requestId: string) =>
    JSON.stringify([request.tenantId, request.deviceId, requestId]);
  const say = (entry: Entry, text: string) => {
    try {
      entry.request.say?.(text);
    } catch (error) {
      log(
        `acp permissions: could not say it in the conversation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const inTenant = <T>(entry: Entry, work: () => Promise<T>) =>
    runAsTenant(entry.request.tenantId, work);

  function forget(entry: Entry) {
    entry.state = "over";
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (entry.approvalId && byApproval.get(entry.approvalId) === entry)
      byApproval.delete(entry.approvalId);
  }

  /** Writes the answer to the device; kept to send again while it is away. */
  function answer(entry: Entry, optionId: string | null) {
    if (entry.state === "over") return;
    entry.answer = optionId;
    const { request } = entry;
    const sent = deps.relay.send(
      { tenantId: request.tenantId, deviceId: request.deviceId },
      {
        type: "acp.permission.answer",
        agentId: request.agentId,
        requestId: entry.requestId,
        optionId,
      },
    );
    entry.state = sent ? "answered" : "unsent";
    const turn = watched.get(request.turnId);
    if (turn && sent) turn.lastAnswered = entry;
  }

  /** The card goes back to running: it parked on this approval. Idempotent. */
  async function unpark(entry: Entry) {
    if (!entry.parked || !entry.approvalId) return;
    entry.parked = false;
    await deps.board
      .resumed({
        tenantId: entry.request.tenantId,
        approvalId: entry.approvalId,
        failed: false,
      })
      .catch((error: unknown) =>
        log(
          `acp permissions: the card of approval ${entry.approvalId} could not move back: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /** An approval that is settled answers the agent. */
  async function settle(entry: Entry, request: ApprovalRecord) {
    if (entry.state !== "waiting") return;
    const wanted = answerOf(request);
    if (!wanted) return;
    answer(entry, optionFor(entry.options, wanted));
    await unpark(entry);
  }

  /**
   * The turn is over: its approval, if still open, expires (only a pending one is touched), and its
   * card does not stay parked.
   */
  async function expire(entry: Entry) {
    forget(entry);
    if (!entry.approvalId || entry.answer !== undefined) return;
    const { toolCallId, runId } = entry;
    await inTenant(entry, async () => {
      await deps.approvals.policy?.withdrawPending(
        entry.request.ownerUserId,
        ACP_PERMISSION_EXPIRED,
        (action) =>
          isAcpAction(action) &&
          action.toolCallId === toolCallId &&
          action.runId === runId,
        { resume: false },
      );
    }).catch((error: unknown) =>
      log(
        `acp permissions: approval ${entry.approvalId} could not be expired: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    await unpark(entry);
  }

  async function endTurn(turnId: string) {
    const turn = watched.get(turnId);
    if (!turn) return;
    turn.ended = true;
    turn.unsubscribe();
    watched.delete(turnId);
    for (const entry of [...turn.entries]) await expire(entry);
  }

  async function answerRefused(turnId: string) {
    const entry = watched.get(turnId)?.lastAnswered;
    if (!entry) return;
    log(
      `acp permissions: the agent did not take the answer to request ${entry.requestId} of turn ${turnId}`,
    );
    // Kept, settled: a report of the same request is not answered again, so nothing loops.
    entry.state = "over";
    if (entry.approvalId) byApproval.delete(entry.approvalId);
    say(entry, ACP_BAD_OPTION);
    if (entry.approvalId)
      await inTenant(entry, () =>
        deps.approvals.saveResult(
          entry.request.ownerUserId,
          entry.approvalId as string,
          { content: ACP_BAD_OPTION, error: ACP_BAD_OPTION },
        ),
      ).catch((error: unknown) =>
        log(
          `acp permissions: approval ${entry.approvalId} could not be marked failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  function watch(entry: Entry) {
    const { tenantId, turnId } = entry.request;
    let turn = watched.get(turnId);
    if (!turn) {
      const fresh: WatchedTurn = {
        tenantId,
        turnId,
        entries: new Set(),
        ended: false,
        unsubscribe: () => undefined,
      };
      fresh.unsubscribe = deps.relay.subscribe(turnId, (frame) => {
        if (frame.type === "acp.turn.end") void endTurn(turnId);
        else if (frame.type === "acp.error" && frame.code === "ask_mode_lost")
          void endTurn(turnId);
        else if (frame.type === "acp.error" && frame.code === "bad_option")
          void answerRefused(turnId);
      });
      watched.set(turnId, fresh);
      turn = fresh;
    }
    turn.entries.add(entry);
  }

  const turnEnded = (entry: Entry) =>
    entry.state === "over" || watched.get(entry.request.turnId) === undefined;

  /** One sentence for the card, made here from the request's kind and title. */
  const sentence = (name: string, kind: string, title: string) =>
    `${name}想要${VERBS[kind] ?? VERBS.other}${title ? `：${clip(title, 200)}` : ""}`;

  async function resolve(entry: Entry) {
    const { request } = entry;
    const frame = request.frame;
    const toolCall = record(frame.toolCall) ?? {};
    const facts = record(frame.facts);
    const employee = await deps.employee(request);
    if (turnEnded(entry)) return;
    if (!employee) {
      answer(entry, optionFor(entry.options, "reject_once"));
      say(entry, ACP_EMPLOYEE_GONE);
      return;
    }
    const kind = kindOfRequest(toolCall.kind);
    const title = typeof toolCall.title === "string" ? toolCall.title : "";
    const runId = `acp:${request.turnId}`;
    const toolCallId = `acp:${request.deviceId}:${entry.requestId}`;
    const ask: AcpPermissionAsk = {
      kind,
      title,
      rawInput: toolCall.rawInput,
      facts: {
        insideWorkdir:
          typeof facts?.insideWorkdir === "boolean"
            ? facts.insideWorkdir
            : null,
        paths: Array.isArray(facts?.paths)
          ? facts.paths.filter(
              (path): path is string => typeof path === "string",
            )
          : [],
      },
      actorId: request.ownerUserId,
      botId: request.agentId,
      continuation: {
        runId,
        threadId: request.threadId,
        toolCallId,
        toolName: `acp/${kind}`,
        args: {},
        messages: [],
        state: {},
        context: [],
        forwardedProps: {},
      },
    };
    const grants =
      (await deps.approvals.policy?.conversationGrants?.(
        request.ownerUserId,
        request.threadId,
      )) ?? [];
    const threadAllows = new Set(
      grants
        .filter(
          (grant) => grant.botId === request.agentId && isAcpAction(grant),
        )
        .map(acpAllowKey),
    );
    // Classified once: what is decided and what the approval stores are the same reading.
    const classified = classifyRequest(ask);
    const decided = await resolvePermission({
      request: ask,
      classified,
      employeeRules: employee.rules,
      threadAllows,
      policy: (candidate) => deps.policy(candidate),
    });
    if (turnEnded(entry)) return;
    if (decided.kind === "allow") {
      answer(entry, optionFor(entry.options, "allow_once"));
      return;
    }
    if (decided.kind === "deny") {
      answer(entry, optionFor(entry.options, "reject_once"));
      say(entry, `${sentence(employee.name, kind, title)}。${decided.reason}`);
      return;
    }
    const progress = request.progress ?? { done: [], files: [] };
    const agentCallId = str(toolCall.toolCallId);
    const card: AcpApprovalCard = {
      employee: employee.name,
      computer: employee.computer,
      action: sentence(employee.name, kind, title),
      hit: decided.because,
      reason: decided.policy.reason,
      summary:
        progress.done.length > 0
          ? `这一轮已完成：${progress.done
              .slice(-5)
              .map((step) => clip(step, 120))
              .join("；")}`
          : "这一轮还没有完成别的步骤。",
      files: progress.files.slice(0, 50),
      offerConversation: decided.offerConversation,
      deviceId: request.deviceId,
      requestId: entry.requestId,
      turnId: request.turnId,
      ...(agentCallId ? { toolCallId: `${request.runId}:${agentCallId}` } : {}),
      options: entry.options,
    };
    const action: ApprovalAction = {
      ...approvalAction({ ...classified.candidate, target: { acp: card } }),
      policy: decided.policy,
    };
    entry.runId = runId;
    entry.toolCallId = toolCallId;
    const opened = await deps.approvals.open(action);
    entry.approvalId = opened.id;
    byApproval.set(opened.id, entry);
    entry.state = "waiting";
    if (opened.status !== "pending") {
      // Opened before (another server, or before a restart) and answered since.
      await settle(entry, opened);
      return;
    }
    if (turnEnded(entry)) {
      await expire(entry);
      return;
    }
    entry.parked = true;
    await deps.board.needsAction({
      tenantId: request.tenantId,
      runRef: request.runRef,
      approvalId: opened.id,
    });
    // The turn ended while the card was being parked: it must not stay parked.
    if (turnEnded(entry)) await unpark(entry);
  }

  async function decide(entry: Entry) {
    entry.state = "resolving";
    try {
      await inTenant(entry, () => resolve(entry));
    } catch (error) {
      if (entry.state === "resolving") entry.state = "retry";
      log(
        `acp permissions: request ${entry.requestId} of turn ${entry.request.turnId} could not be decided, tried again shortly: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A request reported again: the device reconnected while it still waits. */
  async function again(entry: Entry) {
    if (entry.state === "unsent" || entry.state === "answered") {
      answer(entry, entry.answer ?? null);
      return;
    }
    if (entry.state === "retry") {
      await decide(entry);
      return;
    }
    if (entry.state === "waiting" && entry.approvalId) {
      const approvalId = entry.approvalId;
      const request = await inTenant(entry, () =>
        deps.approvals.get(entry.request.ownerUserId, approvalId),
      ).catch(() => null);
      if (request) await settle(entry, request);
    }
  }

  /** Decided on a server that does not hold the request: answered from the approval itself. */
  function answerFromApproval(request: ApprovalRecord) {
    const card = acpCardOf(request.action);
    const wanted = answerOf(request);
    if (!card || !wanted || !card.deviceId || !card.requestId) return;
    deps.relay.send(
      { tenantId: request.ownerUserId, deviceId: card.deviceId },
      {
        type: "acp.permission.answer",
        agentId: request.action.botId,
        requestId: card.requestId,
        optionId: optionFor(parseOptions(card.options), wanted),
      },
    );
  }

  const stopListening = deps.onDecided((request) => {
    if (!isAcpAction(request.action)) return;
    const entry = byApproval.get(request.id);
    if (entry) void settle(entry, request);
    else answerFromApproval(request);
  });

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const entry of [...entries.values()]) {
        if (entry.state === "unsent") answer(entry, entry.answer ?? null);
        else if (entry.state === "retry") await decide(entry);
        else if (entry.state === "waiting" && entry.approvalId) {
          const approvalId = entry.approvalId;
          const request = await inTenant(entry, () =>
            deps.approvals.get(entry.request.ownerUserId, approvalId),
          ).catch(() => null);
          if (request) await settle(entry, request);
        }
      }
      // A turn ended where this server was not told (stopped while its computer was away).
      for (const turn of [...watched.values()]) {
        const row = await runAsTenant(turn.tenantId, () =>
          deps.turns.get(turn.tenantId, turn.turnId),
        ).catch(() => undefined);
        if (row === null || (row && isFinalAcpTurnStatus(row.status)))
          await endTurn(turn.turnId);
      }
      // Answered (or refused) and nothing heard back: forgotten once their turn is.
      for (const entry of [...entries.values()])
        if (
          (entry.state === "answered" || entry.state === "over") &&
          !watched.has(entry.request.turnId)
        )
          forget(entry);
    } finally {
      polling = false;
    }
  }
  const stopPolling = (deps.every ?? defaultEvery)(deps.pollMs ?? 5_000, () => {
    void poll().catch((error: unknown) =>
      log(
        `acp permissions: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  });

  return {
    async onRequest(request) {
      const requestId = str(request.frame.requestId);
      if (!requestId) return;
      const key = keyOf(request, requestId);
      const known = entries.get(key);
      if (known) {
        await again(known).catch((error: unknown) =>
          log(
            `acp permissions: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      const entry: Entry = {
        key,
        request,
        requestId,
        options: parseOptions(request.frame.options),
        state: "resolving",
        parked: false,
      };
      entries.set(key, entry);
      watch(entry);
      await decide(entry);
    },
    poll,
    dispose() {
      stopPolling();
      stopListening();
      for (const turn of watched.values()) turn.unsubscribe();
      watched.clear();
      entries.clear();
      byApproval.clear();
    },
  };
}
