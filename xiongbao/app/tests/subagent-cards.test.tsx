import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 子代理卡片（期四）：一步里派出的每个子代理一张卡，并排在同一组里；卡上是任务开头、状态（工作中时转圈、做完了、
 * 没能完成）和耗时，点开看完整任务和它交回的答案。同一个子代理不在别处再画一遍（「用了几个工具」那一行里没有它）。
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

const PARENT = "55569917-dab5-8e00-871d-f32189296876";

const TASKS = {
  a: "调研甲公司的产品定价：列出所有公开套餐、每人每月价格和计费方式，注明来源链接。",
  b: "调研乙公司的产品定价：列出所有公开套餐、每人每月价格和计费方式，注明来源链接。",
  c: "调研丙公司的产品定价：列出所有公开套餐、每人每月价格和计费方式，注明来源链接。",
};

/** 子代理交回的结果，按服务器写的样子再编一次码。 */
const done = (answer: string, ms: number) =>
  JSON.stringify(
    JSON.stringify({ answer, threadId: "sub-thread", steps: 3, ms }),
  );
const failedResult = JSON.stringify(
  JSON.stringify({
    error: "The subagent did not finish: The provider is unavailable.",
    threadId: "sub-thread",
    steps: 1,
    ms: 4_000,
  }),
);

/** 一步里派出三个子代理，`results` 里有的已经交回。 */
function turn(results: Partial<Record<keyof typeof TASKS, string>>): Message[] {
  const ids = Object.keys(TASKS) as (keyof typeof TASKS)[];
  return [
    { id: "ask", role: "user", content: "调研三家竞品的定价" },
    {
      id: "fan-out",
      role: "assistant",
      content: "",
      toolCalls: ids.map((id) => ({
        id: `call-${id}`,
        type: "function" as const,
        function: {
          name: "run_subagent",
          arguments: JSON.stringify({
            task: TASKS[id],
            answer: "一张表：套餐、价格、来源",
          }),
        },
      })),
    },
    ...ids.flatMap((id) => {
      const content = results[id];
      return content === undefined
        ? []
        : [
            {
              id: `result-${id}`,
              role: "tool" as const,
              toolCallId: `call-${id}`,
              content,
            },
          ];
    }),
  ];
}

function draw(messages: Message[], busy: boolean) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider
          agentId="general-assistant"
          threadId={PARENT}
        >
          <ChatTranscript busy={busy} messages={messages} restoring={false} />
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

function card(view: ReturnType<typeof draw>, start: string) {
  const found = [
    ...view.container.querySelectorAll<HTMLElement>("[data-subagent-card]"),
  ].find((one) => one.querySelector("summary")?.textContent?.includes(start));
  if (!found) throw new Error(`no card for ${start}`);
  return found;
}

test("three subagents from one step are three cards in one group: two done, one still working", async () => {
  const view = draw(
    turn({
      a: done("甲：基础版 30 元/人/月，专业版 80 元/人/月。", 12_300),
      b: done("乙：10 人以内 199 元/月。", 9_800),
    }),
    true,
  );
  expect(await view.findByText("正在处理一个子任务…")).toBeTruthy();
  const groups = view.container.querySelectorAll("[data-subagent-cards]");
  expect(groups).toHaveLength(1);
  expect(groups[0]?.querySelectorAll("[data-subagent-card]")).toHaveLength(3);
  // 不在「用了几个工具」那一行里再画一遍。
  expect(view.queryByText(/用了 \d+ 个工具/)).toBeNull();

  const a = within(card(view, "调研甲公司"));
  expect(a.getByText("已完成")).toBeTruthy();
  expect(a.getByText("3 个步骤 · 耗时 12.3 秒")).toBeTruthy();
  expect(
    card(view, "调研甲公司").querySelector("[data-working-spinner]"),
  ).toBeNull();

  const c = card(view, "调研丙公司");
  expect(within(c).getByText("工作中")).toBeTruthy();
  const spinner = c.querySelector("[data-working-spinner]");
  expect(spinner?.getAttribute("class")).toContain("motion-safe:animate-spin");
  // 还在做，说不出用了多久。
  expect(within(c).queryByText(/耗时/)).toBeNull();
});

test("a card's title is the first 30 characters of its task", async () => {
  const view = draw(turn({ a: done("好", 1_000) }), true);
  await view.findByText("正在处理 2 个子任务…");
  const title = [...TASKS.a].slice(0, 30).join("");
  expect(
    within(
      card(view, "调研甲公司").querySelector("summary") as HTMLElement,
    ).getByText(`${title}…`),
  ).toBeTruthy();
});

test("a card opens to its whole task and the answer it handed back", async () => {
  const view = draw(
    turn({
      a: done("甲：基础版 30 元/人/月，专业版 80 元/人/月。", 12_300),
      b: done("乙", 1_000),
      c: done("丙", 1_000),
    }),
    false,
  );
  await view.findByText("执行了 3 个子任务");
  const a = card(view, "调研甲公司") as HTMLDetailsElement;
  expect(a.open).toBe(false);
  a.open = true;
  fireEvent(a, new Event("toggle"));
  const opened = within(a);
  expect(opened.getByText(TASKS.a)).toBeTruthy();
  expect(
    await opened.findByText(/甲：基础版 30 元\/人\/月，专业版 80 元\/人\/月。/),
  ).toBeTruthy();
});

test("a subagent that failed says so on its card", async () => {
  const view = draw(
    turn({ a: done("甲", 1_000), b: done("乙", 1_000), c: failedResult }),
    false,
  );
  await view.findByText("执行了 3 个子任务");
  const c = within(card(view, "调研丙公司"));
  expect(c.getByText(/没能完成 · 耗时 4\.0 秒/)).toBeTruthy();
  expect(c.queryByText("已完成")).toBeNull();
});
