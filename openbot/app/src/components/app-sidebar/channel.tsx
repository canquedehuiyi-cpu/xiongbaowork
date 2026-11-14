import { IconPencil, IconPin, IconPinnedOff } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, type ReactNode, useState } from "react";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import { LeaveGroupDialog } from "@/components/channels/leave-group-dialog";
import { RenameConversationDialog } from "@/components/channels/rename-conversation-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { useTypedReveal } from "@/lib/typed-reveal";
import { ChannelItemContent } from "./channel-item-content";
import { DangerItem, DissolveRowDialog } from "./row-danger";

/**
 * One conversation in the sidebar's list: the faces of whoever is in it (two or more stack, which is
 * how a 群聊 reads in the list), the employee's name and the time, then the conversation's title.
 * Memoized: `use-channel-events` preserves unchanged row identity, and `content-visibility` keeps
 * off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin, Rename and Delete ({@link ChannelMenu}). Deleting is confirmed in a dialog
 * that names the channel, because the row it was invoked on is one of several identical-looking rows.
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
  /* Types in only on arrival; an already-named row draws it outright. */
  const revealed = useTypedReveal(summary);
  const threadTitle = revealed.text || untitled || "新会话";
  const title = summary || untitled || "新会话";
  const group = participantIds.length > 1;

  return (
    <ChannelMenu
      canRename={canRename}
      channelId={channelId}
      group={group}
      groupId={groupId}
      name={name}
      pinned={pinned}
      title={summary || untitled || ""}
    >
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
    </ChannelMenu>
  );
});

/**
 * A conversation row's right-click menu and the dialogs it opens: Pin, Rename (offered only to the
 * person who started the conversation, which is who the server lets rename it), and Delete, Leave
 * or Dissolve. `children` is the row itself, the menu's trigger. Shared by the sidebar's row and the
 * default skin's 消息 list, so both pin, rename and delete a conversation the same way.
 */
export function ChannelMenu({
  channelId,
  name,
  title,
  pinned,
  canRename,
  group,
  groupId,
  children,
}: {
  channelId: string;
  name: string;
  /** What the conversation is called, prefilled in the rename dialog. */
  title: string;
  pinned: boolean;
  canRename: boolean;
  /** Two or more Bots: leaving or dissolving instead of deleting. */
  group: boolean;
  /** The group this conversation is the chat of, when it is one the person made. */
  groupId?: string;
  children: ReactNode;
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
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
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
        title={title}
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
}
