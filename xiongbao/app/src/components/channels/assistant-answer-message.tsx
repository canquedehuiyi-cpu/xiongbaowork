import {
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import type { ComponentProps } from "react";

/** The answer's markdown body in a `data-slot` wrapper, the hook a screen frames the answer by (the Bot chat's graphite card). */
function AnswerMarkdownRenderer(
  props: ComponentProps<typeof CopilotChatAssistantMessage.MarkdownRenderer>,
) {
  return (
    <div data-slot="assistant-answer">
      <CopilotChatAssistantMessage.MarkdownRenderer {...props} />
    </div>
  );
}

/** The SDK's assistant message, with its markdown body wrapped so a screen can frame it. */
function AnswerAssistantMessage(props: CopilotChatAssistantMessageProps) {
  return (
    <CopilotChatAssistantMessage
      {...props}
      markdownRenderer={props.markdownRenderer ?? AnswerMarkdownRenderer}
    />
  );
}

// The SDK slot type includes its static subcomponents, which callers may also customize.
export const AssistantAnswerMessage = Object.assign(
  AnswerAssistantMessage,
  CopilotChatAssistantMessage,
);
