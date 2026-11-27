import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EventType, type Message } from "@ag-ui/core";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { stepLimitNotes } from "@/components/channels/step-limit-note";
import {
  CONTINUE_TEXT,
  continueAfterStepLimit,
  createStepLimitTracker,
  readStepLimit,
  type StepLimitTracker,
} from "@/lib/channels/step-limit";
import { queryClient } from "@/query-client";
import { STEP_LIMIT_EVENT } from "../../shared/step-limit";
import { settleReactWork } from "./settle-react-work";

/**
 * 员工跑满步数被强制收尾（期一）：最后一轮带 `CUSTOM step-limit {steps}` 时，回答末尾一行「已用完 N 步 · 继续」。
 *
 * 钉四件事：最后一轮有事件才显示；旧轮的事件（回放时一直都在）不显示；员工正在运行时不显示；按「继续」以你的
 * 身份发出「继续」，这一行随即收起。事件按线上的样子喂：实时的一轮和回放的历史都是同一串 AG-UI 事件。
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
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const started = { type: EventType.RUN_STARTED };
const finished = { type: EventType.RUN_FINISHED };
const limit = (steps: number) => ({
  type: EventType.CUSTOM,
  name: STEP_LIMIT_EVENT,
  value: { steps },
});

function feed(tracker: StepLimitTracker, events: object[]) {
  for (const event of events) tracker.feed(event);
}

const messages: Message[] = [
  { id: "u1", role: "user", content: "把三家竞品的报告写完" },
  { id: "a1", role: "assistant", content: "前两家写完了，第三家还没查。" },
];

/** 对话页的接法：追踪器的步数 + 是否在忙，交给转录的附注。 */
function Harness({
  tracker,
  busy,
  send,
}: {
  tracker: StepLimitTracker;
  busy: boolean;
  send: (text: string) => Promise<unknown>;
}) {
  const steps = useSyncExternalStore(
    tracker.listen,
    tracker.steps,
    tracker.steps,
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider>
        <ChatTranscript
          busy={busy}
          messages={messages}
          notes={stepLimitNotes({
            steps,
            busy,
            onContinue: () => continueAfterStepLimit(tracker, send),
          })}
          restoring={false}
        />
      </ChatRuntimeProvider>
    </QueryClientProvider>
  );
}

test("the last run that ran out of steps offers to carry on", async () => {
  const tracker = createStepLimitTracker();
  feed(tracker, [started, limit(80), finished]);
  expect(tracker.steps()).toBe(80);
  const view = render(
    <Harness busy={false} send={async () => ""} tracker={tracker} />,
  );
  expect(await view.findByText(/已用完 80 步/)).toBeTruthy();
  expect(view.getByRole("button", { name: "继续" })).toBeTruthy();
});

test("a step limit from an earlier run is not shown", async () => {
  const tracker = createStepLimitTracker();
  // 回放：第一轮触顶，第二轮好好答完了。
  feed(tracker, [started, limit(80), finished, started, finished]);
  expect(tracker.steps()).toBeNull();
  const view = render(
    <Harness busy={false} send={async () => ""} tracker={tracker} />,
  );
  await view.findByText("前两家写完了，第三家还没查。");
  expect(view.queryByText(/已用完/)).toBeNull();
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
});

test("nothing is offered while the employee is running", async () => {
  const tracker = createStepLimitTracker();
  feed(tracker, [started, limit(80), finished]);
  const view = render(
    <Harness busy={true} send={async () => ""} tracker={tracker} />,
  );
  await view.findByText("前两家写完了，第三家还没查。");
  expect(view.queryByText(/已用完/)).toBeNull();
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
});

test("pressing carry on sends 继续 as the person and the line goes away", async () => {
  const tracker = createStepLimitTracker();
  feed(tracker, [started, limit(80), finished]);
  const sent: string[] = [];
  const view = render(
    <Harness
      busy={false}
      send={async (text) => {
        sent.push(text);
        return "";
      }}
      tracker={tracker}
    />,
  );
  const button = await view.findByRole("button", { name: "继续" });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(sent).toEqual(["继续"]);
  expect(CONTINUE_TEXT).toBe("继续");
  expect(view.queryByText(/已用完/)).toBeNull();
  // 新一轮开始、又跑完没触顶：不会再出现。
  act(() => feed(tracker, [started, finished]));
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
});

test("a carry on that did not go out puts the line back", async () => {
  const tracker = createStepLimitTracker();
  feed(tracker, [started, limit(80), finished]);
  await continueAfterStepLimit(tracker, async () => {
    throw new Error("这位员工还在忙。");
  });
  expect(tracker.steps()).toBe(80);
  // 发出去了、新一轮也开了，之后才失败：那是这一轮自己的失败，不再放回。
  await continueAfterStepLimit(tracker, async () => {
    tracker.feed(started);
    throw new Error("断了");
  });
  expect(tracker.steps()).toBeNull();
});

test("only a well-formed step-limit event is read", () => {
  expect(readStepLimit(STEP_LIMIT_EVENT, { steps: 80 })).toBe(80);
  expect(readStepLimit("delivery.accepted", { steps: 80 })).toBeNull();
  expect(readStepLimit(STEP_LIMIT_EVENT, { steps: "80" })).toBeNull();
  expect(readStepLimit(STEP_LIMIT_EVENT, { steps: 0 })).toBeNull();
  expect(readStepLimit(STEP_LIMIT_EVENT, null)).toBeNull();
});
