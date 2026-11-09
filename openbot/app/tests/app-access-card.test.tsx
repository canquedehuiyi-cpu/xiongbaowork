import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  AppAccessRequestCard,
  readAppAccessCard,
} from "@/components/channels/app-access-card";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import { writeAppAccessRequestAnswer } from "../../shared/app-access-request";

/**
 * 对话里的「申请访问」卡片：员工调用 `request_app_access` 后，对话记录把它的回答画成一张卡片，写明应用名和
 * 「已向管理员申请访问」或「已有待处理的申请」。申请人可以撤回自己还在等的申请；别人看这段对话时（读不到
 * 这条申请）只看到卡片，没有撤回按钮。
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let status: "pending" | "cancelled" | "approved" | "dismissed" | null =
  "pending";
const sent: { path: string; method: string }[] = [];

beforeEach(() => {
  sent.length = 0;
  status = "pending";
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method === "DELETE") {
        sent.push({ path: url, method: "DELETE" });
        status = "cancelled";
        return Response.json({ request: { status } });
      }
      if (url === "/api/plugins/access-requests/req-1") {
        if (status === null)
          return Response.json({ error: "没有这条申请。" }, { status: 404 });
        return Response.json({ request: { id: "req-1", status } });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const answer = (cardStatus: "created" | "existing") =>
  writeAppAccessRequestAnswer(
    {
      requestId: "req-1",
      appKey: "notion",
      title: "Notion",
      kind: "enable",
      status: cardStatus,
    },
    "已向管理员申请访问：请管理员上架「Notion」。",
  );

function draw(cardStatus: "created" | "existing" = "created") {
  const read = readAppAccessCard("request_app_access", answer(cardStatus));
  if (!read) throw new Error("not a card");
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AppAccessRequestCard {...read} />
    </QueryClientProvider>,
  );
}

test("only request_app_access answers with a card are read as one", () => {
  expect(readAppAccessCard("request_app_access", answer("created"))).not.toBe(
    null,
  );
  // 运行时把字符串编码成 JSON 带过来，也认得出。
  expect(
    readAppAccessCard("request_app_access", JSON.stringify(answer("created"))),
  ).not.toBeNull();
  expect(readAppAccessCard("other_tool", answer("created"))).toBeNull();
  expect(
    readAppAccessCard("request_app_access", "「Notion」已经可以使用了。"),
  ).toBeNull();
});

test("a new request names the app and says it was asked for, and the asker may withdraw it", async () => {
  const view = draw();
  expect(view.getByText("Notion")).toBeTruthy();
  expect(view.getByText("已向管理员申请访问")).toBeTruthy();
  fireEvent.click(await view.findByRole("button", { name: "撤回申请" }));
  await waitFor(() =>
    expect(sent).toEqual([
      { path: "/api/plugins/access-requests/req-1", method: "DELETE" },
    ]),
  );
  await view.findByText("申请已撤回");
  expect(view.queryByRole("button", { name: "撤回申请" })).toBeNull();
});

test("a repeated request says one is already waiting", async () => {
  const view = draw("existing");
  expect(view.getByText("已有待处理的申请")).toBeTruthy();
  await view.findByRole("button", { name: "撤回申请" });
});

test("an answered request says how it was answered, and offers nothing", async () => {
  status = "approved";
  const view = draw();
  await view.findByText("管理员已批准");
  expect(view.queryByRole("button", { name: "撤回申请" })).toBeNull();
});

test("somebody who cannot read the request sees the card without a withdraw button", async () => {
  status = null;
  const view = draw();
  expect(view.getByText("已向管理员申请访问")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.queryByRole("button", { name: "撤回申请" })).toBeNull();
});

test("the transcript draws the tool's answer as the card, not as a tool line", async () => {
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerToolLine
        args="{}"
        name="request_app_access"
        result={JSON.stringify(answer("created"))}
      />
    </QueryClientProvider>,
  );
  expect(view.getByText("Notion")).toBeTruthy();
  expect(view.getByText("已向管理员申请访问")).toBeTruthy();
  // 给模型看的那句话不出现在卡片上。
  expect(view.queryByText(/请管理员上架/)).toBeNull();
  await view.findByRole("button", { name: "撤回申请" });
});
