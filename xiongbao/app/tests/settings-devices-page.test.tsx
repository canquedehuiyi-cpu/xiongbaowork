import {
  afterAll,
  afterEach,
  beforeAll,
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { TEAM_ADMIN_NOTE } from "@/components/settings/settings-section";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { routeTree } from "@/routeTree.gen";
import {
  AUDIENCES,
  type AudienceName,
  OfflineWebSocket,
  renderAt,
  settingKeysIn,
  stubFetchFor,
} from "./settings-audience-kit";
import { settleReactWork } from "./settle-react-work";

/*
 * 电脑与设备 `/settings/devices`（spec §5.3.5，F01–F04、N19、O07、O08、O17、O18）：同一套路由树、
 * 同一份夹具，按受众渲染。页面级的门控用例（从 settings-gating 挪来）也在这里。
 */

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
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

const TEST_MS = 60000;

/** 页上各节的锚点，按出现顺序。 */
function sectionIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("section[id]")].map(
    (section) => section.id,
  );
}

function sectionTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll("section > div > h2")].map(
    (heading) => heading.textContent ?? "",
  );
}

/** 一节的描述（标题下面那一段）。 */
function descriptionOf(section: Element): string {
  return section.querySelector(":scope > p")?.textContent ?? "";
}

describe("页标题电脑与设备，第一节「我的设备」", () => {
  for (const audience of AUDIENCES) {
    test(
      audience,
      async () => {
        const { container } = await renderAt("/settings/devices", audience);
        expect(container.querySelector("h1")?.textContent).toBe("电脑与设备");
        const first = container.querySelector("section[id]");
        expect(first?.id).toBe("my-devices");
        expect(first?.querySelector("h2")?.textContent).toBe("我的设备");
      },
      TEST_MS,
    );
  }
});

test(
  "个人版有「你的员工的浏览器」「这台电脑上的文件夹」，没有团队三节",
  async () => {
    const { container } = await renderAt("/settings/devices", "personal");
    expect(sectionIds(container)).toEqual([
      "my-devices",
      "this-computer",
      "this-computer-folders",
    ]);
    expect(sectionTitles(container)).toEqual([
      "我的设备",
      "你的员工的浏览器",
      "这台电脑上的文件夹",
    ]);
    const text = container.textContent ?? "";
    for (const gone of ["团队的电脑", "闲置电脑", "COMPUTER_SUPERVISOR_URL"]) {
      expect(text).not.toContain(gone);
    }
    // 个人版：一位员工一行，没有「谁的座位」「从哪出网」。
    const browsers = container.querySelector("#this-computer") as HTMLElement;
    await within(browsers).findByRole("button", { name: "停止浏览器" });
    expect(browsers.textContent).not.toContain("出网");
    expect(settingKeysIn(container)).toEqual([]);
  },
  TEST_MS,
);

describe("团队版管理员有「团队的电脑」「网络」「闲置电脑」，描述首句是「只有管理员看得到。改动对所有成员生效。」", () => {
  for (const audience of ["team-admin", "unknown-edition"] as const) {
    test(
      audience,
      async () => {
        const { container } = await renderAt("/settings/devices", audience);
        expect(sectionIds(container)).toEqual([
          "my-devices",
          "team-computers",
          "network",
          "idle",
        ]);
        expect(sectionTitles(container)).toEqual([
          "我的设备",
          "团队的电脑",
          "网络",
          "闲置电脑",
        ]);
        for (const id of ["team-computers", "network", "idle"]) {
          const section = container.querySelector(`section#${id}`) as Element;
          expect(descriptionOf(section).startsWith(TEAM_ADMIN_NOTE)).toBe(true);
        }
      },
      TEST_MS,
    );
  }

  test(
    "团队的电脑：这个部署里的电脑（停止、重置、出口）和每位员工的文件夹",
    async () => {
      const { container } = await renderAt("/settings/devices", "team-admin");
      const team = container.querySelector("#team-computers") as HTMLElement;
      await within(team).findByText("dev@xiongbao.local · 数据分析员");
      const text = team.textContent ?? "";
      expect(text).toContain("COMPUTER_SUPERVISOR_URL");
      expect(text).toContain("这个部署里的电脑");
      expect(text).toContain("经 network policy filter 出网");
      expect(text).toContain("这台电脑上的文件夹");
      expect(
        within(team).getByRole("button", { name: "停止浏览器" }),
      ).toBeTruthy();
      expect(within(team).getAllByRole("button", { name: "重置" }).length).toBe(
        1,
      );
      // 审计记录的链接留在团队版的审计页。
      const audit = within(team)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"));
      expect(audit).toContain("/admin/audit");
    },
    TEST_MS,
  );

  test(
    "网络：组织一行带 network.policy.organization，每个分组一行不带键，可以添加分组策略",
    async () => {
      const { container } = await renderAt("/settings/devices", "team-admin");
      const network = container.querySelector("#network") as HTMLElement;
      const organization = await within(network).findByRole("button", {
        name: /组织/,
      });
      expect(organization.getAttribute("data-setting-key")).toBe(
        "network.policy.organization",
      );
      const group = within(network).getByRole("button", {
        name: /分组：sales/,
      });
      expect(group.hasAttribute("data-setting-key")).toBe(false);
      expect(
        within(network).getByRole("button", { name: "添加分组策略" }),
      ).toBeTruthy();
      expect([...network.querySelectorAll("[data-setting-key]")].length).toBe(
        1,
      );
    },
    TEST_MS,
  );

  test(
    "闲置电脑：停掉闲置电脑一行带 enterprise.inactiveComputerDays，另有立即停掉",
    async () => {
      const { container } = await renderAt("/settings/devices", "team-admin");
      const idle = container.querySelector("#idle") as HTMLElement;
      const row = await within(idle).findByRole("button", {
        name: /^停掉闲置电脑/,
      });
      expect(row.getAttribute("data-setting-key")).toBe(
        "enterprise.inactiveComputerDays",
      );
      expect(row.textContent).toContain("闲置 7 天后");
      expect(
        within(idle).getByRole("button", { name: "立即停掉闲置电脑" }),
      ).toBeTruthy();
    },
    TEST_MS,
  );
});

