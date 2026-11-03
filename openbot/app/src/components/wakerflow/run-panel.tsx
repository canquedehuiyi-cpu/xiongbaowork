import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RequestError } from "@/lib/client";
import { newId } from "@/lib/new-id";
import {
  abortWakerFlowRun,
  getWakerFlowRun,
  isTerminalRunStatus,
  laterRunReading,
  listWakerFlowRuns,
  runInputProblems,
  startWakerFlowRun,
  type WakerFlow,
  type WakerFlowPlan,
  type WakerFlowRun,
  type WakerFlowRunStep,
  type WakerFlowRunSummary,
  wakerFlowKeys,
} from "@/lib/wakerflows";

/** How often a run that has not ended is asked about again. */
const POLL_INTERVAL_MS = 2000;

const RUN_STATUS: Record<string, string> = {
  running: "运行中",
  awaiting_action: "等待处理",
  done: "已完成",
  failed: "失败",
  aborted: "已停止",
};

const STEP_STATE: Record<WakerFlowRunStep["state"], string> = {
  pending: "等待中",
  running: "进行中",
  awaiting_action: "等待处理",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
  aborted: "已停止",
};

const LOST_MESSAGE =
  "网络连接中断，暂时无法确认这次运行是否已开始。可以直接重试，同一次请求不会重复运行。";

const runStatusLabel = (status: string) => RUN_STATUS[status] ?? status;

/** One request id per set of inputs; `spent` once the server settled it, so the next run is a new one. */
type PendingStart = { key: string; id: string; spent: boolean };

/**
 * Running a saved WakerFlow and reading its runs (spec D10, stories WF4 and WF5).
 *
 * The form is the plan's own inputs; a required one left empty never reaches the server. A press mints
 * one request id and a retry of the same inputs after a lost answer sends the same id, so a dropped
 * connection can never start the crew twice. Each run lists its steps with their state and output, and
 * 停止 asks the server once and stays disabled once the run has ended.
 *
 * Polling is monotonic: once a run has been seen ended (from a poll or from 停止's own answer), a
 * late answer that still says `running` is ignored. The ended readings live here, above the list and
 * the details, so neither the list's status nor a detail can move backwards.
 */
