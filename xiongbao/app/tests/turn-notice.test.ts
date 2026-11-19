import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { continueAfterStepLimit } from "@/lib/channels/step-limit";
import {
  createTurnStopTracker,
  readTurnStop,
  turnStopOfText,
  turnStopWords,
} from "@/lib/channels/turn-notice";
import {
  INTERRUPTED_NOTICE,
  SEGMENTS_NOTICE,
  TURN_INTERRUPTED_EVENT,
  TURN_LIMIT_EVENT,
  timeUpNotice,
} from "../../shared/turn-notices";

/**
 * 一轮没做完就停下的三种情形（期九·四）：到点、工具轮数用完、进程中途没了。事件按线上的样子喂（实时的一轮和
 * 回放的历史是同一串 AG-UI 事件），说明那句话也认；只认最后一轮；按「继续」收起、没发出去放回。
 */

const started = { type: EventType.RUN_STARTED };
const custom = (name: string, value: unknown) => ({
  type: EventType.CUSTOM,
  name,
  value,
});

test("the words say which limit it was, and a clock limit says the minutes", () => {
  expect(turnStopWords("time")).toBe("到 25 分钟了");
  expect(turnStopWords("segments")).toBe("步数用完了");
  expect(turnStopWords("interrupted")).toBe("这一轮被打断了");
});

test("the three events are read as what they are, and nothing else is", () => {
  expect(readTurnStop(TURN_LIMIT_EVENT, { reason: "time" })).toBe("time");
  expect(readTurnStop(TURN_LIMIT_EVENT, { reason: "segments" })).toBe(
    "segments",
  );
  expect(readTurnStop(TURN_INTERRUPTED_EVENT, { reason: "restart" })).toBe(
    "interrupted",
  );
  // A reason this page does not know, a shape that is not one, another event's name.
  expect(readTurnStop(TURN_LIMIT_EVENT, { reason: "tokens" })).toBeNull();
  expect(readTurnStop(TURN_LIMIT_EVENT, undefined)).toBeNull();
  expect(readTurnStop("step-limit", { steps: 12 })).toBeNull();
});

test("the sentence the server wrote is read as the same thing, for a thread restored without its events", () => {
  expect(turnStopOfText(INTERRUPTED_NOTICE)).toBe("interrupted");
  expect(turnStopOfText(SEGMENTS_NOTICE)).toBe("segments");
  // Whatever number of minutes the deployment ran the turn under.
  expect(turnStopOfText(timeUpNotice(25))).toBe("time");
  expect(turnStopOfText(timeUpNotice(60))).toBe("time");
  // Words that only look like it are not it.
  expect(turnStopOfText("这一轮已经跑满 25 分钟，我先停在这里。")).toBeNull();
  expect(turnStopOfText("好的，已经做完了。")).toBeNull();
  expect(turnStopOfText(undefined)).toBeNull();
});

test("a turn that hit its clock or its rounds shows a stop, and the next turn clears it", () => {
  const tracker = createTurnStopTracker();
  tracker.feed(started);
  expect(tracker.stop()).toBeNull();
  tracker.feed(custom(TURN_LIMIT_EVENT, { reason: "time" }));
  expect(tracker.stop()).toBe("time");
  tracker.feed(started);
  expect(tracker.stop()).toBeNull();
  tracker.feed(custom(TURN_LIMIT_EVENT, { reason: "segments" }));
  expect(tracker.stop()).toBe("segments");
});

test("a turn that lost its process shows an interruption, replayed after older turns", () => {
  const tracker = createTurnStopTracker();
  // The history replays an older turn that ran into its clock, then the last one, which was cut off.
  tracker.feed(started);
  tracker.feed(custom(TURN_LIMIT_EVENT, { reason: "time" }));
  tracker.feed(started);
  tracker.feed(custom(TURN_INTERRUPTED_EVENT, { reason: "restart" }));
  expect(tracker.stop()).toBe("interrupted");
});

test("the sentence alone is enough when no event was replayed, and goes when the person speaks", () => {
  const tracker = createTurnStopTracker();
  const sentence = { id: "a1", role: "assistant", content: INTERRUPTED_NOTICE };
  tracker.sync([{ id: "u1", role: "user", content: "做" }, sentence]);
  expect(tracker.stop()).toBe("interrupted");
  // The person said 继续: the sentence is no longer the last thing.
  tracker.sync([
    { id: "u1", role: "user", content: "做" },
    sentence,
    { id: "u2", role: "user", content: "继续" },
  ]);
  expect(tracker.stop()).toBeNull();
});

test("an event and its sentence are one stop, not two", () => {
  const tracker = createTurnStopTracker();
  let told = 0;
  tracker.listen(() => {
    told += 1;
  });
  tracker.feed(started);
  tracker.feed(custom(TURN_LIMIT_EVENT, { reason: "segments" }));
  tracker.sync([{ id: "a1", role: "assistant", content: SEGMENTS_NOTICE }]);
  expect(tracker.stop()).toBe("segments");
  expect(told).toBe(1);
});

test("pressing continue puts the line away for good, from the event and from the sentence", async () => {
  const tracker = createTurnStopTracker();
  const sentence = { id: "a1", role: "assistant", content: timeUpNotice(25) };
  tracker.feed(started);
  tracker.feed(custom(TURN_LIMIT_EVENT, { reason: "time" }));
  tracker.sync([sentence]);
  const sent: string[] = [];
  await continueAfterStepLimit(tracker, async (text) => {
    sent.push(text);
  });
  expect(sent).toEqual(["继续"]);
  expect(tracker.stop()).toBeNull();
  // The messages have not caught up yet: the sentence must not bring it back.
  tracker.sync([sentence]);
  expect(tracker.stop()).toBeNull();
});

test("a continue that was not sent puts the line back, unless a new turn began", async () => {
  const tracker = createTurnStopTracker();
  tracker.feed(started);
  tracker.feed(custom(TURN_LIMIT_EVENT, { reason: "time" }));
  await continueAfterStepLimit(tracker, async () => {
    throw new Error("还在忙");
  });
  expect(tracker.stop()).toBe("time");

  const token = tracker.dismiss();
  tracker.feed(started);
  tracker.undismiss(token);
  expect(tracker.stop()).toBeNull();
});
