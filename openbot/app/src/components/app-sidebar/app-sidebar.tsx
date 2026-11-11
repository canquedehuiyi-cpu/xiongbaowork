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
import { BrowserNavItem } from "@/components/browser/browser-nav-item";
import { BrandLogo } from "@/components/layout/brand-logo";
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
import { SidebarAccount } from "./sidebar-account";
import { SidebarRoster } from "./sidebar-roster";
=======
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { isNavigationLink, useNavigationItems } from "@/lib/navigation";
import { relativeTimeShort } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { BotsNavBadge } from "../bot-profile/attention";
import { BrowserNavItem } from "../browser/browser-nav-item";
import { navigationRender } from "../edition/team-features-dialog";
import { OpenBotVersion } from "../layout/openbot-version";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import { useSignOut } from "./use-sign-out";
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d

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
 * One nav row, as docs/design/ios-studio draws it: 37px tall on a 40px pitch, a 9px radius, the
 * 13px label 11px after an 18px icon, everything quiet grey. The open entry lifts onto a faint white
 * plate with a hairline, turns white, and carries the one red mark of the sidebar: a 4×12 bar at its
 * right end. Written in px because this app's root font size is 15px.
 */
const navRowClassName =
  "h-[37px] gap-[11px] rounded-[9px] border border-transparent px-[11px] text-[13px] text-muted-foreground hover:bg-foreground/[0.03] hover:text-sidebar-foreground data-[status=active]:border-foreground/[0.06] data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground after:ml-auto after:hidden after:h-[12px] after:w-[4px] after:shrink-0 after:rounded-[3px] after:bg-signal after:content-[''] data-[status=active]:after:block [&_svg]:size-[18px] [&_svg]:text-faint data-[status=active]:[&_svg]:text-sidebar-accent-foreground";

/** A group label: 11px, faint, aligned with the row's icon, 7px above its first row. */
const groupLabelClassName =
  "h-[18px] px-[11px] pb-[7px] text-[11px] text-faint leading-[18px] box-content";

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
      <SidebarMenu className="gap-[3px]">
        {items.map((item) => (
          <NavRow key={item.to} {...item} />
        ))}
      </SidebarMenu>
    </div>
  );
}

/** The brand: the 35px logo, the product's name and its English name in spaced mono, and the collapse button. */
function SidebarBrand() {
  const { toggleSidebar } = useSidebar();
  return (
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
    <SidebarHeader className="flex-row items-center justify-between gap-2 pt-[21px] pr-[12px] pb-[24px] pl-[21px]">
      <Link
        className="flex min-w-0 items-center gap-[11px] rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        to="/"
      >
        <BrandLogo className="rounded-[10px]" size={35} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-bold text-[15px] leading-[19px] tracking-[0.015em]">
            {appConfig.brand.productName}
          </span>
          {appConfig.brand.englishName ? (
            <span className="mt-[3px] truncate font-mono text-[9px] text-faint uppercase leading-[11px] tracking-[0.13em]">
              {appConfig.brand.englishName}
            </span>
          ) : null}
        </span>
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
=======
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        untitled={untitledLine(channel)}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTimeShort(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        canRename={channel.canRename ?? false}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
  const inMore =
    MORE_NAV.some((item) => underPath(pathname, item.to)) ||
    underPath(pathname, "/browser");
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
    <Sidebar {...props}>
      <SidebarBrand />
      <SidebarContent className="scroll-fade-b gap-0">
        <nav aria-label="主导航" className="px-[15px]">
          {NAV_GROUPS.map((group, index) => (
            <div
              className={index > 0 ? "mt-[18px]" : undefined}
              key={group.label}
=======
    <Sidebar variant="inset" {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            {/* The same hover as every other row in the sidebar, not the menu button's accent tint. */}
            <SidebarMenuButton
              className="font-semibold text-[14px] tracking-tighter h-full leading-tight hover:bg-foreground/5 hover:text-sidebar-foreground active:bg-foreground/5 active:text-sidebar-foreground"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {appConfig.brand.productName}
                </Link>
              )}
            />
            {/* Square, as tall as the name beside it, with the sidebar's hover rather than `muted`, which
                is nearly the sidebar's own colour. */}
            <Button
              aria-label="New conversation"
              className="aspect-square h-full w-auto hover:bg-foreground/5 dark:hover:bg-foreground/5"
              size="icon"
              variant="ghost"
              render={(props) => (
                <Link
                  {...props}
                  to="/channel/new"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
      <div className="border-sidebar-border border-t px-[15px] pt-[6px]">
        <SidebarMenu className="gap-[4px]">
          <SidebarMenuItem>
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
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
=======
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                {/* The name and the release the server runs, side by side: 80/20 of the row. */}
                <span className="grid min-w-0 flex-1 grid-cols-[4fr_1fr] items-center gap-2">
                  <span className="truncate text-sm trackint-tight">
                    {currentUser?.name || currentUser?.email}
                  </span>
                  <OpenBotVersion className="text-right text-[10px] leading-3 text-muted-foreground" />
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {navigation
                  .filter((item) => item.section === "account")
                  .map((item) => (
                    <DropdownMenuItem
                      className={userMenuItemClassName}
                      key={item.id}
                      nativeButton={item.kind === "dialog"}
                      // A link closes a narrow window's sheet as it is followed; a dialog has to
                      // close it itself, or the sheet waits behind the dialog.
                      render={navigationRender(
                        item,
                        item.kind === "dialog"
                          ? { onClick: () => setOpenMobile(false) }
                          : {},
                      )}
                    >
                      <item.icon />
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                {signOutOffered ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    disabled={signOut.pending}
                    onClick={signOut.run}
                    variant="destructive"
                  >
                    <IconLogout />
                    Sign out
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
          </SidebarMenuItem>
        </SidebarMenu>
        {moreOpen ? (
          <nav aria-label="更多入口" id="sidebar-more-nav">
            <SidebarMenu className="gap-[4px] pt-[4px]">
              {MORE_NAV.map((item) => (
                <NavRow key={item.to} {...item} />
              ))}
              {/*
               * 上游 v1.0.0 的「教员工做事」（自己的浏览器 + Recorder，取代了旧的演示录制）。只在服务端
               * 说能为这个人跑浏览器时出现，所以不进 MORE_NAV，按上游组件原样挂在这里。
               */}
              <BrowserNavItem />
            </SidebarMenu>
          </nav>
        ) : null}
      </div>
      <SidebarAccount />
      <SidebarRail />
    </Sidebar>
  );
}
