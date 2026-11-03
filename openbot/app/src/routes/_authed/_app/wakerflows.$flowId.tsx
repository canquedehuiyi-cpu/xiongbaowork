import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunPanel } from "@/components/wakerflow/run-panel";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { RequestError } from "@/lib/client";
import {
  createWakerFlow,
  deleteWakerFlow,
  isTerminalRunStatus,
  listWakerFlowRuns,
  type WakerFlow,
  type WakerFlowPlan,
  wakerFlowKeys,
  wakerFlowQueryOptions,
} from "@/lib/wakerflows";

/**
 * One WakerFlow (spec D10, stories WF4 and WF5): its saved plan, read-only, and its runs.
 *
 * 编辑 opens the plan editor. 复用 makes a new draft Flow holding a copy of this plan and opens it
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
      description={current.description || undefined}
      title={current.name}
    >
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
              <ol className="mt-1 flex flex-col gap-2">
                {plan.steps.map((step, index) => (
                  <li className="rounded-md bg-muted px-3 py-2" key={step.id}>
                    <p className="font-medium">
                      第 {index + 1} 步 · {memberName(step.agentId)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">
                      {step.instruction}
                    </p>
                    <p className="mt-1 text-muted-foreground text-xs">
                      读取：
                      {step.inputKeys.length > 0
                        ? step.inputKeys.join("、")
                        : "无"}
                      {" · 产出："}
                      {step.outputKey}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-muted-foreground text-sm">
            还没有计划。点「编辑」用一句话生成一份。
          </p>
        )}
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
