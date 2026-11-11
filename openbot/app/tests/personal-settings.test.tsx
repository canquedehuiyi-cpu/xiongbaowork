import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { ComputersPage } from "@/components/manage/computers-page";
import { SETTINGS_SIDEBAR_ITEMS } from "@/components/settings/settings-sidebar";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type HostAccessStatus,
  hostAccessKeys,
} from "@/lib/computers/host-access";
import { type ComputerFleet, computerKeys } from "@/lib/computers/queries";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { Route as AdminComputersRoute } from "@/routes/_authed/admin/computers";
import { Route as LearningRoute } from "@/routes/_authed/settings/learning";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function capabilities(edition: "team" | "personal"): DeploymentCapabilities {
  return {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  };
}

function clientFor(edition: "team" | "personal" | undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition)
    client.setQueryData(deploymentKeys.capabilities(), capabilities(edition));
  return client;
}

/*
 * Upstream's personal edition moves pages out of Admin into Settings and makes the Computer page one
 * person's one computer. This deployment has no personal edition, so its tests are gone from here;
 * what stays is what the team edition keeps.
 */

describe("the Settings sidebar", () => {
  test("学习 shows in Settings, open to everyone", () => {
    expect(SETTINGS_SIDEBAR_ITEMS.map((item) => item.title)).toContain("学习");
    expect(LearningRoute.options.beforeLoad).toBeUndefined();
  });
});

/*
 * Upstream's Computer page (`components/manage/computers-page.tsx`), in the team edition. This
 * deployment's Admin still draws its own page (`routes/_authed/admin/computers.tsx`), where these
 * upstream changes are marked M4 待接入, so the page is checked here as upstream wrote it; the last
 * test checks what this deployment's own page already shares with it.
 */
