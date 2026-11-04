import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Flowchart } from "@/components/wakerflow/flowchart";
import { RunPanel } from "@/components/wakerflow/run-panel";
import { SessionPanel } from "@/components/wakerflow/session-panel";
import { ShareDialog } from "@/components/wakerflow/share-dialog";
import { VersionList } from "@/components/wakerflow/version-list";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { RequestError } from "@/lib/client";
import {
  createWakerFlow,
  deleteWakerFlow,
  isTerminalRunStatus,
  listWakerFlowRuns,
  type WakerFlow,
  type WakerFlowPlan,
  type WakerFlowStep,
  wakerFlowKeys,
  wakerFlowQueryOptions,
  wakerFlowsQueryOptions,
} from "@/lib/wakerflows";

/**
 * One WakerFlow (spec D10, stories WF4 and WF5): its saved plan, read-only, and its runs.
 *
 * 版本 lists every saved version and restores one (WF8). 编辑 opens the plan editor. 复用 makes a new draft Flow holding a copy of this plan and opens it
 * in the editor, so the copy is only compiled when the person saves it. 删除 is refused by the server
 * while planning or a run is still going (409); the button then stays disabled with the server's
 * reason until the Flow changes or every run that was going when it refused has ended. Board cards of
 * this Flow's runs open here (`tasks/routes.ts`).
 */
export const Route = createFileRoute("/_authed/_app/wakerflows/$flowId")({
  component: WakerFlowDetailPage,
});

function WakerFlowDetailPage() {
  const { flowId } = Route.useParams();
  // A different Flow is a different page: no run selection or refusal may carry over.
  return <WakerFlowDetail flowId={flowId} key={flowId} />;
}

/** The copy's name, kept inside the server's 160-character bound. */
const copyName = (name: string) => `${name.slice(0, 150)}（副本）`;

