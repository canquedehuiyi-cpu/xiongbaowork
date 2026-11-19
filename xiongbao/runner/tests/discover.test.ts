import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { AppEntry } from "../src/apps";
import {
  CANDIDATE_EXPIRED,
  CANDIDATE_REF,
  CANDIDATE_TTL_MS,
  type Candidate,
  DISCOVER_KEY_FAILED,
  DISCOVER_KEY_FILE,
  type DiscoverDeps,
  DiscoverError,
  discoverApps,
  findCandidate,
  identityOf,
  identityOfEntry,
  MAX_CANDIDATES,
} from "../src/discover";
import type { UninstallEntry } from "../src/discover-installed";

/*
 * Discovery of the apps on the owner's Windows machine: what other AI tools already run, deduped,
 * with a status and an opaque, signed, short-lived reference. Everything the machine would be asked
 * (files, registry, PATH, clock) is injected; nothing that identifies how to start an app leaves.
 */

const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-discover-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

const APPDATA = "C:\\Users\\me\\AppData\\Roaming";
const USERPROFILE = "C:\\Users\\me";
const PATHS = {
  claudeDesktop: win32.join(APPDATA, "Claude", "claude_desktop_config.json"),
  claudeCode: win32.join(USERPROFILE, ".claude.json"),
  cursor: win32.join(USERPROFILE, ".cursor", "mcp.json"),
  vscodeMcp: win32.join(APPDATA, "Code", "User", "mcp.json"),
  windsurf: win32.join(USERPROFILE, ".codeium", "windsurf", "mcp_config.json"),
};

/** 2026-11-08 09:00:00 UTC, on a whole second. */
const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
const INSTALLED_OK: UninstallEntry[] = [{ DisplayName: "微信" }];
const ON_PATH = new Set(["node", "docker", "uv"]);

function machine(
  files: Record<string, unknown>,
  over: Partial<DiscoverDeps> & { apps?: AppEntry[] } = {},
) {
  made += 1;
  const dataDir = join(scratch, `m${made}`);
  const counts = { readText: 0, readInstalled: 0 };
  let now = T0;
  let current = files;
  const deps: DiscoverDeps = {
    platform: "win32",
    env: { APPDATA, USERPROFILE },
    dataDir,
    registry: { list: () => over.apps ?? [] },
    readText: (path) => {
      counts.readText += 1;
      const value = current[path];
      return value === undefined
        ? undefined
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    },
    readInstalled: async () => {
      counts.readInstalled += 1;
      return INSTALLED_OK;
    },
    resolveCommand: (command) =>
      ON_PATH.has(command) ? `C:\\bin\\${command}.exe` : undefined,
    now: () => now,
    ...over,
  };
  return {
    deps,
    dataDir,
    counts,
    setNow: (value: number) => {
      now = value;
    },
    setFiles: (value: Record<string, unknown>) => {
      current = value;
    },
  };
}

const servers = (entries: Record<string, unknown>) => ({
  mcpServers: entries,
});

const names = (candidates: Candidate[]) => candidates.map((c) => c.name);

test("non-Windows platforms return nothing and read nothing", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const m = machine(
      { [PATHS.cursor]: servers({ a: { command: "node" } }) },
      { platform },
    );
    expect(await discoverApps(m.deps)).toEqual({
      platform,
      candidates: [],
      installed: [],
    });
    expect(m.counts).toEqual({ readText: 0, readInstalled: 0 });
    expect(existsSync(join(m.dataDir, DISCOVER_KEY_FILE))).toBe(false);
    expect(
      await findCandidate(m.deps, `cand_${"1".repeat(6)}_${"A".repeat(22)}`),
    ).toEqual({ error: CANDIDATE_EXPIRED });
    expect(existsSync(join(m.dataDir, DISCOVER_KEY_FILE))).toBe(false);
  }
});

