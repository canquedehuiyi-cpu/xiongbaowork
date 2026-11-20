import { expect, test } from "bun:test";
import { boardMockPlan, boardMockWanted, boardPolicy } from "./mock-board";
import type { MockRequest } from "./mock-model";

/*
 * 本机假模型的「看板卡」剧本（`EVAL_MOCK_SCRIPT=board`）：演一个照提示做事的员工，看一张卡从开始到交付要走几次
 * 模型调用。它认的是请求里的系统提示——有没有「接活回执和第一批读取放在同一步」「更新计划和下一步动作放在同一步」
 * 「依赖的命令用 && 合成一条」这几句——有就把对应的几步并成一步，没有就一步一个。所以步数是看产品有没有把这几句话
 * 交到模型手上，而不是剧本里写死的；回退开关关掉哪句，那句对应的步就回来。判分结果不代表能力。
 */

const ACCEPT = "接活回执和第一批读取、命令放在同一步一起发";
const PLAN = "更新计划和下一步动作放在同一步发";
const MERGE = "joined with &&";

const names = (turn: ReturnType<typeof boardPolicy>) =>
  (turn.tools ?? []).map((tool) => tool.name);

/** 一路问下去，直到剧本说话（没有工具调用）：每一步的工具名。 */
function walk(
  system: string,
  offered = ["accept_task", "update_plan", "deliver_task"],
) {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: "【看板派活】标题：写占位文件，工作目录 eval/terminal",
    },
  ];
  const steps: string[][] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const request: MockRequest = {
      protocol: "chat",
      lastUser: String(messages.find((m) => m.role === "user")?.content),
      toolResultsSinceUser: 0,
      offeredTools: offered,
      raw: { messages },
    };
    const turn = boardPolicy(request);
    if (!turn.tools?.length) {
      steps.push(["<text>"]);
      return steps;
    }
    steps.push(names(turn));
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: (turn.tools ?? []).map((tool, index) => ({
        id: `c${steps.length}-${index}`,
        type: "function",
        function: {
          name: tool.name,
          arguments: JSON.stringify(tool.arguments),
        },
      })),
    });
    for (const [index] of (turn.tools ?? []).entries())
      messages.push({
        role: "tool",
        tool_call_id: `c${steps.length}-${index}`,
        content: "ok",
      });
  }
  throw new Error("the script never ended");
}

test("EVAL_MOCK_SCRIPT=board 才打开", () => {
  expect(boardMockWanted({})).toBe(false);
  expect(boardMockWanted({ EVAL_MOCK_SCRIPT: "learn" })).toBe(false);
  expect(boardMockWanted({ EVAL_MOCK_SCRIPT: "board" })).toBe(true);
});

test("提示里一句都没有（回退开关全关）：一步一个，记账步各占一步，交付后还有一句收尾的话", () => {
  expect(walk("你是员工。")).toEqual([
    ["accept_task"],
    ["update_plan"],
    ["computer_run_command"],
    ["computer_write_file"],
    ["computer_run_command"],
    ["update_plan"],
    ["deliver_task"],
    ["<text>"],
  ]);
});

test("只有接活那句：接活和第一批读取同一步发，其余照旧", () => {
  expect(walk(`你是员工。${ACCEPT}`)).toEqual([
    ["accept_task", "computer_run_command"],
    ["update_plan"],
    ["computer_write_file"],
    ["computer_run_command"],
    ["update_plan"],
    ["deliver_task"],
    ["<text>"],
  ]);
});

test("只有计划那句：开头的计划和第一批读取同一步发，收尾的计划和交付同一步发", () => {
  expect(walk(`你是员工。${PLAN}`)).toEqual([
    ["accept_task"],
    ["update_plan", "computer_run_command"],
    ["computer_write_file"],
    ["computer_run_command"],
    ["update_plan", "deliver_task"],
    ["<text>"],
  ]);
});

test("只有合并命令那句：读、写、校验并成一条命令", () => {
  expect(walk(`你是员工。${MERGE}`)).toEqual([
    ["accept_task"],
    ["update_plan"],
    ["computer_run_command"],
    ["update_plan"],
    ["deliver_task"],
    ["<text>"],
  ]);
});

test("三句都有：接活、开头的计划和读写校验一步发完，收尾的计划和交付一步发完", () => {
  expect(walk(`你是员工。${ACCEPT} ${PLAN} ${MERGE}`)).toEqual([
    ["accept_task", "update_plan", "computer_run_command"],
    ["update_plan", "deliver_task"],
    ["<text>"],
  ]);
});

test("手上没有接活、计划、交付工具的员工：只有干活的几步", () => {
  expect(walk("你是员工。", [])).toEqual([
    ["computer_run_command"],
    ["computer_write_file"],
    ["computer_run_command"],
    ["<text>"],
  ]);
});

test("题目目录从交代里认，工具调用的参数带上它", () => {
  const plan = boardMockPlan("eval/refactor", {
    accept: false,
    plan: false,
    merge: false,
    tools: new Set(["accept_task", "update_plan", "deliver_task"]),
  });
  expect(JSON.stringify(plan)).toContain("eval/refactor");
});
