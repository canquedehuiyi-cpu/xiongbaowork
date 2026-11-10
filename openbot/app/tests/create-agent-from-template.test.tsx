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
import type { ReactNode } from "react";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { AgentRolePanel } from "@/components/roles/role-editor";
import type { AgentProfile } from "@/lib/agents/queries";
import type { RoleProfile } from "../../shared/role-profile";

/**
 * Story ROLE1 (spec §3.3, ROLE1-4 acceptance 3): a new coworker started from a role template is
 * prefilled from it, created with its persona and 工作手册, and — for the person's own template —
 * remembers where it came from, which its detail then shows as 来自模板「…」v1.
 *
 * The harness of `create-agent-avatar.test.tsx`: a stubbed `fetch` recording every write, and the
 * real dialog inside a router of one route.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let writes: { request: string; body: unknown }[] = [];

const backend: RoleProfile = {
  identity: {
    title: "后端工程师",
    roleDescription: "按需求写实现、跑测试。",
  },
  persona: { tone: "直接", principles: "先读代码", habits: "" },
  bible: "# 发布流程\n\n1. 打标签",
};
const OWN = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "后端工程师",
  profile: backend,
  version: 1,
  updatedAt: "2026-11-04T00:00:00.000Z",
  official: false,
};
const OFFICIAL = {
  id: "official:code-reviewer",
  name: "代码审核员",
  profile: {
    identity: { title: "Code Reviewer", roleDescription: "审差异与风险。" },
    persona: { tone: "", principles: "严格审核。", habits: "" },
    bible: "",
  },
  version: 1,
  official: true,
};

const CREATED: AgentProfile = {
  id: "agent_new",
  name: "小后",
  title: backend.identity.title,
  roleDescription: backend.identity.roleDescription,
  avatarSeed: "agent_new",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  modelRef: null,
  persona: backend.persona,
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
  global.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      if (path === "/api/agents/capabilities") {
        return Response.json({ capabilities: { builtInAvailable: true } });
      }
      if (path === "/api/role-templates") {
        return Response.json({ templates: [OWN], official: [OFFICIAL] });
      }
      if (path === "/api/role-templates/employees/agent_new") {
        return Response.json({
          acceptsRoleTemplate: true,
          source: {
            id: OWN.id,
            version: 1,
            name: OWN.name,
            latestVersion: 1,
            hasUpdate: false,
            modified: false,
          },
        });
      }
      if (path === "/api/agents" && method === "POST") {
        return Response.json({ agent: CREATED }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function draw(screen: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
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

async function createFrom(templateId: string) {
  const created: string[] = [];
  const view = draw(
    <CreateAgentDialog
      onClose={() => {}}
      onCreated={(id) => created.push(id)}
      open
    />,
  );
  const picker = await view.findByLabelText("从模板开始");
  const user = userEvent.setup({ document: picker.ownerDocument });
  await user.selectOptions(picker, templateId);
  await user.type(view.getByLabelText("名字"), "小后");
  await user.click(view.getByRole("button", { name: "下一步" }));
  expect(await view.findByText("第 2 步，共 3 步")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "下一步" }));
  expect(await view.findByText("第 3 步，共 3 步")).toBeTruthy();
  const builtIn = view.container.ownerDocument.querySelector(
    'input[value="builtin"]',
  );
  if (!builtIn) throw new Error("no built-in choice");
  await user.click(builtIn);
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await settle();
  return { view, created };
}

test("starting from an own template prefills it, and the created coworker records the template at v1", async () => {
  const created: string[] = [];
  const view = draw(
    <CreateAgentDialog
      onClose={() => {}}
      onCreated={(id) => created.push(id)}
      open
    />,
  );
  const picker = await view.findByLabelText("从模板开始");
  // Both kinds are offered; official ones are marked.
  expect(picker.textContent).toContain("后端工程师");
  expect(picker.textContent).toContain("代码审核员（官方）");
  const user = userEvent.setup({ document: picker.ownerDocument });
  await user.selectOptions(picker, OWN.id);
  expect((view.getByLabelText("头衔") as HTMLInputElement).value).toBe(
    "后端工程师",
  );
  expect((view.getByLabelText("角色") as HTMLTextAreaElement).value).toBe(
    "按需求写实现、跑测试。",
  );
  cleanup();

  const run = await createFrom(OWN.id);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.request).toBe("POST /api/agents");
  expect(writes[0]?.body).toMatchObject({
    name: "小后",
    title: "后端工程师",
    roleDescription: "按需求写实现、跑测试。",
    persona: backend.persona,
    bible: backend.bible,
    roleTemplate: { id: OWN.id, version: 1 },
  });
  expect(run.created).toEqual([CREATED.id]);
  cleanup();

  // The new coworker's detail says where its role came from.
  const detail = draw(
    <AgentRolePanel
      agentId={CREATED.id}
      onSaveBible={async () => {}}
      profile={{
        ...CREATED,
        bible: backend.bible,
        roleTemplate: { id: OWN.id, version: 1 },
        acceptsRoleTemplate: true,
      }}
    />,
  );
  expect(await detail.findByText("来自模板「后端工程师」v1")).toBeTruthy();
  expect(created).toEqual([]);
});

test("an official template prefills and copies, but is not recorded as a source", async () => {
  await createFrom(OFFICIAL.id);
  expect(writes).toHaveLength(1);
  const body = writes[0]?.body as Record<string, unknown>;
  expect(body).toMatchObject({
    title: "Code Reviewer",
    roleDescription: "审差异与风险。",
    persona: OFFICIAL.profile.persona,
    bible: null,
  });
  expect("roleTemplate" in body).toBe(false);
});

test("without a template the request carries nothing of one", async () => {
  const view = draw(
    <CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />,
  );
  const user = userEvent.setup({
    document: (await view.findByLabelText("从模板开始")).ownerDocument,
  });
  await user.type(view.getByLabelText("名字"), "报销专员");
  await user.type(view.getByLabelText("头衔"), "财务运营");
  await user.type(view.getByLabelText("角色"), "审核票据。");
  await user.click(view.getByRole("button", { name: "下一步" }));
  await user.click(await view.findByRole("button", { name: "下一步" }));
  await view.findByText("第 3 步，共 3 步");
  const builtIn = view.container.ownerDocument.querySelector(
    'input[value="builtin"]',
  );
  if (!builtIn) throw new Error("no built-in choice");
  await user.click(builtIn);
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await settle();
  const body = writes[0]?.body as Record<string, unknown>;
  for (const key of ["persona", "bible", "roleTemplate"]) {
    expect(key in body).toBe(false);
  }
});
