import { expect, test } from "bun:test";
import { bookkeepingOf, bookkeepingShare } from "./bookkeeping";
import type { EvalRecord, EvalResults } from "./records";
import { renderReport } from "./report";

/*
 * 「记账步」：一步里只有 accept_task、update_plan、deliver_task、request_extension 这几个不干实事的工具，
 * 再加上交付被接受之后的那一步（员工多说的一句收尾的话）。它们各自单独占一次模型调用，每次都要把整段历史再发一遍，
 * 所以报告里单独看它们占总步数的比例。读运行事件（AG-UI）：一步发出的几个调用，结果都在它们全部发出之后。
 * 不读对话快照：服务器把相邻的助手消息合成一条，步和步分不开。
 */

type Event = Record<string, unknown>;
const start = (id: string, name: string): Event => ({
  type: "TOOL_CALL_START",
  toolCallId: id,
  toolCallName: name,
});
const result = (id: string, content: string): Event => ({
  type: "TOOL_CALL_RESULT",
  toolCallId: id,
  content,
});
const said = (id: string, delta: string): Event => ({
  type: "TEXT_MESSAGE_CHUNK",
  messageId: id,
  delta,
});
const runStarted: Event = { type: "RUN_STARTED" };
const runFinished: Event = { type: "RUN_FINISHED" };
const DELIVERED = JSON.stringify({ delivered: true, taskId: "t" });
const BOUNCED = JSON.stringify({ bounced: true, reason: "缺必需项" });
/** 运行把字符串结果存成带引号的 JSON 字符串。 */
const stored = (text: string) => JSON.stringify(text);

