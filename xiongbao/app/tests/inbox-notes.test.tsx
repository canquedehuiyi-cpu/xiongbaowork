import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApprovalDetail } from "@/components/approvals/approval-detail";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { quoteFromSelection } from "@/components/approvals/inbox-notes";
import { settleReactWork } from "./settle-react-work";

/**
 * 审批箱批注（试点，开关 XIONGBAO_PILOT_INBOX_NOTES）。
 * 服务器在 HTTP 边界上造（批注存在内存里，发送清空）；审批箱、审批页和批注面板是真的。
 * 开关没开时：不画任何新元素，也不向批注的地址发任何请求。
 */

type Note = {
  id: string;
  text: string;
  quote?: { text: string; start: number; end: number };
  at: string;
};

let inboxNotes = true;
let notes: Note[] = [];
let calls: { method: string; path: string; body: unknown }[] = [];
let review: unknown = null;
let planQuestion = false;
let originalFetch: typeof fetch;

const QUESTION = {
  id: "q-1",
  botId: "bot-1",
  threadId: "thread-1",
  channelId: "channel-1",
  question: "要不要把导出接口改成异步？",
  why: "改完后调用方要等通知。",
  createdAt: new Date().toISOString(),
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    if (path.startsWith("/api/approvals/items/")) {
      calls.push({ method, path, body });
      if (path.endsWith("/notes/send")) {
        const sent = notes.length;
        notes = [];
        return Response.json({ id: "q-1", sent });
      }
      if (method === "POST") {
        const note = { id: `n-${notes.length + 1}`, at: "now", ...body };
        notes.push(note);
        return Response.json({ note }, { status: 201 });
      }
      if (method === "DELETE") {
        notes = notes.filter((note) => !path.endsWith(`/${note.id}`));
        return Response.json({ removed: true });
      }
      return Response.json({ notes, review });
    }
    if (path === "/api/capabilities")
      return Response.json(inboxNotes ? { inboxNotes: true } : {});
    if (path === "/api/approvals/a-1")
      return Response.json({
        id: "a-1",
        status: "pending",
        decision: null,
        decidedVia: null,
        createdAt: new Date().toISOString(),
        action: {
          botId: "bot-1",
          toolRef: "acp/terminal",
          effect: "write",
          scope: "~/work",
          threadId: "thread-1",
          args: { command: "git push" },
          target: {
            acp: {
              employee: "代码熊",
              action: "运行命令：git push",
              files: [
                "server/src/export.ts",
                "server/tests/export.test.ts",
                "package.json",
              ],
              offerConversation: true,
            },
          },
        },
      });
    if (path === "/api/approvals")
      return Response.json({
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [planQuestion ? { ...QUESTION, plan: true } : QUESTION],
      });
    if (path === "/api/me")
      return Response.json({
        user: {
          id: "me",
          role: "user",
          email: "me@example.test",
          name: "小熊",
        },
      });
    if (path === "/api/agents")
      return Response.json({
        agents: [{ id: "bot-1", name: "代码熊", avatarSeed: "bot-1" }],
      });
    if (path === "/api/computers/host-access")
      return Response.json({ folders: [] });
    throw new Error(`Unexpected fixture request: ${path}`);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  inboxNotes = true;
  notes = [];
  calls = [];
  review = null;
  planQuestion = false;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const inbox = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApprovalInbox waitingOnly />
    </QueryClientProvider>,
  );

