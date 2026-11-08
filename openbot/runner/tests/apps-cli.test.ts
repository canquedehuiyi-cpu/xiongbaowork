import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAppRegistry } from "../src/apps";
import { createRootRegistry } from "../src/roots";
import {
  heartbeatFrame,
  parseAppCommand,
  parseRootCommand,
  runAppCommand,
} from "../src/index";

const FIXTURE = resolve(import.meta.dir, "fixtures/fake-mcp-stdio.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "apps-cli-"));
  dirs.push(dir);
  return dir;
};

async function run(dataDir: string, flags: string[]) {
  const parsed = parseAppCommand(
    ["--data-dir", dataDir, ...flags],
    {},
    dataDir,
  );
  if (parsed === null || typeof parsed === "string")
    throw new Error(`not an app command: ${String(parsed)}`);
  const lines: string[] = [];
  const code = await runAppCommand(parsed, (line) => lines.push(line));
  return { code, lines, json: JSON.parse(lines[0] ?? "null") };
}

test("heartbeat carries apps as ref and name only", () => {
  const dataDir = fresh();
  const apps = createAppRegistry({ dataDir });
  const entry = apps.add({
    kind: "stdio",
    name: "笔记",
    command: "secret-cmd",
    args: [],
    env: { KEY: "sk-secret" },
  });
  const roots = createRootRegistry({ dataDir, privatePaths: [] });
  const frame = heartbeatFrame(roots, apps);
  expect(JSON.parse(frame)).toEqual({
    type: "heartbeat",
    roots: [],
    apps: [{ ref: entry.ref, name: "笔记" }],
  });
  expect(frame).not.toContain("secret-cmd");
  expect(frame).not.toContain("sk-secret");
});

test("--add-app then --list-apps masks env values", async () => {
  const dataDir = fresh();
  const input = JSON.stringify({
    kind: "stdio",
    name: "笔记",
    command: "x",
    args: [],
    env: { API_KEY: "sk-secret" },
  });
  const added = await run(dataDir, ["--add-app", input]);
  expect(added.code).toBe(0);
  expect(added.lines).toHaveLength(1);
  expect(added.lines[0]).not.toContain("sk-secret");
  const listed = await run(dataDir, ["--list-apps"]);
  expect(listed.code).toBe(0);
  expect(listed.lines[0]).not.toContain("sk-secret");
  expect(listed.json.apps[0].env).toEqual({ API_KEY: "••••" });
  // The file itself keeps the real value.
  expect(createAppRegistry({ dataDir }).list()[0]).toMatchObject({
    env: { API_KEY: "sk-secret" },
  });
});

test("--add-app reports bad json and registry refusals as a one-line error", async () => {
  const dataDir = fresh();
  // Bad JSON never reaches the registry: the parser says so.
  expect(
    parseAppCommand(["--data-dir", dataDir, "--add-app", "{nope"], {}, dataDir),
  ).toContain("JSON");
  const refused = await run(dataDir, [
    "--add-app",
    JSON.stringify({ kind: "http", name: "远程", url: "http://example.com" }),
  ]);
  expect(refused.code).toBe(2);
  expect(refused.json.error).toContain("本机地址");
});

test("--test-app lists the fake server's tools", async () => {
  const dataDir = fresh();
  createAppRegistry({ dataDir }).add({
    kind: "stdio",
    name: "假应用",
    command: process.execPath,
    args: [FIXTURE],
    env: {},
  });
  const result = await run(dataDir, ["--test-app", "假应用"]);
  expect(result.code).toBe(0);
  expect(result.json).toEqual({
    ok: true,
    tools: ["echo", "write_note", "wipe"],
    count: 3,
  });
  const missing = await run(dataDir, ["--test-app", "没有"]);
  expect(missing.code).toBe(2);
  expect(missing.json.ok).toBe(false);
});

test("--disable-app, --enable-app and --remove-app", async () => {
  const dataDir = fresh();
  const apps = createAppRegistry({ dataDir });
  apps.add({ kind: "http", name: "本地", url: "http://127.0.0.1:9" });
  expect(
    (await run(dataDir, ["--disable-app", "本地"])).json.apps[0].enabled,
  ).toBe(false);
  expect(apps.reported()).toEqual([]);
  expect(
    (await run(dataDir, ["--enable-app", "本地"])).json.apps[0].enabled,
  ).toBe(true);
  expect((await run(dataDir, ["--remove-app", "本地"])).json.apps).toEqual([]);
  expect((await run(dataDir, ["--remove-app", "本地"])).code).toBe(2);
});

test("root flags and app flags cannot be combined", () => {
  const dir = fresh();
  const mixed = ["--list-roots", "--list-apps"];
  expect(typeof parseRootCommand(mixed, {}, dir)).toBe("string");
  expect(typeof parseAppCommand(mixed, {}, dir)).toBe("string");
  expect(parseAppCommand(["--server", "http://x"], {}, dir)).toBeNull();
  expect(
    typeof parseAppCommand(["--list-apps", "--enable-app", "a"], {}, dir),
  ).toBe("string");
});

