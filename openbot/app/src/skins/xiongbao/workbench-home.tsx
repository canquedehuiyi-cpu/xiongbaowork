import {
  type Icon,
  IconAt,
  IconBolt,
  IconBoxSeam,
  IconChalkboardTeacher,
  IconChecks,
  IconCircleCheck,
  IconCpu,
  IconLayoutKanban,
  IconListDetails,
  IconPlug,
  IconRoute,
  IconSettings,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import {
  employeeGroups,
  listedEmployees,
} from "@/components/app-sidebar/roster";
import { waitingCount } from "@/components/approvals/waiting";
import { TEACH_A_BOT } from "@/components/browser/browser-nav-item";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  SidebarToggleBar,
  useSidebarToggleVisible,
} from "@/components/layout/sidebar-toggle";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { automationListQueryOptions } from "@/lib/automations/queries";
import { autonomousOverviewQueryOptions } from "@/lib/autonomous/queries";
import { buildEntries } from "@/lib/autonomous/unified";
import { client } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { navigationFor } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import {
  clockOf,
  greetingFor,
  type TodayTask,
  todayFeed,
  todayStats,
} from "@/lib/workbench/today";
import { TONE } from "./employee-card";
import { useBrowserAvailable } from "./list-column";

/**
 * 任务看板的卡，按全部时间读（`period=all`）。看板的时间窗按建卡时间算，月初建、今天做完的卡不能被它
 * 挡在外面；服务端按更新时间倒序给最近的 200 张，今天做完的都在前面。键在 `["tasks"]` 下面，看板改了
 * 卡（查收、归档）时一起刷新。
 */
const todayTasksQueryOptions = () =>
  queryOptions({
    queryKey: ["tasks", "workbench-today"],
    queryFn: () =>
      client<TodayTask[]>("/api/tasks?period=all", "tasks", {
        fallback: "读不到今天的任务。",
      }),
    refetchInterval: 30_000,
  });

/** 现在几点，每分钟走一次：问候、「今天」「今晚」跨过点时跟着变。 */
function useNow(fixed: Date | undefined): Date {
  const [now, setNow] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}

/** 一个数的三种样子：读到了是数，还在读或读不到都只画「—」，读屏念出是哪一种。 */
type Reading = number | "loading" | "error";

function reading(
  query: { isError: boolean; data: unknown },
  value: () => number,
): Reading {
  if (query.data !== undefined) return value();
  return query.isError ? "error" : "loading";
}

/** 一组来源一起才算得出的数：都读到了才是数，有一个读不到就是读不到。 */
function readingOf(
  queries: readonly { isError: boolean; data: unknown }[],
  value: () => number,
): Reading {
  if (queries.every((query) => query.data !== undefined)) return value();
  return queries.some((query) => query.isError && query.data === undefined)
    ? "error"
    : "loading";
}

function Stat({ label, value }: { label: string; value: Reading }) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse rounded-[14px] border p-3.5",
        TONE.card,
        TONE.line,
      )}
    >
      <dt className={cn("text-[12px]", TONE.muted)}>{label}</dt>
      <dd className="m-0 font-bold text-[24px] tabular-nums leading-tight">
        {typeof value === "number" ? (
          value
        ) : (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">
              {value === "error" ? "读不到" : "正在读取"}
            </span>
          </>
        )}
      </dd>
    </div>
  );
}

type Tile = {
  id: string;
  label: string;
  detail: string;
  icon: Icon;
  /** 图标底色，取 `skin.css` 里的 `--wb-app-*`。 */
  tone: string;
  link: LinkProps;
};

/** 应用格子（设计稿工作台那一屏的 `.apps`）：常用六个在前，更多四个在后。 */
const APP_TILES: readonly Tile[] = [
  {
    id: "tasks",
    label: "任务看板",
    detail: "谁在做什么",
    icon: IconLayoutKanban,
    tone: "--wb-app-red",
    link: { to: "/tasks" },
  },
  {
    id: "autonomous",
    label: "自主工作",
    detail: "定时与自动运行",
    icon: IconBolt,
    tone: "--wb-app-amber",
    link: { to: "/autonomous" },
  },
  {
    id: "reachability",
    label: "Waker",
    detail: "规则唤起员工",
    icon: IconAt,
    tone: "--wb-app-violet",
    link: { to: "/reachability" },
  },
  {
    id: "bots",
    label: "人才市场",
    detail: "召唤新员工",
    icon: IconUsers,
    tone: "--wb-app-gold",
    link: { to: "/bots" },
  },
  {
    id: "capabilities",
    label: "能力",
    detail: "技能与插件",
    icon: IconBoxSeam,
    tone: "--wb-app-teal",
    link: { to: "/capabilities" },
  },
  {
    id: "connections",
    label: "连接",
    detail: "授权你的账号",
    icon: IconPlug,
    tone: "--wb-app-blue",
    link: { to: "/connections" },
  },
];

