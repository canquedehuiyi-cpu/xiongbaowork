import {
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
  const [dissolving, setDissolving] = useState(false);
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
          {groupId ? (
            // A chat the person's own group is the other face of: deleting it would orphan the group.
            <ContextMenuItem
              variant="destructive"
              onClick={() => setDissolving(true)}
            >
              <IconUsersMinus />
              解散群组…
            </ContextMenuItem>
          ) : group && !canRename ? (
            <ContextMenuItem
              variant="destructive"
              onClick={() => setLeaving(true)}
            >
              <IconLogout />
              退出群组…
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              variant="destructive"
              onClick={() => setConfirming(true)}
            >
              <IconTrash />
              删除会话…
            </ContextMenuItem>
          )}
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
      {dissolving && groupId ? (
        <DissolveRowDialog
          fallbackName={name}
          groupId={groupId}
          onDissolved={isOpen ? () => navigate({ to: "/" }) : undefined}
          onOpenChange={setDissolving}
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
