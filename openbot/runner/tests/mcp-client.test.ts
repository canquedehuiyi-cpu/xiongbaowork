import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../src/apps";
import {
  childEnv,
  connectApp,
  launchSpec,
  type McpConnection,
  McpAppError,
} from "../src/mcp-client";
import { startFakeHttpMcp } from "./fixtures/fake-mcp-http";

/*
 * The runner's own MCP client: JSON-RPC over a child's pipes or over loopback HTTP, no SDK. Every
 * test closes what it opened so no child process outlives the run.
 */

const fixture = join(import.meta.dir, "fixtures", "fake-mcp-stdio.ts");
const open: McpConnection[] = [];
const stops: Array<() => void> = [];
const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-mcp-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

afterEach(async () => {
  for (const connection of open.splice(0)) await connection.close();
  for (const stop of stops.splice(0)) stop();
});

function stdioEntry(env: Record<string, string> = {}): AppEntry {
  return {
    ref: "app_aaaaaaaaaaaaaaaaaaaaaa",
    name: "fake",
    kind: "stdio",
    command: process.execPath,
    args: [fixture],
    env,
    enabled: true,
  };
}

async function connect(
  env: Record<string, string> = {},
  timeouts?: { initMs?: number; listMs?: number; callMs?: number },
) {
  const connection = await connectApp(stdioEntry(env), { timeouts });
  open.push(connection);
  return connection;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as McpAppError;
  }
  throw new Error("expected a rejection");
}

test("stdio: initialize, list three tools with annotations, call echo returns its text", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "ok" });
  const tools = await connection.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([
    "echo",
    "write_note",
    "wipe",
  ]);
  expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  expect(tools[1]?.annotations).toBeUndefined();
  expect(tools[2]?.annotations?.destructiveHint).toBe(true);
  const outcome = await connection.callTool("echo", { text: "hello" });
  expect(outcome).toEqual({
    content: [{ type: "text", text: "hello" }],
    isError: false,
    truncated: false,
  });
  const unknown = await rejection(connection.callTool("nope", {}));
  expect(unknown.kind).toBe("unknown_tool");
});

test("stdio: non-JSON lines on stdout before and between messages are ignored", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "banner" });
  expect((await connection.listTools()).length).toBe(3);
  const outcome = await connection.callTool("echo", { text: "still fine" });
  expect(outcome.content[0]?.text).toBe("still fine");
});

test("stdio: paged tools/list follows nextCursor and stops after 10 pages", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "paged" });
  const tools = await connection.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(
    Array.from({ length: 10 }, (_, page) => `page_${page}`),
  );
});

test('stdio: a server that exits early rejects with kind "start" and the last ≤4096 bytes of stderr', async () => {
  const error = await rejection(
    connectApp(stdioEntry({ FAKE_MCP_MODE: "exit" })),
  );
  expect(error).toBeInstanceOf(McpAppError);
  expect(error.kind).toBe("start");
  expect(error.stderrTail).toBeDefined();
  expect(Buffer.byteLength(error.stderrTail ?? "")).toBeLessThanOrEqual(4096);
  expect(error.stderrTail?.endsWith("FATAL-END")).toBe(true);
});

test('stdio: a command that does not exist rejects with kind "start"', async () => {
  const entry = stdioEntry();
  if (entry.kind !== "stdio") throw new Error("fixture");
  entry.command = join(scratch, "no-such-command");
  expect((await rejection(connectApp(entry))).kind).toBe("start");
});

test('stdio: callTool past callMs rejects with kind "timeout"; abort sends notifications/cancelled and rejects', async () => {
  const slow = await connect(
    { FAKE_MCP_MODE: "slow", FAKE_MCP_DELAY: "5000" },
    { callMs: 300 },
  );
  const timedOut = await rejection(slow.callTool("echo", { text: "x" }));
  expect(timedOut.kind).toBe("timeout");
  expect(timedOut.message).toContain("300");

  const log = join(scratch, "cancel.log");
  rmSync(log, { force: true });
  const connection = await connect({
    FAKE_MCP_MODE: "ok",
    FAKE_MCP_LOG: log,
  });
  const controller = new AbortController();
  const pending = rejection(
    connection.callTool("echo", { text: "__hang__" }, controller.signal),
  );
  setTimeout(() => controller.abort(), 100);
  const aborted = await pending;
  expect(aborted.name).toBe("AbortError");
  const logged = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  for (
    let i = 0;
    i < 40 &&
    !logged().some((line) => line.method === "notifications/cancelled");
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(
    logged().some((line) => line.method === "notifications/cancelled"),
  ).toBe(true);
  // A call already aborted before it starts never reaches the server.
  const before = new AbortController();
  before.abort();
  expect(
    (await rejection(connection.callTool("echo", {}, before.signal))).name,
  ).toBe("AbortError");
});

test("stdio: image and resource content become text placeholders; a 2 MB text result is cut to 1 MB with truncated: true", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "ok" });
  const media = await connection.callTool("echo", { text: "__media__" });
  expect(media.truncated).toBe(false);
  expect(media.content.every((item) => item.type === "text")).toBe(true);
  expect(media.content[0]?.text).toBe("[图片 12 KB，已省略]");
  expect(media.content[1]?.text).toContain("file:///a.txt");
  expect(media.content[1]?.text).toContain("inside");
  expect(media.content[2]?.text).toBe("after");

  const big = await connection.callTool("echo", { text: "__big__" });
  expect(big.truncated).toBe(true);
  const total = big.content.reduce(
    (sum, item) => sum + Buffer.byteLength(item.text),
    0,
  );
  expect(total).toBe(1_000_000);
});

