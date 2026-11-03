import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * D06 automations (AUT1-AUT4, C1): a person's own automations at `/api/automations`.
 *
 * The shapes mirror `server/src/automations/types.ts` as they come over the wire, so every date is an
 * ISO string. The server decides every rule (the five-trigger cap, the 15-minute floor, the end date,
 * the run cap); this side only asks, and shows a refusal in the server's own words.
 */

/** 原版显示上限 5 (AUT1): the server refuses a sixth switched-on trigger; the form offers five. */
export const MAX_ACTIVE_TRIGGERS = 5;
export const MAX_AUTOMATION_NAME = 80;

export type AutomationTarget =
  | { kind: "waker"; agentId: string }
  | { kind: "wakerflow"; flowId: string };

export type AutomationTriggerConfig =
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "once"; at: string }
  | { kind: "webhook" };

export type Automation = {
  id: string;
  name: string;
  target: AutomationTarget;
  enabled: boolean;
  maxRuns: number | null;
  endDate: string | null;
  runCount: number;
  createdAt: string;
  /** Present on the list: the circuit breaker is what switched it off (C3). */
  breakerTripped?: boolean;
};

export type AutomationTrigger = {
  id: string;
  automationId: string;
  config: AutomationTriggerConfig;
  enabled: boolean;
  nextRunAt: string | null;
  hasSecret: boolean;
  lastError: string | null;
};

export type AutomationState =
  | "running"
  | "paused"
  | "expired"
  | "max_runs"
  | "breaker";

export const AUTOMATION_STATE_LABEL: Record<AutomationState, string> = {
  running: "运行中",
  paused: "已暂停",
  expired: "已到期停止",
  max_runs: "已达上限",
  breaker: "已熔断",
};

export const TRIGGER_KIND_LABEL: Record<
  AutomationTriggerConfig["kind"],
  string
> = {
  schedule: "定期",
  once: "一次性",
  webhook: "Hook / API",
};

/**
 * Where it stands, in the order a person needs it: the breaker first (it is the one that asks for
 * attention), then the limits that stopped it for good (AUT4), then on or off.
 */
export function automationState(
  automation: Pick<
    Automation,
    "enabled" | "maxRuns" | "runCount" | "endDate" | "breakerTripped"
  >,
  now: Date = new Date(),
): AutomationState {
  if (!automation.enabled && automation.breakerTripped === true) {
    return "breaker";
  }
  if (
    automation.maxRuns !== null &&
    automation.runCount >= automation.maxRuns
  ) {
    return "max_runs";
  }
  if (
    automation.endDate !== null &&
    now.getTime() >= new Date(automation.endDate).getTime()
  ) {
    return "expired";
  }
  return automation.enabled ? "running" : "paused";
}

/** The public entry a Hook / API trigger is started from (AUT2). The secret is not part of it. */
export function automationHookPath(triggerId: string): string {
  return `/api/automations/hooks/${encodeURIComponent(triggerId)}`;
}

export const automationKeys = {
  all: ["automations"] as const,
  list: () => ["automations", "list"] as const,
  detail: (id: string) => ["automations", "detail", id] as const,
  capabilities: () => ["automations", "capabilities"] as const,
  flows: () => ["automations", "wakerflows"] as const,
};

const LIST_FALLBACK = "自动任务加载失败，请稍后再试。";

function automationPath(id: string): string {
  return `/api/automations/${encodeURIComponent(id)}`;
}

export function automationListQueryOptions() {
  return queryOptions({
    queryKey: automationKeys.list(),
    queryFn: async (): Promise<Automation[]> => {
      const automations = await client<unknown>(
        "/api/automations",
        "automations",
        { fallback: LIST_FALLBACK },
      );
      // A body without the list is a failed read, not "no automations".
      if (!Array.isArray(automations)) throw new Error(LIST_FALLBACK);
      return automations as Automation[];
    },
    // A firing moves the run count and the next trigger time, and nothing pushes.
    refetchInterval: 300_000,
  });
}

export function automationDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: automationKeys.detail(id),
    queryFn: async (): Promise<{
      automation: Automation;
      triggers: AutomationTrigger[];
    }> => {
      const body = (await (
        await client(automationPath(id), {
          fallback: "触发条件加载失败。",
        })
      ).json()) as { automation?: Automation; triggers?: unknown };
      if (!body.automation || !Array.isArray(body.triggers)) {
        throw new Error("触发条件加载失败。");
      }
      return {
        automation: body.automation,
        triggers: body.triggers as AutomationTrigger[],
      };
    },
    refetchInterval: 300_000,
  });
}

