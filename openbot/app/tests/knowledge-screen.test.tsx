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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentProfile } from "@/lib/agents/queries";
import { Route as KnowledgeRoute } from "@/routes/_authed/_app/knowledge";
import { settleReactWork } from "./settle-react-work";

/**
 * Story RES1 (D08) at the screen where it is decided: a person creates a knowledge base, keeps
 * Markdown or text in it under the 64K-character cap the server enforces, decides which of their
 * own Wakers may read it, and is told — not overwritten — when somebody else changed it first.
 *
 * The route is the real one. `fetch` is a small in-memory stand-in for `/api/knowledge` that keeps
 * revisions the way the server does, so what is asserted is what the screen sends and how it
 * answers the server's 409, not what this harness happens to return.
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

type FakeSource = {
  id: string;
  title: string;
  kind: string;
  content: string;
  revision: number;
};
type FakeNotebook = {
  id: string;
  title: string;
  revision: number;
  sources: FakeSource[];
  bindings: string[];
};

const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const STAMP = "2026-11-01T00:00:00.000Z";

function profile(id: string, name: string, mine: boolean): AgentProfile {
  return {
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    visibility: mine ? "private" : "public",
    builtIn: true,
    endpoint: null,
    modelRef: null,
    persona: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: mine,
    mine,
  };
}

const AGENTS = [
  profile("waker-reviewer", "小熊审稿", true),
  profile("waker-ops", "小熊运营", true),
  profile("waker-theirs", "别人的熊", false),
];

const chars = (value: string) => [...value].length;

function draw(initial: FakeNotebook[] = []) {
  const state = { notebooks: initial, nextId: 0 };
  const notebookJson = (notebook: FakeNotebook) => ({
    id: notebook.id,
    title: notebook.title,
    revision: notebook.revision,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  const sourceJson = (notebook: FakeNotebook, source: FakeSource) => ({
    id: source.id,
    notebookId: notebook.id,
    title: source.title,
    kind: source.kind,
    digest: null,
    chars: chars(source.content),
    revision: source.revision,
    updatedAt: STAMP,
  });
  const stale = () =>
    Response.json({ error: "内容已被修改，请刷新后再保存。" }, { status: 409 });

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(String(input), "http://openbot.test");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({
      method,
      path: url.pathname,
      ...(body === undefined ? {} : { body }),
    });
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/api/agents")
      return Response.json({ agents: AGENTS });
    if (
      parts[0] !== "api" ||
      parts[1] !== "knowledge" ||
      parts[2] !== "notebooks"
    )
      return Response.json({ error: "Not found" }, { status: 404 });

    const [, , , notebookId, child, childId] = parts;
    if (!notebookId) {
      if (method === "POST") {
        state.nextId += 1;
        const created: FakeNotebook = {
          id: `33333333-3333-4333-8333-${String(state.nextId).padStart(12, "0")}`,
          title: String(body?.title),
          revision: 1,
          sources: [],
          bindings: [],
        };
        state.notebooks.push(created);
        return Response.json(
          { notebook: notebookJson(created) },
          { status: 201 },
        );
      }
      return Response.json({ notebooks: state.notebooks.map(notebookJson) });
    }

    const notebook = state.notebooks.find((entry) => entry.id === notebookId);
    if (!notebook)
      return Response.json({ error: "找不到这个知识库。" }, { status: 404 });

    if (!child) {
      if (method === "PATCH") {
        if (body?.revision !== notebook.revision) return stale();
        notebook.title = String(body?.title);
        notebook.revision += 1;
        return Response.json({ notebook: notebookJson(notebook) });
      }
      if (method === "DELETE") {
        if (body?.revision !== notebook.revision) return stale();
        state.notebooks = state.notebooks.filter((entry) => entry !== notebook);
        return Response.json({
          deleted: true,
          bindingsRemoved: notebook.bindings.length,
        });
      }
      return Response.json({
        notebook: notebookJson(notebook),
        sources: notebook.sources.map((source) => sourceJson(notebook, source)),
        bindings: notebook.bindings.map((agentId) => ({
          agentId,
          notebookId: notebook.id,
          accessMode: "read_only",
          updatedAt: STAMP,
        })),
      });
    }

    if (child === "sources") {
      if (!childId && method === "POST") {
        const content = String(body?.content);
        if (chars(content) > 65_536)
          return Response.json(
            { error: "单个资料最多 64K 字符。" },
            { status: 413 },
          );
        state.nextId += 1;
        const source: FakeSource = {
          id: `44444444-4444-4444-8444-${String(state.nextId).padStart(12, "0")}`,
          title: String(body?.title),
          kind: String(body?.kind),
          content,
          revision: 1,
        };
        notebook.sources.push(source);
        return Response.json(
          { source: { ...sourceJson(notebook, source), content } },
          { status: 201 },
        );
      }
      const source = notebook.sources.find((entry) => entry.id === childId);
      if (!source)
        return Response.json({ error: "找不到这份资料。" }, { status: 404 });
      if (method === "PATCH") {
        if (body?.revision !== source.revision) return stale();
        source.title = String(body?.title);
        source.content = String(body?.content);
        source.revision += 1;
        return Response.json({
          source: { ...sourceJson(notebook, source), content: source.content },
        });
      }
      if (method === "DELETE") {
        notebook.sources = notebook.sources.filter((entry) => entry !== source);
        return new Response(null, { status: 204 });
      }
      return Response.json({
        source: { ...sourceJson(notebook, source), content: source.content },
      });
    }

    if (child === "bindings" && childId) {
      if (method === "PUT") {
        // The server's rule: only the person's own Wakers.
        if (!AGENTS.some((agent) => agent.id === childId && agent.mine))
          return Response.json(
            { error: "只能授权给你自己的 Waker。" },
            { status: 403 },
          );
        if (!notebook.bindings.includes(childId))
          notebook.bindings.push(childId);
        return Response.json({
          binding: {
            agentId: childId,
            notebookId: notebook.id,
            accessMode: "read_only",
            updatedAt: STAMP,
          },
        });
      }
      if (method === "DELETE") {
        const removed = notebook.bindings.includes(childId);
        notebook.bindings = notebook.bindings.filter((id) => id !== childId);
        return Response.json({ removed });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/knowledge"] }),
    routeTree: root.addChildren([
      // `as never`, as in `assemble-install.test.tsx`: the file route is registered in the generated
      // tree under its real parent, and this only re-addresses it for one render.
      KnowledgeRoute.update({
        getParentRoute: () => root,
        path: "/knowledge",
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
    state,
    user: userEvent.setup({ document: view.baseElement.ownerDocument }),
  };
}

function notebook(overrides: Partial<FakeNotebook> = {}): FakeNotebook {
  return {
    id: NOTEBOOK_ID,
    title: "产品手册",
    revision: 1,
    sources: [],
    bindings: [],
    ...overrides,
  };
}

test("creating a knowledge base posts its name and opens it", async () => {
  const { view, user } = draw();

  await view.findByText("还没有知识库");
  await user.type(view.getByLabelText("新知识库名称"), "  产品手册 ");
  await user.click(view.getByRole("button", { name: "新建知识库" }));

  await view.findByRole("heading", { level: 2, name: "产品手册" });
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/knowledge/notebooks",
      body: { title: "产品手册" },
    },
  ]);
  expect(view.queryByText("还没有知识库")).toBeNull();
});

test("the source counter counts characters as the server does and holds back anything over 64K", async () => {
  const { view } = draw([notebook()]);

  const content = await view.findByLabelText("内容");
  const title = view.getByLabelText("资料名称");
  fireEvent.change(title, { target: { value: "安装指南" } });
  const add = () => view.getByRole("button", { name: "添加资料" });

  // An emoji is one character to the server (code points), not two UTF-16 units.
  fireEvent.change(content, { target: { value: "# 标题 😀" } });
  expect(view.getByText("6 / 65,536 字符")).toBeTruthy();
  expect(add().hasAttribute("disabled")).toBe(false);

  // Exactly at the cap is allowed, even though its UTF-16 length is twice that.
  fireEvent.change(content, { target: { value: "😀".repeat(65_536) } });
  expect(view.getByText("65,536 / 65,536 字符")).toBeTruthy();
  expect(add().hasAttribute("disabled")).toBe(false);

  // One over is refused before it ever leaves the browser.
  fireEvent.change(content, { target: { value: "a".repeat(65_537) } });
  expect(
    view.getByText("65,537 / 65,536 字符，超过 64K 上限，请删减后再保存。"),
  ).toBeTruthy();
  expect(add().hasAttribute("disabled")).toBe(true);
  fireEvent.submit(add().closest("form") as HTMLFormElement);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(writes()).toEqual([]);
});

test("a Markdown source is added to the open knowledge base", async () => {
  const { view, user, state } = draw([notebook()]);

  const content = await view.findByLabelText("内容");
  await user.type(view.getByLabelText("资料名称"), "安装指南");
  expect((view.getByLabelText("格式") as HTMLSelectElement).value).toBe(
    "markdown",
  );
  fireEvent.change(content, { target: { value: "# 安装\n\n先装 Bun。" } });
  await user.click(view.getByRole("button", { name: "添加资料" }));

  await view.findByText("安装指南");
  expect(writes()).toEqual([
    {
      method: "POST",
      path: `/api/knowledge/notebooks/${NOTEBOOK_ID}/sources`,
      body: {
        title: "安装指南",
        kind: "markdown",
        content: "# 安装\n\n先装 Bun。",
      },
    },
  ]);
  expect(view.getByText("Markdown · 13 字符")).toBeTruthy();
  expect(state.notebooks[0]?.sources[0]?.kind).toBe("markdown");
});

test("授权给 offers only the person's own Wakers, and ticking grants read-only access", async () => {
  const { view, user, state } = draw([notebook()]);

  const group = await view.findByRole("group", { name: "授权给" });
  await within(group).findByRole("checkbox", { name: "小熊审稿" });
  const boxes = within(group).getAllByRole("checkbox");
  expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual([
    "小熊审稿",
    "小熊运营",
  ]);
  // Somebody else's Waker is not offered at all.
  expect(within(group).queryByText("别人的熊")).toBeNull();

  const reviewer = within(group).getByRole("checkbox", { name: "小熊审稿" });
  expect(reviewer.getAttribute("aria-checked")).toBe("false");
  await user.click(reviewer);
  await waitFor(() =>
    expect(
      within(group)
        .getByRole("checkbox", { name: "小熊审稿" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(writes()).toEqual([
    {
      method: "PUT",
      path: `/api/knowledge/notebooks/${NOTEBOOK_ID}/bindings/waker-reviewer`,
      body: { accessMode: "read_only" },
    },
  ]);
  expect(state.notebooks[0]?.bindings).toEqual(["waker-reviewer"]);

  calls.length = 0;
  await user.click(within(group).getByRole("checkbox", { name: "小熊审稿" }));
  await waitFor(() =>
    expect(
      within(group)
        .getByRole("checkbox", { name: "小熊审稿" })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  expect(writes()).toEqual([
    {
      method: "DELETE",
      path: `/api/knowledge/notebooks/${NOTEBOOK_ID}/bindings/waker-reviewer`,
    },
  ]);
  expect(state.notebooks[0]?.bindings).toEqual([]);
});

test("a rename over somebody else's change says 别人刚改过，已刷新 and shows their version", async () => {
  const { view, user, state } = draw([notebook()]);

  await view.findByRole("heading", { level: 2, name: "产品手册" });
  // Another tab renames it after this one loaded.
  const stored = state.notebooks[0];
  if (!stored) throw new Error("the seeded notebook is missing");
  stored.title = "产品手册（新版）";
  stored.revision = 2;

  const field = view.getByLabelText("名称") as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "我的改名");
  await user.click(view.getByRole("button", { name: "保存名称" }));

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("别人刚改过，已刷新");
  await view.findByRole("heading", { level: 2, name: "产品手册（新版）" });
  await waitFor(() =>
    expect((view.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "产品手册（新版）",
    ),
  );
  // One write, carrying the revision it was drawn from, and no retry over the newer copy.
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: `/api/knowledge/notebooks/${NOTEBOOK_ID}`,
      body: { title: "我的改名", revision: 1 },
    },
  ]);
  expect(stored.title).toBe("产品手册（新版）");
});

test("a stale source edit is refused, refreshed from the server and not retried", async () => {
  const { view, user, state } = draw([
    notebook({
      sources: [
        {
          id: SOURCE_ID,
          title: "安装指南",
          kind: "markdown",
          content: "# 旧内容",
          revision: 1,
        },
      ],
    }),
  ]);

  await user.click(await view.findByRole("button", { name: "编辑 安装指南" }));
  const form = await view.findByRole("form", { name: "编辑资料 安装指南" });
  const editor = within(form).getByLabelText(/内容/) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe("# 旧内容"));

  const source = state.notebooks[0]?.sources[0];
  if (!source) throw new Error("the seeded source is missing");
  source.content = "# 别人写的新内容";
  source.revision = 2;

  fireEvent.change(editor, { target: { value: "# 我的修改" } });
  await user.click(within(form).getByRole("button", { name: "保存资料" }));

  expect((await view.findByRole("alert")).textContent).toBe(
    "别人刚改过，已刷新",
  );
  await waitFor(() =>
    expect(
      (
        within(
          view.getByRole("form", { name: "编辑资料 安装指南" }),
        ).getByLabelText(/内容/) as HTMLTextAreaElement
      ).value,
    ).toBe("# 别人写的新内容"),
  );
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: `/api/knowledge/notebooks/${NOTEBOOK_ID}/sources/${SOURCE_ID}`,
      body: { title: "安装指南", content: "# 我的修改", revision: 1 },
    },
  ]);
  expect(source.content).toBe("# 别人写的新内容");
});

test("deleting a knowledge base asks first and sends the revision it was shown", async () => {
  const { view, user, state } = draw([notebook({ revision: 3 })]);

  await user.click(await view.findByRole("button", { name: "删除知识库" }));
  expect(writes()).toEqual([]);
  await user.click(view.getByRole("button", { name: "确认删除" }));

  await view.findByText("还没有知识库");
  expect(writes()).toEqual([
    {
      method: "DELETE",
      path: `/api/knowledge/notebooks/${NOTEBOOK_ID}`,
      body: { revision: 3 },
    },
  ]);
  expect(state.notebooks).toEqual([]);
});
