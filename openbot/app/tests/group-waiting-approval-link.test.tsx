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
import { cleanup, render, waitFor } from "@testing-library/react";
import { GroupChat } from "@/components/channels/group-chat";
import type { GroupMessage } from "@/lib/groups";
import { settleReactWork } from "./settle-react-work";

/**
 * A group line that waits on a person, and the way to act on it.
 *
 * The line already said what it waits for and offered 去审批, which opened the approvals page: a
 * list the person then had to search for the one row their Bot was stopped on. In a group that is
 * the wrong shape of answer -- the line knows exactly which approval would resume it, and the
 * server now hands that id to the person who must decide it (and to nobody else; the server half is
 * `server/tests/group-conversations.integration.test.ts`). So the link names it, and a line that
 * has no id of its own still goes to the list rather than a link that lands on nothing.
 *
 * The group, the agents and the inbox are played at the HTTP boundary; GroupChat and the router are
 * the real ones.
 */

const CHANNEL = "group-1";
const ADA = "agent-ada";
const GRACE = "agent-grace";
const APPROVAL = "approval-7f3a";

function line(
  id: string,
  agentId: string,
  overrides: Partial<GroupMessage> = {},
): GroupMessage {
  return {
    id,
    channelId: CHANNEL,
    ownerUserId: "me",
    agentId,
    text: "",
    status: "waiting",
    createdAt: new Date().toISOString(),
    reason: "Waiting for your approval.",
    ...overrides,
  };
}

let messages: GroupMessage[] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
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
    if (url.pathname === "/api/me")
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    if (url.pathname === "/api/agents")
      return Response.json({
        agents: [
          { id: ADA, name: "Ada", avatarSeed: ADA },
          { id: GRACE, name: "Grace", avatarSeed: GRACE },
        ],
      });
    if (url.pathname === `/api/groups/${CHANNEL}`)
      return Response.json({
        bots: [
          { id: ADA, name: "Ada" },
          { id: GRACE, name: "Grace" },
        ],
        people: [
          { userId: "me", email: "me@example.test", name: null, creator: true },
        ],
        messages,
      });
    if (url.pathname === "/api/approvals")
      return Response.json({
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    if (url.pathname === "/api/bots/attention")
      return Response.json({ lastPingId: null, bots: [] });
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  messages = [];
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function conversation() {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <GroupChat channelId={CHANNEL} />,
  });
  const approvals = createRoute({
    getParentRoute: () => root,
    path: "/settings/approvals",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, approvals]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The 去审批 link beside each waiting line, in transcript order. */
async function links() {
  const rendered = conversation();
  await waitFor(() => {
    expect(rendered.getAllByText("去审批")).toHaveLength(messages.length);
  });
  return rendered
    .getAllByText("去审批")
    .map((link) => link.getAttribute("href") ?? "");
}

test("a waiting line links to the one approval it is stopped on", async () => {
  messages = [line(`m-1:${ADA}`, ADA, { approvalId: APPROVAL })];
  const [href] = await links();
  expect(href).toContain("/settings/approvals");
  expect(href).toContain(`focus=${APPROVAL}`);
});

test("a waiting line with no approval of its own still links to the list", async () => {
  // A durable wait -- a computer still offline, an action the person took on themselves -- has no
  // approval row to land on. The list is where the answer is, so that is where it goes.
  messages = [line(`m-1:${GRACE}`, GRACE)];
  const [href] = await links();
  expect(href).toContain("/settings/approvals");
  expect(href).not.toContain("focus=");
});
