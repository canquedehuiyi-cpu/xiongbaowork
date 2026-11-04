import { IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentAuditTrail } from "@/components/agents/audit-trail";
import { AvatarSourcesPanel } from "@/components/avatar/avatar-sources";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import { agentRunningTasksQueryOptions } from "@/lib/bot-lifecycle/queries";
import { RequestError } from "@/lib/client";
import {
  modelChoiceName,
  modelLibraryQueryOptions,
  poolChoiceName,
} from "@/lib/models/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { relativeTime } from "@/lib/relative-time";
import { routinesQueryOptions } from "@/lib/routines/queries";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
} from "@/lib/responsibilities";

/**
 * One coworker's detail page (story D5): what it is responsible for, what it is doing now, which
 * skills and tools it holds, and what has recently happened to it.
 *
 * A sibling of `/wakers` (the trailing underscore), not a child: the card wall has no outlet and
 * this page is a whole screen of its own. It reads only what other screens already serve — the
 * coworker's profile, its responsibilities and routines, the board's running rows, its plugin
 * grants and its audit trail — and edits none of them here: changing a skill is the assembly
 * screen's job, and a second place to grant one would be a second place to get the policy wrong.
 *
 * Each section owns its loading, error and empty state, so one read failing never blanks the
 * others.
 */
export const Route = createFileRoute("/_authed/_app/wakers_/$agentId")({
  component: WakerDetailPage,
});

const RESPONSIBILITY_STATUS: Record<ResponsibilityRecord["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

/** The board's own words for where a task came from (`SOURCE_LABEL` on /tasks), kept identical. */
const TASK_SOURCE_LABEL: Record<string, string> = {
  chat: "对话",
  routine: "例行",
  responsibility: "职责",
  handoff: "交接",
  group_run: "组团",
};

function WakerDetailPage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) {
    return (
      <PageShell title="员工详情">
        <Skeleton className="mt-6 h-16" />
      </PageShell>
    );
  }
  if (!agent.data) {
    const missing =
      agent.error instanceof RequestError && agent.error.status === 404;
    return (
      <PageShell
        backButton={{ label: "数字员工", linkProps: { to: "/wakers" } }}
        title="员工详情"
      >
        {missing ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            找不到这位员工，或者你没有权限查看它。
          </p>
        ) : (
          <div className="mt-6">
            <QueryError
              error={agent.error}
              label="读不到这位员工"
              onRetry={() => void agent.refetch()}
              retrying={agent.isFetching}
            />
          </div>
        )}
      </PageShell>
    );
  }

  const profile = agent.data;
  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link
              params={{ agentId: profile.id }}
              to="/assemble/$agentId"
              {...props}
            />
          )}
          size="sm"
          variant="outline"
        >
          装配
        </Button>
      }
      backButton={{ label: "数字员工", linkProps: { to: "/wakers" } }}
      description={profile.title || undefined}
      title={profile.name}
    >
      <div className="mt-4 flex items-center gap-3">
        <AbstractAvatar
          name={profile.name}
          seed={profile.avatarSeed}
          size={40}
        />
        <p className="min-w-0 text-muted-foreground text-sm">
          {profile.canManage
            ? "你是它的主人，可以在装配页修改它。"
            : "这位员工归别人所有，这里只能看。"}
        </p>
      </div>
      <ModelLine profile={profile} />

      <AvatarSourcesSection profile={profile} />
      <DutiesSection profile={profile} />
      <RunningTasksSection agentId={profile.id} />
      <SkillGrantsSection agentId={profile.id} />

      <PageSection
        description="谁在什么时候对它做了什么，读自现有的审计记录。"
        title="最近审计"
      >
        <AgentAuditTrail agentId={profile.id} />
      </PageSection>
    </PageShell>
  );
}

/**
 * The 分身's information sources (story F1, spec D3): where a person who skipped the onboarding step
 * configures it, and where anybody lists, adds and removes them later.
 *
 * Shown on the person's own 分身 only, which is the one id `GET /api/me/avatar/sources` names; every
 * other coworker's page, and anybody else's 分身, has no such section.
 */
function AvatarSourcesSection({ profile }: { profile: AgentProfile }) {
  const sources = useQuery({
    ...avatarSourcesQueryOptions(),
    enabled: profile.mine,
  });
  if (!profile.mine || sources.data?.agentId !== profile.id) return null;
  return (
    <PageSection
      description="告诉分身你的资料放在哪里、是什么。文字声明只是说明，分身不会因此读取任何文件；本地文件夹是你电脑上交给分身只读查看的文件夹。"
      title="信息来源"
    >
      <AvatarSourcesPanel />
    </PageSection>
  );
}