test("the same command and args in two tools is one candidate from the first source", async () => {
  const m = machine({
    [PATHS.claudeDesktop]: servers({
      notes: { command: "node", args: ["server.js"] },
    }),
    [PATHS.cursor]: servers({
      // Another spelling of the same program, with its own environment: still the same app.
      "my notes": {
        command: "C:\\Program Files\\nodejs\\NODE.EXE",
        args: ["server.js"],
        env: { TOKEN: "x" },
      },
      other: { command: "node", args: ["other.js"] },
    }),
  });
  const { candidates, installed } = await discoverApps(m.deps);
  expect(installed).toEqual(["微信"]);
  expect(
    candidates.map(({ name, source, sourceLabel, kind }) => ({
      name,
      source,
      sourceLabel,
      kind,
    })),
  ).toEqual([
    {
      name: "notes",
      source: "claude-desktop",
      sourceLabel: "Claude Desktop 的配置",
      kind: "stdio",
    },
    {
      name: "other",
      source: "cursor",
      sourceLabel: "Cursor 的配置",
      kind: "stdio",
    },
  ]);
});

test("npx -y pkg, bunx pkg and bun x pkg are one identity", async () => {
  const stdio = (command: string, args: string[]) => ({
    kind: "stdio" as const,
    command,
    args,
    env: {},
  });
  const one = identityOf(stdio("npx", ["-y", "@scope/pkg", "--flag"]));
  expect(identityOf(stdio("npx.cmd", ["--yes", "@scope/pkg", "--flag"]))).toBe(
    one,
  );
  expect(identityOf(stdio("npx", ["@scope/pkg", "--flag"]))).toBe(one);
  expect(identityOf(stdio("bunx", ["@scope/pkg", "--flag"]))).toBe(one);
  expect(
    identityOf(stdio("C:\\bun\\bun.exe", ["x", "@scope/pkg", "--flag"])),
  ).toBe(one);
  expect(identityOf(stdio("npx", ["-y", "@scope/pkg"]))).not.toBe(one);
  expect(identityOf(stdio("node", ["@scope/pkg", "--flag"]))).not.toBe(one);
  // Environment and working folder are not part of what an app is.
  expect(
    identityOf({
      ...stdio("npx", ["-y", "@scope/pkg", "--flag"]),
      env: { K: "v" },
      cwd: "C:\\w",
    }),
  ).toBe(one);
  expect(identityOf({ kind: "http", url: "http://LOCALHOST:80/mcp" })).toBe(
    identityOf({ kind: "http", url: "http://localhost/mcp" }),
  );

  const m = machine({
    [PATHS.claudeDesktop]: servers({
      a: { command: "npx", args: ["-y", "pkg"] },
    }),
    [PATHS.cursor]: servers({ b: { command: "bunx", args: ["pkg"] } }),
    [PATHS.windsurf]: servers({ c: { command: "bun", args: ["x", "pkg"] } }),
  });
  expect(names((await discoverApps(m.deps)).candidates)).toEqual(["a"]);
});

test("a registered app with the same identity is enabled with its ref; a disabled one carries its ref but is not enabled", async () => {
  const on = `app_${"a".repeat(22)}`;
  const off = `app_${"b".repeat(22)}`;
  const apps: AppEntry[] = [
    {
      ref: on,
      name: "我起的名字",
      kind: "stdio",
      command: "bunx",
      args: ["pkg"],
      env: { K: "other" },
      enabled: true,
    },
    {
      ref: off,
      name: "figma",
      kind: "http",
      url: "http://127.0.0.1:3845/mcp/",
      enabled: false,
    },
  ];
  expect(identityOfEntry(apps[0]!)).toBe(
    identityOf({ kind: "stdio", command: "npx", args: ["-y", "pkg"], env: {} }),
  );
  const m = machine(
    {
      [PATHS.claudeDesktop]: servers({
        pkg: { command: "npx", args: ["-y", "pkg"] },
        figma: { url: "http://127.0.0.1:3845/mcp/" },
        fresh: { command: "node", args: ["x.js"] },
      }),
    },
    { apps },
  );
  const { candidates } = await discoverApps(m.deps);
  expect(
    candidates.map(({ name, app, enabled }) => ({ name, app, enabled })),
  ).toEqual([
    { name: "pkg", app: on, enabled: true },
    { name: "figma", app: off, enabled: false },
    { name: "fresh", app: undefined, enabled: false },
  ]);
  expect("app" in candidates[2]!).toBe(false);
});

