import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pipelineTemplatesQueryOptions } from "@/lib/pipelines/queries";
import { retireCrewMutationOptions } from "@/lib/waker-groups/mutations";

type Crew = { id: string; name: string };

/**
 * What dissolving a group takes with it, counted from the flows it owns. The one place the words
 * live, so the employees card, the settings drawer and the sidebar row's menu cannot drift apart.
 *
 * Three states. While the count is loading it says so and `counting` holds the confirm button back;
 * if the count fails the sentence is simply said without a number and the dissolve is still allowed;
 * once loaded the number is in it.
 */
export function useDissolveCopy(crew: Crew, active: boolean) {
  // Only read when the question is asked: how many flows go with the group.
  const pipelines = useQuery({
    ...pipelineTemplatesQueryOptions(),
    enabled: active,
  });
  const counting = active && pipelines.isPending;
  const count = pipelines.data?.filter(
    (template) => template.groupId === crew.id,
  ).length;
  return {
    counting,
    copy: counting
      ? "正在统计…"
      : `解散「${crew.name}」：聊天记录不再显示；它的${
          count === undefined ? "" : ` ${count} 条`
        }组团流程和运行记录会一并删除；看板上已有的任务卡保留。`,
  };
}

/**
 * The confirmation behind every 「解散群组」 that is not on the employees card: ask once, then retire
 * the group. `onDissolved` runs after the server has said yes; a refusal is shown in the dialog.
 */
export function DissolveCrewDialog({
  crew,
  open,
  onOpenChange,
  onDissolved,
}: {
  crew: Crew;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDissolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const retire = useMutation(retireCrewMutationOptions(queryClient));
  const { counting, copy } = useDissolveCopy(crew, open);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>解散群组</DialogTitle>
          <DialogDescription>{copy}</DialogDescription>
        </DialogHeader>
        {retire.error ? (
          <p className="text-destructive text-sm" role="alert">
            {retire.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            取消
          </Button>
          <Button
            disabled={retire.isPending || counting}
            onClick={() =>
              retire.mutate(crew.id, {
                onSuccess: () => {
                  onOpenChange(false);
                  onDissolved?.();
                },
              })
            }
            variant="destructive"
          >
            确认解散「{crew.name}」
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
