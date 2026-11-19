import { expect, test } from "bun:test";
import { UPDATE_PLAN_TOOL } from "./plan";
import {
  readSubagentResult,
  SUBAGENT_GUIDANCE,
  SUBAGENT_PLAN_GUIDANCE,
  SUBAGENT_TOOL,
  SUBAGENTS_PER_ANSWER,
  subagentGuidance,
  subagentThreadId,
} from "./subagent";

/*
 * The server and the browser find a subagent's thread the same way, from the conversation and the
 * call, so the browser can show its steps before its result exists. Pinned against a thread id this
 * deployment minted (`channels/thread-identity.ts`) and a call id as OpenAI writes one.
 */
const parent = "55569917-dab5-8e00-871d-f32189296876";
const call = "call_Lo8pMYCXoxGTh7qG1TKwnUMB";

test("a subagent's thread is derived, not minted, and is its own", async () => {
  const thread = await subagentThreadId(parent, call);
  expect(await subagentThreadId(parent, call)).toBe(thread);
  expect(await subagentThreadId(parent, "call_other")).not.toBe(thread);
  expect(thread).not.toBe(parent);
  // A version 8 UUID carrying its conversation's deployment fingerprint, as every thread here does.
  expect(thread).toMatch(
    /^55569917-dab5-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("a result is read back from the tool message as the store holds it", () => {
  const stored = JSON.stringify(
    JSON.stringify({ answer: "Healthy.", threadId: "t", steps: 2 }),
  );
  expect(readSubagentResult(stored)).toEqual({
    answer: "Healthy.",
    threadId: "t",
    steps: 2,
  });
  expect(readSubagentResult("Refused. No subagent was started.")).toBeNull();
});

/*
 * How long the run took is counted by the server around the run, so the card can say it for a turn
 * that ended before the person arrived. It is absent on a result written before it was counted, which
 * still has to read; a result carrying something that is not a duration is not this contract at all,
 * and is dropped whole rather than drawn with a clock nobody measured.
 */
test("a result carries its run's duration and still reads without one", () => {
  expect(
    readSubagentResult(
      JSON.stringify({
        answer: "Healthy.",
        threadId: "t",
        steps: 2,
        ms: 1300,
      }),
    ),
  ).toEqual({ answer: "Healthy.", threadId: "t", steps: 2, ms: 1300 });
  for (const ms of ["1300", -1, Number.NaN])
    expect(
      readSubagentResult(
        JSON.stringify({ answer: "Healthy.", threadId: "t", steps: 2, ms }),
      ),
    ).toBeNull();
});

/*
 * 期四：持有 run_subagent 的员工被告知，多部分任务主动委派，而不是先被劝退。
 * 硬约束（每轮上限、不能嵌套、团队成员不是子代理）照写；劝退句不再出现。
 */
test("a Bot holding run_subagent is told to share out a job of independent parts, on its own initiative", () => {
  expect(SUBAGENT_GUIDANCE).toContain("主动委派");
  expect(SUBAGENT_GUIDANCE).toContain("两个以上相互独立的部分");
  expect(SUBAGENT_GUIDANCE).toContain("给每个部分派一个子代理");
  expect(SUBAGENT_GUIDANCE).toContain("并行");
  expect(SUBAGENT_GUIDANCE).toContain("分别调研几家公司");
  expect(SUBAGENT_GUIDANCE).toContain("另派一个子代理做校对");
  expect(SUBAGENT_GUIDANCE).toContain("你自己负责计划、汇总和最后的判断");
  expect(SUBAGENT_GUIDANCE).toContain("一两步就能完成的简单任务自己做，不派");
  // 怎么交代：目标、范围、交回什么。
  expect(SUBAGENT_GUIDANCE).toContain("task 里写目标、范围");
  expect(SUBAGENT_GUIDANCE).toContain("answer 里写明要交回什么、用什么格式");
  // 硬约束是事实，照写。
  expect(SUBAGENT_GUIDANCE).toContain(
    `每轮最多派 ${SUBAGENTS_PER_ANSWER} 个子代理`,
  );
  expect(SUBAGENT_GUIDANCE).toContain("子代理不能再派子代理");
  expect(SUBAGENT_GUIDANCE).toContain("团队成员是独立的数字员工，不是子代理");
  // 不再劝退。
  for (const discouraging of [
    "比自己做慢",
    "优先串行",
    "短小",
    "只在",
    "slower",
    "only when",
  ])
    expect(SUBAGENT_GUIDANCE).not.toContain(discouraging);
});

test("the delegation rule is said only to a Bot holding run_subagent, and the word on plans only with update_plan", () => {
  expect(subagentGuidance([])).toBeUndefined();
  expect(subagentGuidance([UPDATE_PLAN_TOOL])).toBeUndefined();
  expect(subagentGuidance([SUBAGENT_TOOL])).toBe(SUBAGENT_GUIDANCE);
  expect(subagentGuidance([SUBAGENT_TOOL, UPDATE_PLAN_TOOL])).toBe(
    `${SUBAGENT_GUIDANCE}\n\n${SUBAGENT_PLAN_GUIDANCE}`,
  );
  expect(SUBAGENT_PLAN_GUIDANCE).toContain(
    "计划里相互独立的几项可以在同一步里各派一个子代理去做",
  );
  // 计划工具只许一项 in_progress，这里不能教它同时标好几项。
  expect(SUBAGENT_PLAN_GUIDANCE).toContain("同一时间仍最多一项 in_progress");
  // 没有计划工具的员工，不被教用计划工具。
  expect(SUBAGENT_GUIDANCE).not.toContain(UPDATE_PLAN_TOOL);
  expect(SUBAGENT_GUIDANCE).not.toContain("列出计划");
});
