import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import type { QueuedMessage } from "@/components/channels/composer";
import {
  closedVariantOf,
  type TurnClosedVariant,
} from "@/lib/channels/turn-closed";
import { queryClient } from "@/query-client";
import { clearSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/**
 * 本轮收尾的正性终态行（WP-3.2 S1b）：干净结束说「本轮已结束 · 等待你的下一句」，用户按停说
 * 「本轮已由你停止」，子任务交还待批说「有一个命令等你批准」。
 *
 * 钉七件事：干净收尾有话说；空 thread 零噪音；终态行与「思考中」永不同屏；按停不是报错；
 * 交还待批在这段对话里说；这一行不是消息、永不进回传给模型的对话；刷新后除非 run 带着错误收尾，
 * 否则什么都不挂（终态行不承诺跨刷新存活）。
 *
 * 版本判定（lib/channels/turn-closed.ts）与渲染谓词分开钉：判定是纯函数，渲染这一份只管
 * 「给了版本、谓词成立才画」，出错句（Stopped）永远抢先。
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

const CLOSED = "transcript-turn-closed";

/** 一轮说完话的转录：人问一句，员工答一句。 */
function answered(): Message[] {
  return [
    { id: "u1", role: "user", content: "把最近的邮件总结一下。" },
    { id: "a1", role: "assistant", content: "最近三封都是季度数字。" },
  ];
}

/** 子任务交还的结果：shared/subagent.ts 的合同，readSubagentResult 读得出的那一种。 */
const HANDED_BACK = JSON.stringify({
  handedBack: {
    tool: "computer_click",
    args: { selector: "#pay" },
    reason: "needs-approval",
    said: "要付款了，这一步得你点头。",
  },
  next: "Do it yourself in the conversation, where the person is asked.",
  threadId: "11111111-1111-4111-8111-111111111111",
  steps: 3,
});

/** 一轮里派了个子任务、子任务在待批动作前交还的转录。 */
function handedBackTurn(): Message[] {
  return [
    { id: "u1", role: "user", content: "帮我把这单付了。" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-sub",
          type: "function",
          function: {
            name: "run_subagent",
            arguments: JSON.stringify({ task: "走到付款页" }),
          },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "call-sub", content: HANDED_BACK },
    { id: "a2", role: "assistant", content: "我先停在这儿。" },
  ];
}

function transcript(
  messages: Message[],
  opts: {
    busy?: boolean;
    closed?: TurnClosedVariant | null;
    stopped?: string;
    queued?: readonly QueuedMessage[];
  } = {},
) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript messages={messages} restoring={false} {...opts} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("a clean stop says the turn is closed and waits", () => {
  const view = render(transcript(answered(), { closed: "idle" }));
  const line = view.getByTestId(CLOSED);
  expect(line.getAttribute("data-variant")).toBe("idle");
  expect(line.textContent).toContain("本轮已结束");
  expect(line.textContent).toContain("等待你的下一句");
  expect(line.getAttribute("role")).toBe("status");
  // 判定这一份：正常收尾（success 或缺 outcome）就是 idle。
  expect(closedVariantOf(answered(), "success", false)).toBe("idle");
  expect(closedVariantOf(answered(), undefined, false)).toBe("idle");
});

test("an empty thread says nothing", () => {
  // 空 thread：就算版本被置了位也不画——首屏零噪音。
  const view = render(transcript([], { closed: "idle" }));
  expect(view.queryByTestId(CLOSED)).toBeNull();
  // 只有历史行、没有 live 终态事件（closed 未置位）：也不画。
  view.rerender(transcript(answered()));
  expect(view.queryByTestId(CLOSED)).toBeNull();
});

test("the closed line and the thinking line are never on screen together", () => {
  // 忙着：等模型那一格在，终态行不在（就算版本已置位）。
  const view = render(
    transcript([{ id: "u1", role: "user", content: "总结一下。" }], {
      busy: true,
      closed: "idle",
    }),
  );
  expect(view.getByText("思考中")).toBeTruthy();
  expect(view.queryByTestId(CLOSED)).toBeNull();
  // 工具段（stageLine 不画的那一格）也不许漏出来。
  view.rerender(
    transcript(answered(), { busy: true, closed: "idle" }),
  );
  expect(view.queryByTestId(CLOSED)).toBeNull();
  // 收尾：终态行在，「思考中」不在。
  view.rerender(transcript(answered(), { closed: "idle" }));
  expect(view.getByTestId(CLOSED)).toBeTruthy();
  expect(view.queryByText("思考中")).toBeNull();
  // 排队的后续句优先：队列在，终态行让位。
  view.rerender(
    transcript(answered(), {
      closed: "idle",
      queued: [
        { id: "q1", text: "接着做下一件。", commandIds: [], attachments: [] },
      ],
    }),
  );
  expect(view.queryByTestId(CLOSED)).toBeNull();
});

test("a stopped-by-you turn says so, not an error", () => {
  // 判定：只认 "cancelled" 这一个字面值（@ag-ui/core@1.0.2 核过）；别的写法不猜。
  expect(closedVariantOf(answered(), "cancelled", false)).toBe("cancelled");
  expect(closedVariantOf(answered(), "cancel", false)).toBe("idle");
  const view = render(transcript(answered(), { closed: "cancelled" }));
  const line = view.getByTestId(CLOSED);
  expect(line.getAttribute("data-variant")).toBe("cancelled");
  expect(line.textContent).toContain("本轮已由你停止");
  expect(line.textContent).toContain("想继续就说一句。");
  // 不是报错：Stopped 的注意色系与 testid 都不出现。
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(view.container.querySelector(".bg-signal-soft")).toBeNull();
});

test("a hand-back asks for the approval in this conversation", () => {
  // 判定：最后一轮带 handedBack 且没反过来问人 ⇒ awaiting_approval；问了人就不说这句。
  expect(closedVariantOf(handedBackTurn(), "success", false)).toBe(
    "awaiting_approval",
  );
  expect(closedVariantOf(handedBackTurn(), "success", true)).toBe("idle");
  // 优先级：交还待批压过取消（有具体动作待你手）。
  expect(closedVariantOf(handedBackTurn(), "cancelled", false)).toBe(
    "awaiting_approval",
  );
  const view = render(
    transcript(handedBackTurn(), { closed: "awaiting_approval" }),
  );
  const line = view.getByTestId(CLOSED);
  expect(line.getAttribute("data-variant")).toBe("awaiting_approval");
  expect(line.textContent).toContain("有一个命令等你批准");
  expect(line.textContent).toContain("批准后我接着做。");
  // 更早轮交还过、这一轮没有：不该还说「等你批准」。
  const older = [
    ...handedBackTurn(),
    { id: "u2", role: "user" as const, content: "批了，继续。" },
    { id: "a3", role: "assistant" as const, content: "做完了。" },
  ];
  expect(closedVariantOf(older, "success", false)).toBe("idle");
});

test("the closed line is not a message and never reaches the model", () => {
  const messages = answered();
  const before = messages.length;
  const view = render(transcript(messages, { closed: "idle" }));
  const line = view.getByTestId(CLOSED);
  // 设计律（chat-transcript.tsx 的 Stopped 注释）：无 id、不锚定、不是会话行。
  expect(line.hasAttribute("data-message-id")).toBe(false);
  expect(line.hasAttribute("data-scroll-anchor")).toBe(false);
  // 渲染前后 messages 一条不多：这句话不进回传给模型的对话。
  expect(messages.length).toBe(before);
  for (const message of messages)
    expect(JSON.stringify(message)).not.toContain("本轮已结束");
  // 下一轮开始（busy 抬起）即撤，不留到下一轮里。
  view.rerender(transcript(messages, { busy: true, closed: "idle" }));
  expect(view.queryByTestId(CLOSED)).toBeNull();
});

test("a reload shows nothing unless the run stopped with an error", () => {
  // 刷新后：只有历史行，closed 复位（未置位）⇒ 什么都不挂。
  const view = render(transcript(answered()));
  expect(view.queryByTestId(CLOSED)).toBeNull();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  // 上一轮带着错误收尾：重放把 runError 挂回来 ⇒ Stopped 在，终态行永远不与它同屏。
  view.rerender(
    transcript(answered(), {
      closed: "idle",
      stopped: "员工停下了，没有说原因。",
    }),
  );
  expect(view.getByTestId("transcript-stopped")).toBeTruthy();
  expect(view.queryByTestId(CLOSED)).toBeNull();
});