export function WakerFlowDetail(props: {
  flowId: string;
  /** Overridable so a test does not wait two seconds per poll. */
  pollIntervalMs?: number;
}) {
  const { flowId } = props;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const flow = useQuery(wakerFlowQueryOptions(flowId));
  const agents = useQuery(agentListQueryOptions());
  // The same cache entry the run panel polls, so a refused 删除 can see the run it waited on end.
  const runs = useQuery({
    queryKey: wakerFlowKeys.runs(flowId),
    queryFn: () => listWakerFlowRuns(flowId),
    enabled: flow.data?.status === "ready",
  });

  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /**
   * The server's refusal, tied to the revision it refused and to the runs that were going then: a
   * newer Flow, or the end of every one of those runs, lets the person ask again.
   */
  const [blocked, setBlocked] = useState<{
    revision: number;
    message: string;
    going: string[];
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  const current = flow.data;
  const runsNow = runs.data ?? [];
  const blockerEnded =
    blocked !== null &&
    blocked.going.length > 0 &&
    blocked.going.every((id) => {
      const seen = runsNow.find((run) => run.id === id);
      return seen ? isTerminalRunStatus(seen.status) : false;
    });
  const deleteBlocked =
    current && blocked && blocked.revision === current.revision && !blockerEnded
      ? blocked.message
      : null;

  async function remove(target: WakerFlow) {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setDeleting(true);
    setFailure(null);
    try {
      await deleteWakerFlow(target.id, target.revision);
      queryClient.removeQueries({ queryKey: wakerFlowKeys.detail(target.id) });
      await queryClient.invalidateQueries({ queryKey: wakerFlowKeys.list() });
      await navigate({ to: "/wakerflows" });
    } catch (error) {
      setConfirming(false);
      if (error instanceof RequestError && error.status === 409) {
        setBlocked({
          revision: target.revision,
          message: error.message,
          going: runsNow
            .filter((run) => !isTerminalRunStatus(run.status))
            .map((run) => run.id),
        });
        // A lost revision race reloads the Flow, and the newer revision re-enables 删除; a fresh run
        // list starts the panel's polling, whose answer re-enables it once those runs have ended.
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: wakerFlowKeys.detail(target.id),
          }),
          queryClient.invalidateQueries({
            queryKey: wakerFlowKeys.runs(target.id),
          }),
        ]);
      } else {
        setFailure(
          error instanceof Error ? error.message : "这个 WakerFlow 没能删除。",
        );
      }
    } finally {
      setDeleting(false);
    }
  }

  async function reuse(source: WakerFlow & { plan: WakerFlowPlan }) {
    setCopying(true);
    setFailure(null);
    try {
      const name = copyName(source.name);
      const created = await createWakerFlow({
        idea: source.idea,
        name,
        description: source.description,
        modelRef: source.modelRef,
      });
      // The copy is a draft: the editor opens on it, and only Save compiles it into a runnable Flow.
      const plan: WakerFlowPlan = structuredClone({ ...source.plan, name });
      queryClient.setQueryData(wakerFlowKeys.detail(created.id), {
        ...created,
        plan,
      });
      await queryClient.invalidateQueries({ queryKey: wakerFlowKeys.list() });
      await navigate({ to: "/wakerflows/new", search: { flow: created.id } });
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "没能复用这个 WakerFlow。",
      );
    } finally {
      setCopying(false);
    }
  }

  if (!current) {
    return (
      <PageShell
        backButton={{ label: "WakerFlow", linkProps: { to: "/wakerflows" } }}
        title="WakerFlow"
      >
        {flow.error ? (
          <p className="mt-8 text-destructive text-sm" role="alert">
            {flow.error.message}
          </p>
        ) : (
          <div className="mt-8 flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14 w-2/3" />
          </div>
        )}
      </PageShell>
    );
  }

  const plan = current.plan;
  const names = new Map(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  );
  const memberName = (agentId: string) =>
    names.get(agentId) ??
    plan?.members.find((member) => member.agentId === agentId)?.role ??
    agentId;
  const runnable = current.status === "ready" && plan !== null;

  return (
    <PageShell
      action={
        <div className="flex flex-row gap-2">
          <Button
            render={(linkProps) => (
              <Link
                search={{ flow: current.id }}
                to="/wakerflows/new"
                {...linkProps}
              />
            )}
            size="sm"
            variant="outline"
          >
            编辑
          </Button>
          {plan ? (
            <Button
              disabled={copying}
              onClick={() => reuse({ ...current, plan })}
              size="sm"
              variant="outline"
            >
              {copying ? "正在复用…" : "复用"}
            </Button>
          ) : null}
          {current.status === "ready" ? <ShareDialog flow={current} /> : null}
          <Button
            disabled={deleting || deleteBlocked !== null}
            onClick={() => remove(current)}
            size="sm"
            variant="destructive"
          >
            {confirming ? "确认删除" : "删除"}
          </Button>
        </div>
      }
      backButton={{ label: "WakerFlow", linkProps: { to: "/wakerflows" } }}
      // WF9: the session panel is a right-hand column on a wide screen, and comes last on a narrow one.
      className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-x-8 lg:[&>*]:col-start-1 lg:[&>header]:col-span-2"
      description={current.description || undefined}
      title={current.name}
      width="wide"
    >
      <aside
        aria-label="修改会话"
        className="order-last mt-8 lg:order-none lg:col-start-2! lg:row-start-2 lg:row-span-12 lg:sticky lg:top-4"
      >
        <SessionPanel flow={current} />
      </aside>
      {deleteBlocked ? (
        <p className="mt-4 text-muted-foreground text-sm" role="status">
          暂时不能删除：{deleteBlocked}
        </p>
      ) : null}
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure}
        </p>
      ) : null}

      <PageSection
        description={
          current.status === "ready" ? "已保存，可以运行。" : "草稿，尚未保存。"
        }
        title="计划"
      >
        {plan ? (
          <div className="mt-3 flex flex-col gap-4 text-sm">
            <div>
              <h3 className="font-medium">员工</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {plan.members.map((member) => (
                  <li key={member.agentId}>
                    {memberName(member.agentId)} · {member.role}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-medium">输入</h3>
              {plan.inputs.length === 0 ? (
                <p className="mt-1 text-muted-foreground">不需要输入。</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {plan.inputs.map((input) => (
                    <li key={input.key}>
                      {input.label}（{input.key}）
                      {input.required ? " · 必填" : " · 选填"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="font-medium">步骤</h3>
              <div className="mt-2">
                <PlanFlowchart memberName={memberName} plan={plan} />
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-muted-foreground text-sm">
            还没有计划。点「编辑」用一句话生成一份。
          </p>
        )}
      </PageSection>

      <PageSection
        description="每次保存都会留下一个版本；恢复旧版本会另存为新版本。"
        title="版本"
      >
        <div className="mt-3">
          <VersionList flow={current} />
        </div>
      </PageSection>

      <PageSection title="运行">
        <div className="mt-3">
          {runnable && plan ? (
            <RunPanel
              flow={{ ...current, plan }}
              {...(props.pollIntervalMs === undefined
                ? {}
                : { pollIntervalMs: props.pollIntervalMs })}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              保存计划后才能运行。
            </p>
          )}
        </div>
      </PageSection>
    </PageShell>
  );
}

/**
 * The saved plan as a flowchart (WF7): every step's kind and what it reads and produces. A nested
 * Flow's node opens that Flow, and says so when it has been saved again since this plan pinned it.
 */
function PlanFlowchart(props: {
  plan: WakerFlowPlan;
  memberName: (agentId: string) => string;
}) {
  const { plan, memberName } = props;
  const nests = plan.steps.some((step) => step.kind === "flow");
  const flows = useQuery({ ...wakerFlowsQueryOptions(), enabled: nests });
  const byId = (id: string) =>
    (flows.data ?? []).find((flow) => flow.id === id);
  const of = (step: { id: string }) =>
    plan.steps.find((candidate) => candidate.id === step.id) as WakerFlowStep;
  return (
    <Flowchart
      detail={(node) => {
        const step = of(node);
        const reads =
          step.kind === "flow" ? Object.values(step.inputMap) : step.inputKeys;
        const who =
          step.kind === "decision" || step.kind === "flow"
            ? ""
            : `${memberName(step.agentId)} · `;
        const out =
          step.kind === "decision" ? "" : ` · 产出：${step.outputKey}`;
        return `${who}读取：${reads.length > 0 ? reads.join("、") : "无"}${out}`;
      }}
      extra={(node) => {
        const step = of(node);
        if (step.kind !== "flow") return null;
        const child = byId(step.targetFlowId);
        return (
          <span className="flex flex-wrap items-center gap-2">
            <Link
              className="underline"
              params={{ flowId: step.targetFlowId }}
              to="/wakerflows/$flowId"
            >
              打开子流程{child ? `「${child.name}」` : ""}（第{" "}
              {step.targetRevision} 版）
            </Link>
            {child && child.revision > step.targetRevision ? (
              <span className="text-amber-700 dark:text-amber-400">
                子流程有新版本（第 {child.revision} 版），编辑后可更新
              </span>
            ) : null}
          </span>
        );
      }}
      label="计划流程图"
      steps={plan.steps}
      title={(node) => {
        const step = of(node);
        switch (step.kind) {
          case "decision":
            return "条件判断";
          case "flow":
            return byId(step.targetFlowId)?.name ?? "子流程";
          case "action":
            return step.tool;
          default:
            return step.instruction.split("\n")[0] ?? "";
        }
      }}
    />
  );
}
