import {
  IconMessagePlus,
  IconPinFilled,
  IconPlus,
  IconSearch,
  IconUsersPlus,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { memo, useRef, useState } from "react";
import { ChannelMenu } from "@/components/app-sidebar/channel";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import {
  conversationStamp,
  isGroupChannel,
  isUnread,
  matchingChannels,
} from "@/components/app-sidebar/roster";
import { waitingBotIds } from "@/components/approvals/waiting";
import { ChannelAvatar, TypingBadge } from "@/components/channels/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { useBotNames } from "@/lib/agents/bot-names";
import { approvalInboxOptions } from "@/lib/approvals";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import { iconButtonClassName, ListHead } from "./list-head";

/** 「消息」列表的筛选：全部、未读、待我确认、群组。 */
export type MessageFilter = "all" | "unread" | "needsMe" | "groups";

const FILTERS: readonly { key: MessageFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "unread", label: "未读" },
  { key: "needsMe", label: "待我确认" },
  { key: "groups", label: "群组" },
];

/** 某个筛选下一行也没有时说的话。 */
const EMPTY_FILTER: Record<Exclude<MessageFilter, "all">, string> = {
  unread: "没有未读的消息",
  needsMe: "没有等你确认的事",
  groups: "还没有群组",
};

/** 一段会话最后动的时间：最后一条消息，没人说过话的就是它建出来的时候。 */
function lastActivity(channel: ChannelSummary): string {
  return channel.lastMessageAt ?? channel.createdAt;
}

/**
 * 置顶的在前，其余按最后消息时间从新到旧，单聊和群组混在一起排。服务端也是这个顺序，这里再排一次，是为了
 * 推送把一行改了却没挪位置的时候（和 `pinnedFirst` 同一个理由）。
 */
function byRecency(channels: readonly ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      lastActivity(b).localeCompare(lastActivity(a)),
  );
}

/**
 * 一对一会话的那位员工有没有等你确认的事。群组不算：「待我确认」按员工给出，一个群组里有好几位员工，
 * 说不清是哪一位在等你。`waiting` 为空是还不知道（在加载，或读失败了），一律不算。
 */
function waitsOnMe(
  channel: ChannelSummary,
  waiting: ReadonlySet<string> | undefined,
): boolean {
  return (
    waiting !== undefined &&
    !isGroupChannel(channel) &&
    channel.agentIds.length === 1 &&
    waiting.has(channel.agentIds[0] ?? "")
  );
}

function passes(
  channel: ChannelSummary,
  filter: MessageFilter,
  openChannelId: string | undefined,
  waiting: ReadonlySet<string> | undefined,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unread":
      return isUnread(channel, openChannelId);
    case "needsMe":
      return waitsOnMe(channel, waiting);
    case "groups":
      return isGroupChannel(channel);
  }
}

/**
 * 有事等你确认的员工：在等你回答的提问、在等你批的审批，按员工归（和 `useWaitingByBot` 同一套规则），
 * 整个列表一次审批收件箱查询，不是每行一个。
 *
 * `bots` 只在读到了、而且这次没出错时才有；在加载或读失败时是 `undefined`，谁也不标、「待我确认」也不说
 * 「没有」——不知道的事不当成没有。
 */
function useWaitingBots() {
  const inbox = useQuery({ ...approvalInboxOptions(), select: waitingBotIds });
  return {
    bots: inbox.isError ? undefined : inbox.data,
    failed: inbox.isError,
    retrying: inbox.isFetching,
    retry: () => void inbox.refetch(),
  };
}

/**
 * 消息：单聊和群组合成一个列表，按最后消息时间倒序（置顶的在最前）。上面是搜索框和筛选标签「全部 / 未读 /
 * 待我确认 / 群组」，右上「＋」收着「新对话」「新建群组」。点一行就是那段对话。
 *
 * 只画拿得到的东西：未读只有「有没有」，没有条数，所以是一个点，不是数字。
 */
