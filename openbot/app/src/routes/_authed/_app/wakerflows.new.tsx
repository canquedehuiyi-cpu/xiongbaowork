import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  CARD_FACE,
  FlowSection,
  SELECT_CLASS,
} from "@/components/wakerflow/flow-ui";
import { PlanEditor } from "@/components/wakerflow/plan-editor";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { RequestError } from "@/lib/client";
import { newId } from "@/lib/new-id";
import {
  cancelWakerFlowGeneration,
  createWakerFlow,
  flowModelChoicesQueryOptions,
  generateWakerFlowPlan,
  getWakerFlow,
  getWakerFlowRequest,
  WAKERFLOW_SUGGESTIONS,
  type WakerFlowCandidate,
  type WakerFlowPlan,
  type WakerFlowRequest,
  wakerFlowKeys,
  wakerFlowQueryOptions,
} from "@/lib/wakerflows";

/**
 * Creating a WakerFlow from a sentence, and editing the plan it becomes (spec D10, WF2/WF3).
 *
 * `?flow=` opens an existing Flow here too: until the detail screen exists (WF-E), this is where the
 * list's rows lead, so a saved plan can be edited and a draft can be generated again.
 */
export const Route = createFileRoute("/_authed/_app/wakerflows/new")({
  component: WakerFlowNewPage,
  validateSearch: (search: Record<string, unknown>): { flow?: string } =>
    typeof search.flow === "string" && search.flow ? { flow: search.flow } : {},
});

function WakerFlowNewPage() {
  const { flow } = Route.useSearch();
  // A different Flow is a different page: nothing typed for one may leak into another.
  return (
    <WakerFlowWorkbench key={flow ?? "new"} initialFlowId={flow ?? null} />
  );
}

/** How often, and for how long, a request whose answer was lost is asked about again. */
const POLL_INTERVAL_MS = 1500;
const POLL_LIMIT = 240;
/** How long a cancel waits for a request the server has not claimed yet. */
const CANCEL_INTERVAL_MS = 300;
const CANCEL_LIMIT = 20;

const NOT_STARTED_MESSAGE = "网络连接中断，这次生成没有开始。可以直接重试。";
const LOST_MESSAGE =
  "网络连接中断，暂时无法确认生成结果。可以重试，同一次请求不会重复生成。";
const NEVER_STARTED_MESSAGE = "这次生成没有开始，已停止。";
const STILL_RUNNING_MESSAGE =
  "生成仍未结束，暂时无法确认结果。可以稍后重试，同一次请求不会重复生成。";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function candidateFor(agent: AgentProfile): WakerFlowCandidate {
  const role =
    agent.title.trim() || agent.roleDescription.trim() || agent.name.trim();
  return {
    agentId: agent.id,
    name: agent.name.trim().slice(0, 160),
    role: (role || "员工").slice(0, 160),
  };
}

type EditorState = { plan: WakerFlowPlan; revision: number; version: number };

/** One request id per question; `spent` once the server settled it, so asking again is a new one. */
type PendingRequest = { key: string; id: string; spent: boolean };

