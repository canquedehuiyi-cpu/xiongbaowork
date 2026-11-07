import {
  IconAt,
  IconBolt,
  IconBook,
  IconBox,
  IconBoxSeam,
  IconBrain,
  IconChecks,
  IconChevronDown,
  IconDots,
  IconLayoutKanban,
  IconLogout,
  IconPlus,
  IconRobot,
  IconRoute,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconSparkles,
  IconTargetArrow,
  IconUserCircle,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  type LinkOptions,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  type SegmentedTab,
  SegmentedTabs,
} from "@/components/layout/segmented-tabs";
import { UsagePanel } from "@/components/quota/usage-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { BotAttentionList } from "../bot-profile/attention";
import { buttonVariants } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;
const settingsLinkOptions = { to: "/settings" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-[28px] bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, and the last message, because those are the things the
 * row can actually show — searching against something invisible returns results a person cannot
 * account for. The last message is included because it is still what the second line draws until the
 * conversation has been named. Message history beyond that line is not here to search: it lives in
 * the thread store, and reaching for it is a server endpoint rather than a filter.
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
    [channel.name, channel.summary, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
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
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        unread={unread}
        busy={channel.busy ?? false}
      />
    </motion.div>
  );
}

/** Which roster tab a conversation belongs to: two or more coworkers is a group conversation. */
export function channelTab(channel: ChannelSummary): ConversationTab {
  return channel.agentIds.length > 1 ? "groups" : "wakers";
}

type ConversationTab = "wakers" | "groups";

const CONVERSATION_TABS = [
  { value: "wakers", label: "员工" },
  { value: "groups", label: "群组" },
] as const satisfies readonly SegmentedTab<ConversationTab>[];

/*
 * The reference product's workbench: five primary entries, in this order, above everything else.
 * Paths are this product's own (docs/plans/2026-11-07-qoderwake-cn-frontend-parity.md maps
 * /work-management → /tasks, /at-waker → /reachability, /autonomous-work → /autonomous,
 * /management → /wakers, /resources/plugins → /resources); the existing URLs are a compatibility
 * contract, so the labels move and the links do not.
 */
const PRIMARY_NAV = [
  { to: "/tasks", label: "任务看板", icon: IconLayoutKanban },
  { to: "/reachability", label: "@Waker", icon: IconAt },
  { to: "/autonomous", label: "自主工作", icon: IconBolt },
  { to: "/wakers", label: "Waker 管理", icon: IconUsers },
  { to: "/resources", label: "能力与资源", icon: IconBoxSeam },
] as const;

/*
 * Everything this product had in its sidebar before the workbench layout, kept one click away.
 * None of these are in the reference's primary navigation, and every one of them is a route
 * somebody may have bookmarked or be used to — so they fold away rather than disappear.
 */
const MORE_NAV = [
  { to: "/pipelines", label: "组团流程", icon: IconRoute },
  { to: "/bots", label: "Bot 会话", icon: IconRobot },
  { to: "/skills", label: "技能", icon: IconBox },
  { to: "/agents", label: "员工列表", icon: IconUserCircle },
  { to: "/team-bots", label: "团队 Bot", icon: IconUsersGroup },
  { to: "/responsibilities", label: "职责", icon: IconTargetArrow },
  { to: "/memory", label: "记忆", icon: IconBrain },
  { to: "/knowledge", label: "知识库", icon: IconBook },
  { to: "/approvals", label: "审批", icon: IconChecks },
] as const;

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
 * One nav row. 32 CSS px tall — the reference's sidebar link height — written in px rather than
 * Tailwind's rem steps because this app's root font size is 15px, where `h-8` comes out at 30.
 */
const navRowClassName =
  "h-[32px] gap-2.5 px-2.5 text-[13px] text-sidebar-foreground/75 hover:bg-foreground/5 hover:text-sidebar-foreground data-[status=active]:bg-foreground/[0.07] data-[status=active]:font-medium data-[status=active]:text-sidebar-foreground [&>svg]:size-[16px]";

