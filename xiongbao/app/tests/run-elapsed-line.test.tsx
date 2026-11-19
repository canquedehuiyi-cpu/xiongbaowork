import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  ChatTranscript,
  type Typist,
} from "@/components/channels/chat-transcript";
import type { RunStage } from "@/lib/channels/run-stage";
import { queryClient } from "@/query-client";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/**
 * 状态行末尾的实时耗时（WP-3.2 S1a）：「思考中 · 已跑 2 分 15 秒」。
 *
 * 钉四件事：正在跑的那一行（等模型、执行工具、输出回答、默认皮肤的「正在输入」）都带着秒数说；
 * 不足一秒一个字不多说；轮收尾秒数跟着那一格一起撤；回放的历史一个数都不显。
 *
 * 秒数是原有文字旁边一个兄弟节点：既有的「思考中」「正在执行工具」「正在输出回答」精确匹配
 * （`stage-progress.test.tsx`）一个字不许动，这里也只按子串认秒数。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // 每一行都问「这个调用在主人在不在」，这里一条也不在。
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
  clearSkin();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const ELAPSED = /已跑|已进行/;

const EMAILS = '{"messages":[{"subject":"Quarterly numbers"}]}';

/** 一次 Gmail 调用，`result` 不给就是还挂着。 */
function step(n: number, tool: string, result?: string): Message[] {
  const id = `call-${n}`;
  return [
    {
      id: `a-${n}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: `mcp__composio-gmail__${tool}`,
            arguments: JSON.stringify({ page: n }),
          },
        },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: `t-${n}`,
            role: "tool" as const,
            toolCallId: id,
            content: result,
          },
        ]),
  ];
}

/** 一次读了四封信、最后一次读 thread：answered 与否跟着 `lastAnswered`。 */
function run(lastAnswered: boolean): Message[] {
  return [
    { id: "u1", role: "user", content: "Summarize my recent unread emails." },
    ...step(1, "GMAIL_FETCH_EMAILS", EMAILS),
    ...step(
      2,
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      lastAnswered ? EMAILS : undefined,
    ),
  ];
}

function transcript(
  messages: Message[],
  busy: boolean,
  opts: {
    stage?: RunStage;
    elapsedMs?: number;
    elapsedObserved?: boolean;
    typist?: Typist;
  } = {},
) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript
          busy={busy}
          messages={messages}
          restoring={false}
          {...opts}
        />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("a working line carries the elapsed time next to the stage word", () => {
  // 等模型：既有那一句一个字不动，秒数在旁边。135000ms = 2 分 15 秒。
  const view = render(
    transcript(run(true), true, { stage: "model", elapsedMs: 135_000 }),
  );
  expect(view.getByText("思考中")).toBeTruthy();
  expect(view.getByText(/已跑 2 分 15 秒/)).toBeTruthy();

  // 输出回答：同一格换了话，秒数跟着。
  view.rerender(
    transcript(run(true), true, { stage: "answer", elapsedMs: 135_000 }),
  );
  expect(view.getByText("正在输出回答")).toBeTruthy();
  expect(view.getByText(/已跑 2 分 15 秒/)).toBeTruthy();

  // 执行工具：等模型那一格这时不画，秒数挂在工具阶段行上——长工具窗口不空白。
  view.rerender(
    transcript(run(false), true, { stage: "tool", elapsedMs: 135_000 }),
  );
  expect(view.getByText("正在执行工具")).toBeTruthy();
  expect(view.getByText(/已跑 2 分 15 秒/)).toBeTruthy();
  expect(view.queryByText("思考中")).toBeNull();

  // 半路接上的轮：量的是我们看到它跑了多久，限定词是「已进行」。
  view.rerender(
    transcript(run(true), true, {
      stage: "model",
      elapsedMs: 135_000,
      elapsedObserved: true,
    }),
  );
  expect(view.getByText(/已进行 2 分 15 秒/)).toBeTruthy();
  expect(view.queryByText(/已跑/)).toBeNull();

  // 默认皮肤：「<员工名> 正在输入」那一行也带着秒数，名字和话一个字不动。
  setSkin("xiongbao");
  view.rerender(
    transcript(run(true), true, {
      elapsedMs: 135_000,
      typist: { name: "雄宝", agentId: "expenses" },
    }),
  );
  expect(view.getByText("雄宝 正在输入")).toBeTruthy();
  expect(view.getByText(/已跑 2 分 15 秒/)).toBeTruthy();
});

test("nothing is said before a second has passed", () => {
  // 不足一秒：防抖，不画一个一闪而过的「0 毫秒」。
  const view = render(
    transcript(run(true), true, { stage: "model", elapsedMs: 400 }),
  );
  expect(view.getByText("思考中")).toBeTruthy();
  expect(view.queryByText(ELAPSED)).toBeNull();
  // 没量出来（没给秒数）：那一格照旧一个字不多。
  view.rerender(transcript(run(true), true, { stage: "model" }));
  expect(view.getByText("思考中")).toBeTruthy();
  expect(view.queryByText(ELAPSED)).toBeNull();
});

test("a finished run stops counting and the closed line speaks", () => {
  const view = render(
    transcript(run(true), true, { stage: "answer", elapsedMs: 135_000 }),
  );
  expect(view.getByText(/已跑 2 分 15 秒/)).toBeTruthy();
  // 轮收尾：秒数跟着那一格一起撤，不留一个还在走的钟。
  view.rerender(transcript(run(true), false));
  expect(view.queryByText(ELAPSED)).toBeNull();
  expect(view.queryByText("正在输出回答")).toBeNull();
  expect(view.queryByText("思考中")).toBeNull();
});

test("replay shows no elapsed time", () => {
  // 回放的历史不带逐事件时间戳：没有起点就没有秒数，不拿存档时间冒充。
  const view = render(transcript(run(true), true));
  expect(view.getByText("思考中")).toBeTruthy();
  expect(view.queryByText(ELAPSED)).toBeNull();
  expect(view.container.querySelector("[data-run-stage]")).toBeNull();
});