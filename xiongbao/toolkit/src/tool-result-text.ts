import type { Message } from "@ag-ui/client";

/**
 * A tool's text result, as the model saw it when the tool ran, and not encoded a second time.
 *
 * The runtime puts a finished tool call into the stream as `JSON.stringify(output)`. For an object
 * that is the right text. For a tool that answers with a plain string it quotes and escapes it:
 * `已更新计划…` leaves the tool and is stored, and later replayed to the model, as
 * `"\"已更新计划…\""`. The turn that ran the tool used the string as it was, so the next turn's
 * conversation differed from the one before it from that message on, which is every token after it
 * missing the provider's prompt cache, and the model read the escapes as part of the answer.
 *
 * The stored text and the stream's events are left as the runtime wrote them, because what draws a tool
 * result reads that form. The encoding is undone only on the history a turn hands the model, and where
 * it can be undone without guessing: a result that is a JSON string literal came from a string, because
 * nothing else serializes to one. An object, array, number or text that is not a JSON string literal is
 * returned as it is. Results stored long ago are in the same form, so they are read the same way.
 */
export function plainToolResult(content: string): string {
  if (content.length < 2 || !content.startsWith('"') || !content.endsWith('"'))
    return content;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "string" ? parsed : content;
  } catch {
    return content;
  }
}

/**
 * The conversation with every string tool result decoded. A message that needs no change is the same
 * object, and the array itself is returned when nothing changed.
 */
export function plainToolResults<T extends Message>(
  messages: readonly T[],
): T[] {
  let changed = false;
  const decoded = messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string")
      return message;
    const plain = plainToolResult(message.content);
    if (plain === message.content) return message;
    changed = true;
    return { ...message, content: plain };
  });
  return changed ? decoded : (messages as T[]);
}
