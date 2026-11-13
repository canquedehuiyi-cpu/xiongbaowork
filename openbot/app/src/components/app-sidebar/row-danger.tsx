import {
  IconLoader2,
  IconLogout,
  IconTrash,
  IconUsersMinus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DissolveCrewDialog } from "@/components/wakers/dissolve-crew";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

/** What a conversation row's last, destructive action is. */
export type RowDanger =
  | { kind: "pending" }
  | { kind: "dissolve"; groupId: string }
  | { kind: "leave" }
  | { kind: "delete" };

/**
 * Which destructive action a conversation row offers, shared by the sidebar and the skins' lists.
 *
 * That depends on whether the chat is a group's the person made, which is read from the groups
 * list. Call this only from something that mounts when the menu opens (or, for a list that is
 * drawn at once, when the list is), so a roster whose menus are never opened asks for nothing.
 * Each mount asks again and `pending` stands until the answer is in: the list is kept fresh for 30s
 * elsewhere, and a stale one would offer 删除 for a chat that is a group's, orphaning the group.
 * If the read fails, a multi-employee chat falls back to what the row knew: not mine to rename →
 * leave, mine → delete.
 */
export function useRowDanger({
  canRename,
  channelId,
  group,
  groupId,
}: {
  canRename: boolean;
  channelId: string;
  /** Whether the chat has two or more Bots. */
  group: boolean;
  /** The group this chat belongs to, when the row already knows it. */
  groupId?: string;
}): RowDanger {
  const groups = useQuery({
    ...wakerGroupsQueryOptions(),
    enabled: group,
    refetchOnMount: "always",
  });
  if (group && (groups.isPending || groups.isFetching))
    return { kind: "pending" };
  const linked =
    groupId ?? groups.data?.find((entry) => entry.channelId === channelId)?.id;
  if (linked) return { kind: "dissolve", groupId: linked };
  if (group && !canRename) return { kind: "leave" };
  return { kind: "delete" };
}

/**
 * 解散群组 from a row: the same confirmation as the settings drawer's, which needs the group's name.
 * Mounted only once asked, so the list's many rows do not each read the groups.
 */
export function DissolveRowDialog({
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

/** The menu's last item; see `useRowDanger` for how it is chosen. */
export function DangerItem({
  canRename,
  channelId,
  deleteLabel = "删除会话…",
  group,
  groupId,
  onDelete,
  onDissolve,
  onLeave,
}: {
  canRename: boolean;
  channelId: string;
  /** What the plain delete says; a skin keeps its own word for it. */
  deleteLabel?: string;
  group: boolean;
  groupId?: string;
  onDelete: () => void;
  onDissolve: (groupId: string) => void;
  onLeave: () => void;
}) {
  const danger = useRowDanger({ canRename, channelId, group, groupId });
  if (danger.kind === "pending")
    return (
      <ContextMenuItem disabled>
        <IconLoader2 />
        正在读取…
      </ContextMenuItem>
    );
  if (danger.kind === "dissolve")
    return (
      <ContextMenuItem
        variant="destructive"
        onClick={() => onDissolve(danger.groupId)}
      >
        <IconUsersMinus />
        解散群组…
      </ContextMenuItem>
    );
  if (danger.kind === "leave")
    return (
      <ContextMenuItem variant="destructive" onClick={onLeave}>
        <IconLogout />
        退出群组…
      </ContextMenuItem>
    );
  return (
    <ContextMenuItem variant="destructive" onClick={onDelete}>
      <IconTrash />
      {deleteLabel}
    </ContextMenuItem>
  );
}
