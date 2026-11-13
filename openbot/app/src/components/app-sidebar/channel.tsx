import {
  IconLoader2,
  IconLogout,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconTrash,
  IconUsersMinus,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import { LeaveGroupDialog } from "@/components/channels/leave-group-dialog";
import { RenameConversationDialog } from "@/components/channels/rename-conversation-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DissolveCrewDialog } from "@/components/wakers/dissolve-crew";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { useTypedReveal } from "@/lib/typed-reveal";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import { ChannelItemContent } from "./channel-item-content";

/**
 * One conversation in the sidebar's list: the faces of whoever is in it (two or more stack, which is
 * how a 群聊 reads in the list), the employee's name and the time, then the conversation's title.
 * Memoized: `use-channel-events` preserves unchanged row identity, and `content-visibility` keeps
 * off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin, Rename and Delete. Rename is offered only to the person who started the
 * conversation, which is who the server lets rename it. Deleting is confirmed in a dialog that
 * names the channel, because the row it was invoked on is one of several identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  summary,
  untitled,
  lastMessageAt,
  pinned,
  canRename,
  unread,
  busy,
  emphasis,
  groupId,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  /** What the conversation is about, once named. The channel name only says which Bot it is. */
  summary?: string;
  /** Used as the thread title until the conversation has been named. See `untitledLine`. */
  untitled?: string;
  lastMessageAt?: string;
  pinned: boolean;
  /** Whether this person started the conversation, and so may rename it. The server's answer. */
  canRename: boolean;
  unread: boolean;
  busy: boolean;
  emphasis: MessageListEmphasis;
  /** The group this conversation is the chat of, when it is one the person made. */
  groupId?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's channel is the one on screen, as a boolean, so navigating between
  // channels re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  /* Types in only on arrival; an already-named row draws it outright. */
  const revealed = useTypedReveal(summary);
  const threadTitle = revealed.text || untitled || "新会话";
  const title = summary || untitled || "新会话";
  const group = participantIds.length > 1;
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dissolving, setDissolving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  /**
   * Why a pin did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. There is no toast in this
   * app, and the row is where the person was looking, so the sentence goes here and is replaced by
   * the next attempt.
   */
  const [pinProblem, setPinProblem] = useState<string | null>(null);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            // Two or more Bots is a group conversation, which has its own shared transcript.
            to={group ? "/group/$channelId" : "/channel/$channelId"}
            params={{ channelId }}
            type="button"
            className="flex w-full flex-row items-center gap-2 rounded-[9px] border border-transparent px-2.5 py-2 hover:bg-foreground/[0.03] [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
            activeProps={{
              // The open conversation lifts onto the sidebar's plate, as the open nav row does.
              className: "border-foreground/[0.06] bg-sidebar-accent",
            }}
          >
            <ChannelItemContent
              busy={busy}
              displayedTitle={threadTitle}
              emphasis={emphasis}
              groupId={groupId}
              lastMessageAt={lastMessageAt}
              name={name}
              participantIds={participantIds}
              pinned={pinned}
              revealing={revealed.typing}
              title={title}
              unread={unread}
            />
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setPinProblem(null);
              setPinned.mutate(
                { channelId, pinned: !pinned },
                { onError: (thrown) => setPinProblem(thrown.message) },
              );
            }}
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "取消置顶" : "置顶会话"}
          </ContextMenuItem>
          {canRename ? (
            <ContextMenuItem onClick={() => setRenaming(true)}>
              <IconPencil />
              重命名会话…
            </ContextMenuItem>
          ) : null}
          <DangerItem
            canRename={canRename}
            channelId={channelId}
            group={group}
            groupId={groupId}
            onDelete={() => setConfirming(true)}
            onDissolve={setDissolving}
            onLeave={() => setLeaving(true)}
          />
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <RenameConversationDialog
        channelId={channelId}
        onOpenChange={setRenaming}
        open={renaming}
        title={summary || untitled || ""}
      />
      {dissolving ? (
        <DissolveRowDialog
          fallbackName={name}
          groupId={dissolving}
          onDissolved={isOpen ? () => navigate({ to: "/" }) : undefined}
          onOpenChange={(open) => setDissolving(open ? dissolving : null)}
        />
      ) : null}
      <LeaveGroupDialog
        channelId={channelId}
        leave={isOpen ? () => navigate({ to: "/" }) : undefined}
        name={name}
        onOpenChange={setLeaving}
        open={leaving}
      />
      <DeleteConversationDialog
        channelId={channelId}
        // Away first when this row's channel is the one on screen.
        leave={isOpen ? () => navigate({ to: "/" }) : undefined}
        name={name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </>
  );
});

/**
 * 解散群组 from a row: the same confirmation as the settings drawer's, which needs the group's name.
 * Mounted only once asked, so the list's many rows do not each read the groups.
 */
function DissolveRowDialog({
  fallbackName,
  groupId,
  onDissolved,
  onOpenChange,
}: {
  fallbackName: string;
  groupId: string;
  onDissolved?: () => unknown;
  onOpenChange: (open: boolean) => void;
}) {
  const crew = useQuery(wakerGroupsQueryOptions()).data?.find(
    (entry) => entry.id === groupId,
  );
  return (
    <DissolveCrewDialog
      crew={{ id: groupId, name: crew?.name ?? fallbackName }}
      onDissolved={() => void onDissolved?.()}
      onOpenChange={onOpenChange}
      open
    />
  );
}

/**
 * The menu's last item, which depends on whether the chat is a group's the person made. That is
 * read from the groups list, and the list is read only here: the menu's content mounts when the menu
 * opens, so a roster whose menus are never opened asks for nothing. Until the answer is in a disabled
 * placeholder stands in, so 删除会话 never shows first and then turns into something else. If the
 * read fails, a multi-employee chat falls back to what the row knew: not mine to rename → leave,
 * mine → delete.
 */
function DangerItem({
  canRename,
  channelId,
  group,
  groupId,
  onDelete,
  onDissolve,
  onLeave,
}: {
  canRename: boolean;
  channelId: string;
  group: boolean;
  groupId?: string;
  onDelete: () => void;
  onDissolve: (groupId: string) => void;
  onLeave: () => void;
}) {
  // The list is fresh for 30s everywhere else; a menu that decides between delete and dissolve must
  // not read a stale one, so each opening asks again and waits for the answer.
  const groups = useQuery({
    ...wakerGroupsQueryOptions(),
    enabled: group,
    refetchOnMount: "always",
  });
  if (group && (groups.isPending || groups.isFetching))
    return (
      <ContextMenuItem disabled>
        <IconLoader2 />
        正在读取…
      </ContextMenuItem>
    );
  const linked =
    groupId ?? groups.data?.find((entry) => entry.channelId === channelId)?.id;
  if (linked)
    return (
      <ContextMenuItem variant="destructive" onClick={() => onDissolve(linked)}>
        <IconUsersMinus />
        解散群组…
      </ContextMenuItem>
    );
  if (group && !canRename)
    return (
      <ContextMenuItem variant="destructive" onClick={onLeave}>
        <IconLogout />
        退出群组…
      </ContextMenuItem>
    );
  return (
    <ContextMenuItem variant="destructive" onClick={onDelete}>
      <IconTrash />
      删除会话…
    </ContextMenuItem>
  );
}
