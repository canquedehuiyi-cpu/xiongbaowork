import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createAppRegistry } from "../src/apps";
import {
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

/*
 * `apps.discover` through the real executor: discovery answers what this machine could offer, by
 * name, with nothing that says how to start it. The machine (files, registry, PATH, clock) is
 * injected, so the Windows branch runs here.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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
  over: Partial<DiscoverDeps> & { installed?: unknown[] } = {},
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
  const { installed, ...deps } = over;
  const discovery = createDiscoverActions({
    dataDir: base,
    registry,
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
    reads,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("apps.discover answers candidates and installed through the executor", async () => {
  expect([...DISCOVER_ACTIONS]).toEqual(["apps.discover"]);
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
