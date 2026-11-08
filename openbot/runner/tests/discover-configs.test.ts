import { expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  type ConfigSource,
  configFiles,
  parseJsonc,
  readConfigServers,
  SOURCE_LABELS,
  SOURCE_SHORT,
  serversFromConfig,
} from "../src/discover-configs";

/*
 * Other AI tools' MCP configuration on a Windows machine, read only to offer the owner what they
 * already set up there. Each format has a fixed sample below; nothing here touches the real disk.
 */

const APPDATA = "C:\\Users\\me\\AppData\\Roaming";
const USERPROFILE = "C:\\Users\\me";
const env = { APPDATA, USERPROFILE };

const PATHS = {
  claudeDesktop: win32.join(APPDATA, "Claude", "claude_desktop_config.json"),
  claudeCode: win32.join(USERPROFILE, ".claude.json"),
  cursor: win32.join(USERPROFILE, ".cursor", "mcp.json"),
  vscodeMcp: win32.join(APPDATA, "Code", "User", "mcp.json"),
  vscodeSettings: win32.join(APPDATA, "Code", "User", "settings.json"),
  windsurf: win32.join(USERPROFILE, ".codeium", "windsurf", "mcp_config.json"),
};

const CLAUDE_DESKTOP = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\me\\\\Desktop"],
      "env": { "API_KEY": "sk-test-secret", "RETRIES": 3 }
    },
    "figma": { "url": "http://127.0.0.1:3845/mcp" }
  },
  "globalShortcut": "Ctrl+Space"
}`;

const CLAUDE_CODE = `{
  "numStartups": 12,
  "mcpServers": {
    "github": { "type": "stdio", "command": "docker", "args": ["run", "-i", "ghcr.io/github/github-mcp-server"] }
  },
  "projects": {
    "C:/Users/me/secret-project": {
      "allowedTools": [],
      "mcpServers": {
        "sqlite": { "command": "uvx", "args": ["mcp-server-sqlite"] }
      }
    },
    "C:/Users/me/empty-project": { "allowedTools": [] }
  }
}`;

const CURSOR = `{
  "mcpServers": {
    "local-api": { "url": "http://localhost:8080/sse" },
    "notes": { "command": "node", "args": ["C:\\\\tools\\\\notes\\\\index.js"] }
  }
}`;

const VSCODE_MCP = `// VS Code keeps comments in its MCP file
{
  "inputs": [{ "type": "promptString", "id": "key" }],
  "servers": {
    /* a block comment */
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--label=a,}"], // trailing comma below
    },
    "memory": { "type": "http", "url": "http://[::1]:7000/mcp" },
  },
}`;

const VSCODE_SETTINGS = `{
  "editor.fontSize": 14, // a comment after a value
  "mcp": {
    "servers": {
      "time": { "command": "uvx", "args": ["mcp-server-time"], },
    },
  },
  "mcp.servers": {
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }
  },
}`;

const WINDSURF = `{
  "mcpServers": {
    "browser": { "serverUrl": "http://127.0.0.1:9222/mcp" }
  }
}`;

function reader(files: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    readText: (path: string) => {
      reads.push(path);
      return files[path];
    },
  };
}

function only(source: ConfigSource, files: Record<string, string>) {
  return readConfigServers({ env, readText: reader(files).readText }).filter(
    (server) => server.source === source,
  );
}

test("claude desktop: mcpServers stdio and loopback url entries", () => {
  const found = only("claude-desktop", {
    [PATHS.claudeDesktop]: CLAUDE_DESKTOP,
  });
  expect(found).toEqual([
    {
      source: "claude-desktop",
      name: "filesystem",
      spec: {
        kind: "stdio",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "C:\\Users\\me\\Desktop",
        ],
        // A non-string value is not an environment variable anything can start with.
        env: { API_KEY: "sk-test-secret" },
      },
    },
    {
      source: "claude-desktop",
      name: "figma",
      spec: { kind: "http", url: "http://127.0.0.1:3845/mcp" },
    },
  ]);
});

test("claude code: top-level and per-project mcpServers; no project path appears in the result", () => {
  const found = only("claude-code", { [PATHS.claudeCode]: CLAUDE_CODE });
  expect(found.map((server) => server.name)).toEqual(["github", "sqlite"]);
  expect(found[0]?.spec).toEqual({
    kind: "stdio",
    command: "docker",
    args: ["run", "-i", "ghcr.io/github/github-mcp-server"],
    env: {},
  });
  expect(found[1]?.spec).toEqual({
    kind: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite"],
    env: {},
  });
  // A project's path is only walked through to reach its servers.
  expect(JSON.stringify(found)).not.toContain("secret-project");
  expect(JSON.stringify(found)).not.toContain("empty-project");
  for (const server of found) {
    expect(Object.keys(server).sort()).toEqual(["name", "source", "spec"]);
  }
});

test("cursor: mcpServers with url and with command", () => {
  const found = only("cursor", { [PATHS.cursor]: CURSOR });
  expect(found).toEqual([
    {
      source: "cursor",
      name: "local-api",
      spec: { kind: "http", url: "http://localhost:8080/sse" },
    },
    {
      source: "cursor",
      name: "notes",
      spec: {
        kind: "stdio",
        command: "node",
        args: ["C:\\tools\\notes\\index.js"],
        env: {},
      },
    },
  ]);
});

test("vscode: mcp.json servers and settings.json mcp.servers, with comments and trailing commas", () => {
  const found = only("vscode", {
    [PATHS.vscodeMcp]: VSCODE_MCP,
    [PATHS.vscodeSettings]: VSCODE_SETTINGS,
  });
  expect(found.map((server) => server.name)).toEqual([
    "playwright",
    "memory",
    "time",
    "fetch",
  ]);
  // A comma and a brace inside a string are text, not a trailing comma; `//` in a url is not a comment.
  expect(found[0]?.spec).toEqual({
    kind: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest", "--label=a,}"],
    env: {},
  });
  expect(found[1]?.spec).toEqual({
    kind: "http",
    url: "http://[::1]:7000/mcp",
  });
});

