import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunTimeline } from "@/components/wakerflow/run-timeline";
import { runEventLabel, type WakerFlowRunEvent } from "@/lib/wakerflows";
import { settleReactWork } from "./settle-react-work";

/**
 * WF8-7: a run's event timeline against a stubbed `/events`. What is asserted is what is asked for —
 * each page after the last sequence shown — and what is shown: every event once, in order, in the
 * person's words, with 加载更多 only while there is more.
 */
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
const asked: string[] = [];
afterEach(() => {
  cleanup();
  asked.length = 0;
  globalThis.fetch = originalFetch;
});

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const event = (
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): WakerFlowRunEvent => ({
  sequence,
  type,
  correlationId: `${RUN_ID}:${type}:${sequence}`,
  payload,
  createdAt: new Date("2026-11-04T08:00:00Z").toISOString(),
});

const ALL = [
  event(11, "run_started", { cursor: 0, stepCount: 2 }),
  event(12, "step_started", { index: 0, stepId: "draft" }),
  event(13, "step_done", { index: 0, outputLength: 9 }),
  event(14, "step_parked", { index: 1, waitingOn: "question" }),
  event(15, "step_answered", { index: 1 }),
  event(16, "run_done", {}),
];

/** Pages of the events above, `limit` after `after`, as the server answers them. */
function serve(events: WakerFlowRunEvent[]) {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://openbot.test");
    asked.push(`${url.pathname}?${url.searchParams.toString()}`);
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const rest = events.filter((entry) => entry.sequence > after);
    const page = rest.slice(0, limit);
    return Response.json({
      events: page,
      next: rest.length > limit ? (page.at(-1)?.sequence ?? null) : null,
    });
  }) as typeof fetch;
}

const shownTypes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-event-type]")).map((node) =>
    node.getAttribute("data-event-type"),
  );

test("the timeline reads a page at a time and 加载更多 shows the rest, each event once and in order", async () => {
  serve(ALL);
  const view = render(
    <RunTimeline flowId={FLOW_ID} pageSize={4} runId={RUN_ID} version="a" />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await waitFor(() => expect(shownTypes(view.container)).toHaveLength(4));
  expect(view.getByText("开始运行")).toBeDefined();
  expect(view.getByText("第 2 步等待回答")).toBeDefined();
  await user.click(view.getByRole("button", { name: "加载更多" }));
  await waitFor(() =>
    expect(shownTypes(view.container)).toEqual(ALL.map((entry) => entry.type)),
  );
  expect(view.getByText("第 2 步已回答")).toBeDefined();
  expect(view.getByText("运行完成")).toBeDefined();
  // The last page said there is no more.
  expect(view.queryByRole("button", { name: "加载更多" })).toBeNull();
  expect(asked).toEqual([
    `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}/events?after=0&limit=4`,
    `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}/events?after=14&limit=4`,
  ]);
});

test("while the run goes on, a change reads only what came after the newest event shown", async () => {
  let known = ALL.slice(0, 2);
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://openbot.test");
    asked.push(url.searchParams.get("after") ?? "");
    const after = Number(url.searchParams.get("after") ?? 0);
    return Response.json({
      events: known.filter((entry) => entry.sequence > after),
      next: null,
    });
  }) as typeof fetch;
  const view = render(
    <RunTimeline flowId={FLOW_ID} runId={RUN_ID} version="running:0" />,
  );
  await waitFor(() => expect(shownTypes(view.container)).toHaveLength(2));
  known = ALL;
  view.rerender(
    <RunTimeline flowId={FLOW_ID} runId={RUN_ID} version="done:2" />,
  );
  await waitFor(() =>
    expect(shownTypes(view.container)).toEqual(ALL.map((entry) => entry.type)),
  );
  expect(asked).toEqual(["0", "12"]);
});

test("each kind of event reads as a sentence, and a failure says why", () => {
  expect(runEventLabel(event(1, "run_started", { cursor: 2 }))).toBe(
    "从第 3 步开始运行",
  );
  expect(
    runEventLabel(event(2, "step_parked", { index: 0, waitingOn: "approval" })),
  ).toBe("第 1 步等待审批");
  expect(runEventLabel(event(3, "step_skipped", { index: 1 }))).toBe(
    "第 2 步已跳过",
  );
  expect(
    runEventLabel(event(4, "step_failed", { index: 2, error: "发布接口超时" })),
  ).toBe("第 3 步失败：发布接口超时");
  expect(runEventLabel(event(5, "run_aborted"))).toBe("运行已停止");
  expect(runEventLabel(event(6, "run_retried", { index: 2 }))).toBe(
    "已从第 3 步重试",
  );
});
