/**
 * A coworker that answers without a model.
 *
 * WHY THIS EXISTS. Verifying B2/B3 ("@ a coworker and the message reaches it, its reply lands in the
 * channel and in the task") needs a Bot that replies, and every Bot this repository ships needs an
 * API key: the compose `agent-bot` refuses to start without `MANAGED_AGENT_TOKEN` and calls OpenAI,
 * the LangGraph and Mastra examples are framework bots that call a model too. Echo is the difference
 * between "we can prove the routing" and "we can only prove it with somebody's credit card".
 *
 * It is a test double at the product's real boundary, not fake data: the server POSTs an AG-UI
 * RunAgentInput to this address exactly as it would to a customer's hosted Bot, and this answers with
 * the SSE event sequence the server's own tests describe (`agent-connection-live.test.ts`,
 * `agent-endpoint.test.ts`). Nothing about the calling side is stubbed.
 *
 * The reply quotes the last user message back so a walkthrough can tell apart "a card appeared" from
 * "this coworker received the words I typed".
 */
const PORT = Number(process.env.ECHO_BOT_PORT ?? 4200);

type Message = { role?: unknown; content?: unknown };

function lastUserText(body: { messages?: unknown }): string {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Message[])
    : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/** One AG-UI event as the server reads it: a `data:` frame per event, blank line between. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, name: "echo-bot" });
    }

    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      threadId?: unknown;
      runId?: unknown;
      messages?: unknown;
    };
    const threadId =
      typeof body.threadId === "string" ? body.threadId : "echo-thread";
    const runId = typeof body.runId === "string" ? body.runId : "echo-run";
    const messageId = `${runId}-message`;
    const asked = lastUserText(body);

    // SSE, not a body: the caller reads this as a stream, and an empty run is a failure to answer.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(frame(event)));
        send({ type: "RUN_STARTED", threadId, runId });
        send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        send({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: asked
            ? `已收到：${asked}（来自 echo-bot，本员工不接模型，仅用于验证派活路由）`
            : "echo-bot 在线，但这次没带可复述的用户消息。",
        });
        send({ type: "TEXT_MESSAGE_END", messageId });
        send({ type: "RUN_FINISHED", threadId, runId });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  },
});

console.log(`echo-bot listening on http://127.0.0.1:${server.port}/ag-ui`);
