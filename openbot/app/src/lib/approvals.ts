import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour =
  | "allow"
  | "pre_approved"
  | "ask"
  | "hand_off"
  | "deny";
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & { id: string };
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
};
/** 只给「允许一次」的底线：删除类、对外发送、分享与授权、公开发布。 */
const ONCE_ONLY_SOURCES: ReadonlySet<string> = new Set([
  "destructive_tool",
  "outbound_send",
  "share_access",
  "publish_post",
]);
/**
 * 这条请求能不能用「在这里总是允许」来回答。只给「允许一次」的底线问的动作每次都要问，存下的规则
 * 用不上（服务端也会拒绝），所以不给这个选项。与服务端 approvals/types 的 `offersStandingRule`
 * 同一个条件。
 */
export function offersStandingRule(
  policy: { source: string } | undefined,
): boolean {
  return !ONCE_ONLY_SOURCES.has(policy?.source ?? "");
}
export type ApprovalInboxData = {
  enabled: boolean;
  requests: {
    id: string;
    status: string;
    createdAt: string;
    action: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      threadId: string;
      toolCallId?: string;
      args: unknown;
      target: unknown;
      policy?: {
        behaviour: "allow" | "ask" | "hand_off" | "deny";
        source: string;
        reason: string;
      };
    };
  }[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
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
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: {
    id: string;
    botId: string;
    threadId: string;
    question: string;
    why?: string;
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
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallback: "你的决定没能保存。",
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
export const answerPersonQuestion = (id: string, response: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { response },
    fallback: "你的回答没能保存。",
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

/** A tool's mode on a Bot's permissions page (SEC1 §4.5): 直接, 询问 or 禁用. */
export type EmployeeToolMode = "direct" | "ask" | "disabled";
export const TOOL_MODE_LABELS: Record<EmployeeToolMode, string> = {
  direct: "直接",
  ask: "询问",
  disabled: "禁用",
};
/** The rule behaviour each mode is saved as, read back the same way. */
export const MODE_OF_BEHAVIOUR: Partial<Record<RuleBehaviour, EmployeeToolMode>> = {
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
