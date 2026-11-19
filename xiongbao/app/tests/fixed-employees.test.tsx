/*
 * 两个固定员工（8.3）：「招一位新同事」里的「固定员工」页签有 Claude Code 和 Codex 两张卡，一键启用；
 * Claude Code 在云电脑里跑，不用配对电脑；Codex 只能在你自己的电脑上跑，界面上没有云电脑可选，要先配对一台
 * 在线的电脑。员工设置里的「运行位置：云电脑 / 本机」切换：只有 Claude Code 有，切到本机要选一台在线的配对电脑。
 *
 * 整个 `/bots` 页面挂在内存路由里画，接口由下面的假 fetch 回答，断言读的是真正发出去的请求。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
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
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HireSettings } from "@/components/agents/external/hire-settings";
import { ACP_RULE_DEFAULTS } from "@/lib/agents/external";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
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
  refuse,
}: {
  devices?: Device[];
  discovery?: { online: boolean; agents: unknown[] };
  /** 招聘接口拒绝时的状态和话。 */
  refuse?: { status: number; error: string };
} = {}) {
  respond = (request) => {
    if (request.url === "/api/devices" && request.method === "GET")
      return Response.json({ devices });
    const discover = request.url.match(/^\/api\/devices\/([^/]+)\/agents$/);
    if (discover && request.method === "GET") return Response.json(discovery);
    if (
      request.url === "/api/agents/external" &&
      request.method === "POST" &&
      refuse
    )
      return Response.json({ error: refuse.error }, { status: refuse.status });
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

function draw(entry: string, agents: unknown[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), {
    id: ME,
    email: "me@example.com",
    name: "何总",
  });
  client.setQueryData(agentKeys.list(false), agents);
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
      stub("/bots/$agentId/setup"),
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

/** 招聘接口收到的那一次请求。 */
const hires = () =>
  sent.filter(
    (request) =>
      request.url === "/api/agents/external" && request.method === "POST",
  );

const claudeCard = (screen: ReturnType<typeof draw>["screen"]) =>
  screen.findByRole("article", { name: "Claude Code" });

/** 员工列表里招聘人读到的一位外部员工。 */
function employee(
  over: Partial<AgentProfile> & { external: Record<string, unknown> },
): AgentProfile {
  return {
    id: "ext-1",
    name: "Claude Code",
    title: "外部员工",
    mine: true,
    canManage: true,
    ...over,
  } as unknown as AgentProfile;
}

test("固定员工页签里是 Claude Code 和 Codex 两张卡，Claude Code 在云电脑、Codex 在你自己的电脑", async () => {
  serve();
  const { screen } = draw("/bots?source=fixed");

  const claude = await claudeCard(screen);
  const codex = screen.getByRole("article", { name: "Codex" });
  expect(
    screen.getByRole("tab", { name: "固定员工" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(within(claude).getByText("运行位置：云电脑")).toBeTruthy();
  expect(within(claude).getByText(/不用填 key/)).toBeTruthy();
  expect(within(codex).getByText("运行位置：你自己的电脑")).toBeTruthy();
  // Codex 没有云电脑可选：不画选项，写明原因，和服务器拒绝时是同一句话。
  expect(within(codex).queryByRole("radio")).toBeNull();
  expect(
    within(codex).getByText("Codex 员工暂时只能在你自己的电脑上跑。"),
  ).toBeTruthy();
});

test("一键启用 Claude Code：只发云电脑，不带电脑和文件夹，也不用配对电脑", async () => {
  serve({ devices: [] });
  const { screen, router } = draw("/bots?source=fixed");

  const claude = await claudeCard(screen);
  await userEvent.click(
    within(claude).getByRole("button", { name: "启用 Claude Code" }),
  );

  await waitFor(() => expect(hires()).toHaveLength(1));
  expect(hires()[0]?.body).toEqual({
    runtime: "cloud",
    harness: "claude-code",
    name: "Claude Code",
    rules: ACP_RULE_DEFAULTS,
  });
  // 启用后去这位员工的页面。
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/ext-1"),
  );
});

test("一键启用 Codex：用自己配对的在线电脑和它共享的第一个文件夹，运行位置是本机", async () => {
  serve();
  const { screen, router } = draw("/bots?source=fixed");

  const codex = await screen.findByRole("article", { name: "Codex" });
  await within(codex).findByText("何总的 MacBook Pro");
  const enable = within(codex).getByRole("button", {
    name: "启用 Codex",
  }) as HTMLButtonElement;
  await waitFor(() => expect(enable.disabled).toBe(false));
  await userEvent.click(enable);

  await waitFor(() => expect(hires()).toHaveLength(1));
  expect(hires()[0]?.body).toEqual({
    runtime: "device",
    harness: "codex",
    deviceId: "dev-mac",
    workdirRef: "fld_shop",
    name: "Codex",
    rules: ACP_RULE_DEFAULTS,
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/ext-1"),
  );
});

test("Codex 要先配对电脑：没有就提示去配对，不能启用", async () => {
  serve({ devices: [] });
  const { screen } = draw("/bots?source=fixed");

  const codex = await screen.findByRole("article", { name: "Codex" });
  expect(await within(codex).findByText(/还没有配对的电脑/)).toBeTruthy();
  expect(
    within(codex)
      .getByRole("link", { name: "去配对一台电脑" })
      .getAttribute("href"),
  ).toBe("/settings/devices");
  expect(
    (
      within(codex).getByRole("button", {
        name: "启用 Codex",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // Claude Code 不受影响。
  expect(
    (
      within(screen.getByRole("article", { name: "Claude Code" })).getByRole(
        "button",
        { name: "启用 Claude Code" },
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(hires()).toEqual([]);
});

test("Codex 的电脑离线、没装 Codex、没有共享文件夹时不能启用，各说各的原因", async () => {
  serve({ devices: [device({ online: false })] });
  let view = draw("/bots?source=fixed");
  let codex = await view.screen.findByRole("article", { name: "Codex" });
  expect(await within(codex).findByText(/电脑离线/)).toBeTruthy();
  expect(
    (
      within(codex).getByRole("button", {
        name: "启用 Codex",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  cleanup();

  serve({ devices: [device({ roots: [] })] });
  view = draw("/bots?source=fixed");
  codex = await view.screen.findByRole("article", { name: "Codex" });
  expect(await within(codex).findByText(/还没有共享文件夹/)).toBeTruthy();
  cleanup();

  serve({ discovery: { online: true, agents: [] } });
  view = draw("/bots?source=fixed");
  codex = await view.screen.findByRole("article", { name: "Codex" });
  expect(await within(codex).findByText(/还没装 Codex/)).toBeTruthy();
  expect(
    (
      within(codex).getByRole("button", {
        name: "启用 Codex",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(hires()).toEqual([]);
});

test("已经有这一家的外部员工就写已启用，给打开和设置，不再启用第二个", async () => {
  serve();
  const { screen } = draw("/bots?source=fixed", [
    employee({
      id: "ext-cc",
      name: "我的 Claude Code",
      external: {
        harness: "claude-code",
        runtime: "cloud",
        deviceId: "cloud:ext-cc",
        workdirRef: "cloud:workspace",
        rules: ACP_RULE_DEFAULTS,
      },
    }),
  ]);

  const claude = await claudeCard(screen);
  expect(within(claude).getByText(/已启用 · 我的 Claude Code/)).toBeTruthy();
  expect(
    within(claude).getByRole("link", { name: "打开" }).getAttribute("href"),
  ).toBe("/bots/ext-cc");
  expect(
    within(claude).getByRole("link", { name: "设置" }).getAttribute("href"),
  ).toBe("/bots/ext-cc/setup");
  expect(
    within(claude).queryByRole("button", { name: "启用 Claude Code" }),
  ).toBeNull();
  // 另一家没有，照样能启用。
  const codex = screen.getByRole("article", { name: "Codex" });
  expect(within(codex).queryByText(/已启用/)).toBeNull();
});

test("服务器拒绝时把它的话写在卡片上", async () => {
  serve({ refuse: { status: 402, error: "员工名额已满" } });
  const { screen } = draw("/bots?source=fixed");
  const claude = await claudeCard(screen);
  await userEvent.click(
    within(claude).getByRole("button", { name: "启用 Claude Code" }),
  );
  expect(await within(claude).findByRole("alert")).toHaveProperty(
    "textContent",
    "员工名额已满",
  );
});

/* ---- 员工设置里的「运行位置：云电脑 / 本机」 ---- */

const CLOUD_RUN = {
  harness: "claude-code",
  deviceId: "cloud:ext-cc",
  workdirRef: "cloud:workspace",
  runtime: "cloud",
  rules: ACP_RULE_DEFAULTS,
} as const;
const DEVICE_RUN = {
  harness: "claude-code",
  deviceId: "dev-mac",
  workdirRef: "fld_shop",
  rules: ACP_RULE_DEFAULTS,
} as const;
const CODEX_RUN = { ...DEVICE_RUN, harness: "codex" } as const;

function settings(
  external: Record<string, unknown>,
  harness: "claude-code" | "codex",
  devices: Device[] = [device()],
) {
  respond = (request) => {
    if (request.url === "/api/devices" && request.method === "GET")
      return Response.json({ devices });
    if (
      request.url === "/api/agents/external/ext-cc" &&
      request.method === "PATCH"
    )
      return Response.json({
        agent: { id: "ext-cc", name: "Claude Code", type: "device_acp" },
      });
    return undefined;
  };
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
  let saved = "";
  const root = createRootRoute({
    component: () => (
      <HireSettings
        deviceId={String(external.deviceId)}
        editing={{
          agentId: "ext-cc",
          name: "Claude Code",
          department: null,
          external: external as never,
        }}
        harness={harness}
        onHired={(id) => {
          saved = id;
        }}
      />
    ),
  });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/settings/devices",
        component: () => <p>stub devices</p>,
      } as never),
    ]),
  });
  const screen = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { screen, saved: () => saved };
}

const patches = () => sent.filter((request) => request.method === "PATCH");

test("云电脑上的 Claude Code：运行位置选着云电脑，没有电脑和文件夹要选，保存只送名字和规则", async () => {
  const { screen, saved } = settings(CLOUD_RUN, "claude-code");
  const form = await screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });

  const group = within(form).getByRole("radiogroup", { name: "运行位置" });
  expect(
    (within(group).getByRole("radio", { name: "云电脑" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (within(group).getByRole("radio", { name: "本机" }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  expect(
    within(form).queryByLabelText("工作文件夹（它只在这里面干活）"),
  ).toBeNull();
  expect(within(form).queryByLabelText("电脑")).toBeNull();
  expect(within(form).getByText(/在云电脑里干活/)).toBeTruthy();

  await userEvent.click(within(form).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saved()).toBe("ext-cc"));
  expect(patches()[0]?.body).toEqual({
    name: "Claude Code",
    department: "",
    rules: ACP_RULE_DEFAULTS,
  });
});

test("切到本机：默认选上在线的配对电脑，选好文件夹才能存，存的是运行位置加电脑和文件夹", async () => {
  const { screen, saved } = settings(CLOUD_RUN, "claude-code");
  const form = await screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });
  const save = within(form).getByRole("button", {
    name: "保存",
  }) as HTMLButtonElement;

  await userEvent.click(within(form).getByRole("radio", { name: "本机" }));
  // 电脑已经选上在线的那台，文件夹要本人选。
  expect(within(form).getByLabelText("电脑")).toHaveProperty(
    "value",
    "dev-mac",
  );
  expect(save.disabled).toBe(true);
  fireEvent.change(
    within(form).getByLabelText("工作文件夹（它只在这里面干活）"),
    { target: { value: "fld_docs" } },
  );
  expect(save.disabled).toBe(false);
  await userEvent.click(save);

  await waitFor(() => expect(saved()).toBe("ext-cc"));
  expect(patches()[0]?.body).toEqual({
    name: "Claude Code",
    department: "",
    runtime: "device",
    deviceId: "dev-mac",
    workdirRef: "fld_docs",
    rules: ACP_RULE_DEFAULTS,
  });
});

test("切到本机但没有配对的电脑：提示先去配对，不能存", async () => {
  const { screen } = settings(CLOUD_RUN, "claude-code", []);
  const form = await screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });
  await userEvent.click(within(form).getByRole("radio", { name: "本机" }));

  expect(await within(form).findByText(/还没有配对的电脑/)).toBeTruthy();
  expect(
    within(form)
      .getByRole("link", { name: "去配对一台电脑" })
      .getAttribute("href"),
  ).toBe("/settings/devices");
  expect(
    (within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // 切回云电脑又能存了。
  await userEvent.click(within(form).getByRole("radio", { name: "云电脑" }));
  expect(
    (within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("切到本机但电脑离线、或是别人配对的：不能存", async () => {
  const { screen } = settings(CLOUD_RUN, "claude-code", [
    device({ online: false }),
  ]);
  const form = await screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });
  await userEvent.click(within(form).getByRole("radio", { name: "本机" }));
  expect(await within(form).findByText(/电脑离线/)).toBeTruthy();
  expect(
    (within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  cleanup();

  const other = settings(CLOUD_RUN, "claude-code", [
    device({ pairedByUserId: "user-other" }),
  ]);
  const second = await other.screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });
  await userEvent.click(within(second).getByRole("radio", { name: "本机" }));
  expect(await within(second).findByText(/还没有配对的电脑/)).toBeTruthy();
  expect(
    (within(second).getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("本机上的 Claude Code 可以切到云电脑：存的是运行位置，不带电脑和文件夹", async () => {
  const { screen, saved } = settings(DEVICE_RUN, "claude-code");
  const form = await screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });
  expect(
    (within(form).getByRole("radio", { name: "本机" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    within(form).getByLabelText("工作文件夹（它只在这里面干活）"),
  ).toBeTruthy();

  await userEvent.click(within(form).getByRole("radio", { name: "云电脑" }));
  expect(
    within(form).queryByLabelText("工作文件夹（它只在这里面干活）"),
  ).toBeNull();
  await userEvent.click(within(form).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saved()).toBe("ext-cc"));
  expect(patches()[0]?.body).toEqual({
    name: "Claude Code",
    department: "",
    runtime: "cloud",
    rules: ACP_RULE_DEFAULTS,
  });
});

test("Codex 固定在本机：云电脑那一项不可选并写明原因，不改运行位置就不送 runtime", async () => {
  const { screen, saved } = settings(CODEX_RUN, "codex");
  const form = await screen.findByRole("form", {
    name: "改 Claude Code 的配置",
  });

  const cloud = within(form).getByRole("radio", {
    name: "云电脑",
  }) as HTMLInputElement;
  expect(cloud.disabled).toBe(true);
  expect(
    (within(form).getByRole("radio", { name: "本机" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    within(form).getByText("Codex 员工暂时只能在你自己的电脑上跑。"),
  ).toBeTruthy();

  await userEvent.click(within(form).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saved()).toBe("ext-cc"));
  expect(patches()[0]?.body).toEqual({
    name: "Claude Code",
    department: "",
    rules: ACP_RULE_DEFAULTS,
  });
});
