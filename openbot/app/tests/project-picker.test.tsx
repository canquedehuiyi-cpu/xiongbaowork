import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectPicker } from "@/components/projects/project-picker";
import type { RegisteredDevice } from "@/lib/devices/queries";
import type { Project } from "@/lib/projects/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Story RES2, phase 3 (spec §5 RES2-3, acceptance 4): the coworker's project picker, shared by the
 * conversation and the coworker's detail page. Only what this coworker may use on the chosen machine
 * can be picked; another coworker's own project is never offered, and one on another machine is
 * greyed with where it is. The server's filtering is faked the way `/api/projects` filters.
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

const device = (id: string, name: string): RegisteredDevice => ({
  id,
  deviceId: name,
  name,
  platform: "linux",
  lastSeenAt: "2026-11-04T00:00:00.000Z",
  online: true,
  roots: [],
});
const study = device("11111111-1111-4111-8111-111111111111", "书房电脑");
const office = device("22222222-2222-4222-8222-222222222222", "办公室电脑");

let n = 0;
const project = (fields: Partial<Project>): Project => {
  n += 1;
  return {
    id: `33333333-3333-4333-8333-33333333333${n}`,
    deviceId: study.id,
    scope: "public",
    agentId: null,
    name: `项目${n}`,
    description: "",
    source: {
      kind: "local",
      rootRef: "fld_RRRRRRRRRRRRRRRRRRRRRR",
      label: "合同",
      writable: false,
    },
    revision: 1,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
    ...fields,
  };
};

const shared = project({ name: "公共文档" });
const xsOwn = project({ name: "X 的后端", scope: "agent", agentId: "bot-x" });
const ysOwn = project({ name: "Y 的设计稿", scope: "agent", agentId: "bot-y" });
const officeOne = project({ name: "办公室项目", deviceId: office.id });

function serve(devices: RegisteredDevice[]) {
  const all = [shared, xsOwn, ysOwn, officeOne];
  const current = new Map<string, string | null>();
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === "/api/devices") return Response.json({ devices });
    if (path.startsWith("/api/projects?")) {
      const search = new URL(path, "http://x").searchParams;
      const deviceId = search.get("device");
      const agent = search.get("agent");
      // As the server answers it: the machine's public projects and this coworker's own.
      const projects = all.filter(
        (entry) =>
          entry.deviceId === deviceId &&
          (entry.scope === "public" || entry.agentId === agent),
      );
      return Response.json({
        projects,
        currentProjectId: current.get(`${deviceId}/${agent}`) ?? null,
      });
    }
    if (path === "/api/projects/current" && method === "PUT") {
      current.set(`${body.deviceId}/${body.agentId}`, body.projectId);
      return Response.json({
        project: all.find((entry) => entry.id === body.projectId) ?? null,
      });
    }
    return Response.json({ error: "not faked" }, { status: 404 });
  }) as typeof fetch;
}

function draw(agentId: string, compact = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectPicker agentId={agentId} compact={compact} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

const options = (select: HTMLElement) =>
  [...(select as HTMLSelectElement).options].map((option) => ({
    text: option.textContent,
    disabled: option.disabled,
  }));

test("acceptance 4: a coworker is offered the public projects and its own; another coworker's own never appears, and another machine's is greyed with where it is", async () => {
  serve([study, office]);
  const { view } = draw("bot-x");
  const select = await view.findByLabelText("当前项目");
  await waitFor(() => expect(options(select)).toHaveLength(4));
  expect(options(select)).toEqual([
    { text: "不使用项目（在员工自己的工作区里）", disabled: false },
    { text: "公共文档", disabled: false },
    { text: "X 的后端（专属）", disabled: false },
    { text: "办公室项目（在另一台设备上：办公室电脑）", disabled: true },
  ]);
  expect(view.queryByText(/Y 的设计稿/)).toBeNull();
  // Each machine is asked only for what this coworker may use there.
  expect(
    calls
      .filter((call) => call.path.startsWith("/api/projects?"))
      .every((call) => call.path.includes("agent=bot-x")),
  ).toBeTrue();
});

test("picking writes the coworker's current project on that machine, and 不使用项目 clears it", async () => {
  serve([study]);
  const { view, user } = draw("bot-x");
  const select = await view.findByLabelText("当前项目");
  await waitFor(() => expect(options(select)).toHaveLength(3));
  // One machine: no machine to pick.
  expect(view.queryByLabelText("项目所在设备")).toBeNull();

  await user.selectOptions(select, xsOwn.id);
  await waitFor(() =>
    expect((select as HTMLSelectElement).value).toBe(xsOwn.id),
  );
  expect(
    await view.findByText(/派活时文件和命令默认在这个项目里执行/),
  ).toBeTruthy();
  await user.selectOptions(select, "");
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()).toEqual([
    {
      method: "PUT",
      path: "/api/projects/current",
      body: { deviceId: study.id, agentId: "bot-x", projectId: xsOwn.id },
    },
    {
      method: "PUT",
      path: "/api/projects/current",
      body: { deviceId: study.id, agentId: "bot-x", projectId: null },
    },
  ]);
});

test("with two machines the machine is picked first, and the other machine's projects become the greyed ones", async () => {
  serve([study, office]);
  const { view, user } = draw("bot-y");
  const select = await view.findByLabelText("当前项目");
  await waitFor(() => expect(options(select)).toHaveLength(4));
  await user.selectOptions(view.getByLabelText("项目所在设备"), office.id);
  await waitFor(() =>
    expect(options(select)).toEqual([
      { text: "不使用项目（在员工自己的工作区里）", disabled: false },
      { text: "办公室项目", disabled: false },
      { text: "公共文档（在另一台设备上：书房电脑）", disabled: true },
      { text: "Y 的设计稿（在另一台设备上：书房电脑）", disabled: true },
    ]),
  );
});

test("beside the conversation it draws nothing when there is no machine or no project to pick", async () => {
  serve([]);
  const none = draw("bot-x", true);
  await waitFor(() =>
    expect(calls.some((call) => call.path === "/api/devices")).toBeTrue(),
  );
  await settleReactWork();
  expect(none.view.container.textContent).toBe("");
  cleanup();

  serve([study]);
  const full = draw("bot-x", true);
  expect(await full.view.findByLabelText("当前项目")).toBeTruthy();
});
