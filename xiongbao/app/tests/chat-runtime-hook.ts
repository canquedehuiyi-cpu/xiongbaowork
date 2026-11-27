import * as library from "@copilotkit/react-core/v2";
import { useCopilotKit as useChatRuntime } from "@copilotkit/react-core/v2";

/**
 * The library's export name for the chat-runtime hook, found by identity among its exports, so a test
 * can replace or spy on that export (`mock.module`, `spyOn`) while the source only ever says
 * `useChatRuntime`. Read once, when this module loads, before any test swaps the export out.
 */
export const CHAT_RUNTIME_HOOK = Object.keys(library).find(
  (name) => (library as Record<string, unknown>)[name] === useChatRuntime,
) as keyof typeof library;
