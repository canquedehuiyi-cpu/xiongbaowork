/**
 * The client side of a chat run over plain HTTP, shared by the two harnesses that drive a real server
 * without a browser: `background-chat.ts` (gate G8, mocked model) and the employee evaluation's chat path
 * (`employee-eval/run-xiongbao.ts` with `EVAL_PATH=chat`, real model).
 *
 * It is what the page does with `fetch`: send a run request that declares `forwardedProps.computerTools =
 * "server"`, read the event stream frame by frame, hang up when a scenario says so, join a live turn again
 * with `/connect`, and read the stored thread back. Nothing here starts a server, a model or a computer;
 * the caller passes the server's origin and the person's session cookie.
 */

import { randomUUID } from "node:crypto";

/** One event of the stream, as the server sends it. */
export type Streamed = {
  type?: string;
  toolCallId?: string;
  toolCallName?: string;
  messageId?: string;
  delta?: string;
  content?: string;
  name?: string;
  [key: string]: unknown;
};

/** What the page offers a Bot it may drive; the server drops them for a run that declares itself. */
export const browserTools = [
  "computer_run_command",
  "computer_navigate",
  "computer_write_file",
  "report_refusal",
].map((name) => ({
  name,
  description: `The browser's ${name}.`,
  parameters: { type: "object", properties: {} },
}));

/** An open event stream: events are read one at a time, and the connection can be hung up. */
export type Stream = {
  events: Streamed[];
  /** Resolves with the first event the test accepts, reading on from where it stopped. */
  next(
    accept: (event: Streamed) => boolean,
    timeoutMs?: number,
  ): Promise<Streamed>;
  /** Resolves when the server ends the stream, with everything it sent. */
  done(timeoutMs?: number): Promise<Streamed[]>;
  /** Hang up: the client goes away mid-turn. */
  hangUp(): void;
};

/** Where a Bot's run and connect endpoints are. */
export const RUN_PATH = (bot: string) =>
  `/api/copilotkit/agent/${encodeURIComponent(bot)}/run`;
export const CONNECT_PATH = (bot: string) =>
  `/api/copilotkit/agent/${encodeURIComponent(bot)}/connect`;

export async function openStream(
  origin: string,
  cookie: string,
  path: string,
  payload: unknown,
): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  if (response.status !== 200 || !response.body)
    throw new Error(
      `${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Streamed[] = [];
  let buffer = "";
  let cursor = 0;
  let ended = false;

  async function pull(): Promise<boolean> {
    if (ended) return false;
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      return false;
    }
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut < 0) break;
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) events.push(JSON.parse(data) as Streamed);
    }
    return true;
  }

  const within = <T>(what: string, ms: number, work: Promise<T>) =>
    Promise.race([
      work,
      Bun.sleep(ms).then(() => {
        throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
      }),
    ]);

  return {
    events,
    async next(accept, timeoutMs = 60_000) {
      return within(
        "an event from the stream",
        timeoutMs,
        (async () => {
          for (;;) {
            while (cursor < events.length) {
              const event = events[cursor++] as Streamed;
              if (accept(event)) return event;
            }
            if (!(await pull()))
              throw new Error(
                `The stream ended before the event arrived (saw ${events.map((e) => e.type).join(", ")})`,
              );
          }
        })(),
      );
    },
    async done(timeoutMs = 120_000) {
      await within(
        "the stream to end",
        timeoutMs,
        (async () => {
          while (await pull()) {}
        })(),
      );
      return events;
    },
    hangUp() {
      controller.abort();
      reader.cancel().catch(() => undefined);
    },
  };
}

/** A message of the stored thread, as the page reloads it. */
export type StoredMessage = {
  id?: string;
  role: string;
  content?: string;
  toolCallId?: string;
  /** The thread endpoint names a call `{ id, name, args }`; a stored snapshot nests them under `function`. */
  toolCalls?: {
    id: string;
    name?: string;
    args?: string;
    function?: { name: string; arguments: string };
  }[];
};

/** The thread as the page reloads it: the stored messages, by the person's session alone. */
export async function fetchStoredMessages(
  origin: string,
  cookie: string,
  botId: string,
  threadId: string,
): Promise<StoredMessage[]> {
  const response = await fetch(
    `${origin}/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(botId)}`,
    {
      headers: { origin, ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (response.status !== 200)
    throw new Error(
      `thread messages answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  return (body as { messages?: StoredMessage[] }).messages ?? [];
}

/**
 * The run request the page sends for a person's message, declaring that the server runs the computer.
 * `messages` is the whole conversation, the new user message last.
 */
export function runRequest(input: {
  threadId: string;
  runId?: string;
  messages: { id?: string; role: string; content?: string }[];
}) {
  return {
    threadId: input.threadId,
    runId: input.runId ?? `run-${randomUUID()}`,
    state: {},
    messages: input.messages,
    tools: browserTools,
    context: [],
    forwardedProps: { computerTools: "server" },
  };
}

/** The request that joins a thread's live turn, or replays its last one. */
export function connectRequest(threadId: string) {
  return {
    threadId,
    runId: `run-${randomUUID()}`,
    state: {},
    messages: [],
    tools: browserTools,
    context: [],
    forwardedProps: {},
  };
}

export const toolResultsOf = (messages: StoredMessage[]) =>
  messages.filter((message) => message.role === "tool");
export const callsOf = (messages: StoredMessage[]) =>
  messages.flatMap((message) => message.toolCalls ?? []);
export const lastAssistantText = (messages: StoredMessage[]) =>
  messages
    .filter((message) => message.role === "assistant" && message.content)
    .at(-1)?.content;

/** A condensed, comparable view of a stream: what was called, what came back, what was said. */
export function digest(events: Streamed[]) {
  const calls: string[] = [];
  const results: string[] = [];
  let said = "";
  for (const event of events) {
    if (event.type === "TOOL_CALL_START") calls.push(String(event.toolCallId));
    if (event.type === "TOOL_CALL_RESULT")
      results.push(`${event.toolCallId}:${String(event.content)}`);
    if (event.type === "TEXT_MESSAGE_CONTENT")
      said += String(event.delta ?? "");
  }
  return { calls, results, said };
}
