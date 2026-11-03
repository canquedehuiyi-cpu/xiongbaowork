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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import type { PluginSkill, PluginsPage } from "@/lib/plugins/queries";
import type { WakerGroup } from "@/lib/waker-groups/queries";
import { Route as AdminSkillsRoute } from "@/routes/_authed/admin/skills";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec E2 on the deployment's skills: an administrator hands a skill to a whole crew in one press.
 *
 * The crew is only a way to say WHICH coworkers. What is asserted is what the person relies on: the
 * chip's number is the writes it will make (members not already holding it, and only coworkers the
 * deployment has), one press makes one grant per such member and none naming the group, and the
 * row ends with a sentence that says how many landed and, on a refusal, the server's own reason.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let writes: { path: string; body: Record<string, unknown> }[] = [];
let refused = new Set<string>();

const skill: PluginSkill = {
  id: "skill-1",
  slug: "weekly-report",
  ownerUserId: null,
  title: "周报",
  summary: "写本周周报。",
  instructions: "汇总本周进展。",
  origin: "admin",
  installedBy: null,
  grantedTo: ["agent-dev"],
  tools: [],
};

const page: PluginsPage = {
  catalogue: [],
  servers: [],
  skills: [skill],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
};

const agents = [
  { id: "agent-dev", name: "阿开", mine: true, hidden: false, pinned: false },
  {
    id: "agent-review",
    name: "阿审",
    mine: false,
    hidden: false,
    pinned: false,
  },
  { id: "agent-ops", name: "阿维", mine: false, hidden: false, pinned: false },
];

// One member already holding the skill, two who do not, and one the deployment has no coworker for.
const crew: WakerGroup = {
  id: "crew-1",
  name: "编程小组",
  description: null,
  members: [
    { agentId: "agent-dev", position: 0 },
    { agentId: "agent-review", position: 1 },
    { agentId: "agent-ops", position: 2 },
    { agentId: "agent-gone", position: 3 },
  ],
};

beforeEach(() => {
  writes = [];
  refused = new Set();
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const path = url.split("?")[0];
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        writes.push({ path: url, body });
        return refused.has(String(body.agentId))
          ? Response.json({ error: "这位员工已停用。" }, { status: 403 })
          : Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(page);
      if (path === "/api/agents") {
        return Response.json({
          agents: url.includes("hidden=true") ? [] : agents,
        });
      }
      if (path === "/api/waker-groups")
        return Response.json({ groups: [crew] });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Component = AdminSkillsRoute.options.component as ComponentType;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Component /> }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const CHIP = "把 /weekly-report 交给编程小组";

test("the crew chip counts the members who do not hold the skill yet", async () => {
  const view = draw();
  const chip = await view.findByRole("button", { name: CHIP });
  // 4 members: one already holds it, one is no coworker of this deployment.
  await waitFor(() => expect(chip.textContent).toBe("编程小组 · 2"));
});

test("one press writes one grant per member and never one for the group", async () => {
  const view = draw();
  const chip = await view.findByRole("button", { name: CHIP });
  await waitFor(() => expect(chip.textContent).toBe("编程小组 · 2"));
  await userEvent.click(chip);

  expect(
    await view.findByText("编程小组：全部 2 位员工都已拿到 /weekly-report。"),
  ).toBeTruthy();
  expect(writes.map((write) => write.path)).toEqual([
    "/api/plugins/grants",
    "/api/plugins/grants",
  ]);
  expect(
    writes
      .map((write) => write.body)
      .sort((left, right) =>
        String(left.agentId).localeCompare(String(right.agentId)),
      ),
  ).toEqual([
    { kind: "skill", ref: "weekly-report", agentId: "agent-ops" },
    { kind: "skill", ref: "weekly-report", agentId: "agent-review" },
  ]);
});

test("a refused member is said, with the server's reason, and does not stop the others", async () => {
  refused = new Set(["agent-review"]);
  const view = draw();
  const chip = await view.findByRole("button", { name: CHIP });
  await waitFor(() => expect(chip.textContent).toBe("编程小组 · 2"));
  await userEvent.click(chip);

  const line = await view.findByText(
    "编程小组：2 位里有 1 位拿到 /weekly-report，1 位被拒绝（这位员工已停用。）。",
  );
  expect(line.getAttribute("role")).toBe("alert");
  expect(writes).toHaveLength(2);
});
