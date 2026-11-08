import { afterAll, afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../src/apps";
import {
  childCwd,
  childEnv,
  connectApp,
  launchSpec,
  type McpConnection,
  McpAppError,
  resolveWindowsCommand,
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

test('http: connection refused rejects with kind "unreachable"', async () => {
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
  expect(error.kind).toBe("unreachable");
});

test('http: an app closed after the handshake rejects the next call with kind "unreachable", never "connect"', async () => {
  const server = startFakeHttpMcp({ sse: false });
  const connection = await connectApp({
    ref: "app_bbbbbbbbbbbbbbbbbbbbbb",
    name: "web",
    kind: "http",
    url: server.url,
    enabled: true,
  });
  open.push(connection);
  expect((await connection.listTools())[0]?.name).toBe("echo");
  server.stop();
  // The request never reached the app: nothing can have happened there.
  const error = await rejection(connection.callTool("echo", { text: "x" }));
  expect(error.kind).toBe("unreachable");
  // Not reused: the next use connects afresh.
  expect(connection.closed).toBe(true);
});

test("http: a redirect is not followed, so the body is never posted anywhere else", async () => {
  let elsewhere = 0;
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      elsewhere += 1;
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  stops.push(() => other.stop(true));
  const redirecting = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 307,
        headers: { Location: `http://127.0.0.1:${other.port}/mcp` },
      }),
  });
  stops.push(() => redirecting.stop(true));
  const error = await rejection(
    connectApp({
      ref: "app_bbbbbbbbbbbbbbbbbbbbbb",
      name: "web",
      kind: "http",
      url: `http://127.0.0.1:${redirecting.port}/mcp`,
      enabled: true,
    }),
  );
  expect(error.kind).toBe("protocol");
  expect(elsewhere).toBe(0);
});

