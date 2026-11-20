/**
 * 本机验证用的假模型：一个只在回环地址上监听的 HTTP 服务，讲两种协议——
 *
 * - OpenAI 兼容的 Chat Completions（`POST …/chat/completions`，流式和非流式都行），熊宝走这个；
 * - OpenAI Responses（`POST …/responses`，流式），Codex 走这个。
 *
 * 每次请求交给调用方给的 `policy` 决定这一步回什么：一段话，或者一批工具调用。它不懂题目，只用来证明
 * 「模型发出工具调用 → 做题方真的执行 → 产物被拷出来判分」这条链是通的。只在 `EVAL_LOCAL_MOCK=1`
 * 的本机模式里用，CI 里两个评测脚本都拒绝这个模式。
 */

export type MockTurn = {
  text?: string;
  tools?: { name: string; arguments: Record<string, unknown> }[];
};

/** 一次请求的要点：协议、最近一条用户话、自那以后已经有几次工具结果、请求里提供的工具名。 */
export type MockRequest = {
  protocol: "chat" | "responses";
  lastUser: string;
  toolResultsSinceUser: number;
  offeredTools: string[];
  raw: Record<string, unknown>;
};

export type MockModel = {
  url: string;
  calls: number;
  stop: () => void;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : String((part as { text?: unknown }).text ?? ""),
      )
      .join("");
  return "";
}

function summarizeChat(body: Record<string, unknown>): MockRequest {
  const messages = (body.messages as Record<string, unknown>[]) ?? [];
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  return {
    protocol: "chat",
    lastUser: textOf(messages[lastUserIndex]?.content),
    toolResultsSinceUser: messages
      .slice(lastUserIndex + 1)
      .filter((message) => message.role === "tool").length,
    offeredTools: ((body.tools as Record<string, unknown>[]) ?? []).map(
      (tool) =>
        String(
          (tool.function as { name?: unknown } | undefined)?.name ??
            tool.name ??
            "",
        ),
    ),
    raw: body,
  };
}

function summarizeResponses(body: Record<string, unknown>): MockRequest {
  const input = (body.input as Record<string, unknown>[]) ?? [];
  let lastUserIndex = -1;
  input.forEach((item, index) => {
    if (item.role === "user") lastUserIndex = index;
  });
  return {
    protocol: "responses",
    lastUser: textOf(input[lastUserIndex]?.content),
    toolResultsSinceUser: input
      .slice(lastUserIndex + 1)
      .filter((item) => item.type === "function_call_output").length,
    offeredTools: ((body.tools as Record<string, unknown>[]) ?? []).map(
      (tool) => String(tool.name ?? ""),
    ),
    raw: body,
  };
}

const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

function chatAnswer(
  body: Record<string, unknown>,
  turn: MockTurn,
  step: number,
) {
  const id = `mock-${step}`;
  const toolCalls = (turn.tools ?? []).map((tool, index) => ({
    id: `call_${step}_${index}`,
    type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
  }));
  const finish = toolCalls.length ? "tool_calls" : "stop";
  if (body.stream !== true)
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: String(body.model ?? "mock"),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.text ?? (toolCalls.length ? null : ""),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage: USAGE,
    });
  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: unknown,
  ) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: String(body.model ?? "mock"),
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  let out = chunk({ role: "assistant", content: turn.text ?? "" }, null);
  toolCalls.forEach((call, index) => {
    out += chunk({ tool_calls: [{ index, ...call }] }, null);
  });
  out += chunk({}, finish);
  out += `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: USAGE })}\n\n`;
  out += "data: [DONE]\n\n";
  return new Response(out, {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesAnswer(turn: MockTurn, step: number) {
  const event = (payload: Record<string, unknown>) =>
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const items: Record<string, unknown>[] = (turn.tools ?? []).map(
    (tool, index) => ({
      type: "function_call",
      id: `fc_${step}_${index}`,
      call_id: `call_${step}_${index}`,
      name: tool.name,
      arguments: JSON.stringify(tool.arguments),
    }),
  );
  if (turn.text || items.length === 0)
    items.push({
      type: "message",
      id: `msg_${step}`,
      role: "assistant",
      content: [{ type: "output_text", text: turn.text ?? "" }],
    });
  let out = event({
    type: "response.created",
    response: { id: `resp_${step}` },
  });
  for (const item of items)
    out += event({ type: "response.output_item.done", item });
  out += event({
    type: "response.completed",
    response: {
      id: `resp_${step}`,
      usage: {
        input_tokens: USAGE.prompt_tokens,
        output_tokens: USAGE.completion_tokens,
        total_tokens: USAGE.total_tokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  return new Response(out, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** 一张有文字、有色块的页面：截图出来是一张有内容的 PNG，而不是空白页。 */
function demoPage(): string {
  const rows = Array.from(
    { length: 60 },
    (_, index) =>
      `<p style="margin:2px 0;color:hsl(${(index * 37) % 360} 60% 35%)">Row ${index}: revenue, margin and headcount by region, with notes on supply, pricing and the outlook.</p><div style="height:6px;background:linear-gradient(90deg,hsl(${(index * 53) % 360} 80% 60%),hsl(${(index * 91) % 360} 80% 40%))"></div>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Demo report</title></head><body style="font:14px sans-serif;margin:16px">${rows}</body></html>`;
}

export function startMockModel(
  policy: (request: MockRequest) => MockTurn,
): MockModel {
  const state = { calls: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      if (request.method === "GET" && /\/models$/.test(path))
        return Response.json({
          object: "list",
          data: [{ id: "mock", object: "model" }],
        });
      // 本机验证要打开的网页：假模型的剧本让电脑导航到这里，再截图。
      if (request.method === "GET" && path === "/page")
        return new Response(demoPage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      state.calls += 1;
      if (path.endsWith("/chat/completions"))
        return chatAnswer(body, policy(summarizeChat(body)), state.calls);
      if (path.endsWith("/responses"))
        return responsesAnswer(policy(summarizeResponses(body)), state.calls);
      return new Response(null, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get calls() {
      return state.calls;
    },
    stop: () => server.stop(true),
  };
}