function WakerFlowWorkbench({
  initialFlowId,
}: {
  initialFlowId: string | null;
}) {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const choices = useQuery(flowModelChoicesQueryOptions());
  const existing = useQuery({
    ...wakerFlowQueryOptions(initialFlowId ?? ""),
    enabled: initialFlowId !== null,
  });

  const [flowId, setFlowId] = useState<string | null>(initialFlowId);
  const [idea, setIdea] = useState("");
  const [modelRef, setModelRef] = useState("");
  const [scenario, setScenario] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const request = useRef<PendingRequest | null>(null);
  // Bumped by every press and every cancel, so an answer to an abandoned attempt is ignored.
  const attempt = useRef(0);
  const loaded = useRef(false);

  const models = choices.data ?? [];
  // Never an implicit default: only a model the person picked, and only while it is still offered.
  const chosen = models.some((model) => model.id === modelRef) ? modelRef : "";
  const roster = agents.data ?? [];
  const members = roster
    .filter((agent) => picked.includes(agent.id))
    .map(candidateFor);
  const trimmed = idea.trim();
  const ready =
    trimmed.length > 0 &&
    trimmed.length <= 4000 &&
    chosen !== "" &&
    members.length > 0 &&
    !generating;

  useEffect(() => {
    const flow = existing.data;
    if (!flow || loaded.current) return;
    loaded.current = true;
    setIdea(flow.idea);
    if (flow.modelRef) setModelRef(flow.modelRef);
    if (flow.plan) {
      setPicked(flow.plan.members.map((member) => member.agentId));
      setEditor({ plan: flow.plan, revision: flow.revision, version: 0 });
    }
  }, [existing.data]);

  useEffect(
    () => () => {
      // Leaving the page abandons any polling still going.
      attempt.current += 1;
    },
    [],
  );

  const spend = () => {
    if (request.current) request.current.spent = true;
  };

  /** Ask where a request stands until it settles. Null: the server never claimed it. */
  async function follow(
    id: string,
    requestId: string,
    mine: number,
  ): Promise<WakerFlowRequest | null | "lost" | "stale"> {
    for (let round = 0; round < POLL_LIMIT; round += 1) {
      if (round > 0) await wait(POLL_INTERVAL_MS);
      if (attempt.current !== mine) return "stale";
      let current: WakerFlowRequest | null;
      try {
        current = await getWakerFlowRequest(id, requestId);
      } catch {
        return "lost";
      }
      if (attempt.current !== mine) return "stale";
      if (current?.status !== "pending") return current;
    }
    return "lost";
  }

  async function settle(id: string, outcome: WakerFlowRequest, mine: number) {
    if (outcome.status === "completed" && outcome.result) {
      spend();
      const result = outcome.result;
      let settled: number;
      if (result.applied && result.revision !== null) settled = result.revision;
      else {
        // Not written into the Flow: Save has to be fenced by the Flow's own current revision.
        try {
          settled = (await getWakerFlow(id)).revision;
        } catch (thrown) {
          if (attempt.current !== mine) return;
          setError(
            thrown instanceof RequestError
              ? thrown.message
              : "计划已生成，但网络中断没能读取。请重新加载这个 WakerFlow。",
          );
          return;
        }
      }
      if (attempt.current !== mine) return;
      setEditor((previous) => ({
        plan: result.plan,
        revision: settled,
        version: (previous?.version ?? 0) + 1,
      }));
      setNotice(
        result.applied
          ? "计划已生成，可以在下方修改后保存。"
          : "计划已生成，但这个 WakerFlow 已经保存过；新计划在下方，保存后才会替换。",
      );
      void queryClient.invalidateQueries({ queryKey: wakerFlowKeys.all });
      return;
    }
    // failed, cancelled, unknown: settled for good. Trying again is a new request.
    spend();
    setError(
      outcome.status === "cancelled"
        ? null
        : (outcome.error ?? "计划没能生成，请重试。"),
    );
    if (outcome.status === "cancelled")
      setNotice(outcome.error ?? "已取消生成。");
  }

  async function generate() {
    if (!ready) return;
    attempt.current += 1;
    const mine = attempt.current;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      let id = flowId;
      if (!id) {
        try {
          id = (await createWakerFlow({ idea: trimmed, modelRef: chosen })).id;
        } catch (thrown) {
          setError(
            thrown instanceof RequestError
              ? thrown.message
              : "网络连接中断，WakerFlow 没有创建。可以直接重试。",
          );
          return;
        }
        setFlowId(id);
        void queryClient.invalidateQueries({ queryKey: wakerFlowKeys.list() });
      }
      // Everything the server's request fingerprint covers: names and roles included, so a renamed
      // coworker is a new question rather than a reused id the server refuses with a 409.
      const key = JSON.stringify([id, trimmed, chosen, members, scenario]);
      if (
        !request.current ||
        request.current.key !== key ||
        request.current.spent
      )
        request.current = { key, id: newId(), spent: false };
      const requestId = request.current.id;
      setCancellable(true);

      let outcome: WakerFlowRequest | null | "lost" | "stale";
      try {
        outcome = await generateWakerFlowPlan(id, {
          requestId,
          modelRef: chosen,
          idea: trimmed,
          members,
          ...(scenario ? { scenario } : {}),
        });
      } catch (thrown) {
        if (attempt.current !== mine) return;
        if (
          thrown instanceof RequestError &&
          (thrown.status < 500 || thrown.status === 501)
        ) {
          // Refused before anything was claimed (501: planning is switched off on this server) —
          // except a reused id, which needs a fresh one.
          if (thrown.status === 409) spend();
          setError(thrown.message);
          return;
        }
        // The line dropped or the server broke mid-answer: the request may still be running.
        outcome = await follow(id, requestId, mine);
        if (outcome === null) {
          setError(NOT_STARTED_MESSAGE);
          return;
        }
      }
      if (
        outcome !== null &&
        outcome !== "stale" &&
        outcome !== "lost" &&
        outcome.status === "pending"
      )
        outcome = await follow(id, requestId, mine);
      if (outcome === "stale" || attempt.current !== mine) return;
      if (outcome === "lost") {
        setError(LOST_MESSAGE);
        return;
      }
      if (outcome === null) {
        setError(NOT_STARTED_MESSAGE);
        return;
      }
      if (outcome.status === "pending") {
        setError(STILL_RUNNING_MESSAGE);
        return;
      }
      await settle(id, outcome, mine);
    } finally {
      if (attempt.current === mine) {
        setGenerating(false);
        setCancellable(false);
      }
    }
  }

  /**
   * Cancel one request. A 404 means the server has not claimed it yet (its generate call is still on
   * the way), so the cancel is asked again shortly — otherwise the generation would start after the
   * cancel and run on. Null: it was never claimed while we asked.
   */
  async function requestCancel(
    id: string,
    requestId: string,
    mine: number,
  ): Promise<WakerFlowRequest | null | "stale"> {
    for (let round = 0; round < CANCEL_LIMIT; round += 1) {
      if (round > 0) await wait(CANCEL_INTERVAL_MS);
      if (attempt.current !== mine) return "stale";
      try {
        return await cancelWakerFlowGeneration(id, requestId);
      } catch (thrown) {
        if (!(thrown instanceof RequestError && thrown.status === 404))
          throw thrown;
      }
    }
    return null;
  }

  async function cancel() {
    const current = request.current;
    if (!flowId || !current) return;
    attempt.current += 1;
    const mine = attempt.current;
    setCancellable(false);
    try {
      const outcome = await requestCancel(flowId, current.id, mine);
      if (outcome === "stale" || attempt.current !== mine) return;
      if (outcome === null) {
        // Never claimed in all that time: nothing is generating under this id.
        setNotice(NEVER_STARTED_MESSAGE);
        return;
      }
      if (outcome.status === "pending") {
        setNotice("正在取消…");
        const later = await follow(flowId, current.id, mine);
        if (later === "stale") return;
        if (later && later !== "lost") await settle(flowId, later, mine);
        else setError(LOST_MESSAGE);
      } else {
        await settle(flowId, outcome, mine);
      }
    } catch (thrown) {
      if (attempt.current !== mine) return;
      // The id is kept: pressing 生成 again asks for this same request's outcome, never a second one.
      setError(
        thrown instanceof RequestError
          ? thrown.message
          : "网络连接中断，没能取消。可以再次生成以查看这次请求的结果。",
      );
    } finally {
      if (attempt.current === mine) setGenerating(false);
    }
  }

  async function reload() {
    if (!flowId) return;
    try {
      const flow = await getWakerFlow(flowId);
      queryClient.setQueryData(wakerFlowKeys.detail(flowId), flow);
      setEditor((previous) => ({
        plan: flow.plan ?? previous?.plan ?? emptyPlan(),
        revision: flow.revision,
        version: (previous?.version ?? 0) + 1,
      }));
      setError(null);
      setNotice("已加载最新的计划。");
    } catch (thrown) {
      setError(
        thrown instanceof RequestError
          ? thrown.message
          : "网络连接中断，没能重新加载。",
      );
    }
  }

  const modelProblem = choices.error
    ? choices.error instanceof RequestError
      ? choices.error.message
      : "可用于规划的模型没能加载。"
    : !choices.isPending && models.length === 0
      ? "还没有可用于规划的模型。请先在「能力 › 模型库」中接入并启用一个模型。"
      : null;

  return (
    <PageShell
      backButton={{ label: "WakerFlow", linkProps: { to: "/wakerflows" } }}
      description="用一句话说出你想要的流程，选一个模型和参与的员工，生成一份可以修改、保存后执行的计划。"
      // The bar reads 「‹ WakerFlow › 新建」: the Back link already names the list.
      crumb={initialFlowId ? "编辑" : "新建"}
      title={initialFlowId ? "编辑 WakerFlow" : "新建 WakerFlow"}
      width="workbench"
    >
      {initialFlowId && existing.isPending ? (
        <Skeleton
          aria-label="正在加载 WakerFlow"
          className="mb-[12px] h-[96px] rounded-[13px]"
          role="status"
        />
      ) : null}
      {existing.error ? (
        <p
          className="mb-[12px] rounded-[13px] border border-signal/40 bg-signal-soft px-4 py-3 text-[13px] text-signal-ink"
          role="alert"
        >
          {existing.error.message}
        </p>
      ) : null}

      {/*
       * The three things a plan is generated from, in one card at a reading width: what the flow is,
       * which model writes it, and who carries it out. The verb sits at the card's foot.
       */}
      <div
        className={`${CARD_FACE} flex max-w-[880px] flex-col divide-y divide-border`}
      >
        <section className="p-[16px]">
          <h2 className="font-bold text-[15px] tracking-[-0.01em]">描述流程</h2>
          <div className="mt-[10px] flex flex-col gap-[10px]">
            <Textarea
              aria-label="描述你想要的流程"
              maxLength={4000}
              placeholder="例如：每周五汇总本周进展、风险和下周计划，生成一份工作周报"
              value={idea}
              onChange={(event) => {
                setIdea(event.target.value);
                if (!event.target.value.trim()) setScenario(null);
              }}
            />
            <fieldset className="flex flex-wrap gap-[7px]">
              <legend className="sr-only">场景建议</legend>
              {WAKERFLOW_SUGGESTIONS.map((suggestion) => (
                <Button
                  aria-pressed={scenario === suggestion}
                  className="h-auto min-h-7 whitespace-normal py-1 text-left aria-pressed:border-signal/70 aria-pressed:bg-signal-soft"
                  key={suggestion}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setIdea(suggestion);
                    setScenario(suggestion);
                  }}
                >
                  {suggestion}
                </Button>
              ))}
            </fieldset>
          </div>
        </section>

        <section className="p-[16px]">
          <h2 className="font-bold text-[15px] tracking-[-0.01em]">规划模型</h2>
          <div className="mt-[10px] flex flex-col gap-2">
            {choices.isPending ? (
              <Skeleton className="h-[32px] w-full max-w-[288px] rounded-[9px]" />
            ) : null}
            {modelProblem ? (
              <p className="text-[13px] text-muted-foreground" role="status">
                {modelProblem}{" "}
                {!choices.error ? (
                  <Link
                    className="text-foreground underline underline-offset-2"
                    to="/capabilities/models"
                  >
                    去接入模型
                  </Link>
                ) : null}
              </p>
            ) : null}
            {models.length > 0 ? (
              <select
                aria-label="规划模型"
                className={`${SELECT_CLASS} w-full max-w-[288px]`}
                value={chosen}
                onChange={(event) => setModelRef(event.target.value)}
              >
                <option value="">选择模型</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </section>

        <section className="p-[16px]">
          <h2 className="font-bold text-[15px] tracking-[-0.01em]">
            参与的员工
          </h2>
          <div className="mt-[10px] flex flex-wrap gap-[7px]">
            {agents.isPending ? (
              <Skeleton className="h-[32px] w-full max-w-[288px] rounded-[9px]" />
            ) : null}
            {agents.error ? (
              <p className="text-[13px] text-signal-ink" role="alert">
                员工列表没能加载。
              </p>
            ) : null}
            {!agents.isPending && !agents.error && roster.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                你还没有可用的员工，先创建一位员工再来生成流程。
              </p>
            ) : null}
            {roster.map((agent) => (
              <label
                className="flex h-[32px] cursor-pointer items-center gap-[7px] rounded-[9px] border border-border bg-foreground/[0.035] px-[11px] text-[13px] has-checked:border-signal/70 has-checked:bg-signal-soft has-focus-visible:ring-2 has-focus-visible:ring-ring/60"
                key={agent.id}
              >
                <input
                  checked={picked.includes(agent.id)}
                  className="accent-signal"
                  type="checkbox"
                  onChange={(event) =>
                    setPicked((current) =>
                      event.target.checked
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id),
                    )
                  }
                />
                {agent.name}
              </label>
            ))}
          </div>
        </section>

        <div className="flex flex-col gap-[8px] p-[16px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!ready} onClick={() => void generate()}>
              {generating ? "正在生成…" : editor ? "重新生成计划" : "生成计划"}
            </Button>
            {generating ? (
              <Button
                disabled={!cancellable}
                variant="outline"
                onClick={() => void cancel()}
              >
                取消生成
              </Button>
            ) : null}
          </div>
          {error ? (
            <p className="text-[13px] text-signal-ink" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="text-[13px] text-muted-foreground" role="status">
              {notice}
            </p>
          ) : null}
        </div>
      </div>

      {editor && flowId ? (
        <FlowSection title="编辑计划">
          <PlanEditor
            coworkers={roster.map((agent) => ({
              id: agent.id,
              name: agent.name,
            }))}
            flowId={flowId}
            key={editor.version}
            onReload={() => void reload()}
            onSaved={(flow) => {
              setEditor((previous) =>
                previous ? { ...previous, revision: flow.revision } : previous,
              );
              queryClient.setQueryData(wakerFlowKeys.detail(flow.id), flow);
              void queryClient.invalidateQueries({
                queryKey: wakerFlowKeys.list(),
              });
            }}
            plan={editor.plan}
            revision={editor.revision}
          />
        </FlowSection>
      ) : null}
    </PageShell>
  );
}

function emptyPlan(): WakerFlowPlan {
  return { name: "", description: "", members: [], inputs: [], steps: [] };
}
