/**
 * The 本机应用（MCP）section's rules (ui/apps.js), without a window: how the two add forms are read,
 * what each says when it is wrong, what is handed to the shell's commands, and what the list shows.
 */
import { expect, test } from "bun:test";
import {
  addApp,
  describeApps,
  MASK,
  maskEnv,
  parseArgsLines,
  parseEnvLines,
  removeApp,
  setAppEnabled,
  testApp,
  validateStdio,
  validateUrl,
} from "../ui/apps.js";

test("arguments are one per line, blanks dropped, spaces inside kept", () => {
  expect(parseArgsLines("-y\n  some-mcp \n\n--dir=C:\\My Docs\r\n")).toEqual([
    "-y",
    "some-mcp",
    "--dir=C:\\My Docs",
  ]);
  expect(parseArgsLines("")).toEqual([]);
});

test("environment lines are KEY=VALUE split at the first equals sign", () => {
  expect(parseEnvLines("A=1\nB = x=y")).toEqual({
    ok: true,
    env: { A: "1", B: "x=y" },
  });
  expect(parseEnvLines("\n")).toEqual({ ok: true, env: {} });
  expect(parseEnvLines("NOEQUALS")).toMatchObject({ ok: false });
  expect(parseEnvLines("=v")).toMatchObject({ ok: false });
  expect(parseEnvLines("1BAD=v")).toMatchObject({ ok: false });
});

test("environment values are always shown masked", () => {
  expect(MASK).toBe("••••");
  expect(maskEnv("sk-secret")).toBe("••••");
  expect(maskEnv("")).toBe("••••");
});

test("a url is accepted only as http or https on this computer", () => {
  for (const ok of [
    "http://127.0.0.1:8080/mcp",
    "https://localhost/mcp",
    "http://[::1]:3000",
    "http://LOCALHOST:3845/mcp",
    "http://127.0.0.1:65535",
  ]) {
    expect(validateUrl(ok)).toEqual({ ok: true, value: ok });
  }
  for (const bad of [
    "",
    "not a url",
    "ftp://127.0.0.1",
    "http://example.com/mcp",
    "http://192.168.1.5:8080",
    "http://0.0.0.0:8080",
    "http://localhost.evil.com",
    "http://127.0.0.1@evil.com",
    "http://localhost:99999",
  ]) {
    expect(validateUrl(bad)).toMatchObject({ ok: false });
  }
});

test("a command form becomes the runner's stdio app", () => {
  expect(
    validateStdio({
      name: " 笔记 ",
      command: " npx ",
      args: "-y\nsome-mcp",
      env: "KEY=v",
      cwd: " /tmp/x ",
    }),
  ).toEqual({
    ok: true,
    value: {
      name: "笔记",
      kind: "stdio",
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { KEY: "v" },
      cwd: "/tmp/x",
    },
  });
  const bare = validateStdio({
    name: "a",
    command: "x",
    args: "",
    env: "",
    cwd: "",
  });
  expect(bare).toMatchObject({ ok: true });
  expect("cwd" in (bare as { value: object }).value).toBeFalse();
  expect(
    validateStdio({ name: "", command: "x", args: "", env: "", cwd: "" }),
  ).toMatchObject({ ok: false, field: "name" });
  expect(
    validateStdio({ name: "a", command: " ", args: "", env: "", cwd: "" }),
  ).toMatchObject({ ok: false, field: "command" });
  expect(
    validateStdio({ name: "a", command: "x", args: "", env: "oops", cwd: "" }),
  ).toMatchObject({ ok: false, field: "env" });
});

test("adding hands the shell the app and returns the list or the sentence", async () => {
  const seen: unknown[] = [];
  const result = await addApp(
    { kind: "http", name: "Excel", url: "http://127.0.0.1:9/mcp" },
    async (command, args) => {
      seen.push([command, args]);
      return [{ ref: "app_x", name: "Excel", kind: "http", enabled: true }];
    },
  );
  expect(seen).toEqual([
    [
      "add_app",
      {
        definition: {
          name: "Excel",
          kind: "http",
          url: "http://127.0.0.1:9/mcp",
        },
      },
    ],
  ]);
  expect(result).toMatchObject({ apps: [{ name: "Excel" }] });
  expect(
    await addApp(
      { kind: "http", name: "x", url: "http://example.com" },
      async () => {
        throw new Error("never");
      },
    ),
  ).toHaveProperty("error");
  expect(
    await addApp(
      { kind: "http", name: "Excel", url: "http://localhost/" },
      async () => {
        throw "重名";
      },
    ),
  ).toEqual({ error: "重名" });
});

test("remove, enable and test go to their commands", async () => {
  const seen: unknown[] = [];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    seen.push([command, args]);
    return command === "test_app" ? { count: 2, tools: ["a", "b"] } : [];
  };
  await removeApp("app_x", invoke);
  await setAppEnabled("app_x", false, invoke);
  const tested = await testApp("app_x", invoke);
  expect(seen).toEqual([
    ["remove_app", { target: "app_x" }],
    ["set_app_enabled", { target: "app_x", enabled: false }],
    ["test_app", { target: "app_x" }],
  ]);
  expect(await testApp("app_x", async () => ({ count: 0 }))).toEqual({
    message: "连接成功，找到 0 个工具",
  });
  expect(tested).toEqual({ message: "连接成功，找到 2 个工具：a、b" });
  expect(
    await testApp("app_x", async () => {
      throw "启动失败";
    }),
  ).toEqual({ error: "启动失败" });
});

test("the list shows kind, state and masked env, never a value", () => {
  expect(describeApps([]).empty).toBe("还没有添加本机应用。");
  const { items } = describeApps([
    {
      ref: "app_1",
      name: "Blender",
      kind: "stdio",
      command: "uvx",
      args: ["blender-mcp"],
      env: { KEY: "••••" },
      enabled: true,
    },
    {
      ref: "app_2",
      name: "Excel",
      kind: "http",
      url: "http://127.0.0.1:1/",
      enabled: false,
    },
  ]);
  expect(items[0]).toMatchObject({
    ref: "app_1",
    detail: "uvx blender-mcp",
    env: ["KEY=••••"],
    enabled: true,
    toggle: "停用",
  });
  expect(items[1]).toMatchObject({
    detail: "http://127.0.0.1:1/",
    env: [],
    enabled: false,
    status: "已停用",
    toggle: "启用",
  });
});
