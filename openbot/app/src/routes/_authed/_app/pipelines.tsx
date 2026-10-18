import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  abortRunMutationOptions,
  createTemplateMutationOptions,
  resumeRunMutationOptions,
  skipStepMutationOptions,
  startRunMutationOptions,
} from "@/lib/pipelines/mutations";
import {
  type PipelineRunStep,
  pipelineRunQueryOptions,
  pipelineTemplatesQueryOptions,
  type StepDraft,
} from "@/lib/pipelines/queries";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

export const Route = createFileRoute("/_authed/_app/pipelines")({
  component: RouteComponent,
  /*
   * `?run=` is the run this page is showing, kept in the address so the board's 打开 on a crew's card
   * and the group chat's "查看这次运行" can land on it (audit N1). Absent means no run is open, which
   * is the same as the page before a person presses 运行.
   */
  validateSearch: (search: Record<string, unknown>): { run?: string } =>
    typeof search.run === "string" && search.run ? { run: search.run } : {},
});

/** What a step's state reads as on the page. Every state the store can leave a step in is named. */
const STATE_WORDS: Record<PipelineRunStep["state"], string> = {
  pending: "还没轮到",
  running: "正在做",
  awaiting_action: "等你处理",
  done: "做完了",
  failed: "失败了",
  skipped: "跳过了",
  aborted: "已结束",
};

