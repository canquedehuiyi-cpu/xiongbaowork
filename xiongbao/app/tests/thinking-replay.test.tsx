import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GroupLine } from "@/components/channels/group-chat";
import { reasoningTimesSubscriber } from "@/components/channels/thinking-block";
import type { GroupMessage } from "@/lib/groups";
import { queryClient } from "@/query-client";
import { REASONING_TRUNCATED_NOTE } from "../../shared/thinking";
import { settleReactWork } from "./settle-react-work";

/**
 * 刷新后也说得出想了多久，群聊里也看得到思考（期三后续）。
 *
 * 服务器在推理事件上记下发出的时刻（`timestamp`），回放时这些事件原样再来一遍：对话据此算出每段思考用了多久，
 * 刷新后折起来的那一行照样是「思考了 N 秒」；事件上没有时刻的（期三以前的旧对话）仍是「思考过程」。
 * 群回复行上带着服务器记下的这一轮思考（`reasoning: { text, ms }`），回复上方画同样的折叠块，群里每个人都看得到；
 * 太长被截断的，展开后注明。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const ask: Message = { id: "u1", role: "user", content: "调研三家竞品" };
const answer: Message = { id: "a1", role: "assistant", content: "对比如下。" };
const thinking = (id: string) =>
  ({
    id,
    role: "reasoning",
    content: "先定比较的维度。",
  }) as unknown as Message;

function transcript(messages: Message[]) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider>
        <ChatTranscript busy={false} messages={messages} restoring={false} />
      </ChatRuntimeProvider>
    </QueryClientProvider>
  );
}

/** 回放时连上对话的订阅收到的推理事件，时刻是服务器当时记下的。 */
function replay(messageId: string, start?: number, end?: number) {
  for (const event of [
    {
      type: "REASONING_MESSAGE_START",
      messageId,
      role: "reasoning",
      ...(start === undefined ? {} : { timestamp: start }),
    },
    { type: "REASONING_MESSAGE_CONTENT", messageId, delta: "先定比较的维度。" },
    {
      type: "REASONING_MESSAGE_END",
      messageId,
      ...(end === undefined ? {} : { timestamp: end }),
    },
  ])
    reasoningTimesSubscriber.onEvent({ event });
}

test("a replayed thought whose events carry their moments says how long it took", async () => {
  replay("r-timed", 1_700_000_000_000, 1_700_000_012_000);
  const view = render(transcript([ask, thinking("r-timed"), answer]));
  await view.findByText("对比如下。");
  const box = view.container.querySelector("[data-thinking]");
  expect(box?.textContent).toContain("思考了 12 秒");
  const details = box?.querySelector("details") as HTMLDetailsElement | null;
  expect(details?.open).toBe(false);
});

test("a thought from before the moments were kept still says 思考过程", async () => {
  replay("r-old");
  const view = render(transcript([ask, thinking("r-old"), answer]));
  await view.findByText("对比如下。");
  const box = view.container.querySelector("[data-thinking]");
  expect(box?.textContent).toContain("思考过程");
  expect(box?.textContent).not.toMatch(/思考了 \d/);
});

function groupLine(overrides: Partial<GroupMessage>) {
  const message: GroupMessage = {
    id: "m1",
    channelId: "g1",
    ownerUserId: "someone-else",
    agentId: "ada",
    text: "甲、乙两家查完了。",
    status: "completed",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <GroupLine message={message} mine={false} name="小研" />
    </QueryClientProvider>,
  );
}

test("a group reply carries its thinking above it, folded, for everyone", () => {
  const view = groupLine({
    reasoning: { text: "先查甲家。\n\n再查乙家。", ms: 12_000 },
  });
  const box = view.container.querySelector("[data-thinking]");
  expect(box).toBeTruthy();
  expect(box?.textContent).toContain("思考了 12 秒");
  const details = box?.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  // 在回复上方。
  const said = view.getByText("甲、乙两家查完了。");
  expect(
    (box?.compareDocumentPosition(said) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(box?.textContent).toContain("再查乙家。");
});

test("a group reply's thinking that was cut says so, and one with no time says 思考过程", () => {
  const view = groupLine({
    reasoning: { text: "想了很多。", truncated: true },
  });
  const box = view.container.querySelector("[data-thinking]");
  expect(box?.textContent).toContain("思考过程");
  const details = box?.querySelector("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(box?.textContent).toContain(REASONING_TRUNCATED_NOTE);
});

test("a group reply without thinking draws no block", () => {
  const view = groupLine({});
  expect(view.container.querySelector("[data-thinking]")).toBeNull();
});
