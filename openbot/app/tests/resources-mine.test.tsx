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
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MineScreen } from "@/components/resources/mine-screen";
import type {
  PluginConnection,
  PluginsPage,
  PluginTeam,
} from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * 「我的」（`/capabilities/mine`，P4 4a）的内容契约：一个员工被给了什么的单一列表。
 *
 * 4a 画两块——技能（每条带 `runnable` 档位徽章：完整可用/部分可用/暂不可用；null 是没被移植
 * 审计过的手写技能，什么都不画）和连接器（以本人身份访问的读 `/api/plugins/connections` 判断
 * 这个人连上没有，其余看部署手里有没有凭据；都不画「已连接」）。团队块在 4b 由 `/api/teams`
 * 供给，这里不画。
 *
 * 渲染在自己的小路由上：`MineScreen` 的待绑定卡片链接到 `/connections`，团队卡拉到
 * `/channel/$channelId`，这两条地址在这棵树里以桩存在（连接页与频道本身由各自的测试看管）。
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

/** 搜索框的可访问名字：它收窄的是这一页的三块，不只是技能。 */
const SEARCH_LABEL = "搜索技能、团队和连接器";

type Auth = PluginsPage["catalogue"][number]["auth"];

const skill = (
  slug: string,
  title: string,
  runnable: string | null,
  reason?: { blockedReason: string; blockedReasonRef: string },
  /**
   * 正文。卡片只在有正文时给「看正文」——一条没有正文的技能，那个入口点开只会说「没有正文」。
   */
  instructions = "这位员工照着做就行。",
) => ({
  id: `s-${slug}`,
  slug,
  ownerUserId: null,
  title,
  summary: `${title}的说明。`,
  instructions,
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
    /** 开场就带着的锚点（不带 `#`），用来看「从别处带 # 进来」这一路。 */
    hash?: string;
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
  /*
   * 团队卡的入口落在频道上：多员工的频道由 `/channel/$channelId` 统一转给群聊，所以卡片只认这一条
   * 地址，不必自己判断团里有几个人。
   */
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    component: () => <p>团队频道</p>,
  });
  /*
   * 技能卡的「看正文」落在技能页的只读面板上（`?view=<slug>`），地址参数由那张页自己解析。
   */
  const skillView = createRoute({
    getParentRoute: () => root,
    path: "/capabilities/skills",
    component: () => <p>技能页</p>,
  });
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [options.hash ? `/#${options.hash}` : "/"],
    }),
    routeTree: root.addChildren([mine, connections, channel, skillView]),
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
 * 团队卡原先只画「叫什么、干什么、几个人」，理由是不去重复侧栏已有的频道链接。但这一页是「我被
 * 给了什么」的清单：技能有连接入口、连接器有「去连接」，团队却是死路一条——一支在侧栏里得按名字
 * 去找。清单里列出来的每一样，都该能从它自己走到去用它。
 */
test("a team card offers the way into that team's own channel", async () => {
  const view = await renderMine(
    page([], [], [team("gstack", "软件工坊", 6), team("design", "设计所", 2)]),
  );
  await waitFor(() => expect(view.getByText("软件工坊")).toBeTruthy());
  const link = within(
    view.getByText("软件工坊").closest("li") as HTMLElement,
  ).getByRole("link", { name: "进入软件工坊" });
  expect(link.getAttribute("href")).toBe("/channel/gstack");
  // 每张卡指向自己那个团，不是同一个地址。
  expect(
    within(view.getByText("设计所").closest("li") as HTMLElement)
      .getByRole("link", { name: "进入设计所" })
      .getAttribute("href"),
  ).toBe("/channel/design");
});

/**
 * 连接器块把「已经连好的」和「还要你去连的」并排画在一起，四个里只有一个是待办：要找它得先认一遍
 * 徽章。先挑出来的那个开关也一样从状态算，不另发请求。
 */
