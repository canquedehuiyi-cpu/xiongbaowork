import { outcomeForPerson } from "@openbot/shared/approval-outcomes";
import { ownToolLabel } from "@openbot/shared/tool-name";
import { readOutcome } from "@/lib/computers/activity";
import type { VisibleChatItem } from "./chat-messages";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
const labels: Record<string, string> = {
  computer_navigate: "打开了页面",
  computer_read: "读取了页面",
  computer_snapshot: "查看了页面结构",
  computer_click: "在页面上点击",
  computer_type: "填写了字段",
  computer_key: "按了按键",
  computer_scroll: "滚动了页面",
};
=======
/** The browser steps, named in the words every other line uses for them (`shared/tool-name.ts`). */
const BROWSER_STEPS: ReadonlySet<string> = new Set([
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
]);
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

/** Whether a tool call is one of the browser steps a tool group draws with its page link. */
export function isBrowserStep(item: BrowserStep): boolean {
  return BROWSER_STEPS.has(item.toolCall.function.name);
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Whether the computer turned a browser step away until the Bot looked at the page again.
 *
 * After a person hands the browser back, the computer asks the Bot for a fresh snapshot before it
 * acts on the page. That answer is an instruction for the Bot: nothing happened on the page, and the
 * Bot takes the snapshot and acts again on its own. Drawn, it put the instruction in red under a
 * turn that went on to work, so the transcript leaves it out.
 *
 * Not a handback whose closing snapshot failed. That result also says `snapshotRequired`, carries
 * the handoff's status, and is a real failure the person may need to resume.
 */
export function awaitingFreshLook(step: BrowserStep): boolean {
  if (!isBrowserStep(step)) return false;
  const result = objectOf(step.result);
  return (
    result.ok === false &&
    result.snapshotRequired === true &&
    result.handoffStatus === undefined
  );
}

export function browserStepDetails(step: BrowserStep) {
  const result = objectOf(step.result);
  const args = objectOf(step.toolCall.function.arguments);
  const navigation = step.toolCall.function.name === "computer_navigate";
  const rawUrl = navigation ? (result.url ?? args.url) : undefined;
  let url: URL | undefined;
  try {
    if (typeof rawUrl === "string") {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        url = parsed;
    }
  } catch {
    /* A partial streaming URL is not a link yet. */
  }
  /*
   * A sentence rather than the computer's JSON is the approval's answer for a step the Bot did not
   * carry out: the person declined it, or the turn stopped before it to wait for them. Read as the
   * Computer panel reads it (`readOutcome`), so the transcript does not draw it as done.
   */
  const sentence =
    step.result !== undefined &&
    !isJson(step.result) &&
    !step.result.startsWith("Error:")
      ? readOutcome(step.result)
      : null;
  const failed =
    result.ok === false ||
    result.refused === true ||
    step.result?.startsWith("Error:") === true ||
    sentence?.ok === false;
  return {
    label: ownToolLabel(step.toolCall.function.name) ?? undefined,
    href: url?.href,
    title:
      navigation && typeof result.title === "string" && result.title.trim()
        ? result.title
        : url?.hostname,
    failed,
    reason:
      typeof result.reason === "string"
        ? result.reason
        : sentence?.ok === false && typeof sentence.reason === "string"
          ? outcomeForPerson(sentence.reason)
          : undefined,
    visited: navigation && result.ok === true,
    pending: step.result === undefined,
  };
}
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371

export function BrowserActivity({
  group,
  active,
}: {
  group: BrowserGroup;
  active: boolean;
}) {
  const steps = group.steps.map((step) => ({
    id: step.id,
    ...browserStepDetails(step),
  }));
  const pages = steps.filter((step) => step.visited).length;
  const issues = steps.filter((step) => step.failed).length;
  const running = active && steps.some((step) => step.pending);
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      <ToolLine
        label={
          running
            ? "正在浏览…"
            : pages
              ? `浏览了 ${pages} 个页面`
              : "浏览器活动"
        }
        detail={issues ? `${issues} 个问题` : undefined}
        running={running}
      >
        <ol className="space-y-2 py-1">
          {steps.map((step) => (
            <li key={step.id} className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-muted-foreground">
                  {step.label}
                </span>
                {step.href ? (
                  <a
                    href={step.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
                  >
                    {step.title ?? step.href}
                  </a>
                ) : null}
                {step.pending && (
                  <span className="text-muted-foreground">
                    {active ? "进行中" : "未完成"}
                  </span>
                )}
              </div>
              {step.failed && (
                <p className="mt-0.5 text-destructive">
                  {step.reason ?? "这一步没能完成。"}
                </p>
              )}
            </li>
          ))}
        </ol>
      </ToolLine>
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}
=======
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
