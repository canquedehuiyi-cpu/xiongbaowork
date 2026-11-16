import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import {
  AuditPage,
  withoutOpenBotWorking,
} from "@/components/manage/audit-page";
import { PluginPage } from "@/components/manage/plugin-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { managePaths } from "@/lib/manage-paths";
import {
  brokeredKeyMissing,
  brokeredReach,
} from "@/lib/plugins/provider-vocabulary";
import {
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * The personal edition calls the product OpenBot. Seen on Windows: Settings > Activity said
 * "Started by this deployment" under rows OpenBot itself started, and an app's page under
 * Connections said what "this deployment" registers and keeps. That is Admin's word, for the person
 * who runs OpenBot for everybody; Admin keeps it.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const notion = {
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "Pages and databases.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "me",
  dynamicClient: true,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
} as unknown as PluginServer;

const page = {
  catalogue: [
    {
      key: "notion",
      title: "Notion",
      vendor: "Notion",
      summary: "Pages and databases.",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [notion],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
  authorizesPerAction: false,
} as unknown as PluginsPage;

const startedByOpenBot = {
  id: "e1",
  actorUserId: null,
  initiatorKind: "deployment",
  initiatorId: null,
  // Every Bot given Routines' tools at a start; Activity leaves the computer's start-up rows out.
  eventType: "configuration.changed",
  targetType: "mcp_server",
  targetId: "routines",
  payload: {
    change: "plugin_granted",
    kind: "mcp",
    refs: ["routines/create_goal", "routines/list_goals"],
    actor: "openbot:always-on",
  },
  createdAt: "2026-11-07T11:00:00Z",
};

const originalFetch = global.fetch;
beforeAll(() => {
  // Nothing here is fetched that the cache does not already hold; anything else is not served.
  global.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

function draw(edition: "team" | "personal", screen: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(pluginKeys.page(), page);
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  // Activity asks without OpenBot's own working; Admin asks for everything.
  seedAuditPage(
    client,
    edition === "personal" ? withoutOpenBotWorking("") : "",
    { events: [startedByOpenBot] },
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: screen }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("Activity says OpenBot started what OpenBot started", async () => {
  const Activity = ActivityRoute.options.component as ComponentType;
  const view = draw("personal", () => <Activity />);
  expect(await view.findByText("由熊宝发起")).toBeTruthy();
  expect(view.container.textContent).not.toContain("部署");
});

test("Admin's Audit still says this deployment", async () => {
  const view = draw("team", () => <AuditPage />);
  expect(await view.findByText("由本部署发起")).toBeTruthy();
});

test("an app's page under Connections says what OpenBot does, not a deployment", async () => {
  const view = draw("personal", () => <PluginPage pluginKey="notion" />);
  await view.findAllByText("连接");
  const text = view.container.textContent ?? "";
  expect(text).toContain("熊宝登记一个 OAuth 客户端");
  expect(text).toContain("首次连接时熊宝数字员工会自动向服务商登记");
  expect(text).toContain("熊宝数字员工没有公网地址");
  expect(text).not.toContain("部署");
});

test("the same page in Admin keeps its word", async () => {
  const view = draw("team", () => <PluginPage pluginKey="notion" />);
  await view.findAllByText("连接");
  const text = view.container.textContent ?? "";
  expect(text).toContain("部署登记一个 OAuth 客户端");
  expect(text).toContain("首次连接时本部署会自动向服务商登记");
});

test("a brokered app's sentences name no deployment in personal, and keep it in Admin", () => {
  const personal = managePaths("personal").edition;
  expect(
    brokeredReach("composio", { title: "Gmail", kind: "consent" }).description,
  ).not.toMatch(/这个部署|本部署/);
  // 「部署设置」是设置里一页的名字，不是在说「这个部署」。
  expect(brokeredKeyMissing("composio", personal)).not.toMatch(
    /这个部署|本部署/,
  );
  expect(brokeredReach("composio").description).toContain(
    "这个部署为这类应用统一持有一把密钥",
  );
  expect(brokeredKeyMissing("composio")).toContain("请在这个部署上设置");
});
