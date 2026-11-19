import { IconLoader2 } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ACP_CARD } from "./acp-cards";

/*
 * 员工的「思考」块（期三）：它这一步在回答或调工具之前想了什么，画在那一步上方。
 *
 * 正在想（这一轮还在跑、它是最后一项）：标题「思考中…」，前面是转圈（和「思考中」那一行同一个，`motion-safe:`
 * 才转），没展开时下面只露最近两行，随推理一段段流进来。想完了（后面有了回答或工具调用，或这一轮结束）：折成
 * 一行「思考了 N 秒」，点开看完整推理。
 *
 * 秒数只说量到的：从这个块在屏幕上开始想、到它想完，是这一页亲眼看到的。刷新后回放的推理一下子全到，没有
 * 逐事件的时间戳（`lib/channels/run-stage.ts` 也是这个口径），量不出来就不编一个数，标题写「思考过程」。
 *
 * 外框取对话里卡片那一套（`acp-cards.tsx` 的 `ACP_CARD`），折叠取工具行的 `<details>`（`tool-line`）。
 */

/** 每一段推理被看见在想的起止（按推理消息的 id）。块会随滚动卸下再装上，所以记在模块里。 */
const timings = new Map<string, { start: number; end?: number }>();

/** 没展开时露出的行数。 */
const PREVIEW_LINES = 2;

/** 想了多久，按人说话的样子：「12 秒」「1 分 5 秒」。不足一秒按一秒说。 */
export function thoughtFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** 推理的最后几行（空行不算），没展开时露出来的那一截。 */
function latestLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-PREVIEW_LINES)
    .join("\n");
}

export function ThinkingBlock({
  id,
  text,
  thinking,
}: {
  /** 推理消息的 id：量时间按它记。 */
  id: string;
  text: string;
  /** 还在想：这一轮还在跑，而且它是最后一项。 */
  thinking: boolean;
}) {
  const [, redraw] = useState(0);
  // 在屏幕上看着它开始想、看着它想完，才记下起止。
  useEffect(() => {
    const known = timings.get(id);
    if (thinking) {
      if (!known) timings.set(id, { start: Date.now() });
      return;
    }
    if (known && known.end === undefined) {
      known.end = Date.now();
      redraw((count) => count + 1);
    }
  }, [id, thinking]);
  const [open, setOpen] = useState(false);
  const timing = timings.get(id);
  const title = thinking
    ? "思考中…"
    : timing?.end !== undefined
      ? `思考了 ${thoughtFor(timing.end - timing.start)}`
      : "思考过程";
  const preview = thinking && !open ? latestLines(text) : "";
  return (
    <div
      className={cn(ACP_CARD, "max-w-none gap-0 py-3 text-[13px]")}
      data-thinking={thinking ? "live" : "done"}
    >
      <details
        className="tool-line min-w-0"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden
            className="tool-line-chevron shrink-0 text-xs transition-transform"
          >
            ▸
          </span>
          {thinking ? (
            <IconLoader2
              aria-hidden="true"
              className="size-[14px] shrink-0 motion-safe:animate-spin"
              data-working-spinner=""
            />
          ) : null}
          <span className={thinking ? "tool-line-running" : undefined}>
            {title}
          </span>
        </summary>
        <p className="m-0 mt-2 whitespace-pre-wrap break-words pl-5 text-muted-foreground leading-relaxed [overflow-wrap:anywhere]">
          {text}
        </p>
      </details>
      {preview ? (
        <p
          className="m-0 mt-2 whitespace-pre-wrap break-words pl-5 text-muted-foreground leading-relaxed [overflow-wrap:anywhere]"
          data-thinking-preview=""
        >
          {preview}
        </p>
      ) : null}
    </div>
  );
}
