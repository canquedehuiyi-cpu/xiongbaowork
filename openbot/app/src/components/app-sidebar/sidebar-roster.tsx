import { IconPlayerPlay, IconPlus, IconSearch } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useMemo, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { SearchBox } from "@/components/layout/search-box";
import { usePortraitSrc } from "@/components/portraits/use-portrait";
import { Button } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useMessageListEmphasis } from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";
import {
  type WakerGroup,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";
import { ChannelPagination } from "./channel-pagination";
import { ChannelRow } from "./channel-row";
import {
  channelsOf,
  hasUnseenActivity,
  isGroupChannel,
  latestDirectChannel,
  listedEmployees,
  matchingChannels,
  pinnedFirst,
} from "./roster";
import { useConversationFocus } from "./use-conversation-focus";

/*
 * 熊宝 v0.2.7 的侧栏名册（「员工 / 群组」），#452 换成上游的单一会话列表时去掉了，用户要回来：单聊从员工
 * 进，群聊和群组在另一边。和上游的「会话」列表并存，由 app-sidebar.tsx 顶上的切换选看哪一边。
 */

/*
 * The 「+ 新建…」 row and the search toggle beside it (docs/design/ios-studio): a quiet text row with
 * a red plus, left-aligned under the switch, and a 32px magnifier at its right.
 */
const newRowClassName =
  "flex h-[32px] min-w-0 flex-1 items-center gap-[7px] rounded-[8px] pl-[9px] text-[12px] text-foreground/85 outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-signal";

/** One roster row: a 29px rounded-square face 5px in, the name and its line 9px after it. */
const rowClassName =
  "flex h-[42px] min-w-0 flex-1 items-center gap-[9px] rounded-[9px] px-[5px] outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60";

/** A section label inside the 群组 view: 11px, faint, aligned with the rows. */
const sectionLabelClassName =
  "mt-[12px] mb-[4px] flex items-center justify-between px-[6px] text-[11px] text-faint leading-[18px]";

function RosterToolbar({
  actions,
  searchLabel,
  fieldLabel,
  query,
  onQueryChange,
}: {
  actions: ReactNode;
  searchLabel: string;
  fieldLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-[2px]">
        {actions}
        <Button
          aria-expanded={open}
          aria-label={searchLabel}
          className="size-[32px] shrink-0 text-muted-foreground"
          onClick={() => {
            // Closing the field drops what it held, so a hidden filter never narrows the list.
            if (open) onQueryChange("");
            setOpen(!open);
          }}
          size="icon"
          title={searchLabel}
          variant="ghost"
        >
          <IconSearch className="size-[16px]" />
        </Button>
      </div>
      {open ? (
        <SearchBox
          className="mt-[6px]"
          label={fieldLabel}
          onValueChange={onQueryChange}
          placeholder={fieldLabel}
          value={query}
        />
      ) : null}
    </>
  );
}

function RosterNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-[6px] py-3 text-[12px] text-muted-foreground leading-5">
      {children}
    </div>
  );
}

function matches(needle: string, ...fields: (string | null | undefined)[]) {
  const query = needle.trim().toLowerCase();
  return !query || fields.some((field) => field?.toLowerCase().includes(query));
}

/**
 * What the employee row says beside the name: how many things wait on the person (the badge's words
 * — 「2 个提问、1 个审批」 — are its name and tooltip), an unread dot, a busy mark, or 已暂停. Merged
 * into the roster rather than drawn as a second list of the same people, so an employee appears in
 * the sidebar exactly once.
 */
