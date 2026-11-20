import { expect, test } from "bun:test";
import { bookkeepingOf, bookkeepingShare } from "./bookkeeping";
import type { EvalRecord, EvalResults } from "./records";
import { renderReport } from "./report";

/*
 * 「记账步」：一步里只有 accept_task、update_plan、deliver_task、request_extension 这几个不干实事的工具，
 * 再加上交付被接受之后的那一步（员工多说的一句收尾的话）。它们各自单独占一次模型调用，每次都要把整段历史再发一遍，
 * 所以报告里单独看它们占总步数的比例。读对话快照（AG-UI 的消息）：一条带工具调用的助手消息就是一步。
 */

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const step = (...calls: ReturnType<typeof call>[]) => ({
  id: `a-${calls.map((c) => c.id).join("-") || "text"}`,
  role: "assistant",
  content: "",
  toolCalls: calls,
});
const said = (text: string) => ({ id: `t-${text}`, role: "assistant", content: text });
const result = (id: string, content: string) => ({
  id: `r-${id}`,
  role: "tool",
  toolCallId: id,
  content,
});
const user = { id: "u", role: "user", content: "做这一件事" };
const DELIVERED = JSON.stringify({ delivered: true, taskId: "t" });
const BOUNCED = JSON.stringify({ bounced: true, reason: "缺必需项" });

test("每一类单独数：接活、计划、交付，一步一个；总数是它们之和", () => {
  const messages = [
    user,
    step(call("1", "accept_task")),
    result("1", '{"accepted":true}'),
    step(call("2", "update_plan")),
    result("2", "已更新计划"),
    step(call("3", "computer_run_command")),
    result("3", "ok"),
    step(call("4", "update_plan")),
    result("4", "已更新计划"),
    step(call("5", "deliver_task")),
    result("5", DELIVERED),
    said("做完了。"),
  ];
  expect(bookkeepingOf(messages)).toEqual({
    steps: 7,
    accept: 1,
    plan: 2,
    deliver: 1,
    afterDeliver: 1,
    total: 5,
  });
});

test("和干实事的调用同一步发出的，不算记账步", () => {
  const messages = [
    user,
    step(call("1", "accept_task"), call("2", "computer_read_file")),
    result("1", "{}"),
    result("2", "x"),
    step(call("3", "update_plan"), call("4", "computer_run_command")),
    result("3", "ok"),
    result("4", "ok"),
    step(call("5", "deliver_task")),
    result("5", DELIVERED),
  ];
  expect(bookkeepingOf(messages)).toEqual({
    steps: 3,
    accept: 0,
    plan: 0,
    deliver: 1,
    afterDeliver: 0,
    total: 1,
  });
});

test("接活和计划同一步发（都是记账工具）：算一个记账步，记在接活名下", () => {
  const messages = [
    user,
    step(call("1", "accept_task"), call("2", "update_plan")),
    result("1", "{}"),
    result("2", "ok"),
  ];
  expect(bookkeepingOf(messages)).toMatchObject({
    steps: 1,
    accept: 1,
    plan: 0,
    total: 1,
  });
});

test("交付被挡回的那一步之后的话，不算「交付后一步」", () => {
  const messages = [
    user,
    step(call("5", "deliver_task")),
    result("5", BOUNCED),
    said("缺了必需项，我补上。"),
  ];
  expect(bookkeepingOf(messages)).toMatchObject({
    deliver: 1,
    afterDeliver: 0,
    total: 1,
  });
});

test("交付被接受之后接着又做了事：那一步是干实事的，不算", () => {
  const messages = [
    user,
    step(call("5", "deliver_task")),
    result("5", DELIVERED),
    step(call("6", "computer_run_command")),
    result("6", "ok"),
    said("好了"),
  ];
  expect(bookkeepingOf(messages)).toMatchObject({
    deliver: 1,
    afterDeliver: 0,
  });
});

test("交付被接受之后这一轮直接结束：没有「交付后一步」", () => {
  const messages = [user, step(call("5", "deliver_task")), result("5", DELIVERED)];
  expect(bookkeepingOf(messages)).toEqual({
    steps: 1,
    accept: 0,
    plan: 0,
    deliver: 1,
    afterDeliver: 0,
    total: 1,
  });
});

test("申请延期也是记账步，只记在总数里；读不懂的东西不抛错", () => {
  const messages = [
    user,
    step(call("1", "request_extension")),
    result("1", "{}"),
    null,
    "x",
    { role: "assistant", toolCalls: "bad" },
  ];
  expect(bookkeepingOf(messages as unknown[])).toMatchObject({
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
