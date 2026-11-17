import { expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { of } from "rxjs";
import {
  isServerOnlyEvent,
  type RunStage,
  withRunStages,
} from "../src/threads/run-side-events";

/** Only the server puts the delivery loop's cards in a run; one an agent sends is dropped, however spelled. */
test("a delivery.* card is the server's, however it is cased or padded", () => {
  const custom = (name: unknown) =>
    ({ type: EventType.CUSTOM, name, value: {} }) as unknown as BaseEvent;
  for (const name of [
    "delivery.delivered",
    "Delivery.delivered",
    " DELIVERY.accepted",
    "delivery.extension_decided ",
  ])
    expect(isServerOnlyEvent(custom(name))).toBe(true);
  for (const name of ["partner.note", "deliveryman", 3, undefined])
    expect(isServerOnlyEvent(custom(name))).toBe(false);
  expect(
    isServerOnlyEvent({ type: EventType.RUN_STARTED } as unknown as BaseEvent),
  ).toBe(false);
});

/**
 * `run.stage` is what the SERVER marks a turn's boundaries with, and those marks ride the run's own
 * stream — so the forgery gate must leave them alone. Dropping them there would drop the real ones.
 */
test("a stage mark is the run's own event, not a delivery card", () => {
  const stage = (stage: string, seq: number) =>
    ({
      type: EventType.CUSTOM,
      name: "run.stage",
      value: { stage, seq },
    }) as unknown as BaseEvent;
  for (const event of [
    stage("model", 1),
    stage("tool", 2),
    stage("answer", 3),
    // 拼错了也一样：门只认 `delivery.` 前缀，别的名一律放行。
    stage("nonsense", 4),
    {
      type: EventType.CUSTOM,
      name: "RUN.STAGE",
      value: {},
    } as unknown as BaseEvent,
  ])
    expect(isServerOnlyEvent(event)).toBe(false);
});

/** 阶段标记只有这一种读法：`run.stage` 的那两条事件用它，别的一律不算。 */
const isStageMark = (one: BaseEvent): boolean =>
  one.type === EventType.CUSTOM &&
  (one as BaseEvent & { name?: string }).name === "run.stage";

/** 一条 `run.stage` 里报的阶段与序号（只为断言读出来，读不出就当没有）。 */
const stageMark = (one: BaseEvent): { seq: number; stage: RunStage } =>
  (one as BaseEvent & { value: { seq: number; stage: RunStage } }).value;

/**
 * 一轮的阶段边界标成 `run.stage`：RUN_STARTED 之后标「调用模型」，其后每个换阶段的事件前标一条，同一个阶段
 * 连着出现只标第一次。工具答完话把这一轮交回模型，那也是一次真实的换段；五条结果连着回来只标一次。
 * `seq` 数的是这一轮里第几次标（一轮就是一条流），从 1 起。
 */
test("a turn's stages are marked once each, in order, at the event that begins them", () => {
  const event = (type: EventType) => ({ type }) as unknown as BaseEvent;
  const events = [
    event(EventType.RUN_STARTED),
    event(EventType.TOOL_CALL_START),
    event(EventType.TOOL_CALL_ARGS),
    event(EventType.TOOL_CALL_END),
    // 两条工具连着答完：回到模型，只标一次。
    event(EventType.TOOL_CALL_RESULT),
    event(EventType.TOOL_CALL_RESULT),
    // 模型又开了一步：这才再标执行工具。
    event(EventType.TOOL_CALL_START),
    event(EventType.TOOL_CALL_END),
    event(EventType.TOOL_CALL_RESULT),
    event(EventType.TEXT_MESSAGE_START),
    event(EventType.TEXT_MESSAGE_CONTENT),
    event(EventType.RUN_FINISHED),
  ];
  const seen: BaseEvent[] = [];
  // `of` 同步发完，订阅里就把这一轮走完：不需要等，也不需要造一个结束事件。
  withRunStages(of(...events)).subscribe((emitted) => seen.push(emitted));
  const marked = seen.filter(isStageMark).map(stageMark);
  expect(marked.map((one) => [one.stage, one.seq])).toEqual([
    ["model", 1],
    ["tool", 2],
    ["model", 3],
    ["tool", 4],
    ["model", 5],
    ["answer", 6],
  ]);
  // 标记插在它开始的那个事件前面，原来的事件一个不少、顺序不动；开头那条跟在 RUN_STARTED 后面。
  expect(seen.map((one) => one.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.CUSTOM,
    EventType.CUSTOM,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.CUSTOM,
    EventType.TOOL_CALL_RESULT,
    EventType.TOOL_CALL_RESULT,
    EventType.CUSTOM,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_END,
    EventType.CUSTOM,
    EventType.TOOL_CALL_RESULT,
    EventType.CUSTOM,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.RUN_FINISHED,
  ]);
});

/** 一轮里只发文字、一步没走：标开头那条「调用模型」，再加开始作答那一条，中间的事件都不另标。 */
test("a turn that only answers is marked at its two boundaries", () => {
  const event = (type: EventType) => ({ type }) as unknown as BaseEvent;
  const seen: BaseEvent[] = [];
  withRunStages(
    of(
      event(EventType.RUN_STARTED),
      event(EventType.TEXT_MESSAGE_START),
      event(EventType.TEXT_MESSAGE_CONTENT),
      event(EventType.TEXT_MESSAGE_END),
      event(EventType.RUN_FINISHED),
    ),
  ).subscribe((emitted) => seen.push(emitted));
  expect(seen.filter(isStageMark)).toEqual([
    {
      type: EventType.CUSTOM,
      name: "run.stage",
      value: { stage: "model", seq: 1 },
    },
    {
      type: EventType.CUSTOM,
      name: "run.stage",
      value: { stage: "answer", seq: 2 },
    },
  ]);
});

