import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RequestError } from "@/lib/client";
import { newId } from "@/lib/new-id";
import { FlowInputFields } from "./flow-input-fields";
import { CARD_FACE, StateBadge } from "./flow-ui";
import { Flowchart } from "./flowchart";
import { RunTimeline } from "./run-timeline";
import {
  abortWakerFlowRun,
  answerWakerFlowConfirmation,
  filledInputValues,
  getWakerFlowRun,
  initialInputValues,
  isTerminalRunStatus,
  laterRunReading,
  listWakerFlowConfirmations,
  listWakerFlowRuns,
  retryWakerFlowRun,
  runInputProblems,
  skipWakerFlowConfirmation,
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

const LOST_ANSWER_MESSAGE =
  "网络连接中断，暂时无法确认回答是否已提交。可以直接再提交一次，同一个回答不会重复生效。";
const LOST_RETRY_MESSAGE =
  "网络连接中断，暂时无法确认是否已开始重试。可以直接再按一次，不会重复重试。";

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

  const [values, setValues] = useState<Record<string, string>>(() =>
    initialInputValues(plan.inputs),
  );
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
    const inputs = filledInputValues(plan.inputs, values);
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
        setValues(initialInputValues(plan.inputs));
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
    <div className="flex flex-col gap-[22px]">
      <form
        aria-label="运行这个 WakerFlow"
        className={`${CARD_FACE} flex flex-col gap-3 p-[14px]`}
        noValidate
        onSubmit={submit}
      >
        {plan.inputs.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            这个流程不需要输入，可以直接运行。
          </p>
        ) : (
          <FlowInputFields
            idPrefix="run-input"
            inputs={plan.inputs}
            onChange={(key, value) => {
              const next = { ...values, [key]: value };
              setValues(next);
              if (Object.keys(problems).length > 0)
                setProblems(runInputProblems(plan, next));
            }}
            problems={problems}
            values={values}
          />
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

      <section aria-label="运行记录" className="flex flex-col gap-[9px]">
        <h3 className="font-bold text-[15px] tracking-[-0.01em]">运行记录</h3>
        {runs.isPending ? (
          <p className="text-[13px] text-muted-foreground" role="status">
            正在加载运行记录…
          </p>
        ) : runs.error ? (
          <p className="text-destructive text-sm" role="alert">
            {runs.error.message}
          </p>
        ) : list.length === 0 ? (
          <p className="rounded-[13px] border border-border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
            还没有运行记录。
          </p>
        ) : (
          <ul className="flex flex-col gap-[9px]">
            {list.map((run) => (
              <RunRow
                ended={ended[run.id] ?? null}
                flow={flow}
                key={run.id}
                onEnded={remember}
                onRetried={async (newRunId) => {
                  setSelected(newRunId);
                  await queryClient.invalidateQueries({
                    queryKey: wakerFlowKeys.runs(flow.id),
                  });
                }}
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
  onRetried: (newRunId: string) => void;
}) {
  const { flow, run, ended } = props;
  const status = ended?.status ?? run.status;
  const created = new Date(run.createdAt);
  return (
    <li
      className={`${CARD_FACE} px-[14px] py-[10px] ${
        props.open ? "border-foreground/20" : ""
      }`}
    >
      <div className="flex flex-row flex-wrap items-center justify-between gap-3">
        <button
          aria-expanded={props.open}
          className="flex min-w-0 items-center gap-[10px] rounded-[7px] text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={props.onToggle}
          type="button"
        >
          <span className="font-medium tabular-nums">
            {Number.isNaN(created.getTime())
              ? "运行"
              : created.toLocaleString("zh-CN")}
          </span>
          <span data-run-status={run.id}>
            <StateBadge label={runStatusLabel(status)} state={status} />
          </span>
        </button>
        {run.parentTaskId ? (
          <Link
            className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
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
          onRetried={props.onRetried}
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
  onRetried: (newRunId: string) => void;
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
      <p className="mt-2 text-[13px] text-muted-foreground" role="status">
        正在加载这次运行…
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-border border-t pt-3">
      <div className="flex flex-row items-center gap-3">
        <span
          className="text-[13px] text-muted-foreground"
          data-testid="run-detail-status"
        >
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
      {/* WF7: the run on the plan's flowchart, each node in its step's state. */}
      <Flowchart
        label="运行流程图"
        states={Object.fromEntries(
          run.steps.map((step) => [
            step.id,
            {
              state: step.state,
              ...(step.skipReason ? { skipReason: step.skipReason } : {}),
            },
          ]),
        )}
        steps={run.steps}
        title={(node) =>
          run.steps.find((step) => step.id === node.id)?.instruction ?? node.id
        }
      />
      <ol className="flex flex-col gap-[7px]">
        {run.steps.map((step, index) => (
          <li
            className="rounded-[11px] border border-border bg-background/60 px-3 py-[9px] text-[13px]"
            key={step.id}
          >
            <div className="flex flex-row items-start justify-between gap-3">
              <span className="min-w-0 font-medium">
                第 {index + 1} 步 · {step.instruction}
              </span>
              <StateBadge
                label={
                  step.state === "skipped" && step.skipReason === "branch"
                    ? "分支未选中"
                    : (STEP_STATE[step.state] ?? step.state)
                }
                state={step.state}
              />
            </div>
            {step.output ? (
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[12px] text-foreground/90">
                {step.outputKey ? `${step.outputKey}：` : ""}
                {step.output}
              </pre>
            ) : null}
            {step.error ? (
              <p className="mt-2 text-[12px] text-signal-ink">{step.error}</p>
            ) : null}
            {step.branch ? (
              <p className="mt-2 text-[12px] text-muted-foreground">
                走了「{step.branch.label}」分支
              </p>
            ) : null}
            {run.status === "awaiting_action" &&
            index === run.cursor &&
            step.state === "awaiting_action" ? (
              step.childRunId && step.targetFlowId ? (
                // WF7: a nested Flow's step waits on its child run, which has its own page.
                <p className="mt-2 text-xs">
                  这一步在等子流程运行完成。{" "}
                  <Link
                    className="underline"
                    params={{ flowId: step.targetFlowId }}
                    to="/wakerflows/$flowId"
                  >
                    查看子流程
                  </Link>
                </p>
              ) : step.approvalId ? (
                // D5: an approval has one place to be answered, and it is not here.
                <p className="mt-2 text-xs">
                  这一步在等审批。{" "}
                  <Link className="underline" to="/approvals">
                    去审批
                  </Link>
                </p>
              ) : (
                <StepQuestion
                  flowId={flowId}
                  onSettled={() => refetchDetail()}
                  runId={runId}
                  stepId={step.id}
                />
              )
            ) : null}
          </li>
        ))}
      </ol>
      {run.status === "failed" ? (
        <RetryFromFailure
          flowId={flowId}
          onRetried={props.onRetried}
          run={run}
        />
      ) : null}
      <RunTimeline
        flowId={flowId}
        runId={runId}
        version={`${run.status}:${run.cursor}:${run.steps
          .map((step) => step.state)
          .join(",")}`}
      />
    </div>
  );
}

/**
 * A step that stopped on a question (WF8, spec §3.3): the question, a box for the answer, and 跳过.
 * One request id per answer: a retry after a lost reply sends the same one, so the answer is taken
 * once; a question someone else already settled is said so, in the server's words.
 */
function StepQuestion(props: {
  flowId: string;
  runId: string;
  stepId: string;
  onSettled: () => unknown;
}) {
  const { flowId, runId, stepId } = props;
  const queryClient = useQueryClient();
  const asked = useQuery({
    queryKey: wakerFlowKeys.confirmations(flowId, runId),
    queryFn: () => listWakerFlowConfirmations(flowId, runId),
  });
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);
  const confirmation = (asked.data ?? []).find(
    (entry) => entry.nodeId === stepId && entry.status === "pending",
  );
  if (!confirmation) return null;
  const confirmationId = confirmation.id;

  async function settle(kind: "answer" | "skip") {
    if (sending) return;
    if (kind === "answer" && !answer.trim()) {
      setFailure("请填写回答。");
      return;
    }
    const key = JSON.stringify([confirmationId, kind, answer]);
    if (pendingRequest.current?.key !== key)
      pendingRequest.current = { key, id: newId() };
    const requestId = pendingRequest.current.id;
    setSending(true);
    setFailure(null);
    try {
      if (kind === "answer")
        await answerWakerFlowConfirmation(flowId, runId, confirmationId, {
          requestId,
          answer,
        });
      else
        await skipWakerFlowConfirmation(flowId, runId, confirmationId, {
          requestId,
        });
      pendingRequest.current = null;
      await queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.confirmations(flowId, runId),
      });
      await props.onSettled();
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) {
        pendingRequest.current = null;
        setFailure(error.message);
        await queryClient.invalidateQueries({
          queryKey: wakerFlowKeys.confirmations(flowId, runId),
        });
      } else {
        setFailure(LOST_ANSWER_MESSAGE);
      }
    } finally {
      setSending(false);
    }
  }

  const field = `answer-${confirmationId}`;
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[11px] border border-signal/40 bg-signal-soft p-[10px] text-[12px]">
      <p className="font-medium">这一步在问你：{confirmation.question}</p>
      <label className="sr-only" htmlFor={field}>
        你的回答
      </label>
      <Textarea
        id={field}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="你的回答会作为这一步的产出，后面的步骤会读到它。"
        rows={2}
        value={answer}
      />
      {failure ? (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex flex-row gap-2">
        <Button
          disabled={sending}
          onClick={() => void settle("answer")}
          size="sm"
          type="button"
        >
          {sending ? "正在提交…" : "提交回答"}
        </Button>
        <Button
          disabled={sending}
          onClick={() => void settle("skip")}
          size="sm"
          type="button"
          variant="outline"
        >
          跳过这一步
        </Button>
      </div>
    </div>
  );
}

/**
 * 从失败步骤重试 (WF8, spec §3.5, D6): asks once more, naming the step that will run again and that
 * whatever it already did may happen a second time, before the retry is sent. The steps before it
 * are carried over and not run again; the retry runs on the definition this run used (D7).
 */
function RetryFromFailure(props: {
  flowId: string;
  run: WakerFlowRun;
  onRetried: (newRunId: string) => void;
}) {
  const { flowId, run } = props;
  const failedAt = run.steps.findIndex((step) => step.state === "failed");
  const from = failedAt >= 0 ? failedAt : run.cursor;
  const step = run.steps[from];
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  if (!step) return null;

  async function retry() {
    if (sending) return;
    request.current ??= newId();
    setSending(true);
    setFailure(null);
    try {
      const retried = await retryWakerFlowRun(flowId, run.id, {
        requestId: request.current,
      });
      setConfirming(false);
      props.onRetried(retried.newRunId);
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) {
        request.current = null;
        setFailure(error.message);
      } else {
        // The retry may have been registered: the same id is kept, so pressing again starts no second.
        setFailure(LOST_RETRY_MESSAGE);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {confirming ? (
        <div
          className="flex flex-col gap-2 rounded-[11px] border border-signal/40 bg-signal-soft p-[10px]"
          role="alertdialog"
          aria-label="确认从失败步骤重试"
        >
          <p>
            将从第 {from + 1} 步「{step.instruction}」重新执行，前面已完成的
            {from} 步不会再执行，使用的是这次运行时的流程定义。
          </p>
          <p className="text-[12px] text-signal-ink">
            注意：失败的那一步会重新执行一次。它失败之前如果已经发出消息或写入文件，这些操作可能会再发生一次。
          </p>
          {failure ? (
            <p className="text-destructive text-xs" role="alert">
              {failure}
            </p>
          ) : null}
          <div className="flex flex-row gap-2">
            <Button
              disabled={sending}
              onClick={() => void retry()}
              size="sm"
              type="button"
            >
              {sending ? "正在重试…" : "确认重试"}
            </Button>
            <Button
              disabled={sending}
              onClick={() => setConfirming(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-row items-center gap-2">
          <Button
            onClick={() => setConfirming(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            从失败步骤重试
          </Button>
          <span className="text-muted-foreground text-xs">
            失败的那一步会重新执行一次。
          </span>
          {failure ? (
            <span className="text-destructive text-xs" role="alert">
              {failure}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
