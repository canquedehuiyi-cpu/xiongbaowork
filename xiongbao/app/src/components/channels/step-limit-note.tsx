import type { TranscriptNote } from "@/components/channels/chat-transcript";

/*
 * 回答末尾那一行「已用完 N 步 · 继续」（期一）：员工这一轮跑满了步数、被强制收尾时，给你一个接着干的按钮。
 * 步数由 `lib/channels/step-limit.ts` 从最后一轮的事件里读出来；这里只管画。
 *
 * 样式不新造：一行浅灰小字取转录里「<员工名> 正在输入」那一行（`chat-transcript.tsx` 的 `Typing`），按钮取
 * 排队消息的「移除」（同一个文件）。两样在深色、浅色里都已经在用。
 */

/** 附注的键：一段对话里最多一行。 */
const KEY = "step-limit";

export function StepLimitNote({
  steps,
  onContinue,
}: {
  steps: number;
  onContinue: () => unknown;
}) {
  return (
    <ContinueLine
      dataAttribute="data-step-limit"
      onContinue={onContinue}
      said={`已用完 ${steps} 步`}
    />
  );
}

/**
 * 一行「<说了什么> · 继续」：期一的步数用完和期九·四的到点、被打断共用，三处是同一个按钮、同一个样子。
 * `dataAttribute` 是各自的标记，测试和脚本按它找到这一行。
 */
export function ContinueLine({
  said,
  onContinue,
  dataAttribute,
}: {
  said: string;
  onContinue: () => unknown;
  dataAttribute: string;
}) {
  return (
    <p
      className="m-0 flex items-center text-[12px] text-[color:var(--wb-muted,var(--muted-foreground))]"
      {...{ [dataAttribute]: "" }}
    >
      <span>{`${said} · `}</span>
      <button
        className="ml-1 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => void onContinue()}
        type="button"
      >
        继续
      </button>
    </p>
  );
}

/**
 * 交进转录的附注：挂在最后一行下面（`anchor: null`），也就是这一轮回答的末尾。最后一轮没触顶、已经按过、
 * 员工正在运行时都不给。
 */
export function stepLimitNotes({
  steps,
  busy,
  onContinue,
}: {
  steps: number | null;
  busy: boolean;
  onContinue?: () => unknown;
}): TranscriptNote[] {
  if (steps === null || busy || onContinue === undefined) return [];
  return [
    {
      key: KEY,
      anchor: null,
      node: <StepLimitNote onContinue={onContinue} steps={steps} />,
    },
  ];
}
