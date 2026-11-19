import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { humanise, readToolName } from "@openbot/shared/tool-name";
import { IconLoader2 } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { TurnInFlightContext } from "@/components/gallery/streaming";
import { spentOf } from "@/lib/spent-of";
import { subagentStepsQueryOptions } from "@/lib/subagents/queries";
import { cn } from "@/lib/utils";
import { ACP_CARD } from "./acp-cards";
import { toVisibleChatItems, type VisibleChatItem } from "./chat-messages";
import {
  type StepDetails,
  StepIcon,
  StepOutput,
  StepRow,
  stepDetails,
  subtaskWordsFor,
} from "./tool-activity";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/**
 * A piece of work a Bot gave to a subagent, as one step of the line its turn's work folds into.
 *
 * A subagent is the same Bot run again on one part of the work, in a thread of its own, so its steps
 * are not in this conversation at all. This row is where the person finds them: one line saying it
 * was a subtask, what it was asked and how it ended, which opens to the task, its answer and each
 * step it took, read from its own thread.
 *
 * A CARD AGAIN (期四). It was one line inside the folded work line, next to the searches and pages,
 * when a Bot started a subtask about once a week. Now Bots share work out on purpose, several parts
 * at once, and a person wants each part in view: what it was asked, whether it is still working, how
 * long it took and what it handed back. So each subtask is a card of its own, the subtasks of one
 * step side by side (`SubtaskCards` in `tool-activity.tsx`), and nothing else draws them a second
 * time. What the line learned stays: no "Needs your approval" badge with nothing to press (a stop is
 * "已交还", said plainly inside), the reason and time from #678, the steps read only once it opens.
 *
 * Its steps are read only once the row is opened. A closed row needs nothing from its thread: how
 * it ended is in the call's own result, and while it works the folded line says so.
 *
 * Called a subtask on screen, because that is what the person is looking at: part of what they
 * asked for, being done on its own. "Agent" is a word OpenBot keeps for software somebody brings.
 */
