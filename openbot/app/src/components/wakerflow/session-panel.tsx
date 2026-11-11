import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Tag } from "@/components/resources/resource-kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RequestError } from "@/lib/client";
import { newId } from "@/lib/new-id";
import {
  activateWakerFlowSession,
  cancelWakerFlowGeneration,
  createWakerFlowSession,
  deleteWakerFlowSession,
  flowModelChoicesQueryOptions,
  listWakerFlowSessions,
  listWakerFlowSessionTurns,
  planDifferences,
  sendWakerFlowSessionTurn,
  type WakerFlow,
  type WakerFlowPlan,
  type WakerFlowRequestStatus,
  type WakerFlowSessionTurn,
  wakerFlowKeys,
} from "@/lib/wakerflows";
import { CARD_FACE, SELECT_CLASS } from "./flow-ui";

const STATUS_LABEL: Record<WakerFlowRequestStatus, string> = {
  pending: "生成中",
  completed: "已生成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
};

const LOST_MESSAGE =
  "网络连接中断，暂时无法确认生成结果。可以重试，同一次请求不会重复生成。";

/** A request id that is still the same question until the server settled it. */
type Pending = { prompt: string; modelRef: string; id: string };

/**
 * The customization sessions of one WakerFlow (WF9, spec §3.1): its history, the session the page
 * opens on, and a conversation that proposes changes to the plan.
 *
 * Each change request is planned against the Flow's current plan and the session's last turns. What
 * comes back is a candidate shown as its differences from the current plan; 应用 opens the editor on
 * it, and only Save makes it the Flow's plan (a never-saved draft takes the candidate at once, as
 * first planning does). 取消 stops a request still being generated.
 */
