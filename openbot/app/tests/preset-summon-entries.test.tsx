/*
 * 召唤员工: the remaining ways into a conversation with an employee — the chat's profile panel
 * (「开始新对话」) and the employee dialog's 「开始对话」 — summon a preset original instead, the
 * card flip and all, or open the person's own copy's conversation once it is summoned.
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const copyConversation = async () =>
  Response.json({
    agent: { ...PRESET, id: "copy-doctor", summonKind: null, mine: true },
    channelId: "c-doctor",
    created: false,
  });

test("the profile panel summons a preset not summoned yet, with the card flip", async () => {
  const { view } = draw(PRESET, (id) => <AgentProfile agentId={id} />);
  await userEvent.click(
    await view.findByRole("button", { name: "召唤 暖心医生" }),
  );
  expect(
    await within(document.body).findByRole("dialog", { name: "召唤员工" }),
  ).toBeTruthy();
  expect(posted).toEqual(["/api/agents/preset-doctor/summon"]);
});

test("the profile panel's 开始新对话 on a summoned preset opens the person's own copy's conversation", async () => {
  answer = copyConversation;
  const { view, router } = draw({ ...PRESET, summoned: true }, (id) => (
    <AgentProfile agentId={id} />
  ));
  await userEvent.click(
    await view.findByRole("button", { name: "开始新对话" }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/c-doctor"),
  );
  expect(posted).toEqual(["/api/agents/preset-doctor/summon"]);
});

test("the employee dialog's conversation row summons a preset not summoned yet", async () => {
  const { view } = draw(PRESET, (id) => (
    <AgentDialog agentId={id} onClose={() => {}} open />
  ));
  const dialog = within(await within(view.baseElement).findByRole("dialog"));
  await userEvent.click(await dialog.findByRole("button", { name: "召唤" }));
  expect(
    await within(document.body).findByRole("dialog", { name: "召唤员工" }),
  ).toBeTruthy();
  expect(posted).toEqual(["/api/agents/preset-doctor/summon"]);
});

test("the employee dialog's 开始 on a summoned preset opens the person's own copy's conversation", async () => {
  answer = copyConversation;
  const { view, router } = draw({ ...PRESET, summoned: true }, (id) => (
    <AgentDialog agentId={id} onClose={() => {}} open />
  ));
  const dialog = within(await within(view.baseElement).findByRole("dialog"));
  await userEvent.click(await dialog.findByRole("button", { name: "开始" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/c-doctor"),
  );
  expect(posted).toEqual(["/api/agents/preset-doctor/summon"]);
});
