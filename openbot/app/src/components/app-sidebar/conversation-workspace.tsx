import { IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { SearchBox } from "@/components/layout/search-box";
import { SegmentedTabs } from "@/components/layout/segmented-tabs";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { automationListQueryOptions } from "@/lib/automations/queries";
import { autonomousQueryOptions } from "@/lib/autonomous/queries";
import { type EntrySource, SOURCE_LABEL } from "@/lib/autonomous/unified";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import {
  channelsOf,
  conversationStamp,
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "./roster";
import { useConversationFocus } from "./use-conversation-focus";

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

type WorkspaceTab = "chats" | "automations";

const WORKSPACE_TABS = [
  { value: "chats", label: "对话任务" },
  { value: "automations", label: "自动任务" },
] as const;

const newLinkClassName =
  "flex h-[24px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&>svg]:size-[13px]";

/**
 * A conversation row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a list that reacts to being read is a list that moves
 * under the cursor.
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
  // that way: navigating re-renders the rows whose answer changed, not the whole list.
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
        lastMessageAt={conversationStamp(
          channel.lastMessageAt ?? channel.createdAt,
        )}
        pinned={channel.pinned}
        unread={unread}
        busy={channel.busy ?? false}
      />
    </motion.div>
  );
}

function CountRow({
  count,
  children,
}: {
  count: number | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-[28px] items-center justify-between gap-1 px-[12px]">
      <span className="text-[12px] text-muted-foreground">
        {count === null ? "正在统计…" : `共${count}个任务`}
      </span>
      <span className="flex items-center gap-0.5">{children}</span>
    </div>
  );
}

function ListEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="px-[8px] py-3">
      <Empty className="min-h-[180px] border border-dashed p-4">
        <EmptyHeader>
          <EmptyTitle className="text-[13px]">{title}</EmptyTitle>
          <EmptyDescription className="text-pretty text-[12px]">
            {description}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/**
 * 对话任务: the employee's conversations, or every conversation when the open one has no employee.
 *
 * Everything the old sidebar roster did lives here now: search over what is loaded, pinned first,
 * unread and busy marks, the right-click pin and delete, and the cursor pagination — which, as
 * before, never walks the history on its own while a filter hides what it would load.
 */
function ConversationList({
  agentId,
  agentName,
}: {
  agentId: string | undefined;
  agentName: string;
}) {
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const own =
    agentId === undefined ? channels.data : channelsOf(channels.data, agentId);
  const searching = search.trim().length > 0;
  const visible = pinnedFirst(matchingChannels(own, search));
  /*
   * Nothing of this employee's among the pages loaded so far is not the same as nothing at all, and
   * it is no reason to walk the whole history unasked either: somebody with a long run of other
   * conversations would otherwise watch every page load in search of one. The button stays.
   */
  const emptySoFar = !searching && own !== undefined && own.length === 0;
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing. Order animation is for a channel that was
   * just spoken in, which is occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  return (
    <>
      <CountRow count={own === undefined ? null : own.length}>
        <Button
          aria-expanded={searchOpen}
          aria-label="搜索对话"
          className="size-[24px] text-muted-foreground"
          onClick={() => {
            if (searchOpen) setSearch("");
            setSearchOpen(!searchOpen);
          }}
          size="icon"
          title="搜索对话"
          variant="ghost"
        >
          <IconSearch className="size-[13px]" />
        </Button>
        {agentId ? (
          <Link
            activeProps={{}}
            className={newLinkClassName}
            search={{ agent: agentId }}
            to="/channel/new"
          >
            <IconPlus aria-hidden="true" />
            新建
          </Link>
        ) : (
          <Link activeProps={{}} className={newLinkClassName} to="/channel/new">
            <IconPlus aria-hidden="true" />
            新建
          </Link>
        )}
      </CountRow>
      {searchOpen ? (
        <div className="px-[12px] pb-1.5">
          <SearchBox
            label="搜索会话"
            onValueChange={setSearch}
            placeholder="搜索…"
            value={search}
          />
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-[6px] pb-3"
        data-slot="workspace-list"
        ref={scrollRoot}
      >
        {channels.isError && !channels.data ? (
          <div className="px-[6px] py-3 text-[12px] text-muted-foreground">
            <span role="alert">会话列表加载失败。</span>
            <Button
              className="ml-1 h-auto px-1 py-0 text-[12px]"
              disabled={channels.isFetching}
              onClick={() => void channels.refetch()}
              variant="link"
            >
              {channels.isFetching ? "正在重试…" : "重试"}
            </Button>
          </div>
        ) : null}
        {/*
         * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A list nobody has used yet
         * needs telling how to start. A list that simply does not match what is in the box has to say
         * so and quote it back — told "no conversations yet" while holding a typo, a person reads
         * their conversations as gone.
         */}
        {searching && visible.length === 0 ? (
          <ListEmpty
            description={
              channels.hasNextPage
                ? "加载更早的会话，才能搜索更多历史。"
                : `没有叫“${search.trim()}”的会话，最近也没有人提到过它。`
            }
            title={
              channels.hasNextPage
                ? "已加载的会话里没有匹配的"
                : "没有匹配的会话"
            }
          />
        ) : null}
        {emptySoFar ? (
          <ListEmpty
            description={
              channels.hasNextPage
                ? "加载更早的会话，看看更早的历史里有没有。"
                : "点「新建」开始第一段对话，它就会出现在这里。"
            }
            title={
              channels.hasNextPage
                ? agentId
                  ? `已加载的会话里没有和${agentName}的对话`
                  : "已加载的会话里还没有对话"
                : agentId
                  ? `还没有和${agentName}的对话`
                  : "你还没有会话"
            }
          />
        ) : null}
        {/*
         * Keyed by employee and by the filter: switching whose list this is, or typing, swaps the
         * list outright instead of fading rows out under somebody who is still typing.
         */}
        <AnimatePresence
          initial={false}
          key={`${agentId ?? "all"}?${searching ? search.trim() : ""}`}
        >
          {visible.map((channel) => (
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
          searching={searching || emptySoFar}
        />
      </div>
    </>
  );
}

type AutomationRow = {
  key: string;
  source: EntrySource;
  name: string;
  enabled: boolean;
};

/**
 * 自动任务: what this employee does on its own, read from the same two sources 自主工作 unifies — its
 * automations, and its routines, responsibilities and check-ins — each linking to that row's detail
 * on 自主工作 (`?detail=<source>:<id>`, the page's own deep link). 自主工作 has no per-employee filter
 * in its address, so the link opens the row rather than a narrowed list.
 */
function AutomationList({ agentId }: { agentId: string }) {
  const summary = useQuery(autonomousQueryOptions(agentId));
  const automations = useQuery(automationListQueryOptions());
  const pending = summary.isPending || automations.isPending;
  const failed =
    (summary.isError && !summary.data) ||
    (automations.isError && !automations.data);
  const rows: AutomationRow[] = [
    ...(automations.data ?? [])
      .filter(
        (automation) =>
          automation.target.kind === "waker" &&
          automation.target.agentId === agentId,
      )
      .map((automation) => ({
        key: `automation:${automation.id}`,
        source: "automation" as const,
        name: automation.name,
        enabled: automation.enabled,
      })),
    ...(summary.data?.routines ?? []).map((routine) => ({
      key: `routine:${routine.id}`,
      source: "routine" as const,
      name: routine.instruction,
      enabled: routine.enabled,
    })),
    ...(summary.data?.responsibilities ?? []).map((responsibility) => ({
      key: `responsibility:${responsibility.id}`,
      source: "responsibility" as const,
      name: responsibility.title,
      enabled: responsibility.status === "active",
    })),
    ...(summary.data?.proactive ?? []).map((check) => ({
      key: `proactive:${check.id}`,
      source: "proactive" as const,
      name: check.focus,
      enabled: check.enabled,
    })),
  ];
  return (
    <>
      <CountRow count={pending || failed ? null : rows.length}>
        <Link activeProps={{}} className={newLinkClassName} to="/autonomous">
          <IconPlus aria-hidden="true" />
          新建
        </Link>
      </CountRow>
      <div className="min-h-0 flex-1 overflow-y-auto px-[6px] pb-3">
        {pending ? (
          <p className="px-[6px] py-3 text-[12px] text-muted-foreground">
            正在加载自动任务…
          </p>
        ) : failed ? (
          <div className="px-[6px] py-3 text-[12px] text-muted-foreground">
            <span role="alert">自动任务加载失败。</span>
            <Button
              className="ml-1 h-auto px-1 py-0 text-[12px]"
              disabled={summary.isFetching || automations.isFetching}
              onClick={() => {
                void summary.refetch();
                void automations.refetch();
              }}
              variant="link"
            >
              重试
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <ListEmpty
            description="在「自主工作」里给这位员工安排定时任务或长期职责。"
            title="还没有自动任务"
          />
        ) : (
          rows.map((row) => (
            <Link
              activeProps={{}}
              className="flex w-full flex-col rounded-lg px-2.5 py-2 hover:bg-foreground/5"
              key={row.key}
              search={{ detail: row.key }}
              to="/autonomous"
            >
              <span className="truncate font-semibold text-[13px] leading-5">
                {row.name}
              </span>
              <span className="truncate text-[12px] text-muted-foreground leading-4">
                {SOURCE_LABEL[row.source]}
                {row.enabled ? "" : " · 已停用"}
              </span>
            </Link>
          ))
        )}
      </div>
    </>
  );
}

function WorkspaceHeader({
  agentId,
  agent,
  name,
  scope,
}: {
  agentId: string | undefined;
  agent: AgentProfile | undefined;
  name: string;
  /**
   * Switch between this employee's conversations and every conversation, when there is an employee
   * to narrow to. The upstream sidebar listed (and searched) every conversation; the column narrowed
   * that to one employee and left no way back, so this is the way back.
   */
  scope?: { all: boolean; onChange: (all: boolean) => void; agentName: string };
}) {
  return (
    <div className="flex h-[56px] shrink-0 items-center gap-[8px] px-[12px]">
      {agentId ? (
        <span aria-hidden="true" className="contents">
          <AbstractAvatar
            decorative
            name={name}
            seed={agent?.avatarSeed ?? agentId}
            portrait={{ kind: "coworker", id: agentId }}
            size={32}
          />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-semibold text-[14px]">
        {name}
      </span>
      {scope ? (
        <button
          aria-pressed={scope.all}
          className="shrink-0 rounded-sm text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => scope.onChange(!scope.all)}
          title={
            scope.all
              ? `只看${scope.agentName}的对话`
              : "看所有员工的对话，并在其中搜索"
          }
          type="button"
        >
          {scope.all ? `只看${scope.agentName}` : "全部对话"}
        </button>
      ) : null}
      {agentId ? (
        <Link
          className="shrink-0 rounded-sm text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          params={{ agentId }}
          to="/wakers/$agentId"
        >
          管理
        </Link>
      ) : null}
    </div>
  );
}

/**
 * What the workspace column holds, wherever it is drawn: the header, the 「对话任务 | 自动任务」
 * switch and the list, for one employee or (switched, or with nobody to narrow to) every
 * conversation.
 */
function WorkspaceBody({ focusAgentId }: { focusAgentId: string | undefined }) {
  const agents = useQuery(agentListQueryOptions());
  const [tab, setTab] = useState<WorkspaceTab>("chats");
  const [all, setAll] = useState(false);
  const focused = focusAgentId
    ? agents.data?.find((candidate) => candidate.id === focusAgentId)
    : undefined;
  const focusedName = focusAgentId ? (focused?.name ?? "员工") : "";
  const agentId = all ? undefined : focusAgentId;
  const agent = agentId ? focused : undefined;
  const name = agentId ? focusedName : "全部对话";
  return (
    <>
      <WorkspaceHeader
        agent={agent}
        agentId={agentId}
        name={name}
        {...(focusAgentId
          ? { scope: { all, onChange: setAll, agentName: focusedName } }
          : {})}
      />
      {agentId ? (
        <div className="px-[12px] pb-2">
          <SegmentedTabs
            className="flex w-full [&>button]:flex-1"
            label="任务类型"
            onValueChange={setTab}
            size="sm"
            tabs={WORKSPACE_TABS}
            value={tab}
          />
        </div>
      ) : null}
      {agentId && tab === "automations" ? (
        <AutomationList agentId={agentId} />
      ) : (
        <ConversationList agentId={agentId} agentName={name} />
      )}
    </>
  );
}

/**
 * The middle column beside a conversation (description (1) of the parity brief): ~240px between the
 * sidebar and the chat, about one employee — its avatar, name and 「管理」 link, a 「对话任务 |
 * 自动任务」 switch, a count with 「+ 新建」, and the list.
 *
 * Whose? The employee a new conversation is addressed to, or the first member of the open one. A
 * conversation with nobody in it (or a roster that has not answered yet) shows every conversation
 * instead, so no conversation is ever unreachable from here.
 *
 * Renders nothing off the conversation routes.
 */
export function ConversationWorkspace() {
  const focus = useConversationFocus();
  const agents = useQuery(agentListQueryOptions());
  if (!focus.active) return null;
  const agentId = focus.agentId;
  const name = agentId
    ? (agents.data?.find((candidate) => candidate.id === agentId)?.name ??
      "员工")
    : undefined;
  return (
    <aside
      aria-label={name ? `${name}的对话` : "全部对话"}
      className="hidden w-[240px] shrink-0 flex-col border-border border-r bg-card md:flex"
    >
      {/* Remounted per employee, so switching to 全部对话 for one does not carry to the next. */}
      <WorkspaceBody focusAgentId={agentId} key={agentId ?? "all"} />
    </aside>
  );
}

/**
 * The same list on a phone, inside the sidebar drawer.
 *
 * The column above is `md:flex` only, and on a phone the sidebar is a drawer (`Sheet`), so below
 * 768px there was no way to reach an earlier conversation, search them, pin or delete one, or load
 * older pages — all of which the upstream sidebar carried in that drawer. Drawn only on a phone, so
 * a desktop never renders the list twice; off a conversation it lists every conversation, as the
 * upstream drawer did. Following a link inside it closes the drawer, like leaving any sheet.
 */
export function MobileConversations() {
  const { isMobile, setOpenMobile } = useSidebar();
  const focus = useConversationFocus();
  if (!isMobile) return null;
  const agentId = focus.active ? focus.agentId : undefined;
  return (
    <section
      aria-label="对话"
      className="mt-3 flex max-h-[60vh] min-h-[240px] flex-col border-sidebar-border border-t"
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest("a[href]"))
          setOpenMobile(false);
      }}
    >
      <WorkspaceBody focusAgentId={agentId} key={agentId ?? "all"} />
    </section>
  );
}
