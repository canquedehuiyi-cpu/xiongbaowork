import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppHostError, createAppHost } from "../src/app-host";
import { type AppEntry, createAppRegistry } from "../src/apps";
import {
  type McpCallOutcome,
  type McpConnection,
  McpAppError,
  type McpTool,
} from "../src/mcp-client";

/* The app host with a fake `connect`: no process is started and no port is opened. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (text: string): McpCallOutcome => ({
  content: [{ type: "text", text }],
  isError: false,
  truncated: false,
});

function setup(
  opts: {
    tools?: McpTool[];
    call?: (name: string) => Promise<McpCallOutcome>;
    idleMs?: number;
    connect?: (entry: AppEntry) => Promise<McpConnection>;
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-host-"));
  dirs.push(dataDir);
  const registry = createAppRegistry({ dataDir });
  const entry = registry.add({
    name: "画图",
    kind: "stdio",
    command: "x",
    args: [],
    env: {},
  });
  const conns: Array<McpConnection & { dead: boolean; closeCount: number }> =
    [];
  const connect =
    opts.connect ??
    (async () => {
      const conn = {
        dead: false,
        closeCount: 0,
        get closed() {
          return conn.dead;
        },
        listTools: async () =>
          opts.tools ?? [{ name: "draw" }, { name: "erase" }],
        callTool: async (name: string) =>
          opts.call ? opts.call(name) : ok(`done ${name}`),
        close: async () => {
          conn.dead = true;
          conn.closeCount += 1;
        },
      };
      conns.push(conn);
      return conn;
    });
  const host = createAppHost(registry, { idleMs: opts.idleMs, connect });
  return { host, registry, entry, conns };
}

test("lazy: nothing is started until the first tools() call", async () => {
  const { host, entry, conns } = setup();
  expect(conns.length).toBe(0);
  expect((await host.tools(entry.ref)).map((t) => t.name)).toEqual([
    "draw",
    "erase",
  ]);
  expect(conns.length).toBe(1);
  await host.closeAll();
});

test("tools() cuts descriptions to 1024 bytes", async () => {
  const { host, entry } = setup({
    tools: [{ name: "draw", description: "字".repeat(2000) }],
  });
  const [tool] = await host.tools(entry.ref);
  const bytes = Buffer.byteLength(tool?.description ?? "");
  expect(bytes).toBeLessThanOrEqual(1024);
  expect(bytes).toBeGreaterThan(1000);
  await host.closeAll();
});

test("reuses one connection; closes it after idleMs of no use and reconnects next time", async () => {
  const { host, entry, conns } = setup({ idleMs: 40 });
  await host.tools(entry.ref);
  await host.call(entry.ref, "draw", {});
  expect(conns.length).toBe(1);
  await sleep(120);
  expect(conns[0]?.closeCount).toBe(1);
  await host.call(entry.ref, "draw", {});
  expect(conns.length).toBe(2);
  await host.closeAll();
});

test("serialises calls per app: two concurrent calls never overlap", async () => {
  let running = 0;
  let max = 0;
  const { host, entry } = setup({
    call: async (name) => {
      running += 1;
      max = Math.max(max, running);
      await sleep(20);
      running -= 1;
      return ok(name);
    },
  });
  const [a, b] = await Promise.all([
    host.call(entry.ref, "draw", {}),
    host.call(entry.ref, "erase", {}),
  ]);
  expect(max).toBe(1);
  expect(a.content[0]?.text).toBe("draw");
  expect(b.content[0]?.text).toBe("erase");
  await host.closeAll();
});

test("unknown tool name is refused before callTool reaches the connection", async () => {
  let reached = 0;
  const { host, entry } = setup({
    call: async () => {
      reached += 1;
      return ok("x");
    },
  });
  const error = await host.call(entry.ref, "nope", {}).catch((e) => e);
  expect(error).toBeInstanceOf(AppHostError);
  expect(error.kind).toBe("unknown_tool");
  expect(error.userMessage).toBe(
    "「画图」没有名为「nope」的工具（已有：draw、erase）。",
  );
  expect(reached).toBe(0);
  await host.closeAll();
});

test("a dead connection (closed) is replaced on the next call", async () => {
  const { host, entry, conns } = setup();
  await host.call(entry.ref, "draw", {});
  if (conns[0]) conns[0].dead = true;
  await host.call(entry.ref, "draw", {});
  expect(conns.length).toBe(2);
  await host.closeAll();
});

test("closeAll closes every open connection", async () => {
  const { host, entry, registry, conns } = setup();
  const other = registry.add({
    name: "表格",
    kind: "http",
    url: "http://127.0.0.1:9/mcp",
  });
  await host.tools(entry.ref);
  await host.tools(other.ref);
  expect(conns.length).toBe(2);
  await host.closeAll();
  expect(conns.map((c) => c.closeCount)).toEqual([1, 1]);
});

test("a disabled or unknown app is refused, and a disabled one is closed", async () => {
  const { host, entry, registry, conns } = setup();
  await host.tools(entry.ref);
  registry.setEnabled(entry.ref, false);
  const message = "这台电脑上没有这个本机应用，或它已停用。";
  const error = await host.call(entry.ref, "draw", {}).catch((e) => e);
  expect(error).toBeInstanceOf(AppHostError);
  expect(error.kind).toBe("unavailable");
  expect(error.userMessage).toBe(message);
  expect(conns[0]?.closeCount).toBe(1);
  const missing = await host
    .tools("app_AAAAAAAAAAAAAAAAAAAAAA")
    .catch((e) => e);
  expect(missing.userMessage).toBe(message);
});

test("an edited entry drops the old connection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "app-host-"));
  dirs.push(dataDir);
  const registry = createAppRegistry({ dataDir });
  const entry = registry.add({
    name: "网页应用",
    kind: "http",
    url: "http://127.0.0.1:1/mcp",
  });
  const urls: string[] = [];
  const closes: string[] = [];
  const host = createAppHost(registry, {
    connect: async (e) => {
      const url = e.kind === "http" ? e.url : "";
      urls.push(url);
      return {
        closed: false,
        listTools: async () => [{ name: "t" }],
        callTool: async () => ok("x"),
        close: async () => {
          closes.push(url);
        },
      };
    },
  });
  await host.tools(entry.ref);
  await Bun.write(
    join(dataDir, "runner-apps.json"),
    JSON.stringify({
      apps: [{ ...entry, url: "http://127.0.0.1:2/mcp" }],
    }),
  );
  await host.tools(entry.ref);
  expect(urls).toEqual(["http://127.0.0.1:1/mcp", "http://127.0.0.1:2/mcp"]);
  expect(closes).toEqual(["http://127.0.0.1:1/mcp"]);
  await host.closeAll();
});

test("errors are worded in Chinese and keep the original as cause", async () => {
  const failing = (error: unknown, entryName = "画图") => {
    const { host, entry } = setup({
      connect: async () => {
        throw error;
      },
    });
    return { host, entry, name: entryName };
  };
  const start = new McpAppError("start", "x", "boom");
  const a = failing(start);
  const startError = await a.host.tools(a.entry.ref).catch((e) => e);
  expect(startError.userMessage).toBe("「画图」启动失败：boom");
  expect(startError.kind).toBe("start");
  expect(startError.cause).toBe(start);

  // http connect failure
  const dataDir = mkdtempSync(join(tmpdir(), "app-host-"));
  dirs.push(dataDir);
  const registry = createAppRegistry({ dataDir });
  const web = registry.add({
    name: "网页",
    kind: "http",
    url: "http://localhost:1/mcp",
  });
  const refused = new McpAppError("connect", "refused");
  const host = createAppHost(registry, {
    connect: async () => {
      throw refused;
    },
  });
  const connectError = await host.tools(web.ref).catch((e) => e);
  expect(connectError.userMessage).toBe(
    "连不上「网页」的本机地址，请确认软件已打开。",
  );
  expect(connectError.cause).toBe(refused);
});

test("a timeout during a call names the seconds, is phase call, and an abort passes through", async () => {
  const timeout = new McpAppError("timeout", "slow");
  const { host, entry } = setup({
    call: async () => {
      throw timeout;
    },
  });
  const error = await host.call(entry.ref, "draw", {}).catch((e) => e);
  expect(error.userMessage).toBe("「画图」在 120 秒内没有返回。");
  expect(error.kind).toBe("timeout");
  expect(error.phase).toBe("call");
  expect(error.cause).toBe(timeout);
  await host.closeAll();

  const abort = new Error("aborted");
  abort.name = "AbortError";
  const second = setup({
    call: async () => {
      throw abort;
    },
  });
  const aborted = await second.host
    .call(second.entry.ref, "draw", {})
    .catch((e) => e);
  expect(aborted).toBe(abort);
  await second.host.closeAll();
});
