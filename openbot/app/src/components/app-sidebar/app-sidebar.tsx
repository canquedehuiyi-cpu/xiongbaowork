<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
import { IconLogout, IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import type * as React from "react";
import { useEffect, useId, useState } from "react";
import { useAttentionNotifications } from "@/components/bot-profile/attention";
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { isNavigationLink, useNavigationItems } from "@/lib/navigation";
import { relativeTimeShort } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { BotsNavBadge } from "../bot-profile/attention";
import { BrowserNavItem } from "../browser/browser-nav-item";
import { OpenBotLogo } from "../edition/openbot-logo";
import { navigationRender } from "../edition/team-features-dialog";
import { OpenBotVersion } from "../layout/openbot-version";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import { useSignOut } from "./use-sign-out";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

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
 * `sidebar-accent` edged in the logo's gold, with everything else muted. Written in px rather than
 * Tailwind's rem steps because this app's root font size is 15px.
 */
const navRowClassName =
  "h-[32px] gap-[10px] rounded-md px-[10px] text-[14px] text-sidebar-foreground/55 hover:bg-foreground/5 hover:text-sidebar-foreground data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground data-[status=active]:shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand-gold)_40%,transparent)] [&_svg]:size-[16px]";

/** A group label: 12px, dim, 8px in from the row box (x 20), 5px above its first row. */
const groupLabelClassName =
  "mb-[5px] h-[18px] px-[8px] text-[12px] text-sidebar-foreground/45 leading-[18px]";

function NavRow({ to, label, icon: Icon, owns = [] }: NavItem) {
  const ownsCurrent = useRouterState({
    select: (state) =>
      owns.some((path) => underPath(state.location.pathname, path)),
  });
  return (
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
    <div className="size-[28px] shrink-0 bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    </div>
  );
}

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
/** 48px: our logo with the Chinese and English names on the left, the collapse button on the right (x 211–225 on the reference). */
function SidebarBrand() {
  const { toggleSidebar } = useSidebar();
  return (
    <SidebarHeader className="h-[48px] flex-row items-center justify-between gap-2 py-0 pr-[10px] pl-[16px]">
      <Link
        className="flex h-[32px] min-w-0 items-center gap-[8px] rounded-md font-semibold text-[14px] tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        to="/"
      >
        <BrandLogo className="rounded-[6px]" size={26} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate leading-[16px]">
            {appConfig.brand.productName}
          </span>
          {appConfig.brand.englishName ? (
            <span className="truncate font-medium text-[10px] text-brand-gold-ink leading-[12px] tracking-[0.08em]">
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
/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, its opening and the last message, because those are the
 * things the row can actually show — searching against something invisible returns results a person
 * cannot account for. The opening and the last message are included because one of them is what the
 * second line draws until the conversation has been named. Message history beyond that line is not
 * here to search: it lives in the thread store, and reaching for it is a server endpoint rather than
 * a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.opening, channel.lastMessage].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
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
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======
  const emphasis = useMessageListEmphasis();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();
  const channels = useInfiniteQuery(channelListQueryOptions());
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
  const navigation = useNavigationItems();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            <SidebarMenuButton
              // The product's name, not a menu row: nothing changes on hover or press (the row fill read as a blue box on
              // the frosted sidebar). It still goes home when clicked, and the keyboard's focus ring stays.
              className="h-full cursor-default font-semibold text-[14px] leading-tight tracking-tighter hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {/* OpenBot's mark beside its name, as on open.bot and the desktop app. A deployment that renames the
                      product (brand.yaml) has no mark here: the orb is OpenBot's, not theirs. */}
                  {appConfig.brand.productName === "OpenBot" ? (
                    <OpenBotLogo
                      aria-hidden="true"
                      className="size-5 shrink-0"
                    />
                  ) : null}
                  {appConfig.brand.productName}
                </Link>
              )}
            />
            <Button
              aria-label="New conversation"
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
            >
              <IconPlus />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px">
            <SidebarMenuItem>
              <InputGroup className="bg-background text-sm rounded-lg h-9">
                <InputGroupInput
                  aria-label="Search conversations"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search…"
                  value={search}
                />
                <InputGroupAddon>
                  <IconSearch />
                </InputGroupAddon>
              </InputGroup>
            </SidebarMenuItem>
            <div className="w-full h-2" />
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {searching && visibleChannels.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>
                      {channels.hasNextPage
                        ? "No loaded conversations match your search"
                        : "No conversations match your search"}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {channels.hasNextPage
                        ? "Load older conversations to search more of your history."
                        : `No conversation has “${search.trim()}” in its name or latest message.`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!searching && channels.data?.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>No conversations yet</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Start a conversation with a Bot and it shows up here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            <AnimatePresence initial={false}>
              {visibleChannels.map((channel) => (
                <ChannelRow
                  emphasis={emphasis}
                  key={channel.id}
                  animateOrder={animateOrder}
                  channel={channel}
                />
              ))}
            </AnimatePresence>
            <ChannelPagination
              query={channels}
              scrollRoot={scrollRoot}
              searching={searching}
            />
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          {navigation
            .filter(isNavigationLink)
            .filter((item) => item.section === "primary")
            .map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  className="hover:bg-foreground/5 h-10"
                  render={(props) => (
                    <Link
                      {...props}
                      to={item.to}
                      activeProps={{ className: "bg-foreground/5" }}
                    />
                  )}
                >
                  <div className="size-[28px] flex items-center justify-center">
                    <item.icon />
                  </div>
                  <span className="text-sm">{item.label}</span>
                  {/* What waits on you across every Bot; Bots lists them first. */}
                  {item.id === "bots" ? <BotsNavBadge /> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          {/* Your own browser, with the Recorder in it. Drawn only where OpenBot can run one for you. */}
          <BrowserNavItem />
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm trackint-tight">
                    {currentUser?.name || currentUser?.email}
                  </span>
                  <OpenBotVersion className="text-[10px] leading-3 text-muted-foreground" />
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
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
