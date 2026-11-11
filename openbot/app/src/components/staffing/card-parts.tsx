import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { Badge, GalleryFrame, type Tone } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import { RequestError } from "@/lib/client";
import { guidanceFor } from "@/lib/quota/guidance";
import {
  type Proposal,
  type ProposalStatus,
  useApplyProposal,
  useDiscardProposal,
  useEditProposal,
} from "@/lib/staffing/queries";
import { cn } from "@/lib/utils";

/**
 * 四种卡片共用的零件：外框、状态标签、可折叠的一块、底部按钮和拒绝原因。
 *
 * 外框沿用 `GalleryFrame`（`proposed-bot.tsx` 那张卡片的框），颜色只用主题里的黑白与信号红
 * （`docs/design/ios-studio`）。手机上手指点得准：能按的东西高度都不少于 44px（`h-11`）。
 */

/** 能按的东西的最小点击区：手机上 44px。 */
export const TAP = "h-11 min-w-11 px-4";

const STATUS: Record<ProposalStatus, { label: string; tone: Tone }> = {
  pending: { label: "等你确认", tone: "caution" },
  applying: { label: "正在执行", tone: "neutral" },
  applied: { label: "已完成", tone: "positive" },
  partially_applied: { label: "部分完成", tone: "negative" },
  discarded: { label: "已作废", tone: "neutral" },
  expired: { label: "已过期", tone: "neutral" },
};

/** 作废与过期的卡片变灰、不可操作。 */
export const isClosed = (status: ProposalStatus) =>
  status === "discarded" || status === "expired";

export function CardShell({
  proposalId,
  status,
  title,
  caption,
  children,
}: {
  proposalId: string;
  status: ProposalStatus | null;
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  const closed = status !== null && isClosed(status);
  return (
    <div
      className={cn(closed && "opacity-60 grayscale")}
      data-staffing-proposal={proposalId}
      data-status={status ?? undefined}
    >
      <GalleryFrame
        action={
          status ? (
            <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
          ) : null
        }
        caption={caption}
        title={title}
      >
        {children}
      </GalleryFrame>
    </div>
  );
}

/**
 * 可折叠的一块。用原生的 `details`：键盘、读屏、手机都不用另做，收起时内容仍在页面里，草稿里写了什么
 * 不会因为没展开就看不到（展开就是全文）。
 */
export function Section({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className="group border-border border-t first:border-t-0"
      open={open}
    >
      <summary className="flex min-h-11 cursor-pointer select-none items-center justify-between gap-2 font-medium text-sm marker:content-none">
        {title}
        <span
          aria-hidden="true"
          className="text-muted-foreground transition-transform group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="flex flex-col gap-3 pb-3">{children}</div>
    </details>
  );
}

/**
 * 按钮没做成时的原因。名额满（402）说套餐和用量，并给升级入口；其余照服务端的原话说——内容已变化、
 * 已过期、没有权限，服务端的句子已经是给本人看的中文。
 */
export function ActionProblem({ error }: { error: unknown }) {
  if (error instanceof RequestError && error.status === 402 && error.quota) {
    const guidance = guidanceFor(error.quota);
    return (
      <div className="flex flex-col gap-1 text-sm" role="alert">
        <p className="font-medium text-destructive">{guidance.sentence}</p>
        <p className="text-muted-foreground">{guidance.hint}</p>
        <UpgradeLink />
      </div>
    );
  }
  const message =
    error instanceof Error ? error.message : "这一步没有做成，请稍后再试。";
  return (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}

export function UpgradeLink() {
  return (
    <Link
      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
      to="/settings/plans"
    >
      升级套餐
    </Link>
  );
}

/** 底部的两个按钮：作废在左、确认在右；按下其中一个时两个都不能再按，免得连点。 */
export function DecisionButtons({
  confirmLabel,
  busy,
  confirmBlocked = false,
  onConfirm,
  onDiscard,
}: {
  confirmLabel: string;
  busy: "confirm" | "discard" | null;
  /** 名额已满之类：确认不可按，作废仍然可以。 */
  confirmBlocked?: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        className={TAP}
        disabled={busy !== null}
        onClick={onDiscard}
        variant="outline"
      >
        {busy === "discard" ? "正在作废…" : "作废"}
      </Button>
      <Button
        className={TAP}
        disabled={busy !== null || confirmBlocked}
        onClick={onConfirm}
      >
        {busy === "confirm" ? "正在执行…" : confirmLabel}
      </Button>
    </div>
  );
}

/** 作废、过期的卡片：只说结论，不再有可按的东西。 */
export function ClosedNote({ status }: { status: ProposalStatus }) {
  return (
    <p className="text-muted-foreground text-sm">
      {status === "expired"
        ? "这份提议 7 天没有确认，已经过期，什么都没有执行。"
        : "这份提议已作废，什么都没有执行。"}
    </p>
  );
}

/**
 * 确认与作废的流程。改过草稿就先存（PATCH）再执行（apply）：服务端执行的是它存着的那份，没存的改动不算数。
 * 按下之后到有答复之前不接受第二次，连点只执行一次（服务端也只认一次）。
 */
export function useDecision(proposalId: string) {
  const edit = useEditProposal(proposalId);
  const apply = useApplyProposal(proposalId);
  const discardIt = useDiscardProposal(proposalId);
  const [busy, setBusy] = useState<"confirm" | "discard" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pressed = useRef(false);

  const run = async (
    which: "confirm" | "discard",
    work: () => Promise<void>,
  ) => {
    if (pressed.current) return;
    pressed.current = true;
    setBusy(which);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause);
    } finally {
      pressed.current = false;
      setBusy(null);
    }
  };

  return {
    busy,
    error,
    confirm: (edited: Proposal["draft"] | null) =>
      run("confirm", async () => {
        if (edited) await edit.mutateAsync(edited);
        await apply.mutateAsync();
      }),
    discard: () =>
      run("discard", async () => {
        await discardIt.mutateAsync();
      }),
  };
}
