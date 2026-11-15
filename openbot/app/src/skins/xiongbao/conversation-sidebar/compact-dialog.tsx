import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type CompactOutcome,
  compactConversation,
  formatTokens,
  invalidateConversationSidebar,
  type SidebarSource,
} from "@/lib/threads/sidebar";
import { cn } from "@/lib/utils";
import type {
  CompactionEstimate,
  ContextUsage,
} from "../../../../../shared/conversation-sidebar";

/**
 * 「压缩会话」按钮和确认弹窗（设计稿「压缩会话」）：把较早的消息总结成一段，最近 10 条不动，原来的消息
 * 照样留在对话里。
 *
 * 弹窗里写「较早的 N 条」和「压缩前 X → 预计压缩后 约 Y」，都是服务器按线程里的消息字数估的
 * （`compactionEstimate`：非消息部分不变，消息只剩保留的 10 条，加新摘要的预计长度）；压完换成服务器报的实数。
 * 没有预估（读不到线程）时不编，写「压完才知道」。
 *
 * 外部员工、远程员工（`managedBy`）的上下文由它们自己管，调用的人不画这个按钮。
 */

const BUTTON =
  "inline-flex min-h-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border border-(--wb-line2) bg-(--wb-card2) px-3 text-(--wb-fg) text-[12.5px] outline-none transition-colors hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-accent) disabled:cursor-default disabled:opacity-60";
const DIALOG_BUTTON =
  "inline-flex min-h-10 cursor-pointer items-center justify-center rounded-[10px] px-4 text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-(--wb-accent) disabled:cursor-default disabled:opacity-60";

const REFUSED: Record<
  Extract<CompactOutcome, { status: "refused" }>["reason"],
  string
> = {
  in_progress: "正在压缩，稍等一会儿再看。",
  too_short: "这段对话还不长，没有可以压缩的较早消息。",
  external: "这位员工自己管理上下文，不能在这里压缩。",
  failed: "这次没压成，稍后再试一次。",
  missing: "找不到这个对话了。",
};

type Phase =
  | { step: "confirm" }
  | { step: "working" }
  | { step: "done"; tokensBefore: number | null; tokensAfter: number | null }
  | { step: "refused"; reason: keyof typeof REFUSED };

export function CompactButton({
  source,
  agentId,
  name,
  usage,
  estimate,
  large = false,
}: {
  source: SidebarSource;
  /** 压哪位员工的上下文；单聊不给时服务器取对话里那一位。 */
  agentId?: string;
  /** 员工名，「产品官仍然记得要点」；不知道时写「员工」。 */
  name?: string;
  usage: ContextUsage;
  /** 服务器的预估；没有时为 null。 */
  estimate: CompactionEstimate | null;
  /** 手机上按钮大一些，好点。 */
  large?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={cn(
          BUTTON,
          "ml-auto",
          large && "min-h-10 px-3.5 text-[13px]",
        )}
        onClick={() => setOpen(true)}
        type="button"
      >
        压缩会话
      </button>
      {open ? (
        <CompactDialog
          agentId={agentId}
          estimate={estimate}
          name={name}
          onClose={() => setOpen(false)}
          source={source}
          usage={usage}
        />
      ) : null}
    </>
  );
}

function CompactDialog({
  source,
  agentId,
  name,
  usage,
  estimate,
  onClose,
}: {
  source: SidebarSource;
  agentId?: string;
  name?: string;
  usage: ContextUsage;
  estimate: CompactionEstimate | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ step: "confirm" });
  const who = name ?? "员工";
  const earlier = estimate?.summarizable ?? null;
  const nothingYet = earlier === 0;

  const compact = async () => {
    setPhase({ step: "working" });
    const outcome = await compactConversation(source, agentId);
    if (outcome.status === "compacted") {
      setPhase({
        step: "done",
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
      });
      // 侧栏的用量、员工行下的「已压缩」、对话里的分隔线都从侧栏的数据来：马上再读。
      void invalidateConversationSidebar(queryClient, source);
    } else {
      setPhase({ step: "refused", reason: outcome.reason });
    }
  };

  const done = phase.step === "done";
  const before = done ? (phase.tokensBefore ?? usage.used) : usage.used;
  let after: string;
  if (done)
    after = phase.tokensAfter === null ? "—" : formatTokens(phase.tokensAfter);
  else
    after =
      estimate === null
        ? "压完才知道"
        : `约 ${formatTokens(estimate.estimatedAfter)}`;

  let sentence: string;
  if (done) sentence = "已压缩。较早的消息总结成了一段，原来的消息还在对话里。";
  else if (nothingYet) sentence = REFUSED.too_short;
  else
    sentence = `把较早的${
      earlier === null ? "" : ` ${earlier} 条`
    }消息总结成一段，${who}仍然记得要点。原来的消息照样留在对话里，随时可以往上翻。`;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && phase.step !== "working") onClose();
      }}
      open
    >
      <DialogContent
        className="max-w-[504px] gap-3 rounded-[16px] border-(--wb-line2) bg-(--wb-card) p-[22px] text-(--wb-fg)"
        showCloseButton={false}
      >
        <DialogTitle className="m-0 font-semibold text-(--wb-fg) text-[18px]">
          压缩这段对话？
        </DialogTitle>
        <DialogDescription className="m-0 text-(--wb-fg2) text-[14px] leading-[1.7]">
          {sentence}
        </DialogDescription>
        <div
          className="flex flex-wrap items-center gap-2.5 text-(--wb-fg2) text-[13px]"
          data-compact-numbers=""
          data-compacted={done ? "" : undefined}
        >
          <span>压缩前</span>
          <b className="font-semibold text-(--wb-fg) tabular-nums">
            {before === null ? "—" : formatTokens(before)}
          </b>
          <span aria-hidden="true">→</span>
          <span>{done ? "压缩后" : "预计压缩后"}</span>
          <b className="font-semibold text-(--wb-green-fg) tabular-nums">
            {after}
          </b>
        </div>
        {phase.step === "refused" ? (
          <p className="m-0 text-(--wb-amber-fg) text-[13px]" role="alert">
            {REFUSED[phase.reason]}
          </p>
        ) : null}
        <div className="flex justify-end gap-2.5">
          {done ? (
            <button
              className={cn(
                DIALOG_BUTTON,
                "border-0 bg-(image:--wb-me) font-semibold text-(--wb-me-fg)",
              )}
              onClick={onClose}
              type="button"
            >
              完成
            </button>
          ) : (
            <>
              <button
                className={cn(
                  DIALOG_BUTTON,
                  "border border-(--wb-line2) bg-(--wb-card2) text-(--wb-fg) hover:bg-(--wb-hover)",
                )}
                disabled={phase.step === "working"}
                onClick={onClose}
                type="button"
              >
                取消
              </button>
              <button
                className={cn(
                  DIALOG_BUTTON,
                  "border-0 bg-(image:--wb-me) px-[18px] font-semibold text-(--wb-me-fg)",
                )}
                disabled={phase.step === "working" || nothingYet}
                onClick={() => void compact()}
                type="button"
              >
                {phase.step === "working" ? "正在压缩…" : "压缩"}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
