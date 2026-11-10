import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AgentRolePanel } from "@/components/roles/role-editor";
import { RoleTemplatesScreen } from "@/routes/_authed/_app/role-templates";
import {
  type RoleProfile,
  roleProfileToMarkdown,
} from "../../shared/role-profile";
import { settleReactWork } from "./settle-react-work";

/**
 * Story ROLE1, the screens (spec §5 ROLE1-4): the 角色模板 page's editor with Markdown import and
 * smart generation, the unsaved-change prompt, and a coworker's 角色 panel — its source, the
 * 新版本 notice, the diff before 按模板更新, and no template for a built-in coworker.
 *
 * The usual harness: `GlobalRegistrator`, a stubbed `fetch` that answers the role routes and records
 * every write, and the real components inside a memory router.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let originalConfirm: typeof window.confirm;
beforeAll(() => {
  originalConfirm = window.confirm;
});
let writes: { request: string; body: unknown }[] = [];
let routes: Record<string, () => Response> = {};

const reviewer: RoleProfile = {
  identity: { title: "代码审核员", roleDescription: "审查合并请求。" },
  persona: { tone: "直接", principles: "先读测试", habits: "不说空话" },
  bible: "# 审核清单\n\n- 测试",
};

beforeEach(() => {
  writes = [];
  routes = {};
  global.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      const answer = routes[`${method} ${String(path)}`];
      return answer ? answer() : new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
});

function draw(screen: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => screen,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/plans",
        component: () => <p>别处</p>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const textOf = (view: ReturnType<typeof render>, label: string) =>
  (view.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

describe("the 角色模板 page", () => {
  beforeEach(() => {
    routes["GET /api/role-templates"] = () =>
      Response.json({ templates: [], official: [] });
    routes["GET /api/role-templates/models"] = () =>
      Response.json({
        models: [{ id: "m-1", name: "custom/x", label: "我的模型" }],
      });
  });

  test("pasted Markdown fills all three tabs; a malformed file says where, in place", async () => {
    const { view } = draw(<RoleTemplatesScreen />);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(await view.findByRole("button", { name: "新建模板" }));

    // A malformed file first: the error names the section and line, and nothing is filled.
    await user.type(
      view.getByLabelText("粘贴 Markdown"),
      "# 身份\n头衔：甲\n# 技能\n# 人设\n# 手册",
    );
    await user.click(view.getByRole("button", { name: "导入粘贴的内容" }));
    expect(view.getByRole("alert").textContent).toBe(
      "「技能」（第 3 行）：未知的一级标题「技能」。",
    );
    expect(textOf(view, "头衔")).toBe("");

    await user.clear(view.getByLabelText("粘贴 Markdown"));
    // `type` would read the braces in Markdown as key names; paste the text instead.
    await user.click(view.getByLabelText("粘贴 Markdown"));
    await user.paste(roleProfileToMarkdown(reviewer));
    await user.click(view.getByRole("button", { name: "导入粘贴的内容" }));
    expect(view.queryByRole("alert")).toBeNull();

    expect(textOf(view, "头衔")).toBe("代码审核员");
    expect(textOf(view, "职责")).toBe("审查合并请求。");
    await user.click(view.getByRole("tab", { name: "人设" }));
    expect(textOf(view, "性格语气")).toBe("直接");
    expect(textOf(view, "工作守则")).toBe("先读测试");
    expect(textOf(view, "口头约束")).toBe("不说空话");
    await user.click(view.getByRole("tab", { name: "手册" }));
    expect(textOf(view, "工作手册")).toBe("# 审核清单\n\n- 测试");
    // Filled, not saved.
    expect(writes).toEqual([]);
    expect(view.getByText("有未保存的修改")).toBeTruthy();
  });

  test("a generated profile lands in the editor unsaved, and leaving with it asks first", async () => {
    routes["POST /api/role-templates/generate"] = () =>
      Response.json({
        requestId: "r",
        state: "completed",
        profile: reviewer,
        error: null,
      });
    const { view, router } = draw(<RoleTemplatesScreen />);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(await view.findByRole("button", { name: "新建模板" }));
    await user.type(view.getByLabelText("一句话描述这个角色"), "严格的审核员");
    await waitFor(() =>
      expect(view.getByLabelText("生成用的模型")).toBeTruthy(),
    );
    await user.click(view.getByRole("button", { name: "生成" }));
    await settle();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.request).toBe("POST /api/role-templates/generate");
    expect(writes[0]?.body).toMatchObject({
      modelRef: "m-1",
      description: "严格的审核员",
    });
    const sent = writes[0]?.body as { requestId?: unknown } | undefined;
    expect(typeof sent?.requestId).toBe("string");
    expect(textOf(view, "头衔")).toBe("代码审核员");
    expect(view.getByText("已填入编辑器，确认后再保存。")).toBeTruthy();
    expect(view.getByText("有未保存的修改")).toBeTruthy();

    // Leaving: asked, and staying keeps the draft.
    const asked: string[] = [];
    window.confirm = (message?: string) => {
      asked.push(String(message));
      return false;
    };
    // Not awaited: a blocked navigation stays pending until it is let through.
    act(() => {
      void router.navigate({ to: "/plans" });
    });
    await settle();
    expect(asked).toEqual(["有未保存的修改，确定要离开吗？"]);
    expect(view.queryByText("别处")).toBeNull();
    expect(textOf(view, "头衔")).toBe("代码审核员");

    // Agreeing leaves.
    window.confirm = () => true;
    // Not awaited: a blocked navigation stays pending until it is let through.
    act(() => {
      void router.navigate({ to: "/plans" });
    });
    await settle();
    expect(await view.findByText("别处")).toBeTruthy();
  });

  test("a failed generation says so and fills nothing", async () => {
    routes["POST /api/role-templates/generate"] = () =>
      Response.json({
        requestId: "r",
        state: "failed",
        profile: null,
        error: "生成的格式无效，请重试。",
      });
    const { view } = draw(<RoleTemplatesScreen />);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(await view.findByRole("button", { name: "新建模板" }));
    await user.type(view.getByLabelText("一句话描述这个角色"), "运营");
    await waitFor(() =>
      expect(view.getByLabelText("生成用的模型")).toBeTruthy(),
    );
    await user.click(view.getByRole("button", { name: "生成" }));
    expect(await view.findByText("生成的格式无效，请重试。")).toBeTruthy();
    expect(textOf(view, "头衔")).toBe("");
  });
});

describe("a coworker's 角色 panel", () => {
  const template = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "代码审核员",
    profile: reviewer,
    version: 3,
    updatedAt: "2026-11-04T00:00:00.000Z",
    official: false,
  };
  const profile = {
    title: "代码审核员",
    roleDescription: "审查合并请求。",
    persona: { tone: "直接", principles: "旧的守则", habits: "不说空话" },
    bible: "# 旧清单",
    canManage: true,
    roleTemplate: { id: template.id, version: 2 },
    acceptsRoleTemplate: true,
  };

  test("a newer template version is announced, and 按模板更新 shows the diff before it writes", async () => {
    routes["GET /api/role-templates"] = () =>
      Response.json({ templates: [template], official: [] });
    routes["GET /api/role-templates/employees/agent-1"] = () =>
      Response.json({
        acceptsRoleTemplate: true,
        source: {
          id: template.id,
          version: 2,
          name: "代码审核员",
          latestVersion: 3,
          hasUpdate: true,
          modified: null,
        },
      });
    routes[`POST /api/role-templates/${template.id}/apply`] = () =>
      Response.json({
        agent: {},
        status: { acceptsRoleTemplate: true, source: null },
      });
    const { view } = draw(
      <AgentRolePanel
        agentId="agent-1"
        onSaveBible={async () => {}}
        profile={profile}
      />,
    );
    expect(await view.findByText("来自模板「代码审核员」v2")).toBeTruthy();
    expect(
      view.getByText("模板「代码审核员」有新版本（v3，当前 v2）"),
    ).toBeTruthy();

    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(await view.findByRole("button", { name: "按模板更新" }));
    // The diff first, naming exactly what changes; nothing written yet.
    const diff = view.getByRole("list", { name: "改动" });
    expect(diff.textContent).toContain("工作守则");
    expect(diff.textContent).toContain("旧的守则");
    expect(diff.textContent).toContain("先读测试");
    expect(diff.textContent).toContain("手册");
    expect(diff.textContent).not.toContain("头衔");
    expect(writes).toEqual([]);

    await user.click(view.getByRole("button", { name: "确认更新" }));
    await settle();
    expect(writes).toEqual([
      {
        request: `POST /api/role-templates/${template.id}/apply`,
        body: { agentId: "agent-1", version: 3 },
      },
    ]);
    expect(view.getByText("已按模板「代码审核员」v3 更新。")).toBeTruthy();
  });

  test("a coworker changed after taking its template says so", async () => {
    routes["GET /api/role-templates"] = () =>
      Response.json({ templates: [template], official: [] });
    routes["GET /api/role-templates/employees/agent-1"] = () =>
      Response.json({
        acceptsRoleTemplate: true,
        source: {
          id: template.id,
          version: 3,
          name: "代码审核员",
          latestVersion: 3,
          hasUpdate: false,
          modified: true,
        },
      });
    const { view } = draw(
      <AgentRolePanel
        agentId="agent-1"
        onSaveBible={async () => {}}
        profile={{ ...profile, roleTemplate: { id: template.id, version: 3 } }}
      />,
    );
    expect(
      await view.findByText("来自模板「代码审核员」v3，已在模板基础上修改"),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "按模板更新" })).toBeNull();
  });

  test("the 分身 has no 套用模板, but its Bible is written by hand and checked for length", async () => {
    routes["GET /api/role-templates"] = () =>
      Response.json({ templates: [template], official: [] });
    routes["GET /api/role-templates/employees/avatar-me"] = () =>
      Response.json({ acceptsRoleTemplate: false, source: null });
    const saved: (string | null)[] = [];
    const { view } = draw(
      <AgentRolePanel
        agentId="avatar-me"
        onSaveBible={async (bible) => {
          saved.push(bible);
        }}
        profile={{
          ...profile,
          bible: null,
          roleTemplate: null,
          acceptsRoleTemplate: false,
        }}
      />,
    );
    await settle();
    expect(view.queryByLabelText("套用模板")).toBeNull();
    expect(view.queryByRole("button", { name: "按模板更新" })).toBeNull();

    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(view.getByLabelText("工作手册"));
    await user.paste("周报在飞书。");
    await user.click(view.getByRole("button", { name: "保存手册" }));
    await settle();
    expect(saved).toEqual(["周报在飞书。"]);

    await user.click(view.getByLabelText("工作手册"));
    await user.paste("多".repeat(8000));
    expect(view.getByText("手册超过 8000 字，不能保存。")).toBeTruthy();
    expect(
      (view.getByRole("button", { name: "保存手册" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("a coworker that takes templates is offered its owner's, with the diff first", async () => {
    routes["GET /api/role-templates"] = () =>
      Response.json({ templates: [template], official: [] });
    routes["GET /api/role-templates/employees/agent-2"] = () =>
      Response.json({ acceptsRoleTemplate: true, source: null });
    const { view } = draw(
      <AgentRolePanel
        agentId="agent-2"
        onSaveBible={async () => {}}
        profile={{ ...profile, roleTemplate: null }}
      />,
    );
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const select = await view.findByLabelText("套用模板");
    await user.selectOptions(select, template.id);
    expect(view.getByText("套用「代码审核员」v3 会改动：")).toBeTruthy();
    expect(writes).toEqual([]);
  });
});
