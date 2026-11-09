import type {
  LearningAutoAssignState,
  LearningProposal,
  LearningRunSummary,
  LearningSettings,
  LearningTarget,
} from "@openbot/shared/learning";
import {
  IconChevronRight,
  IconHistory,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import {
  PeopleProposalsSection,
  SharingRequestsSection,
  WhoApprovesSection,
} from "@/components/admin/controls/people-learning";
import { SkillSharingSection } from "@/components/admin/controls/skill-sharing-section";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import { ProposalDialog } from "@/components/learning/proposal-dialog";
import { skillTitle } from "@/lib/learning/display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  reviewLearningProposalMutationOptions,
  startLearningRunMutationOptions,
} from "@/lib/learning/mutations";
import {
  createLearningContainer,
  learnedSkillsQueryOptions,
  learningAutomaticQueryOptions,
  learningDeliveryQueryOptions,
  learningKeys,
  learningOverviewQueryOptions,
  learningProposalQueryOptions,
  learningProposalsQueryOptions,
  learningRunsQueryOptions,
  learningSettingsQueryOptions,
  saveLearningSettings,
} from "@/lib/learning/queries";
import { queryClient as appQueryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/learning")({
  component: LearningPage,
});
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

/** What automatic assignment found, in words, or nothing when there is nothing to say. */
function automaticMessage(
  automatic: LearningAutoAssignState | null | undefined,
  settings: LearningSettings,
): string | undefined {
  if (!automatic) return undefined;
  if (
    automatic.state === "assigned" &&
    settings.defaultTarget?.containerId === automatic.containerId
  )
    return `熊宝已自动使用这个 Intelligence 项目里的「${automatic.containerId}」容器，随时可以在这里改。`;
  if (automatic.state === "absent")
    return `这个 Intelligence 项目里还没有「${automatic.containerId}」学习容器，所以暂时什么都不收集。`;
  if (automatic.state === "not_entitled")
    return "这个 Intelligence 项目的套餐不含自动学习，所以没有分配容器。";
  if (automatic.state === "learning_off")
    return "Intelligence 里关闭了学习，在那里打开之前什么都不收集。";
  if (automatic.state === "unavailable")
    return "熊宝没能向 Intelligence 查询这个项目的学习容器，会自动重试。";
  return undefined;
}

function TargetFields({
  target,
  onChange,
  label,
}: {
  target: LearningTarget | null;
  onChange: (target: LearningTarget | null) => void;
  label: string;
}) {
  const fieldId = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-2 text-sm" htmlFor={`${fieldId}-container`}>
        {label}的学习容器 ID
        <Input
          id={`${fieldId}-container`}
          aria-label={`${label}的学习容器 ID`}
          value={target?.containerId ?? ""}
          maxLength={64}
          placeholder="support-learning"
          onChange={(event) =>
            onChange(
              event.target.value
                ? { ...target, containerId: event.target.value }
                : null,
            )
          }
        />
      </label>
      <label className="grid gap-2 text-sm" htmlFor={`${fieldId}-revision`}>
        指定修订号（可选）
        <Input
          id={`${fieldId}-revision`}
          aria-label={`${label}的修订号`}
          value={target?.revision ?? ""}
          disabled={!target}
          placeholder="最新发布"
          maxLength={256}
          onChange={(event) => {
            if (target)
              onChange({
                containerId: target.containerId,
                ...(event.target.value ? { revision: event.target.value } : {}),
              });
          }}
        />
      </label>
    </div>
  );
}

/**
 * The missing container, and how it gets made: a button when this deployment holds a credential that
 * can create it, and always the exact steps for an operator, since the runtime key cannot.
 */
function ContainerSetup({
  automatic,
}: {
  automatic: Extract<LearningAutoAssignState, { state: "absent" }>;
}) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createLearningContainer,
    onSuccess: async (next) => {
      queryClient.setQueryData(learningKeys.automatic, next);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm">
      {automatic.canCreate && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending
              ? "正在创建…"
              : `创建 ${automatic.containerId} 容器`}
          </Button>
          <span className="text-muted-foreground">
            使用部署时配置的凭据，不会使用运行时密钥。
          </span>
        </div>
      )}
      {(create.error || automatic.createError) && (
        <p role="alert" className="text-destructive">
          {create.error?.message ?? automatic.createError}
        </p>
      )}
      {automatic.instructions && (
        <p>
          <span className="font-medium">创建方法：</span>
          {automatic.instructions}
        </p>
      )}
    </div>
  );
}