function EmployeeMarks({
  attention,
  conversations,
}: {
  attention: BotAttention | undefined;
  conversations: ChannelSummary[];
}) {
  const waiting = attention ? waitingOnYou(attention) : 0;
  const unread =
    (attention?.unread ?? 0) > 0 || conversations.some(hasUnseenActivity);
  const busy = conversations.some((channel) => channel.busy);
  return (
    <>
      {busy ? (
        <span
          aria-label="处理中"
          className="size-2 shrink-0 animate-pulse rounded-full border-[1.5px] border-signal"
          role="img"
        />
      ) : null}
      {attention?.paused ? (
        <span className="shrink-0 rounded-sm bg-foreground/[0.08] px-1 text-[11px] text-muted-foreground leading-4">
          已暂停
        </span>
      ) : null}
      {waiting > 0 && attention ? (
        <span
          aria-label={attentionSummary(attention)}
          className="shrink-0 rounded-full bg-signal px-1.5 font-medium text-[11px] text-signal-foreground tabular-nums leading-4"
          role="img"
          title={attentionSummary(attention)}
        >
          {waiting}
        </span>
      ) : unread ? (
        <span
          aria-label="有未读消息"
          className="size-2 shrink-0 rounded-full bg-signal"
          role="img"
          title={attention ? attentionSummary(attention) : "有未读消息"}
        />
      ) : null}
    </>
  );
}

