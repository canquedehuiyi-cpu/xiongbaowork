import { offersStandingRule as offersStandingRuleFor } from "@openbot/shared/standing-rule";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { client } from "@/lib/client";
export type ApprovalDecision =
  | "allow_once"
  | "allow_conversation"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour =
  | "allow"
  | "pre_approved"
  | "ask"
  | "hand_off"
  | "deny";
/** The kinds of action OpenBot asks about by name, as server/src/approvals/types.ts lists them. */
export type ActionKind =
  | "deleting"
  | "sending"
  | "sharing"
  | "publishing"
  | "payments"
  | "credentials"
  | "security_settings";
/** What the admin lets members do about a kind: open, ask every time, or leave it to them. */
export type ActionKindPolicy = "open" | "ask" | "hand_off";
/**
 * One "Allow for this conversation": what it allows, and in which conversation. Drawn in that
 * conversation, with a way to turn it off.
 */
export type ConversationGrant = {
  id: string;
  threadId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  account?: string;
  kind?: ActionKind;
  createdAt: string;
};
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & {
  id: string;
  /** The one account at the app a saved rule is for, where the person holds several. */
  account?: string | null;
};
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "不问直接做",
  pre_approved: "预先批准过才做",
  ask: "做之前先问",
  hand_off: "交给你来做",
  deny: "禁用",
};
/** Which layer settled a request, as the inbox names it. */
export const POLICY_SOURCE_LABELS: Record<string, string> = {
  safety: "安全底线",
  team_rule: "管理员设定",
  owner_rule: "员工所有者设定",
  personal_rule: "你的规则",
  dangerous_command: "危险命令",
  sensitive_path: "敏感文件",
  host_command_cap: "团队命令上限",
  app_tool: "本机应用",
  app_enable: "启用本机应用",
  // --- desktop control (sub-project 2) ---
  desktop_window: "敏感窗口",
  // --- end desktop control ---
  destructive_tool: "删除类操作",
  outbound_send: "对外发送",
  share_access: "分享与授权",
  publish_post: "公开发布",
  auto_review: "自动审查",
  default: "你的偏好",
  person_declined: "你已拒绝过",
  conversation: "这段对话里已允许",
  task: "检查任务每步都问",
};
/**
 * 这条请求能不能用「在这里总是允许」来回答。只给「允许一次」的底线（删除类、对外发送、分享与授权、
 * 公开发布）和检查任务、安全底线问的动作每次都要问，存下的规则用不上（服务端也会拒绝），所以不给
 * 这个选项。名单只在 shared/standing-rule.ts 声明一次，服务端读的是同一份。
 */
export function offersStandingRule(
  policy: { source: string } | undefined,
): boolean {
  return offersStandingRuleFor({ policy });
}
export type ApprovalInboxData = {
  enabled: boolean;
  requests: {
    id: string;
    status: string;
    createdAt: string;
    /** When the person (or a rule) decided it; null while it waits. */
    decidedAt?: string | null;
    action: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      threadId: string;
      toolCallId?: string;
      args: unknown;
      target: unknown;
      /** Which of the person's accounts at the app, where they hold several. */
      account?: string;
      policy?: {
        behaviour: "allow" | "ask" | "hand_off" | "deny";
        source: string;
        reason: string;
        kind?: ActionKind;
        /** The admin set this kind to ask every time: Allow once and Deny only. */
        closed?: boolean;
      };
    };
  }[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
  /** "Allow for this conversation" answers still in force, in every conversation. */
  conversationGrants?: ConversationGrant[];
  preferences?: {
    enabled: boolean;
    autoReview: boolean;
    hostCommands: HostCommandPolicy;
  };
  team?: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommandPolicy;
    /** Every Bot asks before a dangerous command (SEC1 D10). */
    enforceDangerousCommands?: boolean;
    /** The kinds the admin closed. A kind not named is open. */
    actionKinds?: Partial<Record<ActionKind, ActionKindPolicy>>;
    /** The words that make a click on the computer ask every time; null or absent is the default list. */
    desktopActionWords?: string[] | null;
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: {
    id: string;
    botId: string;
    /** The Bot whose conversation this belongs to: for a hand-off, the Bot that handed it on. */
    conversationBotId?: string;
    threadId: string;
    /** The conversation it was asked in, which is where it is answered. */
    channelId?: string;
    question: string;
    why?: string;
    /** The separate decisions inside the question, each answered on its own. */
    parts?: { header: string; question: string; options?: string[] }[];
    createdAt: string;
  }[];
};
export const approvalInboxOptions = () =>
  queryOptions({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalInboxData> => {
      const response = await client("/api/approvals", {
        fallback: "读不到你的审批。",
      });
      return response.json();
    },
    refetchInterval: 10_000,
  });

