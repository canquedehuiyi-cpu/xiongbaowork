import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { settleReactWork } from "./settle-react-work";

/**
 * `@` IN A NEW CONVERSATION OFFERS THE BOTS IN TO:, BEFORE ANYTHING HAS BEEN SENT.
 *
 * FOUND ON WINDOWS: a new conversation with two Bots in To:, nothing sent yet, and `@` in the
 * composer said "No Bots in this conversation". The person could not address one of them in their
 * first message; only once the group existed did `@` list its Bots. The Bots in To: are who the
 * conversation is with, so they are who `@` offers, and a first message addressed to one goes to
 * that Bot only, as every later message in the group does.
 *
 * Everything above `fetch` is real: the `/channel/new` route, its To: picker, its composer and the
 * start sequence. `fetch` records what left the browser.
 */

const NativeResponse = globalThis.Response;

function agent(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    avatarSeed: overrides.id,
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

const CLAUDE = agent({ id: "claude-agent-sdk", name: "Claude Agent SDK" });
const ASSISTANT = agent({ id: "picked-harness", name: "Personal Assistant" });

/** Every write that left the browser, as `METHOD /path body`. */
let sent: { method: string; path: string; body: unknown }[] = [];
let originalFetch: typeof fetch;
let originalRect: typeof Range.prototype.getBoundingClientRect;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  /*
   * The `@` menu opens at the caret: prompt-area measures the caret's range and draws no menu for a
   * range with no box. happy-dom lays nothing out, so every range measures empty; a browser's caret
   * is a line tall. This is that line, and nothing else about layout is assumed.
   */
  originalRect = Range.prototype.getBoundingClientRect;
  const caret = { x: 8, y: 8, top: 8, left: 8, width: 1, height: 16 };
  Range.prototype.getBoundingClientRect = () =>
    ({ ...caret, right: 9, bottom: 24, toJSON: () => caret }) as DOMRect;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET")
      sent.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    if (url.pathname === "/api/groups" && method === "POST")
      return NativeResponse.json(
        {
          channel: {
            id: "group-1",
            name: "Claude Agent SDK, Personal Assistant",
            agentIds: [CLAUDE.id, ASSISTANT.id],
            threadId: "group-thread",
            active: true,
            lastMessageAt: null,
          },
        },
        { status: 201 },
      );
    if (url.pathname === "/api/groups/group-1" && method === "POST")
      return new NativeResponse(null, { status: 202 });
    if (url.pathname === "/api/channels" && method === "POST")
      return NativeResponse.json(
        {
          channel: {
            id: "channel-1",
            name: "Claude Agent SDK",
            agentIds: [CLAUDE.id],
            threadId: "channel-thread",
            active: true,
            lastMessageAt: null,
          },
        },
        { status: 201 },
      );
    return NativeResponse.json({ error: "Not here." }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  sent = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  Range.prototype.getBoundingClientRect = originalRect;
  GlobalRegistrator.unregister();
});

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
/** Where a started conversation opens. Only that it was opened matters here. */
const groupRoute = createRoute({
  path: "/group/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>The group</p>,
});
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>The conversation</p>,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, groupRoute, channelRoute]),
  ]),
]);

/**
 * A new conversation starts with nobody in To:, so each test picks its Bot. This deployment's To:
 * holds one Bot (a group starts from its own group pages), so `@` offers that one.
 */
function renderNewConversation(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "team",
  } satisfies DeploymentCapabilities);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/channel/new"] }),
  });
  return Object.assign(
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    { router },
  );
}

type View = ReturnType<typeof renderNewConversation>;

/** Add a Bot to To:, as a person does: type its name in the field and pick it. */
async function addToTo(view: View, name: string) {
  await userEvent
    .setup({ document })
    .type(await view.findByRole("combobox", { hidden: true }), name);
  fireEvent.click(
    await view.findByRole("option", { hidden: true, name: new RegExp(name) }),
  );
  // The field shows the Bot it now holds.
  await waitFor(() =>
    expect(
      view.getByRole<HTMLInputElement>("combobox", { hidden: true }).value,
    ).toBe(name),
  );
}

/** Type `@` in the composer and read the names the menu offers. */
async function namesOfferedByAt(view: View): Promise<string[]> {
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "消息",
  });
  const user = userEvent.setup({ document });
  await user.click(editor);
  await user.keyboard("@");
  const menu = await view.findByRole("listbox", {
    hidden: true,
    name: "@ suggestions",
  });
  return [...menu.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent ?? "",
  );
}

test("a new conversation with its one Bot picked offers that Bot to @, and sends to it alone", async () => {
  const view = renderNewConversation([CLAUDE]);
  await addToTo(view, "Claude Agent SDK");

  const offered = await namesOfferedByAt(view);
  expect(offered).toEqual([expect.stringContaining("Claude Agent SDK")]);

  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("option", {
      hidden: true,
      name: /Claude Agent SDK/,
    }),
  );
  await user.keyboard("hello{Enter}");

  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/channels",
      body: { agentIds: [CLAUDE.id] },
    }),
  );
  expect(sent.some((write) => write.path.startsWith("/api/groups"))).toBe(
    false,
  );
});