test("stdio: env from the entry reaches the child; XIONGBAO_* from the parent does not", async () => {
  process.env.XIONGBAO_TEST_SECRET = "leak";
  try {
    const connection = await connect({
      FAKE_MCP_MODE: "ok",
      FROM_ENTRY: "yes",
    });
    const read = async (name: string) =>
      (await connection.callTool("echo", { text: `__env__:${name}` }))
        .content[0]?.text;
    expect(await read("FROM_ENTRY")).toBe("yes");
    expect(await read("XIONGBAO_TEST_SECRET")).toBe("<unset>");
  } finally {
    delete process.env.XIONGBAO_TEST_SECRET;
  }
});

test("stdio: close() ends the child and marks the connection closed", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "ok" });
  expect(connection.closed).toBe(false);
  await connection.close();
  expect(connection.closed).toBe(true);
  expect((await rejection(connection.listTools())).kind).toBe("connect");
});

test("http: json and sse responses both parse; the session id is echoed on later requests", async () => {
  for (const sse of [false, true]) {
    const server = startFakeHttpMcp({ sse });
    stops.push(server.stop);
    const connection = await connectApp({
      ref: "app_bbbbbbbbbbbbbbbbbbbbbb",
      name: "web",
      kind: "http",
      url: server.url,
      enabled: true,
    });
    open.push(connection);
    expect((await connection.listTools())[0]?.name).toBe("echo");
    expect(
      (await connection.callTool("echo", { text: `hi ${sse}` })).content[0]
        ?.text,
    ).toBe(`hi ${sse}`);
    const later = server.requests.filter(
      (request) => request.method !== "initialize",
    );
    expect(later.length).toBeGreaterThanOrEqual(3);
    expect(
      later.every((request) => request.sessionId?.startsWith("sess-")),
    ).toBe(true);
  }
});

test('http: connection refused rejects with kind "connect"', async () => {
  const server = startFakeHttpMcp({ sse: false });
  const url = server.url;
  server.stop();
  const error = await rejection(
    connectApp({
      ref: "app_bbbbbbbbbbbbbbbbbbbbbb",
      name: "web",
      kind: "http",
      url,
      enabled: true,
    }),
  );
  expect(error.kind).toBe("connect");
});

test('windows command shim: on win32 a bare command such as npx or bunx is launched as cmd.exe /d /s /c "npx ..."', () => {
  const entry = {
    ref: "app_aaaaaaaaaaaaaaaaaaaaaa",
    name: "n",
    kind: "stdio" as const,
    command: "npx",
    args: ["-y", "@scope/server", "C:\\My Files\\a b", 'say "hi"'],
    env: {},
    enabled: true,
  };
  const win = launchSpec(entry, "win32", {});
  expect(win.command).toBe("cmd.exe");
  expect(win.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(win.args).toHaveLength(4);
  expect(win.args[3]).toBe(
    '""npx" "-y" "@scope/server" "C:\\My Files\\a b" "say \\"hi\\"""',
  );
  expect(win.windowsVerbatimArguments).toBe(true);
  expect(
    launchSpec(entry, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })
      .command,
  ).toBe("C:\\Windows\\System32\\cmd.exe");
  // Trailing backslashes must not swallow the closing quote.
  const trailing = launchSpec({ ...entry, args: ["C:\\dir\\"] }, "win32", {});
  expect(trailing.args[3]).toBe('""npx" "C:\\dir\\\\""');

  for (const platform of ["linux", "darwin"] as const) {
    expect(launchSpec(entry, platform, {})).toEqual({
      command: "npx",
      args: entry.args,
    });
  }
});

test("childEnv drops XIONGBAO_* from the parent and lets the entry override the rest", () => {
  const env = childEnv(
    { PATH: "/bin", XIONGBAO_TOKEN: "t", KEEP: "1", OVER: "old" },
    { OVER: "new", XIONGBAO_MINE: "ok" },
  );
  expect(env).toEqual({
    PATH: "/bin",
    KEEP: "1",
    OVER: "new",
    XIONGBAO_MINE: "ok",
  });
});

test("stdio: a total cap applies to text plus structuredContent", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "ok" });
  const outcome = await connection.callTool("echo", { text: "__structured__" });
  expect(outcome.truncated).toBe(true);
  const total =
    outcome.content.reduce(
      (sum, item) => sum + Buffer.byteLength(item.text),
      0,
    ) + Buffer.byteLength(JSON.stringify(outcome.structuredContent ?? null));
  expect(total).toBeLessThanOrEqual(1_000_000);
});

test("stdio: connection.closed becomes true once the child has exited, and close() afterwards is safe", async () => {
  const connection = await connect({ FAKE_MCP_MODE: "ok" });
  const error = await rejection(
    connection.callTool("echo", { text: "__exit__" }),
  );
  expect(error.kind).toBe("connect");
  expect(connection.closed).toBe(true);
  await connection.close();
});

test("http: close() with a request in flight rejects with kind connect", async () => {
  const server = startFakeHttpMcp({ sse: false, delayMs: 2000 });
  stops.push(server.stop);
  const connection = await connectApp({
    ref: "app_bbbbbbbbbbbbbbbbbbbbbb",
    name: "web",
    kind: "http",
    url: server.url,
    enabled: true,
  });
  open.push(connection);
  const pending = rejection(connection.callTool("echo", { text: "x" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await connection.close();
  expect((await pending).kind).toBe("connect");
  expect(connection.closed).toBe(true);
});
