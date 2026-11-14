import {
  type Icon,
  IconBell,
  IconChevronRight,
  IconDeviceLaptop,
  IconLogout,
  IconPalette,
  IconUserEdit,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { useId } from "react";
import {
  employeeGroups,
  listedEmployees,
} from "@/components/app-sidebar/roster";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import {
  SidebarToggleBar,
  useSidebarToggleVisible,
} from "@/components/layout/sidebar-toggle";
import { useOptionalTheme } from "@/components/theme-provider";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { avatarSourcesQueryOptions } from "@/lib/avatar/sources";
import {
  AVATAR_MENU_ITEM,
  type NavigationItem,
  useNavigationItems,
} from "@/lib/navigation";
import { planSummaryQueryOptions } from "@/lib/quota/queries";
import { cn } from "@/lib/utils";
import { initialOf } from "./rail";

/** 「我」菜单里的一行：一个链接。 */
export type MeLink = {
  id: string;
  label: string;
  icon: Icon;
  /** 第二行，只写读得到的真实数据或这一页是做什么的；读不到就没有。 */
  detail?: string;
  link: LinkProps;
  /** 链到的那一页的路径，列表栏拿它判断当前项。 */
  path: string;
  /**
   * 这一行是不是它链到的那一页本身。个人资料、外观只是设置页里某一段的捷径，不认领设置页，免得在设置页时
   * 列表栏三行一起亮。
   */
  claims: boolean;
};

export type MeMenu = {
  /** 名字，没有名字时是邮箱。 */
  name: string;
  /** 头像上画的那个字。 */
  initial: string;
  /** 现在的套餐名；没有套餐或还没读到时没有。 */
  plan?: string;
  /** 本人已召唤的员工数（和侧栏「员工」同一个口径）；员工列表读到之前没有。 */
  employees?: number;
  /** 分组的菜单行。 */
  groups: MeLink[][];
  signOut: { offered: boolean; pending: boolean; run: () => void };
};

/** 这个人自己的分身员工的 id，和原来账户菜单读的是同一处；读不到就不画「我的分身」。 */
function useAvatarAgentId(): string | undefined {
  return useQuery({
    ...avatarSourcesQueryOptions(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data?.agentId;
}

function navLink(item: NavigationItem, detail?: string): MeLink {
  return {
    id: item.id,
    label: item.label,
    icon: item.icon,
    detail,
    link: { to: item.to },
    path: item.to,
    claims: true,
  };
}

/**
 * 「我」的内容，页面（`/me`）和工作台列表栏共用：个人卡的数据，加上取代原账户菜单的菜单。
 *
 * 套餐名和已配对几台电脑来自现在的套餐查询（`planSummaryQueryOptions`，和原账户菜单、套餐页共用缓存），
 * 员工数来自员工列表，「管理」只在导航清单给了这个人管理项时才有（按角色和版本筛过）。加入日期服务端不给，
 * 所以不写。
 */
export function useMeMenu(): MeMenu {
  const user = useQuery(currentUserQueryOptions()).data;
  const quota = useQuery(planSummaryQueryOptions()).data;
  const agents = useQuery(agentListQueryOptions()).data;
  const avatarAgentId = useAvatarAgentId();
  const navigation = useNavigationItems();
  const theme = useOptionalTheme();
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();

  const plan = quota?.plan?.name;
  const plans = navigation.find((item) => item.id === "plans");
  const settings = navigation.find((item) => item.id === "settings");
  const adminItem = navigation.find((item) => item.id === "admin");

  const profile: MeLink[] = [
    {
      id: "profile",
      label: "个人资料",
      icon: IconUserEdit,
      detail: "名字与长期指令",
      link: { to: "/settings" },
      path: "/settings",
      claims: false,
    },
    ...(avatarAgentId
      ? [
          {
            id: AVATAR_MENU_ITEM.id,
            label: AVATAR_MENU_ITEM.label,
            icon: AVATAR_MENU_ITEM.icon,
            link: { to: "/bots/$agentId", params: { agentId: avatarAgentId } },
            path: `/bots/${avatarAgentId}`,
            claims: true,
          } satisfies MeLink,
        ]
      : []),
    {
      id: "devices",
      label: "我的电脑",
      icon: IconDeviceLaptop,
      detail: quota ? `已配对 ${quota.usage.devices} 台` : undefined,
      link: { to: "/settings/devices" },
      path: "/settings/devices",
      claims: true,
    },
    {
      id: "notifications",
      label: "通知",
      icon: IconBell,
      detail: "员工的更新在哪里收到",
      link: { to: "/settings/notifications" },
      path: "/settings/notifications",
      claims: true,
    },
  ];
  const app: MeLink[] = [
    ...(plans ? [navLink(plans, plan)] : []),
    {
      id: "appearance",
      label: "外观",
      icon: IconPalette,
      detail: theme ? (theme.dark ? "深色" : "浅色") : undefined,
      // 设置页的「外观」一段：深色主题和皮肤选择。
      link: { to: "/settings" },
      path: "/settings",
      claims: false,
    },
    ...(settings ? [navLink(settings, "全部高级设置")] : []),
    ...(adminItem ? [navLink(adminItem, "仅管理员")] : []),
  ];

  return {
    name: user?.name?.trim() || user?.email || "",
    initial: initialOf(user?.name, user?.email),
    plan: plan || undefined,
    employees: agents
      ? employeeGroups(listedEmployees(agents)).summoned.length
      : undefined,
    groups: [profile, app],
    signOut: {
      offered: signOutOffered,
      pending: signOut.pending,
      run: signOut.run,
    },
  };
}

/** 列表栏里哪一行是当前项：认领这一页的行里，路径最具体的那一行。 */
export function currentMeLink(
  groups: readonly MeLink[][],
  pathname: string,
): MeLink | undefined {
  const under = (path: string) =>
    pathname === path || pathname.startsWith(`${path}/`);
  return groups
    .flat()
    .filter((row) => row.claims && under(row.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/*
 * 颜色只从 `--wb-*` 令牌取（`skin.css`）。这一页也会画在别的皮肤（包括「经典」）里，那里没有 `--wb-*`，
 * 所以每个取值都带一个应用自己的令牌做后备。
 */
const TONE = {
  fg: "text-[color:var(--wb-fg,var(--foreground))]",
  muted: "text-[color:var(--wb-muted,var(--muted-foreground))]",
  card: "bg-[color:var(--wb-card,var(--card))]",
  line: "border-[color:var(--wb-line,var(--border))]",
  line2: "border-[color:var(--wb-line2,var(--border))]",
  hover: "hover:bg-[color:var(--wb-hover,var(--accent))]",
  accent: "text-[color:var(--wb-accent,var(--signal))]",
  focus:
    "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--wb-accent,var(--ring))]",
} as const;

/** 设计稿 `.menu div`：一行一个入口，名字在左，灰色的第二行在右。 */
const menuRowClassName = cn(
  "flex min-h-[48px] w-full items-center gap-3 border-0 border-t bg-transparent px-4 py-[13px] text-left text-[14px] first:border-t-0",
  TONE.line,
  TONE.fg,
  TONE.hover,
  TONE.focus,
);

function MenuLinkRow({ row }: { row: MeLink }) {
  const detailId = useId();
  const Glyph = row.icon;
  return (
    <li className="flex border-0">
      <Link
        {...row.link}
        aria-describedby={row.detail ? detailId : undefined}
        className={menuRowClassName}
      >
        <Glyph
          aria-hidden="true"
          className={cn("size-[18px] shrink-0", TONE.accent)}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
        {row.detail ? (
          <span
            aria-hidden="true"
            className={cn("shrink-0 truncate text-[12px]", TONE.muted)}
            id={detailId}
          >
            {row.detail}
          </span>
        ) : null}
        <IconChevronRight
          aria-hidden="true"
          className={cn("size-4 shrink-0", TONE.muted)}
        />
      </Link>
    </li>
  );
}

const menuClassName = cn(
  "m-0 flex list-none flex-col overflow-hidden rounded-[14px] border p-0",
  TONE.card,
  TONE.line,
);

/**
 * 「我」页面（`/me`，设计稿「我」那一屏）：个人卡（头像、名字、套餐徽标、已召唤几位员工），下面分组的菜单
 * 取代原来的账户菜单——个人资料、我的分身、我的电脑、通知；套餐与用量、外观、设置，管理员多一行「管理」；
 * 最后是退出登录（只在有登录可退的部署上）。
 */
export function MePage() {
  const menu = useMeMenu();
  const showToggle = useSidebarToggleVisible();
  return (
    <div className={cn("flex h-full min-h-0 flex-col", TONE.fg)} data-me-page>
      {showToggle ? <SidebarToggleBar /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid w-full max-w-[560px] gap-3.5 px-[13px] py-[26px] md:px-[26px]">
          <h1 className="sr-only">我</h1>
          <section
            aria-label="个人卡"
            className={cn(
              "flex items-center gap-3.5 rounded-[16px] border bg-[image:radial-gradient(200px_120px_at_90%_0%,var(--wb-accent-soft,transparent),transparent_70%)] p-4",
              TONE.card,
              TONE.line2,
            )}
          >
            <span
              aria-hidden="true"
              className="grid size-[58px] shrink-0 place-items-center rounded-full bg-[color:var(--wb-card2,var(--muted))] bg-[image:var(--wb-me-avatar,none)] font-semibold text-[22px]"
            >
              {menu.initial}
            </span>
            <div className="min-w-0">
              <p className="m-0 flex min-w-0 items-center gap-1.5">
                <span className="truncate font-semibold text-[17px]">
                  {menu.name}
                </span>
                {menu.plan ? (
                  <span
                    className="shrink-0 rounded-[6px] bg-[image:var(--wb-plan,none)] bg-secondary px-[7px] py-0.5 font-bold text-[10.5px] text-[color:var(--wb-plan-fg,var(--secondary-foreground))] uppercase"
                    data-testid="me-plan"
                  >
                    {menu.plan}
                  </span>
                ) : null}
              </p>
              {menu.employees !== undefined ? (
                <p className={cn("m-0 mt-[3px] text-[12.5px]", TONE.muted)}>
                  已召唤 {menu.employees} 位员工
                </p>
              ) : null}
            </div>
          </section>
          {menu.groups.map((group) => (
            <ul className={menuClassName} key={group[0]?.id}>
              {group.map((row) => (
                <MenuLinkRow key={row.id} row={row} />
              ))}
            </ul>
          ))}
          {menu.signOut.offered ? (
            <ul className={menuClassName}>
              <li className="flex">
                <button
                  className={cn(menuRowClassName, "disabled:opacity-60")}
                  disabled={menu.signOut.pending}
                  onClick={menu.signOut.run}
                  type="button"
                >
                  <IconLogout
                    aria-hidden="true"
                    className={cn("size-[18px] shrink-0", TONE.accent)}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    退出登录
                  </span>
                </button>
              </li>
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
