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
import { cleanup, render } from "@testing-library/react";
import { authKeys } from "@/lib/auth/queries";
import { identityKeys } from "@/lib/identity/queries";
import {
  type CatalogueItem,
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as ConnectionRoute } from "@/routes/_authed/settings/connected-accounts/$key";
import { Route as ConnectionsRoute } from "@/routes/_authed/settings/connected-accounts/index";
import { settleReactWork } from "./settle-react-work";

/*
 * Your connected accounts, under Settings → 已连接的账号.
 *
 * Upstream moved these to a Connections page with a personal edition that turns apps on from the
 * same list. This deployment has no personal edition and keeps the page under Settings, so what is
 * checked here is what the team edition kept: only the apps an admin turned on are listed, as your
 * accounts, and an app's own page is only your account, with nothing to turn the app on or off.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function entry(
  key: string,
  title: string,
  auth: CatalogueItem["auth"],
): CatalogueItem {
  return {
    key,
    title,
    vendor: title,
    summary: `${title} for your Bots.`,
    docsUrl: "",
    auth,
    perInstance: false,
  };
}

/** Apps the catalogue offers; only Notion has been turned on (see `server`). */
const CATALOGUE = [
  entry("notion", "Notion", "user-oauth"),
  entry("google-drive", "Google Drive", "user-oauth"),
  entry("exa", "Exa Search", "none"),
  entry("exa-authenticated", "Exa Search (API key)", "deployment-bearer"),
  entry("routines", "Routines", "builtin"),
];

/** A server row as the plugin list returns it. Notion registers its own client; Drive needs one. */
function server(key: string): PluginServer {
  return {
    id: key,
    title: CATALOGUE.find((item) => item.key === key)?.title ?? key,
    vendor: key,
    url: `https://${key}.example/mcp`,
    summary: "",
    docsUrl: "",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "me",
    dynamicClient: key === "notion",
    authScheme: null,
    tools: [],
    withdrawn: [],
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
  } as unknown as PluginServer;
}

let servers: PluginServer[] = [];
let connected: string[] = [];
let composio = false;

function page(): PluginsPage {
  return {
    catalogue: CATALOGUE,
    servers,
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: composio,
  } as unknown as PluginsPage;
}

const originalFetch = global.fetch;
beforeEach(() => {
  servers = [server("notion")];
  connected = [];
  composio = false;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (init?.method && init.method !== "GET") {
        if (path === "/api/plugins/servers") {
          const { key } = JSON.parse(String(init.body)) as { key: string };
          servers = [...servers, server(key)];
        }
        if (path.endsWith("/connect"))
          return Response.json({ connected: true });
        return Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(page());
      if (path === "/api/plugins/connections")
        return Response.json({
          connections: connected.map((serverId) => ({
            serverId,
            status: "connected",
          })),
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw(at = "/settings/connected-accounts") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "person-1",
    email: "person@example.com",
    role: "user",
  });
  client.setQueryData(pluginKeys.page(), page());
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(identityKeys.links(), []);
  client.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });

  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const list = (
    ConnectionsRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/settings/connected-accounts/",
    path: "/settings/connected-accounts/",
    getParentRoute: () => authed,
  });
  const one = (
    ConnectionRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/settings/connected-accounts/$key",
    path: "/settings/connected-accounts/$key",
    getParentRoute: () => authed,
  });
  const history = createMemoryHistory({ initialEntries: [at] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([list as never, one as never]),
    ]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history };
}