/** A blank step, so the editor's rows have ids the run can be matched against later. */
function blankStep(agentId: string): StepDraft {
  return {
    id: `step-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    instruction: "",
  };
}

/**
 * A crew's pipelines: the plan, and the run it produced (spec D10 / I1-I4).
 *
 * The editor writes an *ordered* list because the order is the feature — a review that runs before the
 * code exists reviews nothing — and the run below it is polled rather than pushed, since a crew advances
 * inside the server and the only honest answer about where it got to is to ask again.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const crews = useQuery(wakerGroupsQueryOptions());
  const coworkers = useQuery(agentListQueryOptions());
  const [crewId, setCrewId] = useState<string | null>(null);
  const { run: runId } = Route.useSearch();
  const navigate = useNavigate();
  const setRunId = (id: string | null) =>
    navigate({ to: "/pipelines", search: id ? { run: id } : {} });

  const selected = crewId ?? crews.data?.[0]?.id ?? null;
  const templates = useQuery(
    pipelineTemplatesQueryOptions(selected ?? undefined),
  );
  const names = new Map(
    (coworkers.data ?? []).map((agent) => [agent.id, agent.name]),
  );

  return (
    <PageShell
      description="把小组的工作写成一条流程：谁先做、做什么、然后交给谁。流程跑起来时每一步都会在看板上留下自己的任务卡。"
      title="组团流程"
    >
      {crews.isError ? (
        <QueryError
          label="小组加载失败"
          error={crews.error}
          retrying={crews.isFetching}
          onRetry={() => void crews.refetch()}
        />
      ) : null}
      {coworkers.isError ? (
        <QueryError
          label="员工加载失败"
          error={coworkers.error}
          retrying={coworkers.isFetching}
          onRetry={() => void coworkers.refetch()}
        />
      ) : null}
      {crews.isPending ? (
        <p className="text-muted-foreground text-sm">正在加载小组…</p>
      ) : null}
      {crews.data === undefined ? null : crews.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有小组</EmptyTitle>
            <EmptyDescription>
              流程的步骤只能交给组里的员工。先到「员工 ›
              小组」建一个组，再来这里排流程。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <PageSection title="选一个小组">
            <PageRows>
              <div className="flex flex-wrap gap-2">
                {(crews.data ?? []).map((crew) => (
                  <Button
                    key={crew.id}
                    aria-pressed={crew.id === selected}
                    variant={crew.id === selected ? "default" : "outline"}
                    onClick={() => {
                      setCrewId(crew.id);
                      setRunId(null);
                    }}
                  >
                    {crew.name}
                  </Button>
                ))}
              </div>
            </PageRows>
          </PageSection>

          {selected ? (
            <TemplateEditor
              crewId={selected}
              /*
               * The crew's own roster, in the order the person put it, not the whole workspace. The step
               * picker is where the screen's promise lives — "流程的步骤只能交给组里的员工" — and offering
               * outsiders is offering a plan the server will refuse.
               */
              coworkers={(
                crews.data?.find((crew) => crew.id === selected)?.members ?? []
              )
                .slice()
                .sort((a, b) => Number(a.position) - Number(b.position))
                .map((member) => ({
                  id: member.agentId,
                  name: names.get(member.agentId) ?? "已不在花名册里",
                }))}
              problem={
                coworkers.isError
                  ? "员工名单读不出来，流程里就没法点名谁做。"
                  : null
              }
            />
          ) : null}

          {selected && templates.isError ? (
            <QueryError
              label="流程加载失败"
              error={templates.error}
              retrying={templates.isFetching}
              onRetry={() => void templates.refetch()}
            />
          ) : null}
          {templates.data === undefined || !selected ? null : (
            <PageSection title={`${templates.data?.length ?? 0} 条流程`}>
              <PageRows>
                {(templates.data ?? []).map((template) => (
                  <TemplateRow
                    key={template.id}
                    template={template}
                    names={names}
                    onStarted={setRunId}
                    queryClient={queryClient}
                  />
                ))}
              </PageRows>
            </PageSection>
          )}

          {runId ? (
            <RunPanel
              runId={runId}
              names={names}
              queryClient={queryClient}
              onOpened={() => setRunId(null)}
            />
          ) : null}
        </>
      )}
    </PageShell>
  );
}

/**
 * The step rows, and the one write that saves them.
 *
 * Steps are edited as a whole list and saved in one request, the same way a crew's roster is: a
 * half-applied plan is a plan where step 2 is someone else's job, and nothing downstream can say so.
 */
function TemplateEditor(props: {
  crewId: string;
  coworkers: { id: string; name: string }[];
  problem: string | null;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(createTemplateMutationOptions(queryClient));
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(props.problem);

  if (props.problem && !problem) setProblem(props.problem);

  const first = props.coworkers[0]?.id;

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    // biome-ignore lint/style/noNonNullAssertion: the bound check above is this array's own
    const row = next[index]!;
    // biome-ignore lint/style/noNonNullAssertion: the bound check above covers both indexes
    next[index] = next[target]!;
    next[target] = row;
    setSteps(next);
  }

  return (
    <PageSection title="新建一条流程">
      <div className="flex flex-col gap-3">
        <Input
          aria-label="流程名称"
          placeholder="例如：编程任务"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {props.coworkers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            这个小组里还没有员工。先到「员工 › 小组」把人加进来 ——
            流程的步骤只能交给组里的员工。
          </p>
        ) : steps.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有步骤。第一步通常是「谁先做」。
          </p>
        ) : null}
        {steps.map((step, index) => (
          <div className="flex flex-col gap-2" key={step.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">
                第 {index + 1} 步
              </span>
              <select
                aria-label={`第 ${index + 1} 步的员工`}
                className="border-input bg-background rounded-md border px-2 py-1 text-sm"
                value={step.agentId}
                onChange={(event) =>
                  setSteps(
                    steps.map((row) =>
                      row.id === step.id
                        ? { ...row, agentId: event.target.value }
                        : row,
                    ),
                  )
                }
              >
                {props.coworkers.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {steps.length > 1 ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => move(index, -1)}
                  >
                    上移
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => move(index, 1)}
                  >
                    下移
                  </Button>
                </>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setSteps(steps.filter((row) => row.id !== step.id))
                }
              >
                去掉这步
              </Button>
            </div>
            <Input
              aria-label={`第 ${index + 1} 步要做什么`}
              placeholder="它要做的事，例如：按需求写出实现并自测"
              value={step.instruction}
              onChange={(event) =>
                setSteps(
                  steps.map((row) =>
                    row.id === step.id
                      ? { ...row, instruction: event.target.value }
                      : row,
                  ),
                )
              }
            />
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!first}
            // biome-ignore lint/style/noNonNullAssertion: the button is disabled while it is absent
            onClick={() => setSteps([...steps, blankStep(first!)])}
          >
            加一步
          </Button>
          <Button
            disabled={
              !name.trim() ||
              steps.length === 0 ||
              steps.some((step) => !step.instruction.trim()) ||
              create.isPending
            }
            onClick={() =>
              create.mutate(
                { groupId: props.crewId, name: name.trim(), steps },
                {
                  onError: (thrown: Error) => setProblem(thrown.message),
                  onSuccess: () => {
                    setName("");
                    setSteps([]);
                    setProblem(null);
                  },
                },
              )
            }
          >
            保存流程
          </Button>
        </div>
        {problem ? (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </PageSection>
  );
}

/**
 * One template, and the task it is handed.
 *
 * The task is asked for here rather than stored on the template: a plan is a habit, and the work each
 * press is for is different every time.
 */
function TemplateRow(props: {
  template: {
    id: string;
    name: string;
    steps: { agentId: string; instruction: string }[];
  };
  names: Map<string, string>;
  onStarted: (runId: string) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const start = useMutation(startRunMutationOptions(props.queryClient));
  const [task, setTask] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <Item>
      <ItemContent>
        <ItemTitle>{props.template.name}</ItemTitle>
        <ItemDescription>
          {props.template.steps
            .map(
              (step) =>
                `${props.names.get(step.agentId) ?? step.agentId}：${step.instruction}`,
            )
            .join(" → ")}
        </ItemDescription>
        {problem ? (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="flex items-center gap-2">
        <Input
          aria-label={`交给${props.template.name}的任务`}
          className="w-48"
          placeholder="这次要做什么"
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
        <Button
          disabled={!task.trim() || start.isPending}
          onClick={() =>
            start.mutate(
              { templateId: props.template.id, task: task.trim() },
              {
                onError: (thrown: Error) => setProblem(thrown.message),
                onSuccess: (run) => {
                  setTask("");
                  setProblem(null);
                  props.onStarted(run.runId);
                },
              },
            )
          }
        >
          运行
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * Where the crew got to.
 *
 * Skip and abort are per the spec's I4: the person may stop one step without stopping the plan, or
 * stop the plan outright. A step waiting on an approval is the one thing the screen does not offer to
 * decide here -- the answer belongs to the approvals screen, which holds the row it was asked about.
 */
function RunPanel(props: {
  runId: string;
  names: Map<string, string>;
  queryClient: ReturnType<typeof useQueryClient>;
  onOpened: () => void;
}) {
  const run = useQuery(pipelineRunQueryOptions(props.runId));
  const skip = useMutation(skipStepMutationOptions(props.queryClient));
  const abort = useMutation(abortRunMutationOptions(props.queryClient));
  const resume = useMutation(resumeRunMutationOptions(props.queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const data = run.data;

  return (
    <PageSection title="这次运行">
      {run.isError ? (
        <QueryError
          label="运行记录加载失败"
          error={run.error}
          retrying={run.isFetching}
          onRetry={() => void run.refetch()}
        />
      ) : null}
      {run.isPending ? (
        <p className="text-muted-foreground text-sm">正在问小组跑到哪了…</p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-3">
          <PageRows>
            {data.steps.map((step, index) => (
              <Item key={step.id}>
                <ItemContent>
                  <ItemTitle>
                    第 {index + 1} 步 ·{" "}
                    {props.names.get(step.agentId) ?? step.agentId}
                  </ItemTitle>
                  <ItemDescription>
                    {STATE_WORDS[step.state] ?? step.state}
                    {step.output ? ` · ${step.output}` : ""}
                    {step.error ? ` · ${step.error}` : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {step.state === "awaiting_action" ? (
                    /*
                     * The bridge the approval screen cannot cross on its own.
                     *
                     * The person answers the approval there; this button is for the shape where they
                     * answered it elsewhere (Slack, the phone) and want this run to pick up. What it
                     * sends is the answer they were given, not a new request to the coworker -- see
                     * `pipeline/store.ts`'s `resume`.
                     */
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resume.isPending}
                      onClick={() =>
                        resume.mutate(
                          {
                            runId: props.runId,
                            output: "已经处理完了，按这个往下跑。",
                          },
                          {
                            onError: (thrown: Error) =>
                              setProblem(thrown.message),
                          },
                        )
                      }
                    >
                      我处理完了
                    </Button>
                  ) : step.state === "pending" || step.state === "running" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={skip.isPending}
                      onClick={() =>
                        skip.mutate(
                          { runId: props.runId, stepId: step.id },
                          {
                            onError: (thrown: Error) =>
                              setProblem(thrown.message),
                          },
                        )
                      }
                    >
                      跳过这步
                    </Button>
                  ) : null}
                </ItemActions>
              </Item>
            ))}
          </PageRows>
          {data.status === "running" || data.status === "awaiting_action" ? (
            <Button
              variant="outline"
              disabled={abort.isPending}
              onClick={() =>
                abort.mutate(props.runId, {
                  onError: (thrown: Error) => setProblem(thrown.message),
                  onSuccess: props.onOpened,
                })
              }
            >
              中止这次运行
            </Button>
          ) : (
            <p className="text-muted-foreground text-sm">
              {data.status === "done"
                ? "跑完了。每一步的卡在任务看板上。"
                : data.status === "aborted"
                  ? "已经中止，没做的步骤记为已结束。"
                  : "停在失败的那一步，后面的步骤没有跑。"}
            </p>
          )}
          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </PageSection>
  );
}