test("windsurf: mcpServers with serverUrl", () => {
  expect(only("windsurf", { [PATHS.windsurf]: WINDSURF })).toEqual([
    {
      source: "windsurf",
      name: "browser",
      spec: { kind: "http", url: "http://127.0.0.1:9222/mcp" },
    },
  ]);
});

test("a non-loopback url, a missing command and non-string args are dropped; unknown fields are ignored", () => {
  const found = serversFromConfig("cursor", {
    remote: { url: "https://mcp.example.com/sse" },
    "remote-ip": { url: "http://192.168.1.5:3000/mcp" },
    "no-command": { args: ["x"], env: { A: "b" } },
    "blank-command": { command: "  ", url: "file:///etc/passwd" },
    "number-args": { command: "node", args: ["a", 2] },
    "string-args": { command: "node", args: "server.js" },
    "   ": { command: "node" },
    "not-an-object": "node server.js",
    kept: {
      command: "node",
      args: ["server.js"],
      cwd: "C:\\work",
      disabled: true,
      alwaysAllow: ["x"],
      type: "stdio",
    },
    "  这是一个名字特别特别长的应用名称它一共有超过四十个字所以要被截断到四十个字为止啊啊啊  ":
      {
        url: "http://localhost:1/",
      },
  });
  expect(found).toEqual([
    {
      source: "cursor",
      name: "kept",
      spec: {
        kind: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
        cwd: "C:\\work",
      },
    },
    {
      source: "cursor",
      name: "这是一个名字特别特别长的应用名称它一共有超过四十个字所以要被截断到四十个字为止啊",
      spec: { kind: "http", url: "http://localhost:1/" },
    },
  ]);
  expect([...(found[1]?.name ?? "")].length).toBe(40);
});

test("a UTF-8 BOM parses; a broken file skips only its own source", () => {
  expect(parseJsonc('\uFEFF{ "a": 1, }')).toEqual({ a: 1 });
  expect(() => parseJsonc("{ broken")).toThrow();
  const { readText } = reader({
    [PATHS.claudeDesktop]: `\uFEFF${CLAUDE_DESKTOP}`,
    [PATHS.claudeCode]: "{ this is not json",
    [PATHS.cursor]: "[1, 2, 3]",
    [PATHS.windsurf]: WINDSURF,
  });
  const found = readConfigServers({ env, readText });
  expect(found.map((server) => `${server.source}/${server.name}`)).toEqual([
    "claude-desktop/filesystem",
    "claude-desktop/figma",
    "windsurf/browser",
  ]);
  // A reader that throws counts as a file that could not be read.
  const throwing = readConfigServers({
    env,
    readText: (path) => {
      if (path === PATHS.claudeDesktop) throw new Error("EACCES");
      return path === PATHS.windsurf ? WINDSURF : undefined;
    },
  });
  expect(throwing.map((server) => server.name)).toEqual(["browser"]);
});

test("configFiles builds the five Windows paths from APPDATA and USERPROFILE, and none when both are missing", () => {
  const files = configFiles(env);
  expect(files.map(({ source, path }) => ({ source, path }))).toEqual([
    { source: "claude-desktop", path: PATHS.claudeDesktop },
    { source: "claude-code", path: PATHS.claudeCode },
    { source: "cursor", path: PATHS.cursor },
    { source: "vscode", path: PATHS.vscodeMcp },
    { source: "vscode", path: PATHS.vscodeSettings },
    { source: "windsurf", path: PATHS.windsurf },
  ]);
  expect(new Set(files.map((file) => file.source)).size).toBe(5);
  // Windows spells variable names in any case.
  expect(
    configFiles({ appdata: APPDATA, UserProfile: USERPROFILE }).map(
      (file) => file.path,
    ),
  ).toEqual(files.map((file) => file.path));
  expect(configFiles({ USERPROFILE }).map((file) => file.source)).toEqual([
    "claude-code",
    "cursor",
    "windsurf",
  ]);
  expect(configFiles({ APPDATA }).map((file) => file.source)).toEqual([
    "claude-desktop",
    "vscode",
    "vscode",
  ]);
  expect(configFiles({})).toEqual([]);
  expect(configFiles({ APPDATA: "", USERPROFILE: undefined })).toEqual([]);
  const { reads, readText } = reader({});
  expect(readConfigServers({ env: {}, readText })).toEqual([]);
  expect(reads).toEqual([]);
});

test("labels name every source in Chinese, and a short form for renaming", () => {
  expect(SOURCE_LABELS).toEqual({
    "claude-desktop": "Claude Desktop 的配置",
    "claude-code": "Claude Code 的配置",
    cursor: "Cursor 的配置",
    vscode: "VS Code 的配置",
    windsurf: "Windsurf 的配置",
  });
  expect(SOURCE_SHORT).toEqual({
    "claude-desktop": "Claude Desktop",
    "claude-code": "Claude Code",
    cursor: "Cursor",
    vscode: "VS Code",
    windsurf: "Windsurf",
  });
});

test("control characters in a name become spaces", () => {
  expect(
    serversFromConfig("cursor", {
      "\tmy\napp\u0000x\r\n": { url: "http://localhost:1/" },
      "\n\t": { url: "http://localhost:2/" },
    }).map((server) => server.name),
  ).toEqual(["my app x"]);
});
