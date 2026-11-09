import {
  IconExternalLink,
  IconPlayerPause,
  IconTools,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentAuditTrail } from "@/components/agents/audit-trail";
import { AvatarSourcesPanel } from "@/components/avatar/avatar-sources";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { BotPermissions } from "@/components/bot-profile/permissions";
import {
  BotControls,
  UpdateRoutingSection,
} from "@/components/bot-profile/profile";
import {
  PANEL_FACE,
  PROFILE_TAG,
  ProfileEmpty,
  ProfilePanel,
  ProfileSection,
} from "@/components/bot-profile/profile-kit";
import { PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { EditablePortrait } from "@/components/portraits/portrait-picker";
import { ProjectPicker } from "@/components/projects/project-picker";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { CardIndex, PERSONAL_SURFACE } from "@/components/wakers/card-chrome";
import { STATUS_WORD } from "@/components/wakers/coworker-card";
import {
  type WakerStatus,
  wakersBackLink,
} from "@/components/wakers/wakers-search";
import {
  type AgentProfile,
  agentQueryOptions,
  isSharedWithYou,
} from "@/lib/agents/queries";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import {
  agentRunningTasksQueryOptions,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { RequestError } from "@/lib/client";
import {
  modelChoiceName,
  modelLibraryQueryOptions,
  poolChoiceName,
} from "@/lib/models/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { relativeTime } from "@/lib/relative-time";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
} from "@/lib/responsibilities";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { cn } from "@/lib/utils";

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
 *
 * Drawn in the workbench frame (docs/design/ios-studio): the employee's name in the breadcrumb bar
 * and as the compact heading, then its 「角色档案」 — the 44px face, role, status badge and model, in
 * the same card language as its card on the 员工管理 wall, the person's own 分身 wearing that wall's
 * one local red. Below it the page splits in two on a wide screen: what it is doing and holds on the
 * left, and what is between this person and it (对你, project, sources, routing) beside it on the
 * right; one column on anything narrower, the settings first.
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

/** A loading group: the shape of one panel row, announced. */
function PanelSkeleton({ label }: { label: string }) {
  return (
    <Skeleton
      aria-label={label}
      className="mt-[10px] h-[54px] rounded-[14px]"
      role="status"
    />
  );
}

function WakerDetailPage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId));
  const back = { label: "员工管理", linkProps: wakersBackLink() };

  if (agent.isPending) {
    return (
      <PageShell backButton={back} title="员工详情" width="workbench">
        <Skeleton
          aria-label="正在读取员工"
          className="h-[132px] rounded-[16px]"
          role="status"
        />
      </PageShell>
    );
  }
  if (!agent.data) {
    const missing =
      agent.error instanceof RequestError && agent.error.status === 404;
    return (
      <PageShell backButton={back} title="员工详情" width="workbench">
        {missing ? (
          <p
            className={cn(
              PANEL_FACE,
              "max-w-[640px] px-[16px] py-[14px] text-[13px] text-destructive",
            )}
            role="alert"
          >
            找不到这位员工，或者你没有权限查看它。
          </p>
        ) : (
          <div className="max-w-[640px]">
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
          variant="outline"
        >
          <IconTools />
          装配
        </Button>
      }
      backButton={back}
      crumb={profile.name}
      title={profile.name}
      width="workbench"
    >
      <ProfileCard profile={profile} />
      <div className="mt-[12px] empty:hidden">
        <BotPausedBanner agentId={profile.id} />
      </div>

      {/*
       * One employee, one page (user decision: 合并成一个详情页). What is between this person and the
       * employee — the old /bots profile's 对你 and its update routing — sits in the side column, and
       * what it is doing for them and what it is set up with fills the main one.
       */}
      <div className="mt-[28px] grid grid-cols-1 gap-x-[28px] gap-y-[28px] min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        <div className="flex min-w-0 flex-col gap-[28px] min-[1180px]:col-start-2 min-[1180px]:row-start-1">
          <BotControls agent={profile} />
          <ProjectSection profile={profile} />
          <AvatarSourcesSection profile={profile} />
          <UpdateRoutingSection />
        </div>
        <div className="flex min-w-0 flex-col gap-[28px] min-[1180px]:col-start-1 min-[1180px]:row-start-1">
          <BotActivitySections agentId={profile.id} />
          <RunningTasksSection agentId={profile.id} />
          <DutiesSection profile={profile} />
          <SkillGrantsSection agentId={profile.id} />
          <BotPermissions agentId={profile.id} />
          <ProfileSection
            description="谁在什么时候对它做了什么，读自现有的审计记录。"
            title="最近审计"
          >
            <AgentAuditTrail agentId={profile.id} />
          </ProfileSection>
        </div>
      </div>
    </PageShell>
  );
}

/*
 * The status badge as the wall draws it (coworker-card's `.badge.status`): a brighter pill with the
 * signal dot for 在线, quiet ones for 休息 and 暂停 (with its glyph), a dashed outline for 状态未知 —
 * each with its word, so none is told by colour alone.
 */
const STATUS_BADGE: Record<WakerStatus, string> = {
  working: "bg-foreground/[0.085] text-foreground",
  resting: "bg-foreground/[0.05] text-muted-foreground",
  paused: "bg-foreground/[0.05] text-muted-foreground",
  unknown:
    "border border-dashed border-muted-foreground/60 text-muted-foreground",
};

const STATUS_SENTENCE: Record<WakerStatus, string> = {
  working: "正在处理看板上的任务。",
  resting: "当前没有运行中的任务。",
  paused: "你已暂停它，恢复之前它不会再替你开工。",
  unknown: "读不到看板或暂停状态，现在的状态不确定。",
};

/**
 * Where this employee stands, from the two reads the page already makes: its pause (对你) and the
 * board's running rows. Nothing while either is still loading; 状态未知 when either failed, because
 * a read that failed is not rest.
 */
function useProfileStatus(agentId: string): WakerStatus | null {
  const lifecycle = useQuery(botLifecycleQueryOptions(agentId));
  const running = useQuery(agentRunningTasksQueryOptions(agentId));
  if (lifecycle.data?.paused) return "paused";
  if (running.data && running.data.length > 0) return "working";
  if (lifecycle.isError || running.isError) return "unknown";
  if (lifecycle.data && running.data) return "resting";
  return null;
}

/** The hairline and highlight around the 44px face (the wall card's `FACE_RING`). */
const FACE_RING =
  "inline-flex shrink-0 rounded-[13px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_13%,transparent)] [&_svg]:scale-[1.42]";

/**
 * The employee's 「角色档案」: the card it wears on the 员工管理 wall, drawn wide. A mono `PROFILE`
 * index with its tags and the status badge on top; the face (a button that changes it, for its
 * owner), its role line and what it is for; and a footer of facts under a hairline — the model its
 * runs speak with, and whose it is.
 */
function ProfileCard({ profile }: { profile: AgentProfile }) {
  const status = useProfileStatus(profile.id);
  const sources = useQuery({
    ...avatarSourcesQueryOptions(),
    enabled: profile.mine,
  });
  const isAvatar = profile.mine && sources.data?.agentId === profile.id;
  const unconfigured = isAvatar && sources.data?.configuredAt === null;
  const role = isAvatar ? "个人分身" : profile.title.trim() || "员工";

  return (
    <div
      className={cn(
        "relative isolate flex min-w-0 flex-col overflow-hidden rounded-[16px] border border-border bg-card px-[16px] pt-[12px] pb-[12px] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] md:px-[18px]",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(ellipse_at_12%_0,color-mix(in_oklab,var(--foreground)_7%,transparent),transparent_70%)] before:content-['']",
        isAvatar && PERSONAL_SURFACE,
      )}
      data-personal={isAvatar ? "" : undefined}
      data-testid="profile-card"
    >
      <div className="flex min-h-[21px] flex-wrap items-start justify-between gap-[6px]">
        <span className="flex min-w-0 flex-wrap items-center gap-[5px]">
          <CardIndex index={isAvatar ? "ME" : "DETAIL"} kind="Profile" />
          {isAvatar ? (
            <span
              className={cn(PROFILE_TAG, "bg-signal-soft text-signal-ink")}
              data-avatar-tag=""
            >
              个人分身
            </span>
          ) : null}
          {unconfigured ? (
            <span
              className={cn(
                PROFILE_TAG,
                "border border-signal/45 border-dashed bg-transparent text-signal-ink",
              )}
              title="还没有登记信息来源，可以在下面的「信息来源」里配置。"
            >
              待配置
            </span>
          ) : null}
          {profile.pinned ? <span className={PROFILE_TAG}>已置顶</span> : null}
          {profile.hidden ? <span className={PROFILE_TAG}>已隐藏</span> : null}
          {isSharedWithYou(profile) ? (
            <span className={PROFILE_TAG}>共享给你</span>
          ) : null}
        </span>
        {status ? (
          <span
            className={cn(
              "inline-flex h-[21px] shrink-0 items-center gap-[5px] rounded-full px-[8px] font-semibold text-[11px] whitespace-nowrap",
              STATUS_BADGE[status],
            )}
            data-status={status}
            title={STATUS_SENTENCE[status]}
          >
            {status === "working" ? (
              <span
                aria-hidden="true"
                className="size-[5px] rounded-full bg-signal"
              />
            ) : null}
            {status === "paused" ? (
              <IconPlayerPause aria-hidden="true" className="size-[11px]" />
            ) : null}
            {STATUS_WORD[status]}
          </span>
        ) : null}
      </div>

      <div className="mt-[12px] flex min-w-0 items-start gap-[12px]">
        {profile.canManage ? (
          <EditablePortrait
            className={FACE_RING}
            id={profile.id}
            kind="coworker"
            name={profile.name}
            seed={profile.avatarSeed}
            size={44}
          />
        ) : (
          <span className={FACE_RING}>
            <AbstractAvatar
              name={profile.name}
              portrait={{ kind: "coworker", id: profile.id }}
              seed={profile.avatarSeed}
              size={44}
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-[15px] leading-[22px] tracking-[-0.01em]">
            {role}
          </p>
          <p className="mt-px line-clamp-2 text-pretty text-[13px] text-muted-foreground leading-[1.55]">
            {profile.roleDescription.trim() || "还没写职责。"}
          </p>
        </div>
      </div>

      <div className="mt-[12px] flex min-w-0 flex-col gap-x-[18px] gap-y-[4px] border-border border-t pt-[9px] text-[12px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <ModelLine profile={profile} />
        <p className="min-w-0">
          {profile.canManage
            ? "你是它的主人，点头像可以更换，其它设置在装配页修改。"
            : "这位员工归别人所有，这里只能看。"}
        </p>
      </div>
    </div>
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
    <ProfileSection
      description="告诉分身你的资料放在哪里、是什么。文字声明只是说明，分身不会因此读取任何文件；本地文件夹是你电脑上交给分身只读查看的文件夹；知识库和连接器让分身读取你自己的知识库和已连接的账号。"
      title="信息来源"
    >
      <div className={cn(PANEL_FACE, "mt-[10px] p-[14px]")}>
        <AvatarSourcesPanel />
      </div>
    </ProfileSection>
  );
}

/**
 * 当前项目 (story RES2): the project this coworker works in on the person's machine, picked here or
 * beside the conversation. Only on a coworker the person manages: picking a project is a person's
 * act (decision D8), and somebody else's coworker is not theirs to point at their files.
 */
function ProjectSection({ profile }: { profile: AgentProfile }) {
  if (!profile.canManage) return null;
  return (
    <ProfileSection
      description="它在你电脑上干活时所在的项目。不选项目时，它在自己的工作区里执行文件和命令。项目在「能力与资源」里管理。"
      title="当前项目"
    >
      <div className={cn(PANEL_FACE, "mt-[10px] px-[14px] py-[11px]")}>
        <ProjectPicker agentId={profile.id} />
      </div>
    </ProfileSection>
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
    <p className="min-w-0 truncate" data-testid="coworker-model" title={name}>
      <span>模型：</span>
      <b className="font-semibold text-foreground/90">{name}</b>
    </p>
  );
}

/** A small heading inside a section, above one of its groups. */
function SubHead({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-[16px] font-semibold text-[13px] text-foreground/90">
      {children}
    </h3>
  );
}

/** A state word on a row (theme.css `.badge`), beside its title. */
function RowTag({ children }: { children: ReactNode }) {
  return (
    <span className={cn(PROFILE_TAG, "h-[19px] px-[7px] text-[10.5px]")}>
      {children}
    </span>
  );
}

/** 职责: the role it was given, the long-running duties it holds, and the routines it runs. */
function DutiesSection({ profile }: { profile: AgentProfile }) {
  const duties = useQuery(responsibilitiesQueryOptions());
  const mine = (duties.data ?? []).filter(
    (duty) => duty.agentId === profile.id,
  );

  return (
    <ProfileSection description="它被交代要负责的事。" title="职责">
      <p
        className={cn(
          PANEL_FACE,
          "mt-[10px] px-[14px] py-[11px] text-[13.5px] leading-[1.6]",
        )}
        data-testid="role-description"
      >
        {profile.roleDescription || (
          <span className="text-muted-foreground">还没写角色描述。</span>
        )}
      </p>

      <SubHead>长期职责</SubHead>
      {duties.isPending ? (
        <PanelSkeleton label="正在读取长期职责" />
      ) : duties.isError ? (
        <div className="mt-[10px]">
          <QueryError
            error={duties.error}
            label="读不到长期职责"
            onRetry={() => void duties.refetch()}
            retrying={duties.isFetching}
          />
        </div>
      ) : mine.length === 0 ? (
        <ProfileEmpty>它还没有长期职责。</ProfileEmpty>
      ) : (
        <ProfilePanel>
          {mine.map((duty) => (
            <Item key={duty.id} size="sm">
              <ItemContent>
                <ItemTitle>
                  {duty.title}
                  <RowTag>
                    {RESPONSIBILITY_STATUS[duty.status] ?? duty.status}
                  </RowTag>
                </ItemTitle>
                <ItemDescription>{duty.instruction}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ProfilePanel>
      )}

      <SubHead>定时任务</SubHead>
      <RoutineSummary agentId={profile.id} />
    </ProfileSection>
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
        <PanelSkeleton label="正在读取定时任务" />
      ) : routines.isError ? (
        <div className="mt-[10px]">
          <QueryError
            error={routines.error}
            label="读不到定时任务"
            onRetry={() => void routines.refetch()}
            retrying={routines.isFetching}
          />
        </div>
      ) : mine.length === 0 ? (
        <ProfileEmpty>这位员工还没有定时任务</ProfileEmpty>
      ) : (
        <ProfilePanel>
          {mine.map((routine) => (
            <Item key={routine.id} size="sm">
              <ItemContent className={routine.enabled ? "" : "opacity-60"}>
                <ItemTitle>
                  <span className="font-mono text-[12.5px]">
                    {routine.schedule}
                  </span>
                  <span className="font-normal text-muted-foreground text-xs">
                    {routine.timezone}
                  </span>
                  <RowTag>{routine.enabled ? "已启用" : "已暂停"}</RowTag>
                </ItemTitle>
                <ItemDescription className="line-clamp-2">
                  {routine.instruction}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ProfilePanel>
      )}
      <Link
        className="mt-[8px] inline-flex items-center gap-[4px] rounded-[6px] text-[12px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
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
    <ProfileSection
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
      description="任务看板上由它执行、还没结束的任务；上面的「进行中」是它替你跟进的事和等你处理的事。"
      title="看板上的进行中任务"
    >
      {running.isPending ? (
        <PanelSkeleton label="正在读取进行中任务" />
      ) : running.isError ? (
        /*
         * Said as a failure, never as an empty list: "nothing running" on a board that could not be
         * read is the one wrong answer this section can give.
         */
        <div className="mt-[10px]">
          <QueryError
            error={running.error}
            label="读不到进行中任务"
            onRetry={() => void running.refetch()}
            retrying={running.isFetching}
          />
        </div>
      ) : rows.length === 0 ? (
        <ProfileEmpty>它现在没有进行中的任务。</ProfileEmpty>
      ) : (
        <ProfilePanel>
          {rows.map((task) => (
            <Item key={task.id} size="sm">
              <span
                aria-hidden="true"
                className="size-[6px] shrink-0 self-start rounded-full bg-signal mt-[7px]"
              />
              <ItemContent>
                <ItemTitle>{task.title}</ItemTitle>
                <ItemDescription>
                  {TASK_SOURCE_LABEL[task.source] ?? task.source} · 更新于
                  {relativeTime(task.updatedAt)}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ProfilePanel>
      )}
    </ProfileSection>
  );
}

/** 技能授权: what a run of this coworker actually holds, read-only; granting is the assembly page's. */
function SkillGrantsSection({ agentId }: { agentId: string }) {
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const skills = granted.data?.skills ?? [];
  const tools = granted.data?.tools ?? [];

  return (
    <ProfileSection
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
        <PanelSkeleton label="正在读取技能授权" />
      ) : granted.isError ? (
        <div className="mt-[10px]">
          <QueryError
            error={granted.error}
            label="读不到技能授权"
            onRetry={() => void granted.refetch()}
            retrying={granted.isFetching}
          />
        </div>
      ) : skills.length === 0 && tools.length === 0 ? (
        <ProfileEmpty>
          <span className="font-medium text-foreground/80">
            还没有授予任何技能或工具
          </span>
          <span className="ml-[6px]">所以它现在只能对话。</span>
        </ProfileEmpty>
      ) : (
        <ProfilePanel>
          {skills.map((skill) => (
            <Item data-grant="skill" key={skill.slug} size="sm">
              <ItemContent>
                <ItemTitle>
                  {skill.title}
                  <RowTag>技能</RowTag>
                </ItemTitle>
                <ItemDescription>{skill.summary || "技能"}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
          {tools.map((tool) => (
            <Item data-grant="tool" key={tool.ref} size="sm">
              <ItemContent>
                <ItemTitle>
                  {tool.toolName}
                  <RowTag>工具</RowTag>
                </ItemTitle>
                <ItemDescription>
                  {tool.description || "连接器工具"}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ProfilePanel>
      )}
    </ProfileSection>
  );
}
