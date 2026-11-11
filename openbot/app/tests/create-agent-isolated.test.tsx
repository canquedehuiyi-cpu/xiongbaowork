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
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
} from "@/lib/agents/isolation";
import { deploymentKeys } from "@/lib/deployment/queries";

/**
 * 熊宝的新建向导并入了上游 New Bot sheet 的「独立运行」开关（M5b）：问在「它在哪里运行」那一步，字段名照上游
 * （`POST /api/agents` 的 `isolated`）。部署给不了、管理员关掉了，都照样画出来、勾不上、说明原因；没勾就什么都
 * 不发，创建和以前一模一样；个人版只有一个人一台电脑，不问。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let writes: { request: string; body: Record<string, unknown> }[] = [];
let isolationAvailable = true;
let isolatedComputers = true;

const CREATED: AgentProfile = {
  id: "agent_new",
  name: "报销专员",
  title: "财务运营",
  roleDescription: "审核票据。",
  avatarSeed: "agent_new",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  modelRef: null,
  persona: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
};

beforeEach(() => {
  writes = [];
  isolationAvailable = true;
  isolatedComputers = true;
  global.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      if (path === "/api/agents/capabilities")
        return Response.json({
          capabilities: { builtInAvailable: true, isolationAvailable },
        });
      if (path === "/api/admin/enterprise/me")
        return Response.json({ capabilities: { isolatedComputers } });
      if (path === "/api/agents" && method === "POST")
        return Response.json({ agent: CREATED }, { status: 201 });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function draw(edition: "team" | "personal" = "team") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** Through the first two steps to 「它在哪里运行？」, with 内置 picked. */
async function toWhereItRuns(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByLabelText("名字"), "报销专员");
  await user.type(view.getByLabelText("头衔"), "财务运营");
  await user.type(view.getByLabelText("角色"), "审核票据。");
  await user.click(view.getByRole("button", { name: "下一步" }));
  await view.findByText("第 2 步，共 3 步");
  await user.click(view.getByRole("button", { name: "下一步" }));
  await view.findByText("第 3 步，共 3 步");
  const builtIn = view.container.ownerDocument.querySelector(
    'input[value="builtin"]',
  );
  if (!builtIn) throw new Error("no built-in choice");
  await user.click(builtIn);
  await settle();
  return user;
}

const isolatedBox = (view: ReturnType<typeof draw>) =>
  view.getByRole("checkbox", { name: "独立运行" });

test("ticking 独立运行 asks for a computer of its own in the create", async () => {
  const view = draw();
  const user = await toWhereItRuns(view);
  const box = isolatedBox(view);
  expect(box.getAttribute("aria-disabled")).not.toBe("true");
  expect(view.getByText("给它一台自己的电脑，不和你共用。")).toBeTruthy();
  await user.click(box);
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await settle();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.request).toBe("POST /api/agents");
  expect(writes[0]?.body.isolated).toBe(true);
});

test("left unticked, the create carries no isolated field at all", async () => {
  const view = draw();
  const user = await toWhereItRuns(view);
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await settle();
  expect(writes).toHaveLength(1);
  expect("isolated" in (writes[0]?.body ?? {})).toBe(false);
});

test("a deployment that cannot make one draws the box disabled, with why", async () => {
  isolationAvailable = false;
  const view = draw();
  await toWhereItRuns(view);
  expect(isolatedBox(view).hasAttribute("data-disabled")).toBe(true);
  expect(view.getByText(ISOLATION_UNAVAILABLE)).toBeTruthy();
});

test("an administrator who switched it off for this person is named as the reason", async () => {
  isolatedComputers = false;
  const view = draw();
  await toWhereItRuns(view);
  expect(isolatedBox(view).hasAttribute("data-disabled")).toBe(true);
  expect(view.getByText(ISOLATION_NOT_ALLOWED)).toBeTruthy();
});

test("the personal edition is not asked", async () => {
  const view = draw("personal");
  await toWhereItRuns(view);
  expect(view.queryByRole("checkbox", { name: "独立运行" })).toBeNull();
});
