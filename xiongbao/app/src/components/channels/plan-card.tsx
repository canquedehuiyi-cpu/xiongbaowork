import { IconCheck, IconCircle, IconLoader2 } from "@tabler/icons-react";
import { useState } from "react";
import { ACP_CARD } from "@/components/channels/acp-cards";
import type { PlanItem } from "@/lib/channels/plan";
import { cn } from "@/lib/utils";

/*
 * 钉在对话区顶部的计划清单（期二）。外框取对话里卡片的那一套（`acp-cards.tsx` 的 `ACP_CARD`），折叠取工具行的
 * `<details>`（`tool-line` 让「▸」展开时转过来），图标取 tabler：没开始是空心圈，正在做是工具行那个
 * `IconLoader2`（`motion-safe:` 才转），做完是勾，文字变淡。
 *
 * 还有没做完的就展开；全部做完默认折成一行「计划 · 已全部完成 N 项」。人自己点开、点合以后照人的来，直到清单
 * 从「没做完」变成「全做完」或者反过来，再回到默认。
 */

const ICON = "size-[14px] shrink-0";

function StatusIcon({ status }: { status: PlanItem["status"] }) {
  if (status === "done")
    return (
      <IconCheck
        aria-hidden="true"
        className={cn(ICON, "text-faint")}
        data-plan-icon="done"
      />
    );
  if (status === "in_progress")
    return (
      <IconLoader2
        aria-hidden="true"
        className={cn(ICON, "text-muted-foreground motion-safe:animate-spin")}
        data-plan-icon="in_progress"
      />
    );
  return (
    <IconCircle
      aria-hidden="true"
      className={cn(ICON, "text-muted-foreground")}
      data-plan-icon="pending"
    />
  );
}

/** 读屏念的状态：图标只是装饰。 */
const STATUS_WORD: Record<PlanItem["status"], string> = {
  pending: "未开始",
  in_progress: "进行中",
  done: "已完成",
};

export function PlanCard({
  items,
  name,
}: {
  items: readonly PlanItem[];
  /** 群聊里是谁的计划：卡上带员工名。单聊不给。 */
  name?: string;
}) {
  const done = items.filter((item) => item.status === "done").length;
  const allDone = items.length > 0 && done === items.length;
  /*
   * 人自己点开、点合的那一下，记下当时清单做没做完；做完与没做完之间换了一次，这一下就不算了，回到默认（没做完
   * 展开、做完折起）。
   */
  const [chosen, setChosen] = useState<{
    allDone: boolean;
    open: boolean;
  } | null>(null);
  const open =
    chosen !== null && chosen.allDone === allDone ? chosen.open : !allDone;
  const title = allDone
    ? `计划 · 已全部完成 ${items.length} 项`
    : `计划 · 完成 ${done}/${items.length}`;
  return (
    <details
      className={cn(ACP_CARD, "tool-line max-w-none gap-0 py-3")}
      data-plan-card=""
      onToggle={(event) => {
        const now = event.currentTarget.open;
        if (now !== open) setChosen({ allDone, open: now });
      }}
      open={open}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 text-[13px]">
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-muted-foreground text-xs transition-transform"
        >
          ▸
        </span>
        {name ? (
          <span className="min-w-0 shrink truncate font-medium">{name}</span>
        ) : null}
        {name ? (
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
        ) : null}
        <span className="shrink-0 font-medium">{title}</span>
      </summary>
      <ol className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 pl-5 text-[13px]">
        {items.map((item, index) => (
          <li
            className="flex min-w-0 items-start gap-2"
            data-plan-status={item.status}
            // 同一份清单里文字可以重复，按位置认。
            // biome-ignore lint/suspicious/noArrayIndexKey: 清单按位置画，项没有自己的 id。
            key={index}
          >
            <span className="mt-[3px] flex shrink-0">
              <StatusIcon status={item.status} />
            </span>
            <span
              className={cn(
                "min-w-0 break-words [overflow-wrap:anywhere]",
                item.status === "done" && "text-muted-foreground",
              )}
            >
              {item.text}
            </span>
            <span className="sr-only">{STATUS_WORD[item.status]}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