function NavRow({
  to,
  label,
  icon: Icon,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={navRowClassName}
        render={(props) => <Link {...props} to={to} />}
      >
        <Icon />
        <span className="truncate">{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const channels = useInfiniteQuery(channelListQueryOptions());
  // Read off the roster the app already holds, so the sidebar makes no request of its own for it.
  const assignedTeamBots =
    useQuery(agentListQueryOptions()).data?.filter((bot) => bot.assignedToMe) ??
    [];
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<ConversationTab>("wakers");
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  /*
   * A page that lives under 更多 opens the section, so the current place is always marked: folded
   * away, a person on /approvals would see no entry lit at all.
   */
  const inMore = MORE_NAV.some(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  const [moreOpen, setMoreOpen] = useState(() => readMoreOpen() || inMore);
  useEffect(() => {
    if (inMore) setMoreOpen(true);
  }, [inMore]);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const tabChannels = channels.data?.filter(
    (channel) => channelTab(channel) === tab,
  );
  const visibleChannels = pinnedFirst(matchingChannels(tabChannels, search));
  /*
   * Nothing of this tab among the pages loaded so far is not the same as nothing at all, and it is
   * no reason to walk the whole history unasked either: a person with a long run of one-to-one
   * conversations would otherwise watch every page load in search of a group. The button stays.
   */
  const tabEmptySoFar = !searching && tabChannels?.length === 0;
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
  const newConversation =
    tab === "groups"
      ? { to: "/group/new", label: "新建群聊", icon: IconUsersGroup }
      : { to: "/channel/new", label: "新建会话", icon: IconPlus };

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    await navigate({ to: "/sign" });
  };

  const toggleMore = () => {
    setMoreOpen((open) => {
      writeMoreOpen(!open);
      return !open;
    });
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="h-12 justify-center px-3 py-0">
        <Link
          {...appLinkOptions}
          className="flex h-[32px] items-center gap-2 rounded-md px-1 font-semibold text-[14px] tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span
            aria-hidden="true"
            className="flex size-[22px] items-center justify-center rounded-md bg-primary font-bold text-[12px] text-primary-foreground"
          >
            {appConfig.brand.productName.slice(0, 1)}
          </span>
          <span className="truncate">{appConfig.brand.productName}</span>
        </Link>
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b gap-0">
        {/* Segment one: the workbench. */}
        <SidebarGroup className="px-2 py-1">
          <nav aria-label="主导航">
            <SidebarMenu className="gap-0.5">
              {PRIMARY_NAV.map((item) => (
                <NavRow key={item.to} {...item} />
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
        {/* Team Bots an administrator assigned to this person: always here, never folded away. */}
        {assignedTeamBots.length > 0 ? (
          <SidebarGroup className="px-2 py-0">
            <nav aria-label="指派给我的团队 Bot">
              <SidebarMenu className="gap-0.5">
                {assignedTeamBots.map((bot) => (
                  <SidebarMenuItem key={bot.id}>
                    <SidebarMenuButton
                      className={navRowClassName}
                      render={(props) => (
                        <Link
                          {...props}
                          search={{ agent: bot.id }}
                          to="/channel/new"
                        />
                      )}
                    >
                      <ChannelAvatar participantIds={[bot.id]} size={16} />
                      <span className="truncate">{bot.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        ) : null}
        {/* Segment two: this product's own destinations, folded. */}
        <SidebarGroup className="px-2 py-0">
          <SidebarMenu className="gap-0.5">
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
              <SidebarMenu className="gap-0.5 pt-0.5">
                {MORE_NAV.map((item) => (
                  <NavRow key={item.to} {...item} />
                ))}
              </SidebarMenu>
            </nav>
          ) : null}
        </SidebarGroup>
        <div className="mx-4 my-2 border-sidebar-border border-t" />
        <SidebarGroup className="gap-1 px-2 pt-0">
          <div className="flex items-center justify-between gap-2 px-1">
            <SegmentedTabs
              label="会话类型"
              onValueChange={setTab}
              size="sm"
              tabs={CONVERSATION_TABS}
              value={tab}
            />
            <Link
              activeProps={{ className: "bg-foreground/5" }}
              aria-label={newConversation.label}
              className={cn(
                buttonVariants({ size: "icon", variant: "ghost" }),
                "size-[28px]",
              )}
              title={newConversation.label}
              to={newConversation.to}
            >
              <newConversation.icon />
            </Link>
          </div>
          <SidebarMenu className="gap-px">
            <SidebarMenuItem className="px-1 pb-1">
              <InputGroup className="h-[32px] rounded-lg bg-background text-[13px]">
                <InputGroupInput
                  aria-label="搜索会话"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索…"
                  value={search}
                />
                <InputGroupAddon>
                  <IconSearch />
                </InputGroupAddon>
              </InputGroup>
            </SidebarMenuItem>
            {/* Bots that need you, or that you paused. See bot-profile/attention.tsx. */}
            <BotAttentionList />
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {searching && visibleChannels.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[30dvh]">
                  <EmptyHeader>
                    <EmptyTitle>
                      {channels.hasNextPage
                        ? "已加载的会话里没有匹配的"
                        : "没有匹配的会话"}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {channels.hasNextPage
                        ? "加载更早的会话，才能搜索更多历史。"
                        : `没有叫“${search.trim()}”的会话，最近也没有人提到过它。`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {tabEmptySoFar ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[30dvh]">
                  <EmptyHeader>
                    <EmptyTitle>
                      {channels.hasNextPage
                        ? tab === "groups"
                          ? "已加载的会话里没有群组会话"
                          : "已加载的会话里没有员工会话"
                        : tab === "groups"
                          ? "还没有群组会话"
                          : "你还没有会话"}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {channels.hasNextPage
                        ? "加载更早的会话，看看更早的历史里有没有。"
                        : tab === "groups"
                          ? "把几位员工拉进同一段对话，群组会话就会出现在这里。"
                          : "开始和员工对话，你的会话就会出现在这里。"}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {/* Keyed by tab: switching views swaps the list outright, like filtering does. */}
            <AnimatePresence initial={false} key={tab}>
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
              searching={searching || tabEmptySoFar}
            />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-1.5 px-2 pb-2">
        {/*
         * The plan and its usage, above the account row: it is the one number a person reads just
         * before something is refused, and it has to be somewhere they already look.
         */}
        <UsagePanel />
        <SidebarMenu className="gap-0.5">
          {/*
           * The reference's small butler at the foot of the sidebar, mapped onto what this product
           * already has: the default assistant at /bot.
           */}
          <NavRow icon={IconSparkles} label="小管家" to="/bot" />
          <SidebarMenuItem className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="h-[36px] min-w-0 flex-1 gap-2 px-1.5 hover:bg-foreground/5" />
                }
              >
                <UserAvatar />
                <span className="truncate text-[13px]">
                  {currentUser?.name || currentUser?.email}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {/* Admin routes are server-guarded; hide the entry for users who cannot open them. */}
                {currentUser?.role === "admin" ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    render={<Link {...adminLinkOptions} />}
                  >
                    <IconShieldLock />
                    管理
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  render={<Link {...settingsLinkOptions} />}
                >
                  <IconSettings />
                  账户设置
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  disabled={signOut.isPending}
                  onClick={handleSignOut}
                  variant="destructive"
                >
                  <IconLogout />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link
              {...settingsLinkOptions}
              activeProps={{ className: "bg-foreground/5" }}
              aria-label="设置"
              className={cn(
                buttonVariants({ size: "icon", variant: "ghost" }),
                "size-[32px] shrink-0",
              )}
              title="设置"
            >
              <IconSettings />
            </Link>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
