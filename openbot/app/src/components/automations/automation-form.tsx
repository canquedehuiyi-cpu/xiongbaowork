import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type AutomationTarget,
  type AutomationTriggerConfig,
  automationCapabilitiesQueryOptions,
  type CreatedAutomation,
  createAutomationMutationOptions,
  MAX_ACTIVE_TRIGGERS,
  MAX_AUTOMATION_NAME,
  TRIGGER_KIND_LABEL,
  wakerflowChoicesQueryOptions,
} from "@/lib/automations/queries";

type TriggerDraft = {
  key: number;
  kind: AutomationTriggerConfig["kind"];
  cron: string;
  timezone: string;
  at: string;
};

const SELECT =
  "border-input bg-background rounded-md border px-2 py-1 disabled:opacity-50";

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A `datetime-local` value is wall-clock time here; the server wants an instant with an offset. */
function toInstant(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toConfig(draft: TriggerDraft): AutomationTriggerConfig {
  if (draft.kind === "schedule") {
    return {
      kind: "schedule",
      cron: draft.cron.trim(),
      timezone: draft.timezone.trim(),
    };
  }
  if (draft.kind === "once") {
    // An unreadable time is sent as typed, so the refusal is the server's sentence, not a guess here.
    return { kind: "once", at: toInstant(draft.at) ?? draft.at };
  }
  return { kind: "webhook" };
}

/**
 * New automation (AUT1-AUT4): what to do, who does it, when, and until when.
 *
 * Target is a Waker, or a WakerFlow that already exists when this deployment can run one (AUT3).
 * Up to five triggers of the kinds the server knows: 定期 (cron in a time zone), 一次性 (one instant)
 * and Hook / API (an entry started from outside with a secret). A run cap and an end date are both
 * optional (AUT4). Whatever the server refuses is shown in its own words and the form stays filled.
 */
export function AutomationForm({
  onCreated,
}: {
  onCreated: (created: CreatedAutomation) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(createAutomationMutationOptions(queryClient));
  const agents = useQuery(agentListQueryOptions());
  const capabilities = useQuery(automationCapabilitiesQueryOptions());
  const canFlow = capabilities.data?.wakerflow === true;
  const flows = useQuery(wakerflowChoicesQueryOptions(canFlow));
  const roster = agents.data ?? [];
  const field = useId();

  const [name, setName] = useState("");
  const [targetKind, setTargetKind] =
    useState<AutomationTarget["kind"]>("waker");
  const [agentId, setAgentId] = useState("");
  const [flowId, setFlowId] = useState("");
  const [nextKey, setNextKey] = useState(1);
  const [triggers, setTriggers] = useState<TriggerDraft[]>([
    { key: 0, kind: "schedule", cron: "", timezone: localZone(), at: "" },
  ]);
  const [maxRuns, setMaxRuns] = useState("");
  const [endDate, setEndDate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const chosenAgent = agentId || roster[0]?.id || "";
  const chosenFlow = flowId || flows.data?.[0]?.id || "";
  const flowMode = targetKind === "wakerflow" && canFlow;
  const target: AutomationTarget | null = flowMode
    ? chosenFlow
      ? { kind: "wakerflow", flowId: chosenFlow }
      : null
    : chosenAgent
      ? { kind: "waker", agentId: chosenAgent }
      : null;
  const ready = Boolean(name.trim() && target && triggers.length > 0);

  const change = (key: number, patch: Partial<TriggerDraft>) =>
    setTriggers((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft,
      ),
    );

  return (
    <form
      aria-label="新建自动任务"
      className="mb-4 flex flex-col gap-3 rounded-lg border p-3"
      // The server is the one judge of every value; the browser must not stop a request first.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!target || create.isPending) return;
        setProblem(null);
        const runs = maxRuns.trim();
        create.mutate(
          {
            automation: {
              name: name.trim(),
              target,
              // Typed as written: a cap of 0 or 1.5 is the server's to refuse, in its own words.
              maxRuns: runs ? Number(runs) : null,
              endDate: endDate ? (toInstant(endDate) ?? endDate) : null,
            },
            triggers: triggers.map(toConfig),
          },
          {
            onError: (thrown: Error) =>
              setProblem(thrown.message || "这个自动任务没能建立。"),
            onSuccess: onCreated,
          },
        );
      }}
    >
      <label htmlFor={`${field}-name`} className="flex flex-col gap-1 text-sm">
        要做的事
        <Input
          aria-label="要做的事"
          id={`${field}-name`}
          maxLength={MAX_AUTOMATION_NAME}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：整理本周客户反馈并汇总要点"
          value={name}
        />
      </label>

      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          执行对象
          <select
            aria-label="执行对象"
            className={SELECT}
            onChange={(event) =>
              setTargetKind(event.target.value as AutomationTarget["kind"])
            }
            value={flowMode ? "wakerflow" : "waker"}
          >
            <option value="waker">Waker</option>
            <option disabled={!canFlow} value="wakerflow">
              {canFlow ? "WakerFlow" : "WakerFlow（暂未开放）"}
            </option>
          </select>
        </label>
        {flowMode ? (
          <label className="flex flex-col gap-1">
            选择 WakerFlow
            <select
              aria-label="选择 WakerFlow"
              className={SELECT}
              onChange={(event) => setFlowId(event.target.value)}
              value={chosenFlow}
            >
              {(flows.data ?? []).map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            选择 Waker
            <select
              aria-label="选择 Waker"
              className={SELECT}
              onChange={(event) => setAgentId(event.target.value)}
              value={chosenAgent}
            >
              {roster.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {flowMode && flows.isSuccess && flows.data.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          还没有已创建的 WakerFlow，请先去建一个。
        </p>
      ) : null}
      {!canFlow ? (
        <p className="text-muted-foreground text-xs">
          WakerFlow 自动执行尚未开放，暂时只能选择 Waker。
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="pb-1">
          触发条件（{triggers.length}/{MAX_ACTIVE_TRIGGERS}）
        </legend>
        {triggers.map((draft, index) => {
          const n = index + 1;
          return (
            <div
              className="flex flex-wrap items-end gap-2 rounded-md border p-2"
              key={draft.key}
            >
              <label className="flex flex-col gap-1">
                触发方式 {n}
                <select
                  aria-label={`触发方式 ${n}`}
                  className={SELECT}
                  onChange={(event) =>
                    change(draft.key, {
                      kind: event.target
                        .value as AutomationTriggerConfig["kind"],
                    })
                  }
                  value={draft.kind}
                >
                  <option value="schedule">
                    {TRIGGER_KIND_LABEL.schedule}
                  </option>
                  <option value="once">{TRIGGER_KIND_LABEL.once}</option>
                  <option value="webhook">{TRIGGER_KIND_LABEL.webhook}</option>
                </select>
              </label>
              {draft.kind === "schedule" ? (
                <>
                  <label
                    className="flex flex-col gap-1"
                    htmlFor={`${field}-cron-${draft.key}`}
                  >
                    cron 规则 {n}
                    <Input
                      aria-label={`cron 规则 ${n}`}
                      id={`${field}-cron-${draft.key}`}
                      onChange={(event) =>
                        change(draft.key, { cron: event.target.value })
                      }
                      placeholder="分 时 日 月 周，例如 0 9 * * 1-5"
                      value={draft.cron}
                    />
                  </label>
                  <label
                    className="flex flex-col gap-1"
                    htmlFor={`${field}-zone-${draft.key}`}
                  >
                    时区 {n}
                    <Input
                      aria-label={`时区 ${n}`}
                      id={`${field}-zone-${draft.key}`}
                      onChange={(event) =>
                        change(draft.key, { timezone: event.target.value })
                      }
                      value={draft.timezone}
                    />
                  </label>
                </>
              ) : null}
              {draft.kind === "once" ? (
                <label
                  className="flex flex-col gap-1"
                  htmlFor={`${field}-at-${draft.key}`}
                >
                  触发时间 {n}
                  <Input
                    aria-label={`触发时间 ${n}`}
                    id={`${field}-at-${draft.key}`}
                    onChange={(event) =>
                      change(draft.key, { at: event.target.value })
                    }
                    type="datetime-local"
                    value={draft.at}
                  />
                </label>
              ) : null}
              {draft.kind === "webhook" ? (
                <p className="text-muted-foreground text-xs">
                  建立后会得到一个 Hook
                  地址和只显示一次的密钥，外部系统调用它即可触发。
                </p>
              ) : null}
              <Button
                aria-label={`移除触发条件 ${n}`}
                disabled={triggers.length === 1}
                onClick={() =>
                  setTriggers((current) =>
                    current.filter((entry) => entry.key !== draft.key),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                移除
              </Button>
            </div>
          );
        })}
        <div>
          <Button
            disabled={triggers.length >= MAX_ACTIVE_TRIGGERS}
            onClick={() => {
              setTriggers((current) => [
                ...current,
                {
                  key: nextKey,
                  kind: "schedule",
                  cron: "",
                  timezone: localZone(),
                  at: "",
                },
              ]);
              setNextKey((key) => key + 1);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            添加触发条件
          </Button>
          {triggers.length >= MAX_ACTIVE_TRIGGERS ? (
            <span className="text-muted-foreground ps-2 text-xs">
              最多 {MAX_ACTIVE_TRIGGERS} 个触发条件
            </span>
          ) : null}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label htmlFor={`${field}-max-runs`} className="flex flex-col gap-1">
          最大运行次数（可不填）
          <Input
            aria-label="最大运行次数"
            id={`${field}-max-runs`}
            inputMode="numeric"
            onChange={(event) => setMaxRuns(event.target.value)}
            type="number"
            value={maxRuns}
          />
        </label>
        <label htmlFor={`${field}-end`} className="flex flex-col gap-1">
          截止日期（可不填）
          <Input
            aria-label="截止日期"
            id={`${field}-end`}
            onChange={(event) => setEndDate(event.target.value)}
            type="datetime-local"
            value={endDate}
          />
        </label>
      </div>
      <p className="text-muted-foreground text-xs">
        到达最大运行次数或截止日期后会自动停止；定期触发的最短间隔为 15 分钟。
      </p>

      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      <div>
        <Button disabled={!ready || create.isPending} size="sm" type="submit">
          {create.isPending ? "正在建立…" : "建立自动任务"}
        </Button>
      </div>
    </form>
  );
}
