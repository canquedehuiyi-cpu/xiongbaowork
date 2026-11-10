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
import { pluginKeys } from "@/lib/plugins/queries";
import { routineKeys } from "@/lib/routines/queries";
import { Route as AssembleRoute } from "@/routes/_authed/_app/assemble.$agentId";
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { settleReactWork } from "./settle-react-work";

/**
 * Story RES1 (D08) on the assembly page: which of the person's knowledge bases this coworker may
 * read is decided here, one box per base, through the same binding endpoint the knowledge screen
 * uses — and a coworker the person cannot manage gets boxes that cannot be ticked.
 *
 * Everything outside the knowledge zone is seeded as in `assemble-screen.test.tsx`; the knowledge
 * reads go to a small in-memory `/api/knowledge` that keeps bindings, so a tick is asserted both as
 * the request that left and as the state the screen redraws from.
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
const calls: { method: string; path: string; body?: unknown }[] = [];
const writes = () => calls.filter((entry) => entry.method !== "GET");

const agentId = "assemble-reviewer";
const HANDBOOK = "11111111-1111-4111-8111-111111111111";
const STYLE = "22222222-2222-4222-8222-222222222222";
const STAMP = "2026-11-01T00:00:00.000Z";

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

function draw({
  profile = base,
  bound = [HANDBOOK],
}: {
  profile?: AgentProfile;
  bound?: string[];
} = {}) {
  const notebooks = [
    { id: HANDBOOK, title: "产品手册" },
    { id: STYLE, title: "写作规范" },
  ];
  const bindings = new Set(bound);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.detail(agentId), profile);
  queryClient.setQueryData(authKeys.currentUser(), { id: "owner-1" });
  queryClient.setQueryData(modelKeys.library(), { models: [], templates: [] });
  queryClient.setQueryData(personaKeys.list(), []);
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  });
  queryClient.setQueryData(pluginKeys.forAgent(agentId), {
    tools: [],
    skills: [],
  });
  queryClient.setQueryData(routineKeys.list(), {
    routines: [],
    sweep: { lastSweptAt: null, working: true },
  });

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });

    if (path === "/api/knowledge/notebooks") {
      return Response.json({
        notebooks: notebooks.map((notebook) => ({
          ...notebook,
          revision: 1,
          createdAt: STAMP,
          updatedAt: STAMP,
        })),
      });
    }
    if (path === `/api/knowledge/for/${agentId}`) {
      // The server's rule: a Waker that is not the person's own is a 403 here.
      if (!profile.mine)
        return Response.json(
          { error: "找不到你的这个 Waker。" },
          { status: 403 },
        );
      return Response.json({
        notebooks: notebooks
          .filter((notebook) => bindings.has(notebook.id))
          .map((notebook) => ({
            notebookId: notebook.id,
            title: notebook.title,
            accessMode: "read_only",
          })),
      });
    }
    const binding = path.match(
      /^\/api\/knowledge\/notebooks\/([^/]+)\/bindings\/([^/]+)$/,
    );
    if (binding?.[1] && binding[2] === agentId) {
      if (method === "PUT") {
        bindings.add(binding[1]);
        return Response.json({
          binding: {
            agentId,
            notebookId: binding[1],
            accessMode: "read_only",
            updatedAt: STAMP,
          },
        });
      }
      if (method === "DELETE") {
        const removed = bindings.delete(binding[1]);
        return Response.json({ removed });
      }
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

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

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    bindings,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

const boxFor = (
  view: ReturnType<typeof draw>["view"],
  title: string,
): HTMLElement => view.getByRole("checkbox", { name: `允许读取 ${title}` });

test("the knowledge zone has one box per base, ticked for the ones this coworker may read", async () => {
  const { view } = draw();

  await view.findByRole("heading", { level: 2, name: "知识库" });
  await view.findByRole("checkbox", { name: "允许读取 产品手册" });
  await waitFor(() =>
    expect(boxFor(view, "产品手册").getAttribute("aria-checked")).toBe("true"),
  );
  expect(boxFor(view, "写作规范").getAttribute("aria-checked")).toBe("false");
  expect(boxFor(view, "产品手册").hasAttribute("data-disabled")).toBe(false);
  expect(writes()).toEqual([]);
});

test("ticking a base grants this coworker read-only access to it, unticking takes it back", async () => {
  const { view, user, bindings } = draw({ bound: [] });

  await view.findByRole("checkbox", { name: "允许读取 写作规范" });
  await user.click(boxFor(view, "写作规范"));
  await waitFor(() =>
    expect(boxFor(view, "写作规范").getAttribute("aria-checked")).toBe("true"),
  );
  expect(writes()).toEqual([
    {
      method: "PUT",
      path: `/api/knowledge/notebooks/${STYLE}/bindings/${agentId}`,
      body: { accessMode: "read_only" },
    },
  ]);
  expect([...bindings]).toEqual([STYLE]);

  calls.length = 0;
  await user.click(boxFor(view, "写作规范"));
  await waitFor(() =>
    expect(boxFor(view, "写作规范").getAttribute("aria-checked")).toBe("false"),
  );
  expect(writes()).toEqual([
    {
      method: "DELETE",
      path: `/api/knowledge/notebooks/${STYLE}/bindings/${agentId}`,
    },
  ]);
  expect([...bindings]).toEqual([]);
});

test("a coworker the person cannot manage gets knowledge boxes that cannot be ticked", async () => {
  const { view, user } = draw({
    profile: { ...base, canManage: false, mine: false },
  });

  await view.findByRole("checkbox", { name: "允许读取 产品手册" });
  for (const title of ["产品手册", "写作规范"]) {
    const box = boxFor(view, title);
    expect(box.hasAttribute("data-disabled")).toBe(true);
    // None of the person's bases can be bound to somebody else's coworker, so none is ticked.
    expect(box.getAttribute("aria-checked")).toBe("false");
  }
  expect(view.getByText("知识库只能授权给你自己的员工。")).toBeTruthy();

  await user.click(boxFor(view, "产品手册"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(writes()).toEqual([]);
  // The per-Waker read is never asked for a coworker the server would answer with a 403.
  expect(
    calls.some((entry) => entry.path.startsWith("/api/knowledge/for/")),
  ).toBe(false);
});

test("a manager who is not the owner still cannot grant: the boxes stay disabled", async () => {
  const { view, user } = draw({
    profile: { ...base, canManage: true, mine: false },
  });

  await view.findByRole("checkbox", { name: "允许读取 写作规范" });
  expect(boxFor(view, "写作规范").hasAttribute("data-disabled")).toBe(true);
  await user.click(boxFor(view, "写作规范"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls.filter((entry) => entry.path.includes("/bindings/"))).toEqual(
    [],
  );
});
