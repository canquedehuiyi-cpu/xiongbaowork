import { type BaseEvent, EventType } from "@ag-ui/client";

/** What a stream has opened and not closed, so a turn cut short can be closed in order. */
export function openTracker() {
  const texts = new Set<string>();
  const reasoning = new Set<string>();
  const reasoningMessages = new Set<string>();
  const steps = new Set<string>();
  const calls = new Set<string>();
  const unanswered = new Set<string>();
  let started = false;
  const idOf = (event: BaseEvent, key: string) =>
    String((event as unknown as Record<string, unknown>)[key]);
  return {
    get started() {
      return started;
    },
    see(event: BaseEvent) {
      switch (event.type) {
        case EventType.RUN_STARTED:
          started = true;
          break;
        case EventType.TEXT_MESSAGE_START:
          texts.add(idOf(event, "messageId"));
          break;
        case EventType.TEXT_MESSAGE_END:
          texts.delete(idOf(event, "messageId"));
          break;
        case EventType.REASONING_START:
          reasoning.add(idOf(event, "messageId"));
          break;
        case EventType.REASONING_END:
          reasoning.delete(idOf(event, "messageId"));
          break;
        case EventType.REASONING_MESSAGE_START:
          reasoningMessages.add(idOf(event, "messageId"));
          break;
        case EventType.REASONING_MESSAGE_END:
          reasoningMessages.delete(idOf(event, "messageId"));
          break;
        case EventType.STEP_STARTED:
          steps.add(idOf(event, "stepName"));
          break;
        case EventType.STEP_FINISHED:
          steps.delete(idOf(event, "stepName"));
          break;
        case EventType.TOOL_CALL_START:
          calls.add(idOf(event, "toolCallId"));
          unanswered.add(idOf(event, "toolCallId"));
          break;
        case EventType.TOOL_CALL_END:
          calls.delete(idOf(event, "toolCallId"));
          break;
        case EventType.TOOL_CALL_RESULT:
          calls.delete(idOf(event, "toolCallId"));
          unanswered.delete(idOf(event, "toolCallId"));
          break;
      }
    },
    /** The events that close what is open, then answer every call nobody answered. */
    closing(unansweredText: string): BaseEvent[] {
      const events: unknown[] = [];
      for (const messageId of texts)
        events.push({ type: EventType.TEXT_MESSAGE_END, messageId });
      for (const messageId of reasoningMessages)
        events.push({ type: EventType.REASONING_MESSAGE_END, messageId });
      for (const messageId of reasoning)
        events.push({ type: EventType.REASONING_END, messageId });
      for (const toolCallId of calls)
        events.push({ type: EventType.TOOL_CALL_END, toolCallId });
      for (const stepName of steps)
        events.push({ type: EventType.STEP_FINISHED, stepName });
      for (const toolCallId of unanswered)
        events.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId: crypto.randomUUID(),
          toolCallId,
          role: "tool",
          content: JSON.stringify({ ok: false, error: unansweredText }),
        });
      texts.clear();
      reasoning.clear();
      reasoningMessages.clear();
      steps.clear();
      calls.clear();
      unanswered.clear();
      return events as BaseEvent[];
    },
  };
}