describe("团队版成员只有「我的设备」", () => {
  for (const audience of [
    "team-member",
    "team-member-local",
  ] as AudienceName[]) {
    test(
      audience,
      async () => {
        const { container } = await renderAt("/settings/devices", audience);
        expect(sectionIds(container)).toEqual(["my-devices"]);
        expect(settingKeysIn(container)).toEqual([]);
        const text = container.textContent ?? "";
        for (const gone of [
          "团队的电脑",
          "这台电脑上的文件夹",
          "你的员工的浏览器",
        ]) {
          expect(text).not.toContain(gone);
        }
      },
      TEST_MS,
    );
  }
});

test(
  "受众读完之前，团队和个人版的节一个都不画，我的设备照常画",
  async () => {
    stubFetchFor("team-admin");
    const answered = globalThis.fetch;
    // 版本一直读不回来：受众永远不 ready。
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost/");
        if (url.pathname === "/api/capabilities") {
          return new Promise<Response>(() => {});
        }
        return answered(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    queryClient.setQueryData(authKeys.currentUser(), {
      id: "admin",
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
      onboarding: null,
    });
    const router = createRouter({
      routeTree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ["/settings/devices"] }),
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await waitFor(
      () =>
        expect(view.container.querySelector("h1")?.textContent).toBe(
          "电脑与设备",
        ),
      { timeout: 25000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sectionIds(view.container)).toEqual(["my-devices"]);
  },
  TEST_MS,
);

test(
  "企业管控页不再有网络和电脑两节",
  async () => {
    const { container } = await renderAt("/admin/enterprise", "team-admin");
    await waitFor(() => expect(sectionTitles(container)).toContain("能力"));
    const titles = sectionTitles(container);
    expect(titles).not.toContain("网络");
    expect(titles).not.toContain("电脑");
    const text = container.textContent ?? "";
    expect(text).not.toContain("停掉闲置电脑");
    expect(text).not.toContain("添加分组策略");
  },
  TEST_MS,
);

describe("页面描述说得出这个人在这页能做什么", () => {
  const OWN = "配对你自己的电脑，让员工在上面替你干活。";
  const ADMIN = `${OWN}作为管理员，你还可以管理团队的电脑、员工的电脑能连到哪里，以及闲置多久后停掉。`;
  const EXPECTED: Record<AudienceName, string> = {
    "team-admin": ADMIN,
    "unknown-edition": ADMIN,
    "team-member": OWN,
    "team-member-local": OWN,
    personal: `${OWN}你也可以在这里停止或重置员工的浏览器，并选择员工能读取这台电脑上的哪些文件夹。`,
  };
  for (const audience of AUDIENCES) {
    test(
      audience,
      async () => {
        const { container } = await renderAt("/settings/devices", audience);
        const description = container.querySelector("header p");
        expect(description?.textContent).toBe(EXPECTED[audience]);
      },
      TEST_MS,
    );
  }
});

describe("锚点", () => {
  const scrolled: string[] = [];
  let original: typeof HTMLElement.prototype.scrollIntoView;
  function spy() {
    original = HTMLElement.prototype.scrollIntoView;
    scrolled.length = 0;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.id);
    };
  }
  afterEach(() => {
    if (original) HTMLElement.prototype.scrollIntoView = original;
  });

  test(
    "带 #network 打开：管理员滚到网络一节",
    async () => {
      spy();
      await renderAt("/settings/devices#network", "team-admin");
      expect(scrolled).toContain("network");
    },
    TEST_MS,
  );

  test(
    "成员带 #team-computers 打开：那一节不画，落在页顶，不报错",
    async () => {
      spy();
      const { container } = await renderAt(
        "/settings/devices#team-computers",
        "team-member",
      );
      expect(container.querySelector("h1")?.textContent).toBe("电脑与设备");
      expect(scrolled).toEqual([]);
    },
    TEST_MS,
  );
});
