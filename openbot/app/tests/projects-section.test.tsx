import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsSection } from "@/components/resources/projects-section";
import type { RegisteredDevice } from "@/lib/devices/queries";
import type { Project } from "@/lib/projects/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Story RES2, phase 3 (spec §5 RES2-3): the 项目 zone of 能力与资源. A machine first, then its
 * projects; a new one from a folder the machine registered or from a Git repository and branch; a
 * 员工专属 project needs a coworker; 同步 and 列出分支 wait for the machine to be online and say why.
 * The fetch is faked and records every call.
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
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((call) => call.method !== "GET");

const READ = "fld_RRRRRRRRRRRRRRRRRRRRRR";
const WRITE = "fld_WWWWWWWWWWWWWWWWWWWWWW";

const study = {
  id: "11111111-1111-4111-8111-111111111111",
  deviceId: "study-pc",
  name: "书房电脑",
  platform: "linux",
  lastSeenAt: "2026-11-04T00:00:00.000Z",
  online: true,
  roots: [
    { ref: READ, name: "合同" },
    { ref: WRITE, name: "后端代码", mode: "write" },
  ],
} as RegisteredDevice;
const laptop: RegisteredDevice = {
  id: "22222222-2222-4222-8222-222222222222",
  deviceId: "old-laptop",
  name: "旧笔记本",
  platform: "darwin",
  lastSeenAt: "2026-10-01T00:00:00.000Z",
  online: false,
  roots: [],
};

const project = (fields: Partial<Project>): Project => ({
  id: "33333333-3333-4333-8333-333333333333",
  deviceId: study.id,
  scope: "public",
  agentId: null,
  name: "合同审阅",
  description: "",
  source: { kind: "local", rootRef: READ, label: "合同", writable: false },
  revision: 1,
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  ...fields,
});

const siteRepo = project({
  id: "44444444-4444-4444-8444-444444444444",
  deviceId: laptop.id,
  name: "官网",
  source: {
    kind: "git",
    url: "https://git.example.test/web/site.git",
    branch: "main",
    rootRef: null,
    writable: true,
    syncedAt: null,
    commit: null,
  },
});