function EmployeeRow({
  agent,
  attention,
  channels,
  selected,
}: {
  agent: AgentProfile;
  attention: BotAttention | undefined;
  channels: ChannelSummary[] | undefined;
  selected: boolean;
}) {
  const queryClient = useQueryClient();
  const resume = useMutation(setBotPausedMutationOptions(queryClient));
  const latest = latestDirectChannel(channels, agent.id);
  const line = agent.roleDescription || agent.title;
  const body = (
    <>
      <span aria-hidden="true" className="contents">
        <AbstractAvatar
          decorative
          name={agent.name}
          seed={agent.avatarSeed}
          portrait={{ kind: "coworker", id: agent.id }}
          size={29}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-[13px] leading-[18px]">
          {agent.name}
        </span>
        {line ? (
          <span className="block truncate text-[11px] text-faint leading-[16px]">
            {line}
          </span>
        ) : null}
      </span>
      <EmployeeMarks
        attention={attention}
        conversations={channelsOf(channels, agent.id)}
      />
    </>
  );
  const className = cn(
    rowClassName,
    selected &&
      "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-foreground/[0.06]",
  );
  return (
    <li className="flex items-center">
      {/* Its latest 单聊, else a new conversation addressed to it. */}
      {latest ? (
        <Link
          activeProps={{}}
          aria-current={selected ? "true" : undefined}
          className={className}
          params={{ channelId: latest.id }}
          to="/channel/$channelId"
        >
          {body}
        </Link>
      ) : (
        <Link
          activeProps={{}}
          aria-current={selected ? "true" : undefined}
          className={className}
          search={{ agent: agent.id }}
          to="/channel/new"
        >
          {body}
        </Link>
      )}
      {attention?.paused ? (
        <Button
          aria-label={`恢复 ${agent.name}`}
          className="size-[28px] shrink-0 text-muted-foreground"
          disabled={resume.isPending}
          onClick={() => resume.mutate({ agentId: agent.id, paused: false })}
          size="icon"
          title="已暂停，点一下恢复"
          variant="ghost"
        >
          <IconPlayerPlay className="size-[14px]" />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * 员工: everyone the person can talk to, each row opening its latest 单聊 (or a new one addressed to
 * it), with what waits on the person from that employee. 「新建员工」 opens the same wizard as the
 * header of 员工 (`/bots?new=true`).
 */
export function EmployeeList() {
  const [query, setQuery] = useState("");
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const focus = useConversationFocus();
  const attentionById = useMemo(
    () =>
      new Map((attention.data ?? []).map((bot) => [bot.agentId, bot] as const)),
    [attention.data],
  );
  const employees = listedEmployees(agents.data);
  const shown = employees.filter((agent) =>
    matches(query, agent.name, agent.title, agent.roleDescription),
  );
  /*
   * Selected only while a 单聊 with it (or a new conversation addressed to it) is open: a 群聊 is
   * about everyone in it, so it lights nobody here.
   */
  const openGroup = focus.channelId
    ? channels.data?.find((channel) => channel.id === focus.channelId)
    : undefined;
  const selectedId =
    focus.active && !(openGroup && isGroupChannel(openGroup))
      ? focus.agentId
      : undefined;
  return (
    <>
      <RosterToolbar
        actions={
          <Link className={newRowClassName} search={{ new: true }} to="/bots">
            <IconPlus aria-hidden="true" />
            新建员工
          </Link>
        }
        fieldLabel="按名字搜索员工"
        onQueryChange={setQuery}
        query={query}
        searchLabel="搜索员工"
      />
      {agents.isPending ? (
        <RosterNote>正在加载员工…</RosterNote>
      ) : agents.isError && !agents.data ? (
        <RosterNote>
          <span role="alert">员工加载失败。</span>
          <Button
            className="ml-1 h-auto px-1 py-0 text-[12px]"
            disabled={agents.isFetching}
            onClick={() => void agents.refetch()}
            variant="link"
          >
            {agents.isFetching ? "正在重试…" : "重试"}
          </Button>
        </RosterNote>
      ) : employees.length === 0 ? (
        <RosterNote>还没有员工。点「新建员工」创建第一位。</RosterNote>
      ) : shown.length === 0 ? (
        <RosterNote>没有匹配的员工</RosterNote>
      ) : (
        <ul aria-label="员工" className="mt-[8px] flex flex-col gap-px">
          {shown.map((agent) => (
            <EmployeeRow
              agent={agent}
              attention={attentionById.get(agent.id)}
              channels={channels.data}
              key={agent.id}
              selected={selectedId === agent.id}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** Up to three members' faces, overlapped in the 29px slot an employee's face takes. */
function MemberStack({
  group,
  agentsById,
}: {
  group: WakerGroup;
  agentsById: Map<string, AgentProfile>;
}) {
  const custom = usePortraitSrc("group", group.id);
  const ordered = [...group.members].sort((a, b) => a.position - b.position);
  const shown = ordered.slice(0, 3);
  if (custom) {
    // A face somebody chose for the group stands in for its members' faces.
    return (
      <span
        aria-label={`群组头像：${group.name}`}
        className="inline-flex size-[29px] shrink-0 overflow-hidden rounded-[8px]"
        role="img"
      >
        <img
          alt=""
          className="size-full object-cover"
          data-portrait=""
          height={29}
          src={custom}
          width={29}
        />
      </span>
    );
  }
  if (shown.length === 0) {
    return (
      <span className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px] bg-foreground/[0.08] text-[12px] text-muted-foreground">
        {group.name.slice(0, 1)}
      </span>
    );
  }
  // One name for the whole stack — 「成员：甲、乙」 — rather than one bare name per face.
  const names = ordered.map(
    (member) => agentsById.get(member.agentId)?.name ?? "员工",
  );
  return (
    <span
      aria-label={`成员：${names.join("、")}`}
      className="flex h-[29px] w-[29px] shrink-0 items-center"
      role="img"
    >
      {shown.map((member, index) => {
        const agent = agentsById.get(member.agentId);
        return (
          <span
            className={cn(
              "rounded-full ring-2 ring-sidebar",
              index > 0 && "-ml-[10px]",
            )}
            key={member.agentId}
          >
            <AbstractAvatar
              decorative
              name={agent?.name ?? "员工"}
              seed={agent?.avatarSeed ?? member.agentId}
              portrait={{ kind: "coworker", id: member.agentId }}
              size={shown.length === 1 ? 29 : 17}
            />
          </span>
        );
      })}
    </span>
  );
}

/**
 * 群组: the 群聊 the person is in (every loaded conversation with two or more employees, drawn and
 * menued as in 会话), then the 群组 — the named crews from 员工 › 群组, faces stacked.
 *
 * 「新建群聊」 opens the page that makes an empty 群聊 with the employees in the order picked;
 * 「新建群组」 lands on 员工 › 群组, whose create dialog has no address of its own.
 *
 * Older 群聊 than the loaded pages are fetched on request only: paging on scroll here would walk the
 * whole history of 单聊 looking for the next 群聊.
 */
export function GroupList({
  scrollRoot,
}: {
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  const [query, setQuery] = useState("");
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const groups = useQuery(wakerGroupsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const agentsById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const chats = pinnedFirst(
    matchingChannels((channels.data ?? []).filter(isGroupChannel), query),
  );
  const shownGroups = (groups.data ?? []).filter((group) =>
    matches(query, group.name, group.description),
  );
  const searching = query.trim().length > 0;
  return (
    <>
      <RosterToolbar
        actions={
          <>
            <Link className={newRowClassName} to="/group/new">
              <IconPlus aria-hidden="true" />
              新建群聊
            </Link>
            <Link
              className={newRowClassName}
              search={{ tab: "groups" }}
              to="/bots"
            >
              <IconPlus aria-hidden="true" />
              新建群组
            </Link>
          </>
        }
        fieldLabel="按名字搜索群聊和群组"
        onQueryChange={setQuery}
        query={query}
        searchLabel="搜索群聊和群组"
      />
      <section aria-labelledby="sidebar-group-chats">
        <h3 className={sectionLabelClassName} id="sidebar-group-chats">
          群聊
        </h3>
        {channels.isError && !channels.data ? (
          <RosterNote>
            <span role="alert">群聊加载失败。</span>
            <Button
              className="ml-1 h-auto px-1 py-0 text-[12px]"
              disabled={channels.isFetching}
              onClick={() => void channels.refetch()}
              variant="link"
            >
              {channels.isFetching ? "正在重试…" : "重试"}
            </Button>
          </RosterNote>
        ) : channels.data && chats.length === 0 ? (
          <RosterNote>
            {searching
              ? "已加载的群聊里没有匹配的"
              : channels.hasNextPage
                ? "已加载的会话里还没有群聊。"
                : "还没有群聊。点「新建群聊」，选两位以上员工开始。"}
          </RosterNote>
        ) : (
          <ul aria-label="群聊" className="flex flex-col gap-px">
            {chats.map((channel) => (
              <li key={channel.id}>
                <ChannelRow
                  animateOrder={false}
                  channel={channel}
                  emphasis={emphasis}
                />
              </li>
            ))}
          </ul>
        )}
        <ChannelPagination query={channels} scrollRoot={scrollRoot} searching />
      </section>
      <section aria-labelledby="sidebar-crews">
        <h3 className={sectionLabelClassName} id="sidebar-crews">
          群组
        </h3>
        {groups.isPending ? (
          <RosterNote>正在加载群组…</RosterNote>
        ) : groups.isError && !groups.data ? (
          <RosterNote>
            <span role="alert">群组加载失败。</span>
            <Button
              className="ml-1 h-auto px-1 py-0 text-[12px]"
              disabled={groups.isFetching}
              onClick={() => void groups.refetch()}
              variant="link"
            >
              {groups.isFetching ? "正在重试…" : "重试"}
            </Button>
          </RosterNote>
        ) : (groups.data ?? []).length === 0 ? (
          <RosterNote>
            在员工的「群组」里把几位员工编成一组，它就会出现在这里。
          </RosterNote>
        ) : shownGroups.length === 0 ? (
          <RosterNote>没有匹配的群组</RosterNote>
        ) : (
          <ul aria-label="群组" className="flex flex-col gap-px">
            {shownGroups.map((group) => (
              <li className="flex" key={group.id}>
                {/* No group workspace exists to open; 员工 › 群组 is where a group is managed. */}
                <Link
                  activeProps={{}}
                  className={rowClassName}
                  search={{ tab: "groups" }}
                  to="/bots"
                >
                  <MemberStack agentsById={agentsById} group={group} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-[13px] leading-[18px]">
                      {group.name}
                    </span>
                    <span className="block truncate text-[11px] text-faint leading-[16px]">
                      {group.members.length} 名员工
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