/** One request as the inbox lists it. */
export type ApprovalRequestData = ApprovalInboxData["requests"][number];

/**
 * One of this person's requests by id (`GET /api/approvals/:id`). The inbox lists only the newest
 * hundred, so a card parked on an older request asks for that request alone. Keyed under `approvals`,
 * so a decision's refresh of the inbox refreshes this read too.
 */
export const approvalRequestOptions = (id: string) =>
  queryOptions({
    queryKey: ["approvals", "request", id],
    queryFn: async (): Promise<ApprovalRequestData> => {
      const response = await client(
        `/api/approvals/${encodeURIComponent(id)}`,
        { fallback: "读不到这条审批。" },
      );
      return response.json();
    },
  });

/**
 * A request the person has decided and the server has not finished carrying on from.
 *
 * Decided (`approved` or `denied`) or started (`consumed`), the server runs the action, or tells the
 * Bot it was declined, and then picks the conversation up where it stopped, in a turn no browser
 * streams. It marks the request `completed` only once that turn has ended. So between the two, the
 * conversation is the Bot's: the same fact a run on the wire is for a turn started here.
 */
const CARRYING_ON = new Set(["approved", "denied", "consumed"]);

/**
 * How long after the decision a request still counts as the server carrying on.
 *
 * The server stops a turn it carries on at five minutes (`TURN_LIMITS.turnTimeoutMs` in
 * toolkit/limits.ts), and this allows twice that, as the routine sweep does for a run. A request
 * still not `completed` after it is one the resume loop is retrying or giving up on, not a turn this
 * conversation is in, and counting it would leave "Thinking" and Stop up, and messages parked behind
 * them, for good.
 */
const CARRY_ON_MS = 2 * 5 * 60_000;

/** Whether the server is carrying this conversation on after one of its approvals was decided. */
export function carryingOnAfterApproval(
  inbox: ApprovalInboxData | undefined,
  threadId: string,
  now = Date.now(),
): boolean {
  return (inbox?.requests ?? []).some(
    (request) =>
      request.action.threadId === threadId &&
      CARRYING_ON.has(request.status) &&
      now - Date.parse(request.decidedAt ?? request.createdAt) < CARRY_ON_MS,
  );
}

/** Whether a conversation asks before every step, by its thread. Its own root: see below. */
export const approvalThreadKeys = {
  all: ["approval-thread"] as const,
  detail: (threadId: string) => ["approval-thread", threadId] as const,
};
/**
 * Whether this conversation asks before every step, which a task's started from a check-in does, as
 * the server's gate decides it. Never stale: a conversation is a task's from the moment it exists,
 * or never. Kept apart from `["approvals"]`, which every decision invalidates.
 */
