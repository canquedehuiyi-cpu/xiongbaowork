import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAppHost } from "../src/app-host";
import { createAppRegistry } from "../src/apps";
import { createRunnerExecutor } from "../src/execute";

/* The two app actions through the real executor, against the real fake stdio MCP server. */

const FIXTURE = resolve(import.meta.dir, "fixtures/fake-mcp-stdio.ts");
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: { env?: Record<string, string>; callMs?: number } = {},
) {
  const base = mkdtempSync(join(tmpdir(), "apps-exec-"));
  dirs.push(base);
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const registry = createAppRegistry({ dataDir: base });
  const entry = registry.add({
    kind: "stdio",
    name: "假应用",
    command: process.execPath,
    args: [FIXTURE],
    env: options.env ?? {},
  });
  const host = createAppHost(
    registry,
    options.callMs ? { timeouts: { callMs: options.callMs } } : undefined,
  );
  const execute = createRunnerExecutor(
    workspace,
    undefined,
    undefined,
    undefined,
    host,
  );
  closers.push(() => execute.closeApps());
  return { entry, execute };
}

test("apps.tools and apps.call reach the fake server through the executor", async () => {
  const { entry, execute } = setup();
  const listed = await execute({
    action: "apps.tools",
    payload: { app: entry.ref },
  });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  const names = (listed.output as { tools: { name: string }[] }).tools.map(
    (tool) => tool.name,
  );
  expect(names).toEqual(["echo", "write_note", "wipe"]);

  const called = await execute({
    action: "apps.call",
    payload: { app: entry.ref, tool: "echo", args: { text: "你好" } },
  });
  expect(called.ok).toBe(true);
  if (!called.ok) return;
  expect(JSON.stringify(called.output)).toContain("你好");
});

test("apps.call with an unknown ref answers the 中文 error", async () => {
  const { execute } = setup();
  const outcome = await execute({
    action: "apps.call",
    payload: { app: "app_AAAAAAAAAAAAAAAAAAAAAA", tool: "echo", args: {} },
  });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error).toContain("没有这个本机应用");
  expect(outcome.outcomeUnknown).toBeUndefined();
  const tools = await execute({
    action: "apps.tools",
    payload: { app: "app_AAAAAAAAAAAAAAAAAAAAAA" },
  });
  expect(tools.ok).toBe(false);
  expect(
    (tools as { outcomeUnknown?: boolean }).outcomeUnknown,
  ).toBeUndefined();
});

test("apps.call aborted mid-call answers outcomeUnknown", async () => {
  const { entry, execute } = setup();
  const controller = new AbortController();
  const running = execute({
    action: "apps.call",
    payload: { app: entry.ref, tool: "echo", args: { text: "__hang__" } },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1500);
  const outcome = await running;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.outcomeUnknown).toBe(true);
  expect(outcome.error).toContain("已在设备上停止");
});

test("a missing app name in the payload is refused without touching the host", async () => {
  const { execute } = setup();
  const outcome = await execute({ action: "apps.call", payload: {} });
  expect(outcome).toEqual({
    ok: false,
    error: "这台电脑上没有这个本机应用，或它已停用。",
  });
});

test("a missing tool name gets its own error, not the missing-app one", async () => {
  const { entry, execute } = setup();
  for (const tool of [undefined, "", 7]) {
    const outcome = await execute({
      action: "apps.call",
      payload: { app: entry.ref, tool },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("哪个工具");
    expect(outcome.error).not.toContain("没有这个本机应用");
  }
});

test("args that are not a plain object are refused, never run as empty arguments", async () => {
  const { entry, execute } = setup();
  for (const args of [[1, 2], "text", 5, null, true]) {
    const outcome = await execute({
      action: "apps.call",
      payload: { app: entry.ref, tool: "echo", args },
    });
    expect(outcome).toEqual({
      ok: false,
      error: "本机应用的参数格式不对，应为一个 JSON 对象。",
    });
  }
  // Absent args still means "none".
  const none = await execute({
    action: "apps.call",
    payload: { app: entry.ref, tool: "echo" },
  });
  expect(none.ok).toBe(true);
});

test("a call that times out answers outcomeUnknown", async () => {
  const { entry, execute } = setup({ callMs: 300 });
  const outcome = await execute({
    action: "apps.call",
    payload: { app: entry.ref, tool: "echo", args: { text: "__hang__" } },
  });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.outcomeUnknown).toBe(true);
  expect(outcome.error).toContain("没有返回");
});

test("failures before the call was sent are not outcomeUnknown", async () => {
  const dead = setup({ env: { FAKE_MCP_MODE: "exit" } });
  const started = await dead.execute({
    action: "apps.call",
    payload: { app: dead.entry.ref, tool: "echo", args: {} },
  });
  expect(started.ok).toBe(false);
  expect(
    (started as { outcomeUnknown?: boolean }).outcomeUnknown,
  ).toBeUndefined();

  const { entry, execute } = setup();
  const unknownTool = await execute({
    action: "apps.call",
    payload: { app: entry.ref, tool: "nope", args: {} },
  });
  expect(unknownTool.ok).toBe(false);
  expect(
    (unknownTool as { outcomeUnknown?: boolean }).outcomeUnknown,
  ).toBeUndefined();
});