/**
 * Which model this coworker's runs speak with (story H4), named the way the assembly page names it.
 *
 * Read from the profile's own binding and the existing model library, nothing else: a remote coworker
 * chooses its model on its own server; an unbound one runs on the deployment's model; a pool binding
 * is a platform experience model. A library binding is resolved only against the VIEWER's library,
 * which is the owner's only when the viewer is the owner, so anybody else is told whose library it is
 * in rather than shown an id.
 */
function ModelLine({ profile }: { profile: AgentProfile }) {
  const bound =
    profile.builtIn && Boolean(profile.modelRef || profile.platformModelRef);
  const library = useQuery({ ...modelLibraryQueryOptions(), enabled: bound });

  let name: string;
  if (!profile.builtIn) name = "外部托管模型";
  else if (!bound) name = "部署默认模型";
  else if (library.isPending) name = "正在读取…";
  else if (profile.platformModelRef) {
    const pooled = library.data?.pool.find(
      (model) => model.id === profile.platformModelRef,
    );
    name = pooled
      ? `${poolChoiceName(pooled)}（平台体验模型）`
      : "平台体验模型";
  } else {
    const connected = library.data?.models.find(
      (model) => model.id === profile.modelRef,
    );
    name = connected
      ? modelChoiceName(connected)
      : library.isError
        ? "模型库里的一个模型（读不到模型库）"
        : "主人模型库里的一个模型";
  }

  return (
    <p className="mt-3 text-sm" data-testid="coworker-model">
      <span className="text-muted-foreground">模型：</span>
      {name}
    </p>
  );
}

