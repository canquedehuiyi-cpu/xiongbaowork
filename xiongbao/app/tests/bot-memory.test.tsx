import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryList } from "@/components/memory/memories";
import { MemoryScreen } from "@/components/memory/memory-screen";
import { MemorySources } from "@/components/memory/sources";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Memory page: the apps that feed it facts, and its background research. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const source = (id: string, agentId: string, title: string) => ({
  id,
  title,
  agentId,
  toolRef: "mcp/drive/search",
  enabled: true,
  syncStatus: "succeeded",
  syncError: null,
  lastSyncAt: null,
});

const research = (id: string, agentId: string, focus: string) => ({
  id,
  agentId,
  channelId: `channel-${agentId}`,
  focus,
  enabled: true,
  intervalMinutes: 240,
  nextRunAt: "2026-10-09T12:00:00Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
});

const requested: string[] = [];
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
/** The settings the Drive search action takes. */
let searchSettings: Record<string, unknown> = {};
function serving() {
  requested.length = 0;
  refuseWrite = null;
  searchSettings = {};
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    if (init?.method && init.method !== "GET") {
      if (refuseWrite) {
        const error = refuseWrite;
        refuseWrite = null;
        return Response.json({ error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
    if (url === "/api/memory/sources") {
      return Response.json({
        sources: [
          source("s1", "expenses", "Receipts folder"),
          source("s2", "knowledge", "Wiki pages"),
        ],
      });
    }
    if (url.startsWith("/api/memory/sources/available/")) {
      return Response.json({
        tools: [
          {
            ref: "mcp/drive/search",
            title: "Search Drive",
            description: "",
            inputSchema: { properties: searchSettings },
          },
        ],
      });
    }
    if (url === "/api/proactive/settings") {
      return Response.json({
        settings: [
          research("p1", "expenses", "Unpaid invoices"),
          research("p2", "knowledge", "Stale pages"),
        ],
        allowed: true,
      });
    }
    if (url.startsWith("/api/channels")) {
      return Response.json({ channels: [], nextCursor: null });
    }
    return Response.json({
      agents: [
        { id: "expenses", name: "Expenses" },
        { id: "knowledge", name: "Knowledge" },
      ],
    });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("only this Bot's sources are listed, and its app actions load without picking a Bot", async () => {
  serving();
  const view = draw(<MemorySources agentId="expenses" />);
  expect(await view.findByText("Receipts folder")).toBeTruthy();
  expect(view.queryByText("Wiki pages")).toBeNull();
  expect(view.queryByRole("combobox", { name: /^员工/ })).toBeNull();
  await waitFor(() =>
    expect(requested).toContain("/api/memory/sources/available/expenses"),
  );
});

test("only this Bot's background research is listed, with no Bot to pick", async () => {
  serving();
  const view = draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(await view.findByText(/Unpaid invoices/)).toBeTruthy();
  expect(view.queryByText(/Stale pages/)).toBeNull();
  expect(view.queryByRole("combobox", { name: /^员工/ })).toBeNull();
});

/** Opens Add source for the Expenses Bot and chooses its one read action. */
async function openAddSource(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document });
  await view.findByText("Receipts folder");
  await user.click(view.getByRole("button", { name: "添加来源" }));
  await user.click(await view.findByRole("combobox", { name: "读取什么" }));
  await user.click(await view.findByRole("option", { name: "Search Drive" }));
  return user;
}

test("an action setting called name is its own field, not the source name", async () => {
  serving();
  searchSettings = { name: { type: "string" } };
  const view = draw(<MemorySources agentId="expenses" />);
  await openAddSource(view);
  const setting = await view.findByLabelText("name");
  expect(setting).not.toBe(view.getByLabelText("来源名称"));
});

test("reopening Add source after a failure keeps the draft but not the failure", async () => {
  serving();
  const view = draw(<MemorySources agentId="expenses" />);
  const user = await openAddSource(view);
  await user.type(view.getByLabelText("来源名称"), "Invoices");
  refuseWrite = "That folder cannot be read.";
  await user.click(view.getByRole("button", { name: "添加并同步来源" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "That folder cannot be read.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: "添加来源" }));
  const name = (await view.findByLabelText("来源名称")) as HTMLInputElement;
  expect(name.value).toBe("Invoices");
  expect(view.queryByRole("alert")).toBeNull();
});

test("reopening a research row after a failure starts without it", async () => {
  serving();
  const view = draw(<ProactiveResearchSettings agentId="expenses" />);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Expenses/ }));
  refuseWrite = "Research is paused.";
  await user.click(await view.findByRole("button", { name: "立即运行" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Research is paused.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: /Expenses/ }));
  await view.findByRole("button", { name: "立即运行" });
  expect(view.queryByRole("alert")).toBeNull();
});

/** 记忆页上的纠正：「纠正」标记和次数，要取代的旧条，以及确认后旧条会被删除。 */
const remembered = (id: string, content: string, extra = {}) => ({
  id,
  content,
  provenance: "对话（自动记下）",
  sourceId: null,
  enabled: true,
  reviewState: "confirmed",
  formedBy: "person",
  formedByAgentId: null,
  sourceApp: null,
  sourceLink: null,
  observedAt: null,
  updatedAt: "2026-11-27T10:00:00Z",
  fromCorrection: false,
  correctionCount: 0,
  replacesId: null,
  ...extra,
});

function servingCorrections() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/memory")
      return Response.json({
        memories: [
          remembered("k1", "周报用 Excel 不用 Word", {
            formedBy: "bot",
            formedByAgentId: "expenses",
            reviewState: "unreviewed",
            fromCorrection: true,
            correctionCount: 2,
            replacesId: "old1",
          }),
          remembered("old1", "周报用 Word 写"),
          remembered("p1", "我偏好上午开会。"),
        ],
      });
    if (url === "/api/memory/sources") return Response.json({ sources: [] });
    if (url === "/api/proactive/settings")
      return Response.json({ settings: [], allowed: true });
    if (url.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({
      agents: [{ id: "expenses", name: "Expenses" }],
      suggestions: [],
    });
  }) as unknown as typeof fetch;
}

for (const [name, node] of [
  ["记忆列表", <MemoryList key="list" />],
  [
    "能力 › 记忆与信息源",
    <MemoryScreen key="screen" onQuery={() => {}} query="" />,
  ],
] as const) {
  test(`${name}：来自纠正的条目带「纠正」标记和次数，写明将取代哪条，确认旁注明旧条会被删除`, async () => {
    servingCorrections();
    const view = draw(node);
    expect(await view.findByText("将取代：周报用 Word 写")).toBeTruthy();
    expect(view.getAllByText("纠正")).toHaveLength(1);
    expect(view.getByText("本人纠正过 2 次")).toBeTruthy();
    expect(view.getAllByText("确认后旧条会被删除")).toHaveLength(1);
    // 不是纠正的条目没有这些。
    expect(view.queryAllByText(/将取代：/)).toHaveLength(1);
  });
}

test("能力 › 记忆与信息源：改过字保存也算确认，「保存」旁同样注明旧条会被删除", async () => {
  servingCorrections();
  const view = draw(<MemoryScreen onQuery={() => {}} query="" />);
  expect(await view.findByText("保存后旧条会被删除")).toBeTruthy();
  expect(view.getAllByText("保存后旧条会被删除")).toHaveLength(1);
});

test("记忆列表：编辑一条待确认的纠正时，对话框的「保存」旁注明旧条会被删除", async () => {
  servingCorrections();
  const view = draw(<MemoryList />);
  await view.findByText("将取代：周报用 Word 写");
  expect(view.queryByText("保存后旧条会被删除")).toBeNull();
  const user = userEvent.setup({ document });
  // 第一条就是那条纠正。
  await user.click(
    view.getAllByRole("button", { name: "编辑" })[0] as HTMLElement,
  );
  expect(await view.findByText("保存后旧条会被删除")).toBeTruthy();
});