/**
 * Who approves is saved from its own dialog. A Participation draft copied the
 * whole object earlier, so sending those two keys back would overwrite a
 * newer choice; PUT /settings keeps the stored value when they are omitted.
 */
function withoutReviewKeys(settings: LearningSettings): LearningSettings {
  const { personalReview: _review, autoApprove: _auto, ...rest } = settings;
  return rest;
}

export function LearningPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(learningSettingsQueryOptions());
  const automatic = useQuery(learningAutomaticQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const roster = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const [draft, setDraft] = useState<LearningSettings | null>(null);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState(false);
  const overview = useQuery(
    learningOverviewQueryOptions(selected || undefined),
  );
  const delivery = useQuery(learningDeliveryQueryOptions(selected));
  const settings = draft ?? settingsQuery.data;
  // About what is saved, so it steps aside while an edit is in progress.
  const automaticNote =
    settingsQuery.data && !draft
      ? automaticMessage(automatic.data, settingsQuery.data)
      : undefined;
  const save = useMutation({
    mutationFn: saveLearningSettings,
    onSuccess: async (next) => {
      queryClient.setQueryData(learningKeys.settings, next);
      setDraft(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
  function change(next: LearningSettings) {
    setDraft(next);
    setSaved(false);
    save.reset();
  }
  const botIds = [
    ...new Set([
      ...roster.map((agent) => agent.id),
      ...Object.keys(settings?.agents ?? {}),
    ]),
  ];
  const nameFor = (id: string) =>
    roster.find((agent) => agent.id === id)?.name ?? id;
  const snapshot = overview.data;

  return (
    <PageShell
      title="自动学习"
      description="审核 Intelligence 提出的技能并发布，把已发布的技能交给员工使用。需要接入 CopilotKit Intelligence（设置 INTELLIGENCE_API_KEY）；没接入时这里只显示原因。"
    >
      <PageSection
        title="哪些员工参与"
        description="学习容器必须已在同一个 Intelligence 项目里建好。改动只影响之后的对话，已有的对话保留最初的容器。这里还没保存任何设置时，会自动使用该项目里名为 openbot 的容器。"
      >
        {settingsQuery.isPending && <p role="status">正在读取自动学习设置…</p>}
        {settingsQuery.error && (
          <p role="alert" className="text-destructive">
            {settingsQuery.error.message}
          </p>
        )}
        {settings && (
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(withoutReviewKeys(settings));
            }}
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  change({ ...settings, enabled: event.target.checked })
                }
              />
              启用自动学习与技能下发
            </label>
            <TargetFields
              label="默认"
              target={settings.defaultTarget}
              onChange={(defaultTarget) =>
                change({ ...settings, defaultTarget })
              }
            />
            {automaticNote && (
              <p role="status" className="text-sm">
                {automaticNote}
              </p>
            )}
            {!draft && automatic.data?.state === "absent" && (
              <ContainerSetup automatic={automatic.data} />
            )}
            <p className="text-muted-foreground text-sm">
              默认容器留空时，没有单独设置的员工不参与。容器 ID 由 1–64
              个小写字母、数字和单个连字符组成。修订号留空则始终使用最新发布的技能。
            </p>
            <fieldset className="grid gap-4">
              <legend className="mb-3 font-medium">按员工设置</legend>
              {(agents.error || hiddenAgents.error) && (
                <p role="alert" className="text-destructive">
                  员工列表读取失败，下面只显示已有的设置。
                </p>
              )}
              {botIds.map((id) => {
                const override = settings.agents[id];
                const mode = !Object.hasOwn(settings.agents, id)
                  ? "inherit"
                  : override === null
                    ? "exclude"
                    : "container";
                return (
                  <div key={id} className="grid gap-3 rounded-lg border p-4">
                    <label className="grid gap-2 text-sm font-medium">
                      {nameFor(id)}
                      <select
                        className={selectClass}
                        aria-label={`${nameFor(id)}是否参与`}
                        value={mode}
                        onChange={(event) => {
                          const mappings = { ...settings.agents };
                          if (event.target.value === "inherit")
                            delete mappings[id];
                          else
                            mappings[id] =
                              event.target.value === "exclude"
                                ? null
                                : {
                                    containerId:
                                      settings.defaultTarget?.containerId ?? "",
                                  };
                          change({ ...settings, agents: mappings });
                        }}
                      >
                        <option value="inherit">使用默认容器</option>
                        <option value="exclude">不参与</option>
                        <option value="container">使用指定容器</option>
                      </select>
                    </label>
                    {mode === "container" && (
                      <TargetFields
                        label={nameFor(id)}
                        target={override ?? null}
                        onChange={(target) =>
                          change({
                            ...settings,
                            agents: {
                              ...settings.agents,
                              [id]: target ?? { containerId: "" },
                            },
                          })
                        }
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
            <div className="flex items-center justify-end gap-3">
              {saved && (
                <p role="status" className="text-sm">
                  已保存。
                </p>
              )}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "正在保存…" : "保存设置"}
              </Button>
            </div>
            {save.error && (
              <p role="alert" className="text-destructive">
                {save.error.message}
              </p>
            )}
          </form>
        )}
      </PageSection>
      <PageSection
        title="审核与发布"
        description="Intelligence 分析之后会提出技能，在下面审核并发布；员工只会用已发布的技能。注意：本部署的对话保存在自己的数据库里，不会作为学习证据自动送进 Intelligence。"
      >
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm">
            查看哪位员工的容器
            <select
              className={selectClass}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">默认容器</option>
              {botIds.map((id) => (
                <option key={id} value={id}>
                  {nameFor(id)}
                </option>
              ))}
            </select>
          </label>
          {overview.isPending && <p role="status">正在查询 Intelligence…</p>}
          {overview.error && (
            <p role="alert" className="text-destructive">
              {overview.error.message}
            </p>
          )}
          {snapshot && (
            <>
              <p className="text-sm">
                {snapshot.configuration === "configured"
                  ? `${snapshot.container?.name} (${snapshot.container?.id})`
                  : snapshot.configuration === "invalid"
                    ? "所选容器不可用，或 Intelligence 未开启相应功能。"
                    : snapshot.configuration === "selection_required"
                      ? "请选一位员工，或先设置默认容器。"
                      : "还没有分配学习容器。"}
              </p>
              {snapshot.modelProblem && (
                <p role="alert" className="text-destructive text-sm">
                  {snapshot.modelProblem}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
                {(
                  [
                    ["待分析的对话", snapshot.pendingThreadCount],
                    ["待审核的技能", snapshot.pendingCandidateCount],
                    ["已发布的技能", snapshot.publishedSkillCount],
                    ["洞察", snapshot.insightCount],
                  ] as const
                ).map(([label, count]) =>
                  // An older Intelligence with no dashboard does not count these for a project key.
                  count === null ? null : (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-semibold text-xl">{count}</dd>
                    </div>
                  ),
                )}
              </dl>
              <p className="text-sm">
                {snapshot.hasActiveRun
                  ? "正在分析。"
                  : snapshot.latestRunStatus
                    ? `最近一次分析：${snapshot.latestRunStatus}。`
                    : "还没有运行过分析。"}
              </p>
              {/* Links into Intelligence's dashboard, where there is one to link to. */}
              {(snapshot.links.learning || snapshot.links.candidates) && (
                <div className="flex flex-wrap gap-4 text-sm underline">
                  {snapshot.links.learning && (
                    <a
                      href={snapshot.links.learning}
                      target="_blank"
                      rel="noreferrer"
                    >
                      在 Intelligence 里管理学习
                    </a>
                  )}
                  {snapshot.links.candidates && (
                    <a
                      href={snapshot.links.candidates}
                      target="_blank"
                      rel="noreferrer"
                    >
                      审核候选技能
                    </a>
                  )}
                </div>
              )}
            </>
          )}
          {selected && (
            <div className="grid gap-2 rounded-lg border p-4 text-sm">
              <h3 className="font-medium">技能下发</h3>
              {delivery.isPending ? (
                <p>正在检查下发状态…</p>
              ) : delivery.error ? (
                <p role="alert">{delivery.error.message}</p>
              ) : (
                delivery.data && (
                  <>
                    <p>
                      {!delivery.data.configured
                        ? "这位员工没有开启技能下发。"
                        : !delivery.data.initialized
                          ? "正在等待第一份经过校验的技能快照。"
                          : delivery.data.stale
                            ? "正在使用上一份校验过的快照，刷新稍后进行。"
                            : "已有校验过的技能快照。"}
                    </p>
                    {delivery.data.revision && (
                      <p>已加载的修订号：{delivery.data.revision}</p>
                    )}
                    {delivery.data.lastCheckedAt && (
                      <p>
                        上次检查：{" "}
                        {new Date(delivery.data.lastCheckedAt).toLocaleString()}
                      </p>
                    )}
                    {delivery.data.error && (
                      <p role="alert">{delivery.data.error.message}</p>
                    )}
                  </>
                )
              )}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={overview.isFetching || delivery.isFetching}
            onClick={() => {
              void overview.refetch();
              if (selected) void delivery.refetch();
              // The sections below read the same container, and a run only moves on when read again.
              for (const key of [
                learningKeys.proposals(selected || undefined),
                learningKeys.runs(selected || undefined),
                learningKeys.skills(selected || undefined),
              ])
                void queryClient.invalidateQueries({ queryKey: key });
            }}
          >
            刷新状态
          </Button>
          <p className="text-muted-foreground text-sm">
            熊宝把项目凭据保存在服务器上。在这里关闭学习会保留设置和对话的容器分配；分析计划仍在
            Intelligence 里管理。
          </p>
        </div>
      </PageSection>
      <ProposedSkills agentId={selected || undefined} />
      <AnalysisRuns agentId={selected || undefined} />
      <PublishedSkills agentId={selected || undefined} />
      {/* M4: 待接入 以下四个上游分区组件（admin/controls/people-learning.tsx、skill-sharing-section.tsx）及 learning/proposal-dialog.tsx、learned-skill-dialog.tsx 文案仍是英文，需中文化 */}
      <WhoApprovesSection />
      <PeopleProposalsSection />
      <SharingRequestsSection />
      <SkillSharingSection />
    </PageShell>
  );
}

const STATUS: Record<LearningProposal["status"], string> = {
  pending_review: "待审核",
  approved: "已发布",
  rejected: "已拒绝",
};

/**
 * The skills Intelligence proposed for the container shown above, to approve (which publishes it to
 * that container's Bots) or reject, and Learn now. Here because a bundled Intelligence has no
 * dashboard of its own to do it in.
 */
function ProposedSkills({ agentId }: { agentId?: string }) {
  const proposals = useQuery(learningProposalsQueryOptions(agentId));
  const learnNow = useMutation(startLearningRunMutationOptions(appQueryClient));
  const review = useMutation(
    reviewLearningProposalMutationOptions(appQueryClient),
  );
  const [open, setOpen] = useState<string | null>(null);
  const containerId = proposals.data?.containerId ?? null;
  return (
    <PageSection
      title="提出的技能"
      description="批准一个技能，就会把它发布给使用这个容器的员工。每个决定都会记在审计日志里。"
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!containerId || learnNow.isPending}
          onClick={() => learnNow.mutate(agentId)}
        >
          {learnNow.isPending ? "正在开始…" : "立即学习"}
        </Button>
      }
    >
      {learnNow.isSuccess && (
        <p role="status" className="mt-4 text-sm">
          已开始学习。完成后新技能会出现在这里。
        </p>
      )}
      {learnNow.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {learnNow.error.message}
        </p>
      )}
      {proposals.isPending ? null : proposals.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {proposals.error.message}
        </p>
      ) : !containerId ? (
        <PageEmpty icon={IconSparkles} title="没有容器">
          先在「哪些员工参与」里选一个容器，才能看到为它提出的技能。
        </PageEmpty>
      ) : proposals.data.proposals.length === 0 ? (
        <PageEmpty icon={IconSparkles} title="还没有提出的技能">
          Intelligence 分析过学习证据之后才会提出技能。点「立即学习」开始一次分析。
        </PageEmpty>
      ) : (
        <PageRows>
          {proposals.data.proposals.map((proposal, index) => (
            <Fragment key={proposal.id}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  <button onClick={() => setOpen(proposal.id)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {skillTitle(proposal.title, proposal.description)}
                  </ItemTitle>
                  <ItemDescription>{proposal.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">
                    {STATUS[proposal.status]}
                  </span>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {open && (
        <ProposalDialog
          decided={review.data?.status}
          deciding={review.isPending}
          error={review.error}
          load={learningProposalQueryOptions(open, agentId)}
          onClose={() => {
            setOpen(null);
            review.reset();
          }}
          onDecide={(decision) =>
            review.mutate({
              proposalId: open,
              decision,
              ...(agentId ? { agentId } : {}),
            })
          }
        />
      )}
    </PageSection>
  );
}

const RUN_STATUS: Record<LearningRunSummary["status"], string> = {
  queued: "排队中",
  freezing: "正在开始",
  batching: "分析中",
  reducing: "分析中",
  finalizing: "正在收尾",
  succeeded: "已完成",
  failed: "失败",
};

const FAILURES: Record<string, string> = {
  LEARNING_MODEL_NOT_CONFIGURED:
    "Intelligence 里还没有为学习配置模型。",
  LEARNING_NOT_ENABLED: "Intelligence 里没有打开学习。",
  LEARNING_CONTAINER_NOT_FOUND: "Intelligence 里已经没有这个容器了。",
};

/** What an admin reads for a failed run. The code itself stays in the row's title. */
function failureSentence(code: string | null): string {
  return (code && FAILURES[code]) || "这次分析失败了。";
}

const RUN_POLL_MS = 10_000;

/** Re-read the runs every few seconds while one is still going, so Queued does not outlive the run. */
export function runPollInterval(
  runs: Pick<LearningRunSummary, "status">[] | undefined,
): number | false {
  return runs?.some(
    (run) => run.status !== "succeeded" && run.status !== "failed",
  )
    ? RUN_POLL_MS
    : false;
}

/** One line saying how many skills and insights a run produced, for the counts it has. */
function runCounts(run: LearningRunSummary): string | null {
  const counts = [
    run.proposals !== null ? `提出 ${run.proposals} 个技能` : null,
    run.insights !== null ? `${run.insights} 条洞察` : null,
  ].filter((count) => count !== null);
  return counts.length > 0 ? counts.join(", ") : null;
}

/** The times a run started and finished, as the reader's local time. */
function runTimes(run: LearningRunSummary): string | null {
  const times = [
    run.startedAt
      ? `开始于 ${new Date(run.startedAt).toLocaleString()}`
      : null,
    run.completedAt
      ? `完成于 ${new Date(run.completedAt).toLocaleString()}`
      : null,
  ].filter((time) => time !== null);
  return times.length > 0 ? times.join(". ") : null;
}

/** The analysis runs of the container shown above, newest first, so no dashboard is needed to see one fail. */
function AnalysisRuns({ agentId }: { agentId?: string }) {
  const runs = useQuery({
    ...learningRunsQueryOptions(agentId),
    refetchInterval: (query) => runPollInterval(query.state.data?.runs),
  });
  return (
    <PageSection
      title="分析记录"
      description="每次分析都会读一遍学习证据，并据此提出技能。"
    >
      {runs.isPending ? null : runs.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {runs.error.message}
        </p>
      ) : !runs.data.containerId ? (
        <PageEmpty icon={IconHistory} title="没有容器">
          先在「哪些员工参与」里选一个容器，才能看到它的分析记录。
        </PageEmpty>
      ) : runs.data.runs.length === 0 ? (
        <PageEmpty icon={IconHistory} title="还没有分析记录">
          学习分析过一次之后，记录会出现在这里。
        </PageEmpty>
      ) : (
        <PageRows>
          {runs.data.runs.map((run, index) => (
            <Fragment key={run.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconHistory />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {RUN_STATUS[run.status]} ·{" "}
                    {run.trigger === "manual" ? "手动" : "自动"}
                  </ItemTitle>
                  {[runTimes(run), runCounts(run)]
                    .filter((line) => line !== null)
                    .map((line) => (
                      <ItemDescription key={line}>{line}</ItemDescription>
                    ))}
                  {run.status === "failed" ? (
                    <ItemDescription title={run.failureCode ?? undefined}>
                      {failureSentence(run.failureCode)}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** The skills published in the container shown above, each opening to its files. */
function PublishedSkills({ agentId }: { agentId?: string }) {
  const skills = useQuery(learnedSkillsQueryOptions(agentId));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <PageSection
      title="已发布的技能"
      description="使用这个容器的员工会用这些技能。点开一个即可阅读。"
    >
      {skills.isPending ? null : skills.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {skills.error.message}
        </p>
      ) : !skills.data.containerId ? (
        <PageEmpty icon={IconSparkles} title="没有容器">
          先在「哪些员工参与」里选一个容器，才能看到它已发布的技能。
        </PageEmpty>
      ) : skills.data.skills.length === 0 ? (
        <PageEmpty icon={IconSparkles} title="还没有已发布的技能">
          在上面批准的技能会出现在这里。
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.data.skills.map((skill, index) => (
            <Fragment key={skill.name}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  <button onClick={() => setOpen(skill.name)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {skillTitle(skill.name, skill.description)}
                  </ItemTitle>
                  <ItemDescription>{skill.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      <LearnedSkillDialog
        name={open}
        title={(() => {
          // The title its row showed.
          const shown = skills.data?.skills.find(
            (skill) => skill.name === open,
          );
          return shown ? skillTitle(shown.name, shown.description) : undefined;
        })()}
        onClose={() => setOpen(null)}
        source={{ kind: "admin", agentId }}
      />
    </PageSection>
  );
}
