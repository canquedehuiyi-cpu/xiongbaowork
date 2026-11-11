import {
  IconChevronDown,
  IconDots,
  IconLayoutSidebar,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { BrowserNavItem } from "@/components/browser/browser-nav-item";
import { BrandLogo } from "@/components/layout/brand-logo";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import {
  isNavigationLink,
  type NavigationLink,
  navigationOwns,
  useNavigationItems,
} from "@/lib/navigation";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import {
  conversationStamp,
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "./roster";
import { SidebarAccount } from "./sidebar-account";

/*
 * The roster helpers live in roster.ts; re-exported here because the channel screen, the skins and
 * the tests have always read them from the sidebar, as upstream's do.
 */
export {
  conversationStamp,
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

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

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

/**
 * One destination from `lib/navigation.ts`. Marked current on its own page, the pages under it, and
 * the pages it owns; the link's own fuzzy match is switched off so the two rules cannot disagree.
 */
function NavRow({ item }: { item: NavigationLink }) {
  const current = useRouterState({
    select: (state) => navigationOwns(item, state.location.pathname),
  });
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={navRowClassName}
        render={(props) => (
          <Link
            {...props}
            {...(current
              ? { "aria-current": "page" as const, "data-status": "active" }
              : {})}
            activeOptions={{ exact: true, includeSearch: false }}
            to={item.to}
          />
        )}
      >
        <item.icon />
        <span className="truncate">{item.label}</span>
        {/* What waits on you across every employee; 员工 lists them first. */}
        {item.id === "bots" ? <BotsNavBadge /> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The top of the sidebar: the 35px logo and the product's name (its English name under it in spaced
 * mono), the button that hides the sidebar, and 「新对话」 under them.
 */
function SidebarBrand() {
  const { toggleSidebar } = useSidebar();
  return (
    <SidebarHeader className="gap-[14px] pt-[21px] pr-[12px] pb-[12px] pl-[15px]">
      <div className="flex items-center justify-between gap-2 pl-[6px]">
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
      </div>
      <Button
        className="h-[34px] w-full justify-start gap-[8px] rounded-[9px] px-[11px] text-[13px]"
        render={(props) => (
          <Link
            {...props}
            activeProps={{ className: "bg-sidebar-accent" }}
            to="/channel/new"
          />
        )}
        variant="outline"
      >
        <IconPlus className="size-[16px]" />
        新对话
      </Button>
    </SidebarHeader>
  );
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
            ? conversationStamp(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        canRename={channel.canRename ?? false}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
  );
}

/**
 * The app's sidebar, in upstream's shape: the brand and 「新对话」 at the top, a search over every
 * conversation, the conversations themselves (a 群聊 is a row like any other, its faces stacked),
 * and at the foot the destinations from `lib/navigation.ts`, 「更多」, and the account menu.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const visibleChannels = pinnedFirst(matchingChannels(channels.data, search));
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  const navigation = useNavigationItems().filter(isNavigationLink);
  const primary = navigation.filter((item) => item.section === "primary");
  const more = navigation.filter((item) => item.section === "more");
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  /*
   * A page that lives under 更多 opens the section, so the current place is always marked: folded
   * away, a person on /pipelines would see no entry lit at all.
   */
  const inMore = more.some((item) => navigationOwns(item, pathname));
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
      <div className="px-[15px] pb-[8px]">
        <InputGroup className="h-[34px] rounded-[9px] bg-background text-[13px]">
          <InputGroupInput
            aria-label="搜索会话"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索会话…"
            type="search"
            value={search}
          />
          <InputGroupAddon>
            <IconSearch />
          </InputGroupAddon>
        </InputGroup>
      </div>
      <SidebarContent className="scroll-fade-b gap-0" ref={scrollRoot}>
        <nav aria-label="会话" className="flex flex-col gap-px px-[8px] pb-2">
          {/*
           * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A list nobody has used yet
           * needs telling how to start. A list that simply does not match what is in the box has to
           * say so and quote it back — told "no conversations yet" while holding a typo, a person
           * reads their conversations as gone.
           */}
          {searching && visibleChannels.length === 0 ? (
            <Empty className="my-2 min-h-[30dvh] border border-dashed">
              <EmptyHeader>
                <EmptyTitle>
                  {channels.hasNextPage
                    ? "已加载的会话里没有匹配的"
                    : "没有匹配的会话"}
                </EmptyTitle>
                <EmptyDescription className="text-pretty">
                  {channels.hasNextPage
                    ? "加载更早的会话，再多搜一些。"
                    : `没有哪段会话的名字或最近一条消息里有「${search.trim()}」。`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {!searching && channels.data?.length === 0 ? (
            <Empty className="my-2 min-h-[30dvh] border border-dashed">
              <EmptyHeader>
                <EmptyTitle>还没有会话</EmptyTitle>
                <EmptyDescription className="text-pretty">
                  和员工开始一段对话，它就会出现在这里。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {/*
           * Keyed by the filter: typing swaps the list outright instead of fading rows out under
           * somebody who is still typing (熊宝的做法，上游这里仍会淡出)。
           */}
          <AnimatePresence
            initial={false}
            key={searching ? `search:${search.trim()}` : "all"}
          >
            {visibleChannels.map((channel) => (
              <ChannelRow
                animateOrder={animateOrder}
                channel={channel}
                emphasis={emphasis}
                key={channel.id}
              />
            ))}
          </AnimatePresence>
          <ChannelPagination
            query={channels}
            scrollRoot={scrollRoot}
            searching={searching}
          />
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-0 border-sidebar-border border-t px-[15px] pt-[8px] pb-[6px]">
        <nav aria-label="主导航">
          <SidebarMenu className="gap-[3px]">
            {primary.map((item) => (
              <NavRow item={item} key={item.id} />
            ))}
            {/*
             * 上游的「教员工做事」（自己的浏览器 + 录制器）。只在服务端说能为这个人跑浏览器时出现，
             * 带录制中的红点，所以不进 navigation.ts，按上游组件原样挂在主导航后面。
             */}
            <BrowserNavItem />
          </SidebarMenu>
        </nav>
        {more.length > 0 ? (
          <SidebarMenu className="mt-[3px] gap-[3px]">
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
        ) : null}
        {more.length > 0 && moreOpen ? (
          <nav aria-label="更多入口" id="sidebar-more-nav">
            <SidebarMenu className="gap-[3px] pt-[3px]">
              {more.map((item) => (
                <NavRow item={item} key={item.id} />
              ))}
            </SidebarMenu>
          </nav>
        ) : null}
        <SidebarMenu className="mt-[6px] border-sidebar-border border-t pt-[6px]">
          <SidebarAccount />
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
