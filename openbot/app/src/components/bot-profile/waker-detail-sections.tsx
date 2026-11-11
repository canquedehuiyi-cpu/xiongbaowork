/*
 * 熊宝员工详情页的各段（原 `/wakers/$agentId` 一页放下的内容，M5b 拆进上游的 `/bots/$agentId/*` 分页）：
 * 角色档案卡、「本周完成」和分身的信息来源在首页（`BotProfile`），看板上的进行中任务和最近审计在「动态」，
 * 当前项目在「设置」。职责、技能授权、记忆、权限、定时任务各有分页，用的是上游的组件。
 */
import { IconPlayerPause } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentAuditTrail } from "@/components/agents/audit-trail";
import { AvatarSourcesPanel } from "@/components/avatar/avatar-sources";
import {
  PANEL_FACE,
  PROFILE_TAG,
  ProfileEmpty,
  ProfilePanel,
  ProfileSection,
} from "@/components/bot-profile/profile-kit";
import { QueryError } from "@/components/layout/query-error";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
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
import type { WakerStatus } from "@/components/wakers/wakers-search";
import { type AgentProfile, isSharedWithYou } from "@/lib/agents/queries";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import {
  agentRunningTasksQueryOptions,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  modelChoiceName,
  modelLibraryQueryOptions,
  poolChoiceName,
} from "@/lib/models/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/*
 * Each section owns its loading, error and empty state, so one read failing never blanks the
 * others. Drawn in the employee screens' card language (`profile-kit`, docs/design/ios-studio): the
 * 「角色档案」 card is the one it wears on the 员工 roster, drawn wide, the person's own 分身 wearing that
 * roster's one local red.
 */

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
export function useProfileStatus(agentId: string): WakerStatus | null {
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
export function ProfileCard({ profile }: { profile: AgentProfile }) {
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
            ? "你是它的主人，点头像可以更换，其它设置在下面「这位员工的设置」里修改。"
            : "这位员工归别人所有，这里只能看。"}
        </p>
      </div>
    </div>
  );
}

/** Tasks the person marked done this week from this employee's check-ins, folded until asked for. */
export function DoneThisWeek({ agentId }: { agentId: string }) {
  const { done } = useNeedsYou(agentId);
  return <DoneTasks done={done} />;
}

/**
 * The 分身's information sources (story F1, spec D3): where a person who skipped the onboarding step
 * configures it, and where anybody lists, adds and removes them later.
 *
 * Shown on the person's own 分身 only, which is the one id `GET /api/me/avatar/sources` names; every
 * other coworker's page, and anybody else's 分身, has no such section.
 */
export function AvatarSourcesSection({ profile }: { profile: AgentProfile }) {
  const sources = useQuery({
    ...avatarSourcesQueryOptions(),
    enabled: profile.mine,
  });
  if (!profile.mine || sources.data?.agentId !== profile.id) return null;
  return (
    <ProfileSection className="mt-12"
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
export function ProjectSection({ profile }: { profile: AgentProfile }) {
  if (!profile.canManage) return null;
  return (
    <ProfileSection className="mt-12"
      description="它在你电脑上干活时所在的项目。不选项目时，它在自己的工作区里执行文件和命令。项目在「能力 › 公开项目」里管理。"
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
export function ModelLine({ profile }: { profile: AgentProfile }) {
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

/** 进行中任务: the board's rows this coworker is executing right now. */
export function RunningTasksSection({ agentId }: { agentId: string }) {
  const running = useQuery(agentRunningTasksQueryOptions(agentId));
  const rows = running.data ?? [];

  return (
    <ProfileSection className="mt-12"
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
      description="任务看板上由它执行、还没结束的任务；上面的「需要你」是等你处理的事，「动态」是它替你跟进的事。"
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

/**
 * 最近审计: who did what to this employee and when, read from the audit trail the deployment keeps.
 * On the employee's 动态 page, beside what it is doing.
 */
export function RecentAuditSection({ agentId }: { agentId: string }) {
  return (
    <ProfileSection className="mt-12"
      description="谁在什么时候对它做了什么，读自现有的审计记录。"
      title="最近审计"
    >
      <AgentAuditTrail agentId={agentId} />
    </ProfileSection>
  );
}
