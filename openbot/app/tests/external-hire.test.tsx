/*
 * 从我的电脑招（外部员工 Task 10）：「招一位新同事」的「从我的电脑招」页签列出本人电脑上装好的智能体和
 * 它们的状态标签，没装的给「怎么安装」；电脑离线、还没认主人时只说明白、不给招聘按钮；招聘设置只列这台电脑
 * 共享的文件夹，按规格的默认规则招聘，手动添加的本机智能体要再确认一次；「云端（下一步）」只说明。
 *
 * 整个 `/bots` 页面挂在内存路由里画，接口由下面的假 fetch 回答，断言读的是真正发出去的请求。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  jest,
  test,
} from "bun:test";
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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  wakersBackLink,
  wakersReturnSearch,
} from "@/components/wakers/wakers-search";
import { DISCOVERY_RETRY_MS } from "@/lib/agents/external";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { settleReactWork } from "./settle-react-work";

type Sent = { url: string; method: string; body: unknown };
const sent: Sent[] = [];
let respond: (request: Sent) => Response | Promise<Response> | undefined;
let originalFetch: typeof fetch;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3010");
      const request = {
        url: url.pathname,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      sent.push(request);
      return (
        (await respond(request)) ??
        Response.json({ error: "not served" }, { status: 404 })
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  sent.length = 0;
  respond = () => undefined;
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const ME = "user-me";

type Device = {
  id: string;
  deviceId: string;
  name: string;
  platform: string;
  lastSeenAt: string;
  online: boolean;
  pairedByUserId: string | null;
  roots: { ref: string; name: string }[];
  apps: { ref: string; name: string }[];
};

function device(over: Partial<Device> = {}): Device {
  return {
    id: "row-mac",
    deviceId: "dev-mac",
    name: "何总的 MacBook Pro",
    platform: "macos",
    lastSeenAt: new Date().toISOString(),
    online: true,
    pairedByUserId: ME,
    roots: [
      { ref: "fld_shop", name: "xiongbao-shop" },
      { ref: "fld_docs", name: "产品文档" },
    ],
    apps: [{ ref: "app_gemini", name: "Gemini CLI" }],
    ...over,
  };
}

const ALL_INSTALLED = [
  {
    harness: "codex",
    version: "0.58.0",
    installed: true,
    acpReady: true,
    signedIn: true,
  },
  {
    harness: "claude-code",
    version: "2.1.3",
    installed: true,
    acpReady: true,
    signedIn: null,
  },
  {
    harness: "hermes",
    version: "0.9.1",
    installed: true,
    acpReady: true,
    signedIn: null,
  },
];

/** Serves the device list, each device's discovery and the hire, and records what was sent. */
function serve({
  devices = [device()],
  discovery = { online: true, agents: ALL_INSTALLED } as {
    online: boolean;
    agents: unknown[];
  },
}: {
  devices?: Device[];
  discovery?: { online: boolean; agents: unknown[] };
} = {}) {
  respond = (request) => {
    if (request.url === "/api/devices" && request.method === "GET")
      return Response.json({ devices });
    const discover = request.url.match(/^\/api\/devices\/([^/]+)\/agents$/);
    if (discover && request.method === "GET") return Response.json(discovery);
    if (request.url === "/api/agents/external" && request.method === "POST")
      return Response.json(
        {
          agent: {
            id: "ext-1",
            name: (request.body as { name: string }).name,
            title: "外部员工 · Codex",
            department: null,
            type: "device_acp",
          },
        },
        { status: 201 },
      );
    return undefined;
  };
}

function draw(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: ME,
    email: "me@example.com",
    name: "何总",
  });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  client.setQueryData(wakerGroupKeys.list(), []);
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>stub {path}</p>,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([
      BotsRoute.update({
        getParentRoute: () => root,
        path: "/bots",
      } as never),
      stub("/bots/$agentId"),
      stub("/settings/devices"),
      stub("/capabilities/roles"),
    ]),
  });
  const screen = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { screen, router };
}

const discoveries = () =>
  sent.filter(
    (request) =>
      /\/agents$/.test(request.url) &&
      request.method === "GET" &&
      request.url.startsWith("/api/devices/"),
  );

