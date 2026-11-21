import { expect, test } from "bun:test";
import type { EvalRecord, EvalResults } from "./records";
import { renderReport } from "./report";
import {
  addWallSplits,
  modelSpans,
  stampMs,
  toolSpans,
  unionOf,
  wallSplit,
  wallSplitLine,
} from "./wall-split";

test("stampMs reads numbers, ISO strings and dates, and nothing else", () => {
  expect(stampMs(1500)).toBe(1500);
  expect(stampMs("1970-01-01T00:00:02.000Z")).toBe(2000);
  expect(stampMs(new Date(3000))).toBe(3000);
  expect(stampMs(undefined)).toBeUndefined();
  expect(stampMs("not a time")).toBeUndefined();
  expect(stampMs(Number.NaN)).toBeUndefined();
});

test("unionOf merges overlapping and touching spans, drops empty ones", () => {
  expect(
    unionOf([
      { start: 5, end: 8 },
      { start: 0, end: 3 },
      { start: 2, end: 4 },
      { start: 4, end: 4.5 },
      { start: 9, end: 9 },
    ]),
  ).toEqual([
    { start: 0, end: 4.5 },
    { start: 5, end: 8 },
  ]);
});

test("wallSplit: model, tool and the rest add up to the wall clock", () => {
  const split = wallSplit({
    wallMs: 20_000,
    model: [
      { start: 0, end: 6000 },
      { start: 8000, end: 12_000 },
    ],
    tools: [
      { start: 6000, end: 8000 },
      { start: 12_000, end: 15_000 },
    ],
  });
  expect(split).toEqual({ modelMs: 10_000, toolMs: 5000, otherMs: 5000 });
});

test("wallSplit: tools run in parallel count once, and overlap with the model counts as model", () => {
  const split = wallSplit({
    wallMs: 10_000,
    model: [{ start: 0, end: 4000 }],
    tools: [
      { start: 3000, end: 7000 },
      { start: 4000, end: 6000 },
    ],
  });
  // tool union is 3000-7000 (4 s), 1 s of it is inside the model call
  expect(split).toEqual({ modelMs: 4000, toolMs: 3000, otherMs: 3000 });
});

test("wallSplit: parallel model calls count once; the rest is never negative", () => {
  const split = wallSplit({
    wallMs: 5000,
    model: [
      { start: 0, end: 4000 },
      { start: 1000, end: 6000 },
    ],
    tools: [],
  });
  expect(split.modelMs).toBe(6000);
  expect(split.toolMs).toBe(0);
  expect(split.otherMs).toBe(0);
});

test("wallSplit: a missing source is null, not a made-up number", () => {
  const noTools = wallSplit({
    wallMs: 9000,
    model: [{ start: 0, end: 3000 }],
    tools: undefined,
  });
  // 工具时间拿不到：其余 = 墙钟 − 模型（含工具执行），至少分得出模型和非模型。
  expect(noTools).toEqual({ modelMs: 3000, toolMs: null, otherMs: 6000 });
  const nothing = wallSplit({
    wallMs: 9000,
    model: undefined,
    tools: undefined,
  });
  expect(nothing).toEqual({ modelMs: null, toolMs: null, otherMs: null });
});

test("modelSpans needs every call to have an end time", () => {
  expect(
    modelSpans([
      { startedAt: new Date(1000), observedAt: new Date(3000) },
      {
        startedAt: "1970-01-01T00:00:04.000Z",
        observedAt: "1970-01-01T00:00:05.000Z",
      },
    ]),
  ).toEqual([
    { start: 1000, end: 3000 },
    { start: 4000, end: 5000 },
  ]);
  expect(
    modelSpans([
      { startedAt: new Date(1000), observedAt: new Date(3000) },
      { startedAt: new Date(4000), observedAt: null },
    ]),
  ).toBeUndefined();
  expect(modelSpans([])).toBeUndefined();
});

const ev = (type: string, id: string, timestamp?: unknown) => ({
  type,
  toolCallId: id,
  ...(timestamp === undefined ? {} : { timestamp }),
});

test("toolSpans runs from TOOL_CALL_END to TOOL_CALL_RESULT", () => {
  const found = toolSpans([
    ev("TOOL_CALL_START", "a", 1000),
    ev("TOOL_CALL_END", "a", 1500),
    ev("TOOL_CALL_START", "b", 1100),
    ev("TOOL_CALL_END", "b", 1600),
    ev("TOOL_CALL_RESULT", "a", 4000),
    ev("TOOL_CALL_RESULT", "b", 3000),
  ]);
  expect(found).toEqual({
    exact: true,
    spans: [
      { start: 1500, end: 4000 },
      { start: 1600, end: 3000 },
    ],
  });
});

test("toolSpans falls back to START (inexact) and gives up when a stamp is missing", () => {
  expect(
    toolSpans([
      ev("TOOL_CALL_START", "a", 1000),
      ev("TOOL_CALL_END", "a"),
      ev("TOOL_CALL_RESULT", "a", 2000),
    ]),
  ).toEqual({ exact: false, spans: [{ start: 1000, end: 2000 }] });
  expect(
    toolSpans([
      ev("TOOL_CALL_START", "a"),
      ev("TOOL_CALL_END", "a"),
      ev("TOOL_CALL_RESULT", "a"),
    ]),
  ).toBeUndefined();
  expect(
    toolSpans([
      ev("TOOL_CALL_START", "a", 1000),
      ev("TOOL_CALL_END", "a", 1100),
    ]),
  ).toBeUndefined();
  expect(toolSpans([])).toEqual({ exact: true, spans: [] });
});

test("wallSplitLine and addWallSplits", () => {
  const line = wallSplitLine(
    { modelMs: 10_000, toolMs: null, otherMs: 10_000 },
    20_000,
    7,
  );
  expect(line).toBe(
    "墙钟拆分：总 20.0 s = 模型 10.0 s + 工具 — + 其余（含工具） 10.0 s，步数 7",
  );
  expect(
    addWallSplits(
      { modelMs: 1, toolMs: 2, otherMs: 3 },
      { modelMs: 10, toolMs: null, otherMs: 30 },
    ),
  ).toEqual({ modelMs: 11, toolMs: null, otherMs: 33 });
});

const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "research",
  title: "调研",
  passed: true,
  wallMs: 20_000,
  timedOut: false,
  steps: 9,
  toolCalls: 5,
  modelCalls: 9,
  tokens: { input: 600, output: 60, total: 660, cachedInput: 300 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities: {
    plan: "no",
    planDone: "n/a",
    subagent: "no",
    subagentCount: 0,
    reasoning: "n/a",
    verified: "n/a",
    editTool: "n/a",
    grepTool: "n/a",
    stepLimit: "no",
    autoContinued: "no",
  },
  checks: [],
  ...over,
});

const results = (records: EvalRecord[]): EvalResults => ({
  side: "xiongbao",
  suite: "tasks",
  provider: "custom",
  model: "m",
  baseUrl: null,
  runner: "r",
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("the report shows a wall-clock split table with dashes for what could not be measured", () => {
  const text = renderReport([
    results([
      record({ wallSplit: { modelMs: 10_000, toolMs: null, otherMs: null } }),
    ]),
  ]);
  expect(text).toContain("墙钟拆分（模型时间 / 工具时间 / 其余）");
  expect(text).toContain("10.0 s");
  expect(text).toContain("| 调研 | 20.0 s | 10.0 s | — | — | 9 |");
});

test("no wall-clock split table when no record carries one", () => {
  expect(renderReport([results([record()])])).not.toContain("墙钟拆分");
});