export const threadAsksEveryStepQueryOptions = (threadId: string) =>
  queryOptions({
    queryKey: approvalThreadKeys.detail(threadId),
    queryFn: (): Promise<boolean> =>
      client(
        `/api/approvals/threads/${encodeURIComponent(threadId)}`,
        "asksEveryStep",
        { fallback: "读不到这段对话的审批设置。" },
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallback: "你的决定没能保存。",
  });
export const revokeConversationGrant = (id: string) =>
  client(`/api/approvals/conversation-grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "没能关掉，请再试一次。",
  });
export const revokeApprovalRule = (id: string) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "这项许可没能收回。",
  });
export const setApprovalEnabled = (enabled: boolean) =>
  setApprovalPreferences({ enabled });
export const setApprovalPreferences = (input: {
  enabled?: boolean;
  autoReview?: boolean;
  hostCommands?: HostCommandPolicy;
}) =>
  client("/api/approvals/preferences", {
    method: "PATCH",
    body: input,
    fallback: "你的审批偏好没能保存。",
  });
export const createApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/rules", {
    method: "POST",
    body: input,
    fallback: "这条规则没能保存。",
  });
export const setTeamApprovalSettings = (input: {
  enforceAutoReview?: boolean;
  customRulesEnabled?: boolean;
  hostCommandsCap?: HostCommandPolicy;
  enforceDangerousCommands?: boolean;
  actionKinds?: Partial<Record<ActionKind, ActionKindPolicy>>;
  /** Null puts the default list back. */
  desktopActionWords?: string[] | null;
}) =>
  client("/api/approvals/team", {
    method: "PATCH",
    body: input,
    fallback: "团队设置没能保存。",
  });
export const createTeamApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/team/rules", {
    method: "POST",
    body: input,
    fallback: "这条团队规则没能保存。",
  });
export const revokeTeamApprovalRule = (id: string) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "这条团队规则没能移除。",
  });
/**
 * Answer a question a Bot asked. Given in the open conversation (`inConversation`), it may be that
 * conversation's to carry on: true means the question is closed and the conversation runs the answer
 * as its own next turn; false means the server resumes the run that asked.
 */
export const answerPersonQuestion = async (
  id: string,
  response: string,
  inConversation = false,
) =>
  (await client<boolean | undefined>(
    `/api/approvals/questions/${encodeURIComponent(id)}/respond`,
    "continueHere",
    {
      method: "POST",
      body: inConversation ? { response, inConversation } : { response },
      fallback: "你的回答没能保存。",
    },
  )) === true;
export const dismissPersonQuestion = (id: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    fallback: "没能放下这个问题。",
  });
export const updateApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "这条规则没能修改。",
  });
export const updateTeamApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "这条团队规则没能修改。",
  });

/** The inbox's key, which every approval write invalidates: requests, rules and settings alike. */
export const approvalsKey = ["approvals"] as const;
const settle = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: approvalsKey });

export const approvalPreferencesMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setApprovalPreferences,
    onSettled: settle(queryClient),
  });
export const createApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
/** Turn off one "Allow for this conversation": the next such action there asks again. */
export const revokeConversationGrantMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: revokeConversationGrant,
    onSettled: settle(queryClient),
  });
export const revokeApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: revokeApprovalRule,
    onSettled: settle(queryClient),
  });
export const teamApprovalSettingsMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setTeamApprovalSettings,
    onSettled: settle(queryClient),
  });
export const createTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createTeamApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: revokeTeamApprovalRule,
    onSettled: settle(queryClient),
  });
/** Allow once, for this conversation or always, deny, or "I did it myself" on one waiting action. */
export const decideApprovalMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: settle(queryClient),
  });
/** Answer a question a Bot asked mid-run; the run resumes with the answer. */
export const answerPersonQuestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      response,
      inConversation,
    }: {
      id: string;
      response: string;
      inConversation?: boolean;
    }) => answerPersonQuestion(id, response, inConversation),
    /*
     * Answered is answered, whatever the turn that carries the answer comes to: the question's card
     * goes at once, and the badge that counted it is read again rather than on its next poll.
     */
    onSuccess: (_continueHere, { id }) => {
      queryClient.setQueryData<ApprovalInboxData>(approvalsKey, (inbox) =>
        inbox
          ? {
              ...inbox,
              questions: inbox.questions.filter(
                (question) => question.id !== id,
              ),
            }
          : inbox,
      );
      void queryClient.invalidateQueries({
        queryKey: botLifecycleKeys.attention,
      });
      return settle(queryClient)();
    },
  });

/** Put a question down unanswered. Everything is read again: a task waiting on it moves on too. */
export const dismissPersonQuestionMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({ id }: { id: string }) => dismissPersonQuestion(id),
    onSuccess: () => queryClient.invalidateQueries(),
  });

/** A tool's mode on a Bot's permissions page (SEC1 §4.5): 直接, 询问 or 禁用. */
export type EmployeeToolMode = "direct" | "ask" | "disabled";
export const TOOL_MODE_LABELS: Record<EmployeeToolMode, string> = {
  direct: "直接",
  ask: "询问",
  disabled: "禁用",
};
/** The rule behaviour each mode is saved as, read back the same way. */
export const MODE_OF_BEHAVIOUR: Partial<
  Record<RuleBehaviour, EmployeeToolMode>
> = {
  allow: "direct",
  ask: "ask",
  deny: "disabled",
};
export type FloorMode = "off" | "ask";
export type EmployeeSecurity = {
  dangerousCommands: FloorMode;
  sensitivePaths: FloorMode;
  extraSensitivePaths: string[];
  disabledDefaultPaths: string[];
};
export type EmployeePermissions = {
  botId: string;
  /** Only the Bot's owner changes these. */
  editable: boolean;
  /** Somebody else owns this Bot, and their settings apply to the person reading them (D9). */
  ownedByAnother: boolean;
  modes: { id: string; toolRef: string; behaviour: RuleBehaviour }[];
  teamRules: (ApprovalRuleRow & { effect: string; scope: string })[];
  security: EmployeeSecurity;
  defaultSensitivePaths: string[];
  enforceDangerousCommands: boolean;
  customRulesEnabled: boolean;
};
export const employeePermissionsOptions = (botId: string) =>
  queryOptions({
    queryKey: ["approvals", "employee", botId],
    queryFn: async (): Promise<EmployeePermissions> => {
      const response = await client(
        `/api/approvals/employees/${encodeURIComponent(botId)}`,
        { fallback: "读不到这位员工的权限。" },
      );
      return response.json();
    },
  });
export const setEmployeeToolMode = (
  botId: string,
  input: { toolRef: string; mode: EmployeeToolMode | "default" },
) =>
  client(`/api/approvals/employees/${encodeURIComponent(botId)}/tools`, {
    method: "PUT",
    body: input,
    fallback: "这个工具的权限没能保存。",
  });
export const setEmployeeSecurity = (
  botId: string,
  input: Partial<EmployeeSecurity>,
) =>
  client(`/api/approvals/employees/${encodeURIComponent(botId)}/security`, {
    method: "PATCH",
    body: input,
    fallback: "这位员工的安全设置没能保存。",
  });
/**
 * The tools a Bot's permissions disable outright: a 禁用 mode, or a team row disabling the tool for
 * every action and target. The server leaves them out of what the model is offered and refuses them
 * at the gate; the browser's own tools use this to hide themselves too (SEC1 D4).
 */
export function disabledToolRefs(permissions: EmployeePermissions | undefined) {
  const refs = new Set<string>();
  if (!permissions) return refs;
  for (const mode of permissions.modes)
    if (mode.behaviour === "deny") refs.add(mode.toolRef);
  for (const rule of permissions.teamRules)
    if (rule.behaviour === "deny" && rule.effect === "*" && rule.scope === "*")
      refs.add(rule.toolRef);
  return refs;
}
/** Whether `ref` falls under a disabled pattern; `*` matches any run of characters. */
export function toolIsDisabled(disabled: ReadonlySet<string>, ref: string) {
  for (const pattern of disabled) {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    if (new RegExp(`^${source}$`, "s").test(ref)) return true;
  }
  return false;
}

/**
 * Whether a rule's Bot field covers this Bot, matched the way the server matches it (`policy.ts`):
 * `*` is anything, and a `*` inside a value is any run of characters.
 */
export function ruleCoversBot(pattern: string, agentId: string): boolean {
  if (pattern === "*") return true;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(agentId);
}
