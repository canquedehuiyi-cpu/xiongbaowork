import {
  IconAt,
  IconBolt,
  IconBoxSeam,
  IconChecks,
  IconChevronDown,
  IconDots,
  IconLayoutKanban,
  IconLayoutSidebar,
  IconRoute,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useId, useState } from "react";
import { useAttentionNotifications } from "@/components/bot-profile/attention";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { SidebarAccount } from "./sidebar-account";
import { SidebarRoster } from "./sidebar-roster";

/*
 * The roster helpers moved to roster.ts with the conversation list; re-exported here because the
 * channel screen and the tests have always read them from the sidebar.
 */
export {
  channelTab,
  hasUnseenActivity,
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "./roster";

/** ⌘ on Apple platforms, Ctrl everywhere else, as the page-level toggle names it. */
const SHORTCUT_LABEL =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "⌘B"
    : "Ctrl+B";

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Other paths whose screens belong to this entry, so it stays marked while one is open. */
  owns?: readonly string[];
};

/*
 * The reference product's workbench: five primary entries in two labelled groups, in this order.
 * Paths are this product's own (docs/plans/2026-11-07-qoderwake-cn-frontend-parity.md maps
 * /work-management → /tasks, /at-waker → /reachability, /autonomous-work → /autonomous,
 * /management → /wakers, /resources/plugins → /resources); the existing URLs are a compatibility
 * contract, so the labels move and the links do not.
 */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作管理",
    items: [
      { to: "/tasks", label: "任务看板", icon: IconLayoutKanban },
      { to: "/reachability", label: "@Waker", icon: IconAt },
      // 长期职责 and 定时任务 are rows of the 自主工作 list; their own screens belong to it.
      {
        to: "/autonomous",
        label: "自主工作",
        icon: IconBolt,
        owns: ["/responsibilities", "/routines"],
      },
    ],
  },
  {
    label: "员工资源",
    items: [
      // One employee's profile, assembly and the archived roster are all part of 员工管理.
      {
        to: "/wakers",
        label: "员工管理",
        icon: IconUsers,
        owns: ["/bots", "/assemble", "/agents"],
      },
      // WakerFlow, skills, knowledge and memory are tabs of 能力与资源; their screens belong to it.
      {
        to: "/resources",
        label: "能力与资源",
        icon: IconBoxSeam,
        owns: ["/wakerflows", "/skills", "/knowledge", "/memory"],
      },
    ],
  },
];

function underPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/*
 * What no workbench page covers, and the reference has no place for: folded under 更多 at the end of
 * the 员工资源 group. Everything else this sidebar used to list duplicated a tab or a view of one of
 * the five pages and is archived (CONTEXT.md, "所有重复的都归档").
 */
const MORE_NAV: NavItem[] = [
  { to: "/pipelines", label: "组团流程", icon: IconRoute },
  { to: "/team-bots", label: "团队 Bot", icon: IconUsersGroup },
  { to: "/approvals", label: "审批", icon: IconChecks },
];

const MORE_STORAGE_KEY = "openbot-sidebar-more";

function readMoreOpen(): boolean {
  try {
    return window.localStorage.getItem(MORE_STORAGE_KEY) === "open";
  } catch {
    return false;
  }
}

