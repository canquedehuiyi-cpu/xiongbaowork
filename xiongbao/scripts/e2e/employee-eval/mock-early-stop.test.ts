import { expect, test } from "bun:test";
import { serverEnvFrom } from "./config";
import type { MockRequest } from "./mock-model";
import { earlyStopPolicy, earlyStopWanted } from "./mock-early-stop";

/*
 * 本机假模型的「提前收尾」剧本：读了几个文件、列了计划，计划还没做完就说一句话收尾；被提醒（或被评测脚本追
 * 「继续」）之后才动手改文件，改完又不验就收尾；再被提醒才跑校验、把计划打勾。用来在本机看收尾提醒
 * （`XIONGBAO_NUDGE_WHOLE_TURN`、`XIONGBAO_VERIFY_NUDGE`）有没有生效：评测脚本替人发了几次「继续」、改完有没有验证。
 */

const request = (
  messages: { role: string; content?: string }[],
): MockRequest => {
  const users = messages.filter((message) => message.role === "user");
  return {
    protocol: "chat",
    lastUser: users.at(-1)?.content ?? "",
    toolResultsSinceUser: 0,
    offeredTools: ["update_plan"],
    raw: { messages },
  };
};
const tool = () => ({ role: "tool", content: "ok" });
const ask = { role: "user", content: "交代：eval/refactor 里的活做完" };

test("EVAL_MOCK_SCRIPT=early-stop 才打开", () => {
  expect(earlyStopWanted({})).toBe(false);
  expect(earlyStopWanted({ EVAL_MOCK_SCRIPT: "research" })).toBe(false);
  expect(earlyStopWanted({ EVAL_MOCK_SCRIPT: "early-stop" })).toBe(true);
});

test("先列计划并读文件，读完不动手就收尾", () => {
  const first = earlyStopPolicy(request([ask]));
  expect(first.tools?.map((call) => call.name)).toEqual([
    "update_plan",
    "computer_run_command",
  ]);
  const read = earlyStopPolicy(request([ask, tool(), tool()]));
  expect(read.tools?.[0]?.name).toBe("computer_run_command");
  const stop = earlyStopPolicy(request([ask, tool(), tool(), tool(), tool()]));
  expect(stop.tools).toBeUndefined();
  expect(stop.text).toContain("下一步");
});

test("被提醒或被追「继续」之后才改文件，改完不验就收尾，再被提醒才校验", () => {
  const four = [ask, tool(), tool(), tool(), tool()];
  const nudged = (text: string) => [...four, { role: "user", content: text }];
  for (const text of [
    "计划里还有 2 项没做完：改，验",
    "继续完成上面交代的任务",
  ]) {
    const write = earlyStopPolicy(request(nudged(text)));
    expect(write.tools?.[0]?.name).toBe("computer_write_file");
    expect(String(write.tools?.[0]?.arguments.path)).toMatch(/src\/money\.ts$/);
  }
  const written = [...four, tool()];
  expect(earlyStopPolicy(request(written)).text).toContain("重构完成");
  const verify = earlyStopPolicy(
    request([
      ...written,
      { role: "user", content: "你改过 src/money.ts，之后没有跑任何测试" },
    ]),
  );
  expect(verify.tools?.[0]?.name).toBe("computer_run_command");
  expect(String(verify.tools?.[0]?.arguments.command)).toMatch(/test/);
  const done = earlyStopPolicy(request([...written, tool()]));
  expect(done.tools?.[0]?.name).toBe("update_plan");
  expect(earlyStopPolicy(request([...written, tool(), tool()])).text).toContain(
    "全部做完",
  );
});

test("EVAL_SERVER_ENV：只放行 XIONGBAO_ 开头的变量，其余丢掉", () => {
  expect(
    serverEnvFrom(
      "XIONGBAO_VERIFY_NUDGE=off, XIONGBAO_NUDGE_WHOLE_TURN=off,PATH=/evil,bad,XIONGBAO_X=",
    ),
  ).toEqual({
    XIONGBAO_VERIFY_NUDGE: "off",
    XIONGBAO_NUDGE_WHOLE_TURN: "off",
    XIONGBAO_X: "",
  });
  expect(serverEnvFrom(undefined)).toEqual({});
  expect(serverEnvFrom("  ")).toEqual({});
});
