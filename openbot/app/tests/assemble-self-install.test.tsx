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
import type { InstallListing, PluginsPage } from "@/lib/plugins/queries";
import { routineKeys } from "@/lib/routines/queries";
import { Route as AgentsRoute } from "@/routes/_authed/_app/agents/index";
import { Route as AssembleRoute } from "@/routes/_authed/_app/assemble.$agentId";
import { settleReactWork } from "./settle-react-work";

/**
 * Story E3 (D08) on the assembly page: what an administrator listed (上架) the owner of a Waker
 * installs on it and takes off again themselves, through the same grant endpoint every other grant
 * uses.
 *
 * The page reads a small in-memory `/api/plugins` that keeps listings and grants, so a tick is
 * asserted both as the request that left and as the state the screen redraws from. A refusal is the
 * server's own sentence, drawn as sent.
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
const grantCalls = () =>
  calls.filter((entry) => entry.path.startsWith("/api/plugins/grants"));

const agentId = "assemble-reviewer";
const REFUSAL = "You can only install listed entries on Bots you own.";

const base: AgentProfile = {
  id: agentId,
  name: "Reviewer",
  title: "代码审核",
  roleDescription: "审核合并请求。",
  avatarSeed: "reviewer",
  visibility: "private",
  builtIn: false,
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

const deploymentSkill = (slug: string, title: string) => ({
  id: `s-${slug}`,
  slug,
  ownerUserId: null,
  title,
  summary: `${title}的摘要。`,
  instructions: "",
  origin: "deployment",
  installedBy: null,
  grantedTo: [],
  tools: [],
});

function draw({
  profile = base,
  listings = [
    { kind: "skill", ref: "weekly-report", listedAt: null },
    { kind: "mcp", ref: "notion", listedAt: null },
  ],
  held = [],
  mine = [],
  refuse = false,
  teamScoped = false,
  hold = false,
}: {
  profile?: AgentProfile;
  listings?: InstallListing[];
  held?: string[];
  /** Which of `held` this person installed themselves (`/for/:id/installed-by-me`). */
  mine?: string[];
  refuse?: boolean;
  /** The Notion row as G01-E stores a curated connector: id `team:notion`, refs `notion/...`. */
  teamScoped?: boolean;
  /** Keep every grant write open until `release()`, to see what is in flight. */
  hold?: boolean;
} = {}) {
  const grants = new Set(held);
  const installedByMe = new Set(mine);
  const serverId = teamScoped ? "team:notion" : "notion";
  const waiting: (() => void)[] = [];
  const release = () => {
    for (const resume of waiting.splice(0)) resume();
  };
  const page = (): PluginsPage => ({
    catalogue: [
      {
        key: "notion",
        title: "Notion",
        vendor: "Notion",
        summary: "",
        docsUrl: "",
        auth: "user-oauth",
        perInstance: false,
      },
    ],
    servers: [
      {
        id: serverId,
        title: "Notion",
        vendor: "Notion",
        url: "https://mcp.notion.com/mcp",
        summary: "",
        docsUrl: "",
        provenance: "first-party",
        hasCredential: false,
        toolsRefreshedAt: null,
        lastError: null,
        addedBy: null,
        dynamicClient: false,
        authScheme: null,
        tools: ["search", "create_page"].map((name) => ({
          serverId,
          name,
          description: `${name} 的说明。`,
          inputSchema: {},
          ref: `notion/${name}`,
          effect: name === "search" ? ("read" as const) : ("write" as const),
          destructive: false,
          grantedTo: grants.has(`notion/${name}`) ? [agentId] : [],
        })),
        withdrawn: [],
      },
    ],
    skills: [
      deploymentSkill("weekly-report", "周报"),
      deploymentSkill("standup", "站会"),
      deploymentSkill("retro", "复盘"),
    ],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  });
  const forAgent = () => ({
    tools: [...grants]
      .filter((ref) => ref.includes("/"))
      .map((ref) => ({
        ref,
        toolName: ref.split("/")[1] ?? ref,
        description: "",
        inputSchema: {},
      })),
    skills: [...grants]
      .filter((ref) => !ref.includes("/"))
      .map((slug) => ({ slug, title: slug, summary: "", instructions: "" })),
  });

  const queryClient = new QueryClient({
    // `staleTime` so the seeded reads stay seeded; an invalidation still refetches what is on screen.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.detail(agentId), profile);
  queryClient.setQueryData(authKeys.currentUser(), { id: "owner-1" });
  queryClient.setQueryData(modelKeys.library(), { models: [], templates: [] });
  queryClient.setQueryData(personaKeys.list(), []);
  queryClient.setQueryData(routineKeys.list(), {
    routines: [],
    sweep: { lastSweptAt: null, working: true },
  });

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(input);
    const path = url.split("?")[0];
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { ref?: string })
        : undefined;
    calls.push({ method, path: url, ...(body === undefined ? {} : { body }) });

    if (path === "/api/plugins") return Response.json(page());
    if (path === "/api/plugins/listings") return Response.json({ listings });
    if (path === `/api/plugins/for/${agentId}`)
      return Response.json(forAgent());
    if (path === `/api/plugins/for/${agentId}/installed-by-me`)
      return Response.json({
        tools: [...installedByMe].filter((ref) => ref.includes("/")),
        skills: [...installedByMe].filter((ref) => !ref.includes("/")),
      });
    if (path === "/api/plugins/grants") {
      if (hold) await new Promise<void>((resume) => waiting.push(resume));
      if (refuse) return Response.json({ error: REFUSAL }, { status: 403 });
      const ref =
        method === "POST"
          ? body?.ref
          : (new URL(url, "http://x").searchParams.get("ref") ?? undefined);
      if (ref) {
        if (method === "POST") {
          grants.add(ref);
          installedByMe.add(ref);
        } else {
          grants.delete(ref);
          installedByMe.delete(ref);
        }
      }
      return Response.json({ ok: true });
    }
    if (path === "/api/knowledge/notebooks") {
      return Response.json({ notebooks: [] });
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

  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    grants,
    release,
    waiting,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

const SKILL_BOX = "安装目录技能 周报";
const TOOL_BOX = "安装工具 Notion/create_page";

test("a listed deployment skill is a box; only the unlisted ones are counted as an administrator's", async () => {
  const { view } = draw();

  await view.findByRole("checkbox", { name: SKILL_BOX });
  expect(
    view.getByRole("heading", { level: 3, name: "目录技能" }),
  ).toBeTruthy();
  // Three deployment skills, one listed: the sentence counts the two that are not.
  await view.findByText(/另有 2 个部署技能由管理员在插件页里授予/);
  expect(view.queryByText(/另有 3 个部署技能/)).toBeNull();
  // An unlisted deployment skill is not offered as a box.
  expect(
    view.queryByRole("checkbox", { name: "安装目录技能 站会" }),
  ).toBeNull();
});

test("ticking a catalogue skill installs it on this coworker, unticking takes it off", async () => {
  const { view, user, grants } = draw();

  const box = await view.findByRole("checkbox", { name: SKILL_BOX });
  expect(box.getAttribute("aria-checked")).toBe("false");
  await user.click(box);

  await waitFor(() =>
    expect(
      view
        .getByRole("checkbox", { name: SKILL_BOX })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(grantCalls()).toEqual([
    {
      method: "POST",
      path: "/api/plugins/grants",
      body: { agentId, kind: "skill", ref: "weekly-report" },
    },
  ]);
  expect([...grants]).toEqual(["weekly-report"]);

  calls.length = 0;
  await user.click(view.getByRole("checkbox", { name: SKILL_BOX }));
  await waitFor(() =>
    expect(
      view
        .getByRole("checkbox", { name: SKILL_BOX })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  expect(grantCalls()).toEqual([
    {
      method: "DELETE",
      path: `/api/plugins/grants?kind=skill&ref=weekly-report&agentId=${agentId}`,
    },
  ]);
  expect([...grants]).toEqual([]);
});

test("a listed app's tools are boxes, with a hint to connect the person's own account", async () => {
  const { view, user, grants } = draw({ held: ["notion/search"] });

  await view.findByRole("heading", { level: 2, name: "可自助安装的工具" });
  const search = await view.findByRole("checkbox", {
    name: "安装工具 Notion/search",
  });
  await waitFor(() => expect(search.getAttribute("aria-checked")).toBe("true"));
  expect(
    view.getByRole("checkbox", { name: TOOL_BOX }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(view.getByText(/这个应用以使用者本人的账号访问/)).toBeTruthy();
  expect(view.getByRole("link", { name: "已连接的账号" })).toBeTruthy();

  await user.click(view.getByRole("checkbox", { name: TOOL_BOX }));
  await waitFor(() =>
    expect(
      view
        .getByRole("checkbox", { name: TOOL_BOX })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(grantCalls()).toEqual([
    {
      method: "POST",
      path: "/api/plugins/grants",
      body: { agentId, kind: "mcp", ref: "notion/create_page" },
    },
  ]);
  expect([...grants].sort()).toEqual(["notion/create_page", "notion/search"]);
});

test("an app nobody listed offers no boxes", async () => {
  const { view } = draw({
    listings: [{ kind: "skill", ref: "weekly-report", listedAt: null }],
  });

  await view.findByText("管理员还没有上架任何应用。");
  expect(view.queryByRole("checkbox", { name: TOOL_BOX })).toBeNull();
});

test("the server's refusal is shown as the server worded it", async () => {
  const { view, user, grants } = draw({ refuse: true });

  await user.click(await view.findByRole("checkbox", { name: TOOL_BOX }));
  expect(await view.findByText(REFUSAL)).toBeTruthy();
  expect(view.getByText(REFUSAL).getAttribute("role")).toBe("alert");
  expect([...grants]).toEqual([]);
});

test("a coworker the viewer cannot manage gets boxes that cannot be ticked", async () => {
  const { view, user } = draw({ profile: { ...base, canManage: false } });

  const skillBox = await view.findByRole("checkbox", { name: SKILL_BOX });
  const toolBox = await view.findByRole("checkbox", { name: TOOL_BOX });
  expect(skillBox.hasAttribute("data-disabled")).toBe(true);
  expect(toolBox.hasAttribute("data-disabled")).toBe(true);

  await user.click(skillBox);
  await user.click(toolBox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(grantCalls()).toEqual([]);
});

test("a team-scoped curated connector is matched to its listing by catalogue key", async () => {
  const { view } = draw({ teamScoped: true });

  // The listing names `notion`; the row is `team:notion`. Matched, its tools are boxes, not "not added".
  await view.findByRole("checkbox", { name: TOOL_BOX });
  expect(view.queryByText(/已上架，但这个部署还没有添加它/)).toBeNull();
  // And the catalogue entry's `user-oauth` is found under the same key.
  expect(view.getByText(/这个应用以使用者本人的账号访问/)).toBeTruthy();
});

test("after an app and a skill are unlisted, what this person installed stays, for taking off only", async () => {
  const { view, user, grants } = draw({
    listings: [],
    // `notion/create_page` was an administrator's grant; the other two this person installed.
    held: ["notion/search", "notion/create_page", "weekly-report"],
    mine: ["notion/search", "weekly-report"],
  });

  const tool = await view.findByRole("checkbox", {
    name: "安装工具 Notion/search",
  });
  const skillBox = await view.findByRole("checkbox", { name: SKILL_BOX });
  await waitFor(() => expect(tool.getAttribute("aria-checked")).toBe("true"));
  expect(skillBox.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(/已下架：你之前装上的工具仍在/)).toBeTruthy();
  // The administrator's grant is not this person's to take off, so it gets no box here.
  expect(view.queryByRole("checkbox", { name: TOOL_BOX })).toBeNull();
  // Unlisted skills nobody installed are still counted as an administrator's.
  await view.findByText(/另有 2 个部署技能由管理员在插件页里授予/);

  await user.click(tool);
  await user.click(view.getByRole("checkbox", { name: SKILL_BOX }));
  await waitFor(() =>
    expect([...grants].sort()).toEqual(["notion/create_page"]),
  );
  expect(grantCalls()).toEqual([
    {
      method: "DELETE",
      path: `/api/plugins/grants?kind=mcp&ref=notion%2Fsearch&agentId=${agentId}`,
    },
    {
      method: "DELETE",
      path: `/api/plugins/grants?kind=skill&ref=weekly-report&agentId=${agentId}`,
    },
  ]);
  // Taken off and unlisted: nothing left to offer.
  await waitFor(() =>
    expect(
      view.queryByRole("checkbox", { name: "安装工具 Notion/search" }),
    ).toBeNull(),
  );
  expect(view.queryByRole("checkbox", { name: SKILL_BOX })).toBeNull();
});

test("every box with a write in flight stays disabled, not only the latest one", async () => {
  const { view, user, release, waiting } = draw({ hold: true });

  const search = await view.findByRole("checkbox", {
    name: "安装工具 Notion/search",
  });
  await user.click(search);
  await waitFor(() => expect(waiting).toHaveLength(1));
  await user.click(view.getByRole("checkbox", { name: TOOL_BOX }));
  await waitFor(() => expect(waiting).toHaveLength(2));

  // The first request is still out, so its box must still refuse a second press.
  expect(
    view
      .getByRole("checkbox", { name: "安装工具 Notion/search" })
      .hasAttribute("data-disabled"),
  ).toBe(true);
  expect(
    view
      .getByRole("checkbox", { name: TOOL_BOX })
      .hasAttribute("data-disabled"),
  ).toBe(true);
  await user.click(
    view.getByRole("checkbox", { name: "安装工具 Notion/search" }),
  );
  expect(grantCalls()).toHaveLength(2);

  release();
  await waitFor(() =>
    expect(
      view
        .getByRole("checkbox", { name: "安装工具 Notion/search" })
        .hasAttribute("data-disabled"),
    ).toBe(false),
  );
  expect(
    view
      .getByRole("checkbox", { name: TOOL_BOX })
      .hasAttribute("data-disabled"),
  ).toBe(false);
});
