import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  type ChatDeliveryEvent,
  readDeliveryEvent,
} from "@/lib/tasks/delivery-chat";
import { EvidenceLine } from "@/routes/_authed/_app/tasks.$taskId";
import { setSkin } from "@/skins/store";
import { DeliveryChatCard } from "@/skins/xiongbao/delivery-chat";
import { settleReactWork } from "./settle-react-work";

/**
 * 交付卡上「工作区文件」那一行的下载按钮：对话里的交付卡和任务页都走普通链接（服务器回附件），
 * 地址按这张卡的范围（`task=`）生成。交付事件没带员工 id（旧事件）就不出按钮，不猜是哪位员工。
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost/" });
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setSkin("xiongbao");
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const TASK = "t1";
const ME = { id: "user-me", email: "me@example.test", name: "我" };

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });
    if (path === "/api/me") return json({ user: ME });
    if (path.startsWith(`/api/tasks/${TASK}`)) return json({}, 404);
    return json({});
  }) as typeof fetch;
}

function withQueries(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

const delivered = (
  files: string[],
  extra: Record<string, unknown> = {},
  over: { agentId?: string } = {},
): ChatDeliveryEvent => ({
  kind: "delivered",
  taskId: TASK,
  deliverable: { kind: "deliverable", workspaceFiles: files, ...extra },
  ...over,
});

const draw = (event: ChatDeliveryEvent) => {
  serve();
  return withQueries(<DeliveryChatCard agentName="小周" event={event} />);
};

test("workspace_file row downloads through its card; no agentId, no button; unverified says 未核实", () => {
  let view = draw(delivered(["reports/a.xlsx"], {}, { agentId: "bot-1" }));
  expect(view.getByRole("link", { name: "下载" }).getAttribute("href")).toBe(
    "/api/computers/bot-1/files/download?path=reports%2Fa.xlsx&task=t1",
  );
  cleanup();

  view = draw(delivered(["reports/a.xlsx"]));
  expect(view.getByText("reports/a.xlsx")).toBeDefined();
  expect(view.queryByRole("link", { name: "下载" })).toBeNull();
  cleanup();

  view = draw(
    delivered(
      ["reports/a.xlsx", "b.md"],
      { unverifiedFiles: ["b.md"] },
      { agentId: "bot-1" },
    ),
  );
  expect(view.getByText("b.md（未核实）")).toBeDefined();
  expect(view.getByText("reports/a.xlsx")).toBeDefined();
  expect(view.getAllByRole("link", { name: "下载" }).length).toBe(2);
});

test("file names with spaces, Chinese, # ? % stay one path in the address", () => {
  const names = [
    "my report.xlsx",
    "报告/对比.xlsx",
    "a#b.md",
    "q?.md",
    "100%.md",
  ];
  const view = draw(delivered(names, {}, { agentId: "bot 1" }));
  const hrefs = view
    .getAllByRole("link", { name: "下载" })
    .map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual([
    "/api/computers/bot%201/files/download?path=my%20report.xlsx&task=t1",
    "/api/computers/bot%201/files/download?path=%E6%8A%A5%E5%91%8A%2F%E5%AF%B9%E6%AF%94.xlsx&task=t1",
    "/api/computers/bot%201/files/download?path=a%23b.md&task=t1",
    "/api/computers/bot%201/files/download?path=q%3F.md&task=t1",
    "/api/computers/bot%201/files/download?path=100%25.md&task=t1",
  ]);
});

test("the delivery event's agentId is read from the stream; an old event without it has none", () => {
  const read = (value: Record<string, unknown>) =>
    readDeliveryEvent("delivery.delivered", {
      taskId: TASK,
      deliverable: null,
      ...value,
    });
  expect(read({ agentId: "bot-1" })).toMatchObject({ agentId: "bot-1" });
  expect(read({})).not.toHaveProperty("agentId");
});

test("task page row uses the card's own employee; none, no button", () => {
  const row = {
    kind: "workspace_file" as const,
    path: "reports/a.xlsx",
    label: "reports/a.xlsx",
    unverified: true,
  };
  const first = render(<EvidenceLine agentId="bot-9" row={row} taskId="t1" />);
  expect(first.getByRole("link", { name: "下载" }).getAttribute("href")).toBe(
    "/api/computers/bot-9/files/download?path=reports%2Fa.xlsx&task=t1",
  );
  expect(first.getByText("工作区文件 · 未核实")).toBeDefined();
  first.unmount();
  const second = render(<EvidenceLine agentId={null} row={row} taskId="t1" />);
  expect(second.queryByRole("link", { name: "下载" })).toBeNull();
});
