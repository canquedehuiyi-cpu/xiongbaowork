import {
  type Icon,
  IconAt,
  IconBolt,
  IconBoxSeam,
  IconGauge,
  IconLayoutKanban,
  IconPlug,
  IconRoute,
  IconSettings,
  IconShieldLock,
  IconUserCircle,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Where a person can go in OpenBot, in one list, for the sidebar and every skin that replaces it.
 *
 * A destination added here reaches every frame at once. One left out of a frame's own copy would
 * simply be missing from that skin, with nothing failing to say so.
 *
 * `section` says where each entry belongs: `primary` destinations sit with the main places, `more`
 * ones in the sidebar's 「更多」 fold, `account` ones in the menu under the person's name. A skin may
 * group them its own way.
 *
 * 熊宝版（M5b，用户拍板）按上游的页面结构排：员工、任务看板、自主工作、@Waker、能力、连接，后面是教员工做事；
 * 「更多」里是组团流程；账户菜单是我的分身、套餐与用量、设置、管理（仅管理员）。
 *
 * 不在这份清单里的两项：
 * - 教员工做事：只有服务端说能为这个人跑浏览器时才出现，带录制中的红点，由
 *   `components/browser/browser-nav-item.tsx` 的 `BrowserNavItem` 画，紧跟在主导航后面（沿用现有实现）。
 * - 我的分身：地址是这个人自己的分身员工（`/bots/avatar-<tenant>`，id 读自 `GET /api/me/avatar/sources`），
 *   不是固定页面，所以单独定义成 `AVATAR_MENU_ITEM`，由账户菜单解析出地址后画在最前面。
 */
/** 聊天工作台最左侧入口栏的四个入口：消息、通讯录、工作台、我。 */
export type Rail = "msg" | "contacts" | "work" | "me";

export type NavigationItem = {
  /*
   * "routines" is upstream's (#1406) Routines entry. This fork does not list it: scheduled work is
   * under 自主工作, and `/routines` redirects there. It stays in the type so the skins that filter it
   * out of the list (OpenDots draws Routines as its own screen) still compile.
   */
  id:
    | "bots"
    | "tasks"
    | "autonomous"
    | "reachability"
    | "routines"
    | "capabilities"
    | "connections"
    | "pipelines"
    | "plans"
    | "admin"
    | "settings";
  label: string;
  to:
    | "/bots"
    | "/tasks"
    | "/autonomous"
    | "/reachability"
    | "/capabilities"
    | "/connections"
    | "/pipelines"
    | "/settings/plans"
    | "/admin"
    | "/settings";
  icon: Icon;
  section: "primary" | "more" | "account";
  /** 这一项归入口栏的哪一个入口。 */
  rail: Rail;
  /** Admin routes are guarded on the server; the entry is hidden from people who cannot open them. */
  adminOnly?: boolean;
  /**
   * 不在 `to` 下面、却归这一项管的页面，打开它们时这一项仍然亮着：定时任务和长期职责归自主工作，
   * WakerFlow 详情归能力。旧地址（`/wakers`、`/resources` 等）都重定向到新地址，不用列。
   */
  owns?: readonly string[];
};

/** An entry that is a page. Every entry is one; kept so the skins can keep filtering on it. */
export type NavigationLink = NavigationItem;

export function isNavigationLink(item: NavigationItem): item is NavigationLink {
  return Boolean(item.to);
}

export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "bots",
    label: "人才市场",
    to: "/bots",
    icon: IconUsers,
    section: "primary",
    rail: "contacts",
  },
  {
    id: "tasks",
    label: "任务看板",
    to: "/tasks",
    icon: IconLayoutKanban,
    section: "primary",
    rail: "work",
  },
  {
    id: "autonomous",
    label: "自主工作",
    to: "/autonomous",
    icon: IconBolt,
    section: "primary",
    rail: "work",
    owns: ["/responsibilities", "/routines"],
  },
  {
    id: "reachability",
    label: "@Waker",
    to: "/reachability",
    icon: IconAt,
    section: "primary",
    rail: "work",
  },
  {
    id: "capabilities",
    label: "能力",
    to: "/capabilities",
    icon: IconBoxSeam,
    section: "primary",
    rail: "work",
    owns: ["/wakerflows"],
  },
  {
    id: "connections",
    label: "连接",
    to: "/connections",
    icon: IconPlug,
    section: "primary",
    rail: "work",
  },
  {
    id: "pipelines",
    label: "组团流程",
    to: "/pipelines",
    icon: IconRoute,
    section: "more",
    rail: "work",
  },
  {
    id: "plans",
    label: "套餐与用量",
    to: "/settings/plans",
    icon: IconGauge,
    section: "account",
    rail: "me",
  },
  {
    id: "settings",
    label: "设置",
    to: "/settings",
    icon: IconSettings,
    section: "account",
    rail: "me",
  },
  {
    id: "admin",
    label: "管理",
    to: "/admin",
    icon: IconShieldLock,
    section: "account",
    rail: "work",
    adminOnly: true,
  },
];

/**
 * 账户菜单的第一项「我的分身」。地址在运行时才知道（这个人的分身员工 id），所以不进 `NAVIGATION`：账户菜单
 * 读到分身 id 后链到 `/bots/$agentId`，读不到时不画。
 */
export const AVATAR_MENU_ITEM = {
  id: "avatar",
  label: "我的分身",
  icon: IconUserCircle,
  section: "account",
} as const satisfies {
  id: string;
  label: string;
  icon: Icon;
  section: NavigationItem["section"];
};

/**
 * The destinations this person may open, in order. The personal edition has no Admin, since nobody
 * there administers anybody else.
 */
export function navigationFor(
  role: string | undefined,
  edition: "team" | "personal" = "team",
): readonly NavigationItem[] {
  if (edition === "personal") {
    return NAVIGATION.filter((item) => item.id !== "admin");
  }
  return NAVIGATION.filter((item) => !item.adminOnly || role === "admin");
}

/** Whether `pathname` is the entry's own page, a page under it, or one of the pages it owns. */
export function navigationOwns(
  item: NavigationItem,
  pathname: string,
): boolean {
  const under = (path: string) =>
    pathname === path || pathname.startsWith(`${path}/`);
  return under(item.to) || (item.owns ?? []).some(under);
}

/** 不在导航表里的页面，按路径前缀归入口；导航表里的页面先由 `navigationOwns` 认领。 */
const RAIL_PREFIXES: readonly (readonly [string, Rail])[] = [
  ["/channel", "msg"],
  ["/group", "msg"],
  ["/bots", "contacts"],
  ["/assemble", "contacts"],
  ["/tasks", "work"],
  ["/autonomous", "work"],
  ["/reachability", "work"],
  ["/capabilities", "work"],
  ["/connections", "work"],
  ["/browser", "work"],
  ["/pipelines", "work"],
  ["/team-bots", "work"],
  ["/approvals", "work"],
  ["/admin", "work"],
  ["/workbench", "work"],
  ["/settings", "me"],
  ["/me", "me"],
];

/** 打开 `pathname` 时入口栏亮哪一个入口；认不出的地址归消息。 */
export function railForPath(pathname: string): Rail {
  const owner = NAVIGATION.find((item) => navigationOwns(item, pathname));
  if (owner) return owner.rail;
  const hit = RAIL_PREFIXES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return hit ? hit[1] : "msg";
}

/** `navigationFor` the signed-in person, on this deployment's edition. */
export function useNavigationItems(): readonly NavigationItem[] {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  return navigationFor(user?.role, capabilities?.edition ?? "team");
}