function serve(byDevice: Record<string, Project[]>) {
  const stored = { ...byDevice };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === "/api/devices")
      return Response.json({ devices: [study, laptop] });
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: [
          { id: "bot-x", name: "后端工程师", canManage: true },
          { id: "bot-y", name: "设计师", canManage: true },
        ],
      });
    if (path.startsWith("/api/projects?") && method === "GET") {
      const device = new URL(path, "http://x").searchParams.get("device") ?? "";
      return Response.json({ projects: stored[device] ?? [] });
    }
    if (path === "/api/projects/branches")
      return Response.json({ branches: ["main", "release/1.0"] });
    if (path === "/api/projects" && method === "POST") {
      const made = project({
        id: "55555555-5555-4555-8555-555555555555",
        deviceId: body.deviceId,
        name: body.name,
        scope: body.scope,
        agentId: body.agentId,
      });
      stored[body.deviceId] = [...(stored[body.deviceId] ?? []), made];
      return Response.json({ project: made }, { status: 201 });
    }
    return Response.json({ error: "not faked" }, { status: 404 });
  }) as typeof fetch;
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectsSection />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("acceptance 1: a machine is picked first and only its projects are shown; a new local project picks one of the folders that machine registered", async () => {
  serve({ [study.id]: [project({})], [laptop.id]: [siteRepo] });
  const { view, user } = draw();
  const list = await view.findByRole("list", { name: "这台设备上的项目" });
  expect(within(list).getByText("合同审阅")).toBeTruthy();
  expect(within(list).getByText("本地目录 · 合同 · 只读")).toBeTruthy();
  expect(view.queryByText("官网")).toBeNull();

  await user.selectOptions(view.getByLabelText("设备"), laptop.id);
  expect(await view.findByText("官网")).toBeTruthy();
  expect(view.queryByText("合同审阅")).toBeNull();
  await user.selectOptions(view.getByLabelText("设备"), study.id);
  await view.findByText("合同审阅");

  await user.click(view.getByRole("button", { name: "新建项目" }));
  const form = within(view.getByRole("form", { name: "新建项目" }));
  await user.type(form.getByLabelText("项目名称"), "后端");
  // Both folders the machine registered, by name and mode, never a path.
  expect(form.getByText(/合同/)).toBeTruthy();
  expect(form.getByText(/设备上登记为只读/)).toBeTruthy();
  expect(form.getByText(/设备上登记为读写/)).toBeTruthy();

  // D3: a folder registered read-only on the machine cannot be made writable here.
  await user.click(form.getByLabelText(/^合同/));
  const writable = form.getByRole("checkbox", {
    name: "允许员工修改项目里的文件",
  });
  expect(
    writable.getAttribute("aria-disabled") === "true" ||
      writable.hasAttribute("data-disabled"),
  ).toBeTrue();
  expect(form.getByText(/这个目录在设备上登记为只读/)).toBeTruthy();

  await user.click(form.getByLabelText(/^后端代码/));
  await waitFor(() =>
    expect(writable.hasAttribute("data-disabled")).toBeFalse(),
  );
  await user.click(writable);
  await user.click(form.getByRole("button", { name: "保存项目" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual({
    method: "POST",
    path: "/api/projects",
    body: {
      deviceId: study.id,
      name: "后端",
      description: "",
      scope: "public",
      agentId: null,
      source: { kind: "local", rootRef: WRITE, writable: true },
    },
  });
  expect(JSON.stringify(calls)).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\\\/);
});

test("acceptance 1: a Git project takes an address and a branch, lists the branches from the machine, and refuses a credential in the address before sending anything", async () => {
  serve({ [study.id]: [] });
  const { view, user } = draw();
  await view.findByText("这台设备上还没有项目。");
  await user.click(view.getByRole("button", { name: "新建项目" }));
  const form = within(view.getByRole("form", { name: "新建项目" }));
  await user.type(form.getByLabelText("项目名称"), "官网");
  await user.click(form.getByLabelText("Git 仓库"));

  await user.type(
    form.getByLabelText("仓库地址"),
    "https://user:token@git.example.test/web/site.git",
  );
  expect(
    (form.getByRole("button", { name: "列出分支" }) as HTMLButtonElement)
      .disabled,
  ).toBeTrue();
  await user.click(form.getByRole("button", { name: "保存项目" }));
  expect(await form.findByText("仓库地址里不能带密码或令牌。")).toBeTruthy();
  expect(writes()).toEqual([]);

  await user.clear(form.getByLabelText("仓库地址"));
  await user.type(
    form.getByLabelText("仓库地址"),
    "git@git.example.test:web/site.git",
  );
  await user.click(form.getByRole("button", { name: "列出分支" }));
  const branches = await form.findByLabelText("选择分支");
  await user.selectOptions(branches, "release/1.0");
  expect((form.getByLabelText("分支") as HTMLInputElement).value).toBe(
    "release/1.0",
  );
  await user.click(form.getByRole("button", { name: "保存项目" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/projects/branches",
      body: { deviceId: study.id, url: "git@git.example.test:web/site.git" },
    },
    {
      method: "POST",
      path: "/api/projects",
      body: {
        deviceId: study.id,
        name: "官网",
        description: "",
        scope: "public",
        agentId: null,
        source: {
          kind: "git",
          url: "git@git.example.test:web/site.git",
          branch: "release/1.0",
          writable: true,
        },
      },
    },
  ]);
});

test("acceptance 2: a 员工专属 project cannot be saved until a coworker is picked", async () => {
  serve({ [study.id]: [] });
  const { view, user } = draw();
  await view.findByText("这台设备上还没有项目。");
  await user.click(view.getByRole("button", { name: "新建项目" }));
  const form = within(view.getByRole("form", { name: "新建项目" }));
  await user.type(form.getByLabelText("项目名称"), "X 的项目");
  await user.click(form.getByLabelText(/^合同/));
  await user.click(form.getByLabelText("员工专属"));
  await user.click(form.getByRole("button", { name: "保存项目" }));
  expect(await form.findByText("员工专属项目需要选择一位员工。")).toBeTruthy();
  expect(writes()).toEqual([]);

  await user.selectOptions(form.getByLabelText("员工"), "bot-x");
  await user.click(form.getByRole("button", { name: "保存项目" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.body).toMatchObject({
    scope: "agent",
    agentId: "bot-x",
  });
});

test("acceptance 3: on an offline machine 同步 and 列出分支 are unavailable, and the reason is shown", async () => {
  serve({ [laptop.id]: [siteRepo] });
  const { view, user } = draw();
  await user.selectOptions(await view.findByLabelText("设备"), laptop.id);
  const sync = (await view.findByRole("button", {
    name: "同步 官网",
  })) as HTMLButtonElement;
  expect(sync.disabled).toBeTrue();
  expect(
    view.getAllByText(/设备离线，无法同步或列出分支/).length,
  ).toBeGreaterThan(0);

  await user.click(view.getByRole("button", { name: "新建项目" }));
  const form = within(view.getByRole("form", { name: "新建项目" }));
  await user.click(form.getByLabelText("Git 仓库"));
  await user.type(
    form.getByLabelText("仓库地址"),
    "https://git.example.test/a.git",
  );
  expect(
    (form.getByRole("button", { name: "列出分支" }) as HTMLButtonElement)
      .disabled,
  ).toBeTrue();
  expect(form.getByText(/设备离线，无法同步或列出分支/)).toBeTruthy();
  expect(writes()).toEqual([]);
});

test("acceptance 5: every label and button on the zone is Chinese", async () => {
  serve({ [study.id]: [project({})] });
  const { view, user } = draw();
  await view.findByText("合同审阅");
  await user.click(view.getByRole("button", { name: "新建项目" }));
  await user.click(view.getByLabelText("Git 仓库"));
  const texts = [
    ...view.container.querySelectorAll("button, label, legend, option, p, h2"),
  ]
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean);
  expect(texts.length).toBeGreaterThan(10);
  for (const text of texts) {
    // A product name (Git) or a value the person typed may be Latin; the words around it are not.
    expect(text).toMatch(/[一-鿿]/);
  }
});
