import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PluginConnection,
  PluginTeam,
  PluginsPage,
} from "@/lib/plugins/queries";
import { MineScreen } from "@/components/resources/mine-screen";
import { settleReactWork } from "./settle-react-work";

/**
 * 「我的」（`/capabilities/mine`，P4 4a）的内容契约：一个员工被给了什么的单一列表。
 *
 * 4a 画两块——技能（每条带 `runnable` 档位徽章：完整可用/部分可用/暂不可用；null 是没被移植
 * 审计过的手写技能，什么都不画）和连接器（以本人身份访问的读 `/api/plugins/connections` 判断
 * 这个人连上没有，其余看部署手里有没有凭据；都不画「已连接」）。团队块在 4b 由 `/api/teams`
 * 供给，这里不画。
 *
 * 渲染在自己的小路由上：`MineScreen` 的待绑定卡片链接到 `/connections`，那条地址在这棵树里以
 * 桩存在（连接页本身由 aggregate/parity 测试看管）。
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

type Auth = PluginsPage["catalogue"][number]["auth"];

const skill = (
  slug: string,
  title: string,
  runnable: string | null,
  reason?: { blockedReason: string; blockedReasonRef: string },
) => ({
  id: `s-${slug}`,
  slug,
  ownerUserId: null,
  title,
  summary: `${title}的说明。`,
  instructions: "",
  origin: "catalogue",
  installedBy: null,
  runnable,
  blockedReason: reason?.blockedReason ?? null,
  blockedReasonRef: reason?.blockedReasonRef ?? null,
  grantedTo: [] as string[],
  tools: [] as string[],
});

const server = (
  id: string,
  title: string,
  /**
   * 形状上要它，判定上用不到：走哪一条判据由 `catalogue` 里那条 `auth` 决定，而不是卡片自己读
   * 这个字段。
   */
  _auth: Auth,
  hasCredential: boolean,
  /** `custom` 是管理员按地址加的行，`first-party` 是清单里的；broker 的来源另有一组字面量。 */
  provenance = "first-party",
  authScheme: string | null = null,
) => ({
  id,
  title,
  logo: null,
  vendor: title,
  url: `https://${id}.example/mcp`,
  summary: `${title}的说明。`,
  docsUrl: "",
  provenance,
  hasCredential,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  adminConnectOnly: false,
  authScheme,
  tools: [],
  withdrawn: [],
});

/**
 * 清单里的一条，只为回答「这个应用是不是以本人身份访问」：`user-oauth` 的人人各连一个账号，
 * 其余 `auth` 用的是部署手里那一份凭据。
 */
const listed = (key: string, auth: Auth): PluginsPage["catalogue"][number] => ({
  key,
  title: key,
  vendor: key,
  summary: "",
  docsUrl: "",
  auth,
  perInstance: false,
});

const team = (id: string, name: string, memberCount: number): PluginTeam => ({
  id,
  name,
  description: `${name}的说明。`,
  agentIds: Array.from({ length: memberCount }, (_, i) => `${id}-m${i}`),
});

const page = (
  skills: ReturnType<typeof skill>[],
  servers: ReturnType<typeof server>[],
  teams: ReturnType<typeof team>[] = [],
  catalogue: PluginsPage["catalogue"] = [],
): PluginsPage => ({
  catalogue,
  servers,
  skills,
  teams,
  botsMayCallBack: true,
  redirectUri: "https://app.example/oauth/callback",
  composioConfigured: false,
});