test("--add-app - reads the app from stdin, so a key never appears on the command line", async () => {
  const dataDir = fresh();
  const input = JSON.stringify({
    kind: "stdio",
    name: "笔记",
    command: "x",
    args: [],
    env: { API_KEY: "sk-secret" },
  });
  const argv = ["--data-dir", dataDir, "--add-app", "-"];
  expect(argv.join(" ")).not.toContain("sk-secret");
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/index.ts"), ...argv],
    { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", cwd: dataDir },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  const reply = JSON.parse(stdout.trim().split("\n").pop() ?? "null");
  expect(reply.ok).toBe(true);
  expect(reply.app.name).toBe("笔记");
  expect(stdout).not.toContain("sk-secret");
  expect(createAppRegistry({ dataDir }).list()[0]).toMatchObject({
    env: { API_KEY: "sk-secret" },
  });

  // In process too: what stdin says is checked like an argument, and a refusal is one JSON line.
  const parsed = parseAppCommand(argv, {}, dataDir);
  if (parsed === null || typeof parsed === "string")
    throw new Error("not an app command");
  const lines: string[] = [];
  expect(
    await runAppCommand(parsed, (line) => lines.push(line), async () => "{nope"),
  ).toBe(2);
  expect(JSON.parse(lines[0] ?? "null")).toMatchObject({ ok: false });
  expect(lines[0]).toContain("JSON");
}, 20_000);

test("--discover-apps prints one JSON line with candidates and installed and no command or env value", async () => {
  const dataDir = fresh();
  const parsed = parseAppCommand(
    ["--data-dir", dataDir, "--discover-apps"],
    {},
    dataDir,
  );
  if (parsed === null || typeof parsed === "string")
    throw new Error(`not an app command: ${String(parsed)}`);
  expect(parsed.command).toEqual({ kind: "discover" });
  const appData = "C:\\Users\\me\\AppData\\Roaming";
  const config = JSON.stringify({
    mcpServers: {
      笔记: {
        command: "C:\\Users\\me\\tools\\notes-server.exe",
        args: ["--vault", "C:\\Users\\me\\proj"],
        env: { NOTES_TOKEN: "sk-test-secret" },
      },
    },
  });
  const lines: string[] = [];
  const code = await runAppCommand(
    parsed,
    (line) => lines.push(line),
    undefined,
    {
      platform: "win32",
      env: { APPDATA: appData, USERPROFILE: "C:\\Users\\me" },
      readText: (path) =>
        path === `${appData}\\Claude\\claude_desktop_config.json`
          ? config
          : undefined,
      readInstalled: async () => [{ DisplayName: "微信" }],
      resolveCommand: (command) => command,
    },
  );
  expect(code).toBe(0);
  expect(lines).toHaveLength(1);
  const json = JSON.parse(lines[0] ?? "null");
  expect(json).toEqual({
    ok: true,
    platform: "win32",
    candidates: [
      expect.objectContaining({
        name: "笔记",
        source: "claude-desktop",
        status: "ready",
      }),
    ],
    installed: ["微信"],
  });
  for (const secret of [
    "sk-test-secret",
    "NOTES_TOKEN",
    "notes-server",
    "--vault",
    "Users",
    "proj",
  ]) {
    expect(lines[0]).not.toContain(secret);
  }

  // The real default machine: off Windows it reads nothing and answers empty lists.
  if (process.platform !== "win32") {
    const plain: string[] = [];
    expect(await runAppCommand(parsed, (line) => plain.push(line))).toBe(0);
    expect(JSON.parse(plain[0] ?? "null")).toEqual({
      ok: true,
      platform: process.platform,
      candidates: [],
      installed: [],
    });
  }
});

test("--discover-apps cannot be combined with another app flag", () => {
  const dir = fresh();
  for (const other of [
    ["--list-apps"],
    ["--enable-app", "笔记"],
    ["--add-app", "{}"],
  ]) {
    expect(typeof parseAppCommand(["--discover-apps", ...other], {}, dir)).toBe(
      "string",
    );
    expect(typeof parseAppCommand([...other, "--discover-apps"], {}, dir)).toBe(
      "string",
    );
  }
  // It takes no value, and it never mixes with a folder flag either.
  expect(typeof parseAppCommand(["--discover-apps", "笔记"], {}, dir)).toBe(
    "string",
  );
  expect(
    typeof parseRootCommand(["--discover-apps", "--list-roots"], {}, dir),
  ).toBe("string");
  expect(
    typeof parseAppCommand(["--list-roots", "--discover-apps"], {}, dir),
  ).toBe("string");
});
