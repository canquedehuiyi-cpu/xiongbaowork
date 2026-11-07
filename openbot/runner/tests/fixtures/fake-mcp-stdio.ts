/*
 * A tiny MCP server over stdio for the client's tests. Run with `bun`; behaviour comes from
 * FAKE_MCP_MODE:
 *   ok      answers normally
 *   banner  prints non-JSON lines on stdout before and between messages
 *   slow    answers tools/call only after FAKE_MCP_DELAY ms (default 5000)
 *   exit    writes a long stderr and exits with 1 before answering anything
 *   paged   tools/list never stops returning a nextCursor
 * `echo` also has a few test hooks keyed on its `text`: "__big__" (2 MB result), "__media__"
 * (image + resource content), "__env__:NAME" (the child's own env value), "__hang__" (never answers).
 * Every notification the client sends is appended to FAKE_MCP_LOG (when set) as one JSON line.
 */
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_MCP_MODE ?? "ok";

const tools = [
  {
    name: "echo",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Write a note",
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
  },
  {
    name: "wipe",
    description: "Delete everything",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
];

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (mode === "exit") {
  process.stderr.write(`${"a".repeat(6000)}FATAL-END`);
  process.exit(1);
}
if (mode === "banner") process.stdout.write("Server v1.0 starting...\n");

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

function handle(message: {
  id?: number;
  method: string;
  params?: { name?: string; cursor?: string; arguments?: { text?: unknown } };
}) {
  const { id, method, params } = message;
  if (id === undefined) {
    if (process.env.FAKE_MCP_LOG) {
      appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(message)}\n`);
    }
    return;
  }
  const reply = (result: unknown) => {
    if (mode === "banner") process.stdout.write("debug: replying\n");
    send({ jsonrpc: "2.0", id, result });
  };
  if (method === "initialize") {
    return reply({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1" },
    });
  }
  if (method === "tools/list") {
    if (mode === "paged") {
      const page = Number(params?.cursor ?? 0);
      return reply({
        tools: [{ name: `page_${page}`, inputSchema: { type: "object" } }],
        nextCursor: String(page + 1),
      });
    }
    return reply({ tools });
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (!tools.some((tool) => tool.name === name)) {
      return send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
    }
    const text = String(params?.arguments?.text ?? "");
    const respond = () => {
      if (text === "__hang__") return;
      if (text === "__big__") return reply(textResult("x".repeat(2_000_000)));
      if (text === "__media__") {
        return reply({
          content: [
            { type: "image", data: "A".repeat(16384), mimeType: "image/png" },
            {
              type: "resource",
              resource: { uri: "file:///a.txt", text: "inside" },
            },
            { type: "text", text: "after" },
          ],
        });
      }
      if (text.startsWith("__env__:")) {
        return reply(textResult(process.env[text.slice(8)] ?? "<unset>"));
      }
      reply(textResult(text));
    };
    if (mode === "slow") {
      setTimeout(respond, Number(process.env.FAKE_MCP_DELAY ?? 5000));
    } else respond();
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line) handle(JSON.parse(line));
  }
});
