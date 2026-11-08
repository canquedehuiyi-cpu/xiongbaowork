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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BotPermissions } from "@/components/bot-profile/permissions";
import {
  disabledToolRefs,
  type EmployeePermissions,
  toolIsDisabled,
} from "@/lib/approvals";

/**
 * SEC1 §4.5, §6.4: a Bot's 权限 section. Each tool is 直接 / 询问 / 禁用 and writes the matching rule;
 * team rows are locked and named 管理员设定; the owner's settings are labelled as binding everybody
 * who uses the Bot (D9) and are read-only to them; default sensitive paths can be switched off but
 * not removed (D8); administrators get the enterprise-mode link (D1).
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "user";
let permissions: EmployeePermissions;
const sent: { path: string; method: string; body: unknown }[] = [];

const base = (over: Partial<EmployeePermissions> = {}): EmployeePermissions => ({
  botId: "desk",
  editable: true,
  ownedByAnother: false,
  modes: [{ id: "r1", toolRef: "computer_run_command", behaviour: "deny" }],
  teamRules: [
    {
      id: "t1",
      botId: "*",
      toolRef: "mcp/drive/share",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    },
  ],
  security: {
    dangerousCommands: "ask",
    sensitivePaths: "ask",
    extraSensitivePaths: ["config/prod/**"],
    disabledDefaultPaths: [],
  },
  defaultSensitivePaths: [".env*", "*.pem", ".ssh/**"],
  enforceDangerousCommands: false,
  customRulesEnabled: true,
  ...over,
});

beforeEach(() => {
  sent.length = 0;
  permissions = base();
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals/employees/desk")
        return Response.json(permissions);
      if (url === "/api/plugins/for/desk")
        return Response.json({
          tools: [
            {
              ref: "gmail/GMAIL_SEND_EMAIL",
              toolName: "GMAIL_SEND_EMAIL",
              description: "",
              inputSchema: {},
            },
          ],
          skills: [],
        });
      if (url === "/api/me")
        return Response.json({ user: { id: "me", email: "me@example.test", role } });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  const rootRoute = createRootRoute({
    component: () => <BotPermissions agentId="desk" />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const choice = (view: ReturnType<typeof draw>, tool: string, label: string) =>
  Array.from(
    view
      .getByRole("radiogroup", { name: `「${tool}」的权限` })
      .querySelectorAll<HTMLElement>('[role="radio"]'),
  ).find((node) => node.textContent === label) as HTMLElement;

test("the two local-app tools can be set like any other (device MCP bridge §4.2)", async () => {
  const view = draw();
  await view.findByRole("radiogroup", { name: "「查看本机应用」的权限" });
  fireEvent.click(choice(view, "使用本机应用", "禁用"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/tools",
      method: "PUT",
      body: { toolRef: "computer_app_call", mode: "disabled" },
    }),
  );
});

test("the two desktop tools can be set like any other: 列出桌面窗口 and 查看桌面", async () => {
  const view = draw();
  await view.findByRole("radiogroup", { name: "「列出桌面窗口」的权限" });
  await view.findByRole("radiogroup", { name: "「查看桌面」的权限" });
  fireEvent.click(choice(view, "查看桌面", "禁用"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/tools",
      method: "PUT",
      body: { toolRef: "computer_desktop_snapshot", mode: "disabled" },
    }),
  );
});

test("the permissions page lists 启用本机应用", async () => {
  const view = draw();
  await view.findByRole("radiogroup", { name: "「启用本机应用」的权限" });
});

test("each tool is 直接 / 询问 / 禁用, and a choice writes the matching rule", async () => {
  const view = draw();
  await view.findByRole("radiogroup", { name: "「运行命令」的权限" });
  expect(choice(view, "运行命令", "禁用").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(choice(view, "点击网页", "询问"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/tools",
      method: "PUT",
      body: { toolRef: "computer_click", mode: "ask" },
    }),
  );
  // A granted connector tool is listed by the ref the gate checks.
  fireEvent.click(choice(view, "GMAIL_SEND_EMAIL", "直接"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/tools",
      method: "PUT",
      body: { toolRef: "gmail/GMAIL_SEND_EMAIL", mode: "direct" },
    }),
  );
  // Choosing the mode already set clears it back to no rule.
  fireEvent.click(choice(view, "运行命令", "禁用"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/tools",
      method: "PUT",
      body: { toolRef: "computer_run_command", mode: "default" },
    }),
  );
});

test("team rows are locked and named 管理员设定; the owner is told their settings bind everybody using the Bot (D9)", async () => {
  const view = draw();
  await view.findByText("管理员设定");
  expect(view.getByText("做之前先问（已锁定）")).toBeTruthy();
  expect(view.getByText(/其他人使用这位员工时同样适用/)).toBeTruthy();
  expect(view.queryByText("企业模式：前往企业管控")).toBeNull();
});

test("somebody else using the Bot sees the owner's settings labelled and read-only", async () => {
  permissions = base({ editable: false, ownedByAnother: true });
  const view = draw();
  await view.findByText(/这些是员工所有者设定的权限，你使用这位员工时同样适用/);
  expect(view.getByText("员工所有者设定")).toBeTruthy();
  expect(choice(view, "运行命令", "直接").hasAttribute("disabled")).toBeTrue();
  expect(view.queryByRole("textbox", { name: "添加敏感路径" })).toBeNull();
  fireEvent.click(choice(view, "运行命令", "直接"));
  expect(sent).toEqual([]);
});

test("the floors: a default path is switched off, never deleted; an added path can be deleted", async () => {
  const view = draw();
  const envSwitch = await view.findByRole("switch", { name: "启用默认路径 .env*" });
  fireEvent.click(envSwitch);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/security",
      method: "PATCH",
      body: { disabledDefaultPaths: [".env*"] },
    }),
  );
  // Only the added path has a delete button.
  expect(view.getAllByRole("button", { name: "删除" })).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "删除" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/security",
      method: "PATCH",
      body: { extraSensitivePaths: [] },
    }),
  );
  fireEvent.click(view.getByRole("switch", { name: "危险命令需审批" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/employees/desk/security",
      method: "PATCH",
      body: { dangerousCommands: "off" },
    }),
  );
});

test("with the team switch on, the Bot's dangerous-command switch is on and cannot be turned off (D10)", async () => {
  permissions = base({
    enforceDangerousCommands: true,
    security: { ...base().security, dangerousCommands: "off" },
  });
  const view = draw();
  const toggle = await view.findByRole("switch", { name: "危险命令需审批" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(/团队已强制开启危险命令审批/)).toBeTruthy();
});

test("an administrator gets the enterprise-mode link to the existing controls page (D1)", async () => {
  role = "admin";
  try {
    const view = draw();
    const link = await view.findByText("企业模式：前往企业管控");
    expect(link.closest("a")?.getAttribute("href")).toBe("/admin/enterprise");
  } finally {
    role = "user";
  }
});

test("the browser hides a tool the Bot's permissions disable (D4)", () => {
  const disabled = disabledToolRefs(
    base({
      teamRules: [
        {
          id: "t2",
          botId: "*",
          toolRef: "host/*",
          effect: "*",
          scope: "*",
          behaviour: "deny",
        },
        {
          id: "t3",
          botId: "*",
          toolRef: "computer_click",
          effect: "*",
          scope: "shop.example",
          behaviour: "deny",
        },
      ],
    }),
  );
  expect(toolIsDisabled(disabled, "computer_run_command")).toBeTrue();
  expect(toolIsDisabled(disabled, "host/run_command")).toBeTrue();
  // A deny narrowed to one target is decided by the server per call, not hidden.
  expect(toolIsDisabled(disabled, "computer_click")).toBeFalse();
  expect(toolIsDisabled(disabledToolRefs(undefined), "computer_run_command")).toBeFalse();
});
