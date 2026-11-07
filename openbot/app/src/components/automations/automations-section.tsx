import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AutomationForm } from "@/components/automations/automation-form";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  AUTOMATION_STATE_LABEL,
  type Automation,
  type AutomationState,
  type AutomationTrigger,
  automationDetailQueryOptions,
  automationHookPath,
  automationListQueryOptions,
  automationState,
  type CreatedAutomation,
  deleteAutomationMutationOptions,
  rotateTriggerSecretMutationOptions,
  setAutomationEnabledMutationOptions,
  TRIGGER_KIND_LABEL,
} from "@/lib/automations/queries";
import { relativeTime } from "@/lib/relative-time";

const STATE_TONE: Record<AutomationState, string> = {
  running: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  paused: "text-muted-foreground",
  expired: "text-muted-foreground",
  max_runs: "text-muted-foreground",
  breaker: "border-destructive/50 text-destructive",
};

function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { hour12: false });
}

/** One Hook / API secret, shown once: after this it can only be replaced, never read again (AUT2). */
export function SecretOnce({
  triggerId,
  secret,
  onDismiss,
}: {
  triggerId: string;
  secret: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-amber-500/50 p-2 text-xs"
      role="status"
    >
      <p>
        Hook 地址：<code>POST {automationHookPath(triggerId)}</code>
      </p>
      <p>
        调用时在请求头带上 <code>Authorization: Bearer 密钥</code>。
      </p>
      <p>
        密钥（只显示这一次，请现在保存）：
        <output aria-label="Hook 密钥" className="break-all font-mono">
          {secret}
        </output>
      </p>
      <div>
        <Button onClick={onDismiss} size="sm" type="button" variant="outline">
          我已保存
        </Button>
      </div>
    </div>
  );
}

function TriggerChip({
  trigger,
  live,
}: {
  trigger: AutomationTrigger;
  /** Only a running automation fires: a paused, spent or tripped one has no next time to show. */
  live: boolean;
}) {
  const { config } = trigger;
  const detail =
    config.kind === "schedule"
      ? `${config.cron}（${config.timezone}）`
      : config.kind === "once"
        ? formatInstant(config.at)
        : "外部调用";
  const next =
    live && trigger.enabled && trigger.nextRunAt
      ? ` · 下次 ${relativeTime(trigger.nextRunAt)}`
      : "";
  return (
    <li
      className="rounded-full border px-2 py-0.5 text-xs"
      title={trigger.nextRunAt ?? undefined}
    >
      {TRIGGER_KIND_LABEL[config.kind]} · {detail}
      {next}
      {trigger.enabled ? "" : " · 已停用"}
      {/* Why the server switched it off (a missed one-off, an unreadable rule), when it says. */}
      {trigger.lastError ? (
        <span className="text-destructive"> · {trigger.lastError}</span>
      ) : null}
    </li>
  );
}

