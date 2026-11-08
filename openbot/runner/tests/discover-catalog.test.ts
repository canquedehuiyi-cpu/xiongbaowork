import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CatalogEntry, matchCatalog } from "../src/discover-catalog";

/*
 * The built-in catalogue of well-known software. The entries here are samples made up for the test;
 * the shipped catalogue is empty until an entry has been verified on a real machine.
 */

const ENV = { USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AL" };

const CHAT: CatalogEntry = {
  id: "sample-chat",
  name: "示例聊天",
  detect: { installed: "^示例聊天" },
  launch: { bunx: { package: "sample-chat-mcp@1.2.3" } },
  verified: "2026-01-01 测试机 示例聊天 4.0",
};
const PORT_ONLY: CatalogEntry = {
  id: "sample-port",
  name: "示例本地服务",
  detect: { port: { url: "http://127.0.0.1:9999/mcp" } },
  launch: { url: "http://127.0.0.1:9999/mcp" },
  verified: "2026-01-01 测试机 示例 1.0",
};

function ctx(over: Partial<Parameters<typeof matchCatalog>[1]> = {}) {
  return {
    env: ENV,
    installed: [] as string[],
    exists: () => false,
    probe: async () => false,
    ...over,
  };
}

test("an installed-name match makes a candidate; a port-only entry needs a successful probe", async () => {
  const hit = await matchCatalog(
    [CHAT, PORT_ONLY],
    ctx({ installed: ["示例聊天 4.0", "其他"] }),
  );
  expect(hit.found.map((f) => f.name)).toEqual(["示例聊天"]);
  expect(hit.matchedInstalled).toEqual(["示例聊天 4.0"]);

  const probed: string[] = [];
  const up = await matchCatalog(
    [PORT_ONLY],
    ctx({
      probe: async (url) => {
        probed.push(url);
        return true;
      },
    }),
  );
  expect(up.found.map((f) => f.name)).toEqual(["示例本地服务"]);
  expect(probed).toEqual(["http://127.0.0.1:9999/mcp"]);
  expect((await matchCatalog([PORT_ONLY], ctx())).found).toEqual([]);
  const throwing = await matchCatalog(
    [PORT_ONLY],
    ctx({
      probe: async () => {
        throw new Error("refused");
      },
    }),
  );
  expect(throwing.found).toEqual([]);
});

test("a paths entry matches when one path exists, with %VAR% expanded", async () => {
  const entry: CatalogEntry = {
    ...CHAT,
    detect: { paths: ["%LOCALAPPDATA%\\Chat\\chat.exe", "D:\\Chat\\chat.exe"] },
  };
  const asked: string[] = [];
  const result = await matchCatalog(
    [entry],
    ctx({
      exists: (p) => {
        asked.push(p);
        return p === "C:\\Users\\me\\AL\\Chat\\chat.exe";
      },
    }),
  );
  expect(result.found).toHaveLength(1);
  expect(asked[0]).toBe("C:\\Users\\me\\AL\\Chat\\chat.exe");
  expect(result.matchedInstalled).toEqual([]);
});

test("the source label says 正在运行 after a probe and 请先打开它 otherwise", async () => {
  const both: CatalogEntry = {
    ...CHAT,
    detect: { installed: "^示例聊天", port: { url: "http://localhost:7000/" } },
  };
  const running = await matchCatalog(
    [both],
    ctx({ installed: ["示例聊天"], probe: async () => true }),
  );
  expect(running.found[0]?.sourceLabel).toBe(
    "内置清单，检测到 示例聊天 正在运行",
  );
  const idle = await matchCatalog([both], ctx({ installed: ["示例聊天"] }));
  expect(idle.found[0]?.sourceLabel).toBe(
    "内置清单，检测到已安装 示例聊天，使用前请先打开它",
  );
  expect(idle.found[0]?.source).toBe("catalog");
});

test("bunx launches become stdio bunx specs with %USERPROFILE% expanded in args", async () => {
  const entry: CatalogEntry = {
    ...CHAT,
    launch: {
      bunx: {
        package: "sample-chat-mcp@1.2.3",
        args: ["--data", "%USERPROFILE%\\chat"],
      },
    },
  };
  const result = await matchCatalog([entry], ctx({ installed: ["示例聊天"] }));
  expect(result.found[0]?.spec).toEqual({
    kind: "stdio",
    command: "bunx",
    args: ["sample-chat-mcp@1.2.3", "--data", "C:\\Users\\me\\chat"],
    env: {},
  });
});

test("an entry whose args use an unset variable, or whose url is not loopback, is skipped", async () => {
  const unset: CatalogEntry = {
    ...CHAT,
    launch: { bunx: { package: "p@1.0.0", args: ["%NOPE%"] } },
  };
  const remote: CatalogEntry = {
    ...PORT_ONLY,
    launch: { url: "http://example.com/mcp" },
  };
  const probed: string[] = [];
  const result = await matchCatalog(
    [unset, remote],
    ctx({
      installed: ["示例聊天"],
      probe: async (url) => {
        probed.push(url);
        return true;
      },
    }),
  );
  expect(result.found).toEqual([]);
  expect(probed).toEqual([]);
});

test("a probe is only made for a loopback url", async () => {
  const remote: CatalogEntry = {
    ...PORT_ONLY,
    detect: { port: { url: "http://example.com:9999/mcp" } },
  };
  const probed: string[] = [];
  const result = await matchCatalog(
    [remote],
    ctx({
      probe: async (url) => {
        probed.push(url);
        return true;
      },
    }),
  );
  expect(result.found).toEqual([]);
  expect(probed).toEqual([]);
});

test("when the installed programs were not read, an installed-pattern entry is taken as present", async () => {
  const result = await matchCatalog(
    [CHAT, PORT_ONLY],
    ctx({ installedNotRead: true }),
  );
  expect(result.found.map((f) => f.name)).toEqual(["示例聊天"]);
});

test("an invalid installed pattern matches nothing instead of throwing", async () => {
  const bad: CatalogEntry = { ...CHAT, detect: { installed: "(" } };
  const result = await matchCatalog([bad], ctx({ installed: ["("] }));
  expect(result.found).toEqual([]);
});

test("every shipped entry has a verified note and pins an exact package version (@x.y.z)", () => {
  const text = readFileSync(
    join(import.meta.dir, "..", "src", "discover-catalog.json"),
    "utf8",
  );
  const { entries } = JSON.parse(text) as { entries: CatalogEntry[] };
  expect(Array.isArray(entries)).toBe(true);
  for (const entry of entries) {
    expect(entry.verified.trim().length).toBeGreaterThan(0);
    if ("bunx" in entry.launch) {
      expect(entry.launch.bunx.package).toMatch(/^.+@\d+\.\d+\.\d+$/);
    }
  }
});
