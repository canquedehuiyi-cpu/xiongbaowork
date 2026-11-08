import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_REF, createAppRegistry } from "../src/apps";

/*
 * The apps on this machine the owner lets their 分身 call through MCP. Registered locally, reported to
 * the server as a reference and a name only: the command, its environment and the url stay here.
 */

const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-apps-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

function machine() {
  made += 1;
  const dataDir = join(scratch, `m${made}`);
  return { dataDir, apps: createAppRegistry({ dataDir }) };
}

const stdio = (name: string) => ({
  name,
  kind: "stdio" as const,
  command: "npx",
  args: ["-y", "some-mcp"],
  env: { API_KEY: "not-a-real-one" },
});

test("adds a stdio app and reports only ref and name", () => {
  const { dataDir, apps } = machine();
  const entry = apps.add({ ...stdio("设计稿"), cwd: "/work" });
  expect(entry.ref).toMatch(APP_REF);
  expect(entry).toMatchObject({ name: "设计稿", kind: "stdio", enabled: true });
  expect(apps.list()).toEqual([entry]);
  expect(apps.byRef(entry.ref)).toEqual(entry);
  expect(apps.byName("设计稿")).toEqual(entry);

  const reported = apps.reported();
  expect(reported).toEqual([{ ref: entry.ref, name: "设计稿" }]);
  for (const item of reported) {
    for (const key of ["command", "args", "env", "url", "cwd", "kind"]) {
      expect(Object.keys(item)).not.toContain(key);
    }
  }
  expect(JSON.stringify(reported)).not.toContain("API_KEY");

  // Kept beside the token, private like it.
  const file = join(dataDir, "runner-apps.json");
  expect(readFileSync(file, "utf8")).toContain("some-mcp");
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});

test("refuses a duplicate name, an empty or 41-char name, and a 21st app", () => {
  const { apps } = machine();
  apps.add(stdio("一号"));
  expect(() => apps.add(stdio("一号"))).toThrow("重名");
  expect(() => apps.add(stdio("  "))).toThrow("1–40");
  expect(() => apps.add(stdio("x".repeat(41)))).toThrow("1–40");
  // Characters, not UTF-16 units: 40 of an astral character is allowed.
  expect(() => apps.add(stdio("𠮷".repeat(40)))).not.toThrow();

  for (let i = 2; i < 20; i++) apps.add(stdio(`应用${i}`));
  expect(apps.list()).toHaveLength(20);
  expect(() => apps.add(stdio("多出来的"))).toThrow("20");
});

test("refuses a stdio app with no command", () => {
  const { apps } = machine();
  expect(() => apps.add({ ...stdio("空"), command: " " })).toThrow("命令");
  expect(apps.list()).toEqual([]);
});

test("accepts only loopback http urls", () => {
  const { apps } = machine();
  for (const [i, url] of [
    "http://127.0.0.1:3845/mcp",
    "http://localhost/mcp",
    "http://[::1]:9/x",
  ].entries()) {
    const entry = apps.add({ name: `本机${i}`, kind: "http", url });
    expect(entry).toMatchObject({ kind: "http", url, enabled: true });
  }
  for (const url of [
    "http://192.168.1.2/mcp",
    "http://example.com",
    "ftp://localhost",
    "not a url",
  ]) {
    expect(() => apps.add({ name: "远程", kind: "http", url })).toThrow(
      "只能填本机地址",
    );
  }
  expect(apps.list()).toHaveLength(3);
});

test("remove by name or ref; disabled apps are not reported", () => {
  const { apps } = machine();
  const a = apps.add(stdio("甲"));
  const b = apps.add(stdio("乙"));
  expect(apps.setEnabled("乙", false)).toMatchObject({
    ref: b.ref,
    enabled: false,
  });
  expect(apps.reported()).toEqual([{ ref: a.ref, name: "甲" }]);
  expect(apps.list()).toHaveLength(2);
  expect(apps.setEnabled(b.ref, true).enabled).toBeTrue();
  expect(apps.reported()).toHaveLength(2);
  expect(() => apps.setEnabled("没有", true)).toThrow("没有叫");

  expect(apps.remove("甲")).toBeTrue();
  expect(apps.remove(b.ref)).toBeTrue();
  expect(apps.remove("甲")).toBeFalse();
  expect(apps.list()).toEqual([]);
});

test("persists across registry instances", () => {
  const { dataDir, apps } = machine();
  const entry = apps.add(stdio("持久"));
  const http = apps.add({
    name: "网页",
    kind: "http",
    url: "http://localhost:1/mcp",
  });
  apps.setEnabled("网页", false);
  const again = createAppRegistry({ dataDir });
  expect(again.list()).toEqual([entry, { ...http, enabled: false }]);
  expect(again.reported()).toEqual([{ ref: entry.ref, name: "持久" }]);
});

test("names are unique regardless of case", () => {
  const { apps } = machine();
  apps.add(stdio("Figma"));
  expect(() => apps.add(stdio("figma"))).toThrow("重名");
  expect(apps.byName("FIGMA")?.name).toBe("Figma");
});

test("a hand-edited non-loopback http url is dropped on load", () => {
  const { dataDir, apps } = machine();
  apps.add({ name: "好的", kind: "http", url: "http://localhost:1/mcp" });
  apps.add({ name: "被改", kind: "http", url: "http://localhost:2/mcp" });
  const file = join(dataDir, "runner-apps.json");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "http://localhost:2/mcp",
      "http://example.com/mcp",
    ),
  );
  expect(apps.list().map((app) => app.name)).toEqual(["好的"]);
  expect(apps.byName("被改")).toBeUndefined();
});

test('runtime "bundled" persists across instances; any other runtime value is refused', () => {
  const { dataDir, apps } = machine();
  const entry = apps.add({
    ...stdio("自带"),
    command: "bunx",
    args: ["some-mcp"],
    runtime: "bundled",
  });
  expect(entry.kind === "stdio" && entry.runtime).toBe("bundled");
  expect(createAppRegistry({ dataDir }).list()).toEqual([entry]);
  expect(() =>
    apps.add({ ...stdio("别的"), runtime: "node" as unknown as "bundled" }),
  ).toThrow();
  // A hand-edited file with another value drops that entry rather than trusting it.
  const file = join(dataDir, "runner-apps.json");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace('"bundled"', '"node"'),
  );
  expect(createAppRegistry({ dataDir }).list()).toEqual([]);
});