const tagsOf = (card: HTMLElement) =>
  within(within(card).getByRole("list", { name: "状态" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

test("lists installed agents with 已安装/已登录/登录状态未知 tags", async () => {
  serve();
  const { screen } = draw("/bots?source=computer");

  const codex = await screen.findByRole("article", { name: "Codex" });
  expect(tagsOf(codex)).toEqual(["已安装", "已登录"]);
  expect(within(codex).getByText(/0\.58\.0/)).toBeTruthy();
  // 读不出登录状态时写「登录状态未知」，不写「未登录」。
  const claude = screen.getByRole("article", { name: "Claude Code" });
  expect(tagsOf(claude)).toEqual(["已安装", "登录状态未知"]);
  // Hermes 没有登录，用的是它自己配置的模型。
  const hermes = screen.getByRole("article", { name: "Hermes" });
  expect(tagsOf(hermes)).toEqual(["已安装", "模型待确认"]);

  expect(screen.getByText("在这台电脑上找到 3 个能招的智能体")).toBeTruthy();
  expect(
    screen
      .getAllByRole("button", { name: /招进来$/ })
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["把 Codex 招进来", "把 Claude Code 招进来", "把 Hermes 招进来"]);
  // 发现只问被选中的那台本人电脑。
  expect(discoveries().map((request) => request.url)).toEqual([
    "/api/devices/dev-mac/agents",
  ]);
  // 页签在、选中的是「从我的电脑招」。
  expect(
    screen
      .getByRole("tab", { name: "从我的电脑招" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("not-installed agents show 怎么安装 links", async () => {
  serve({
    discovery: {
      online: true,
      agents: [
        ALL_INSTALLED[0],
        // Hermes 报上来了但没装；Claude Code 根本没报。
        {
          harness: "hermes",
          version: null,
          installed: false,
          acpReady: false,
          signedIn: null,
        },
      ],
    },
  });
  const { screen } = draw("/bots?source=computer");

  await screen.findByRole("article", { name: "Codex" });
  expect(screen.queryByRole("article", { name: "Hermes" })).toBeNull();
  expect(screen.queryByRole("article", { name: "Claude Code" })).toBeNull();
  const claude = screen.getByRole("link", { name: /Claude Code · 怎么安装/ });
  expect(claude.getAttribute("href")).toBe(
    "https://docs.claude.com/en/docs/claude-code/setup",
  );
  expect(claude.getAttribute("target")).toBe("_blank");
  expect(
    screen
      .getByRole("link", { name: /Hermes · 怎么安装/ })
      .getAttribute("href"),
  ).toBe("https://github.com/NousResearch/hermes-agent");
  // Codex 装好了，所以没有它的安装链接；手动添加一直在。
  expect(screen.queryByRole("link", { name: /Codex · 怎么安装/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: /其他支持开放协议的智能体 · 手动添加/ }),
  ).toBeTruthy();
  expect(screen.getByText("在这台电脑上找到 1 个能招的智能体")).toBeTruthy();
});

test("an installed agent that cannot speak the protocol yet cannot be hired", async () => {
  serve({
    discovery: {
      online: true,
      agents: [{ ...ALL_INSTALLED[0], acpReady: false }],
    },
  });
  const { screen } = draw("/bots?source=computer");
  const codex = await screen.findByRole("article", { name: "Codex" });
  expect(tagsOf(codex)).toEqual(["已安装", "已登录", "还接不上"]);
  expect(
    (
      within(codex).getByRole("button", {
        name: "把 Codex 招进来",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // 说怎么办，不提内部的工具名；也不把它算进「能招的」。
  expect(within(codex).getByText(/先在这台电脑上装好 Node\.js/)).toBeTruthy();
  expect(within(codex).queryByText(/npx|acp/)).toBeNull();
  expect(screen.getByText("这台电脑上还没找到能招的智能体")).toBeTruthy();
});

test("offline device shows 电脑离线 and no hire buttons", async () => {
  serve({ devices: [device({ online: false })] });
  const { screen } = draw("/bots?source=computer");

  expect(await screen.findByText("何总的 MacBook Pro")).toBeTruthy();
  expect(screen.getAllByText("电脑离线").length).toBeGreaterThan(0);
  expect(screen.queryAllByRole("button", { name: /招进来/ })).toEqual([]);
  expect(screen.queryByRole("button", { name: /手动添加/ })).toBeNull();
  // 离线的电脑问不到，所以根本不去问。
  expect(discoveries()).toEqual([]);
});

test("a device the server finds unreachable is offline too", async () => {
  serve({ discovery: { online: false, agents: [] } });
  const { screen } = draw("/bots?source=computer");
  await waitFor(() =>
    expect(screen.getAllByText("电脑离线").length).toBeGreaterThan(0),
  );
  expect(screen.queryAllByRole("button", { name: /招进来/ })).toEqual([]);
});

test("a computer found offline while its heartbeat says online can be looked up again by hand", async () => {
  // 电脑刚短暂断开：设备列表按心跳还说在线，发现结果却是离线。
  const answer = { online: false, agents: [] as unknown[] };
  serve({ discovery: answer });
  const { screen } = draw("/bots?source=computer");
  await waitFor(() =>
    expect(screen.getAllByText("电脑离线").length).toBeGreaterThan(0),
  );
  // 它回来了：「重新查找」不看缓存里的离线结果，始终在。
  answer.online = true;
  answer.agents = ALL_INSTALLED;
  fireEvent.click(await screen.findByRole("button", { name: "重新查找" }));
  expect(
    await screen.findByRole("button", { name: /把 Codex 招进来/ }),
  ).toBeTruthy();
  expect(screen.queryByText("电脑离线")).toBeNull();
});

test("a computer found offline is asked again once after a while, not over and over", async () => {
  // 假时钟从一开始就装上，自动重试的那个计时器才归它管；页面靠一小步一小步推着走。
  jest.useFakeTimers();
  const step = async (ms: number) => {
    for (let left = ms; left > 0; left -= 100)
      await act(async () => {
        jest.advanceTimersByTime(Math.min(100, left));
        await Promise.resolve();
      });
  };
  try {
    serve({ discovery: { online: false, agents: [] } });
    const { screen } = draw("/bots?source=computer");
    await step(1_000);
    expect(screen.getAllByText("电脑离线").length).toBeGreaterThan(0);
    const before = discoveries().length;
    expect(before).toBe(1);
    await step(DISCOVERY_RETRY_MS - 2_000);
    expect(discoveries().length).toBe(before);
    await step(2_000);
    expect(discoveries().length).toBe(before + 1);
    // 还是离线：不再自己问。
    await step(DISCOVERY_RETRY_MS * 4);
    expect(discoveries().length).toBe(before + 1);
  } finally {
    jest.useRealTimers();
  }
});

test("device not paired by me shows 这台电脑还没认主人…", async () => {
  serve({ devices: [device({ pairedByUserId: null })] });
  const { screen } = draw("/bots?source=computer");

  expect(
    await screen.findByText(/这台电脑还没认主人，在桌面端重新登录一次即可认领/),
  ).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /招进来/ })).toEqual([]);
  expect(discoveries()).toEqual([]);
});

test("someone else's device cannot be hired on", async () => {
  serve({ devices: [device({ pairedByUserId: "user-other" })] });
  const { screen } = draw("/bots?source=computer");
  expect(await screen.findByText(/只能在你自己配对的电脑上招/)).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /招进来/ })).toEqual([]);
  expect(discoveries()).toEqual([]);
});

/** 选一个工作文件夹：默认不选，必须本人选。 */
function pickFolder(form: HTMLElement, ref = "fld_shop") {
  fireEvent.change(
    within(form).getByLabelText("工作文件夹（它只在这里面干活）"),
    { target: { value: ref } },
  );
}

const hireButton = (form: HTMLElement) =>
  within(form).getByRole("button", { name: "招进来" }) as HTMLButtonElement;

test("workdir picker lists only the device's shared folders", async () => {
  serve({
    devices: [
      device(),
      device({
        id: "row-pc",
        deviceId: "dev-pc",
        name: "办公室台式机",
        roots: [{ ref: "fld_other", name: "别的电脑的文件夹" }],
      }),
    ],
  });
  const { screen } = draw("/bots?source=computer&device=dev-mac&hire=codex");

  const form = await screen.findByRole("form", { name: "把 Codex 招进来" });
  const picker = within(form).getByLabelText(
    "工作文件夹（它只在这里面干活）",
  ) as HTMLSelectElement;
  expect([...picker.options].map((option) => option.textContent)).toEqual([
    "请选择…",
    "xiongbao-shop",
    "产品文档",
  ]);
  expect([...picker.options].map((option) => option.value)).toEqual([
    "",
    "fld_shop",
    "fld_docs",
  ]);
  // 默认不选，没选不能招。
  expect(picker.value).toBe("");
  await waitFor(() => expect(within(form).queryByText(/正在确认/)).toBeNull());
  expect(hireButton(form).disabled).toBe(true);
  pickFolder(form, "fld_docs");
  expect(picker.value).toBe("fld_docs");
  expect(hireButton(form).disabled).toBe(false);
  expect(screen.getByText(/在 何总的 MacBook Pro 上干活/)).toBeTruthy();
});

test("custom agent requires the second confirmation checkbox", async () => {
  serve({
    devices: [
      device({
        apps: [
          { ref: "app_gemini", name: "Gemini CLI" },
          { ref: "app_files", name: "文件助手" },
        ],
      }),
    ],
  });
  const { screen, router } = draw("/bots?source=computer");

  // 从「手动添加」进招聘设置。
  await userEvent.click(
    await screen.findByRole("button", { name: /手动添加/ }),
  );
  const form = await screen.findByRole("form", {
    name: "把 本机智能体 招进来",
  });
  expect(router.state.location.search).toMatchObject({
    source: "computer",
    device: "dev-mac",
    hire: "custom",
  });
  // 本机程序也不默认选；说明请人自己挑支持开放协议的那个。
  const app = within(form).getByLabelText("本机程序") as HTMLSelectElement;
  expect(app.value).toBe("");
  expect([...app.options].map((option) => option.textContent)).toEqual([
    "请选择…",
    "Gemini CLI",
    "文件助手",
  ]);
  expect(
    within(form).getByText(/选一个支持开放协议的智能体启动程序/),
  ).toBeTruthy();
  fireEvent.change(app, { target: { value: "app_gemini" } });
  pickFolder(form);
  expect(
    screen.getByRole("form", { name: "把 Gemini CLI 招进来" }),
  ).toBeTruthy();

  // 选齐了，没勾第二次确认还是不能招，点了也不发。
  const hire = hireButton(form);
  expect(hire.disabled).toBe(true);
  await userEvent.click(hire);
  expect(sent.filter((request) => request.method === "POST")).toEqual([]);

  await userEvent.click(
    within(form).getByRole("checkbox", { name: /这个智能体可能从不请求许可/ }),
  );
  expect(hire.disabled).toBe(false);
  await userEvent.click(hire);
  await waitFor(() =>
    expect(sent.some((request) => request.method === "POST")).toBe(true),
  );
  const post = sent.find((request) => request.method === "POST");
  expect(post?.body).toMatchObject({
    deviceId: "dev-mac",
    harness: "custom",
    appRef: "app_gemini",
    acknowledgeNoPermission: true,
    workdirRef: "fld_shop",
  });
});

test("hire posts rules with the spec defaults", async () => {
  serve();
  const { screen, router } = draw("/bots?source=computer");

  await userEvent.click(
    await screen.findByRole("button", { name: "把 Codex 招进来" }),
  );
  const form = await screen.findByRole("form", { name: "把 Codex 招进来" });
  // 规格的默认值，逐项。
  const value = (label: string) =>
    (within(form).getByRole("combobox", { name: label }) as HTMLSelectElement)
      .value;
  expect(value("改工作文件夹里的文件")).toBe("direct");
  expect(value("动工作文件夹以外的文件")).toBe("ask");
  expect(value("运行命令")).toBe("dangerous");
  expect(value("联网下载、装依赖")).toBe("ask");
  expect(value("提交并推送代码")).toBe("ask");
  // 底线固定显示，用规格的说法。
  expect(
    within(form).getByText("付款和下单 · 删除文件 · 对外发消息或邮件"),
  ).toBeTruthy();
  expect(within(form).queryByText(/删除整个文件夹/)).toBeNull();
  // 日报项不显示；「先问你」只推到手机。
  expect(within(form).queryByText(/日报/)).toBeNull();
  expect(within(form).getByText(/同时推到你的手机。/)).toBeTruthy();
  expect(within(form).queryByText(/飞书/)).toBeNull();
  // 部门最多 32 个字，输入框直接挡住。
  expect(within(form).getByLabelText("部门").getAttribute("maxlength")).toBe(
    "32",
  );

  pickFolder(form);
  await waitFor(() => expect(hireButton(form).disabled).toBe(false));
  await userEvent.click(hireButton(form));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/ext-1"),
  );
  const posts = sent.filter((request) => request.method === "POST");
  expect(posts.map((request) => request.url)).toEqual(["/api/agents/external"]);
  expect(posts[0]?.body).toEqual({
    deviceId: "dev-mac",
    harness: "codex",
    name: "Codex",
    workdirRef: "fld_shop",
    rules: {
      editInside: "direct",
      touchOutside: "ask",
      runCommand: "dangerous",
      network: "ask",
      push: "ask",
    },
  });

  // 招到以后「返回」回到「从我的电脑招」，不会又是一张「把 Codex 招进来」。
  expect(wakersReturnSearch()).toEqual({
    source: "computer",
    device: "dev-mac",
  });
  await router.navigate(wakersBackLink() as never);
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(await screen.findByRole("article", { name: "Codex" })).toBeTruthy();
  expect(screen.queryByRole("form", { name: /招进来/ })).toBeNull();
});

test("a rule changed to 直接做 warns under its row, the command row most of all", async () => {
  serve();
  const { screen } = draw("/bots?source=computer&device=dev-mac&hire=codex");
  const form = await screen.findByRole("form", { name: "把 Codex 招进来" });
  const row = (label: string) =>
    within(form)
      .getByRole("combobox", { name: label })
      .closest("li") as HTMLElement;
  const set = (label: string, value: string) =>
    fireEvent.change(within(form).getByRole("combobox", { name: label }), {
      target: { value },
    });

  // 「改工作文件夹里的文件」默认就是直接做，不提示；默认状态一条警示都没有。
  expect(within(form).queryByText(/不再问你/)).toBeNull();
  expect(within(form).queryByText(/拦不全/)).toBeNull();

  set("动工作文件夹以外的文件", "direct");
  expect(
    within(row("动工作文件夹以外的文件")).getByText(
      /不再问你；删除文件、付款和下单、对外发消息仍然每次交给你/,
    ),
  ).toBeTruthy();

  set("运行命令", "direct");
  expect(
    within(row("运行命令")).getByText(
      /命令行上的付款、删除、外发.*拦不全.*先问我/,
    ),
  ).toBeTruthy();

  set("运行命令", "ask");
  expect(within(row("运行命令")).queryByText(/拦不全/)).toBeNull();
  set("动工作文件夹以外的文件", "ask");
  expect(within(form).queryByText(/不再问你/)).toBeNull();
});

test("hiring Hermes says it cannot promise every action asks first", async () => {
  serve();
  const { screen } = draw("/bots?source=computer&device=dev-mac&hire=hermes");
  const form = await screen.findByRole("form", { name: "把 Hermes 招进来" });
  expect(within(form).getByText(/Hermes 有自己的智能审批/)).toBeTruthy();
  expect(within(form).getByText(/不能保证它每个动作都先问你/)).toBeTruthy();

  cleanup();
  serve();
  const codex = draw("/bots?source=computer&device=dev-mac&hire=codex").screen;
  const codexForm = await codex.findByRole("form", { name: "把 Codex 招进来" });
  expect(within(codexForm).queryByText(/智能审批/)).toBeNull();
});

test("a refused hire shows the server's sentence and stays on the form", async () => {
  serve();
  const served = respond;
  respond = (request) =>
    request.method === "POST"
      ? Response.json(
          { error: "只能在你自己配对的电脑上招。" },
          { status: 403 },
        )
      : served(request);
  const { screen, router } = draw(
    "/bots?source=computer&device=dev-mac&hire=codex",
  );
  const form = await screen.findByRole("form", { name: "把 Codex 招进来" });
  pickFolder(form);
  await waitFor(() => expect(hireButton(form).disabled).toBe(false));
  await userEvent.click(hireButton(form));
  expect((await within(form).findByRole("alert")).textContent).toBe(
    "只能在你自己配对的电脑上招。",
  );
  expect(router.state.location.pathname).toBe("/bots");
});

test("the hire form opened by address on an offline computer cannot hire", async () => {
  serve({ devices: [device({ online: false })] });
  const { screen } = draw("/bots?source=computer&device=dev-mac&hire=codex");
  const form = await screen.findByRole("form", { name: "把 Codex 招进来" });
  pickFolder(form);
  expect(within(form).getByRole("status").textContent).toMatch(/电脑离线/);
  expect(hireButton(form).disabled).toBe(true);
  expect(discoveries()).toEqual([]);
});

test("the hire form for an agent the computer does not have cannot hire", async () => {
  serve({
    discovery: {
      online: true,
      agents: [
        ALL_INSTALLED[0],
        {
          harness: "hermes",
          version: null,
          installed: false,
          acpReady: false,
          signedIn: null,
        },
        { ...ALL_INSTALLED[1], acpReady: false },
      ],
    },
  });
  const { screen } = draw("/bots?source=computer&device=dev-mac&hire=hermes");
  const form = await screen.findByRole("form", { name: "把 Hermes 招进来" });
  pickFolder(form);
  expect((await within(form).findByRole("status")).textContent).toMatch(
    /这台电脑上还没装 Hermes/,
  );
  expect(hireButton(form).disabled).toBe(true);

  cleanup();
  const claude = draw(
    "/bots?source=computer&device=dev-mac&hire=claude-code",
  ).screen;
  const claudeForm = await claude.findByRole("form", {
    name: "把 Claude Code 招进来",
  });
  pickFolder(claudeForm);
  expect((await within(claudeForm).findByRole("status")).textContent).toMatch(
    /还接不上/,
  );
  expect(hireButton(claudeForm).disabled).toBe(true);
});

test("the hire form says so when the device list cannot be read", async () => {
  respond = (request) =>
    request.url === "/api/devices"
      ? Response.json({ error: "服务器出错了。" }, { status: 500 })
      : undefined;
  const { screen } = draw("/bots?source=computer&device=dev-mac&hire=codex");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("读不到你的电脑");
  expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  expect(screen.queryByText("找不到这台电脑。")).toBeNull();
  expect(screen.queryByRole("form")).toBeNull();
});

test("a failed discovery says so, offers a retry and no hire buttons", async () => {
  serve();
  const served = respond;
  respond = (request) =>
    /\/agents$/.test(request.url) && request.url.startsWith("/api/devices/")
      ? Response.json(
          { error: "没能读到这台电脑上的智能体，请稍后再试。" },
          { status: 502 },
        )
      : served(request);
  const { screen } = draw("/bots?source=computer");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("读不到这台电脑上的智能体");
  expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /招进来|手动添加/ })).toEqual(
    [],
  );
});

test("discovery in flight shows that it is looking, with no hire buttons yet", async () => {
  serve();
  const served = respond;
  respond = (request) =>
    /\/agents$/.test(request.url) && request.url.startsWith("/api/devices/")
      ? new Promise<Response>(() => {})
      : served(request);
  const { screen } = draw("/bots?source=computer");
  expect(await screen.findByText("正在这台电脑上找智能体…")).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /招进来|手动添加/ })).toEqual(
    [],
  );
});

