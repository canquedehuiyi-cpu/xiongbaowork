import { useRef, useState } from "react";
import { useComputerControl } from "@/lib/computers/use-control";
import { ComputerControlButton } from "./computer-controls";
import { LiveTerminal, type LiveTerminalHandle } from "./live-terminal";
import { TERMINAL_BACKGROUND } from "./terminal-theme";

/**
 * The Computer panel's Terminal tab: the Bot's live shell, and the wheel under it.
 *
 * Drawn as the screen's card is (computer-view.tsx): the same rounded frame and border, and the same
 * row beneath it saying who has control, with the same Take control and Hand back. It is the same
 * wheel. Taking it here takes the whole computer, as it does from the screen, and the Bot waits until
 * it is handed back. The terminal inside is always a dark terminal, in either of the app's themes.
 */
export function ComputerTerminal({ computerId }: { computerId: string }) {
  const { control, someoneElse } = useComputerControl(computerId);
  /** The signed-in person holds the wheel. Someone else holding it on a shared Bot is not them typing. */
  const driving =
    control?.holder === "human" && !control.transitioning && !someoneElse;
  const terminal = useRef<LiveTerminalHandle>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  return (
    <figure className="overflow-hidden rounded-2xl border dark:border-white/15">
      <div
        className="relative h-[clamp(16rem,55vh,30rem)] p-2.5"
        style={{ background: TERMINAL_BACKGROUND }}
      >
        <LiveTerminal
          computerId={computerId}
          driving={driving}
          onProblem={setProblem}
          onReconnecting={setReconnecting}
          ref={terminal}
          retryKey={retryKey}
        />
        {reconnecting && !problem ? (
          <span
            className="absolute top-2 right-2 rounded-full bg-black/60 px-2.5 py-1 font-medium text-white text-xs backdrop-blur-sm"
            role="status"
          >
            正在重新连接…
          </span>
        ) : null}
        {problem ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-4 text-center text-muted-foreground text-sm">
            <span>{problem}</span>
            <button
              className="underline"
              onClick={() => {
                setProblem(null);
                setRetryKey((value) => value + 1);
              }}
              type="button"
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 ${driving ? "bg-amber-500/10" : ""}`}
      >
        {driving ? (
          <span className="text-sm">
            <strong className="font-medium">终端和屏幕现在由你操作。</strong>
            点击终端就能输入。你交还之前，员工会一直等着。终端里的命令以员工的身份运行，员工之后也能看到你在这里留下的东西，不要在这里输入密码或密钥。
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {!control
              ? "正在确认谁在操作…"
              : control.transitioning
                ? "正在完成当前动作…"
                : someoneElse
                  ? "有人接管了操作。"
                  : "员工正在操作。"}
          </span>
        )}
        <ComputerControlButton
          computerId={computerId}
          onTakeControl={() => terminal.current?.focus()}
        />
      </div>
    </figure>
  );
}
