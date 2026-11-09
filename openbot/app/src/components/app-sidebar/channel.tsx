import {
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { useTypedReveal } from "@/lib/typed-reveal";

/** The row's first line: the conversation's title, or the employee's name under that emphasis. */
const PRIMARY_TEXT = "font-semibold text-[13px] leading-5";
/** What the second line leads with. */
const SECONDARY_TEXT = "text-muted-foreground";

/**
 * One conversation in the workspace column (description (1) of the parity brief): the title in bold,
 * then 「聊天 | time」, the open one on the sidebar's grey. Memoized: `use-channel-events` preserves
 * unchanged row identity, and `content-visibility` keeps off-screen rows cheap without
 * virtualization.
 *
 * Right-click opens Pin and Delete. Deleting is confirmed in a dialog that names the channel,
 * because the row it was invoked on is one of several identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  summary,
  untitled,
  lastMessageAt,
  pinned,
  unread,
  busy,
  emphasis,
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
  unread: boolean;
  busy: boolean;
  emphasis: MessageListEmphasis;
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  const threadTitle = revealed.text || lastMessage || "新会话";
  const title = summary || lastMessage || "新会话";
  const group = participantIds.length > 1;
=======
  const threadTitle = revealed.text || untitled || "New conversation";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            className="flex w-full flex-row items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-foreground/5 [contain-intrinsic-size:auto_3rem] [content-visibility:auto]"
=======
            className="flex flex-row py-2 px-2.5 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
            activeProps={{
              className: "bg-sidebar",
            }}
          >
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`min-w-0 flex-1 truncate ${PRIMARY_TEXT}`}
                  title={emphasis === "agent" ? name : title}
                >
                  {emphasis === "agent" ? name : threadTitle}
                  {emphasis !== "agent" && revealed.typing ? (
                    <span className="ml-0.5 inline-block h-3 w-px translate-y-px bg-foreground/70 align-middle" />
                  ) : null}
                </span>
                {pinned ? (
                  <IconPinFilled
                    aria-label="已置顶"
                    className="size-3 shrink-0 text-muted-foreground/70"
                  />
                ) : null}
                {unread ? (
                  <span className="size-2 shrink-0 rounded-full bg-primary">
                    <span className="sr-only">未读</span>
                  </span>
                ) : null}
              </div>
              {/*
               * The reference's second line, 「聊天 | 10月6日 00:56」. With the 员工名字 emphasis the
               * name takes the first line, so the title moves down here in place of the kind.
               */}
              <div className="mt-px flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground leading-4">
                <span className={`min-w-0 truncate ${SECONDARY_TEXT}`}>
                  {emphasis === "agent" ? threadTitle : group ? "群聊" : "聊天"}
                </span>
                {lastMessageAt ? (
                  <span className="shrink-0 whitespace-nowrap">
                    {` | ${lastMessageAt}`}
                  </span>
                ) : null}
              </div>
            </div>
            {busy ? (
              <span className="flex shrink-0 items-center gap-0.5">
                <span className="sr-only">处理中…</span>
                <span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                <span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                <span className="size-1 animate-bounce rounded-full bg-primary" />
              </span>
            ) : null}
=======
            <ChannelItemContent
              participantIds={participantIds}
              name={name}
              title={summary || untitled || "New conversation"}
              displayedTitle={threadTitle}
              lastMessageAt={lastMessageAt}
              emphasis={emphasis}
              busy={busy}
              unread={unread}
              pinned={pinned}
              revealing={revealed.typing}
            />
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            {pinned ? "取消置顶" : "置顶会话"}
=======
            {pinned ? "Unpin conversation" : "Pin conversation"}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            <IconTrash />
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            删除会话…
=======
            Delete conversation…
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <DeleteConversationDialog
        channelId={channelId}
        // Away first when this row's channel is the one on screen.
        leave={isOpen ? () => navigate({ to: "/" }) : undefined}
        name={name}
        onOpenChange={setConfirming}
        open={confirming}
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除「{name}」？</DialogTitle>
            <DialogDescription>
              会话里的所有人都将不再看到这段会话。
            </DialogDescription>
          </DialogHeader>
          {deleteChannel.error ? (
            <p className="text-destructive text-sm">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="destructive"
            >
              {deleteChannel.isPending ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
=======
      />
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    </>
  );
});
