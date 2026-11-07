/*
 * A tiny Streamable HTTP MCP server on a loopback port for the client's tests. It hands out an
 * `Mcp-Session-Id` on initialize and refuses (400) any later request that does not carry it. With
 * `sse` it answers every request as an event stream that first carries unrelated events.
 */
export function startFakeHttpMcp(options: {
  sse: boolean;
  delayMs?: number;
  /** A port of its own choosing, to bring an app back where it was. */
  port?: number;
}) {
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  const requests: Array<{ method: string; sessionId: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      if (request.method === "DELETE")
        return new Response(null, { status: 200 });
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: {
          name?: string;
          cursor?: string;
          arguments?: { text?: unknown };
        };
      };
      const got = request.headers.get("mcp-session-id");
      requests.push({ method: body.method, sessionId: got });
      if (body.method !== "initialize" && got !== sessionId) {
        return new Response("missing session", { status: 400 });
      }
      if (body.method === "tools/call" && options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-http", version: "1" },
        };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            {
              name: "echo",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      } else {
        result = {
          content: [
            { type: "text", text: String(body.params?.arguments?.text ?? "") },
          ],
        };
      }
      const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      const headers: Record<string, string> = {};
      if (body.method === "initialize") headers["Mcp-Session-Id"] = sessionId;
      if (!options.sse) {
        return new Response(message, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const noise = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info" },
      });
      const other = JSON.stringify({
        jsonrpc: "2.0",
        id: 9999,
        result: { content: [{ type: "text", text: "not mine" }] },
      });
      return new Response(
        `event: message\ndata: ${noise}\n\nevent: message\ndata: ${other}\n\nevent: message\ndata: ${message}\n\n`,
        { headers: { ...headers, "Content-Type": "text/event-stream" } },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    port: server.port as number,
    requests,
    stop: () => server.stop(true),
  };
}
