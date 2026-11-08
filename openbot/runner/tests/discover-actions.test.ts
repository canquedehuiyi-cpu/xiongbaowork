import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { createAppHost } from "../src/app-host";
import {
  APPS_FILE,
  type AppEntry,
  createAppRegistry,
  MAX_APPS,
} from "../src/apps";
import {
  CANDIDATE_EXPIRED,
  CANDIDATE_TTL_MS,
  DISCOVER_KEY_FAILED,
  type DiscoverDeps,
} from "../src/discover";
import {
  createDiscoverActions,
  DISCOVER_ACTIONS,
  DISCOVER_FAILED,
  type DiscoverActions,
} from "../src/discover-actions";
import { INSTALLED_LIMIT } from "../src/discover-installed";
import { createRunnerDispatcher } from "../src/dispatch";
import { createRunnerExecutor } from "../src/execute";
import { createActionJournal } from "../src/journal";
import { McpAppError, type McpConnection } from "../src/mcp-client";

/*
 * `apps.discover` through the real executor: discovery answers what this machine could offer, by
 * name, with nothing that says how to start it. The machine (files, registry, PATH, clock) is
 * injected, so the Windows branch runs here.
 */

const dirs: string[] = [];
const hosts: ReturnType<typeof createAppHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeAll();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = resolve(import.meta.dir, "fixtures/fake-mcp-stdio.ts");

const APPDATA = "C:\\Users\\me\\AppData\\Roaming";
const USERPROFILE = "C:\\Users\\me";
const CLAUDE_DESKTOP = win32.join(
  APPDATA,
  "Claude",
  "claude_desktop_config.json",
);
const CURSOR = win32.join(USERPROFILE, ".cursor", "mcp.json");
const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);