test("the only computer, offline or not mine, offers a way to pair another", async () => {
  for (const only of [
    device({ online: false }),
    device({ pairedByUserId: null }),
    device({ pairedByUserId: "user-other" }),
  ]) {
    serve({ devices: [only] });
    const { screen } = draw("/bots?source=computer");
    const link = await screen.findByRole("link", { name: "去配对一台电脑" });
    expect(link.getAttribute("href")).toBe("/settings/devices");
    cleanup();
  }
  // 有别的电脑可换时，用「换一台电脑」就够了。
  serve({
    devices: [
      device({ online: false }),
      device({ id: "row-pc", deviceId: "dev-pc", name: "办公室台式机" }),
    ],
  });
  const { screen } = draw("/bots?source=computer&device=dev-mac");
  await screen.findByText("打开这台电脑、让", { exact: false });
  expect(screen.queryByRole("link", { name: "去配对一台电脑" })).toBeNull();
});

test("cloud tab is informational and has no hire button", async () => {
  serve();
  const { screen, router } = draw("/bots");

  // 默认是人才市场，标题不变。
  expect(
    await screen.findByRole("heading", { level: 1, name: "人才市场" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "云端（下一步）" }));
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({ source: "cloud" }),
  );
  const panel = screen.getByRole("tabpanel", { name: "云端（下一步）" });
  expect(
    within(panel).getByText(/下一步，同一批外部员工也能在云端干活/),
  ).toBeTruthy();
  expect(within(panel).queryAllByRole("button")).toEqual([]);
  expect(screen.queryAllByRole("button", { name: /招进来|手动添加/ })).toEqual(
    [],
  );
  expect(
    screen.getByRole("heading", { level: 1, name: "招一位新同事" }),
  ).toBeTruthy();
  // 云端不问任何电脑。
  expect(discoveries()).toEqual([]);
});