/** 「教员工做事」：只在服务端说能为这个人跑浏览器时才有，和列表栏、侧栏是同一个判断。 */
const TEACH_TILE: Tile = {
  id: "browser",
  label: TEACH_A_BOT,
  detail: "示范一遍给员工",
  icon: IconChalkboardTeacher,
  tone: "--wb-app-violet",
  link: { to: "/browser" },
};

const MORE_TILES: readonly Tile[] = [
  {
    id: "pipelines",
    label: "组团流程",
    detail: "谁先做、交给谁",
    icon: IconRoute,
    tone: "--wb-app-teal",
    link: { to: "/pipelines" },
  },
  {
    id: "team-bots",
    label: "团队 Bot",
    detail: "同事共享的员工",
    icon: IconUsersGroup,
    tone: "--wb-app-blue",
    link: { to: "/team-bots" },
  },
  {
    id: "approvals",
    label: "审批",
    detail: "等你拍板",
    icon: IconChecks,
    tone: "--wb-app-red",
    link: { to: "/approvals" },
  },
];

/** 管理区（仅管理员）：模型、审计、平台设置，各自落到管理里的那一页。 */
const ADMIN_TILES: readonly Tile[] = [
  {
    id: "models",
    label: "模型与套餐",
    detail: "仅管理员",
    icon: IconCpu,
    tone: "--wb-app-admin",
    link: { to: "/admin/providers" },
  },
  {
    id: "audit",
    label: "审计记录",
    detail: "仅管理员",
    icon: IconListDetails,
    tone: "--wb-app-admin",
    link: { to: "/admin/audit" },
  },
  {
    id: "platform",
    label: "平台设置",
    detail: "仅管理员",
    icon: IconSettings,
    tone: "--wb-app-admin",
    link: { to: "/admin/platform" },
  },
];

function TileLink({ tile }: { tile: Tile }) {
  const detailId = useId();
  const Glyph = tile.icon;
  return (
    <li className="flex">
      <Link
        {...tile.link}
        aria-describedby={detailId}
        className={cn(
          "grid w-full content-start justify-items-start gap-2 rounded-[14px] border px-3 py-3.5 font-medium text-[13px] transition-[transform,border-color] duration-150 motion-safe:hover:-translate-y-0.5 hover:border-[color:var(--wb-line2,var(--border))]",
          TONE.card,
          TONE.line,
          TONE.fg,
          TONE.focus,
        )}
      >
        <span
          aria-hidden="true"
          className="grid size-9 place-items-center rounded-[11px] bg-secondary text-[color:var(--wb-app-fg,var(--secondary-foreground))] [&>svg]:size-[18px]"
          style={{ backgroundImage: `var(${tile.tone}, none)` }}
        >
          <Glyph />
        </span>
        <span>{tile.label}</span>
        <span
          aria-hidden="true"
          className={cn("font-normal text-[11px]", TONE.muted)}
          id={detailId}
        >
          {tile.detail}
        </span>
      </Link>
    </li>
  );
}

const tileGridClassName =
  "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5 p-0";

const sectionTitleClassName = cn(
  "m-0 mb-2.5 font-semibold text-[13px] tracking-[.04em]",
  TONE.muted,
);

/**
 * 管理区给不给：沿用导航清单的判断（`navigationFor`，管理员才有、个人版没有）。版本读到之前不当成团队版
 * 先画出来，免得个人版的管理员看见它一闪。
 */
function useAdminSection(): boolean {
  const user = useQuery(currentUserQueryOptions()).data;
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions()).data;
  if (!capabilities) return false;
  return navigationFor(user?.role, capabilities.edition ?? "team").some(
    (item) => item.id === "admin",
  );
}

/**
 * 工作台首页（`/workbench`，设计稿工作台那一屏）：按本地时间问好；今日四个数（在岗员工、今日完成、等你
 * 确认、今晚定时任务）；今日动态（今天做完的任务，按时间倒序，最多 10 条）；应用格子；管理员多一块「管理」。
 * 「整理今日日报」先不做（规格「不做」）。
 *
 * 每个数只在它的来源读到后才画；还在读或读不到都是「—」，不编 0。今日口径见 `lib/workbench/today.ts`。
 *
 * 颜色只从 `--wb-*` 令牌取（`skin.css`）；这一页也会画在别的皮肤（包括「经典」）里，那里没有 `--wb-*`，
 * 每个取值都带一个应用自己的令牌做后备。`now` 只给测试用。
 */
