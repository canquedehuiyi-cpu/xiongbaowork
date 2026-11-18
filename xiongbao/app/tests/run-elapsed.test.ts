import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { createRunStageTracker } from "@/lib/channels/run-stage";

/**
 * 这一轮跑了多久的钟（WP-3.2 S1a）。
 *
 * 钉三件事：起点是观测到本轮开始的那一刻、一轮里多个 run 不重置起点、半路接上的轮把起点标成
 * 「观测的」（说话的人据此加「已进行」限定词，不冒充这一轮真实的年龄）。时钟注入，不碰真实时间。
 *
 * 段的语义一个字没改：`stage-progress.test.tsx` 的既有断言原样守着，这里只断钟。
 */

test("the clock starts at the first run and stops at the end of the turn", () => {
  let t = 1_000;
  const tracker = createRunStageTracker(() => t);
  expect(tracker.startedAt()).toBeNull();
  expect(tracker.elapsedAt(3_400)).toBeNull();

  tracker.feed({ type: EventType.RUN_STARTED });
  expect(tracker.startedAt()).toBe(1_000);
  expect(tracker.observedStart()).toBe(false);
  expect(tracker.elapsedAt(3_400)).toBe(2_400);
  // 时钟回拨不报负数。
  expect(tracker.elapsedAt(500)).toBe(0);

  // 收尾时轮已归零（默认的轮计数就是 0）：钟停，起点清掉，下一轮重新起算。
  t = 5_000;
  tracker.feed({ type: EventType.RUN_FINISHED });
  expect(tracker.startedAt()).toBeNull();
  expect(tracker.elapsedAt(6_000)).toBeNull();
});

test("a second run in the same turn does not reset the clock", () => {
  let t = 1_000;
  let turns = 1;
  const tracker = createRunStageTracker(
    () => t,
    () => turns,
  );
  tracker.feed({ type: EventType.RUN_STARTED });
  tracker.feed({ type: EventType.TOOL_CALL_START, toolCallId: "s1" });
  // 浏览器工具的间隙：一个 run 收尾了，轮还在飞——起点留着，不重置。
  t = 5_000;
  tracker.feed({ type: EventType.RUN_FINISHED });
  expect(tracker.startedAt()).toBe(1_000);

  t = 6_000;
  tracker.feed({ type: EventType.RUN_STARTED });
  expect(tracker.startedAt()).toBe(1_000);
  expect(tracker.elapsedAt(7_000)).toBe(6_000);

  // 最后一个 run 收尾时轮还没归零（say 的 finally 还没走）：钟先留着。
  tracker.feed({ type: EventType.RUN_FINISHED });
  expect(tracker.startedAt()).toBe(1_000);
  // 轮归零后调用方收口：钟这才停。
  turns = 0;
  tracker.turnClosed();
  expect(tracker.startedAt()).toBeNull();
  expect(tracker.elapsedAt(9_000)).toBeNull();
});

test("a tracker attached mid-turn marks its start as observed", () => {
  let t = 2_000;
  const tracker = createRunStageTracker(
    () => t,
    () => 1,
  );
  // 半路接上的流：先看到工具在跑，还没听到 RUN_STARTED——起点只能是观测时刻。
  tracker.feed({ type: EventType.TOOL_CALL_START, toolCallId: "s1" });
  expect(tracker.startedAt()).toBe(2_000);
  expect(tracker.observedStart()).toBe(true);

  // RUN_STARTED 后到：不重置起点，也不把「观测的」改成「从头看见的」。
  t = 3_000;
  tracker.feed({ type: EventType.RUN_STARTED });
  expect(tracker.startedAt()).toBe(2_000);
  expect(tracker.observedStart()).toBe(true);
  expect(tracker.elapsedAt(5_000)).toBe(3_000);
});