/** 职责: the role it was given, the long-running duties it holds, and the routines it runs. */
function DutiesSection({ profile }: { profile: AgentProfile }) {
  const duties = useQuery(responsibilitiesQueryOptions());
  const mine = (duties.data ?? []).filter(
    (duty) => duty.agentId === profile.id,
  );

  return (
    <PageSection description="它被交代要负责的事。" title="职责">
      <p className="mt-3 text-sm" data-testid="role-description">
        {profile.roleDescription || (
          <span className="text-muted-foreground">还没写角色描述。</span>
        )}
      </p>

      <h3 className="mt-6 font-medium text-sm">长期职责</h3>
      {duties.isPending ? (
        <Skeleton
          role="status"
          aria-label="正在读取长期职责"
          className="mt-2 h-12"
        />
      ) : duties.isError ? (
        <div className="mt-2">
          <QueryError
            error={duties.error}
            label="读不到长期职责"
            onRetry={() => void duties.refetch()}
            retrying={duties.isFetching}
          />
        </div>
      ) : mine.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-sm">它还没有长期职责。</p>
      ) : (
        <ItemGroup className="mt-2">
          {mine.map((duty) => (
            <Item key={duty.id} size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>
                  {duty.title}
                  <span className="rounded bg-foreground/5 px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
                    {RESPONSIBILITY_STATUS[duty.status] ?? duty.status}
                  </span>
                </ItemTitle>
                <ItemDescription>{duty.instruction}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}

      <h3 className="mt-6 font-medium text-sm">定时任务</h3>
      <RoutineSummary agentId={profile.id} />
    </PageSection>
  );
}

/**
 * The coworker's routines, read-only: what runs, when, and whether it is switched on.
 *
 * Not the routines list, which runs a routine now, pauses it and deletes it: opening a coworker to
 * look at it must not be one click from making it act. Those controls stay on the assembly page,
 * which this links to, beside every other change to the coworker.
 */
function RoutineSummary({ agentId }: { agentId: string }) {
  const routines = useQuery(routinesQueryOptions());
  const mine = (routines.data?.routines ?? []).filter(
    (routine) => routine.agentId === agentId,
  );

  return (
    <div data-testid="routine-summary">
      {routines.isPending ? (
        <Skeleton
          role="status"
          aria-label="正在读取定时任务"
          className="mt-2 h-12"
        />
      ) : routines.isError ? (
        <div className="mt-2">
          <QueryError
            error={routines.error}
            label="读不到定时任务"
            onRetry={() => void routines.refetch()}
            retrying={routines.isFetching}
          />
        </div>
      ) : mine.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-sm">
          这位员工还没有定时任务
        </p>
      ) : (
        <ItemGroup className="mt-2">
          {mine.map((routine) => (
            <Item key={routine.id} size="sm" variant="muted">
              <ItemContent className={routine.enabled ? "" : "opacity-60"}>
                <ItemTitle>
                  {routine.schedule}
                  <span className="font-normal text-muted-foreground text-xs">
                    {routine.timezone}
                  </span>
                  <span className="rounded bg-foreground/5 px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
                    {routine.enabled ? "已启用" : "已暂停"}
                  </span>
                </ItemTitle>
                <ItemDescription className="line-clamp-2">
                  {routine.instruction}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      <Link
        className="mt-2 inline-block text-muted-foreground text-xs underline-offset-2 hover:underline"
        params={{ agentId }}
        to="/assemble/$agentId"
      >
        去装配页管理定时任务
      </Link>
    </div>
  );
}

/** 进行中任务: the board's rows this coworker is executing right now. */
function RunningTasksSection({ agentId }: { agentId: string }) {
  const running = useQuery(agentRunningTasksQueryOptions(agentId));
  const rows = running.data ?? [];

  return (
    <PageSection
      action={
        <Button
          render={(props) => (
            <Link
              /*
               * `period: "all"`: the board defaults to the last month, and this section reads
               * running work with no window, so the link must ask the same question or a task
               * started more than a month ago would be here and missing there. `executor`, not
               * `crew`: one coworker by its whole id, which a package id with a comma in it would
               * not survive as a comma-split roster.
               */
              search={{ executor: agentId, period: "all", status: "running" }}
              to="/tasks"
              {...props}
            />
          )}
          size="sm"
          variant="outline"
        >
          在看板上看
        </Button>
      }
      description="任务看板上由它执行、还没结束的任务。"
      title="进行中任务"
    >
      {running.isPending ? (
        <Skeleton
          role="status"
          aria-label="正在读取进行中任务"
          className="mt-3 h-12"
        />
      ) : running.isError ? (
        /*
         * Said as a failure, never as an empty list: "nothing running" on a board that could not be
         * read is the one wrong answer this section can give.
         */
        <div className="mt-3">
          <QueryError
            error={running.error}
            label="读不到进行中任务"
            onRetry={() => void running.refetch()}
            retrying={running.isFetching}
          />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          它现在没有进行中的任务。
        </p>
      ) : (
        <ItemGroup className="mt-3">
          {rows.map((task) => (
            <Item key={task.id} size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>{task.title}</ItemTitle>
                <ItemDescription>
                  {TASK_SOURCE_LABEL[task.source] ?? task.source} · 更新于
                  {relativeTime(task.updatedAt)}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </PageSection>
  );
}

/** 技能授权: what a run of this coworker actually holds, read-only; granting is the assembly page's. */
function SkillGrantsSection({ agentId }: { agentId: string }) {
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const skills = granted.data?.skills ?? [];
  const tools = granted.data?.tools ?? [];

  return (
    <PageSection
      action={
        <Button
          render={(props) => (
            <Link params={{ agentId }} to="/assemble/$agentId" {...props} />
          )}
          size="sm"
          variant="outline"
        >
          <IconExternalLink />
          去装配页修改
        </Button>
      }
      description="它运行时实际拥有的技能和工具。这里只读，授予或收回请到装配页。"
      title="技能授权"
    >
      {granted.isPending ? (
        <Skeleton
          role="status"
          aria-label="正在读取技能授权"
          className="mt-3 h-12"
        />
      ) : granted.isError ? (
        <div className="mt-3">
          <QueryError
            error={granted.error}
            label="读不到技能授权"
            onRetry={() => void granted.refetch()}
            retrying={granted.isFetching}
          />
        </div>
      ) : skills.length === 0 && tools.length === 0 ? (
        <Empty className="mt-3 h-[120px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              还没有授予任何技能或工具
            </EmptyTitle>
            <EmptyDescription>所以它现在只能对话。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="mt-3">
          {skills.map((skill) => (
            <Item data-grant="skill" key={skill.slug} size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>{skill.title}</ItemTitle>
                <ItemDescription>{skill.summary || "技能"}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
          {tools.map((tool) => (
            <Item data-grant="tool" key={tool.ref} size="sm" variant="muted">
              <ItemContent>
                <ItemTitle>{tool.toolName}</ItemTitle>
                <ItemDescription>
                  {tool.description || "连接器工具"}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </PageSection>
  );
}