test("http: a loopback app is reached directly, whatever HTTP_PROXY says", async () => {
  const saved: Record<string, string | undefined> = {};
  const names = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  for (const name of names) saved[name] = process.env[name];
  // A proxy nobody answers on, and nothing exempted from it.
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
  process.env.http_proxy = "http://127.0.0.1:9";
  process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  process.env.https_proxy = "http://127.0.0.1:9";
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
  try {
    const server = startFakeHttpMcp({ sse: false });
    stops.push(server.stop);
    const connection = await connectApp({
      ref: "app_bbbbbbbbbbbbbbbbbbbbbb",
      name: "web",
      kind: "http",
      url: server.url.replace("127.0.0.1", "localhost"),
      enabled: true,
    });
    open.push(connection);
    expect((await connection.listTools())[0]?.name).toBe("echo");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

/** A Windows machine with Node installed the usual way, for `launchSpec`'s PATH search. */
const NODE_DIR = "C:\\Program Files\\nodejs";
const NPM_DIR = "C:\\Users\\u\\AppData\\Roaming\\npm";
const winEnv = {
  Path: `C:\\Windows\\System32;"${NODE_DIR}";${NPM_DIR}`,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};
const winFiles = new Set(
  [
    `${NODE_DIR}\\npx.cmd`,
    // npm ships a POSIX shell script beside the shim: it is never the one to run.
    `${NODE_DIR}\\npx`,
    `${NODE_DIR}\\node.exe`,
    `${NPM_DIR}\\pnpm.CMD`,
    "C:\\Windows\\System32\\cmd.exe",
  ].map((path) => path.toLowerCase()),
);
const winIsFile = (path: string) => winFiles.has(path.toLowerCase());

function winEntry(command: string, args: string[] = []) {
  return {
    ref: "app_aaaaaaaaaaaaaaaaaaaaaa",
    name: "n",
    kind: "stdio" as const,
    command,
    args,
    env: {},
    enabled: true,
  };
}

function launchFailure(
  command: string,
  env: Record<string, string>,
): McpAppError {
  try {
    launchSpec(winEntry(command), "win32", env, winIsFile);
  } catch (error) {
    return error as McpAppError;
  }
  throw new Error("expected launchSpec to throw");
}

test("launchSpec: a bundled entry starts the bundled runtime with x --bun on win32 and linux, never through cmd.exe, and carries its env", () => {
  const entry = {
    ...winEntry("bunx", ["@scope/server", "a b"]),
    runtime: "bundled" as const,
  };
  const runtime = {
    command: "C:\\Device\\openbot-runner.exe",
    prefix: ["x", "--bun"],
    env: { BUN_BE_BUN: "1" },
  };
  for (const platform of ["win32", "linux"] as const) {
    // No PATH, no shims: the bundled runtime needs nothing from the owner's machine.
    const spec = launchSpec(
      entry,
      platform,
      {},
      () => false,
      () => runtime,
    );
    expect(spec).toEqual({
      command: "C:\\Device\\openbot-runner.exe",
      args: ["x", "--bun", "@scope/server", "a b"],
      env: { BUN_BE_BUN: "1" },
    });
    expect(spec.windowsVerbatimArguments).toBeUndefined();
  }
  // Without a runtime it fails as a start error in Chinese, not as a missing command.
  let failure: unknown;
  try {
    launchSpec(
      entry,
      "win32",
      {},
      () => false,
      () => undefined,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(McpAppError);
  expect((failure as McpAppError).kind).toBe("start");
  expect((failure as McpAppError).hint).toBe(
    "设备端自带的运行时不可用，请重新安装设备端。",
  );
  // The real thing resolves to this very process under test.
  expect(launchSpec(entry, "linux", {}).command).toBe(process.execPath);
});

test('windows command shim: on win32 a bare command such as npx or bunx is launched as cmd.exe /d /s /c "<its absolute path> ..."', () => {
  const entry = winEntry("npx", [
    "-y",
    "@scope/server",
    "C:\\My Files\\a b",
    'say "hi"',
  ]);
  const win = launchSpec(entry, "win32", winEnv, winIsFile);
  expect(win.command).toBe("cmd.exe");
  expect(win.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(win.args).toHaveLength(4);
  expect(win.args[3]).toBe(
    '""C:\\Program Files\\nodejs\\npx.cmd" "-y" "@scope/server" "C:\\My Files\\a b" "say \\"hi\\"""',
  );
  expect(win.windowsVerbatimArguments).toBe(true);
  expect(
    launchSpec(
      entry,
      "win32",
      { ...winEnv, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      winIsFile,
    ).command,
  ).toBe("C:\\Windows\\System32\\cmd.exe");
  // Trailing backslashes must not swallow the closing quote.
  const trailing = launchSpec(
    { ...entry, args: ["C:\\dir\\"] },
    "win32",
    winEnv,
    winIsFile,
  );
  expect(trailing.args[3]).toBe(
    '""C:\\Program Files\\nodejs\\npx.cmd" "C:\\dir\\\\""',
  );

  for (const platform of ["linux", "darwin"] as const) {
    expect(launchSpec(entry, platform, {}, () => false)).toEqual({
      command: "npx",
      args: entry.args,
    });
  }
});

/*
 * Why the absolute path: a batch file that cmd.exe found through PATH under a quoted name sees
 * `%~dp0` as the CURRENT folder, not its own, so npx.cmd looked for node_modules\npm\bin\npx-cli.js
 * in the runner's folder ("Cannot find module ...\runner\node_modules\npm\bin\npx-cli.js").
 */
test("windows command shim: a bare command is looked up in the child's PATH with PATHEXT, in PATH order", () => {
  expect(resolveWindowsCommand("npx", winEnv, winIsFile)).toBe(
    `${NODE_DIR}\\npx.cmd`,
  );
  expect(resolveWindowsCommand("node", winEnv, winIsFile)).toBe(
    `${NODE_DIR}\\node.exe`,
  );
  // A name that already has its extension, and a shim whose extension is in capitals on disk
  // (Windows names are case-insensitive, so either spelling runs it).
  expect(resolveWindowsCommand("npx.cmd", winEnv, winIsFile)).toBe(
    `${NODE_DIR}\\npx.cmd`,
  );
  expect(resolveWindowsCommand("pnpm", winEnv, winIsFile)).toBe(
    `${NPM_DIR}\\pnpm.cmd`,
  );
  // PATHEXT decides which extensions count; without one, cmd's own default list applies.
  expect(
    resolveWindowsCommand("npx", { ...winEnv, PATHEXT: ".EXE" }, winIsFile),
  ).toBeUndefined();
  expect(resolveWindowsCommand("npx", { Path: winEnv.Path }, winIsFile)).toBe(
    `${NODE_DIR}\\npx.cmd`,
  );
  // A relative PATH folder depends on where the app starts, so it is never searched.
  expect(
    resolveWindowsCommand("npx", { ...winEnv, Path: ".;bin" }, (path) =>
      path.toLowerCase().endsWith("npx.cmd"),
    ),
  ).toBeUndefined();
  // The first PATH folder that has it wins.
  const withTools = (path: string) =>
    winIsFile(path) || path.toLowerCase() === "d:\\tools\\npx.bat";
  expect(
    resolveWindowsCommand(
      "npx",
      { ...winEnv, Path: `D:\\tools;${winEnv.Path}` },
      withTools,
    ),
  ).toBe("D:\\tools\\npx.bat");
  // The PATH searched is the child's: an entry's own PATH comes after the parent's in the child's
  // environment, whatever its spelling, and is the one that counts.
  expect(
    resolveWindowsCommand("npx", { ...winEnv, PATH: "D:\\tools" }, withTools),
  ).toBe("D:\\tools\\npx.bat");
  const child = childEnv(winEnv, { PATH: "D:\\tools" });
  expect(launchSpec(winEntry("npx"), "win32", child, withTools).args[3]).toBe(
    '""D:\\tools\\npx.bat""',
  );
  // A path, absolute or relative, is the owner's choice and is left exactly as written.
  for (const command of [
    `${NODE_DIR}\\npx.cmd`,
    "D:/tools/server",
    ".\\bin\\server.cmd",
    "C:server.cmd",
  ]) {
    expect(resolveWindowsCommand(command, {}, () => false)).toBe(command);
    expect(
      launchSpec(winEntry(command), "win32", {}, () => false).args[3],
    ).toBe(`""${command}""`);
  }
});

test("windows command shim: a command that is not on PATH fails to start with a clear Chinese reason", () => {
  const uvx = launchFailure("uvx", winEnv);
  expect(uvx).toBeInstanceOf(McpAppError);
  expect(uvx.kind).toBe("start");
  expect(uvx.hint).toBe(
    "找不到命令 uvx，请确认已安装（例如 uv），并重启设备端。",
  );
  const npx = launchFailure("npx", { PATHEXT: winEnv.PATHEXT });
  expect(npx.kind).toBe("start");
  expect(npx.hint).toBe(
    "找不到命令 npx，请确认已安装（例如 Node.js），并重启设备端。",
  );
  expect(launchFailure("my-server", winEnv).hint).toBe(
    "找不到命令 my-server，请确认已安装并已加入 PATH，然后重启设备端。",
  );
});

test("stdio: an app without a working folder starts in the home folder, not the runner's own", async () => {
  expect(childCwd(stdioEntry(), "/home/u")).toBe("/home/u");
  expect(childCwd({ ...winEntry("x"), cwd: "/work" }, "/home/u")).toBe("/work");
  expect(childCwd({ ...winEntry("x"), cwd: "" }, "/home/u")).toBe("/home/u");
  const connection = await connect();
  const reply = await connection.callTool("echo", { text: "__cwd__" });
  expect(realpathSync(reply.content[0]?.text ?? "")).toBe(
    realpathSync(homedir()),
  );
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