function writeMoreOpen(open: boolean) {
  try {
    window.localStorage.setItem(MORE_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // A browser that refuses storage still gets a working disclosure; it just will not remember.
  }
}

/*
 * One nav row, measured on the reference at 1696px: 32px tall on a 36px pitch, the row box inset
 * 12px from the sidebar's edges, a 16px icon 10px in, the 14px label at x 48, and the open entry on
 * #363636 (`sidebar-accent`) in white with everything else muted. Written in px rather than
 * Tailwind's rem steps because this app's root font size is 15px.
 */
const navRowClassName =
  "h-[32px] gap-[10px] rounded-md px-[10px] text-[14px] text-sidebar-foreground/55 hover:bg-foreground/5 hover:text-sidebar-foreground data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground data-[status=active]:shadow-[0_0_0_1px_rgb(0_0_0/0.35)] [&_svg]:size-[16px]";

/** A group label: 12px, dim, 8px in from the row box (x 20), 5px above its first row. */
const groupLabelClassName =
  "mb-[5px] h-[18px] px-[8px] text-[12px] text-sidebar-foreground/45 leading-[18px]";

function NavRow({ to, label, icon: Icon, owns = [] }: NavItem) {
  const ownsCurrent = useRouterState({
    select: (state) =>
      owns.some((path) => underPath(state.location.pathname, path)),
  });
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={navRowClassName}
        render={(props) => (
          <Link
            {...props}
            {...(ownsCurrent
              ? { "aria-current": "page" as const, "data-status": "active" }
              : {})}
            to={to}
          />
        )}
      >
        <Icon />
        <span className="truncate">{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const labelId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled run of links inside the nav, not a form control set; fieldset would announce it as one.
    <div aria-labelledby={labelId} role="group">
      <div className={groupLabelClassName} id={labelId}>
        {label}
      </div>
      <SidebarMenu className="gap-[4px]">
        {items.map((item) => (
          <NavRow key={item.to} {...item} />
        ))}
      </SidebarMenu>
    </div>
  );
}

/** 48px: our mark and name on the left, the collapse button on the right (x 211–225 on the reference). */
function SidebarBrand() {
  const { toggleSidebar } = useSidebar();
  return (
    <SidebarHeader className="h-[48px] flex-row items-center justify-between gap-2 py-0 pr-[10px] pl-[16px]">
      <Link
        className="flex h-[32px] min-w-0 items-center gap-[8px] rounded-md font-semibold text-[14px] tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        to="/"
      >
        <span
          aria-hidden="true"
          className="flex size-[21px] shrink-0 items-center justify-center rounded-[5px] bg-primary font-bold text-[12px] text-primary-foreground"
        >
          {appConfig.brand.productName.slice(0, 1)}
        </span>
        <span className="truncate">{appConfig.brand.productName}</span>
      </Link>
      <Button
        aria-label="隐藏侧栏"
        className="size-[28px] shrink-0 text-muted-foreground"
        onClick={toggleSidebar}
        size="icon"
        title={`隐藏侧栏（${SHORTCUT_LABEL}）`}
        variant="ghost"
      >
        <IconLayoutSidebar className="size-[16px]" />
      </Button>
    </SidebarHeader>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  // The browser notification when an employee starts needing this person; badges ride on its row.
  useAttentionNotifications(useQuery(botAttentionQueryOptions()).data);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  /*
   * A page that lives under 更多 opens the section, so the current place is always marked: folded
   * away, a person on /approvals would see no entry lit at all.
   */
  const inMore = MORE_NAV.some((item) => underPath(pathname, item.to));
  const [moreOpen, setMoreOpen] = useState(() => readMoreOpen() || inMore);
  useEffect(() => {
    if (inMore) setMoreOpen(true);
  }, [inMore]);

  const toggleMore = () => {
    setMoreOpen((open) => {
      writeMoreOpen(!open);
      return !open;
    });
  };

  return (
    <Sidebar {...props}>
      <SidebarBrand />
      <SidebarContent className="scroll-fade-b gap-0">
        <nav aria-label="主导航" className="px-[12px]">
          {NAV_GROUPS.map((group, index) => (
            // 17px between one group's last row and the next group's label (label centre y 201).
            <div
              className={index > 0 ? "mt-[17px]" : undefined}
              key={group.label}
            >
              <NavGroup {...group} />
            </div>
          ))}
        </nav>
        <SidebarRoster />
      </SidebarContent>
      {/*
       * This product's own destinations, folded, same row style — at the foot, above the account,
       * so the workbench groups and the 员工 / 群组 roster sit exactly where the reference has them
       * (the reference has no such row; between the two it pushed the roster down 36px).
       */}
      <div className="border-sidebar-border border-t px-[12px] pt-[6px]">
        <SidebarMenu className="gap-[4px]">
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-controls="sidebar-more-nav"
              aria-expanded={moreOpen}
              className={navRowClassName}
              onClick={toggleMore}
            >
              <IconDots />
              <span className="flex-1 truncate">更多</span>
              <IconChevronDown
                className={moreOpen ? "rotate-180" : undefined}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {moreOpen ? (
          <nav aria-label="更多入口" id="sidebar-more-nav">
            <SidebarMenu className="gap-[4px] pt-[4px]">
              {MORE_NAV.map((item) => (
                <NavRow key={item.to} {...item} />
              ))}
            </SidebarMenu>
          </nav>
        ) : null}
      </div>
      <SidebarAccount />
      <SidebarRail />
    </Sidebar>
  );
}