export function SubtaskStep({
  step,
  active,
}: {
  step: StepDetails;
  /** The turn this step belongs to is still in flight. */
  active: boolean;
}) {
  const chat = useCopilotChatConfiguration();
  const [open, setOpen] = useState(false);
  const toolCallId = step.subtask?.toolCallId ?? step.id;
  const result = step.subtask?.result ?? null;
  /*
   * Running while its turn is, whichever row it is in: a component the Bot drew in the same step can
   * land below it, and the group is then not the newest row, though the subagent is still working.
   */
  const inFlight = useContext(TurnInFlightContext);
  const running = (active || inFlight) && step.pending;
  const options = subagentStepsQueryOptions({
    toolCallId,
    parentThreadId: chat?.threadId,
    threadId: result?.threadId,
    agentId: chat?.agentId ?? "default",
    live: running,
  });
  const thread = useQuery({
    ...options,
    enabled: open && options.enabled !== false,
  });
  const steps = (thread.data ? toVisibleChatItems(thread.data.messages) : [])
    .filter((item): item is ToolItem => item.kind === "tool")
    .map(stepDetails);
  const count = Math.max(steps.length, result?.steps ?? 0);
  const handedBack =
    result && "handedBack" in result ? result.handedBack : null;

  const title = step.subtask?.task ? titleOf(step.subtask.task) : undefined;
  return (
    <li className="min-w-0">
      <details
        className={cn(ACP_CARD, "tool-line max-w-none gap-0 py-3 text-[13px]")}
        data-subagent-card=""
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex min-w-0 grow basis-64 items-center gap-1.5">
            <span
              aria-hidden
              className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
            >
              ▸
            </span>
            <StepIcon kind="subtask" />
            {/* Shimmers while it works, as every running step does. See `StepRow`. */}
            <span
              className={cn(
                "shrink-0 font-medium",
                running && "tool-line-running",
              )}
            >
              {step.label}
            </span>
            {title ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span className="min-w-0 truncate" title={step.subtask?.task}>
                  {title}
                </span>
              </>
            ) : null}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-5">
            <SubtaskStatus
              count={count}
              handedBack={handedBack !== null}
              ms={result?.ms}
              running={running}
              step={step}
            />
          </span>
        </summary>
        <div className="mt-2 space-y-2 pl-5">
          {step.subtask?.task ? (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {step.subtask.task}
            </p>
          ) : null}
          {handedBack ? <HandedBack {...handedBack} /> : null}
          {step.output ? <StepOutput output={step.output} /> : null}
          {steps.length ? (
            <ol className="space-y-2">
              {steps.map((inner) => (
                <StepRow active={running} key={inner.id} step={inner} />
              ))}
            </ol>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * How the subtask ended, beside its line. A finished one says how many steps it took, and once the
 * server timed its run, how long that run took. While it works neither is known, so nothing about
 * time is said: the line shimmers and that is the whole of it.
 */
function SubtaskStatus({
  step,
  running,
  handedBack,
  count,
  ms,
}: {
  step: StepDetails;
  running: boolean;
  handedBack: boolean;
  count: number;
  /** What the run took, from the server's clock. Absent on a result written before it was timed. */
  ms?: number;
}) {
  const steps = count > 0 ? `${count} 个步骤` : "";
  const spent =
    ms === undefined || !Number.isFinite(ms) || ms < 0
      ? ""
      : `耗时 ${spentOf(ms)}`;
  const withSpent = (how: string) =>
    [how, spent].filter((part) => part !== "").join(" · ");
  if (running)
    return (
      <>
        {/* 和「思考中」前面那个是同一个：设了减少动画就不转。 */}
        <IconLoader2
          aria-hidden="true"
          className="size-[14px] shrink-0 text-muted-foreground motion-safe:animate-spin"
          data-working-spinner=""
        />
        <span className="shrink-0 text-muted-foreground">
          {steps ? `工作中 · ${steps}` : "工作中"}
        </span>
      </>
    );
  if (step.pending)
    return <span className="shrink-0 text-muted-foreground">未完成</span>;
  if (step.refused)
    return <span className="shrink-0 text-destructive">已拦下</span>;
  if (handedBack)
    return (
      <span className="shrink-0 text-muted-foreground">
        {withSpent("已交还")}
      </span>
    );
  if (step.failed)
    return (
      <span className="shrink-0 text-amber-600 dark:text-amber-500">
        {withSpent("没能完成")}
      </span>
    );
  // 做完了：说一声，再说走了几步、用了多久（两样都有才写）。
  return (
    <>
      <span className="shrink-0 text-muted-foreground">已完成</span>
      {steps || spent ? (
        <span className="shrink-0 text-muted-foreground">
          {withSpent(steps)}
        </span>
      ) : null}
    </>
  );
}

/** 卡的标题：任务开头 30 个字，长了带省略号。整段任务在卡里，点开就是。 */
const TITLE_CHARACTERS = 30;

function titleOf(task: string): string {
  const characters = [...task.trim()];
  return characters.length > TITLE_CHARACTERS
    ? `${characters.slice(0, TITLE_CHARACTERS).join("")}…`
    : task.trim();
}

/**
 * The action the subagent stopped before, said plainly. Nothing was done and nobody was asked. The
 * Bot does it itself if it still needs doing, and the person is asked then, on the Bot's own card.
 *
 * WHY it stopped is the gate's own sentence, and what it had said before stopping is its own account;
 * both are written for the Bot, so the first is read here in the words a person uses (see
 * {@link subtaskWordsFor}) and the second is drawn as it was written. Both are absent on a result
 * from before they were carried, and on one that never stopped here.
 */
function HandedBack({
  tool,
  args,
  reason,
  said,
}: {
  tool: string;
  args: unknown;
  reason?: string;
  said?: string;
}) {
  const { label, detail } = tool.startsWith("mcp__")
    ? readToolName(tool)
    : { label: humanise(tool.replace(/^computer_/, "")), detail: undefined };
  const inputs =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [];
  return (
    <section aria-label="已交还" className="space-y-1">
      <p>
        它在一个需要你批准的步骤前停了下来。如果这一步仍然需要做，员工会在这段对话里问你。
      </p>
      {reason ? (
        <p className="text-muted-foreground">
          它停下来的原因：{subtaskWordsFor(reason)}
        </p>
      ) : null}
      <p className="font-medium">
        {label}
        {detail ? `（${detail}）` : ""}
      </p>
      {inputs.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          {inputs.map(([key, value]) => (
            <div className="contents" key={key}>
              <dt>{key}</dt>
              <dd className="min-w-0 break-words text-foreground/80">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {said ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">它停下来时说的：</p>
          <StepOutput output={said} />
        </div>
      ) : null}
    </section>
  );
}
