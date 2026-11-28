import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { authKeys } from "@/lib/auth/queries";
import {
  movedHref,
  resolveMove,
  resolveMoveIn,
  SETTINGS_MOVES,
  type SettingsMove,
} from "@/lib/settings/moves";
import { queryClient } from "@/query-client";
import { routeTree } from "@/routeTree.gen";
import { renderAt } from "./settings-audience-kit";
import { settleReactWork } from "./settle-react-work";

/*
 * 旧地址表（`SETTINGS_MOVES`）的测试，三层：
 * 1. 匹配规则：拿小的合成表测纯函数 `resolveMoveIn`，不依赖真表里放了什么。
 * 2. 真表本身：排序约束、`movedHref`。
 * 3. 经真实路由树：每一行真的走一遍重定向，落到新地址。后续 PR 加行时，表驱动那一组自动覆盖新行；
 *    有特殊行为的行（带参数、`only`、要看门控的）在文件末尾另加用例。
 */

const move = (
  over: Partial<SettingsMove> & { from: string },
): SettingsMove => ({
  id: "T",
  to: "/to",
  ...over,
});

describe("匹配规则（合成表）", () => {
  test("$name 只匹配一段，段数不对不命中", () => {
    const table = [move({ from: "/a/$name", to: "/b/$name" })];
    expect(resolveMoveIn(table, "/a/x", {})).toBe("/b/x");
    expect(resolveMoveIn(table, "/a", {})).toBeNull();
    expect(resolveMoveIn(table, "/a/x/y", {})).toBeNull();
    expect(resolveMoveIn(table, "/z/x", {})).toBeNull();
  });

  test("结尾 /$ 匹配余下全部，可以为空", () => {
    const table = [move({ from: "/a/$", to: "/b/$" })];
    expect(resolveMoveIn(table, "/a/x/y", {})).toBe("/b/x/y");
    expect(resolveMoveIn(table, "/a/x", {})).toBe("/b/x");
    expect(resolveMoveIn(table, "/a", {})).toBe("/b");
    expect(resolveMoveIn(table, "/a/", {})).toBe("/b");
    expect(resolveMoveIn(table, "/ab/x", {})).toBeNull();
  });

  test("命名参数和余下部分可以一起用", () => {
    const table = [move({ from: "/a/$key/tools/$", to: "/b/$key/t/$" })];
    expect(resolveMoveIn(table, "/a/k1/tools/x/y", {})).toBe("/b/k1/t/x/y");
    expect(resolveMoveIn(table, "/a/k1/tools", {})).toBe("/b/k1/t");
  });

  test("先写的先匹配", () => {
    const table = [
      move({ from: "/a/special", to: "/first" }),
      move({ from: "/a/$name", to: "/second/$name" }),
    ];
    expect(resolveMoveIn(table, "/a/special", {})).toBe("/first");
    expect(resolveMoveIn(table, "/a/other", {})).toBe("/second/other");
    const reversed = [...table].reverse();
    expect(resolveMoveIn(reversed, "/a/special", {})).toBe("/second/special");
  });

  test("search：all 带全部，列表只带列出的，省略不带", () => {
    const search = { a: "1", b: "two", c: true };
    expect(
      resolveMoveIn([move({ from: "/f", search: "all" })], "/f", search),
    ).toBe("/to?a=1&b=two&c=true");
    expect(
      resolveMoveIn([move({ from: "/f", search: ["b", "zzz"] })], "/f", search),
    ).toBe("/to?b=two");
    expect(resolveMoveIn([move({ from: "/f" })], "/f", search)).toBe("/to");
    expect(resolveMoveIn([move({ from: "/f", search: "all" })], "/f", {})).toBe(
      "/to",
    );
  });

  test("hash 放在查询后面", () => {
    const table = [move({ from: "/f", hash: "here", search: ["q"] })];
    expect(resolveMoveIn(table, "/f", { q: "1" })).toBe("/to?q=1#here");
    expect(resolveMoveIn(table, "/f", {})).toBe("/to#here");
  });

  test("only 不满足时这一行当作没写，继续往下找", () => {
    const table = [
      move({ from: "/f", to: "/focused", only: (s) => s.focus !== undefined }),
      move({ from: "/f", to: "/plain" }),
    ];
    expect(resolveMoveIn(table, "/f", { focus: "x" })).toBe("/focused");
    expect(resolveMoveIn(table, "/f", {})).toBe("/plain");
    expect(resolveMoveIn([table[0] as SettingsMove], "/f", {})).toBeNull();
  });

  test("参数值解码一次再编码一次：%2F 和中文原样保留，不二次编码", () => {
    const table = [move({ from: "/a/$name", to: "/b/$name" })];
    expect(resolveMoveIn(table, "/a/x%2Fy", {})).toBe("/b/x%2Fy");
    const chinese = encodeURIComponent("日报");
    expect(resolveMoveIn(table, `/a/${chinese}`, {})).toBe(`/b/${chinese}`);
    expect(resolveMoveIn(table, "/a/%2520", {})).toBe("/b/%2520");
    const rest = [move({ from: "/a/$", to: "/b/$" })];
    expect(resolveMoveIn(rest, `/a/x%2Fy/${chinese}`, {})).toBe(
      `/b/x%2Fy/${chinese}`,
    );
  });

  test("路径里的坏转义不抛错", () => {
    const table = [move({ from: "/a/$name", to: "/b/$name" })];
    expect(() => resolveMoveIn(table, "/a/%E0%A4%A", {})).not.toThrow();
  });
});