export function MessageList() {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const groups = useQuery(wakerGroupsQueryOptions());
  const waiting = useWaitingBots();
  const emphasis = useMessageListEmphasis();
  const botName = useBotNames();
  const [filter, setFilter] = useState<MessageFilter>("all");
  // Only the 未读 filter depends on which conversation is open; elsewhere switching conversations
  // re-renders the rows whose open state changed, not the list.
  const openChannelId = useParams({
    strict: false,
    select: (params) =>
      filter === "unread"
        ? (params as { channelId?: string }).channelId
        : undefined,
  });
  const [search, setSearch] = useState("");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const groupOfChannel = new Map(
    (groups.data ?? []).flatMap((group) =>
      group.channelId ? [[group.channelId, group.id] as const] : [],
    ),
  );
  const visible = byRecency(
    matchingChannels(channels.data, search).filter((channel) =>
      passes(channel, filter, openChannelId, waiting.bots),
    ),
  );
  const loaded = channels.data !== undefined;
  // 「待我确认」还不知道答案时，不说「没有」。
  const waitingUnknown = filter === "needsMe" && waiting.bots === undefined;
  return (
    <>
      <ListHead rail="msg">
        <NewMenu />
      </ListHead>
      <label className="mx-4 mb-2 flex items-center gap-1.5 rounded-(--wb-radius-sm) bg-(--wb-card2) px-[11px] py-2 text-(--wb-muted) text-[13px]">
        <IconSearch aria-hidden="true" className="size-4 shrink-0" />
        <input
          aria-label="搜索会话"
          className="min-w-0 flex-1 border-0 bg-transparent text-(--wb-fg) outline-none placeholder:text-(--wb-muted)"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索会话…"
          type="search"
          value={search}
        />
      </label>
      <fieldset
        aria-label="筛选"
        className="m-0 flex min-w-0 gap-1.5 border-0 px-4 pt-0.5 pb-2.5"
      >
        {FILTERS.map(({ key, label }) => (
          <button
            aria-pressed={filter === key}
            className="shrink-0 rounded-(--wb-radius-pill) border-0 bg-(--wb-card2) px-2.5 py-1 text-(--wb-muted) text-[12px] outline-none hover:text-(--wb-fg2) focus-visible:outline-2 focus-visible:outline-(--wb-accent) aria-pressed:bg-(--wb-accent-soft) aria-pressed:font-semibold aria-pressed:text-(--wb-accent)"
            key={key}
            onClick={() => setFilter(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </fieldset>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        ref={scrollRoot}
      >
        <nav aria-label="会话" className="flex flex-col gap-px">
          {channels.isError && !loaded ? (
            <FailedNote
              onRetry={() => void channels.refetch()}
              retrying={channels.isFetching}
            >
              会话加载失败。
            </FailedNote>
          ) : null}
          {filter === "needsMe" && waiting.failed ? (
            <FailedNote onRetry={waiting.retry} retrying={waiting.retrying}>
              待确认事项加载失败
            </FailedNote>
          ) : null}
          {loaded && visible.length === 0 && !waitingUnknown ? (
            <EmptyNote
              filter={filter}
              more={channels.hasNextPage}
              search={searching ? search.trim() : ""}
            />
          ) : null}
          {visible.map((channel) => (
            <MessageRow
              botName={botName}
              channel={channel}
              emphasis={emphasis}
              groupId={groupOfChannel.get(channel.id)}
              key={channel.id}
              waitsOnMe={waitsOnMe(channel, waiting.bots)}
            />
          ))}
          <ChannelPagination
            query={channels}
            scrollRoot={scrollRoot}
            // Filtering can leave the sentinel in view; asking for older pages is then the person's call.
            searching={searching || filter !== "all"}
          />
        </nav>
      </div>
    </>
  );
}

/** 一句「没读出来」和一个「重试」。 */
function FailedNote({
  children,
  onRetry,
  retrying,
}: {
  children: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <p
      className="m-0 px-[10px] py-2 text-(--wb-muted) text-[12.5px]"
      role="alert"
    >
      {children}
      <button
        className="ml-1 border-0 bg-transparent p-0 text-(--wb-accent) underline-offset-2 hover:underline disabled:opacity-60"
        disabled={retrying}
        onClick={onRetry}
        type="button"
      >
        {retrying ? "正在重试…" : "重试"}
      </button>
    </p>
  );
}

/** 右上「＋」：新对话、新建群组。 */
function NewMenu() {
  const itemClassName =
    "gap-2 rounded-(--wb-radius-sm) px-2.5 py-2 text-(--wb-fg) text-[13.5px] focus:bg-(--wb-hover) focus:text-(--wb-fg) [&_svg]:text-(--wb-accent)";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="新对话 / 新建群组"
        className={iconButtonClassName}
        title="新对话 / 新建群组"
      >
        <IconPlus aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[168px] rounded-(--wb-radius) bg-(--wb-card) p-1.5 text-(--wb-fg) shadow-(--wb-shadow) ring-(--wb-line2)"
      >
        <DropdownMenuItem
          className={itemClassName}
          render={<Link to="/channel/new" />}
        >
          <IconMessagePlus aria-hidden="true" />
          新对话
        </DropdownMenuItem>
        <DropdownMenuItem
          className={itemClassName}
          render={<Link to="/group/new" />}
        >
          <IconUsersPlus aria-hidden="true" />
          新建群组
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyNote({
  filter,
  search,
  more,
}: {
  filter: MessageFilter;
  /** 搜的字，没在搜时为空。 */
  search: string;
  /** 还有更早的会话没加载。 */
  more: boolean;
}) {
  const [title, description] = search
    ? [
        more ? "已加载的会话里没有匹配的" : "没有匹配的会话",
        more
          ? "加载更早的会话，再多搜一些。"
          : `没有哪段会话的名字或最近一条消息里有「${search}」。`,
      ]
    : filter === "all"
      ? ["还没有会话", "和员工开始一段对话，它就会出现在这里。"]
      : [
          EMPTY_FILTER[filter],
          more ? "这里只看了已加载的会话，加载更早的再找找。" : undefined,
        ];
  return (
    <Empty className="my-2 min-h-[30dvh] border border-(--wb-line2) border-dashed text-(--wb-fg)">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="text-pretty text-(--wb-muted)">
            {description}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  );
}

/**
 * 设计稿 `.group-av`：群组的头像是成员拼图，2×2 最多 4 格。员工正在干活时，右下角和单聊一样有正在输入的
 * 小标。
 */
function GroupMosaic({
  memberIds,
  busy,
}: {
  memberIds: readonly string[];
  busy: boolean;
}) {
  return (
    <span className="relative shrink-0">
      <span
        aria-hidden="true"
        className="grid size-[42px] grid-cols-2 grid-rows-2 gap-[2px] rounded-(--wb-radius) bg-(--wb-card2) p-[3px]"
        data-testid="group-mosaic"
      >
        {memberIds.slice(0, 4).map((id) => (
          <span
            className="block size-[17px] overflow-hidden rounded-[4px]"
            data-mosaic-cell=""
            key={id}
          >
            <ChannelAvatar participantIds={[id]} size={17} />
          </span>
        ))}
      </span>
      {busy ? <TypingBadge /> : null}
    </span>
  );
}

/**
 * 最后一条消息是谁说的：员工说的写员工名（一对一会话就是会话名，群组里按员工 id 查名字，还没查到就不写），
 * 自己说的写「我」。没有消息时为空。
 */
function speakerOf(
  channel: ChannelSummary,
  botName: (botId: string) => string,
): string {
  if (!channel.lastMessageAgentId) return "我";
  return isGroupChannel(channel)
    ? botName(channel.lastMessageAgentId)
    : channel.name;
}

/**
 * 一行的两行字，跟着「消息列表突出显示」设置（设置 › 外观，和侧栏同一个）：
 * - 对话标题（`thread`，默认）：第一行是会话的标题（改过名的就是改的名），第二行「谁：最后一条消息」；
 * - 员工名字（`agent`）：第一行是员工或群组的名字，第二行最后一条消息（群组里前面写是谁说的），和设计稿一样。
 * 没有标题的会话第一行用名字；拿不到的不画，不编。
 */
function rowLines(
  channel: ChannelSummary,
  emphasis: MessageListEmphasis,
  botName: (botId: string) => string,
): { first: string; second: string } {
  const group = isGroupChannel(channel);
  const last = channel.lastMessage?.trim() ?? "";
  const speaker = last ? speakerOf(channel, botName) : "";
  const said = (prefixed: boolean) =>
    prefixed && speaker ? `${speaker}：${last}` : last;
  if (emphasis === "thread") {
    const first =
      channel.summary?.trim() || channel.opening?.trim() || channel.name;
    // 第一行已经是员工名（会话还没标题）时，第二行不再重复一遍。
    return { first, second: said(speaker !== first) };
  }
  return {
    first: channel.name,
    second:
      said(group) || (channel.summary || untitledLine(channel) || "").trim(),
  };
}

/**
 * 设计稿 `.row`：头像（群组是成员拼图）、第一行和时间，下一行是最后一条消息，未读的右边一个点。打开着的那段
 * 抬成一张卡。右键是置顶、重命名、删除（和侧栏同一个菜单）。
 *
 * Memoized, as the sidebar's row is: `use-channel-events` keeps an unchanged row's object, and whether
 * this row is unread is read here as a boolean, so opening another conversation re-renders the rows
 * whose answer changed rather than the whole list.
 */
const MessageRow = memo(function MessageRow({
  channel,
  emphasis,
  botName,
  groupId,
  waitsOnMe,
}: {
  channel: ChannelSummary;
  emphasis: MessageListEmphasis;
  botName: (botId: string) => string;
  groupId?: string;
  /** 这位员工有事等你确认（只对一对一会话）。 */
  waitsOnMe: boolean;
}) {
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  const group = isGroupChannel(channel);
  const { first, second } = rowLines(channel, emphasis, botName);
  // A turn running, or work the conversation waits on between turns: a hop, a routine.
  const busy = (channel.busy ?? false) || (channel.work?.length ?? 0) > 0;
  return (
    <ChannelMenu
      canRename={channel.canRename ?? false}
      channelId={channel.id}
      group={group}
      groupId={groupId}
      name={channel.name}
      pinned={channel.pinned}
      title={channel.summary || untitledLine(channel) || ""}
    >
      <Link
        activeProps={{}}
        className="flex w-full min-w-0 items-center gap-[11px] rounded-(--wb-radius) px-[10px] py-[10px] text-(--wb-fg) outline-none [contain-intrinsic-size:auto_62px] [content-visibility:auto] hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-accent) aria-[current=page]:bg-(--wb-card) aria-[current=page]:shadow-(--wb-row-shadow)"
        params={{ channelId: channel.id }}
        to={group ? "/group/$channelId" : "/channel/$channelId"}
      >
        {group ? (
          <GroupMosaic busy={busy} memberIds={channel.agentIds} />
        ) : (
          <span className="shrink-0">
            <ChannelAvatar
              participantIds={channel.agentIds}
              size={42}
              typing={busy}
            />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-[14px]">
            <span
              className="min-w-0 truncate font-semibold"
              data-message-first=""
              title={first}
            >
              {first}
            </span>
            {channel.pinned ? (
              <IconPinFilled
                aria-label="已置顶"
                className="size-3 shrink-0 text-(--wb-muted)"
              />
            ) : null}
            {channel.lastMessageAt ? (
              <time
                className="ml-auto shrink-0 text-(--wb-muted) text-[11px] tabular-nums"
                dateTime={channel.lastMessageAt}
              >
                {conversationStamp(channel.lastMessageAt)}
              </time>
            ) : null}
          </span>
          {second || waitsOnMe || unread ? (
            <span className="mt-[3px] flex min-w-0 items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate text-(--wb-muted) text-[12.5px]"
                data-message-second=""
                title={second || undefined}
              >
                {waitsOnMe ? (
                  <em className="text-(--wb-accent) not-italic">[待你确认]</em>
                ) : null}
                {waitsOnMe && second ? " " : null}
                {second}
              </span>
              {unread ? (
                <span className="size-2 shrink-0 rounded-full bg-(--wb-accent)">
                  <span className="sr-only">未读</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </Link>
    </ChannelMenu>
  );
});