function detail() {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/approvals",
    component: () => <ApprovalDetail id="a-1" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/approvals"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** 假的选区：happy-dom 不带选区，用真的 Range 配一个只实现用到的那几项的对象。 */
function selecting(range: Range): Selection {
  return { rangeCount: 1, getRangeAt: () => range } as unknown as Selection;
}

test("开关没开：问题卡上没有批注，也不向批注的地址发请求", async () => {
  inboxNotes = false;
  const { container, findByText } = inbox();
  await findByText(/要不要把导出接口改成异步/);
  // 能力读完之后才下结论：等一个会触发重画的间隙。
  await waitFor(() =>
    expect(container.querySelector("textarea")).not.toBeNull(),
  );
  expect(container.querySelector("[data-inbox-notes]")).toBeNull();
  expect(container.textContent).not.toContain("批注");
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  expect(calls).toEqual([]);
});

test("开关开着，但服务器标明这是等批准的计划：问题卡上不画批注面板，仍有回答框", async () => {
  planQuestion = true;
  const { container, findByText } = inbox();
  await findByText(/要不要把导出接口改成异步/);
  await waitFor(() =>
    expect(container.querySelector("textarea")).not.toBeNull(),
  );
  // 等能力读完再下结论：开关开着时普通提问会画出批注面板，计划不会。
  await settleReactWork();
  expect(container.querySelector("[data-inbox-notes]")).toBeNull();
  expect(container.textContent).not.toContain("批注");
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  expect(calls).toEqual([]);
});

test("开关开着：问题卡上可以连写几条批注，一条带引用，发送后合成一条、问题仍在", async () => {
  const { container, findByLabelText, getByRole, getByText, queryByText } =
    inbox();
  const box = (await findByLabelText("写一条批注")) as HTMLTextAreaElement;

  // 提问类：员工的那一轮已经结束，批注发出去员工不用停下来等；输入框限长与服务器一致。
  expect(container.querySelector("[data-inbox-notes]")?.textContent).toContain(
    "员工不用停下来等",
  );
  expect(box.maxLength).toBe(2000);

  // 先写不带引用的一条。
  fireEvent.change(box, { target: { value: "先说清楚影响哪些调用方" } });
  fireEvent.click(getByRole("button", { name: "添加批注" }));
  await waitFor(() =>
    expect(container.querySelectorAll("[data-note]")).toHaveLength(1),
  );

  // 再选中问题里的一段，引用它写第二条。
  const heading = container.querySelector("h3") as HTMLElement;
  const range = document.createRange();
  // 标题由几段文字拼成（员工名、「问：」、问题），引用要落在问题那一段里。
  const text = [...heading.childNodes].find((node) =>
    node.textContent?.includes("导出接口"),
  ) as Text;
  const at = (text.textContent ?? "").indexOf("导出接口");
  range.setStart(text, at);
  range.setEnd(text, at + 4);
  const original = window.getSelection;
  window.getSelection = () => selecting(range);
  try {
    fireEvent.click(getByRole("button", { name: "引用选中的文字" }));
  } finally {
    window.getSelection = original;
  }
  await waitFor(() =>
    expect(container.querySelector("[data-pending-quote]")?.textContent).toBe(
      "导出接口",
    ),
  );
  fireEvent.change(box, { target: { value: "这里要补测试" } });
  fireEvent.click(getByRole("button", { name: "添加批注" }));
  await waitFor(() =>
    expect(container.querySelectorAll("[data-note]")).toHaveLength(2),
  );
  expect(container.querySelector("blockquote")?.textContent).toBe("导出接口");
  expect(
    calls.filter((call) => call.method === "POST").map((call) => call.body),
  ).toEqual([
    { text: "先说清楚影响哪些调用方" },
    {
      text: "这里要补测试",
      quote: {
        text: "导出接口",
        start: expect.any(Number),
        end: expect.any(Number),
      },
    },
  ]);
  const quoted = calls.filter((call) => call.method === "POST").at(-1)
    ?.body as { quote: { start: number; end: number } };
  expect(quoted.quote.end - quoted.quote.start).toBe(4);

  // 发送：所有批注一次发出，页面说发了几条，问题还在等回答。
  fireEvent.click(getByRole("button", { name: "发送 2 条批注" }));
  await waitFor(() => getByText("已发送 2 条批注，员工会在对话里看到。"));
  expect(
    calls.filter((call) => call.path.endsWith("/notes/send")),
  ).toMatchObject([
    { method: "POST", path: "/api/approvals/items/question/q-1/notes/send" },
  ]);
  expect(container.querySelectorAll("[data-note]")).toHaveLength(0);
  expect(queryByText(/要不要把导出接口改成异步/)).not.toBeNull();
  expect(
    getByRole("button", { name: "发送批注" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("没有批注时发送按钮不能点，空白批注加不进去，写错的批注可以删掉", async () => {
  const { container, findByLabelText, getByRole } = inbox();
  const box = (await findByLabelText("写一条批注")) as HTMLTextAreaElement;
  expect(
    getByRole("button", { name: "发送批注" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(box, { target: { value: "   " } });
  expect(
    getByRole("button", { name: "添加批注" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(box, { target: { value: "写错了" } });
  fireEvent.click(getByRole("button", { name: "添加批注" }));
  await waitFor(() =>
    expect(container.querySelectorAll("[data-note]")).toHaveLength(1),
  );
  fireEvent.click(getByRole("button", { name: "删除第 1 条批注" }));
  await waitFor(() =>
    expect(container.querySelectorAll("[data-note]")).toHaveLength(0),
  );
});

test("没有选中文字就点引用，提示先选一段，不会存下空引用", async () => {
  const { findByRole, getByRole, findByText } = inbox();
  const button = await findByRole("button", { name: "引用选中的文字" });
  const original = window.getSelection;
  window.getSelection = () => ({ rangeCount: 0 }) as unknown as Selection;
  try {
    fireEvent.click(button);
  } finally {
    window.getSelection = original;
  }
  await findByText("先在上面选中想引用的一段文字。");
  expect(getByRole("button", { name: "添加批注" })).toBeTruthy();
});

test("引用只取事项自己的文字，位置按全文算；批注面板里的字、卡片外的字不能引用", () => {
  const card = document.createElement("article");
  card.innerHTML =
    "<h3>代码熊 问：要不要改成异步？</h3><p>改完后调用方要等通知。</p><section data-inbox-notes><p>我写的批注</p></section>";
  document.body.append(card);
  const outside = document.createElement("p");
  outside.textContent = "卡片外面的字";
  document.body.append(outside);
  const pick = (node: Node, from: number, to: number) => {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    return selecting(range);
  };
  const where = card.textContent?.indexOf("调用方") ?? -1;
  const paragraph = card.querySelector("p")?.firstChild as Text;
  const found = quoteFromSelection(card, pick(paragraph, 3, 6));
  expect(found).toEqual({ text: "调用方", start: where, end: where + 3 });
  expect(card.textContent?.slice(found?.start, found?.end)).toBe("调用方");
  expect(
    quoteFromSelection(
      card,
      pick(card.querySelector("section p")?.firstChild as Text, 0, 3),
    ),
  ).toBeNull();
  expect(
    quoteFromSelection(card, pick(outside.firstChild as Text, 0, 3)),
  ).toBeNull();
  expect(quoteFromSelection(card, pick(paragraph, 2, 2))).toBeNull();
  expect(quoteFromSelection(null, pick(paragraph, 0, 3))).toBeNull();
  card.remove();
  outside.remove();
});

test("审批页：代码改动分三章显示，每章一句说明；开关没开时没有", async () => {
  review = [
    {
      id: "core",
      title: "核心改动",
      summary: "先看这里：业务逻辑和功能本身的源码改动。",
      files: ["server/src/export.ts"],
    },
    {
      id: "impact",
      title: "影响",
      summary:
        "再看这里：测试、文档和数据库迁移，说明改动影响到哪、有没有验证。",
      files: ["server/tests/export.test.ts"],
    },
    {
      id: "glue",
      title: "胶水代码",
      summary:
        "最后扫一眼：配置、依赖、入口汇总和生成文件，通常只是把改动接起来。",
      files: ["package.json"],
    },
  ];
  const on = detail();
  await waitFor(() =>
    expect(on.container.querySelectorAll("[data-chapter]")).toHaveLength(3),
  );
  const chapters = [...on.container.querySelectorAll("[data-chapter]")];
  expect(
    chapters.map((chapter) => chapter.getAttribute("data-chapter")),
  ).toEqual(["core", "impact", "glue"]);
  expect(chapters[0]?.textContent).toContain("第 1 章");
  expect(chapters[0]?.textContent).toContain("核心改动");
  expect(chapters[2]?.textContent).toContain("package.json");
  // 审批页上也能写批注；请求要等你决定，所以说明批注什么时候送到，不说员工不用停。
  const panel = on.container.querySelector("[data-inbox-notes]");
  expect(panel).not.toBeNull();
  expect(panel?.textContent).toContain("批注会在你批准或拒绝后送到员工。");
  expect(panel?.textContent).not.toContain("员工不用停下来等");
  cleanup();

  inboxNotes = false;
  calls = [];
  const off = detail();
  await waitFor(() =>
    expect(off.container.textContent).toContain("运行命令：git push"),
  );
  expect(off.container.querySelector("[data-guided-review]")).toBeNull();
  expect(off.container.querySelector("[data-inbox-notes]")).toBeNull();
  expect(calls).toEqual([]);
});

test("不是代码改动（服务器没给分章）时审批页不画引导式评审", async () => {
  review = null;
  const { container } = detail();
  await waitFor(() =>
    expect(container.querySelector("[data-inbox-notes]")).not.toBeNull(),
  );
  expect(container.querySelector("[data-guided-review]")).toBeNull();
});