describe("the Computer page", () => {
  /** What the one shared computer answers once the Personal Assistant has opened a page. */
  const fleet: ComputerFleet = {
    isolation: "shared",
    computers: [
      {
        computer: "person:dev-local-user",
        kind: "person",
        personId: "dev-local-user",
        person: { name: "dev@openbot.local", email: "dev@openbot.local" },
        botId: "personal-assistant",
        running: true,
        startedAt: "2026-11-07T04:21:42.051Z",
        egress: "network policy filter",
      },
    ],
  };
  const hostAccess: HostAccessStatus = {
    connected: false,
    grants: [],
    pending: [],
  };
  const assistant = {
    id: "personal-assistant",
    name: "Personal Assistant",
  } as AgentProfile;

  async function renderPage(
    edition: "team" | "personal",
    host: HostAccessStatus = hostAccess,
    computers: ComputerFleet = fleet,
  ) {
    const client = clientFor(edition);
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
    });
    client.setQueryData(computerKeys.fleet(), computers);
    // No Bot is hidden: a name not on the list is then a Bot that is gone.
    client.setQueryData(agentKeys.list(true), []);
    client.setQueryData(hostAccessKeys.status(), host);
    client.setQueryData(agentKeys.list(false), [assistant]);
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({ component: () => <ComputersPage /> }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await view.findByRole("heading", { name: "电脑" });
    return view;
  }

  /**
   * Teach a Bot's browser, as GET /api/computers/fleet lists it beside the Bots' browsers on the personal edition's one
   * computer: a seat named by the person's browser id (`person-` and 32 hex digits), which is no Bot's.
   */
  const teachBrowser: ComputerFleet["computers"][number] = {
    computer: "bot:person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c",
    kind: "bot",
    botId: "person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c",
    running: true,
    startedAt: "2026-11-07T04:15:46.000Z",
    egress: "network policy filter",
  };

  /** One row of the browsers section, by its title. */
  function browserRow(
    view: Awaited<ReturnType<typeof renderPage>>,
    title: string,
  ) {
    const section = view.getByRole("heading", {
      name: /^(你的员工的浏览器|这个部署里的电脑)$/,
    }).parentElement?.parentElement as HTMLElement;
    return within(section)
      .getByText(title)
      .closest('[data-slot="item"]') as HTMLElement;
  }

  test("in the team edition names whose OpenBot browser it is, never a Bot that is gone", async () => {
    const view = await renderPage("team", hostAccess, {
      isolation: "per-person",
      computers: [
        {
          ...teachBrowser,
          person: { name: "Ada", email: "ada@acme.test" },
        },
        {
          ...teachBrowser,
          computer: "bot:person-00000000000000000000000000000000",
          botId: "person-00000000000000000000000000000000",
        },
      ],
    });
    const ada = browserRow(view, "Ada 的熊宝浏览器");
    expect(ada.textContent).toContain("这个人自己教员工做事时用的浏览器");
    expect(ada.textContent).not.toContain("独立");
    expect(view.getByText("某个人的熊宝浏览器")).toBeTruthy();
    expect(view.container.textContent).not.toContain("已不在的员工");

    within(ada).getByRole("button", { name: "重置" }).click();
    const dialog = await view.findByRole("dialog");
    expect(dialog.textContent).toContain("重置 Ada 的熊宝浏览器？");
    expect(dialog.textContent).toContain(
      "这个人在里面登录过的每个网站都会退出。",
    );
    expect(dialog.textContent).not.toContain("这位员工会退出所有服务");
  });

  /** The section the desktop's folder picker is reached from. */
  function foldersSection(view: Awaited<ReturnType<typeof renderPage>>) {
    return view.getByRole("heading", { name: "这台电脑上的文件夹" })
      .parentElement?.parentElement as HTMLElement;
  }

  // OpenBot Desktop gives its server a host, so a Bot's row offers the picker.
  test("in OpenBot Desktop offers each Bot a folder", async () => {
    const view = await renderPage("team", {
      ...hostAccess,
      desktop: true,
      connected: true,
    });
    const folders = foldersSection(view);
    expect(within(folders).getByText("Personal Assistant")).toBeTruthy();
    const choose = within(folders).getByRole("button", {
      name: "选择文件夹",
    }) as HTMLButtonElement;
    expect(choose.disabled).toBe(false);
    expect(folders.textContent).toContain("文件夹是只读的。");
  });

  // Started with scripts/start.sh, or anywhere but the desktop: no host will ever answer, so the
  // section says what is missing instead of offering a picker that cannot open.
  test("outside OpenBot Desktop says the folders need it, with no picker to press", async () => {
    const view = await renderPage("team", {
      ...hostAccess,
      desktop: false,
    });
    const folders = foldersSection(view);
    expect(within(folders).getByText("需要熊宝桌面版")).toBeTruthy();
    expect(
      within(folders).queryByRole("button", { name: "选择文件夹" }),
    ).toBeNull();
    expect(
      within(folders).queryByRole("button", { name: "停止文件夹访问" }),
    ).toBeNull();
    expect(folders.textContent).not.toContain("桌面应用不在线");
  });

  /** A folder request still open, as `GET /api/host-access` lists it. */
  function waiting(
    kind: NonNullable<HostAccessStatus["pending"][number]["kind"]>,
    botId = "personal-assistant",
  ): HostAccessStatus["pending"][number] {
    return {
      operationId: `op-${kind}`,
      kind,
      botId,
      actorId: "dev-local-user",
    };
  }

  const granted: HostAccessStatus = {
    ...hostAccess,
    desktop: true,
    connected: true,
    grants: [
      {
        id: "host-grant-1",
        botId: "personal-assistant",
        actorId: "dev-local-user",
        displayName: "share",
        revoked: false,
      },
    ],
  };

  // Stop folder access is queued for every Bot ("*"). It drew a row of its own, "A Bot no longer
  // here", until the desktop picked it up.
  test("stopping folder access draws no row for a Bot that isn't there", async () => {
    const view = await renderPage("team", {
      ...granted,
      pending: [waiting("stop", "*")],
    });
    const folders = foldersSection(view);
    expect(folders.textContent).not.toContain("已不在的员工");
    expect(folders.textContent).not.toContain("1 个待处理的请求");
  });

  // In the team edition the desktop's owner may be somebody other than the admin reading, so a
  // request waiting on them still says so. Listing and reading wait on nobody.
  test("in the team edition a waiting request names the desktop owner, and reading names nobody", async () => {
    const view = await renderPage("team", {
      ...granted,
      pending: [
        waiting("choose_folder"),
        waiting("write_file"),
        waiting("list_files"),
      ],
    });
    const text = foldersSection(view).textContent ?? "";
    expect(text).toContain(
      "文件夹访问在等桌面应用的主人批准。",
    );
    expect(text).toContain(
      "文件改动在等桌面应用的主人批准，或者还没做完。",
    );
    expect(text).toContain("正在列出文件。");
    expect(text).not.toContain("正在列出文件来自");
    expect(text).toContain("由桌面应用的主人批准 · 只读");
    expect(text).not.toContain("熊宝桌面版正在弹窗问你");
  });

  test("in the team edition still tells an admin how to give each person a computer", async () => {
    const view = await renderPage("team");
    const text = view.container.textContent ?? "";
    expect(view.getByRole("heading", { name: "电脑" })).toBeTruthy();
    expect(text).toContain("COMPUTER_SUPERVISOR_URL");
    expect(text).toContain("这个部署里的电脑");
    expect(text).toContain("dev@openbot.local · Personal Assistant");
    expect(text).toContain("经 network policy filter 出网");
  });

  /** This deployment's own Admin › 电脑, with the same answers. */
  async function renderAdminPage(computers: ComputerFleet = fleet) {
    const client = clientFor("team");
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
    });
    client.setQueryData(computerKeys.fleet(), computers);
    client.setQueryData(agentKeys.list(true), []);
    client.setQueryData(hostAccessKeys.status(), hostAccess);
    client.setQueryData(agentKeys.list(false), [assistant]);
    const Page = AdminComputersRoute.options.component as ComponentType;
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({ component: () => <Page /> }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await view.findByRole("heading", { name: "电脑" });
    return view;
  }

  test("Admin › 电脑 tells an admin how to give each person a computer", async () => {
    const view = await renderAdminPage();
    const text = view.container.textContent ?? "";
    expect(text).toContain("COMPUTER_SUPERVISOR_URL");
    expect(text).toContain("这个部署里的电脑");
    expect(text).toContain("dev@openbot.local · Personal Assistant");
    expect(text).toContain("经 network policy filter 出网");
  });
});
