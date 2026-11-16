import { IconDeviceDesktop } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";

/** The same ownership action appears in chat, the computer sidebar, and the full-size viewer. */
export function ComputerControlButton({
  computerId,
  onTakeControl,
  prominent = false,
}: {
  computerId: string;
  onTakeControl?: () => void;
  /** Take control drawn solid rather than outlined: where it is the one action offered, over the Bot's screen. */
  prominent?: boolean;
}) {
  const { control, busy, problem, change, someoneElse } =
    useComputerControl(computerId);
  // Someone else's wheel is not the person's to hand back, and not theirs to take from under them either.
  const human = control?.holder === "human" && !someoneElse;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={human || prominent ? "default" : "outline"}
        disabled={busy || !control || control.transitioning || someoneElse}
        aria-busy={busy || control?.transitioning}
        onClick={async () => {
          if (await change?.(human ? "release" : "take")) {
            if (!human) onTakeControl?.();
          }
        }}
      >
        {human ? "交还" : "接管"}
      </Button>
      {control?.transitioning ? (
        <span className="text-xs text-muted-foreground" role="status">
          正在完成当前动作…
        </span>
      ) : null}
      {problem ? (
        <span className="max-w-64 text-xs text-destructive" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

export function ComputerChatControls({
  computerId,
  open,
  onOpenChange,
}: {
  computerId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control, someoneElse } = useComputerControl(
    computerId ?? "",
    Boolean(computerId),
  );
  const needsYou = Boolean(
    control &&
      (control.requested ||
        (control.holder === "human" && !someoneElse) ||
        control.recoveryRequired ||
        control.secretWanted !== undefined),
  );
  const promptKey = needsYou
    ? `${computerId}:${control?.secretWanted ?? control?.request?.id ?? "human"}`
    : null;
  const shownPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (shownPrompt.current === promptKey) return;
    shownPrompt.current = promptKey;
    // Surface each new prompt once; closing the Computer remains a real dismissal.
    if (promptKey) onOpenChange(true);
  }, [promptKey, onOpenChange]);
  return (
    <div className="flex items-start gap-1.5">
      <Button
        size="sm"
        variant={open ? "secondary" : "ghost"}
        aria-label={open ? "关闭电脑" : "打开电脑"}
        aria-expanded={open}
        disabled={!computerId}
        onClick={() => onOpenChange(!open)}
      >
        <IconDeviceDesktop className="size-4" />
        电脑
        {needsYou ? (
          <span
            className="size-2 rounded-full bg-amber-500"
            role="img"
            aria-label="需要你"
          />
        ) : null}
      </Button>
      {computerId ? (
        <ComputerControlButton
          computerId={computerId}
          onTakeControl={() => onOpenChange(true)}
        />
      ) : null}
    </div>
  );
}