test("same name, different identity: the later one is renamed 名称（Cursor）", async () => {
  const m = machine({
    [PATHS.claudeDesktop]: servers({
      files: { command: "node", args: ["a.js"] },
    }),
    [PATHS.cursor]: servers({
      files: { command: "node", args: ["b.js"] },
      FILES: { command: "node", args: ["c.js"] },
    }),
    [PATHS.vscodeMcp]: {
      servers: { files: { command: "node", args: ["d.js"] } },
    },
  });
  expect(names((await discoverApps(m.deps)).candidates)).toEqual([
    "files",
    "files（Cursor）",
    "FILES（Cursor 2）",
    "files（VS Code）",
  ]);
  // A renamed candidate still fits the 40 characters an app's name may have.
  const long = "长".repeat(40);
  const n = machine({
    [PATHS.claudeDesktop]: servers({
      [long]: { command: "node", args: ["a.js"] },
    }),
    [PATHS.cursor]: servers({ [long]: { command: "node", args: ["b.js"] } }),
  });
  const renamed = (await discoverApps(n.deps)).candidates[1]!.name;
  expect([...renamed].length).toBe(40);
  expect(renamed.endsWith("（Cursor）")).toBe(true);
});

test(`status: npx is ready; uvx without uv is needs_uv with 需要先安装 uv; a missing program is missing_command; \${input:key} is unsupported`, async () => {
  const m = machine({
    [PATHS.claudeDesktop]: servers({
      npm: { command: "npx", args: ["-y", "pkg"] },
      python: { command: "uvx", args: ["mcp-server-time"] },
      mine: { command: "my-secret-tool", args: ["serve"] },
      keyed: { command: "node", args: ["s.js"], env: { KEY: `\${input:key}` } },
      flagged: {
        command: "npx",
        args: ["--registry", "https://r.example", "pkg2"],
      },
      web: { url: "http://localhost:9000/mcp" },
      found: { command: "docker", args: ["run", "-i", "img"] },
      "uv run": { command: "uv", args: ["run", "server.py"] },
    }),
  });
  const { candidates } = await discoverApps(m.deps);
  const by = Object.fromEntries(candidates.map((c) => [c.name, c]));
  expect(by.npm).toMatchObject({ status: "ready", kind: "stdio" });
  expect(by.npm?.note).toBeUndefined();
  expect(by.python).toMatchObject({
    status: "needs_uv",
    note: "需要先安装 uv",
  });
  expect(by.mine).toMatchObject({
    status: "missing_command",
    note: "找不到启动这个应用的程序，请先安装它",
  });
  expect(by.keyed).toMatchObject({
    status: "unsupported",
    note: `配置里用到了变量（\${…}），请在设备端「高级：手动添加」里填写实际值`,
  });
  expect(by.flagged).toMatchObject({
    status: "unsupported",
    note: "启动参数无法改写为自带运行时，请在「高级：手动添加」里添加",
  });
  expect(by.web).toMatchObject({ status: "ready", kind: "http" });
  expect(by.found).toMatchObject({ status: "ready" });
  expect(by["uv run"]).toMatchObject({ status: "ready" });
  expect(JSON.stringify(candidates)).not.toContain("my-secret-tool");
});

