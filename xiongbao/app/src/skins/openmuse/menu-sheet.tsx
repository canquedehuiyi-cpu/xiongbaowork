import {
  IconHome,
  IconLogout,
  IconMessageCircle,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUsersGroup,
  IconUsersMinus,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "@/components/app-sidebar/app-sidebar";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import {
  DissolveRowDialog,
  useRowDanger,
} from "@/components/app-sidebar/row-danger";
import { ChannelAvatar } from "@/components/channels/avatar";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import { LeaveGroupDialog } from "@/components/channels/leave-group-dialog";
import { navigationRender } from "@/components/layout/navigation-target";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { untitledLine } from "@/lib/channels/label";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { useNavigationItems } from "@/lib/navigation";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { useMuse } from "./context";
import { MainChatLink, NewChatLink } from "./links";
import {
  Divider,
  ErrorNotice,
  LinkRow,
  MuseButton,
  MuseLinkButton,
  MuseSheet,
  museText,
} from "./ui";

/**
 * OpenMuse's menu: the main chat, a new chat, every conversation OpenBot keeps, and a way to every
 * other OpenBot surface. Nothing here is OpenMuse's own data; each row opens an OpenBot route.
 */
export function MenuSheet({ onClose }: { onClose: () => void }) {
  const { bot } = useMuse();
  const user = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const signOutOffered = useSignOutOffered();
  const navigation = useNavigationItems();
  const [search, setSearch] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const shown = pinnedFirst(matchingChannels(channels.data, search));
  const botName = bot?.name ?? "你的员工";

  return (
    <MuseSheet
      bodyRef={body}
      onClose={onClose}
      subtitle={user.data?.name || user.data?.email}
      title={appConfig.brand.productName}
    >
      <div className="flex flex-col gap-3.5">
        <LinkRow
          detail={`你和${botName}一直在进行的对话`}
          icon={IconMessageCircle}
          render={<MainChatLink agentId={bot?.id} onClick={onClose} />}
          title="主对话"
        />
        <MuseLinkButton
          icon={IconPlus}
          primary
          render={<NewChatLink agentId={bot?.id} onClick={onClose} />}
        >
          新对话
        </MuseLinkButton>
        <div className="mt-3 flex items-center justify-between">
          <h2 className={museText.heading}>对话</h2>
          <MuseLinkButton
            icon={IconUsersGroup}
            render={<Link onClick={onClose} to="/group/new" />}
            small
          >
            新建群组
          </MuseLinkButton>
        </div>
        <label className="relative block">
          <IconSearch
            aria-hidden="true"
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 size-4 text-muted-foreground"
          />
          <input
            aria-label="搜索对话"
            className="min-h-[45px] w-full rounded-[19px] border border-border bg-card py-3 pr-4 pl-10 text-[16px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-[var(--openmuse-focus)]"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索对话"
            value={search}
          />
        </label>
        {channels.isPending ? null : channels.error ? (
          <ErrorNotice error="读不到你的对话。" />
        ) : shown.length === 0 ? (
          <p className={museText.muted}>
            {searching
              ? `没有哪段对话的名称或最新消息里有「${search.trim()}」。`
              : `和${botName}开始一段对话，它就会出现在这里。`}
          </p>
        ) : (
          <div>
            {shown.map((channel) => (
              <ConversationRow
                channel={channel}
                key={channel.id}
                onOpen={onClose}
              />
            ))}
          </div>
        )}
        <ChannelPagination
          query={channels}
          scrollRoot={body}
          searching={searching}
        />
        <p className={museText.small}>
          对话跟着参与其中的员工走。置顶一段，它就会留在最上面。
        </p>
        <Divider className="my-1.5" />
        <div>
          <LinkRow
            icon={IconHome}
            render={<Link onClick={onClose} to="/" />}
            title="首页"
          />
          {/* OpenBot's own destinations, from the one list its sidebar draws. */}
          {navigation.map((item) => (
            <LinkRow
              icon={item.icon}
              key={item.id}
              render={navigationRender(item, { onClick: onClose })}
              tint={item.section === "account" ? "plain" : "sky"}
              title={item.label}
            />
          ))}
        </div>
        {signOutOffered ? (
          <>
            <MuseButton
              className="self-start"
              danger
              disabled={signOut.isPending}
              icon={IconLogout}
              onClick={async () => {
                await signOut.mutateAsync();
                await navigate({ to: "/sign" });
              }}
              small
            >
              退出登录
            </MuseButton>
            <ErrorNotice error={signOut.error?.message} />
          </>
        ) : null}
      </div>
    </MuseSheet>
  );
}

/**
 * One conversation, laid out as this look lists a side chat: its Bots' faces and title, then its actions as pills.
 * Pin and delete are the same two OpenBot offers on its sidebar row.
 */
function ConversationRow({
  channel,
  onOpen,
}: {
  channel: ChannelSummary;
  onOpen: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const navigate = useNavigate();
  const openId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const [dissolving, setDissolving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const group = channel.agentIds.length > 1;
  // The same decision as the main sidebar's row menu: dissolve my group, leave one that is not mine.
  const danger = useRowDanger({
    canRename: channel.canRename ?? false,
    channelId: channel.id,
    group,
  });
  const unread = isUnread(channel, openId);
  const busy = channel.busy || (channel.work?.length ?? 0) > 0;
  const title = channel.summary?.trim() || untitledLine(channel) || "新对话";
  const who = group
    ? channel.agentIds
        .map((id) => agents.data?.find((agent) => agent.id === id)?.name)
        .filter(Boolean)
        .join(", ") || channel.name
    : channel.name;
  const when = channel.lastMessageAt ? relativeTime(channel.lastMessageAt) : "";

  return (
    <div className="flex flex-col gap-2.5 border-border border-b py-3">
      <Item
        className={cn(
          "flex-nowrap items-start gap-2.5 border-0 p-0 [a]:hover:bg-transparent",
          channel.id === openId && "[&_[data-slot=item-title]]:underline",
        )}
        render={
          <Link
            onClick={onOpen}
            params={{ channelId: channel.id }}
            to={group ? "/group/$channelId" : "/channel/$channelId"}
          />
        }
      >
        {/* The same faces OpenBot's own conversation list draws: the Bot, or the group's Bots. */}
        <span className="mt-0.5 shrink-0">
          <ChannelAvatar
            participantIds={channel.agentIds}
            size={24}
            typing={busy}
          />
        </span>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle
            className={cn(
              museText.body,
              "line-clamp-1 block",
              unread && "font-semibold",
            )}
          >
            {title}
          </ItemTitle>
          <span className={cn(museText.small, "flex items-center gap-1.5")}>
            <span className="truncate">
              {who}
              {when ? ` · ${when}` : ""}
            </span>
            {busy ? (
              <span className="shrink-0 text-[var(--openmuse-accent)]">
                · 工作中
              </span>
            ) : null}
          </span>
        </ItemContent>
        {unread ? (
          <span
            className="mt-2 size-2 shrink-0 rounded-full bg-[var(--openmuse-accent)]"
            role="img"
            aria-label="有未读消息"
          />
        ) : null}
        {channel.pinned ? (
          <IconPinFilled
            aria-label="已置顶"
            className="mt-1 size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
      </Item>
      <div className="flex gap-2">
        <MuseButton
          disabled={setPinned.isPending}
          icon={channel.pinned ? IconPinnedOff : IconPin}
          onClick={() =>
            setPinned.mutate({ channelId: channel.id, pinned: !channel.pinned })
          }
          small
        >
          {channel.pinned ? "取消置顶" : "置顶"}
        </MuseButton>
        {danger.kind === "pending" ? (
          <MuseButton disabled small>
            正在读取…
          </MuseButton>
        ) : danger.kind === "dissolve" ? (
          <MuseButton
            icon={IconUsersMinus}
            onClick={() => setDissolving(danger.groupId)}
            small
          >
            解散群组…
          </MuseButton>
        ) : danger.kind === "leave" ? (
          <MuseButton icon={IconLogout} onClick={() => setLeaving(true)} small>
            退出群组…
          </MuseButton>
        ) : (
          <MuseButton
            icon={IconTrash}
            onClick={() => setConfirming(true)}
            small
          >
            删除
          </MuseButton>
        )}
      </div>
      <ErrorNotice error={setPinned.error?.message} />
      {dissolving ? (
        <DissolveRowDialog
          fallbackName={channel.name}
          groupId={dissolving}
          onDissolved={
            channel.id === openId ? () => navigate({ to: "/" }) : undefined
          }
          onOpenChange={(next) => setDissolving(next ? dissolving : null)}
        />
      ) : null}
      <LeaveGroupDialog
        channelId={channel.id}
        leave={channel.id === openId ? () => navigate({ to: "/" }) : undefined}
        name={channel.name}
        onOpenChange={setLeaving}
        open={leaving}
      />
      <DeleteConversationDialog
        channelId={channel.id}
        leave={channel.id === openId ? () => navigate({ to: "/" }) : undefined}
        name={channel.name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </div>
  );
}
