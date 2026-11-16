import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupSections } from "@/components/bot-profile/setup";
import { agentQueryOptions } from "@/lib/agents/queries";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import { settleReactWork } from "./settle-react-work";

/**
 * 员工设置页的「部门」（聊天工作台 Task 6）：主人在设置页填写、修改、清空部门，经由真实的员工资料更新接口
 * 保存；超过 32 个字在页面上就被拦下；不能管理这位员工的人只读。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];

beforeEach(() => {
  updates = [];
});

function serve(department: string | null, ownerUserId = actor.id) {
  let profile: AgentProfile = {
    id: "backend",
    name: "后端工程师",
    title: "Backend Engineer",
    roleDescription: "写实现、跑测试。",
    avatarSeed: "backend",
    ownerUserId,
    visibility: ownerUserId === actor.id ? "private" : "public",
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: "https://agents.example.test/ag-ui",
    hasAuth: false,
    hasCallbackToken: false,
    modelRef: null,
    platformModelRef: null,
    persona: null,
    isolated: false,
    department,
  };
  const store = {
    get: async () => profile,
    update: async (_actor: unknown, _id: string, value: object) => {
      updates.push({ ...value });
      profile = { ...profile, ...value };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createAgentRoutes(store, auth, false);
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path === "/api/admin/enterprise/me")
        return Response.json({
          capabilities: { isolatedComputers: true },
          enforced: true,
        });
      if (typeof path !== "string" || !path.startsWith("/api/agents/")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      return routes.request(
        new Request(
          `http://xiongbao.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** Loads the profile through the real route, as the Setup page does, then draws its sections. */
function Setup() {
  const agent = useQuery(agentQueryOptions("backend"));
  return agent.data ? <SetupSections agent={agent.data} /> : null;
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: Setup }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("主人在设置页填写部门，经员工资料更新接口保存", async () => {
  serve(null);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  const row = await view.findByRole("button", { name: /^部门/ });
  // No department yet reads as the address book's group for it.
  expect(row.textContent).toContain("未分组");

  await user.click(row);
  const field = await view.findByRole("textbox", { name: "部门" });
  await user.type(field, "研发部");
  await user.click(view.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ department: "研发部" });
  // The other fields ride along as stored, so nothing else moves.
  expect(updates[0]).toMatchObject({
    name: "后端工程师",
    title: "Backend Engineer",
  });
});

test("改成别的部门，或清空回到未分组", async () => {
  serve("研发部");
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(await view.findByRole("button", { name: /^部门/ }));
  const field = await view.findByDisplayValue("研发部");
  await user.clear(field);
  await user.click(view.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  // Sent empty, and kept as the explicit clear ("") the server stores for 未分组.
  expect(updates[0]).toMatchObject({ department: "" });
});

test("超过 32 个字在页面上就被拦下，不发请求", async () => {
  serve(null);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(await view.findByRole("button", { name: /^部门/ }));
  const field = await view.findByRole("textbox", { name: "部门" });
  await user.type(field, "部".repeat(33));
  await user.click(view.getByRole("button", { name: "保存" }));

  expect((await view.findByRole("alert")).textContent).toContain(
    "部门不能超过 32 个字",
  );
  expect(updates).toHaveLength(0);
});

test("按字（码点）计长度：32 个 emoji 能保存，33 个被拦下", async () => {
  serve(null);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(await view.findByRole("button", { name: /^部门/ }));
  const field = await view.findByRole("textbox", { name: "部门" });
  // Each is two UTF-16 units: a length check would refuse at 16.
  await user.type(field, "🚀".repeat(33));
  await user.click(view.getByRole("button", { name: "保存" }));
  expect((await view.findByRole("alert")).textContent).toContain(
    "部门不能超过 32 个字",
  );
  expect(updates).toHaveLength(0);

  await user.clear(field);
  await user.type(field, "🚀".repeat(32));
  await user.click(view.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ department: "🚀".repeat(32) });
});

test("其他员工资料的编辑不碰部门", async () => {
  serve("研发部");
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(await view.findByRole("button", { name: /^头衔/ }));
  const field = await view.findByDisplayValue("Backend Engineer");
  await user.clear(field);
  await user.type(field, "Senior Backend Engineer");
  await user.click(view.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).not.toHaveProperty("department");
});

test("不能管理这位员工的人只看到部门，不能编辑", async () => {
  serve("设计部", "someone-else");
  const view = draw();

  expect(await view.findByText("设计部")).toBeTruthy();
  expect(view.queryByRole("button", { name: /^部门/ })).toBeNull();
});
