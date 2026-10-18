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
import { pluginKeys } from "@/lib/plugins/queries";
import { Route as AgentsRoute } from "@/routes/_authed/_app/agents/index";
import { Route as AssembleRoute } from "@/routes/_authed/_app/assemble.$agentId";

/**
 * Ticket 015 acceptance, at the screen where it is decided: installing a skill on one coworker is a
 * grant to the server, on this coworker, and nothing else about it is rewritten.
 *
 * The route is the real one and so is the mutation — the cache is seeded rather than the network
 * stubbed, because the assertion that matters is what leaves the browser. Everything else the screen
 * reads comes from seeded queries, so a failure names the write rather than a missing fetch.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body?: unknown }[] = [];

const agentId = "assemble-reviewer";

const profile: AgentProfile = {
  id: agentId,
  name: "Reviewer",
  title: "Code reviewer",
  roleDescription: "Reviews the pull requests.",
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
};

function draw(grantedSlugs: string[]) {
  const queryClient = new QueryClient({
    // `staleTime` so the seeded answers below are used as seeded: a background refetch would hit the
    // stub, get nothing back, and turn an assertion about a write into one about this harness.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.detail(agentId), profile);
  queryClient.setQueryData(authKeys.currentUser(), { id: "owner-1" });
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: [
      {
        id: "s-mine",
        slug: "careful-review",
        ownerUserId: "owner-1",
        title: "Careful review",
        summary: "Read the diff before commenting.",
        instructions: "",
        origin: "personal",
        installedBy: null,
        grantedTo: [],
        tools: [],
      },
      {
        id: "s-theirs",
        slug: "deployment-skill",
        ownerUserId: null,
        title: "Deployment skill",
        summary: "An administrator's skill.",
        instructions: "",
        origin: "deployment",
        installedBy: null,
        grantedTo: [agentId],
        tools: [],
      },
    ],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  });
  queryClient.setQueryData(pluginKeys.forAgent(agentId), {
    tools: [],
    skills: grantedSlugs.map((slug) => ({
      slug,
      title: slug,
      summary: "",
    })),
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [`/assemble/${agentId}`] }),
    routeTree: root.addChildren([
      // `as never` on the parent: TanStack's own file route is already registered in the generated
      // tree with its real parent, and this only needs it answering to a different address for the
      // duration of one render. `agent-roster-error.test.tsx` casts the same way for the same reason.
      AgentsRoute.update({
        getParentRoute: () => root,
        path: "/agents",
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
    calls.push({
      method: init?.method ?? "GET",
      path: url,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  return {
    view: render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

test("the assembly screen shows what the coworker already holds", async () => {
  const { view } = draw(["careful-review"]);

  const box = await view.findByRole("checkbox");
  expect(box.getAttribute("aria-checked")).toBe("true");
  // An administrator's skill is said to be an administrator's, not offered as a box to tick.
  expect(view.queryByText("Deployment skill")).toBeNull();
  expect(
    view.getByText(/另有 1 个部署技能由管理员在插件页里授予/),
  ).toBeTruthy();
});

test("ticking a skill grants it to this coworker and nothing else", async () => {
  const { view } = draw([]);
  const box = await view.findByRole("checkbox");
  expect(box.getAttribute("aria-checked")).toBe("false");

  await userEvent
    .setup({ document: view.baseElement.ownerDocument })
    .click(box);

  // The grant endpoint only: the mutation settles by invalidating the plugin readers, and those
  // refetch against this stub too, so counting every call would assert on the harness.
  const grants = () =>
    calls.filter((entry) => entry.path.includes("/api/plugins/grants"));
  await waitFor(() => expect(grants().length).toBe(1));
  const [grant] = grants();
  expect(grant?.method).toBe("POST");
  expect(grant?.path).toContain("/api/plugins/grants");
  // The three things a grant joins. There is no `granted` flag on the wire: the POST is the
  // granting, and the DELETE with the same three is the taking back — which is why a grant has no id
  // of its own to carry.
  expect(grant?.body).toEqual({
    agentId,
    kind: "skill",
    ref: "careful-review",
  });
});

test("unticking takes the same grant back", async () => {
  const { view } = draw(["careful-review"]);
  const box = await view.findByRole("checkbox");
  expect(box.getAttribute("aria-checked")).toBe("true");

  await userEvent
    .setup({ document: view.baseElement.ownerDocument })
    .click(box);

  const revokes = () =>
    calls.filter((entry) => entry.path.includes("/api/plugins/grants"));
  await waitFor(() => expect(revokes().length).toBe(1));
  const [revoke] = revokes();
  expect(revoke?.method).toBe("DELETE");
  expect(revoke?.path).toContain("/api/plugins/grants?kind=skill");
  expect(revoke?.path).toContain(`agentId=${agentId}`);
});
