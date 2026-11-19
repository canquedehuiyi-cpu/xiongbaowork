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
import {
  accountModePreview,
  setAccountModeMutationOptions,
} from "@/lib/plugins/mutations";
import { describeApproval } from "@/lib/plugins/shared-use";

/**
 * The one moment an administrator decides between people's own accounts and one shared account.
 *
 * WHAT GOES IS NAMED BEFORE THE BUTTON, from the server's own dry run, so the count on screen is the
 * count that will be revoked — and each Bot's approval is listed as it will be written, because that
 * is the decision being made on their behalf, not a detail of it.
 */
export function AccountModeDialog({
  serverId,
  title,
  target,
  open,
  onOpenChange,
  names = {},
}: {
  serverId: string;
  title: string;
  target: "personal" | "shared";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  names?: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  /**
   * Kept out of the `["plugins", …]` family on purpose. `invalidatePlugins` — which every plugin
   * write, including the switch below, runs `onSettled` — invalidates by that prefix, and this
   * dialog stays mounted and enabled through its own confirm. Sharing the prefix would have the
   * switch's own settle re-fire this dry run a moment after the real write, so the last request the
   * dialog sent would read as a second preview rather than the switch that just happened.
   */
  const preview = useQuery({
    queryKey: ["account-mode", serverId, target],
    queryFn: () => accountModePreview(serverId, target),
    enabled: open,
  });
  const change = useMutation({
    ...setAccountModeMutationOptions(queryClient),
    onSuccess: () => onOpenChange(false),
  });
  const count = preview.data?.wouldRevoke.count ?? 0;
  const goes =
    preview.data?.wouldRevoke.holder === "deployment"
      ? count > 0
        ? "团队账号会被断开。"
        : "现在没有连接团队账号。"
      : `${count} 个个人账号会被断开。`;
  const action =
    target === "shared"
      ? `把 ${title} 改成团队账号`
      : `把 ${title} 改成个人账号`;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target === "shared"
              ? `所有人共用一个 ${title} 团队账号？`
              : `让每个人用自己的 ${title} 账号？`}
          </DialogTitle>
          <DialogDescription>
            {preview.data ? goes : "正在查看这会改变什么…"}
          </DialogDescription>
        </DialogHeader>
        {target === "shared" ? (
          <div className="mt-4 space-y-3 text-sm">
            <p>
              用到这个应用的员工，不管谁在用，都会以这一个账号行事。下面是每位员工切换后会被批准的使用范围。
            </p>
            {preview.data?.bots.length ? (
              <ul className="space-y-1">
                {preview.data.bots.map((bot) => (
                  <li key={bot.botId}>
                    <span className="font-medium">
                      {names[bot.botId] ?? bot.botId}
                    </span>
                    : {describeApproval(bot.exposure)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {preview.error || change.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {(change.error ?? preview.error)?.message}
          </p>
        ) : null}
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            取消
          </Button>
          <Button
            disabled={!preview.data || change.isPending}
            onClick={() =>
              change.mutate({
                serverId,
                mode: target,
                /*
                 * 熊宝要多做的一步（X7）：切到团队账号时，服务端不会自己给员工记共享使用批准，所以把预览里
                 * 每位员工现在的使用范围原样作为批准送回；不送，切换后这些员工对团队账号的调用会被拒绝。
                 */
                ...(target === "shared" && preview.data?.bots.length
                  ? {
                      approvals: Object.fromEntries(
                        preview.data.bots.map((bot) => [
                          bot.botId,
                          bot.exposure,
                        ]),
                      ),
                    }
                  : {}),
              })
            }
            size="sm"
            variant="destructive"
          >
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
