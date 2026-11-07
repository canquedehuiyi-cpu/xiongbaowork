import { IconPlayerPlay, IconPlus, IconSearch } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { SearchBox } from "@/components/layout/search-box";
import {
  type SegmentedTab,
  SegmentedTabs,
} from "@/components/layout/segmented-tabs";
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
import { cn } from "@/lib/utils";
import {
  type WakerGroup,
  wakerGroupsQueryOptions,
} from "@/lib/waker-groups/queries";
import {
  channelsOf,
  hasUnseenActivity,
  latestDirectChannel,
  listedEmployees,
} from "./roster";
import { useConversationFocus } from "./use-conversation-focus";

type RosterTab = "wakers" | "groups";

/*
 * The 「+ 新建…」 row and the search toggle beside it, as the reference draws them: a faint dashed
 * ghost button filling the row (x 12–196 at 1696px) and a 32px magnifier at its right.
 */
const newRowClassName =
  "flex h-[32px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-foreground/[0.06] border-dashed text-[13px] text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&>svg]:size-[14px]";

/** One 48px roster row: a 32px avatar 6px in from the row, the text 8px after it (x 18 and x 58). */
const rowClassName =
  "flex h-[48px] min-w-0 flex-1 items-center gap-[8px] rounded-md px-[6px] outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60";

function RosterToolbar({
  action,
  searchLabel,
  fieldLabel,
  query,
  onQueryChange,
}: {
  action: ReactNode;
  searchLabel: string;
  fieldLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mt-[8px] flex items-center">
        {action}
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
 * What the employee row says beside the name: the attention badge the old 需要你 list carried, an
 * unread dot, a busy mark, or 已暂停. Merged into the roster rather than drawn as a second list of
 * the same people, so an employee appears in the sidebar exactly once.
 */
function EmployeeMarks({
  attention,
  conversations,
}: {
  attention: BotAttention | undefined;
  conversations: ChannelSummary[];
}) {
  const waiting = attention ? needsInput(attention) : 0;
  const unread =
    (attention?.unread ?? 0) > 0 || conversations.some(hasUnseenActivity);
  const busy = conversations.some((channel) => channel.busy);
  return (
    <>
      {busy ? (
        <span
          aria-label="处理中"
          className="size-2 shrink-0 animate-pulse rounded-full border-[1.5px] border-primary"
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
          className="shrink-0 rounded-full bg-primary px-1.5 font-medium text-[11px] text-primary-foreground tabular-nums leading-4"
          title={attentionSummary(attention)}
        >
          {waiting}
        </span>
      ) : unread ? (
        <span
          aria-label="有未读消息"
          className="size-2 shrink-0 rounded-full bg-primary"
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
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={32} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-[14px] leading-[20px]">
          {agent.name}
        </span>
        {line ? (
          <span className="block truncate text-[12px] text-muted-foreground leading-[18px]">
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
    selected && "bg-sidebar-accent text-sidebar-accent-foreground",
  );
  return (
    <li className="flex items-center">
      {/* Its latest one-to-one conversation, else a new one addressed to it. */}
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

function EmployeeList({ employees }: { employees: AgentProfile[] }) {
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
  const shown = employees.filter((agent) =>
    matches(query, agent.name, agent.title, agent.roleDescription),
  );
  return (
    <>
      <RosterToolbar
        action={
          <Link className={newRowClassName} search={{ new: true }} to="/wakers">
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
          员工加载失败。
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
        <ul aria-label="员工" className="mt-[10px] flex flex-col gap-px">
          {shown.map((agent) => (
            <EmployeeRow
              agent={agent}
              attention={attentionById.get(agent.id)}
              channels={channels.data}
              key={agent.id}
              selected={focus.active && focus.agentId === agent.id}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** Up to three members' avatars, overlapped in the 32px slot an employee's avatar takes. */
function MemberStack({
  group,
  agentsById,
}: {
  group: WakerGroup;
  agentsById: Map<string, AgentProfile>;
}) {
  const shown = [...group.members]
    .sort((a, b) => a.position - b.position)
    .slice(0, 3);
  if (shown.length === 0) {
    return (
      <span className="flex size-[32px] shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[12px] text-muted-foreground">
        {group.name.slice(0, 1)}
      </span>
    );
  }
  return (
    <span className="flex h-[32px] w-[32px] shrink-0 items-center">
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
              name={agent?.name ?? "员工"}
              seed={agent?.avatarSeed ?? member.agentId}
              size={shown.length === 1 ? 32 : 18}
            />
          </span>
        );
      })}
    </span>
  );
}

function GroupList() {
  const [query, setQuery] = useState("");
  const groups = useQuery(wakerGroupsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const agentsById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const shown = (groups.data ?? []).filter((group) =>
    matches(query, group.name, group.description),
  );
  return (
    <>
      <RosterToolbar
        action={
          /*
           * The group wall's create dialog is local state there, with no address to open it by, so
           * this lands on the 群组 tab and its own 新建群组 button.
           */
          <Link
            className={newRowClassName}
            search={{ tab: "groups" }}
            to="/wakers"
          >
            <IconPlus aria-hidden="true" />
            新建群组
          </Link>
        }
        fieldLabel="按名字搜索群组"
        onQueryChange={setQuery}
        query={query}
        searchLabel="搜索群组"
      />
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
          <span className="block font-medium text-foreground">还没有群组</span>
          在员工管理的「群组」里把几位员工编成一组，它就会出现在这里。
        </RosterNote>
      ) : shown.length === 0 ? (
        <RosterNote>没有匹配的群组</RosterNote>
      ) : (
        <ul aria-label="群组" className="mt-[10px] flex flex-col gap-px">
          {shown.map((group) => (
            <li className="flex" key={group.id}>
              {/* No group workspace exists to open; the group wall is where a group is managed. */}
              <Link
                activeProps={{}}
                className={rowClassName}
                search={{ tab: "groups" }}
                to="/wakers"
              >
                <MemberStack agentsById={agentsById} group={group} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-[14px] leading-[20px]">
                    {group.name}
                  </span>
                  <span className="block truncate text-[12px] text-muted-foreground leading-[18px]">
                    {group.members.length} 名员工
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The sidebar's lower half: underline tabs 「员工 (n)」 / 「群组 (n)」 over the employee roster or
 * the group list. Conversations are not listed here any more — they live in the workspace column
 * beside an open conversation (see conversation-workspace.tsx).
 */
export function SidebarRoster() {
  const [tab, setTab] = useState<RosterTab>("wakers");
  const agents = useQuery(agentListQueryOptions());
  const groups = useQuery(wakerGroupsQueryOptions());
  const employees = listedEmployees(agents.data);
  const tabs: SegmentedTab<RosterTab>[] = [
    {
      value: "wakers",
      label: agents.data ? `员工 (${employees.length})` : "员工",
    },
    {
      value: "groups",
      label: groups.data ? `群组 (${groups.data.length})` : "群组",
    },
  ];
  return (
    <div className="px-[12px] pt-[15px] pb-3">
      <SegmentedTabs
        // Two equal halves, the selected label bold as the reference draws it.
        className="w-full gap-0 [&>button[aria-selected=true]]:font-semibold [&>button]:flex-1"
        label="员工与群组"
        onValueChange={setTab}
        tabs={tabs}
        value={tab}
        variant="underline"
      />
      {tab === "wakers" ? (
        <EmployeeList employees={employees} />
      ) : (
        <GroupList />
      )}
    </div>
  );
}
