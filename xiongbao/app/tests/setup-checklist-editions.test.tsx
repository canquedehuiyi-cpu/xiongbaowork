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
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { queryClient } from "@/query-client";
import { Route as SetupRoute } from "@/routes/_authed/settings/setup";
import type { Edition } from "../../server/src/edition";
import {
  createSetupRoutes,
  createSetupSources,
} from "../../server/src/setup/checklist";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Setup in each edition, with the server's own setup routes behind `fetch`, so every
 * sentence on the page is the one the server writes.
 *
 * The personal edition has no memory (#1233) and no admin. On Windows its Setup still said the back
 * end "Keeps your conversations and what XiongBao remembers", that people "can connect more apps
 * than the ones an admin adds", and linked the Admin pages by their Admin names, Credentials and
 * Computers, where its Settings call them Keys and Computer. A team deployment keeps its words.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const defaults = queryClient.getDefaultOptions();
beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
  globalThis.fetch = originalFetch;
});

/**
 * Serves `/api/setup` from the server's routes for one edition. No model key, so the model row
 * names the page to add one; a computer that is set up and not yet asked, so its row names the
 * page computers show up on. The person is an admin, as the one person on the personal edition is.
 */
function serve(edition: Edition, facts: { moreApps: boolean }) {
  const sources = createSetupSources({
    productName: "XiongBao",
    config: { singleUser: edition === "personal", edition },
    environment: {},
    model: {
      provider: "openai",
      keyId: "default",
      defaultModel: "gpt-5.6-terra",
      plan: false,
    },
    credentials: { list: async () => [] },
    computer: true,
    apps: { configured: facts.moreApps },
    chat: false,
  });
  const routes = createSetupRoutes(sources, async (context, next) => {
    context.set("actor", {
      id: "person",
      email: "person@example.test",
      role: "admin",
    });
    await next();
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (!path.startsWith("/api/setup")) throw new Error(`unexpected ${path}`);
      return routes.request(
        new Request(
          `http://xiongbao.test${path.slice("/api/setup".length) || "/"}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** The Setup page, as Settings draws it. */
async function draw() {
  const router = createRouter({
    // 点链接时 navigate 会去新地址；这棵树只有根，落到哪里由 router.state.location 说。
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: SetupRoute.options.component }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("list", { name: "设置项" });
  const row = (id: string) => {
    const found = view.container.querySelector<HTMLElement>(
      `[data-setup-row="${id}"]`,
    );
    if (!found) throw new Error(`no ${id} row`);
    return within(found);
  };
  return { view, row, router };
}

const linkTo = (row: ReturnType<typeof within>, name: string) =>
  row.getByRole("link", { name }).getAttribute("href");

test("the personal edition's Setup speaks of no memory and no admin", async () => {
  serve("personal", { moreApps: true });
  const { view, row } = await draw();

  expect(
    row("apps").getByText(
      "You can connect more apps than the ones XiongBao comes with.",
    ),
  ).toBeTruthy();
  // The pages it links are the ones its Settings sidebar names.
  expect(linkTo(row("model"), "Keys")).toBe("/settings/credentials");
  // 服务器仍发 /settings/computer（§3.2），前端按 SETTINGS_MOVES 画新地址（U52）。
  expect(linkTo(row("computer"), "Computer")).toBe(
    "/settings/devices#this-computer",
  );
  expect(view.container.textContent).not.toMatch(/remember|memory|admin/i);
  expect(view.container.innerHTML).not.toContain("/admin/");
});

test("the personal edition's gaps speak of no memory and no admin either", async () => {
  serve("personal", { moreApps: false });
  const { view, row } = await draw();

  expect(
    row("apps").getByText(
      "Without it, you can connect only the apps XiongBao comes with.",
    ),
  ).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/remember|memory|admin/i);
});

test("a team deployment's Setup keeps memory, its admin, and the Admin pages", async () => {
  serve("team", { moreApps: true });
  const { row } = await draw();

  expect(
    row("apps").getByText(
      "People can connect more apps than the ones an admin adds.",
    ),
  ).toBeTruthy();
  expect(linkTo(row("model"), "Credentials")).toBe("/admin/credentials");
  // 服务器仍发 /admin/computers（§3.2），前端按 SETTINGS_MOVES 画新地址（U51）。
  expect(linkTo(row("computer"), "Computers")).toBe(
    "/settings/devices#team-computers",
  );
});

test("a team deployment's gaps speak of the apps an admin adds", async () => {
  serve("team", { moreApps: false });
  const { row } = await draw();

  expect(
    row("apps").getByText(
      "Without it, people can connect only the apps an admin adds.",
    ),
  ).toBeTruthy();
});

describe("点电脑那一行的链接：去的是换过的新地址", () => {
  const cases = [
    ["personal", "Computer", "/settings/devices#this-computer"],
    ["team", "Computers", "/settings/devices#team-computers"],
  ] as const;
  for (const [edition, name, href] of cases) {
    test(edition, async () => {
      serve(edition, { moreApps: true });
      const { row, router } = await draw();
      const link = row("computer").getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      fireEvent.click(link);
      await waitFor(() => {
        const { pathname, hash } = router.state.location;
        expect(`${pathname}#${hash}`).toBe(href);
      });
    });
  }
});
