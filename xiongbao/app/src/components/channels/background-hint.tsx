import type { TranscriptNote } from "@/components/channels/chat-transcript";
import { BACKGROUND_HINT } from "@/lib/channels/background-run";

/*
 * 第一次在后台跑时，回答下方的一行提示「可以关掉页面，跑完会通知你」（期九·四）。样式不新造：和「已用完 N 步 ·
 * 继续」是同一种浅灰小字（`step-limit-note.tsx`）。要不要画由 `useBackgroundHint` 说了算——第一次出现就记在本机，
 * 之后不再出现；这里只管画。
 */

/** 附注的键：一段对话里最多一行。 */
const KEY = "background-hint";

export function BackgroundHint() {
  return (
    <p
      className="m-0 text-[12px] text-[color:var(--wb-muted,var(--muted-foreground))]"
      data-background-hint=""
    >
      {BACKGROUND_HINT}
    </p>
  );
}

/** 交进转录的附注：挂在最后一行下面（`anchor: null`），也就是这一轮回答的下方。 */
export function backgroundHintNotes(shown: boolean): TranscriptNote[] {
  return shown ? [{ key: KEY, anchor: null, node: <BackgroundHint /> }] : [];
}