const renderMine = async (
  body: unknown,
  options: {
    fail?: boolean;
    /** 本人已连接的行；缺省是一行都没有。 */
    connections?: PluginConnection[];
    /** 让那次读失败：以本人身份访问的应用不许在这种时候替人断言「待绑定」。 */
    connectionsFail?: boolean;
  } = {},
) => {
  globalThis.fetch = (async (input: unknown) => {
    const path =
      String((input as { url?: string }).url ?? input).split("?")[0] ?? "";
    if (options.fail && path.endsWith("/api/plugins")) {
      return Response.json({ error: "boom" }, { status: 500 });
    }
    if (path.endsWith("/api/plugins/connections")) {
      if (options.connectionsFail) {
        return Response.json({ error: "boom" }, { status: 500 });
      }
      return Response.json({
        connections: options.connections ?? [],
        redirectUri: null,
      });
    }
    if (path.endsWith("/api/plugins")) {
      return Response.json(body);
    }
    // 其余端点一律 404：这一页只认 /api/plugins 和连接列表，别的读发出来就该被看见。
    return Response.json({ error: "unknown" }, { status: 404 });
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const mine = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: MineScreen,
  });
  const connections = createRoute({
    getParentRoute: () => root,
    path: "/connections",
    component: () => <p>连接页</p>,
  });
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([mine, connections]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settleReactWork();
  return view;
};

test("each skill is drawn with the grade the package claims, and a hand-written one draws none", async () => {
  const view = await renderMine(
    page(
      [
        skill("full-skill", "完整技能", "full"),
        skill("partial-skill", "降级技能", "degraded"),
        skill("dead-skill", "阻断技能", "blocked"),
        skill("hand-written", "手写技能", null),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("完整技能")).toBeTruthy());
  const row = (title: string) =>
    within(view.getByText(title).closest("li") as HTMLElement);
  expect(row("完整技能").getByRole("status").textContent ?? "").toContain(
    "完整可用",
  );
  expect(row("降级技能").getByRole("status").textContent ?? "").toContain(
    "部分可用",
  );
  expect(row("阻断技能").getByRole("status").textContent ?? "").toContain(
    "暂不可用",
  );
  expect(row("手写技能").queryByRole("status")).toBeNull();
});

test("a badged row answers 缺什么 under the badge; full and hand-written rows stay clean", async () => {
  const view = await renderMine(
    page(
      [
        skill("dead-skill", "阻断技能", "blocked", {
          blockedReason: "shell-command-prose",
          blockedReasonRef:
            '正文给出可执行的 shell 命令；openbot 员工没有本地运行时。 ← "git init -q t"（共 2 处）',
        }),
        skill("full-skill", "完整技能", "full"),
        skill("hand-written", "手写技能", null),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("阻断技能")).toBeTruthy());
  const row = (title: string) =>
    within(view.getByText(title).closest("li") as HTMLElement);
  expect(row("阻断技能").getByText(/openbot 员工没有本地运行时/)).toBeTruthy();
  expect(
    (
      row("阻断技能")
        .getByText(/shell 命令/)
        .closest("p") as HTMLElement
    ).title,
  ).toBe("shell-command-prose");
  expect(row("完整技能").queryByText(/shell/)).toBeNull();
  expect(row("手写技能").queryByText(/缺/)).toBeNull();
});

/**
 * 用部署那一份凭据的应用：缺凭据就是「待绑定」，并给出连接入口；已经有凭据的什么都不画——
 * 无事发生不需要一个徽章，也不需要按一下没有结果的动作。
 */
test("a connector short of the deployment's credential reads 待绑定 and offers the way in, one that has it draws neither", async () => {
  const view = await renderMine(
    page(
      [],
      [
        server("tapd", "TAPD", "deployment-bearer", false),
        server("github", "GitHub", "deployment-bearer", true),
      ],
      [],
      [
        listed("tapd", "deployment-bearer"),
        listed("github", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() =>
    expect(view.getAllByText("TAPD").length).toBeGreaterThan(0),
  );
  const tapd = within(
    view.getAllByText("TAPD")[0]?.closest("li") as HTMLElement,
  );
  expect(tapd.getByText("待绑定")).toBeTruthy();
  expect(tapd.getByRole("link", { name: "去连接" })).toBeTruthy();
  const github = within(
    view.getAllByText("GitHub")[0]?.closest("li") as HTMLElement,
  );
  expect(github.queryByText("待绑定")).toBeNull();
  expect(github.queryByRole("link", { name: "去连接" })).toBeNull();
});

/**
 * 清单里 `builtin` 的应用跑在这个部署里面、`none` 的本来就不要认证（品牌包的 `team:staffing`
 * 是前者，常驻的文档类服务是后者）：没有账号要连、也没有令牌要填。它们没有凭据这件事不是缺什么，
 * 画「待绑定」等于让人去找一个不存在的东西。
 */
test("一个不需要凭据的应用（内建或不认证），不画待绑定，也不给连接入口", async () => {
  const view = await renderMine(
    page(
      [],
      [
        server("team:staffing", "团队协作", "builtin", false),
        server("context7", "Context7", "none", false),
      ],
      [],
      [listed("staffing", "builtin"), listed("context7", "none")],
    ),
  );
  await waitFor(() =>
    expect(view.getAllByText("团队协作").length).toBeGreaterThan(0),
  );
  for (const title of ["团队协作", "Context7"]) {
    const row = within(
      view.getAllByText(title)[0]?.closest("li") as HTMLElement,
    );
    expect(row.queryByText("待绑定")).toBeNull();
    expect(row.queryByRole("link", { name: "去连接" })).toBeNull();
  }
});

/**
 * 以本人身份访问的应用，凭据在每个人自己身上：部署手里有没有凭据回答不了这个问题，要读
 * `/api/plugins/connections`。原先这一块只看 `hasCredential`，于是已经连上的人照样被画「待绑定」、
 * 照样被叫去连接——而卡片自己的原则是「连上了就不画」，动作该跟着同一条原则走。
 */
test("一个要本人授权的应用连上了，就不再画待绑定，也不再叫人去连", async () => {
  const view = await renderMine(
    page(
      [],
      [server("notion", "Notion", "user-oauth", false)],
      [],
      [listed("notion", "user-oauth")],
    ),
    {
      connections: [
        { serverId: "notion", scope: "", connectedAt: "2026-11-14T02:00:00Z" },
      ],
    },
  );
  await waitFor(() =>
    expect(view.getAllByText("Notion").length).toBeGreaterThan(0),
  );
  const row = within(
    view.getAllByText("Notion")[0]?.closest("li") as HTMLElement,
  );
  expect(row.queryByText("待绑定")).toBeNull();
  expect(row.queryByRole("link", { name: "去连接" })).toBeNull();
});

test("一个要本人授权、还没连的应用，画待绑定并给出连接入口", async () => {
  const view = await renderMine(
    page(
      [],
      [server("notion", "Notion", "user-oauth", false)],
      [],
      [listed("notion", "user-oauth")],
    ),
  );
  await waitFor(() =>
    expect(view.getAllByText("Notion").length).toBeGreaterThan(0),
  );
  const row = within(
    view.getAllByText("Notion")[0]?.closest("li") as HTMLElement,
  );
  expect(row.getByText("待绑定")).toBeTruthy();
  expect(row.getByRole("link", { name: "去连接" })).toBeTruthy();
});

test("读不到本人的连接时，要本人授权的应用说读不到，而不是替人断言待绑定", async () => {
  const view = await renderMine(
    page(
      [],
      [server("notion", "Notion", "user-oauth", false)],
      [],
      [listed("notion", "user-oauth")],
    ),
    { connectionsFail: true },
  );
  await waitFor(() =>
    expect(view.getAllByText("Notion").length).toBeGreaterThan(0),
  );
  const row = within(
    view.getAllByText("Notion")[0]?.closest("li") as HTMLElement,
  );
  expect(row.getByText("读不到你的连接")).toBeTruthy();
  expect(row.queryByText("待绑定")).toBeNull();
});

test("the read failing is the page's own alert with a retry, drawing neither block", async () => {
  const view = await renderMine(page([], []), { fail: true });
  await waitFor(() =>
    expect(view.getAllByText(/重试/).length).toBeGreaterThan(0),
  );
  expect(view.queryByText("待绑定")).toBeNull();
});

test("a person with neither skills nor teams nor connectors sees each block say so rather than a blank", async () => {
  const view = await renderMine(page([], []));
  // 4b 起是三块：技能、团队、连接器各说各话，谁也不许画成空白。
  await waitFor(() => expect(view.getAllByText(/还没有/).length).toBe(3));
});

test("each team the package gave draws a card with its member count", async () => {
  const view = await renderMine(
    page(
      [],
      [],
      [team("gstack", "软件工坊", 6), team("software-company", "软件公司", 3)],
    ),
  );
  await waitFor(() => expect(view.getByText("软件工坊")).toBeTruthy());
  expect(view.getByText("6 名员工")).toBeTruthy();
  expect(view.getByText("软件公司")).toBeTruthy();
  expect(view.getByText("3 名员工")).toBeTruthy();
});

test("a person given no teams sees the team block say so, not a blank", async () => {
  const view = await renderMine(page([], []));
  await waitFor(() => expect(view.getByText("还没有被给的团队")).toBeTruthy());
  // 空态数从两变三：技能、团队、连接器各说各话。
  await waitFor(() => expect(view.getAllByText(/还没有/).length).toBe(3));
});

/**
 * 109 条技能里 36 条暂不可用、11 条部分可用：这一页如果只给一个长列表，「我能用什么」要滚到底
 * 才数得出来。汇总先答数，点一下再按档位收窄——两者都从同一份 `/api/plugins` 读，不另发请求。
 */
test("each grade is counted before you scroll, and a count narrows the grid", async () => {
  const view = await renderMine(
    page(
      [
        skill("full-a", "完整甲", "full"),
        skill("full-b", "完整乙", "full"),
        skill("partial-a", "降级甲", "degraded"),
        skill("dead-a", "阻断甲", "blocked"),
        skill("hand-a", "手写甲", null),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("完整甲")).toBeTruthy());

  const tally = within(view.getByRole("group", { name: "按档位筛选" }));
  expect(tally.getByRole("button", { name: /完整可用 2/ })).toBeTruthy();
  expect(tally.getByRole("button", { name: /部分可用 1/ })).toBeTruthy();
  expect(tally.getByRole("button", { name: /暂不可用 1/ })).toBeTruthy();
  // 没被移植审计过的手写技能单独一档，不并进「完整可用」。
  expect(tally.getByRole("button", { name: /未评估 1/ })).toBeTruthy();

  act(() => tally.getByRole("button", { name: /暂不可用 1/ }).click());
  await settleReactWork();
  expect(view.getByText("阻断甲")).toBeTruthy();
  expect(view.queryByText("完整甲")).toBeNull();
  expect(
    tally
      .getByRole("button", { name: /暂不可用 1/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");

  // 再点一次放开，而不是把人困在一个筛选里。
  act(() => tally.getByRole("button", { name: /暂不可用 1/ }).click());
  await settleReactWork();
  expect(view.getByText("完整甲")).toBeTruthy();
});

test("搜索词收窄技能列表，一条都不匹配时给出清除筛选的出口", async () => {
  const view = await renderMine(
    page(
      [
        skill("market-export", "导出市场", "full"),
        skill("delete-guard", "修删除守卫", "blocked", {
          blockedReason: "host-specific-skill",
          blockedReasonRef: "正文只讲宿主平台的操作",
        }),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("导出市场")).toBeTruthy());

  const user = userEvent.setup({ document });
  await user.type(view.getByRole("searchbox", { name: "搜索技能" }), "删除");
  await settleReactWork();
  expect(view.getByText("修删除守卫")).toBeTruthy();
  expect(view.queryByText("导出市场")).toBeNull();

  await user.clear(view.getByRole("searchbox", { name: "搜索技能" }));
  await user.type(
    view.getByRole("searchbox", { name: "搜索技能" }),
    "没有这回事",
  );
  await settleReactWork();
  expect(view.getByText("没有匹配的技能")).toBeTruthy();
  act(() => view.getByRole("button", { name: "清除筛选" }).click());
  await settleReactWork();
  expect(view.getByText("导出市场")).toBeTruthy();
});

/**
 * R18 说徽章打了非 full 就必须答「缺什么」，而卡片只画两行。阻断理由常常比两行长（一句规则
 * 理由 + 一条正文引文 + 处数），截断等于答一半，所以要能就地看全，不用离开这一页。
 */
test("a reason longer than the two lines on the card can be read in full there", async () => {
  const longRef =
    '正文给出可执行的 shell 命令；openbot 员工没有本地运行时。 ← "git init -q t"（共 2 处）；正文引用 scripts/ 下的可执行文件；openbot 无脚本通道。';
  const view = await renderMine(
    page(
      [
        skill("dead-a", "阻断甲", "blocked", {
          blockedReason: "shell-command-prose+executable-scripts",
          blockedReasonRef: longRef,
        }),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("阻断甲")).toBeTruthy());
  const row = within(view.getByText("阻断甲").closest("li") as HTMLElement);
  const reason = () =>
    row.getByText(/openbot 员工没有本地运行时/).closest("p") as HTMLElement;

  expect(reason().className).toContain("line-clamp-2");
  const toggle = row.getByRole("button", { name: "展开原因" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  act(() => toggle.click());
  await settleReactWork();
  expect(reason().className).not.toContain("line-clamp-2");
  expect(
    row.getByRole("button", { name: "收起原因" }).getAttribute("aria-expanded"),
  ).toBe("true");
});

/**
 * 109 条技能一次画完就是一屏接一屏的滚。档位汇总回答「我能用什么」，但浏览还是要一条条看，
 * 所以要能一批一批地给：先说清一共多少、还剩多少，按一下再给一批。
 */
test("技能先画一批，剩下的说清有多少，按一下再给一批", async () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    skill(`s-${i}`, `技能${String(i).padStart(2, "0")}`, "full"),
  );
  const view = await renderMine(page(many, []));
  await waitFor(() => expect(view.getByText("技能00")).toBeTruthy());

  // 第一批三十条：第四十条还在后面，并且这一页说清了这个事实。
  expect(view.getByText("技能29")).toBeTruthy();
  expect(view.queryByText("技能30")).toBeNull();
  expect(view.getByText("已显示 30 / 40")).toBeTruthy();

  act(() => view.getByRole("button", { name: "展开其余 10 条" }).click());
  await settleReactWork();
  expect(view.getByText("技能39")).toBeTruthy();
  // 全部画出来了，就没有东西可按。
  expect(view.queryByRole("button", { name: /展开其余/ })).toBeNull();
  expect(view.queryByText(/已显示/)).toBeNull();
});

test("一批装得下的技能全部画出来，不画展开按钮", async () => {
  const view = await renderMine(
    page([skill("a", "甲", "full"), skill("b", "乙", "blocked")], []),
  );
  await waitFor(() => expect(view.getByText("甲")).toBeTruthy());
  expect(view.getByText("乙")).toBeTruthy();
  expect(view.queryByRole("button", { name: /展开其余/ })).toBeNull();
  expect(view.queryByText(/已显示/)).toBeNull();
});

test("a short reason draws no expand control, because there is nothing hidden", async () => {
  const view = await renderMine(
    page(
      [
        skill("dead-b", "阻断乙", "blocked", {
          blockedReason: "host-specific-skill",
          blockedReasonRef: "正文只讲宿主平台的操作",
        }),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("阻断乙")).toBeTruthy());
  const row = within(view.getByText("阻断乙").closest("li") as HTMLElement);
  expect(row.queryByRole("button", { name: "展开原因" })).toBeNull();
});
