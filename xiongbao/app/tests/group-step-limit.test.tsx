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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { GroupChat, groupStepLimit } from "@/components/channels/group-chat";
import type { GroupMessage } from "@/lib/groups";
import { settleReactWork } from "./settle-react-work";

/**
 * 群聊里员工跑满步数被收尾（期一）：回复行上带着服务器记的 `stepLimit {steps}`，最后一轮里有，就在末尾一行
 * 「已用完 N 步 · 继续」。和单聊一样：只看最后一轮（最后一句人话之后的回复）；还有员工在跑时不显示。按「继续」
 * 按群里点名的方式发给最后那位触顶的员工：`@名字 继续`，带上它的 id。
 *
 * 群、员工、收件箱在 HTTP 边界上造；GroupChat 和路由是真的。
 */

const CHANNEL = "group-1";
const ADA = "agent-ada";
const GRACE = "agent-grace";

function person(id: string, text = "把三家竞品的报告写完"): GroupMessage {
  return {
    id,
    channelId: CHANNEL,
    ownerUserId: "me",
    agentId: null,
    text,
    status: "completed",
    createdAt: new Date().toISOString(),
  };
}

function reply(
  id: string,
  agentId: string,
  overrides: Partial<GroupMessage> = {},
): GroupMessage {
  return {
    id,
    channelId: CHANNEL,
    ownerUserId: "me",
    agentId,
    text: "前两家写完了，第三家还没查。",
    status: "completed",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let messages: GroupMessage[] = [];
let posted: unknown[] = [];
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
    if (url.pathname === `/api/groups/${CHANNEL}`) {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
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
    }
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
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  messages = [];
  posted = [];
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
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the last round's step limit offers to carry on, for the last employee that hit it", () => {
  expect(
    groupStepLimit([
      person("p1"),
      reply("r1", ADA, { stepLimit: { steps: 80 } }),
      reply("r2", GRACE, { stepLimit: { steps: 48 } }),
    ]),
  ).toEqual({ messageId: "r2", agentId: GRACE, steps: 48 });
  // 最后一轮里只有一位触顶：发给它，不管后面答完了的那位。
  expect(
    groupStepLimit([
      person("p1"),
      reply("r1", ADA, { stepLimit: { steps: 80 } }),
      reply("r2", GRACE),
    ]),
  ).toEqual({ messageId: "r1", agentId: ADA, steps: 80 });
});

test("a step limit from an earlier round is not offered", () => {
  expect(
    groupStepLimit([
      person("p1"),
      reply("r1", ADA, { stepLimit: { steps: 80 } }),
      person("p2", "好的，先这样"),
      reply("r2", ADA),
    ]),
  ).toBeNull();
  // 人刚说了一句、员工还没回：新的一轮已经开始了。
  expect(
    groupStepLimit([
      person("p1"),
      reply("r1", ADA, { stepLimit: { steps: 80 } }),
      person("p2", "继续"),
    ]),
  ).toBeNull();
});

test("nothing is offered while an employee is still running", () => {
  for (const status of ["running", "queued"] as const)
    expect(
      groupStepLimit([
        person("p1"),
        reply("r1", ADA, { stepLimit: { steps: 80 } }),
        reply("r2", GRACE, { text: "", status }),
      ]),
    ).toBeNull();
});

test("the group shows 已用完 N 步 · 继续 and sends @name 继续 to that employee", async () => {
  messages = [
    person("p1"),
    reply("r1", ADA, { stepLimit: { steps: 80 } }),
    reply("r2", GRACE),
  ];
  const view = conversation();
  await waitFor(() => {
    expect(view.getByText(/已用完 80 步/)).toBeTruthy();
  });
  const button = view.getByRole("button", { name: "继续" });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => {
    expect(posted).toHaveLength(1);
  });
  expect(posted[0]).toMatchObject({ text: "@Ada 继续", agentId: ADA });
  // 发出去就收起，不等新的一轮回来。
  expect(view.queryByText(/已用完/)).toBeNull();
});

test("the group shows nothing while someone is still running", async () => {
  messages = [
    person("p1"),
    reply("r1", ADA, { stepLimit: { steps: 80 } }),
    reply("r2", GRACE, { text: "", status: "running" }),
  ];
  const view = conversation();
  await view.findByText("思考中");
  expect(view.queryByText(/已用完/)).toBeNull();
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
});