export function AutomationRow({
  automation,
  agentName,
}: {
  automation: Automation;
  agentName: (id: string) => string;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery(automationDetailQueryOptions(automation.id));
  const toggle = useMutation(setAutomationEnabledMutationOptions(queryClient));
  const remove = useMutation(deleteAutomationMutationOptions(queryClient));
  const rotate = useMutation(rotateTriggerSecretMutationOptions());
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ triggerId: string; secret: string }>();

  const state = automationState(automation);
  const triggers = detail.data?.triggers ?? [];
  const hooks = triggers.filter(
    (trigger) => trigger.config.kind === "webhook" && trigger.enabled,
  );
  const target =
    automation.target.kind === "waker"
      ? `Waker：${agentName(automation.target.agentId)}`
      : "WakerFlow";
  const busy = toggle.isPending || remove.isPending;
  const fail = (thrown: Error) =>
    setProblem(thrown.message || "操作没有成功。");

  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>
          {automation.name}
          <span
            className={`rounded-full border px-2 py-0.5 font-normal text-xs ${STATE_TONE[state]}`}
          >
            {AUTOMATION_STATE_LABEL[state]}
          </span>
        </ItemTitle>
        <ItemDescription>
          {target} · 已运行 {automation.runCount}/{automation.maxRuns ?? "不限"}
          {automation.endDate
            ? ` · 截止 ${formatInstant(automation.endDate)}`
            : ""}
        </ItemDescription>
        {detail.isError ? (
          <p className="text-destructive text-xs">
            触发条件加载失败：{detail.error.message}
          </p>
        ) : (
          <ul aria-label="触发条件" className="flex flex-wrap gap-1 pt-1">
            {triggers.map((trigger) => (
              <TriggerChip
                key={trigger.id}
                live={state === "running"}
                trigger={trigger}
              />
            ))}
          </ul>
        )}
        {hooks.map((trigger) =>
          fresh?.triggerId === trigger.id ? (
            <SecretOnce
              key={trigger.id}
              onDismiss={() => setFresh(undefined)}
              secret={fresh.secret}
              triggerId={trigger.id}
            />
          ) : (
            <p className="flex items-center gap-2 text-xs" key={trigger.id}>
              <span>
                Hook 地址：<code>POST {automationHookPath(trigger.id)}</code>
              </span>
              <Button
                disabled={rotate.isPending}
                onClick={() => {
                  setProblem(null);
                  rotate.mutate(
                    { automationId: automation.id, triggerId: trigger.id },
                    {
                      onError: fail,
                      onSuccess: (secret) =>
                        setFresh({ triggerId: trigger.id, secret }),
                    },
                  );
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                重新生成密钥
              </Button>
            </p>
          ),
        )}
        {problem ? (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Button
          disabled={busy}
          onClick={() => {
            setProblem(null);
            toggle.mutate(
              { id: automation.id, enabled: !automation.enabled },
              { onError: fail },
            );
          }}
          size="sm"
          variant="outline"
        >
          {automation.enabled ? "暂停" : "恢复"}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setProblem(null);
            remove.mutate(automation.id, { onError: fail });
          }}
          size="sm"
          variant="outline"
        >
          {remove.isPending ? "删除中…" : "删除"}
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * 自动任务 on the 自主工作 page (D06 AUT1-AUT4, C1): every automation this person has, what starts
 * it, where it stands and how many of its runs are used, with pause, resume and delete, and the form
 * to make another. A Hook / API secret appears once, right after it is made or replaced.
 */
export function AutomationsSection() {
  const list = useQuery(automationListQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAutomation | null>(null);
  const names = new Map(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  );
  const agentName = (id: string) => names.get(id) ?? id;
  const secrets = (created?.triggers ?? []).flatMap(({ trigger, secret }) =>
    secret ? [{ triggerId: trigger.id, secret }] : [],
  );

  return (
    <PageSection
      action={
        <Button
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
          size="sm"
          variant="outline"
        >
          {creating ? "收起" : "新建自动任务"}
        </Button>
      }
      description="由定期、一次性或 Hook / API 触发，交给一位 Waker 或一个 WakerFlow 去做；可设最大运行次数与截止日期。"
      title="自动任务"
    >
      {creating ? (
        <AutomationForm
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
          }}
        />
      ) : null}
      {created && secrets.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          <p className="text-sm">「{created.automation.name}」已建立。</p>
          {secrets.map((entry) => (
            <SecretOnce
              key={entry.triggerId}
              onDismiss={() =>
                setCreated((current) =>
                  current
                    ? {
                        ...current,
                        triggers: current.triggers.filter(
                          (item) => item.trigger.id !== entry.triggerId,
                        ),
                      }
                    : current,
                )
              }
              secret={entry.secret}
              triggerId={entry.triggerId}
            />
          ))}
        </div>
      ) : null}
      {list.isError ? (
        <QueryError
          error={list.error}
          label="自动任务加载失败"
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : null}
      {list.isPending ? <Skeleton className="h-16" /> : null}
      {list.isSuccess && list.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          还没有自动任务。点「新建自动任务」建一个。
        </p>
      ) : null}
      {list.isSuccess && list.data.length > 0 ? (
        <PageRows>
          {list.data.map((automation) => (
            <AutomationRow
              agentName={agentName}
              automation={automation}
              key={automation.id}
            />
          ))}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