export function RunPanel(props: {
  flow: WakerFlow & { plan: WakerFlowPlan };
  /** Overridable so a test does not wait two seconds per poll. */
  pollIntervalMs?: number;
}) {
  const { flow } = props;
  const plan = flow.plan;
  const poll = props.pollIntervalMs ?? POLL_INTERVAL_MS;
  const queryClient = useQueryClient();

  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** Runs seen ended, by id: the reading every later answer is measured against. */
  const [ended, setEnded] = useState<Record<string, WakerFlowRun>>({});
  const pending = useRef<PendingStart | null>(null);

  const remember = (run: WakerFlowRun) => {
    if (!isTerminalRunStatus(run.status)) return;
    setEnded((known) => (known[run.id] ? known : { ...known, [run.id]: run }));
  };

  const runs = useQuery({
    queryKey: wakerFlowKeys.runs(flow.id),
    queryFn: () => listWakerFlowRuns(flow.id),
  });
  const anyGoing = (runs.data ?? []).some(
    (run) => !isTerminalRunStatus(run.status) && !ended[run.id],
  );
  const refetchRuns = runs.refetch;
  useEffect(() => {
    if (!anyGoing) return;
    // Never cancels a read still in flight: a slow answer is waited for, not replaced.
    const timer = setInterval(() => {
      void refetchRuns({ cancelRefetch: false });
    }, poll);
    return () => clearInterval(timer);
  }, [anyGoing, poll, refetchRuns]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (starting) return;
    const found = runInputProblems(plan, values);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    // Only declared inputs, and only what was filled: the server refuses a name it did not declare.
    const inputs: Record<string, string> = {};
    for (const input of plan.inputs) {
      const value = values[input.key] ?? "";
      if (value.trim()) inputs[input.key] = value;
    }
    const key = JSON.stringify([flow.revision, inputs]);
    if (
      !pending.current ||
      pending.current.spent ||
      pending.current.key !== key
    ) {
      pending.current = { key, id: newId(), spent: false };
    }
    const request = pending.current;
    setStarting(true);
    setFailure(null);
    try {
      const answer = await startWakerFlowRun(flow.id, {
        requestId: request.id,
        revision: flow.revision,
        inputs,
      });
      // The server has a row for this id now: whatever it says, the next press is a new request.
      request.spent = true;
      if (answer.status === "completed" && answer.runId) {
        setSelected(answer.runId);
        setValues({});
      } else if (answer.error) {
        setFailure(answer.error);
      } else if (answer.status === "pending") {
        // Claimed and still starting: the list will show it once it is registered.
        setSelected(answer.runId);
      }
      await queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.runs(flow.id),
      });
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) {
        // Refused before or at the claim (missing input, stale revision, quota, a reused id): the
        // server's own sentence, and the next press is a new request.
        request.spent = true;
        setFailure(error.message);
      } else {
        // No answer, or a 5xx from the server or a proxy in front of it: the claim may have landed,
        // so the same id is kept and pressing again cannot start a second run.
        setFailure(LOST_MESSAGE);
      }
    } finally {
      setStarting(false);
    }
  }

  const list = runs.data ?? [];

  return (
    <div className="flex flex-col gap-8">
      <form
        aria-label="运行这个 WakerFlow"
        className="flex flex-col gap-3"
        noValidate
        onSubmit={submit}
      >
        {plan.inputs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            这个流程不需要输入，可以直接运行。
          </p>
        ) : (
          plan.inputs.map((input) => {
            const id = `run-input-${input.key}`;
            return (
              <div className="flex flex-col gap-1" key={input.key}>
                <label className="font-medium text-sm" htmlFor={id}>
                  {input.label}
                  {input.required ? "（必填）" : "（选填）"}
                </label>
                <Textarea
                  aria-invalid={problems[input.key] ? true : undefined}
                  aria-required={input.required}
                  id={id}
                  onChange={(event) => {
                    const next = { ...values, [input.key]: event.target.value };
                    setValues(next);
                    if (Object.keys(problems).length > 0)
                      setProblems(runInputProblems(plan, next));
                  }}
                  rows={2}
                  value={values[input.key] ?? ""}
                />
                {problems[input.key] ? (
                  <p className="text-destructive text-xs" role="alert">
                    {problems[input.key]}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
        {failure ? (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
        <div>
          <Button disabled={starting} size="sm" type="submit">
            {starting ? "正在开始…" : "运行"}
          </Button>
        </div>
      </form>

      <section aria-label="运行记录" className="flex flex-col gap-2">
        <h3 className="font-semibold text-base">运行记录</h3>
        {runs.isPending ? (
          <p className="text-muted-foreground text-sm">正在加载运行记录…</p>
        ) : runs.error ? (
          <p className="text-destructive text-sm" role="alert">
            {runs.error.message}
          </p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">还没有运行记录。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((run) => (
              <RunRow
                ended={ended[run.id] ?? null}
                flow={flow}
                key={run.id}
                onEnded={remember}
                onToggle={() =>
                  setSelected((current) => (current === run.id ? null : run.id))
                }
                open={selected === run.id}
                pollIntervalMs={poll}
                run={run}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow(props: {
  flow: WakerFlow;
  run: WakerFlowRunSummary;
  ended: WakerFlowRun | null;
  open: boolean;
  pollIntervalMs: number;
  onToggle: () => void;
  onEnded: (run: WakerFlowRun) => void;
}) {
  const { flow, run, ended } = props;
  const status = ended?.status ?? run.status;
  const created = new Date(run.createdAt);
  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex flex-row items-center justify-between gap-3">
        <button
          aria-expanded={props.open}
          className="text-left text-sm"
          onClick={props.onToggle}
          type="button"
        >
          <span className="font-medium">
            {Number.isNaN(created.getTime())
              ? "运行"
              : created.toLocaleString("zh-CN")}
          </span>
          <span className="ml-2 text-muted-foreground" data-run-status={run.id}>
            {runStatusLabel(status)}
          </span>
        </button>
        {run.parentTaskId ? (
          <Link
            className="text-sm underline opacity-80"
            search={{ q: flow.name, period: "all" }}
            to="/tasks"
          >
            到任务看板查收
          </Link>
        ) : null}
      </div>
      {props.open ? (
        <RunDetail
          ended={ended}
          flowId={flow.id}
          onEnded={props.onEnded}
          pollIntervalMs={props.pollIntervalMs}
          runId={run.id}
        />
      ) : null}
    </li>
  );
}

function RunDetail(props: {
  flowId: string;
  runId: string;
  ended: WakerFlowRun | null;
  pollIntervalMs: number;
  onEnded: (run: WakerFlowRun) => void;
}) {
  const { flowId, runId, ended, onEnded } = props;
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [stopFailure, setStopFailure] = useState<string | null>(null);
  // Set before the request leaves, so a double click cannot send a second one.
  const stopSent = useRef(false);

  const detail = useQuery({
    queryKey: wakerFlowKeys.run(flowId, runId),
    queryFn: async () => {
      const run = await getWakerFlowRun(flowId, runId);
      if (isTerminalRunStatus(run.status)) onEnded(run);
      return run;
    },
  });

  const run = laterRunReading(ended, detail.data ?? null);
  const terminal = run ? isTerminalRunStatus(run.status) : false;
  const refetchDetail = detail.refetch;
  useEffect(() => {
    if (terminal) return;
    // Never cancels a read still in flight; whatever it answers is measured against `ended`.
    const timer = setInterval(() => {
      void refetchDetail({ cancelRefetch: false });
    }, props.pollIntervalMs);
    return () => clearInterval(timer);
  }, [terminal, props.pollIntervalMs, refetchDetail]);

  async function stop() {
    if (stopSent.current || terminal) return;
    stopSent.current = true;
    setStopping(true);
    setStopFailure(null);
    try {
      const outcome = await abortWakerFlowRun(flowId, runId);
      const base = run ?? detail.data;
      if (outcome && base) {
        onEnded({
          ...base,
          status: outcome.status,
          cursor: outcome.cursor,
          steps: outcome.steps,
        });
      }
      await queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.runs(flowId),
      });
    } catch (error) {
      // Nothing was stopped as far as this screen knows: the person may ask again.
      stopSent.current = false;
      setStopFailure(
        error instanceof RequestError ? error.message : "这次运行没能中止。",
      );
    } finally {
      setStopping(false);
    }
  }

  if (!run) {
    return detail.error ? (
      <p className="mt-2 text-destructive text-sm" role="alert">
        {detail.error.message}
      </p>
    ) : (
      <p className="mt-2 text-muted-foreground text-sm">正在加载这次运行…</p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-row items-center gap-3">
        <span className="text-sm" data-testid="run-detail-status">
          {runStatusLabel(run.status)}
        </span>
        <Button
          disabled={terminal || stopping || stopSent.current}
          onClick={stop}
          size="sm"
          type="button"
          variant="outline"
        >
          {stopping ? "正在停止…" : "停止"}
        </Button>
      </div>
      {stopFailure ? (
        <p className="text-destructive text-sm" role="alert">
          {stopFailure}
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {run.steps.map((step, index) => (
          <li className="rounded-md bg-muted px-3 py-2 text-sm" key={step.id}>
            <div className="flex flex-row justify-between gap-3">
              <span className="font-medium">
                第 {index + 1} 步 · {step.instruction}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {STEP_STATE[step.state] ?? step.state}
              </span>
            </div>
            {step.output ? (
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs">
                {step.outputKey ? `${step.outputKey}：` : ""}
                {step.output}
              </pre>
            ) : null}
            {step.error ? (
              <p className="mt-2 text-destructive text-xs">{step.error}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