export function WorkbenchHome({ now: fixedNow }: { now?: Date } = {}) {
  const now = useNow(fixedNow);
  const showToggle = useSidebarToggleVisible();
  const user = useQuery(currentUserQueryOptions()).data;
  const agents = useQuery(agentListQueryOptions());
  const tasks = useQuery(todayTasksQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  const overview = useQuery(autonomousOverviewQueryOptions(true));
  const automations = useQuery(automationListQueryOptions());
  const browser = useBrowserAvailable();
  const adminSection = useAdminSection();

  const names = new Map(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  );
  /*
   * 自动任务的下一次运行从它的触发器来。现在的服务端在列表里带着触发器；老服务端不带，要一个个读详情，
   * 这里不读——带不全时今晚的数就算读不到，不少数。
   */
  const automationList = automations.data ?? [];
  const triggersKnown = automationList.every((automation) =>
    Array.isArray(automation.triggers),
  );
  const autonomous = buildEntries({
    overview: overview.data ?? [],
    automations: automationList,
    triggersOf: (id) =>
      automationList.find((automation) => automation.id === id)?.triggers,
    routines: [],
    responsibilities: [],
    agentName: (id) => names.get(id) ?? id,
    flowName: () => "WakerFlow",
    now,
  });
  const counts = todayStats({
    tasks: tasks.data ?? [],
    waiting: inbox.data ? waitingCount(inbox.data) : 0,
    autonomous,
    employees: agents.data
      ? employeeGroups(listedEmployees(agents.data)).summoned.length
      : 0,
    now,
  });
  const automationsReading =
    automations.data !== undefined && !triggersKnown
      ? { isError: true, data: undefined }
      : automations;
  const feed = tasks.data ? todayFeed(tasks.data, now) : [];

  const name = user?.name?.trim() || user?.email || "";
  const hello = greetingFor(now);
  const apps = [...APP_TILES, ...(browser ? [TEACH_TILE] : []), ...MORE_TILES];

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", TONE.fg)}
      data-workbench-home
    >
      {showToggle ? <SidebarToggleBar /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-[18px] px-[13px] py-[22px] md:px-[26px]">
          <h1 className="m-0 font-bold text-[22px] tracking-[-.01em]">
            {name ? `${hello}，${name}` : hello}
          </h1>

          <section aria-label="今日数据">
            <dl className="m-0 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="在岗员工"
                value={reading(agents, () => counts.onDuty)}
              />
              <Stat
                label="今日完成"
                value={reading(tasks, () => counts.doneToday)}
              />
              <Stat
                label="等你确认"
                value={reading(inbox, () => counts.waitingOnYou)}
              />
              <Stat
                label="今晚定时任务"
                value={readingOf(
                  [overview, automationsReading],
                  () => counts.tonight,
                )}
              />
            </dl>
          </section>

          <section aria-labelledby="workbench-feed-title">
            <h2 className={sectionTitleClassName} id="workbench-feed-title">
              今日动态
            </h2>
            <div
              className={cn(
                "rounded-[14px] border px-3.5 py-1.5",
                TONE.card,
                TONE.line,
              )}
            >
              {feed.length > 0 ? (
                <ol className="m-0 list-none p-0">
                  {feed.map((task) => {
                    const who = task.executorAgentId
                      ? names.get(task.executorAgentId)
                      : undefined;
                    return (
                      <li
                        className={cn(
                          "flex items-center gap-2.5 border-t py-2.5 text-[13px] first:border-t-0",
                          TONE.line,
                          TONE.fg2,
                        )}
                        key={task.id}
                      >
                        <span aria-hidden="true" className="shrink-0">
                          {task.executorAgentId ? (
                            <ChannelAvatar
                              participantIds={[task.executorAgentId]}
                              size={26}
                            />
                          ) : (
                            <IconCircleCheck
                              className={cn("size-[26px]", TONE.muted)}
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {who
                            ? `${who} 完成了「${task.title}」`
                            : `「${task.title}」已完成`}
                        </span>
                        <time
                          className={cn("shrink-0 text-[11.5px]", TONE.muted)}
                          dateTime={task.updatedAt}
                        >
                          {clockOf(task.updatedAt)}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className={cn("m-0 py-2.5 text-[13px]", TONE.muted)}>
                  {tasks.data
                    ? "今天还没有做完的任务。"
                    : tasks.isError
                      ? "读不到今天的任务。"
                      : "正在读取今天的任务…"}
                </p>
              )}
            </div>
          </section>

          <section aria-labelledby="workbench-apps-title">
            <h2 className={sectionTitleClassName} id="workbench-apps-title">
              应用
            </h2>
            <ul className={tileGridClassName}>
              {apps.map((tile) => (
                <TileLink key={tile.id} tile={tile} />
              ))}
            </ul>
          </section>

          {adminSection ? (
            <section aria-labelledby="workbench-admin-title">
              <h2 className={sectionTitleClassName} id="workbench-admin-title">
                管理
              </h2>
              <ul className={tileGridClassName}>
                {ADMIN_TILES.map((tile) => (
                  <TileLink key={tile.id} tile={tile} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