/**
 * Whether this deployment can run a WakerFlow as an automation's target (AUT3).
 *
 * Read off `/api/capabilities` as `wakerflowAutomations`. Absent reads as off: until a WakerFlow
 * executor is registered the server refuses such a target, so the form must not offer it.
 */
export function automationCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: automationKeys.capabilities(),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<{ wakerflow: boolean }> => {
      const body = (await (
        await client("/api/capabilities", {
          fallback: "部署能力读取失败。",
        })
      )
        .json()
        .catch(() => null)) as { wakerflowAutomations?: unknown } | null;
      return { wakerflow: body?.wakerflowAutomations === true };
    },
  });
}

export type WakerFlowChoice = { id: string; name: string };

/** The WakerFlows that already exist, for a WakerFlow target. Asked only when one can be chosen. */
export function wakerflowChoicesQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: automationKeys.flows(),
    enabled,
    queryFn: async (): Promise<WakerFlowChoice[]> => {
      const flows = await client<unknown>("/api/wakerflows", "flows", {
        fallback: "WakerFlow 列表加载失败。",
      });
      if (!Array.isArray(flows)) return [];
      return flows.flatMap((flow: unknown) => {
        if (!flow || typeof flow !== "object") return [];
        const { id, name, status } = flow as {
          id?: unknown;
          name?: unknown;
          status?: unknown;
        };
        // Only a saved Flow can run; a draft would only be refused when the automation is saved.
        if (status !== undefined && status !== "ready") return [];
        return typeof id === "string"
          ? [{ id, name: typeof name === "string" && name ? name : id }]
          : [];
      });
    },
  });
}

export type NewAutomation = {
  name: string;
  target: AutomationTarget;
  maxRuns: number | null;
  endDate: string | null;
};

export type CreatedAutomation = {
  automation: Automation;
  triggers: { trigger: AutomationTrigger; secret: string | null }[];
};

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: automationKeys.all });
}

/**
 * Make one automation with its triggers (AUT1).
 *
 * The API makes the automation first and then each trigger. A person filled in one form, so it is
 * one outcome: if any trigger is refused, the automation just made is deleted again and the refusal
 * is what the form shows. The webhook secrets returned here are their only appearance (AUT2).
 */
export function createAutomationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      automation: NewAutomation;
      triggers: AutomationTriggerConfig[];
    }): Promise<CreatedAutomation> => {
      const automation = await client<Automation>(
        "/api/automations",
        "automation",
        {
          method: "POST",
          body: variables.automation,
          fallback: "这个自动任务没能建立。",
        },
      );
      const triggers: CreatedAutomation["triggers"] = [];
      try {
        for (const config of variables.triggers) {
          const body = (await (
            await client(`${automationPath(automation.id)}/triggers`, {
              method: "POST",
              body: config,
              fallback: "这个触发条件没能添加。",
            })
          ).json()) as { trigger: AutomationTrigger; secret?: string };
          triggers.push({
            trigger: body.trigger,
            secret: typeof body.secret === "string" ? body.secret : null,
          });
        }
      } catch (error) {
        await client(automationPath(automation.id), {
          method: "DELETE",
          fallback: "这个自动任务没能撤回。",
        }).catch(() => undefined);
        throw error;
      }
      return { automation, triggers };
    },
    onSettled: () => invalidate(queryClient),
  });
}

/** 暂停 / 恢复. Switching back on is refused once it is spent (AUT4), in the server's words. */
export function setAutomationEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(`${automationPath(variables.id)}/enabled`, {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: "这个自动任务没能修改。",
      }),
    onSuccess: () => invalidate(queryClient),
  });
}

export function deleteAutomationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(automationPath(id), {
        method: "DELETE",
        fallback: "这个自动任务没能删除。",
      }),
    // The row goes now and only the list is asked again: refetching the deleted one's detail would
    // answer 404 and flash 触发条件加载失败 on a row that is already gone.
    onSuccess: (_response, id) => {
      queryClient.setQueryData<Automation[]>(automationKeys.list(), (current) =>
        current?.filter((automation) => automation.id !== id),
      );
      return queryClient.invalidateQueries({
        queryKey: automationKeys.list(),
      });
    },
  });
}

/** A new secret for a Hook / API trigger; the old one stops working. Shown once (AUT2). */
export function rotateTriggerSecretMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      automationId: string;
      triggerId: string;
    }): Promise<string> => {
      const secret = await client<unknown>(
        `${automationPath(variables.automationId)}/triggers/${encodeURIComponent(variables.triggerId)}/secret`,
        "secret",
        { method: "POST", fallback: "密钥没能重新生成。" },
      );
      if (typeof secret !== "string") throw new Error("密钥没能重新生成。");
      return secret;
    },
  });
}
