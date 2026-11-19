import type { TranscriptNote } from "@/components/channels/chat-transcript";
import { ContinueLine } from "@/components/channels/step-limit-note";
import { type TurnStop, turnStopWords } from "@/lib/channels/turn-notice";

/*
 * 回答末尾那一行「到 25 分钟了 · 继续」「步数用完了 · 继续」「这一轮被打断了 · 继续」（期九·四）：服务器上跑着的
 * 一轮到点、用完工具轮数、或进程中途没了而停下时，给你一个接着干的按钮。样子和期一的「已用完 N 步 · 继续」是同一
 * 个（`ContinueLine`）；停在哪由 `lib/channels/turn-notice.ts` 从最后一轮的事件里读出来，这里只管画。
 */

/** 附注的键：一段对话里最多一行。 */
const KEY = "turn-stop";

export function TurnStopNote({
  stop,
  onContinue,
}: {
  stop: TurnStop;
  onContinue: () => unknown;
}) {
  return (
    <ContinueLine
      dataAttribute="data-turn-stop"
      onContinue={onContinue}
      said={turnStopWords(stop)}
    />
  );
}

/**
 * 交进转录的附注：挂在最后一行下面（`anchor: null`），也就是这一轮回答的末尾。最后一轮没停、已经按过、
 * 员工正在运行时都不给。
 */
export function turnStopNotes({
  stop,
  busy,
  onContinue,
}: {
  stop: TurnStop | null;
  busy: boolean;
  onContinue?: () => unknown;
}): TranscriptNote[] {
  if (stop === null || busy || onContinue === undefined) return [];
  return [
    {
      key: KEY,
      anchor: null,
      node: <TurnStopNote onContinue={onContinue} stop={stop} />,
    },
  ];
}
