import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, within } from "@testing-library/react";
import { queryClient } from "@/query-client";
import { APP_VERSION } from "@/routes/_authed/settings/about";
import {
  AUDIENCES,
  type AudienceName,
  OfflineWebSocket,
  renderAt,
  settingKeysIn,
} from "./settings-audience-kit";
import { settleReactWork } from "./settle-react-work";

/*
 * 账户与外观 `/settings`（spec §5.3.1，B01–B10、E01、H01、K01）：同一套路由树、同一份夹具，按受众渲染。
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

/** 页面自己的返回按钮：不算设置侧栏里同名的那一项。 */
function backLink(container: HTMLElement): HTMLElement {
  const own = [
    ...container.querySelectorAll<HTMLElement>("a[href='/settings']"),
  ]
    .filter((link) => !link.closest("[aria-label='设置导航']"))
    .filter((link) => link.textContent?.includes("账户与外观"));
  expect(own.length).toBe(1);
  return own[0];
}

test(
  "页标题是账户与外观，旧标题不再出现",
  async () => {
    const { container } = await renderAt("/settings", "team-admin");
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("账户与外观");
    expect(container.textContent).not.toContain("偏好设置");
  },
  TEST_MS,
);

test(
  "各节带锚点 id：关于你、外观、键盘快捷键、套餐与用量、关于",
  async () => {
    const { container } = await renderAt("/settings", "team-member");
    for (const id of ["about-you", "appearance", "hotkeys", "plan", "about"]) {
      expect(container.querySelector(`section#${id}`)).toBeTruthy();
    }
  },
  TEST_MS,
);

test(
  "套餐与用量一行：摘要「<套餐名> · 本月 N 个任务」，箭头进 /settings/plans",
  async () => {
    const { container } = await renderAt("/settings", "team-member");
    const plan = container.querySelector("section#plan") as HTMLElement;
    const row = await within(plan).findByRole("link", { name: /套餐与用量/ });
    await within(row).findByText("Team · 本月 7 个任务");
    expect(row.getAttribute("href")).toBe("/settings/plans");
  },
  TEST_MS,
);

test(
  "关于：版本只读；开源软件声明进 /settings/about",
  async () => {
    const { container } = await renderAt("/settings", "team-member");
    const about = container.querySelector("section#about") as HTMLElement;
    expect(about.textContent).toContain("版本");
    expect(about.textContent).toContain(APP_VERSION);
    expect(about.querySelector("[data-setting-key]")).toBeNull();
    const notices = within(about).getByRole("link", { name: /开源软件声明/ });
    expect(notices.getAttribute("href")).toBe("/settings/about");
  },
  TEST_MS,
);

describe("部署设置一行：个人版或 maySetUp 的人都有（含团队管理员，过渡期），摘要是待办数", () => {
  const SEES: Record<AudienceName, boolean> = {
    "team-admin": true,
    "team-member": false,
    "team-member-local": true,
    personal: true,
    "unknown-edition": true,
  };
  for (const audience of AUDIENCES) {
    test(
      audience,
      async () => {
        const { container } = await renderAt("/settings", audience);
        const about = container.querySelector("section#about") as HTMLElement;
        const row = within(about).queryByRole("link", { name: /部署设置/ });
        expect(row !== null).toBe(SEES[audience]);
        if (row) {
          expect(row.getAttribute("href")).toBe("/settings/setup");
          await within(row).findByText("2 项待设置");
        }
      },
      TEST_MS,
    );
  }
});

test(
  "名字、长期指令、深色主题、皮肤、消息列表突出显示各带一个 data-setting-key",
  async () => {
    for (const audience of AUDIENCES) {
      const { container } = await renderAt("/settings", audience);
      expect(settingKeysIn(container).sort()).toEqual([
        "account.instructions",
        "account.name",
        "appearance.messageList",
        "appearance.skin",
        "appearance.theme",
      ]);
      cleanup();
    }
  },
  TEST_MS,
);

test(
  "/settings/plans 标题是套餐与用量，有返回按钮回账户与外观",
  async () => {
    const { container } = await renderAt("/settings/plans", "team-admin");
    expect(container.querySelector("h1")?.textContent).toBe("套餐与用量");
    const back = backLink(container as HTMLElement);
    expect(back.getAttribute("href")).toBe("/settings");
  },
  TEST_MS,
);

test(
  "/settings/about 有返回按钮回账户与外观",
  async () => {
    const { container } = await renderAt("/settings/about", "team-member");
    const back = backLink(container as HTMLElement);
    expect(back.getAttribute("href")).toBe("/settings");
  },
  TEST_MS,
);

test(
  "/settings/setup 有返回按钮回账户与外观",
  async () => {
    const { container } = await renderAt("/settings/setup", "team-admin");
    const back = backLink(container as HTMLElement);
    expect(back.getAttribute("href")).toBe("/settings");
  },
  TEST_MS,
);

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
    "带 #appearance 打开：外观一节滚进视野",
    async () => {
      spy();
      await renderAt("/settings#appearance", "team-member");
      expect(scrolled).toContain("appearance");
    },
    TEST_MS,
  );

  test(
    "锚点不存在：什么也不做，也不报错",
    async () => {
      spy();
      const { container } = await renderAt("/settings#nope", "team-member");
      expect(container.querySelector("h1")?.textContent).toBe("账户与外观");
      expect(scrolled).toEqual([]);
    },
    TEST_MS,
  );
});
