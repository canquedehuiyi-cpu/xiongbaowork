import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
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
};
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
