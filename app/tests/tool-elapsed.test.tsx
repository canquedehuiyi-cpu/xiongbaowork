import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import {
  StepRow,
  type StepDetails,
  ToolActivity,
  type ToolGroup,
} from "../src/components/channels/tool-activity";
import { elapsedWords } from "../src/components/channels/tool-line";
import { queryClient } from "../src/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 一步跑了多久，写在它那一行的末尾。
 *
 * 这个数只有结果自己带了才有（`agent-computer` 量的，见 `tool-activity.ts` 的 `resultFacts`），
 * 所以这一组断言两件事都要钉住：带了就要说出来，没带就一个字也不许多——不许出现「-」「0.0s」这种
 * 占位，也不许把上一段的数留在这一行上。行上那句「退出码 N」是既有文案（同一句也写在
 * `coding-tool-cards.tsx` 与 `computer/terminal-block.tsx`），这里成对锁住，不改动它的写法。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // 折叠起来的那一行会问审批收件箱（`PendingApprovals`），这里一条也不在。
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
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/** 行上的耗时长什么样：秒、一位小数。用来断言「没带就没有」。 */
const DURATION = /\d+(?:\.\d+)?s\b/;

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: string,
): ToolItem {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ...(result === undefined ? {} : { result }),
  };
}

/** 一步的行，耗时可有可无；其余都是最普通的已完成的一步。 */
function spent(elapsedMs: number | undefined): StepDetails {
  return {
    id: "a",
    kind: "tool",
    label: "运行了命令",
    pending: false,
    failed: false,
    refused: false,
    pages: 0,
    inputs: [],
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

function row(step: StepDetails) {
  return render(
    <ol>
      <StepRow active={false} step={step} />
    </ol>,
  );
}

function activity(steps: ToolItem[]) {
  const group: ToolGroup = { id: "g", kind: "tools", steps };
  return render(
    <QueryClientProvider client={queryClient}>
      <ToolActivity active={false} group={group} />
    </QueryClientProvider>,
  );
}

test("one duration, one way of saying it", () => {
  expect(elapsedWords(2400)).toBe("2.4s");
  expect(elapsedWords(900)).toBe("0.9s");
  expect(elapsedWords(0)).toBe("0.0s");
  expect(elapsedWords(65_000)).toBe("65s");
  // 没有量出来、量成负数、量出个无穷：都没有这句话。
  expect(elapsedWords(undefined)).toBe("");
  expect(elapsedWords(-5)).toBe("");
  expect(elapsedWords(Number.NaN)).toBe("");
  expect(elapsedWords(Number.POSITIVE_INFINITY)).toBe("");
});

test("a step that reports how long it took says so on its line", () => {
  const view = row(spent(2400));
  expect(view.getByText("2.4s")).toBeTruthy();
  // 耗时是这一行的第二个事实，不是替掉了别的什么。
  expect(view.getByText("运行了命令")).toBeTruthy();
});

test("a step with no measurement adds neither a duration nor a placeholder", () => {
  const view = row(spent(undefined));
  expect(DURATION.test(view.container.textContent ?? "")).toBe(false);
  expect(view.queryByText("-")).toBeNull();
  expect(view.queryByText("—")).toBeNull();
  expect(view.getByText("运行了命令")).toBeTruthy();
});

test("the measurement comes out of the step's own result", () => {
  // 浏览器的一步：结果是一个 JSON 对象，耗时是 `agent-computer` 写进去的。
  const opened = call(
    "nav",
    "computer_navigate",
    { url: "https://example.com" },
    JSON.stringify({
      elapsedMs: 2400,
      ok: true,
      title: "Example",
      url: "https://example.com",
      visited: true,
    }),
  );
  const view = activity([opened]);
  expect(view.getByText("2.4s")).toBeTruthy();
});

test("a result that carries nothing adds nothing", () => {
  const plain = call(
    "nav",
    "computer_navigate",
    { url: "https://example.com" },
    JSON.stringify({ ok: true, title: "Example", url: "https://example.com" }),
  );
  const view = activity([plain]);
  expect(DURATION.test(view.container.textContent ?? "")).toBe(false);
});

test("a duration and an exit code are said together, and a success says neither", () => {
  const failed: StepDetails = {
    ...spent(2400),
    exitCode: 2,
    failed: true,
  };
  const view = row(failed);
  expect(view.getByText("2.4s")).toBeTruthy();
  // 既有文案：与命令卡片、终端块上的同一句一模一样。
  expect(view.getByText("退出码 2")).toBeTruthy();

  // 结果带着 `exitCode: 0` 但这一步是成功的：退出码是失败那一步的事，成功行上一个字不改。
  const succeeded = row({ ...spent(2400), exitCode: 0 });
  expect(succeeded.queryByText(/退出码/)).toBeNull();
  expect(succeeded.getByText("2.4s")).toBeTruthy();
});
