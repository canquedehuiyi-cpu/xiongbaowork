import { describe, expect, test } from "bun:test";
import {
  fastPathBounceReason,
  fastPathCheckGateOn,
  noteAttachedFastPath,
  uncheckedFastPath,
} from "../src/tasks/fastpath-gate";

const CHECK = "python3 check_summary.py <dir>/out/summary.json";

const user = { role: "user", content: "把这个月的账单汇总一下" };
const run = (id: string, command: string) => ({
  role: "assistant",
  toolCalls: [
    {
      id,
      function: {
        name: "computer_run_command",
        arguments: JSON.stringify({ command }),
      },
    },
  ],
});
const result = (id: string, content = "ok") => ({
  role: "tool",
  toolCallId: id,
  content,
});
const read = (id: string) => ({
  role: "assistant",
  toolCalls: [
    { id, function: { name: "read_skill", arguments: '{"id":"auto-x"}' } },
  ],
});
const skillText = `### 汇总账单 (id: auto-x)\n\n快路径（做过的做法）：\n python3 sum.py\n快路径校验命令：${CHECK}\n`;

let counter = 0;
const fresh = () => `run-fp-${counter++}`;

describe("用了技能快路径，交付前要跑过核对命令", () => {
  test("开头附了快路径、没跑核对：挡回，原因里带命令", () => {
    const runId = fresh();
    noteAttachedFastPath(runId, [CHECK]);
    const checks = uncheckedFastPath({
      runId,
      messages: [user, run("c1", "python3 sum.py /work")],
    });
    expect(checks).toEqual([CHECK]);
    expect(fastPathBounceReason(checks ?? [])).toContain(`「${CHECK}」`);
  });

  test("跑过核对（目录换成实际的、带 cd 前缀）：放行", () => {
    const runId = fresh();
    noteAttachedFastPath(runId, [CHECK]);
    expect(
      uncheckedFastPath({
        runId,
        messages: [
          user,
          run(
            "c1",
            "cd /work && python3 check_summary.py /work/out/summary.json | tail -3",
          ),
          result("c1"),
        ],
      }),
    ).toBeUndefined();
  });

  test("员工 read_skill 读了带核对命令的技能：同样要核对", () => {
    const runId = fresh();
    const messages = [user, read("r1"), result("r1", skillText)];
    expect(uncheckedFastPath({ runId, messages })).toEqual([CHECK]);
    expect(
      uncheckedFastPath({
        runId,
        messages: [
          ...messages,
          run("c2", `python3 "check_summary.py" /tmp/o/out/summary.json`),
        ],
      }),
    ).toBeUndefined();
  });

  test("挡回过一次之后再交：放行，不管跑没跑", () => {
    const runId = fresh();
    noteAttachedFastPath(runId, [CHECK]);
    const bounced = JSON.stringify({
      bounced: true,
      fastPathCheckBounce: true,
    });
    expect(
      uncheckedFastPath({
        runId,
        messages: [
          user,
          { role: "assistant", toolCalls: [] },
          result("d1", bounced),
        ],
      }),
    ).toBeUndefined();
  });

  test("上一轮挡回过不算这一轮：新的用户消息之后重新算", () => {
    const runId = fresh();
    noteAttachedFastPath(runId, [CHECK]);
    const bounced = JSON.stringify({
      bounced: true,
      fastPathCheckBounce: true,
    });
    expect(
      uncheckedFastPath({
        runId,
        messages: [user, result("d1", bounced), user, run("c1", "ls")],
      }),
    ).toEqual([CHECK]);
  });

  test("没用技能、技能没有核对命令、开关 off：照旧", () => {
    expect(
      uncheckedFastPath({ runId: fresh(), messages: [user, run("c1", "ls")] }),
    ).toBeUndefined();
    noteAttachedFastPath("run-none", []);
    expect(
      uncheckedFastPath({ runId: "run-none", messages: [user] }),
    ).toBeUndefined();
    expect(
      uncheckedFastPath({
        runId: fresh(),
        messages: [user, read("r1"), result("r1", "### x\n没有快路径\n")],
      }),
    ).toBeUndefined();
    const runId = fresh();
    noteAttachedFastPath(runId, [CHECK]);
    const env = { XIONGBAO_FASTPATH_CHECK_GATE: "off" };
    expect(fastPathCheckGateOn(env)).toBe(false);
    expect(fastPathCheckGateOn({})).toBe(true);
    expect(uncheckedFastPath({ runId, messages: [user], env })).toBeUndefined();
  });
});