export function SessionPanel(props: { flow: WakerFlow }) {
  const { flow } = props;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sessions = useQuery({
    queryKey: wakerFlowKeys.sessions(flow.id),
    queryFn: () => listWakerFlowSessions(flow.id),
  });
  const choices = useQuery(flowModelChoicesQueryOptions());
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [modelRef, setModelRef] = useState(flow.modelRef ?? "");
  const [sending, setSending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const retry = useRef<Pending | null>(null);

  const list = sessions.data?.sessions ?? [];
  // The page opens on the active session; a choice the person made wins while it still exists.
  const sessionId =
    (selected && list.some((session) => session.id === selected)
      ? selected
      : null) ??
    sessions.data?.activeSessionId ??
    list[0]?.id ??
    null;
  const session = list.find((entry) => entry.id === sessionId) ?? null;
  const turns = useQuery({
    queryKey: wakerFlowKeys.turns(flow.id, sessionId ?? ""),
    queryFn: () => listWakerFlowSessionTurns(flow.id, sessionId ?? ""),
    enabled: sessionId !== null,
  });

  const models = choices.data ?? [];
  const chosen = models.some((model) => model.id === modelRef) ? modelRef : "";
  const trimmed = prompt.trim();
  const canSend =
    session !== null &&
    flow.plan !== null &&
    trimmed.length > 0 &&
    trimmed.length <= 4000 &&
    chosen !== "" &&
    sending === null;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.sessions(flow.id),
      }),
      queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.detail(flow.id),
      }),
    ]);

  async function startSession() {
    setBusy(true);
    setFailure(null);
    try {
      const created = await createWakerFlowSession(flow.id, {
        requestId: newId(),
      });
      setSelected(created.id);
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "没能新建修改会话。");
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    if (id === sessionId) return;
    // A different session starts a different conversation: nothing pending carries over.
    setConfirmingDelete(false);
    retry.current = null;
    setSelected(id);
    setFailure(null);
    try {
      await activateWakerFlowSession(flow.id, id);
      await queryClient.invalidateQueries({
        queryKey: wakerFlowKeys.sessions(flow.id),
      });
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "没能切换到这个会话。",
      );
    }
  }

  async function removeSession() {
    if (!session) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await deleteWakerFlowSession(flow.id, session.id, session.revision);
      setSelected(null);
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "没能删除这个会话。");
    } finally {
      setConfirmingDelete(false);
      setBusy(false);
    }
  }

  async function send() {
    if (!session || !canSend) return;
    // The same question after a lost answer reuses its id, so the server answers from its row.
    const previous = retry.current;
    const pending: Pending =
      previous && previous.prompt === trimmed && previous.modelRef === chosen
        ? previous
        : { prompt: trimmed, modelRef: chosen, id: newId() };
    retry.current = null;
    setSending(pending);
    setFailure(null);
    try {
      const request = await sendWakerFlowSessionTurn(flow.id, session.id, {
        requestId: pending.id,
        modelRef: pending.modelRef,
        prompt: pending.prompt,
      });
      if (request.status === "completed") setPrompt("");
      else if (request.error) setFailure(request.error);
    } catch (error) {
      if (error instanceof RequestError) setFailure(error.message);
      else {
        retry.current = pending;
        setFailure(LOST_MESSAGE);
      }
    } finally {
      setSending(null);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({
          queryKey: wakerFlowKeys.turns(flow.id, session.id),
        }),
      ]);
    }
  }

  async function cancel() {
    if (!sending) return;
    try {
      await cancelWakerFlowGeneration(flow.id, sending.id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "没能取消这次生成。");
    }
  }

  /**
   * Open the editor on the candidate. The editor reads the Flow from the cache once, so the cache
   * holds the candidate for that one read and is marked stale at once: every later read (this page
   * coming back, a Save) goes to the server, and nothing is changed until the person saves.
   */
  async function apply(plan: WakerFlowPlan) {
    queryClient.setQueryData(wakerFlowKeys.detail(flow.id), {
      ...flow,
      plan: structuredClone(plan),
    });
    await queryClient.invalidateQueries({
      queryKey: wakerFlowKeys.detail(flow.id),
      refetchType: "none",
    });
    await navigate({ to: "/wakerflows/new", search: { flow: flow.id } });
  }

  return (
    <div
      className={`${CARD_FACE} flex flex-col gap-[12px] p-[14px] text-[13px]`}
    >
      <div className="flex flex-row items-center justify-between gap-2">
        <h2 className="font-bold text-[15px] tracking-[-0.01em]">修改会话</h2>
        <Button
          disabled={busy || sending !== null}
          onClick={startSession}
          size="sm"
          variant="outline"
        >
          新建会话
        </Button>
      </div>
      {failure ? (
        <p className="text-signal-ink" role="alert">
          {failure}
        </p>
      ) : null}
      {sessions.error ? (
        <p className="text-signal-ink" role="alert">
          {sessions.error.message}
        </p>
      ) : null}

      {list.length === 0 ? (
        sessions.isSuccess ? (
          <p className="text-muted-foreground">
            还没有修改会话。新建一个，用一句话说明想怎么改这个流程。
          </p>
        ) : null
      ) : (
        <ul aria-label="历史会话" className="flex flex-col gap-1">
          {list.map((entry) => (
            <li key={entry.id}>
              <Button
                aria-current={entry.id === sessionId ? "true" : undefined}
                className="w-full justify-between"
                disabled={sending !== null}
                onClick={() => open(entry.id)}
                size="sm"
                variant={entry.id === sessionId ? "secondary" : "ghost"}
              >
                <span className="truncate">{entry.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {entry.active ? "当前 · " : ""}
                  {entry.turnCount} 轮
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {session ? (
        <div className="flex flex-col gap-3 border-border border-t pt-3">
          <div className="flex flex-row items-center justify-between gap-2">
            <h3 className="min-w-0 truncate font-semibold">{session.title}</h3>
            <Button
              disabled={busy || sending !== null}
              onClick={removeSession}
              size="sm"
              variant="ghost"
            >
              {confirmingDelete ? "确认删除" : "删除会话"}
            </Button>
          </div>
          <ol
            aria-label="修改记录"
            className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto"
          >
            {(turns.data ?? []).map((turn) => (
              <Turn
                current={flow.plan}
                key={turn.id}
                onApply={apply}
                turn={turn}
              />
            ))}
          </ol>
          {flow.plan === null ? (
            <p className="text-muted-foreground">
              先生成一份计划，再在这里修改。
            </p>
          ) : null}
          <Textarea
            aria-label="修改要求"
            disabled={sending !== null}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="例如：把第二步改成先审核"
            value={prompt}
          />
          {models.length > 0 ? (
            <select
              aria-label="规划模型"
              className={SELECT_CLASS}
              onChange={(event) => setModelRef(event.target.value)}
              value={chosen}
            >
              <option value="">选择模型</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : null}
          <div className="flex flex-row gap-2">
            <Button disabled={!canSend} onClick={send} size="sm">
              {sending ? "正在生成…" : "发送"}
            </Button>
            {sending ? (
              <Button onClick={cancel} size="sm" variant="outline">
                取消
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Turn(props: {
  turn: WakerFlowSessionTurn;
  current: WakerFlowPlan | null;
  onApply: (plan: WakerFlowPlan) => void;
}) {
  const { turn, current } = props;
  const plan = turn.plan;
  const changes = plan ? planDifferences(current, plan) : [];
  return (
    <li className="rounded-[11px] border border-border bg-background/60 px-3 py-[9px]">
      <p className="whitespace-pre-wrap">{turn.prompt}</p>
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        {STATUS_LABEL[turn.status]}
        {turn.error ? `：${turn.error}` : ""}
      </p>
      {plan ? (
        <div className="mt-2">
          <p className="font-semibold text-[12px]">与当前计划的差异</p>
          {changes.length === 0 ? (
            <p className="text-muted-foreground">与当前计划相同。</p>
          ) : (
            <ul
              aria-label="与当前计划的差异"
              className="mt-1 list-disc pl-5 text-[12px] text-foreground/90"
            >
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            {turn.applied ? (
              <Tag tone="positive">已应用</Tag>
            ) : (
              <Button
                onClick={() => props.onApply(plan)}
                size="sm"
                variant="outline"
              >
                应用
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
