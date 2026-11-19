import { useQuery } from "@tanstack/react-query";
import {
  ACP_CARD,
  ACP_PRIMARY_BUTTON,
  ACP_SECONDARY_BUTTON,
} from "@/components/channels/acp-cards";
import type { ApprovalRequestData } from "@/lib/approvals";
import { channelQueryOptions } from "@/lib/channels/queries";
import { cn } from "@/lib/utils";

/*
 * 「分享到群」检查（服务器 `proactive/private-share.ts`）在审批列表里的样子：员工要把一段可能来自你私人对话或
 * 记忆的内容发给别人（一个群、一个频道、别人的员工），先问你。所有员工都走这一条，不只外部员工。
 *
 * 用一句话说清要发到哪里、为什么问你，加上要发的那段话，按钮只有批准和拒绝；不露出动作的内部名字，也不贴参数。
 */

/** 这条审批是不是「分享到群」检查（按它的效果认，不按内部名字认）。 */
export function isShareApproval(action: { effect: string }): boolean {
  return action.effect === "share_private";
}

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;

export function ShareApprovalCard({
  request,
  botName,
  submitting,
  error,
  onDecide,
}: {
  request: ApprovalRequestData;
  botName: string;
  submitting: boolean;
  error: string | null;
  onDecide: (choice: "allow_once" | "deny") => void;
}) {
  const target = record(request.action.target);
  const args = record(request.action.args);
  const groupId =
    target?.kind === "group" && typeof target.id === "string"
      ? target.id
      : null;
  const group = useQuery({
    ...channelQueryOptions(groupId ?? ""),
    enabled: groupId !== null,
    retry: false,
  });
  const where = groupId
    ? `群「${group.data?.name ?? "这个群"}」`
    : typeof args?.audience === "string" && args.audience
      ? args.audience
      : "别人";
  const preview = typeof args?.preview === "string" ? args.preview : "";
  return (
    <section
      aria-label="分享到群"
      className={cn(
        ACP_CARD,
        "max-w-none gap-3 border-[color:color-mix(in_oklab,var(--wb-amber,var(--signal))_45%,transparent)]",
      )}
      data-share-approval=""
    >
      <b className="font-semibold">
        {botName}想把回答发到{where}，里面可能有你的私人信息
      </b>
      {preview ? (
        <blockquote className="m-0 whitespace-pre-wrap break-words rounded-[var(--wb-radius-sm,9px)] bg-[color:var(--wb-rail,var(--muted))] px-3 py-2.5 text-[13px] leading-relaxed text-[color:var(--wb-fg2,var(--muted-foreground))]">
          {preview}
        </blockquote>
      ) : null}
      <span className="text-[13px] text-[color:var(--wb-fg2,var(--muted-foreground))]">
        批准之前，群里的其他人看不到这段话。
      </span>
      <div className="flex flex-wrap gap-2.5">
        <button
          className={ACP_PRIMARY_BUTTON}
          disabled={submitting}
          onClick={() => onDecide("allow_once")}
          type="button"
        >
          批准
        </button>
        <button
          className={ACP_SECONDARY_BUTTON}
          disabled={submitting}
          onClick={() => onDecide("deny")}
          type="button"
        >
          拒绝
        </button>
      </div>
      {error ? (
        <p
          className="m-0 text-[13px] text-[color:var(--wb-amber-fg,var(--signal-ink))]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