test("每一类单独数：接活、计划、交付，一步一个；总数是它们之和", () => {
  const events = [
    runStarted,
    start("1", "accept_task"),
    result("1", '{"accepted":true}'),
    start("2", "update_plan"),
    result("2", "已更新计划"),
    start("3", "computer_run_command"),
    result("3", "ok"),
    start("4", "update_plan"),
    result("4", "已更新计划"),
    start("5", "deliver_task"),
    result("5", DELIVERED),
    said("m", "做完了。"),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toEqual({
    steps: 6,
    accept: 1,
    plan: 2,
    deliver: 1,
    afterDeliver: 1,
    total: 5,
  });
});

test("一步里的几个调用（结果都在它们全部发出之后）算一步；和干实事的调用同一步发出的不算记账步", () => {
  const events = [
    runStarted,
    start("1", "accept_task"),
    start("2", "computer_read_file"),
    result("1", "{}"),
    result("2", "x"),
    start("3", "update_plan"),
    start("4", "computer_run_command"),
    result("3", "ok"),
    result("4", "ok"),
    start("5", "deliver_task"),
    result("5", DELIVERED),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toEqual({
    steps: 3,
    accept: 0,
    plan: 0,
    deliver: 1,
    afterDeliver: 0,
    total: 1,
  });
});

test("接活和计划同一步发（都是记账工具）：算一个记账步，记在接活名下", () => {
  const events = [
    runStarted,
    start("1", "accept_task"),
    start("2", "update_plan"),
    result("1", "{}"),
    result("2", "ok"),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toMatchObject({
    steps: 1,
    accept: 1,
    plan: 0,
    total: 1,
  });
});

test("计划和交付同一步发：记在交付名下", () => {
  const events = [
    runStarted,
    start("1", "update_plan"),
    start("2", "deliver_task"),
    result("1", "ok"),
    result("2", DELIVERED),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toMatchObject({
    steps: 1,
    plan: 0,
    deliver: 1,
    total: 1,
  });
});

test("交付被挡回之后的话，不算「交付后一步」", () => {
  const events = [
    runStarted,
    start("5", "deliver_task"),
    result("5", BOUNCED),
    said("m", "缺了必需项，我补上。"),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toMatchObject({
    deliver: 1,
    afterDeliver: 0,
    total: 1,
  });
});

test("交付被接受之后接着又做了事：那一步是干实事的，不算", () => {
  const events = [
    runStarted,
    start("5", "deliver_task"),
    result("5", DELIVERED),
    said("m1", "再看一眼。"),
    start("6", "computer_run_command"),
    result("6", "ok"),
    said("m2", "好了"),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toMatchObject({
    deliver: 1,
    afterDeliver: 0,
  });
});

test("交付被接受之后这一轮直接结束：没有「交付后一步」", () => {
  const events = [
    runStarted,
    start("5", "deliver_task"),
    result("5", DELIVERED),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toEqual({
    steps: 1,
    accept: 0,
    plan: 0,
    deliver: 1,
    afterDeliver: 0,
    total: 1,
  });
});

test("结果被存成带引号的字符串也认；追「继续」的下一轮从头数，上一轮的交付不带过去", () => {
  const events = [
    runStarted,
    start("5", "deliver_task"),
    result("5", stored(DELIVERED)),
    runFinished,
    runStarted,
    said("m", "我再确认一下。"),
    runFinished,
  ];
  expect(bookkeepingOf(events)).toMatchObject({
    deliver: 1,
    afterDeliver: 0,
  });
  const same = [
    runStarted,
    start("5", "deliver_task"),
    result("5", stored(DELIVERED)),
    said("m", "好了。"),
    runFinished,
  ];
  expect(bookkeepingOf(same)).toMatchObject({ afterDeliver: 1 });
});

test("总步数可以由调用方给（读 model_token_calls 的行数），占比按它算", () => {
  const events = [
    runStarted,
    start("1", "accept_task"),
    result("1", "{}"),
    runFinished,
  ];
  expect(bookkeepingOf(events, { steps: 9 })).toMatchObject({
    steps: 9,
    accept: 1,
    total: 1,
  });
});

test("申请延期也是记账步，只记在总数里；读不懂的东西不抛错", () => {
  const events = [
    runStarted,
    start("1", "request_extension"),
    result("1", "{}"),
    null,
    "x",
    { type: "TOOL_CALL_START" },
    runFinished,
  ];
  expect(bookkeepingOf(events as unknown as Event[])).toMatchObject({
    accept: 0,
    plan: 0,
    deliver: 0,
    total: 1,
  });
  expect(bookkeepingOf([])).toEqual({
    steps: 0,
    accept: 0,
    plan: 0,
    deliver: 0,
    afterDeliver: 0,
    total: 0,
  });
});

test("占比：记账步 ÷ 总步数，取整的百分数；没有步数是「—」", () => {
  expect(
    bookkeepingShare({
      steps: 8,
      accept: 1,
      plan: 2,
      deliver: 1,
      afterDeliver: 1,
      total: 5,
    }),
  ).toBe("63%");
  expect(
    bookkeepingShare({
      steps: 0,
      accept: 0,
      plan: 0,
      deliver: 0,
      afterDeliver: 0,
      total: 0,
    }),
  ).toBe("—");
  expect(bookkeepingShare(undefined)).toBe("—");
});

const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "terminal",
  title: "终端修构建",
  passed: true,
  wallMs: 1000,
  timedOut: false,
  steps: 8,
  toolCalls: 7,
  modelCalls: 8,
  tokens: { input: 600, output: 60, total: 660, cachedInput: 300 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities: {
    plan: "yes",
    planDone: "yes",
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
  callInputs: [100, 200, 300],
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

test("报告多一张「记账步占比」表：接活、计划、交付、交付后一步、占比；旧表不变", () => {
  const markdown = renderReport([
    results([
      record({
        bookkeeping: {
          steps: 8,
          accept: 1,
          plan: 2,
          deliver: 1,
          afterDeliver: 1,
          total: 5,
        },
      }),
    ]),
  ]);
  expect(markdown).toContain("记账步占比");
  expect(markdown).toContain("熊宝接活");
  expect(markdown).toContain("交付后一步");
  expect(markdown).toContain("| 终端修构建 | 8 | 1 | 2 | 1 | 1 | 63% |");
  // 每步输入表还在。
  expect(markdown).toContain("熊宝每步工具调用");
});

test("旧结果文件没有记账步：不多出这张表", () => {
  const markdown = renderReport([results([record()])]);
  expect(markdown).not.toContain("记账步占比");
});
