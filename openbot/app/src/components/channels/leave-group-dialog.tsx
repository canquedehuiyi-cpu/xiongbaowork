import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { removeGroupMemberMutationOptions } from "@/lib/groups";

/**
 * Confirms leaving a group chat that somebody else started, from the sidebar row's menu. Leaving is
 * the person taking themselves out of the chat's membership; the server's refusal (a flow still
 * running, say) is shown as it was sent. `leave` runs once the server has said yes, when the chat is
 * the one on screen.
 */
export function LeaveGroupDialog({
  channelId,
  leave,
  name,
  onOpenChange,
  open,
}: {
  channelId: string;
  leave?: () => unknown;
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const { reset } = remove;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>退出「{name}」？</DialogTitle>
          <DialogDescription>
            退出后你不会再看到这个群组，群里的其他人不受影响。
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <p className="text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            取消
          </Button>
          <Button
            disabled={remove.isPending || !me}
            onClick={() =>
              remove.mutate(me?.id ?? "", {
                onSuccess: () => {
                  onOpenChange(false);
                  leave?.();
                },
              })
            }
            size="sm"
            variant="destructive"
          >
            确认退出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
