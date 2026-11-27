import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 员工的「思考」块（期三）：推理内容（`reasoning` 消息）画在它那一步的回答上方。
 *
 * 钉这几件事：推理消息成为转录里的一项；正在想时标题是「思考中…」、前面转圈，没展开时只露最近两行，展开看全部；
 * 想完折成一行「思考了 N 秒」，点开看完整推理；刷新后回放的只有折起来的一行，量不出用了多久就不说秒数。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname === "/api/approvals")
        return Response.json({
          enabled: false,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setSystemTime();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const ask: Message = {
  id: "u1",
  role: "user",
  content: "调研三家竞品的定价",
};

const THOUGHT = [
  "先弄清楚要比较的维度：套餐、每人每月价格、计费方式。",
  "甲家官网有公开定价页，直接读。",
  "乙家只写了团队价，要换算成每人。",
  "丙家要登录，得找第三方评测。",
].join("\n");

const thinking = (id: string, content: string) =>
  ({ id, role: "reasoning", content }) as unknown as Message;

const answer: Message = {
  id: "a1",
  role: "assistant",
  content: "三家的定价对比如下。",
};

function transcript(messages: Message[], busy: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider>
        <ChatTranscript busy={busy} messages={messages} restoring={false} />
      </ChatRuntimeProvider>
    </QueryClientProvider>
  );
}

const block = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-thinking]") as HTMLElement | null;

test("a reasoning message is an item of the transcript", () => {
  expect(
    toVisibleChatItems([ask, thinking("r1", THOUGHT), answer], {
      reasoning: true,
    }).map((item) => item.kind),
  ).toEqual(["text", "reasoning", "text"]);
  // 空的推理不算一项。
  expect(
    toVisibleChatItems([ask, thinking("r0", "")], { reasoning: true }),
  ).toHaveLength(1);
});

test("while the employee thinks, the block says so with a spinner and shows the latest two lines", async () => {
  const view = render(transcript([ask, thinking("r1", THOUGHT)], true));
  const found = await view.findByText("思考中…");
  const box = block(view);
  expect(box).toBeTruthy();
  expect(found.closest("[data-thinking]")).toBe(box);
  const spinner = box?.querySelector("[data-working-spinner]");
  expect(spinner?.getAttribute("class")).toContain("motion-safe:animate-spin");
  const preview = box?.querySelector("[data-thinking-preview]");
  expect(preview?.textContent).toContain("乙家只写了团队价");
  expect(preview?.textContent).toContain("丙家要登录");
  expect(preview?.textContent).not.toContain("先弄清楚要比较的维度");
  // 展开看全部。
  const details = box?.querySelector("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(box?.textContent).toContain("先弄清楚要比较的维度");
});

test("the block sits above the answer, and once thinking is over it folds to 思考了 N 秒", async () => {
  setSystemTime(new Date("2026-11-19T12:00:00Z"));
  const view = render(transcript([ask, thinking("r2", THOUGHT)], true));
  await view.findByText("思考中…");
  setSystemTime(new Date("2026-11-19T12:00:12Z"));
  await act(async () => {
    view.rerender(transcript([ask, thinking("r2", THOUGHT), answer], false));
  });
  const box = block(view);
  expect(box?.textContent).toContain("思考了 12 秒");
  expect(box?.querySelector("[data-working-spinner]")).toBeNull();
  const details = box?.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  // 块在回答前面。
  const said = view.getByText("三家的定价对比如下。");
  expect(
    (box?.compareDocumentPosition(said) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(box?.textContent).toContain("先弄清楚要比较的维度");
});

test("a replayed thought is folded, and claims no time it never measured", async () => {
  const view = render(
    transcript([ask, thinking("r3", THOUGHT), answer], false),
  );
  await view.findByText("三家的定价对比如下。");
  const box = block(view);
  expect(box?.textContent).toContain("思考过程");
  expect(box?.textContent).not.toMatch(/思考了 \d/);
  expect(box?.textContent).not.toContain("思考中");
  const details = box?.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(box?.textContent).toContain("丙家要登录，得找第三方评测。");
});
