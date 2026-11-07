import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { modelKeys } from "@/lib/models/queries";
import { personaKeys } from "@/lib/personas/queries";
import { type GrantedPlugins, pluginKeys } from "@/lib/plugins/queries";
import { type RoutineRecord, routineKeys } from "@/lib/routines/queries";
import { Route as AssembleRoute } from "@/routes/_authed/_app/assemble.$agentId";
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { settleReactWork } from "./settle-react-work";

/**
 * Story D7 acceptance: every Waker has its own assembly screen that manages, on one page, its model
 * binding, persona, skills, connectors and routines.
 *
 * `assemble-install.test.tsx` covers the skill grant write. This file covers the rest of the
 * contract: the five zones are all on the page, routines are this coworker's alone, a coworker the
 * person cannot manage is shown read-only, a coworker the server will not hand over is refused, and a
 * persona save PATCHes the profile without disturbing the fields it did not touch.
 *
 * The reads are seeded and `fetch` is stubbed, so what is asserted is what the screen renders from
 * the server's answers and what it sends back.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run — and not unregistering deletes the next file's.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  // Drain React before the document goes away, for the reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body?: unknown }[] = [];
const writes = () => calls.filter((entry) => entry.method !== "GET");

const agentId = "assemble-reviewer";
const otherAgentId = "assemble-someone-else";

const base: AgentProfile = {
  id: agentId,
  name: "Reviewer",
  title: "代码审核",
  roleDescription: "审核合并请求。",
  avatarSeed: "reviewer",
  visibility: "private",
  builtIn: true,
  endpoint: null,
  modelRef: null,
  persona: { tone: "直接", principles: "先读完再评论", habits: "" },
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function routine(
  id: string,
  owner: string,
  instruction: string,
): RoutineRecord {
  return {
    id,
    agentId: owner,
    schedule: `0 9 * * 1-5 ${id}`,
    timezone: "Asia/Shanghai",
    instruction,
    // Gone, so the row draws a chip rather than a link into a route this test does not mount.
    channel: { id: `channel-${id}`, name: null, gone: true },
    enabled: true,
    nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    lastRun: null,
  };
}

const granted: GrantedPlugins = {
  tools: [
    {
      ref: "github:search",
      toolName: "github_search",
      description: "搜索代码仓库。",
      inputSchema: {},
    },
  ],
  skills: [],
};

function draw({
  profile = base,
  agentStatus = 200,
}: {
  profile?: AgentProfile;
  agentStatus?: number;
} = {}) {
  const queryClient = new QueryClient({
    // `staleTime` so the seeded answers are used as seeded rather than refetched from the stub.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // A refused coworker is not seeded: the screen has to ask, and the answer is the 404.
  if (agentStatus === 200) {
    queryClient.setQueryData(agentKeys.detail(agentId), profile);
  }
  queryClient.setQueryData(authKeys.currentUser(), { id: "owner-1" });
  queryClient.setQueryData(modelKeys.library(), { models: [], templates: [] });
  queryClient.setQueryData(personaKeys.list(), []);
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: [
      {
        id: "s-mine",
        slug: "careful-review",
        ownerUserId: "owner-1",
        title: "仔细审核",
        summary: "评论前先读完 diff。",
        instructions: "",
        origin: "personal",
        installedBy: null,
        grantedTo: [],
        tools: [],
      },
    ],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  });
  queryClient.setQueryData(pluginKeys.forAgent(agentId), granted);
  queryClient.setQueryData(routineKeys.list(), {
    routines: [
      routine("r-mine", agentId, "汇总昨天的合并请求"),
      routine("r-theirs", otherAgentId, "给别人发周报"),
    ],
    // Working, so the "nothing is firing" banner stays out of the alerts asserted on below.
    sweep: { lastSweptAt: null, working: true },
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [`/assemble/${agentId}`] }),
    routeTree: root.addChildren([
      // `as never`, as in `assemble-install.test.tsx`: the file routes are registered in the
      // generated tree under their real parents, and this only re-addresses them for one render.
      WakersRoute.update({
        getParentRoute: () => root,
        path: "/wakers",
      } as never),
      AssembleRoute.update({
        getParentRoute: () => root,
        path: "/assemble/$agentId",
      } as never),
    ]),
  });

  globalThis.fetch = (async (
    path: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(path);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    calls.push({ method, path: url, ...(body === undefined ? {} : { body }) });
    if (url === `/api/agents/${agentId}`) {
      if (agentStatus !== 200) {
        return Response.json({ error: "Not found" }, { status: agentStatus });
      }
      const patch =
        method === "PATCH" && body && typeof body === "object" ? body : {};
      return Response.json({ agent: { ...profile, ...patch } });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

const ZONES = ["模型", "人设", "技能", "连接器", "定时任务"] as const;

test("one screen holds all five zones of the coworker", async () => {
  const { view } = draw();

  await view.findByRole("heading", { level: 2, name: "定时任务" });
  for (const zone of ZONES) {
    expect(view.getByRole("heading", { level: 2, name: zone })).toBeTruthy();
  }
  // Each zone draws what it manages, not just its heading.
  expect(view.getByRole("combobox")).toBeTruthy();
  expect(
    view.container.querySelector<HTMLTextAreaElement>("#persona-tone")
      ?.readOnly,
  ).toBe(false);
  expect(view.getByRole("button", { name: "保存" })).toBeTruthy();
  expect(view.getByText("仔细审核")).toBeTruthy();
  expect(view.getByText("github_search")).toBeTruthy();
  expect(view.getByText("汇总昨天的合并请求")).toBeTruthy();
  // A manager sees no read-only notice.
  expect(view.queryByText(/这里只能看/)).toBeNull();
});

test("the routines zone lists only this coworker's routines", async () => {
  const { view } = draw();

  await view.findByText("汇总昨天的合并请求");
  // The routine list is the person's whole list; the screen narrows it to this coworker.
  expect(view.queryByText("给别人发周报")).toBeNull();
  expect(view.queryByText(/r-theirs/)).toBeNull();
  expect(view.queryByText("这位员工还没有定时任务")).toBeNull();
});

test("a coworker the person cannot manage is shown read-only", async () => {
  const { view, user } = draw({
    profile: { ...base, canManage: false, mine: false },
  });

  await view.findByText(
    "这位员工归别人所有，所以这里只能看，要改请到它主人那里。",
  );
  // The model is said, not offered as a choice.
  expect(view.queryByRole("combobox")).toBeNull();
  expect(view.getByText("部署自带的模型")).toBeTruthy();
  // The persona is shown as written, but cannot be typed into or saved.
  for (const part of ["tone", "principles", "habits"]) {
    const field = view.container.querySelector<HTMLTextAreaElement>(
      `#persona-${part}`,
    );
    expect(field?.readOnly).toBe(true);
  }
  expect(
    view.container.querySelector<HTMLTextAreaElement>("#persona-tone")?.value,
  ).toBe("直接");
  expect(view.queryByRole("button", { name: "保存" })).toBeNull();
  expect(view.queryByRole("button", { name: "清空" })).toBeNull();
  // The skill box is drawn so the person can see what it holds, but it cannot be ticked.
  const box = view.getByRole("checkbox");
  expect(box.hasAttribute("data-disabled")).toBe(true);
  await user.click(box);
  // Give a stray mutation the chance to leave before asserting that none did.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    calls.filter((entry) => entry.path.includes("/api/plugins/grants")),
  ).toEqual([]);
  expect(writes()).toEqual([]);
});

test("a coworker the server will not hand over is refused, not assembled", async () => {
  const { view } = draw({ agentStatus: 404 });

  const refusal = await view.findByRole("alert");
  expect(refusal.textContent).toBe("你不能装配这位员工。");
  for (const zone of ZONES) {
    expect(view.queryByRole("heading", { level: 2, name: zone })).toBeNull();
  }
  expect(view.queryByRole("checkbox")).toBeNull();
  expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toContain(
    `GET /api/agents/${agentId}`,
  );
  expect(writes()).toEqual([]);
});

test("saving the persona PATCHes it and keeps the other fields as they are", async () => {
  const { view, user } = draw({ profile: { ...base, modelRef: "model-1" } });

  await view.findByRole("heading", { level: 2, name: "人设" });
  const tone =
    view.container.querySelector<HTMLTextAreaElement>("#persona-tone");
  if (!tone) throw new Error("the persona tone field is missing");
  expect(tone.value).toBe("直接");

  await user.clear(tone);
  await user.type(tone, "  温和但坚定  ");
  await user.click(view.getByRole("button", { name: "保存" }));

  const patches = () =>
    writes().filter(
      (entry) =>
        entry.method === "PATCH" && entry.path === `/api/agents/${agentId}`,
    );
  await waitFor(() => expect(patches().length).toBe(1));
  const [patch] = patches();
  expect(patch?.body).toEqual({
    name: base.name,
    title: base.title,
    roleDescription: base.roleDescription,
    visibility: base.visibility,
    // A built-in coworker's endpoint is the deployment's own; empty leaves the stored one alone.
    endpoint: "",
    // Trimmed, and the two parts not edited go back exactly as they were.
    persona: { tone: "温和但坚定", principles: "先读完再评论", habits: "" },
  });
  // A persona save never sends the model binding, so it cannot clear or change it.
  expect(patch?.body).not.toHaveProperty("modelRef");
  expect(patch?.body).not.toHaveProperty("auth");
  // Nothing but the profile was written.
  expect(writes().length).toBe(1);
  await view.findByText("已保存，员工下一轮开始生效。");
});