function setup(
  over: Partial<DiscoverDeps> & {
    installed?: unknown[];
    /** The host `apps.enable` tests with; the real one (starting the fixture) by default. */
    hostOf?: (
      registry: ReturnType<typeof createAppRegistry>,
    ) => ReturnType<typeof createAppHost>;
  } = {},
  files: Record<string, unknown> = {
    [CLAUDE_DESKTOP]: {
      mcpServers: {
        笔记: {
          command: "npx",
          args: ["-y", "@acme/notes-mcp"],
          env: { API_KEY: "sk-test-secret" },
        },
      },
    },
    [CURSOR]: {
      mcpServers: {
        仓库: {
          command: "C:\\Users\\me\\proj\\server.exe",
          args: ["--root", "C:\\Users\\me\\proj"],
          env: {},
        },
      },
    },
  },
) {
  const base = mkdtempSync(join(tmpdir(), "discover-actions-"));
  dirs.push(base);
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const registry = createAppRegistry({ dataDir: base });
  let now = T0;
  const reads = { installed: 0 };
  const { installed, hostOf, ...deps } = over;
  const host = (hostOf ?? createAppHost)(registry);
  hosts.push(host);
  const discovery = createDiscoverActions({
    dataDir: base,
    registry,
    host,
    deps: {
      platform: "win32",
      env: { APPDATA, USERPROFILE },
      readText: (path) =>
        files[path] === undefined ? undefined : JSON.stringify(files[path]),
      readInstalled: async () => {
        reads.installed += 1;
        return (installed ?? [{ DisplayName: "微信" }]) as never;
      },
      resolveCommand: (command) =>
        command.endsWith(".exe") ? command : undefined,
      now: () => now,
      ...deps,
    },
  });
  const execute = createRunnerExecutor(
    workspace,
    undefined,
    undefined,
    undefined,
    undefined,
    { discovery },
  );
  return {
    execute,
    discovery,
    registry,
    base,
    reads,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("apps.discover answers candidates and installed through the executor", async () => {
  expect([...DISCOVER_ACTIONS]).toEqual(["apps.discover", "apps.enable"]);
  const { execute } = setup();
  const outcome = await execute({ action: "apps.discover", payload: {} });
  expect(outcome).toEqual({
    ok: true,
    output: {
      platform: "win32",
      candidates: [
        expect.objectContaining({
          name: "笔记",
          source: "claude-desktop",
          kind: "stdio",
          status: "ready",
          enabled: false,
        }),
        expect.objectContaining({
          name: "仓库",
          source: "cursor",
          status: "ready",
        }),
      ],
      installed: ["微信"],
    },
  });
  // Names leave; how to start them does not.
  const text = JSON.stringify(outcome);
  for (const secret of [
    "sk-test-secret",
    "API_KEY",
    "@acme/notes-mcp",
    "npx",
    "server.exe",
    "C:\\\\Users",
    "proj",
  ]) {
    expect(text).not.toContain(secret);
  }
});

test("apps.discover with a candidate ref answers only that candidate, or none once expired", async () => {
  const { execute, reads, setNow } = setup();
  const listed = await execute({ action: "apps.discover", payload: {} });
  if (!listed.ok) throw new Error(listed.error);
  const second = (listed.output as { candidates: { ref: string }[] })
    .candidates[1];
  if (!second) throw new Error("no second candidate");
  expect(reads.installed).toBe(1);

  setNow(T0 + CANDIDATE_TTL_MS - 1_000);
  const one = await execute({
    action: "apps.discover",
    payload: { candidate: second.ref, tenantId: "t", botId: "b" },
  });
  expect(one).toEqual({
    ok: true,
    output: {
      platform: "win32",
      candidates: [expect.objectContaining({ ref: second.ref, name: "仓库" })],
    },
  });
  // A lookup by reference never reads the installed programs.
  expect(reads.installed).toBe(1);

  setNow(T0 + CANDIDATE_TTL_MS + 1_000);
  expect(
    await execute({
      action: "apps.discover",
      payload: { candidate: second.ref },
    }),
  ).toEqual({ ok: true, output: { platform: "win32", candidates: [] } });
  expect(
    await execute({
      action: "apps.discover",
      payload: { candidate: "cand_nonsense" },
    }),
  ).toEqual({ ok: true, output: { platform: "win32", candidates: [] } });
  const wrong = await execute({
    action: "apps.discover",
    payload: { candidate: 42 },
  });
  expect(wrong.ok).toBe(false);
  expect("outcomeUnknown" in wrong).toBe(false);
});

test('an executor without discovery still answers Nothing on this machine handles "apps.discover"', async () => {
  const base = mkdtempSync(join(tmpdir(), "discover-actions-"));
  dirs.push(base);
  for (const execute of [
    createRunnerExecutor(base),
    createRunnerExecutor(base, undefined, undefined, undefined, undefined, {}),
  ]) {
    expect(await execute({ action: "apps.discover", payload: {} })).toEqual({
      ok: false,
      error: 'Nothing on this machine handles "apps.discover".',
    });
  }
  // And discovery only takes its own actions: anything else still reaches the executor's switch.
  const { execute } = setup();
  expect(await execute({ action: "apps.nope", payload: {} })).toEqual({
    ok: false,
    error: 'Nothing on this machine handles "apps.nope".',
  });
});

test("more than INSTALLED_LIMIT installed programs: sorted, the first 200 kept, the rest counted", async () => {
  const many = Array.from({ length: INSTALLED_LIMIT + 7 }, (_, i) => ({
    DisplayName: `程序 ${String(INSTALLED_LIMIT + 7 - i).padStart(3, "0")}`,
  }));
  const { execute } = setup({ installed: many });
  const outcome = await execute({ action: "apps.discover", payload: {} });
  if (!outcome.ok) throw new Error(outcome.error);
  const output = outcome.output as {
    installed: string[];
    installedTruncated?: number;
  };
  expect(output.installed).toHaveLength(INSTALLED_LIMIT);
  expect(output.installed[0]).toBe("程序 001");
  expect(output.installed[INSTALLED_LIMIT - 1]).toBe(
    `程序 ${String(INSTALLED_LIMIT).padStart(3, "0")}`,
  );
  expect(output.installedTruncated).toBe(7);
  // Within the limit nothing is said about truncation.
  const few = await setup().execute({ action: "apps.discover", payload: {} });
  if (!few.ok) throw new Error(few.error);
  expect("installedTruncated" in (few.output as object)).toBe(false);
});

test("a discovery that cannot run answers its fixed message, never a path and never outcomeUnknown", async () => {
  const base = mkdtempSync(join(tmpdir(), "discover-actions-"));
  dirs.push(base);
  // The data folder is a file: the signing key cannot be saved under it.
  const blocked = join(base, "not-a-folder");
  await Bun.write(blocked, "x");
  const discovery = createDiscoverActions({
    dataDir: blocked,
    registry: createAppRegistry({ dataDir: base }),
    deps: {
      platform: "win32",
      env: {},
      readText: () => undefined,
      readInstalled: async () => [],
      resolveCommand: () => undefined,
    },
  });
  const outcome = await discovery("apps.discover", {});
  expect(outcome).toEqual({ ok: false, error: DISCOVER_KEY_FAILED });
  expect(JSON.stringify(outcome)).not.toContain(base);

  // Something unforeseen: a fixed sentence too, not the error's own text.
  const broken = createDiscoverActions({
    dataDir: base,
    registry: createAppRegistry({ dataDir: base }),
    deps: {
      platform: "win32",
      env: {},
      readText: () => undefined,
      readInstalled: async () => [],
      resolveCommand: () => undefined,
      now: () => {
        throw new Error(`clock failed at ${base}`);
      },
    },
  });
  const failed = await broken("apps.discover", {});
  expect(failed).toEqual({ ok: false, error: DISCOVER_FAILED });
  expect(DISCOVER_FAILED).toBe("本机应用发现这次没有成功。");
  expect(JSON.stringify(failed)).not.toContain(base);
  expect("outcomeUnknown" in failed).toBe(false);
});

test("off Windows, apps.discover answers empty lists and reads nothing", async () => {
  let reads = 0;
  const { execute } = setup({
    platform: "linux",
    readText: () => {
      reads += 1;
      return undefined;
    },
    readInstalled: async () => {
      reads += 1;
      return [];
    },
  });
  expect(await execute({ action: "apps.discover", payload: {} })).toEqual({
    ok: true,
    output: { platform: "linux", candidates: [], installed: [] },
  });
  expect(reads).toBe(0);
});

test("a discovery stopped while it runs answers 已在设备上停止。, never outcomeUnknown", async () => {
  const controller = new AbortController();
  const { discovery } = setup({
    readInstalled: async () => {
      controller.abort();
      return [];
    },
  });
  const outcome = await discovery("apps.discover", {}, controller.signal);
  expect(outcome).toEqual({ ok: false, error: "已在设备上停止。" });
  expect("outcomeUnknown" in outcome).toBe(false);
});

test("a discovery handler that rejects or throws neither pauses the device nor leaks its message, through the real dispatcher and journal", async () => {
  const base = mkdtempSync(join(tmpdir(), "discover-actions-"));
  dirs.push(base);
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const leak = "C:\\Users\\me\\secret-folder";
  const handlers: Record<string, DiscoverActions> = {
    rejects: async () => {
      throw new Error(`async boom at ${leak}`);
    },
    throws: () => {
      throw new Error(`sync boom at ${leak}`);
    },
  };
  const journal = createActionJournal(join(base, "actions.sqlite"));
  try {
    for (const [label, discovery] of Object.entries(handlers)) {
      const execute = createRunnerExecutor(
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        { discovery },
      );
      const dispatch = createRunnerDispatcher(journal, execute);
      const frames: Record<string, unknown>[] = [];
      await dispatch(
        "local/device",
        {
          type: "action",
          id: label,
          key: label,
          action: "apps.discover",
          payload: {},
        },
        (frame) => frames.push(frame),
      );
      expect(frames).toEqual([
        { type: "result", id: label, ok: false, error: DISCOVER_FAILED },
      ]);
      expect(JSON.stringify(frames)).not.toContain("secret-folder");
      expect(JSON.stringify(frames)).not.toContain("boom");
    }
  } finally {
    journal.close();
  }
});

// --- apps.enable: a discovered candidate becomes a registered app ---

type Listed = {
  ref: string;
  name: string;
  status: string;
  enabled: boolean;
  app?: string;
};

/** Claude Desktop's config holding just these servers. */
const desktop = (servers: Record<string, unknown>) => ({
  [CLAUDE_DESKTOP]: { mcpServers: servers },
});

/** The fixture (this bun) and any `.exe` are installed; nothing else is. */
const resolveFixture = (command: string) =>
  command === process.execPath || command.endsWith(".exe")
    ? command
    : undefined;

async function listed(
  execute: ReturnType<typeof setup>["execute"],
): Promise<Listed[]> {
  const outcome = await execute({ action: "apps.discover", payload: {} });
  if (!outcome.ok) throw new Error(outcome.error);
  return (outcome.output as { candidates: Listed[] }).candidates;
}

async function refOf(
  execute: ReturnType<typeof setup>["execute"],
  name: string,
): Promise<string> {
  const found = (await listed(execute)).find((item) => item.name === name);
  if (!found) throw new Error(`no candidate named ${name}`);
  return found.ref;
}

/**
 * A host whose apps answer one tool without starting anything; it records each entry it connects
 * and the ref of each connection closed. With `failList`, listing the tools fails the way a
 * garbled answer does, leaving the connection open.
 */
function fakeHost(
  connected: AppEntry[],
  opts: { failList?: boolean; closedRefs?: string[] } = {},
) {
  return (registry: ReturnType<typeof createAppRegistry>) =>
    createAppHost(registry, {
      connect: async (entry): Promise<McpConnection> => {
        connected.push(entry);
        let closed = false;
        return {
          get closed() {
            return closed;
          },
          listTools: async () => {
            if (opts.failList) throw new McpAppError("protocol", "garbled");
            return [{ name: "read_note" }];
          },
          callTool: async () => ({
            content: [],
            isError: false,
            truncated: false,
          }),
          close: async () => {
            closed = true;
            opts.closedRefs?.push(entry.ref);
          },
        };
      },
    });
}

/** The app file as written, or "" when nothing was ever written. */
function appsFile(base: string): string {
  const file = join(base, APPS_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test("apps.enable writes the candidate, tests it and answers its tools", async () => {
  const { execute, registry } = setup(
    { resolveCommand: resolveFixture },
    desktop({
      假应用: {
        command: process.execPath,
        args: [FIXTURE],
        env: { FIXTURE_TOKEN: "sk-test-secret" },
      },
    }),
  );
  const ref = await refOf(execute, "假应用");
  const outcome = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  if (!outcome.ok) throw new Error(outcome.error);
  const output = outcome.output as {
    app: { ref: string; name: string };
    tools: { name: string }[];
  };
  const [entry] = registry.list();
  if (!entry) throw new Error("nothing was registered");
  expect(output.app).toEqual({ ref: entry.ref, name: "假应用" });
  expect(output.tools.map((tool) => tool.name)).toEqual([
    "echo",
    "write_note",
    "wipe",
  ]);
  expect(entry).toMatchObject({
    name: "假应用",
    kind: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: { FIXTURE_TOKEN: "sk-test-secret" },
    enabled: true,
  });
  expect("runtime" in entry).toBe(false);
  // How to start it stays on this machine.
  const text = JSON.stringify(outcome);
  for (const secret of [
    "sk-test-secret",
    "FIXTURE_TOKEN",
    "fake-mcp-stdio",
    process.execPath,
  ]) {
    expect(text).not.toContain(secret);
  }
  // And the next discovery says it is enabled, as that app.
  expect((await listed(execute))[0]).toMatchObject({
    name: "假应用",
    enabled: true,
    app: entry.ref,
  });
}, 20_000);

test("apps.enable stores npx -y pkg as the bundled runtime, with the env value copied only into runner-apps.json", async () => {
  const connected: AppEntry[] = [];
  const { execute, registry, base } = setup({
    hostOf: fakeHost(connected),
  });
  const ref = await refOf(execute, "笔记");
  const outcome = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  if (!outcome.ok) throw new Error(outcome.error);
  const [entry] = registry.list();
  expect(entry).toMatchObject({
    name: "笔记",
    kind: "stdio",
    command: "bunx",
    runtime: "bundled",
    args: ["@acme/notes-mcp"],
    env: { API_KEY: "sk-test-secret" },
    enabled: true,
  });
  // The file holds the real value and the runtime; the action's output holds neither.
  const file = JSON.parse(appsFile(base)) as { apps: AppEntry[] };
  expect(file.apps[0]).toMatchObject({
    runtime: "bundled",
    env: { API_KEY: "sk-test-secret" },
  });
  expect(outcome).toEqual({
    ok: true,
    output: {
      app: { ref: entry?.ref, name: "笔记" },
      tools: [{ name: "read_note" }],
    },
  });
  const text = JSON.stringify(outcome);
  for (const secret of [
    "sk-test-secret",
    "API_KEY",
    "@acme/notes-mcp",
    "bunx",
    "bundled",
    "npx",
  ]) {
    expect(text).not.toContain(secret);
  }
  // The connection test ran the stored entry.
  expect(connected.map((app) => app.ref)).toEqual([entry?.ref ?? ""]);
});

test("an enabled npm candidate is reported enabled on the next discovery, whether written npx pkg or C:\\…\\npx.cmd", async () => {
  const connected: AppEntry[] = [];
  const { execute, registry } = setup(
    { hostOf: fakeHost(connected) },
    desktop({
      无确认: { command: "npx", args: ["@acme/plain-mcp", "--port", "0"] },
      全路径: {
        command: "C:\\Program Files\\nodejs\\npx.cmd",
        args: ["-y", "-y", "@acme/path-mcp"],
      },
      外壳: { command: "cmd", args: ["/c", "npx", "--yes", "@acme/cmd-mcp"] },
    }),
  );
  const before = await listed(execute);
  expect(before.map((item) => [item.name, item.status])).toEqual([
    ["无确认", "ready"],
    ["全路径", "ready"],
    ["外壳", "ready"],
  ]);
  for (const item of before) {
    const outcome = await execute({
      action: "apps.enable",
      payload: { candidate: item.ref },
    });
    if (!outcome.ok) throw new Error(outcome.error);
  }
  expect(
    registry
      .list()
      .map((app) =>
        app.kind === "stdio"
          ? [app.name, app.command, app.runtime, app.args]
          : [app.name],
      ),
  ).toEqual([
    ["无确认", "bunx", "bundled", ["@acme/plain-mcp", "--port", "0"]],
    ["全路径", "bunx", "bundled", ["@acme/path-mcp"]],
    ["外壳", "bunx", "bundled", ["@acme/cmd-mcp"]],
  ]);
  const after = await listed(execute);
  expect(after.map((item) => [item.name, item.enabled, item.app])).toEqual(
    registry.list().map((app) => [app.name, true, app.ref]),
  );
});

test("apps.enable twice answers the same app; a disabled registered app is switched back on, not added again", async () => {
  const connected: AppEntry[] = [];
  const { execute, registry } = setup({ hostOf: fakeHost(connected) });
  const ref = await refOf(execute, "笔记");
  const first = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  const second = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  if (!first.ok || !second.ok) throw new Error("enable failed");
  expect(second.output).toEqual(first.output);
  expect(registry.list()).toHaveLength(1);
  const [entry] = registry.list();
  if (!entry) throw new Error("nothing was registered");

  registry.setEnabled(entry.ref, false);
  // The same reference still names the candidate, which now points at the disabled app.
  const third = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  if (!third.ok) throw new Error(third.error);
  expect(third.output).toEqual(first.output);
  expect(registry.list()).toEqual([{ ...entry, enabled: true }]);
});

test("a taken name becomes 名称（2）", async () => {
  const connected: AppEntry[] = [];
  const { execute, registry } = setup({ hostOf: fakeHost(connected) });
  // Another app (a different identity) already holds the name.
  registry.add({ kind: "http", name: "笔记", url: "http://127.0.0.1:9" });
  const outcome = await execute({
    action: "apps.enable",
    payload: { candidate: await refOf(execute, "笔记") },
  });
  if (!outcome.ok) throw new Error(outcome.error);
  expect((outcome.output as { app: { name: string } }).app.name).toBe(
    "笔记（2）",
  );
  // A name taken twice over gets the next free variant, kept to 40 characters.
  const long = "长".repeat(40);
  const two = setup(
    { hostOf: fakeHost(connected) },
    desktop({ [long]: { command: "bunx", args: ["@acme/long-mcp"] } }),
  );
  two.registry.add({ kind: "http", name: long, url: "http://127.0.0.1:9" });
  two.registry.add({
    kind: "http",
    name: `${"长".repeat(37)}（2）`,
    url: "http://127.0.0.1:8",
  });
  const named = await two.execute({
    action: "apps.enable",
    payload: { candidate: await refOf(two.execute, long) },
  });
  if (!named.ok) throw new Error(named.error);
  expect((named.output as { app: { name: string } }).app.name).toBe(
    `${"长".repeat(37)}（3）`,
  );
});

test("a failed connection test removes what was written and answers the host's 中文 error without outcomeUnknown", async () => {
  const { execute, registry, base } = setup(
    { resolveCommand: resolveFixture },
    desktop({
      会退出: {
        command: process.execPath,
        args: [FIXTURE],
        env: { FAKE_MCP_MODE: "exit" },
      },
    }),
  );
  const ref = await refOf(execute, "会退出");
  const failed = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  if (failed.ok) throw new Error("expected a failure");
  expect(failed.error).toStartWith("「会退出」启动失败");
  expect("outcomeUnknown" in failed).toBe(false);
  expect(registry.list()).toEqual([]);
  expect(JSON.parse(appsFile(base))).toEqual({ apps: [] });

  // An app that was registered but off is switched back off, its settings untouched.
  const off = registry.add({
    kind: "stdio",
    name: "我的",
    command: process.execPath,
    args: [FIXTURE],
    env: { FAKE_MCP_MODE: "exit" },
    enabled: false,
  });
  const again = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  if (again.ok) throw new Error("expected a failure");
  expect(again.error).toStartWith("「我的」启动失败");
  expect("outcomeUnknown" in again).toBe(false);
  expect(registry.list()).toEqual([off]);
}, 20_000);

test("an expired, forged or needs_uv candidate writes nothing and says why", async () => {
  const { execute, base, setNow } = setup(
    { hostOf: fakeHost([]) },
    desktop({
      笔记: { command: "npx", args: ["-y", "@acme/notes-mcp"] },
      Python: { command: "uvx", args: ["acme-mcp"] },
    }),
  );
  const notes = await refOf(execute, "笔记");
  const python = await refOf(execute, "Python");
  const forged = `${notes.slice(0, -1)}${notes.endsWith("A") ? "B" : "A"}`;
  for (const candidate of [forged, "cand_nonsense", "app_x"]) {
    expect(
      await execute({ action: "apps.enable", payload: { candidate } }),
    ).toEqual({ ok: false, error: CANDIDATE_EXPIRED });
  }
  expect(
    await execute({ action: "apps.enable", payload: { candidate: python } }),
  ).toEqual({ ok: false, error: "「Python」暂时不能启用：需要先安装 uv" });
  const wrongType = await execute({
    action: "apps.enable",
    payload: { candidate: 42 },
  });
  expect(wrongType.ok).toBe(false);
  expect("outcomeUnknown" in wrongType).toBe(false);

  setNow(T0 + CANDIDATE_TTL_MS + 1_000);
  expect(
    await execute({ action: "apps.enable", payload: { candidate: notes } }),
  ).toEqual({ ok: false, error: CANDIDATE_EXPIRED });
  expect(appsFile(base)).toBe("");
});

test("a connection test that fails without closing leaves no connection open once rolled back", async () => {
  const connected: AppEntry[] = [];
  const closedRefs: string[] = [];
  const { execute, registry } = setup({
    hostOf: fakeHost(connected, { failList: true, closedRefs }),
  });
  const ref = await refOf(execute, "笔记");
  const failed = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  expect(failed).toEqual({
    ok: false,
    error: "「笔记」返回了无法识别的内容。",
  });
  expect(registry.list()).toEqual([]);
  // The one connection the test opened is closed now, not left to the 10-minute idle timer.
  expect(connected).toHaveLength(1);
  expect(closedRefs).toEqual([connected[0]?.ref ?? ""]);

  // The same for an app that was off and is switched off again.
  const off = registry.add({
    kind: "stdio",
    name: "我的",
    command: "npx",
    args: ["-y", "@acme/notes-mcp"],
    env: {},
    enabled: false,
  });
  const again = await execute({
    action: "apps.enable",
    payload: { candidate: ref },
  });
  expect(again).toEqual({
    ok: false,
    error: "「我的」返回了无法识别的内容。",
  });
  expect(registry.list()).toEqual([off]);
  expect(connected.map((app) => app.ref)).toEqual([
    connected[0]?.ref ?? "",
    off.ref,
  ]);
  expect(closedRefs).toEqual(connected.map((app) => app.ref));
});

test("with 名称 through 名称（9） all taken the registry's duplicate-name refusal comes back and nothing is written", async () => {
  const connected: AppEntry[] = [];
  const { execute, registry, base } = setup({ hostOf: fakeHost(connected) });
  for (const name of [
    "笔记",
    ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `笔记（${n}）`),
  ]) {
    registry.add({ kind: "http", name, url: "http://127.0.0.1:9" });
  }
  const before = appsFile(base);
  const outcome = await execute({
    action: "apps.enable",
    payload: { candidate: await refOf(execute, "笔记") },
  });
  expect(outcome).toEqual({
    ok: false,
    error: "已经有一个叫「笔记」的应用了（重名）。",
  });
  expect(appsFile(base)).toBe(before);
  expect(connected).toEqual([]);
});

test("with 20 apps registered the registry's 中文 refusal comes back and nothing is written", async () => {
  const connected: AppEntry[] = [];
  const { execute, registry, base } = setup({ hostOf: fakeHost(connected) });
  for (let i = 0; i < MAX_APPS; i += 1) {
    registry.add({
      kind: "http",
      name: `应用 ${i}`,
      url: `http://127.0.0.1:${9000 + i}`,
    });
  }
  const before = appsFile(base);
  const outcome = await execute({
    action: "apps.enable",
    payload: { candidate: await refOf(execute, "笔记") },
  });
  expect(outcome).toEqual({ ok: false, error: "最多添加 20 个本机应用。" });
  expect(appsFile(base)).toBe(before);
  expect(connected).toEqual([]);
});
