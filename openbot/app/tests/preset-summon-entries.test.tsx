/*
 * 召唤员工 Task 10: the remaining ways into a conversation with an employee — the chat's profile
 * panel (「开始新对话」) and the employee dialog's 「开始对话」 — send a preset original to 人才市场
 * instead, the one place summoning happens. Nothing is summoned from here.
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
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { AgentProfile } from "@/components/agents/agent-profile";
import {
  type AgentProfile as AgentProfileData,
  agentKeys,
} from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

let originalFetch: typeof fetch;
const posted: string[] = [];
let answer: () => Promise<Response> = () => new Promise<Response>(() => {});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/summon")) {
      posted.push(url);
      return answer();
    }
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
});
beforeEach(() => {
  posted.length = 0;
  answer = () => new Promise<Response>(() => {});
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const PRESET: AgentProfileData = {
  id: "preset-doctor",
  name: "暖心医生",
  title: "医生",
  roleDescription: "看病。",
  avatarSeed: "doctor",
  visibility: "public",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  persona: null,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: false,
  mine: false,
  summonKind: "preset",
  summoned: false,
};

function draw(agent: AgentProfileData, page: (id: string) => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.detail(agent.id), agent);
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => page(agent.id),
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => null,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the profile panel sends a preset not summoned yet to its card on 人才市场", async () => {
  const { view } = draw(PRESET, (id) => <AgentProfile agentId={id} />);
  const link = await view.findByRole("link", { name: "去人才市场" });
  expect(link.getAttribute("href")).toBe("/bots#summon-preset-doctor");
  expect(view.queryByRole("button", { name: "开始新对话" })).toBeNull();
  expect(posted).toEqual([]);
});

test("the profile panel sends a summoned preset to 人才市场, where the person's copy is", async () => {
  const { view } = draw({ ...PRESET, summoned: true }, (id) => (
    <AgentProfile agentId={id} />
  ));
  const link = await view.findByRole("link", { name: "去人才市场" });
  expect(link.getAttribute("href")).toBe("/bots");
});

test("the employee dialog's conversation row sends a preset to 人才市场", async () => {
  const { view } = draw(PRESET, (id) => (
    <AgentDialog agentId={id} onClose={() => {}} open />
  ));
  const dialog = within(await within(view.baseElement).findByRole("dialog"));
  const link = await dialog.findByRole("link", { name: "去人才市场" });
  expect(link.getAttribute("href")).toBe("/bots#summon-preset-doctor");
  expect(dialog.queryByRole("button", { name: "开始" })).toBeNull();
  expect(posted).toEqual([]);
});
