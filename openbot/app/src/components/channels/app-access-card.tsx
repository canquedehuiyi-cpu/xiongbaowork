import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  accessRequestKeys,
  accessRequestQueryOptions,
  cancelAccessRequest,
} from "@/lib/plugins/access-requests";
import { asText } from "@/lib/plugins/tool-result";
import {
  type AppAccessRequestCard as Card,
  REQUEST_APP_ACCESS_TOOL,
  readAppAccessRequestAnswer,
} from "../../../../shared/app-access-request";

/**
 * `request_app_access` 的回答里的卡片，不是这个工具或不是卡片时为 null。
 *
 * 运行时把工具的字符串编码成 JSON 带进消息，所以先用 {@link asText} 解开，再读标记。
 */
export function readAppAccessCard(
  name: string,
  result: string | undefined,
): { card: Card } | null {
  if (name !== REQUEST_APP_ACCESS_TOOL || result === undefined) return null;
  const read = readAppAccessRequestAnswer(asText(result));
  return read ? { card: read.card } : null;
}

const ANSWERED: Record<"approved" | "dismissed" | "cancelled", string> = {
  approved: "管理员已批准",
  dismissed: "管理员已驳回",
  cancelled: "申请已撤回",
};

/**
 * 对话里的「申请访问」卡片：应用名，以及「已向管理员申请访问」或「已有待处理的申请」。
 *
 * 画出来时向服务端读这条申请现在的状态，而不是只信工具回答里写的：申请人读得到，就显示处理结果，还在等
 * 时给一个「撤回申请」按钮；别人看这段对话时读不到这条申请，卡片照样显示，但没有按钮。
 */
export function AppAccessRequestCard({ card }: { card: Card }) {
  const cache = useQueryClient();
  const live = useQuery(accessRequestQueryOptions(card.requestId));
  const cancel = useMutation({
    mutationFn: () => cancelAccessRequest(card.requestId),
    onSettled: () =>
      cache.invalidateQueries({
        queryKey: accessRequestKeys.one(card.requestId),
      }),
  });
  const status = live.data?.status;
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
      data-app-access-request={card.requestId}
    >
      <p className="font-medium">{card.title}</p>
      <p className="text-muted-foreground">
        {card.status === "created" ? "已向管理员申请访问" : "已有待处理的申请"}
      </p>
      {status && status !== "pending" ? (
        <p role="status">{ANSWERED[status]}</p>
      ) : null}
      {status === "approved" && card.kind === "enable" ? (
        // 上架之后还要员工的主人自己装（D08），批准不等于马上能用。
        <p className="text-muted-foreground">
          应用已上架，员工的主人在装配页安装后即可使用。
        </p>
      ) : null}
      {status === "pending" ? (
        <div>
          <Button
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            size="sm"
            variant="outline"
          >
            撤回申请
          </Button>
        </div>
      ) : null}
      {cancel.error ? (
        <p className="text-destructive" role="alert">
          {cancel.error.message}
        </p>
      ) : null}
    </div>
  );
}