test("refs: CANDIDATE_REF shape, distinct per candidate; findCandidate accepts at 9 min 59 s and refuses at 10 min 1 s, a forged mac, and a candidate whose env changed after issue", async () => {
  const files = {
    [PATHS.claudeDesktop]: servers({
      keyed: {
        command: "node",
        args: ["s.js"],
        env: { API_KEY: "sk-test-secret" },
      },
      web: { url: "http://localhost:9000/mcp" },
    }),
    [PATHS.cursor]: servers({ other: { command: "node", args: ["o.js"] } }),
  };
  const m = machine(files);
  const { candidates } = await discoverApps(m.deps);
  expect(candidates).toHaveLength(3);
  for (const candidate of candidates)
    expect(candidate.ref).toMatch(CANDIDATE_REF);
  expect(new Set(candidates.map((c) => c.ref)).size).toBe(3);
  const ref = candidates[0]!.ref;

  m.setNow(T0 + CANDIDATE_TTL_MS - 1_000);
  const found = await findCandidate(m.deps, ref);
  expect(found).toEqual({
    candidate: candidates[0]!,
    spec: {
      kind: "stdio",
      command: "node",
      args: ["s.js"],
      env: { API_KEY: "sk-test-secret" },
    },
  });
  expect(await findCandidate(m.deps, candidates[1]!.ref)).toMatchObject({
    candidate: { name: "web" },
    spec: { kind: "http", url: "http://localhost:9000/mcp" },
  });

  m.setNow(T0 + CANDIDATE_TTL_MS + 1_000);
  expect(await findCandidate(m.deps, ref)).toEqual({
    error: CANDIDATE_EXPIRED,
  });

  // Issued more than a minute in the future: not something this machine signed honestly.
  m.setNow(T0 - 61_000);
  expect(await findCandidate(m.deps, ref)).toEqual({
    error: CANDIDATE_EXPIRED,
  });

  m.setNow(T0 + 1_000);
  const mac = ref.slice(-22);
  const flipped = `${ref.slice(0, -22)}${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  expect(await findCandidate(m.deps, flipped)).toEqual({
    error: CANDIDATE_EXPIRED,
  });
  // Re-dated: the issue time is signed with the rest.
  const [, issued] = ref.split("_");
  const redated = ref.replace(
    `_${issued}_`,
    `_${(Number.parseInt(issued!, 36) + 1).toString(36)}_`,
  );
  expect(await findCandidate(m.deps, redated)).toEqual({
    error: CANDIDATE_EXPIRED,
  });
  for (const junk of ["", "cand_", "app_aaaaaaaaaaaaaaaaaaaaaa", `${ref}x`]) {
    expect(await findCandidate(m.deps, junk)).toEqual({
      error: CANDIDATE_EXPIRED,
    });
  }

  m.setFiles({
    ...files,
    [PATHS.claudeDesktop]: servers({
      keyed: {
        command: "node",
        args: ["s.js"],
        env: { API_KEY: "sk-changed" },
      },
      web: { url: "http://localhost:9000/mcp" },
    }),
  });
  expect(await findCandidate(m.deps, ref)).toEqual({
    error: CANDIDATE_EXPIRED,
  });
  // The other candidates did not change and still resolve.
  expect(await findCandidate(m.deps, candidates[2]!.ref)).toMatchObject({
    candidate: { name: "other" },
  });
  m.setFiles({});
  expect(await findCandidate(m.deps, candidates[2]!.ref)).toEqual({
    error: CANDIDATE_EXPIRED,
  });

  // Another machine's key signs other refs.
  const elsewhere = machine(files);
  expect(await findCandidate(elsewhere.deps, candidates[2]!.ref)).toEqual({
    error: CANDIDATE_EXPIRED,
  });
});

test("nothing secret leaves: the result JSON has no env value, command, arg, cwd or path from the fixtures", async () => {
  const m = machine({
    [PATHS.claudeDesktop]: servers({
      secret: {
        command: "C:\\tools\\srv-binary.exe",
        args: ["--listen", "--token=tok-in-args"],
        env: { API_KEY: "sk-test-secret" },
        cwd: "C:\\Users\\me\\proj",
      },
      web: { url: "http://127.0.0.1:4567/private-path" },
    }),
    [PATHS.claudeCode]: {
      projects: {
        "C:/Users/me/proj": {
          mcpServers: { proj: { command: "uvx", args: ["mcp-proj-server"] } },
        },
      },
    },
  });
  const result = await discoverApps(m.deps);
  expect(result.candidates).toHaveLength(3);
  const json = JSON.stringify(result);
  for (const secret of [
    "sk-test-secret",
    "srv-binary",
    "tools",
    "--listen",
    "tok-in-args",
    "C:\\Users\\me",
    "C:/Users/me",
    "Users",
    "4567",
    "private-path",
    "uvx",
    "mcp-proj-server",
    "AppData",
  ]) {
    expect(json).not.toContain(secret);
    expect(json).not.toContain(JSON.stringify(secret).slice(1, -1));
  }
  for (const candidate of result.candidates) {
    expect(
      Object.keys(candidate).every((key) =>
        [
          "ref",
          "name",
          "source",
          "sourceLabel",
          "kind",
          "enabled",
          "app",
          "status",
          "note",
        ].includes(key),
      ),
    ).toBe(true);
  }
});

test("a throwing readInstalled gives installed [] and candidates still come back", async () => {
  const m = machine(
    { [PATHS.cursor]: servers({ a: { command: "node", args: ["a.js"] } }) },
    {
      readInstalled: async () => {
        throw new Error("powershell missing");
      },
    },
  );
  const result = await discoverApps(m.deps);
  expect(result.installed).toEqual([]);
  expect(names(result.candidates)).toEqual(["a"]);
  expect(result.platform).toBe("win32");
});

test("at most MAX_CANDIDATES candidates", async () => {
  const many = Object.fromEntries(
    Array.from({ length: MAX_CANDIDATES + 7 }, (_, i) => [
      `app${i}`,
      { command: "node", args: [`${i}.js`] },
    ]),
  );
  const m = machine({ [PATHS.cursor]: servers(many) });
  expect((await discoverApps(m.deps)).candidates).toHaveLength(MAX_CANDIDATES);
});

test("the key file is created with mode 0o600 and reused by a second discovery", async () => {
  const m = machine({
    [PATHS.cursor]: servers({ a: { command: "node", args: ["a.js"] } }),
  });
  const first = await discoverApps(m.deps);
  const file = join(m.dataDir, DISCOVER_KEY_FILE);
  const key = readFileSync(file);
  expect(key).toHaveLength(32);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  const second = await discoverApps(m.deps);
  expect(readFileSync(file).equals(key)).toBe(true);
  expect(second.candidates[0]!.ref).toBe(first.candidates[0]!.ref);
  // No temporary file is left beside the key.
  expect(readdirSync(m.dataDir)).toEqual([DISCOVER_KEY_FILE]);
});

test("a key that cannot be saved fails with a fixed message that names no local path", async () => {
  // The data folder is a file: nothing can be made inside it.
  const blocked = join(scratch, "blocked-用户");
  writeFileSync(blocked, "not a folder");
  const m = machine(
    { [PATHS.cursor]: servers({ a: { command: "node", args: ["a.js"] } }) },
    { dataDir: blocked },
  );
  const failure = await discoverApps(m.deps).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(DiscoverError);
  const message = (failure as Error).message;
  expect(message).toBe(DISCOVER_KEY_FAILED);
  expect(message).not.toContain(blocked);
  expect(message).not.toContain("blocked");
  expect(message).not.toContain(DISCOVER_KEY_FILE);
  expect(message).not.toMatch(/[\\/]/);
});

test("cmd /c is looked through: cmd /c npx -y pkg is the same app as npx -y pkg, and cmd /c uvx follows the uv rule", async () => {
  const stdio = (command: string, args: string[]) => ({
    kind: "stdio" as const,
    command,
    args,
    env: {},
  });
  const npx = identityOf(stdio("npx", ["-y", "pkg"]));
  expect(identityOf(stdio("cmd", ["/c", "npx", "-y", "pkg"]))).toBe(npx);
  expect(identityOf(stdio("CMD.EXE", ["/C", "npx", "-y", "pkg"]))).toBe(npx);
  expect(
    identityOf(stdio("C:\\Windows\\System32\\cmd.exe", ["/k", "bunx", "pkg"])),
  ).toBe(npx);
  expect(identityOf(stdio("cmd", ["/d", "/s", "/c", "node", "a.js"]))).toBe(
    identityOf(stdio("node", ["a.js"])),
  );
  // Without /c or /k, cmd is just cmd.
  expect(identityOf(stdio("cmd", ["npx", "-y", "pkg"]))).not.toBe(npx);

  const m = machine({
    [PATHS.claudeDesktop]: servers({
      wrapped: {
        command: "cmd",
        args: ["/c", "npx", "-y", "pkg"],
        env: { K: "v" },
      },
      python: { command: "cmd.exe", args: ["/C", "uvx", "mcp-server-time"] },
      flagged: { command: "cmd", args: ["/c", "npx", "--registry", "r", "p"] },
    }),
    [PATHS.cursor]: servers({ plain: { command: "npx", args: ["-y", "pkg"] } }),
  });
  const { candidates } = await discoverApps(m.deps);
  expect(
    candidates.map(({ name, source, status, note }) => ({
      name,
      source,
      status,
      note,
    })),
  ).toEqual([
    {
      name: "wrapped",
      source: "claude-desktop",
      status: "ready",
      note: undefined,
    },
    {
      name: "python",
      source: "claude-desktop",
      status: "needs_uv",
      note: "需要先安装 uv",
    },
    {
      name: "flagged",
      source: "claude-desktop",
      status: "unsupported",
      note: "启动参数无法改写为自带运行时，请在「高级：手动添加」里添加",
    },
  ]);
  // What enabling gets is the command cmd would have run, ready to rewrite to the bundled runtime.
  expect(await findCandidate(m.deps, candidates[0]!.ref)).toMatchObject({
    spec: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { K: "v" },
    },
  });
});

test("a ref is refused when only the command's folder changed after issue", async () => {
  const at = (folder: string) => ({
    [PATHS.claudeDesktop]: servers({
      tool: { command: `${folder}\\srv.exe`, args: ["--x"] },
    }),
  });
  const m = machine(at("C:\\tools"));
  const { candidates } = await discoverApps(m.deps);
  const ref = candidates[0]!.ref;
  expect(await findCandidate(m.deps, ref)).toMatchObject({
    spec: { command: "C:\\tools\\srv.exe" },
  });
  m.setFiles(at("C:\\evil"));
  // Still the same app by name and arguments...
  expect(names((await discoverApps(m.deps)).candidates)).toEqual(["tool"]);
  // ...but not the one that was offered.
  expect(await findCandidate(m.deps, ref)).toEqual({
    error: CANDIDATE_EXPIRED,
  });
});

const CATALOG_SAMPLE = {
  id: "sample-chat",
  name: "示例聊天",
  detect: { installed: "^示例聊天" },
  launch: { bunx: { package: "sample-chat-mcp@1.2.3" } },
  verified: "2026-01-01 测试机 示例聊天 4.0",
};

test("a config source with the same identity wins over the catalogue", async () => {
  const m = machine(
    {
      [PATHS.cursor]: servers({
        mine: { command: "npx", args: ["-y", "sample-chat-mcp@1.2.3"] },
      }),
    },
    {
      readInstalled: async () => [{ DisplayName: "示例聊天 4.0" }],
      catalog: [CATALOG_SAMPLE],
    },
  );
  const result = await discoverApps(m.deps);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.source).toBe("cursor");
  expect(result.candidates[0]?.name).toBe("mine");
});

test("names matched by the catalogue leave the installed list, and its candidate comes after the config ones", async () => {
  const m = machine(
    { [PATHS.cursor]: servers({ a: { command: "node", args: ["a.js"] } }) },
    {
      readInstalled: async () => [
        { DisplayName: "示例聊天 4.0" },
        { DisplayName: "微信" },
      ],
      catalog: [CATALOG_SAMPLE],
    },
  );
  const result = await discoverApps(m.deps);
  expect(result.installed).toEqual(["微信"]);
  expect(names(result.candidates)).toEqual(["a", "示例聊天"]);
  const found = result.candidates[1];
  expect(found?.source).toBe("catalog");
  expect(found?.sourceLabel).toBe(
    "内置清单，检测到已安装 示例聊天，使用前请先打开它",
  );
  expect(found?.status).toBe("ready");
  expect(found?.kind).toBe("stdio");
  // The candidate can be turned back into its spec by its ref.
  const again = await findCandidate(m.deps, found?.ref ?? "");
  expect("candidate" in again && again.spec.kind).toBe("stdio");
});

test("catalogue candidates count toward MAX_CANDIDATES", async () => {
  const many = Object.fromEntries(
    Array.from({ length: MAX_CANDIDATES }, (_, i) => [
      `app${i}`,
      { command: "node", args: [`${i}.js`] },
    ]),
  );
  const m = machine(
    { [PATHS.cursor]: servers(many) },
    {
      readInstalled: async () => [{ DisplayName: "示例聊天" }],
      catalog: [CATALOG_SAMPLE],
    },
  );
  const result = await discoverApps(m.deps);
  expect(result.candidates).toHaveLength(MAX_CANDIDATES);
});
