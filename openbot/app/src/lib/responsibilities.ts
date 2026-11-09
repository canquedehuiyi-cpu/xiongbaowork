import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ResponsibilityRecord = {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string;
  title: string;
  instruction: string;
  successCriteria: string;
  status: "active" | "paused" | "completed";
  progress: string;
  lastResult: string | null;
  subscriptions: {
    source:
      | "manual"
      | "slack"
      | "github"
      | "schedule"
      | "connector"
      | "webhook"
      | "linear"
      | "sentry"
      | "pagerduty"
      | "email";
    eventType: string;
  }[];
  updatedAt: string;
};
export type ResponsibilityRunRecord = {
  id: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
  replyText: string | null;
  error: string | null;
  waiting: { kind: string; requestId?: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};
export type GithubBindingRecord = {
  id: string;
  source: "github";
  repository: string;
  createdAt: string;
  webhookPath?: string;
};
export const responsibilityKeys = {
  all: ["responsibilities"] as const,
  runs: (id: string) => ["responsibilities", id, "runs"] as const,
  bindings: ["responsibilities", "github-bindings"] as const,
  triggers: (id: string) => ["responsibilities", id, "triggers"] as const,
};
export function responsibilitiesQueryOptions() {
  return queryOptions({
    queryKey: responsibilityKeys.all,
    queryFn: (): Promise<ResponsibilityRecord[]> =>
      client("/api/responsibilities", "responsibilities", {
        fallback: "读不到长期职责",
      }),
    refetchInterval: 10_000,
  });
}
export function responsibilityRunsQueryOptions(id: string) {
  return queryOptions({
    queryKey: responsibilityKeys.runs(id),
    queryFn: (): Promise<ResponsibilityRunRecord[]> =>
      client(`/api/responsibilities/${encodeURIComponent(id)}/runs`, "runs", {
        fallback: "读不到长期职责的运行记录",
      }),
    refetchInterval: 10_000,
  });
}
export function githubBindingsQueryOptions() {
  return queryOptions({
    queryKey: responsibilityKeys.bindings,
    queryFn: (): Promise<GithubBindingRecord[]> =>
      client("/api/responsibilities/sources/github", "bindings", {
        fallback: "读不到 GitHub 事件来源",
      }),
  });
}
export function createResponsibility(input: {
  agentId: string;
  channelId: string;
  title: string;
  instruction: string;
  successCriteria: string;
  subscriptions: ResponsibilityRecord["subscriptions"];
}) {
  return client<ResponsibilityRecord>(
    "/api/responsibilities",
    "responsibility",
    {
      method: "POST",
      body: input,
      fallback: "长期职责没能创建",
    },
  );
}
export function updateResponsibility(
  id: string,
  patch: { title: string; instruction: string; successCriteria: string },
) {
  return client(`/api/responsibilities/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
    fallback: "长期职责没能更新",
  });
}
export function responsibilityAction(
  id: string,
  action: "pause" | "resume" | "complete" | "run",
) {
  return client(`/api/responsibilities/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    fallback: "长期职责没能修改",
  });
}
export function createGithubBinding(repository: string, secret: string) {
  return client<GithubBindingRecord>(
    "/api/responsibilities/sources/github",
    "binding",
    {
      method: "POST",
      body: { repository, secret },
      fallback: "GitHub 事件没能连接",
    },
  );
}
export function removeGithubBinding(id: string) {
  return client(
    `/api/responsibilities/sources/github/${encodeURIComponent(id)}`,
    { method: "DELETE", fallback: "GitHub 事件没能断开" },
  );
}

export type TriggerKind =
  | "webhook"
  | "github"
  | "linear"
  | "sentry"
  | "pagerduty"
  | "email"
  | "slack";
export type TriggerFilter = {
  eventTypes: string[];
  field?: { path: string; equals: string };
};
export type TriggerConfig =
  | {
      kind: "webhook" | "linear" | "sentry" | "pagerduty";
      filter: TriggerFilter;
    }
  | { kind: "github"; repository?: string; filter: TriggerFilter }
  | { kind: "email"; allowedSenders: string[]; filter: TriggerFilter }
  | {
      kind: "slack";
      teamId: string;
      mode: "mention" | "phrase" | "reaction" | "message";
      phrases: string[];
      reactions: string[];
      channels: string[];
    };
export type TriggerRecord = {
  id: string;
  responsibilityId: string;
  kind: TriggerKind;
  config: TriggerConfig;
  hasSecret: boolean;
  /** Paused triggers acknowledge deliveries but never start a run. */
  enabled: boolean;
  /** Public path to POST to, for webhook and provider kinds. */
  path: string | null;
  /** Inbound address, for email when the deployment has inbound email configured. */
  address: string | null;
  emailConfigured?: boolean;
  createdAt: string;
};
export function triggersQueryOptions(id: string) {
  return queryOptions({
    queryKey: responsibilityKeys.triggers(id),
    queryFn: (): Promise<TriggerRecord[]> =>
      client(
        `/api/responsibilities/${encodeURIComponent(id)}/triggers`,
        "triggers",
        { fallback: "读不到触发方式" },
      ),
  });
}
export async function createTrigger(
  responsibilityId: string,
  input: { config: TriggerConfig; secret?: string },
) {
  const response = await client(
    `/api/responsibilities/${encodeURIComponent(responsibilityId)}/triggers`,
    { method: "POST", body: input, fallback: "触发方式没能添加" },
  );
  return (await response.json()) as {
    trigger: TriggerRecord;
    secret: string | null;
  };
}
/** Rotate a generated secret, or store the provider's newly pasted one. */
export async function setTriggerSecret(triggerId: string, secret?: string) {
  const response = await client(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}/secret`,
    {
      method: "POST",
      body: secret ? { secret } : {},
      fallback: "触发密钥没能修改",
    },
  );
  return (await response.json()) as {
    trigger: TriggerRecord;
    secret: string | null;
  };
}
export function revealTriggerSecret(triggerId: string) {
  return client<string>(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}/secret`,
    "secret",
    { fallback: "读不到触发密钥" },
  );
}
export function removeTrigger(triggerId: string) {
  return client(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}`,
    { method: "DELETE", fallback: "触发方式没能移除" },
  );
}

export function setTriggerEnabled(triggerId: string, enabled: boolean) {
  return client(
    `/api/responsibilities/triggers/${encodeURIComponent(triggerId)}/enabled`,
    {
      method: "PUT",
      body: { enabled },
      fallback: "触发方式没能修改",
    },
  );
}