describe("真表", () => {
  test("表里具体地址排在同前缀参数地址前面", () => {
    const offenders: string[] = [];
    SETTINGS_MOVES.forEach((later, j) => {
      if (later.from.includes("$")) return;
      SETTINGS_MOVES.slice(0, j).forEach((earlier) => {
        // 前面的行若是参数 / 余下模式，且能匹配后面这个具体地址（无 only 限制），就吞掉了它。
        if (earlier.only) return;
        if (resolveMoveIn([earlier], later.from, {}) !== null) {
          offenders.push(`${earlier.id} 吞掉了 ${later.id}（${later.from}）`);
        }
      });
    });
    expect(offenders).toEqual([]);
  });

  test("行号不重复", () => {
    const ids = SETTINGS_MOVES.map((row) => row.id);
    // 同一行号可以对应带 only 的两条，但不能完全相同的 from + id 重复
    const keys = SETTINGS_MOVES.map((row) => `${row.id} ${row.from}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ids.every((id) => /^U\d{2}$/.test(id))).toBe(true);
  });

  test("movedHref 换服务器发来的旧地址；未知地址原样返回，查询和锚点不丢", () => {
    expect(movedHref("/plans")).toBe("/settings/plans");
    expect(movedHref("/plans#top")).toBe("/settings/plans#top");
    expect(movedHref("/settings/notifications")).toBe(
      "/settings/notifications",
    );
    expect(movedHref("/settings/notifications?x=1#y")).toBe(
      "/settings/notifications?x=1#y",
    );
  });

  test("resolveMove 读真表", () => {
    expect(resolveMove("/plans", {})).toBe("/settings/plans");
    expect(resolveMove("/settings/plans", {})).toBeNull();
  });
});

/* ------------------------------ 经真实路由树 ------------------------------ */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const member = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user" as const,
  onboarding: null,
};

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  const answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: [] }],
    ["GET /api/channels", { channels: [], nextCursor: null }],
    ["GET /api/bots/attention", { bots: [], lastPingId: null }],
    ["GET /api/runtime/info", { version: "test", agents: {} }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const LOAD = { timeout: 25000 };
const TEST_MS = 30000;

function openAt(path: string) {
  queryClient.setQueryData(authKeys.currentUser(), member);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const finalHref = () => {
    const { pathname, searchStr, hash } = router.state.location;
    return `${pathname}${searchStr}${hash ? `#${hash}` : ""}`;
  };
  return { router, view, finalHref };
}

/** 表里一行的样例旧地址：把 `$name` 换成 `sample`，结尾 `$` 换成 `rest/part`。 */
function sample(row: SettingsMove): string {
  return row.from
    .replace(/\/\$$/, "/rest/part")
    .replace(/\$[A-Za-z]+/g, "sample");
}

function expected(row: SettingsMove): string {
  const rest = resolveMoveIn([row], sample(row), {});
  if (rest === null) throw new Error(`${row.id} 样例地址没命中自己`);
  return rest;
}

describe("每一行经真实路由落到新地址", () => {
  for (const row of SETTINGS_MOVES) {
    // 带 only 的行要特定的查询参数才转，由各自的专门用例覆盖。
    if (row.only) continue;
    test(
      `${row.id} ${row.from} 落到 ${row.to}${row.hash ? `#${row.hash}` : ""}`,
      async () => {
        const { finalHref } = openAt(sample(row));
        await waitFor(() => expect(finalHref()).toBe(expected(row)), LOAD);
      },
      TEST_MS,
    );
  }
});

test(
  "U01 /plans 仍去 /settings/plans（服务端 upgradeUrl 的契约）",
  async () => {
    const { finalHref } = openAt("/plans");
    await waitFor(() => expect(finalHref()).toBe("/settings/plans"), LOAD);
  },
  TEST_MS,
);

test(
  "表里没有的 /settings/<未知> 走 notFound，不画空页",
  async () => {
    const { finalHref } = openAt("/settings/no-such-page");
    // 根路由的 notFoundComponent 把人送回首页。
    await waitFor(() => expect(finalHref()).toBe("/"), LOAD);
  },
  TEST_MS,
);

test(
  "表里没有的 /admin/<未知> 对管理员也走 notFound，不画空页",
  async () => {
    queryClient.setQueryData(authKeys.currentUser(), {
      ...member,
      role: "admin",
    });
    const router = createRouter({
      routeTree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ["/admin/no-such-page"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"), LOAD);
  },
  TEST_MS,
);

/* -------------------- U51、U52：电脑页并进电脑与设备（Task 6） -------------------- */

test("U51 /admin/computers 对成员也先转走（admin 路由的预检），落在电脑与设备页顶，团队的电脑一节不画", async () => {
  const { container, finalHref } = await renderAt(
    "/admin/computers",
    "team-member",
  );
  expect(finalHref()).toBe("/settings/devices#team-computers");
  expect(container.querySelector("h1")?.textContent).toBe("电脑与设备");
  expect(container.querySelector("#team-computers")).toBeNull();
  expect(container.textContent).not.toContain("出了点问题");
}, 60000);

test("U51 /admin/computers 对管理员落到团队的电脑一节", async () => {
  const { container, finalHref } = await renderAt(
    "/admin/computers",
    "team-admin",
  );
  expect(finalHref()).toBe("/settings/devices#team-computers");
  expect(container.querySelector("section#team-computers")).not.toBeNull();
}, 60000);

test("U51 /admin/computers 在个人版落到你的员工的浏览器一节（个人版没有团队的电脑）", async () => {
  const { container, finalHref } = await renderAt(
    "/admin/computers",
    "personal",
  );
  expect(finalHref()).toBe("/settings/devices#this-computer");
  expect(container.querySelector("section#this-computer")).not.toBeNull();
  expect(container.querySelector("#team-computers")).toBeNull();
}, 60000);

test("U52 /settings/computer 对团队版管理员落到团队的电脑一节", async () => {
  const { container, finalHref } = await renderAt(
    "/settings/computer",
    "team-admin",
  );
  expect(finalHref()).toBe("/settings/devices#team-computers");
  expect(container.querySelector("section#team-computers")).not.toBeNull();
}, 60000);

test("U52 /settings/computer 在个人版落到你的员工的浏览器一节", async () => {
  const { container, finalHref } = await renderAt(
    "/settings/computer",
    "personal",
  );
  expect(finalHref()).toBe("/settings/devices#this-computer");
  expect(container.querySelector("section#this-computer")).not.toBeNull();
}, 60000);

test("服务器发来的电脑页旧地址换成新地址（部署清单、动作推演）", () => {
  expect(movedHref("/admin/computers")).toBe(
    "/settings/devices#team-computers",
  );
  expect(movedHref("/settings/computer")).toBe(
    "/settings/devices#this-computer",
  );
});