test("待连接的连接器可以先挑出来看，再点一次放开", async () => {
  const view = await renderMine(
    page(
      [],
      [
        server("tapd", "TAPD", "deployment-bearer", false),
        server("github", "GitHub", "deployment-bearer", true),
        server("feishu", "飞书", "deployment-bearer", true),
      ],
      [],
      [
        listed("tapd", "deployment-bearer"),
        listed("github", "deployment-bearer"),
        listed("feishu", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() =>
    expect(view.getAllByText("TAPD").length).toBeGreaterThan(0),
  );
  const toggle = () => view.getByRole("button", { name: /只看待连接的 1/ });
  expect(toggle().getAttribute("aria-pressed")).toBe("false");

  act(() => toggle().click());
  await settleReactWork();
  expect(view.getAllByText("TAPD").length).toBeGreaterThan(0);
  expect(view.queryByText("GitHub")).toBeNull();
  expect(view.queryByText("飞书")).toBeNull();
  expect(toggle().getAttribute("aria-pressed")).toBe("true");

  act(() => toggle().click());
  await settleReactWork();
  expect(view.getAllByText("GitHub").length).toBeGreaterThan(0);
  expect(view.getAllByText("飞书").length).toBeGreaterThan(0);
});

/**
 * 一个按了什么都不变的按钮不是功能。全都连好了就没什么可挑的，全都待连接也无从挑——两种情况下
 * 这个开关都不画。
 */
test("没有可挑的就不画只看待连接的", async () => {
  const connected = await renderMine(
    page(
      [],
      [
        server("github", "GitHub", "deployment-bearer", true),
        server("feishu", "飞书", "deployment-bearer", true),
      ],
      [],
      [
        listed("github", "deployment-bearer"),
        listed("feishu", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() =>
    expect(connected.getAllByText("GitHub").length).toBeGreaterThan(0),
  );
  expect(connected.queryByRole("button", { name: /只看待连接的/ })).toBeNull();
  cleanup();

  const allPending = await renderMine(
    page(
      [],
      [
        server("tapd", "TAPD", "deployment-bearer", false),
        server("notion", "Notion", "deployment-bearer", false),
      ],
      [],
      [
        listed("tapd", "deployment-bearer"),
        listed("notion", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() =>
    expect(allPending.getAllByText("TAPD").length).toBeGreaterThan(0),
  );
  expect(allPending.queryByRole("button", { name: /只看待连接的/ })).toBeNull();
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
  // 总览答的是「被给了多少」，不是「这一筛筛出多少」——筛完还是 5 条。
  expect(view.getByText(/^5 条技能$/)).toBeTruthy();
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
  await user.type(view.getByRole("searchbox", { name: SEARCH_LABEL }), "删除");
  await settleReactWork();
  expect(view.getByText("修删除守卫")).toBeTruthy();
  expect(view.queryByText("导出市场")).toBeNull();

  await user.clear(view.getByRole("searchbox", { name: SEARCH_LABEL }));
  await user.type(
    view.getByRole("searchbox", { name: SEARCH_LABEL }),
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

/**
 * 这一页是「我被给了什么」的清单，但三块的规模要滚过三段才数得出来：技能块自己带了档位汇总，团队
 * 和连接器各有多少却只有滚到那儿才知道。页首一行先把三样答完，再往下看细节。
 *
 * 待连接的数只在每个连接器都答得上来时才写：有一次读不到，写「0 个待连接」就是替人断言没连。
 */
test("页首一行答出三块各多少，待连接的数只算真的待连接", async () => {
  const view = await renderMine(
    page(
      [skill("a", "甲", "full"), skill("b", "乙", "blocked")],
      [
        server("tapd", "TAPD", "deployment-bearer", false),
        server("github", "GitHub", "deployment-bearer", true),
        server("feishu", "飞书", "deployment-bearer", true),
      ],
      [team("gstack", "软件工坊", 6), team("design", "设计所", 2)],
      [
        listed("tapd", "deployment-bearer"),
        listed("github", "deployment-bearer"),
        listed("feishu", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() => expect(view.getByText("甲")).toBeTruthy());
  /*
   * 三块各一段，待连接的数写在连接器那一段旁边而不进链接名：读屏念「3 个连接器」已经说清去处，
   * 把括号也念进去只是把一句提示读成一个长名字。
   */
  const jumpNav = view.getByRole("navigation", {
    name: "跳到这一页的各块",
  });
  const nav = within(jumpNav);
  expect(nav.getByRole("link", { name: "2 条技能" })).toBeTruthy();
  expect(nav.getByRole("link", { name: "2 支团队" })).toBeTruthy();
  expect(nav.getByRole("link", { name: "3 个连接器" })).toBeTruthy();
  expect(jumpNav.textContent).toContain("3 个连接器（1 个待连接）");
});

test("连接读不到时不写待连接几个，只说连接器总数", async () => {
  const view = await renderMine(
    page(
      [],
      [
        // 这一张确实待连接（部署没凭据，也不需要本人授权）。
        server("tapd", "TAPD", "deployment-bearer", false),
        // 这一张要读本人连接，而那次读失败了：它答不上来。
        server("notion", "Notion", "user-oauth", false),
      ],
      [],
      [listed("tapd", "deployment-bearer"), listed("notion", "user-oauth")],
    ),
    { connectionsFail: true },
  );
  await waitFor(() => expect(view.getByText("读不到你的连接")).toBeTruthy());
  /*
   * 有一个确实待连接，另一个答不上来：这时候写「1 个待连接」就是把数得出来的那几个当成了全部，
   * 把「不知道」说成「就一个」。所以整句都不写，只说总数。
   */
  expect(view.getByText("2 个连接器")).toBeTruthy();
  expect(view.queryByText(/个待连接/)).toBeNull();
});

test("只有团队的人，总览只说他有的那一样，不留一个空的连接号", async () => {
  const view = await renderMine(
    page([], [], [team("gstack", "软件工坊", 6), team("design", "设计所", 2)]),
  );
  await waitFor(() => expect(view.getByText("软件工坊")).toBeTruthy());
  expect(view.getByText("2 支团队")).toBeTruthy();
});

test("连接器全都连好了，总览只说几个，不写「0 个待连接」", async () => {
  const view = await renderMine(
    page(
      [],
      [
        server("github", "GitHub", "deployment-bearer", true),
        server("feishu", "飞书", "deployment-bearer", true),
      ],
      [],
      [
        listed("github", "deployment-bearer"),
        listed("feishu", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() =>
    expect(view.getAllByText("GitHub").length).toBeGreaterThan(0),
  );
  expect(view.getByText("2 个连接器")).toBeTruthy();
});

test("什么都没被给时不画总览，三块各自说还没有", async () => {
  const view = await renderMine(page([], []));
  await waitFor(() => expect(view.getAllByText(/还没有/).length).toBe(3));
  expect(view.queryByText(/条技能|支团队|个连接器/)).toBeNull();
});

test("整页读不到时不画总览——数字没有来源", async () => {
  const view = await renderMine(page([], []), { fail: true });
  await waitFor(() =>
    expect(view.getAllByText(/重试/).length).toBeGreaterThan(0),
  );
  expect(view.queryByText(/条技能|支团队|个连接器/)).toBeNull();
});

/**
 * 总览把三块的规模答在页首了，但答案本身没有去处：109 条技能铺在最上面，团队和连接器要滚过三十
 * 张技能卡才出现——三块里只有一块够得到。页首那一行是这一页唯一同时提到三块的地方，所以让每一项
 * 各自成为一个锚点：点「3 支团队」就落在团队块。
 *
 * 断言里查目标 id 存不存在，因为 `href="#x"` 指向一个不存在的 id 是一条死链，只验 href 验不出来。
 * `tabindex="-1"` 是同一件事的另一半：跳过去之后键盘要接着从那块走，而不是留在页首那个链接上。
 */
test("总览的每一项都跳到它自己那一块，落点真的存在", async () => {
  const view = await renderMine(
    page(
      [skill("a", "甲", "full")],
      [server("tapd", "TAPD", "deployment-bearer", false)],
      [team("gstack", "软件工坊", 6)],
      [listed("tapd", "deployment-bearer")],
    ),
  );
  await waitFor(() => expect(view.getByText("甲")).toBeTruthy());

  const nav = within(
    view.getByRole("navigation", { name: "跳到这一页的各块" }),
  );
  const jumps = [
    { name: "1 条技能", target: "mine-skills" },
    { name: "1 支团队", target: "mine-teams" },
    { name: "1 个连接器", target: "mine-connectors" },
  ];
  for (const jump of jumps) {
    expect(
      nav.getByRole("link", { name: jump.name }).getAttribute("href"),
    ).toBe(`#${jump.target}`);
    const anchor = document.getElementById(jump.target);
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute("tabindex")).toBe("-1");
  }
});

/**
 * 跳转只给有的那几块：一个「0 支团队」的入口点下去会落在「还没有被给的团队」上，那是把一个不存在
 * 的目的地画成可点的。只有技能的人拿到一个入口，只有团队的人也只拿到一个。
 */
test("总览只给有内容的块画跳转，没被给的块不画入口", async () => {
  const skillsOnly = await renderMine(page([skill("a", "甲", "full")], []));
  await waitFor(() => expect(skillsOnly.getByText("甲")).toBeTruthy());
  const onlySkills = within(
    skillsOnly.getByRole("navigation", { name: "跳到这一页的各块" }),
  );
  expect(onlySkills.getAllByRole("link").length).toBe(1);
  expect(
    onlySkills.getByRole("link", { name: "1 条技能" }).getAttribute("href"),
  ).toBe("#mine-skills");
  cleanup();

  const view = await renderMine(
    page([], [], [team("gstack", "软件工坊", 6), team("design", "设计所", 2)]),
  );
  await waitFor(() => expect(view.getByText("软件工坊")).toBeTruthy());
  const nav = within(
    view.getByRole("navigation", { name: "跳到这一页的各块" }),
  );
  expect(nav.getAllByRole("link").length).toBe(1);
  expect(nav.getByRole("link", { name: "2 支团队" }).getAttribute("href")).toBe(
    "#mine-teams",
  );
});

/**
 * 带 `#mine-teams` 从别处进来（一条分享出去的链接、一次刷新）就该落在团队块上，并且焦点也交给它：
 * 别人的链接指过来的是一块内容，不是一句「往下滚一点」。浏览器自己做前半步，焦点得这里补。
 */
test("地址上带 #块名 进来，落在那一块并把焦点交过去", async () => {
  const view = await renderMine(page([], [], [team("gstack", "软件工坊", 6)]), {
    hash: "mine-teams",
  });
  await waitFor(() => expect(view.getByText("软件工坊")).toBeTruthy());
  expect(document.activeElement?.id).toBe("mine-teams");
});

/**
 * 技能卡说「这条技能能干什么」，但说不清「它到底教员工做什么」——正文（`instructions`）在这一页
 * 从来没有一个读的地方，要看得去技能页，而那页翻开的是编辑面板、只有自己的技能点得开。清单里列
 * 出来的每一样都该能走过去读，所以卡片给一条到正文的路：`/capabilities/skills?view=<slug>`。
 *
 * 没有正文的技能不画这个入口：那个地址打开只会说「这条技能没有正文」，画出来是个空承诺。
 */
test("a skill card gives the way to read its body, and one with no body draws none", async () => {
  const view = await renderMine(
    page(
      [
        skill("report-writer", "写周报", "full"),
        skill("empty-body", "空技能", "full", undefined, "   "),
      ],
      [],
    ),
  );
  await waitFor(() => expect(view.getByText("写周报")).toBeTruthy());
  const link = within(
    view.getByText("写周报").closest("li") as HTMLElement,
  ).getByRole("link", { name: "看正文：写周报" });
  expect(link.getAttribute("href")).toBe(
    "/capabilities/skills?view=report-writer",
  );
  expect(
    within(view.getByText("空技能").closest("li") as HTMLElement).queryByRole(
      "link",
      { name: /看正文/ },
    ),
  ).toBeNull();
});

/**
 * 搜索框原先是「搜索技能」：这一页有三块，它只收窄其中一块，另外两块照旧铺满。人打了字，一半结果
 * 响应、一半不动，比不搜更难懂——而且「这个部署里有没有和 X 有关的东西」本来就不是技能一个块的
 * 问题。现在三块一起收窄。
 *
 * 措辞必须分得开：**一块被搜索词筛空，和它本来就没有，是两件事**。那个团还在，只是不叫这个名字；
 * 这时候说「还没有被给的团队」是在陈述一个假事实，还会把人引去找管理员要东西。
 */
test("一次搜索同时收窄三块，被筛空的那些说没有匹配而不是还没有", async () => {
  const view = await renderMine(
    page(
      [skill("report", "写周报", "full"), skill("meeting", "整理会议", "full")],
      [server("github", "GitHub", "deployment-bearer", true)],
      [team("gstack", "软件工坊", 6), team("design", "设计所", 2)],
      [listed("github", "deployment-bearer")],
    ),
  );
  await waitFor(() => expect(view.getByText("写周报")).toBeTruthy());

  const user = userEvent.setup({ document });
  await user.type(view.getByRole("searchbox", { name: SEARCH_LABEL }), "软件");
  await settleReactWork();

  // 命中在这一块。
  expect(view.getByText("软件工坊")).toBeTruthy();
  expect(view.queryByText("设计所")).toBeNull();
  // 另外两块一条都不匹配：说「没有匹配的」，不说「还没有被给的」。
  expect(view.getByText("没有匹配的技能")).toBeTruthy();
  expect(view.queryByText("还没有被给的技能")).toBeNull();
  expect(view.getByText("没有匹配的连接器")).toBeTruthy();
  expect(view.queryByText("还没有被给的连接器")).toBeNull();
  // 总览答的是「被给了多少」，不是搜出多少——一搜就变小的数字是筛子自己的答案。
  const nav = within(
    view.getByRole("navigation", { name: "跳到这一页的各块" }),
  );
  expect(nav.getByRole("link", { name: "2 条技能" })).toBeTruthy();
  expect(nav.getByRole("link", { name: "2 支团队" })).toBeTruthy();
  expect(nav.getByRole("link", { name: "1 个连接器" })).toBeTruthy();

  // 换一个只命中技能的词：现在轮到团队被筛空。
  await user.clear(view.getByRole("searchbox", { name: SEARCH_LABEL }));
  await user.type(view.getByRole("searchbox", { name: SEARCH_LABEL }), "周报");
  await settleReactWork();
  expect(view.getByText("写周报")).toBeTruthy();
  expect(view.getByText("没有匹配的团队")).toBeTruthy();
  expect(view.queryByText("还没有被给的团队")).toBeNull();
  expect(view.getByText("没有匹配的连接器")).toBeTruthy();
});

/**
 * 搜索框原先只在 `skills.length > 0` 时画。只有团队、没有技能的人拿不到搜索框——那是最需要搜的人：
 * 团队一多，找一支团就得一张张认卡片。
 */
test("只有团队的人也有搜索框，并且搜得动", async () => {
  const view = await renderMine(
    page([], [], [team("gstack", "软件工坊", 6), team("design", "设计所", 2)]),
  );
  await waitFor(() => expect(view.getByText("软件工坊")).toBeTruthy());

  const user = userEvent.setup({ document });
  await user.type(view.getByRole("searchbox", { name: SEARCH_LABEL }), "设计");
  await settleReactWork();
  expect(view.getByText("设计所")).toBeTruthy();
  expect(view.queryByText("软件工坊")).toBeNull();
});

/**
 * 三块各有各的收窄：技能按档位、连接器按「要不要你去连」、三块都按搜索词。「清除筛选」不是一个块
 * 自己的取消键，是这个人在说「我筛乱了，全放开」——所以它得把三块的收窄一起放掉，清一半等于把人
 * 留在另一个空列表里。
 */
test("清除筛选把三块的收窄一起放开", async () => {
  const view = await renderMine(
    page(
      [
        skill("full-a", "完整甲", "full"),
        skill("dead-a", "阻断甲", "blocked", {
          blockedReason: "host-specific-skill",
          blockedReasonRef: "正文只讲宿主平台的操作",
        }),
      ],
      [
        server("tapd", "TAPD", "deployment-bearer", false),
        server("github", "GitHub", "deployment-bearer", true),
      ],
      [team("gstack", "软件工坊", 6), team("design", "设计所", 2)],
      [
        listed("tapd", "deployment-bearer"),
        listed("github", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() => expect(view.getByText("完整甲")).toBeTruthy());

  // 收窄到两处：技能只剩暂不可用，连接器只看待连接的。
  const tally = within(view.getByRole("group", { name: "按档位筛选" }));
  act(() => tally.getByRole("button", { name: /暂不可用 1/ }).click());
  await settleReactWork();
  act(() => view.getByRole("button", { name: /只看待连接的 1/ }).click());
  await settleReactWork();
  expect(view.queryByText("完整甲")).toBeNull();
  expect(view.queryByText("GitHub")).toBeNull();

  // 再叠一个搜索词，三块都被收窄。
  const user = userEvent.setup({ document });
  await user.type(view.getByRole("searchbox", { name: SEARCH_LABEL }), "软件");
  await settleReactWork();
  expect(view.getByText("没有匹配的技能")).toBeTruthy();
  /*
   * 连接器这一块此刻有两个收窄叠着：搜「软件」一条都不匹配，「只看待连接的」也还按着。挑出来的开关
   * 得按**搜索后**那一份算——按全部算就会在「没有匹配」的位置画出那张待连接的卡，等于把一个被筛掉
   * 的结果塞回列表。
   */
  expect(view.getByText("没有匹配的连接器")).toBeTruthy();
  expect(view.queryByText("TAPD")).toBeNull();

  // 一块的「清除筛选」放开的是全部，不是它自己那一块。
  act(() => view.getAllByRole("button", { name: "清除筛选" })[0]?.click());
  await settleReactWork();
  expect(view.getByText("完整甲")).toBeTruthy();
  expect(view.getByText("阻断甲")).toBeTruthy();
  expect(view.getByText("软件工坊")).toBeTruthy();
  expect(view.getByText("设计所")).toBeTruthy();
  // 连接器卡上标题与厂商是同一个词，两处都写出来了。
  expect(view.getAllByText("GitHub").length).toBeGreaterThan(0);
  expect(view.getAllByText("TAPD").length).toBeGreaterThan(0);
  expect(
    tally
      .getByRole("button", { name: /暂不可用 1/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    view
      .getByRole("button", { name: /只看待连接的 1/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

/**
 * 「只看待连接的」挑的是**搜索结果里**待连接的那几张。按全部算，就会把一张连搜索词都不匹配的
 * 待连接卡画进结果里——搜索没漏掉它，是那个开关自己绕过筛子把它塞回来的。
 */
test("只看待连接的只在搜索结果里挑，不把被搜索筛掉的塞回来", async () => {
  const view = await renderMine(
    page(
      [],
      [
        server("alpha", "Alpha", "deployment-bearer", false),
        server("beta", "Beta", "deployment-bearer", false),
        server("alpine", "Alpine", "deployment-bearer", true),
        server("alger", "Alger", "deployment-bearer", true),
      ],
      [],
      [
        listed("alpha", "deployment-bearer"),
        listed("beta", "deployment-bearer"),
        listed("alpine", "deployment-bearer"),
        listed("alger", "deployment-bearer"),
      ],
    ),
  );
  await waitFor(() =>
    expect(view.getAllByText("Alpha").length).toBeGreaterThan(0),
  );

  act(() => view.getByRole("button", { name: /只看待连接的 2/ }).click());
  await settleReactWork();
  expect(view.getAllByText("Beta").length).toBeGreaterThan(0);

  const user = userEvent.setup({ document });
  await user.type(view.getByRole("searchbox", { name: SEARCH_LABEL }), "al");
  await settleReactWork();
  /*
   * 三种卡各司其职：Alpha 既匹配又待连接，留下；Alpine 匹配但已连，被开关筛掉；Beta 待连接却
   * 不匹配，被搜索筛掉。少任何一条筛子，剩下的那张都会出现在这里。
   */
  expect(view.getAllByText("Alpha").length).toBeGreaterThan(0);
  expect(view.queryByText("Beta")).toBeNull();
  expect(view.queryByText("Alpine")).toBeNull();
});