<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
test("Connected accounts lists only what an admin turned on, as your accounts", async () => {
  const { view } = draw();
=======
const tile = (view: ReturnType<typeof draw>["view"], key: string) =>
  view.getByTestId(`account-${key}`);

describe("Connections in the personal edition", () => {
  test("is one searchable list of every app that connects in one press, with no apps-versus-accounts split", async () => {
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    for (const key of ["notion", "exa"]) expect(tile(view, key)).toBeTruthy();
    expect(
      view.getByRole("textbox", { name: "Search connections" }),
    ).toBeTruthy();
    expect(view.queryByText("Your apps")).toBeNull();
    expect(view.queryByText("Add an app")).toBeNull();
    expect(within(tile(view, "notion")).getByText("Connect")).toBeTruthy();
    expect(within(tile(view, "exa")).getByText("Add")).toBeTruthy();
  });

  test("links to saved logins and keys, which live under Settings", async () => {
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    expect(
      view.getByRole("link", { name: /Saved logins/ }).getAttribute("href"),
    ).toBe("/settings/passwords");
    expect(view.getByRole("link", { name: /^Keys/ }).getAttribute("href")).toBe(
      "/settings/credentials",
    );
  });

  test("apps that need something typed first wait behind one button, or a search", async () => {
    const { view, user } = draw("personal");
    await view.findByTestId("account-notion");
    expect(view.queryByTestId("account-google-drive")).toBeNull();
    expect(view.queryByTestId("account-exa-authenticated")).toBeNull();
    await user.click(
      view.getByRole("button", { name: "Show 2 apps that need setup" }),
    );
    expect(tile(view, "google-drive")).toBeTruthy();
    expect(
      within(tile(view, "exa-authenticated")).getByText("Set up"),
    ).toBeTruthy();
  });

  test("searching finds an app that needs setup", async () => {
    const { view, user } = draw("personal");
    await user.type(
      await view.findByRole("textbox", { name: "Search connections" }),
      "drive",
    );
    expect(await view.findByTestId("account-google-drive")).toBeTruthy();
  });

  test("Connect on an app with a client goes straight to your account", async () => {
    const { view, user } = draw("personal");
    await user.click(await view.findByTestId("account-notion"));
    await waitFor(() =>
      expect(writes).toEqual(["POST /api/plugins/servers/notion/connect"]),
    );
  });

  test("Connect on an app nobody added adds it first; one that needs a client set up then opens its page", async () => {
    const { view, user, history } = draw("personal");
    await user.click(
      await view.findByRole("button", { name: /apps that need setup/ }),
    );
    await user.click(await view.findByTestId("account-google-drive"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/google-drive"),
    );
    expect(writes).toEqual(["POST /api/plugins/servers"]);
  });

  test("Add on an app with no account turns it on and is done", async () => {
    const { view, user } = draw("personal");
    await user.click(await view.findByTestId("account-exa"));
    await waitFor(() => expect(writes).toEqual(["POST /api/plugins/servers"]));
    await waitFor(() =>
      expect(within(tile(view, "exa")).getByText("On")).toBeTruthy(),
    );
  });

  test("Set up opens the app's page, where its key is typed", async () => {
    const { view, user, history } = draw("personal");
    await user.click(
      await view.findByRole("button", { name: /apps that need setup/ }),
    );
    await user.click(await view.findByTestId("account-exa-authenticated"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/exa-authenticated"),
    );
    expect(writes).toEqual([]);
  });

  test("a connected app opens its page, to choose which Bots use it", async () => {
    connected = ["notion"];
    const { view, user, history } = draw("personal");
    await waitFor(() =>
      expect(within(tile(view, "notion")).getByText("Connected")).toBeTruthy(),
    );
    await user.click(await view.findByTestId("account-notion"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/notion"),
    );
  });
});

test("with a broker set up, the last tile browses its directory of more apps", async () => {
  composio = true;
  const { view } = draw("personal");
  const browse = await view.findByTestId("account-browse");
  expect(within(browse).getByText("Browse apps")).toBeTruthy();
  expect(browse.textContent).not.toMatch(/composio/i);
  expect(browse.getAttribute("href")).toBe("/connections/browse/composio");
});

describe("an app under Connections in the personal edition", () => {
  test("Routines is every Bot's, with no switch, and leads to the Routines page", async () => {
    servers = [server("notion"), server("routines")];
    const { view } = draw("personal", "/connections/routines");
    expect(
      await view.findByText(
        "Routines are work your Bots do on a schedule. Every Bot can set one up for you.",
      ),
    ).toBeTruthy();
    expect(
      (await view.findByRole("link", { name: /Your routines/ })).getAttribute(
        "href",
      ),
    ).toBe("/routines");
    expect(view.queryByRole("switch")).toBeNull();
    expect(view.queryByText("Turned on")).toBeNull();
  });

  test("is one page: turning it on, your account, and which Bots use it", async () => {
    const { view } = draw("personal", "/connections/notion");
    expect(await view.findByText("Turned on")).toBeTruthy();
    expect(view.getByText("Your account")).toBeTruthy();
  });
});

test("the team edition's Connections still lists only what an admin turned on, as your accounts", async () => {
  const { view } = draw("team");
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
  expect(await view.findByTestId("account-notion")).toBeTruthy();
  // No list of saved sign-ins and keys here: that is the personal edition's, which this deployment leaves out.
  expect(view.queryByText("Sign-ins and keys")).toBeNull();
  expect(view.queryByTestId("account-google-drive")).toBeNull();
  expect(view.queryByTestId("account-exa")).toBeNull();
});

test("an app under Connected accounts is only your account", async () => {
  const { view } = draw("/settings/connected-accounts/notion");
  await view.findAllByText("Notion");
  // Nothing turns the app itself on or off from here: that is an admin's.
  expect(view.queryByRole("switch")).toBeNull();
  expect(view.queryByText("Turned on")).toBeNull();
});
