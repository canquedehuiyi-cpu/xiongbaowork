/**
 * A memory in 能力与资源 › 信息源与记忆 says who formed it, and offers only what its holder can do.
 *
 * A memory CopilotKit Intelligence holds for the person keeps only its words there: the server can
 * rewrite or forget it, and refuses to pause or confirm it. The card used to offer 停用 and 确认 on
 * it all the same, and both failed. A memory an employee formed names that employee by name.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryCard, memoryStatus } from "@/components/memory/memory-screen";
import type { MemoryRecord } from "@/lib/memory";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

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

const originalFetch = globalThis.fetch;
const sent: { method: string; path: string; body?: unknown }[] = [];
afterEach(() => {
  cleanup();
  queryClient.clear();
  sent.length = 0;
  globalThis.fetch = originalFetch;
});

function serve() {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET")
      sent.push({
        method,
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
    if (path === "/api/agents")
      return Response.json({
        agents: [{ id: "agent-analyst", name: "分析师" }],
      });
    if (path.startsWith("/api/memory/") && method === "DELETE")
      return new Response(null, { status: 204 });
    if (path.startsWith("/api/memory/") && method === "PATCH")
      return Response.json({ memory: {} });
    if (path === "/api/memory") return Response.json({ memories: [] });
    return Response.json({ error: "not faked" }, { status: 404 });
  }) as typeof fetch;
}

const memory = (overrides: Partial<MemoryRecord>): MemoryRecord => ({
  id: "m1",
  content: "我偏好上午开会。",
  provenance: "你告诉员工的",
  sourceId: null,
  enabled: true,
  reviewState: "confirmed",
  formedBy: "person",
  formedByAgentId: null,
  sourceApp: null,
  sourceLink: null,
  observedAt: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

function draw(record: MemoryRecord) {
  serve();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryCard memory={record} />
    </QueryClientProvider>,
  );
}

test("状态行说出记忆是谁记下的、复核到哪一步", () => {
  const bot = memory({
    formedBy: "bot",
    formedByAgentId: "agent-analyst",
    reviewState: "unreviewed",
  });
  expect(memoryStatus(bot, "分析师")).toBe("由 分析师 记下 · 待复核");
  expect(memoryStatus({ ...bot, reviewState: "confirmed" }, "分析师")).toBe(
    "由 分析师 记下",
  );
  expect(memoryStatus(memory({ formedBy: "intelligence" }), "")).toBe(
    "保存在后端",
  );
  expect(memoryStatus(memory({ enabled: false }), "")).toBe("已停用");
  expect(
    memoryStatus(memory({ formedBy: "import", reviewState: "unreviewed" }), ""),
  ).toBe("导入的 · 待复核");
});

test("员工记下的记忆写出那位员工的名字", async () => {
  const view = draw(
    memory({
      formedBy: "bot",
      formedByAgentId: "agent-analyst",
      reviewState: "unreviewed",
    }),
  );
  expect(await view.findByText("由 分析师 记下 · 待复核")).toBeTruthy();
  // Its own review and switch are there.
  expect(view.getByRole("button", { name: "确认" })).toBeTruthy();
  expect(view.getByRole("button", { name: "停用" })).toBeTruthy();
});

test("Intelligence 持有的记忆只有「保存」和「忘掉」，没有停用和确认", async () => {
  const view = draw(
    memory({ id: "held", formedBy: "intelligence", reviewState: "unreviewed" }),
  );
  const card = view.container.querySelector("article") as HTMLElement;
  expect(within(card).getByText("保存在后端")).toBeTruthy();
  const buttons = within(card)
    .getAllByRole("button")
    .map((button) => button.textContent);
  expect(buttons).toEqual(["保存", "忘掉"]);

  // What it does offer still works: an edit is a PATCH of its words, forgetting is a DELETE.
  fireEvent.change(within(card).getByRole("textbox"), {
    target: { value: "我偏好下午开会。" },
  });
  fireEvent.click(within(card).getByRole("button", { name: "保存" }));
  fireEvent.click(within(card).getByRole("button", { name: "忘掉" }));
  await waitFor(() =>
    expect(sent).toEqual(
      expect.arrayContaining([
        {
          method: "PATCH",
          path: "/api/memory/held",
          body: { content: "我偏好下午开会。" },
        },
        { method: "DELETE", path: "/api/memory/held" },
      ]),
    ),
  );
});
