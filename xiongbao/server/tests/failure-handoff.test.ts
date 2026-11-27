import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import {
  RUN_ENDED_EARLY,
  SEGMENT_LIMIT_MESSAGE,
} from "@xiongbao/toolkit/headless-tools";
import { taskEventSentence } from "../src/tasks/events";
import {
  FAILURE_HANDOFF_CHARS,
  failureHandoffOf,
  lastStepsOf,
  renderFailureHandoff,
  writtenFilesOf,
} from "../src/tasks/failure-handoff";

/**
 * 看板卡一轮失败时写的失败交接（设计稿 2026-11-25-borrowed-improvements 5.4）：从这一轮的运行事件确定性地
 * 拼出停在哪、做到哪、留下什么和下一步，不调模型；总长不超过 1500 字，经过 `mask`。
 */

const NEXT_STEP = "先看上面的进度和文件，从断点接着做，别从头再来";

/** 一次工具调用的事件：开始、参数、结束，再加上它的答复。 */
function call(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  answer: string,
): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: tool,
    } as BaseEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent,
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: id,
      messageId: `result-${id}`,
      content: answer,
    } as BaseEvent,
  ];
}

const OK = JSON.stringify({ ok: true });

/** 7 次工具调用：第 3 次写了一个文件，最后一次失败。 */
function sevenCalls(): BaseEvent[] {
  return [
    ...call("c1", "computer_list_files", { path: "." }, OK),
    ...call("c2", "computer_read_file", { path: "data.csv" }, OK),
    ...call(
      "c3",
      "computer_write_file",
      { path: "report/summary.md", contents: "# 汇总\n" },
      OK,
    ),
    ...call("c4", "computer_run_command", { command: "ls report" }, OK),
    ...call("c5", "computer_read_file", { path: "report/summary.md" }, OK),
    ...call("c6", "web_fetch", { url: "https://example.test/rates" }, OK),
    ...call(
      "c7",
      "computer_run_command",
      { command: "python make_table.py" },
      JSON.stringify({ ok: false, error: "exit 1" }),
    ),
  ];
}

describe("failureHandoffOf", () => {
  test("步数到顶的一轮：停在哪、最后 5 次调用、写过的文件、进度", () => {
    const handoff = failureHandoffOf({
      error: SEGMENT_LIMIT_MESSAGE,
      events: sevenCalls(),
      progress: "表格做了一半",
    });
    expect(handoff.stoppedAt).toBe("被停下了：步数到顶");
    expect(handoff.progress).toBe("表格做了一半");
    expect(handoff.steps).toHaveLength(5);
    // 最后 5 次：第 3 到第 7 次。
    expect(handoff.steps.map((step) => step.tool)).toEqual([
      "computer_write_file",
      "computer_run_command",
      "computer_read_file",
      "web_fetch",
      "computer_run_command",
    ]);
    expect(handoff.steps[0]?.summary).toContain("report/summary.md");
    expect(handoff.steps.at(-1)?.ok).toBe(false);
    expect(handoff.steps.slice(0, -1).every((step) => step.ok)).toBe(true);
    expect(handoff.files).toContain("report/summary.md");

    const text = renderFailureHandoff(handoff);
    expect(text).toContain(NEXT_STEP);
    expect(text).toContain("被停下了：步数到顶");
    expect(text).toContain("表格做了一半");
    expect(text).toContain("report/summary.md");
    expect(text.length).toBeLessThanOrEqual(FAILURE_HANDOFF_CHARS);
  });

  test("另外两种停下，和不是停下的错误", () => {
    const stopped = (error: string) =>
      failureHandoffOf({ error, events: [], progress: null }).stoppedAt;
    expect(stopped(RUN_ENDED_EARLY)).toBe("被停下了：提前结束");
    expect(stopped("The routine's turn was stopped after 1500s.")).toBe(
      "被停下了：超时 1500 秒",
    );
    expect(
      stopped(
        "The subagent did not finish: The routine's turn was stopped after 90s.",
      ),
    ).toBe("被停下了：超时 90 秒");
    // 其他错误：「出错了：」加错误首句，最多 80 字。
    expect(stopped("模型连接中断。后面还有一大段说明")).toBe(
      "出错了：模型连接中断。",
    );
    const long = stopped("x".repeat(300));
    expect(long.startsWith("出错了：")).toBe(true);
    expect(
      Array.from(long.slice("出错了：".length)).length,
    ).toBeLessThanOrEqual(80);
  });

  test("10 个超长参数也不超过 1500 字，下一步那句还在", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      call(
        `long-${index}`,
        "computer_write_file",
        {
          path: `out/${"很长的目录名".repeat(40)}-${index}.md`,
          contents: "内容".repeat(5000),
        },
        OK,
      ),
    ).flat();
    const handoff = failureHandoffOf({
      error: "出错了".repeat(400),
      events,
      progress: "进度".repeat(400),
    });
    const text = renderFailureHandoff(handoff);
    expect(text.length).toBeLessThanOrEqual(FAILURE_HANDOFF_CHARS);
    expect(text).toContain(NEXT_STEP);
  });

  // Review Focus 5：失败那一轮的错误文字或工具参数里带着密钥，失败交接里不出现。
  test("错误文字和工具参数里的密钥不进交接", () => {
    const key = `sk-${"A1b2C3d4".repeat(4)}`;
    expect(key).toHaveLength(35);
    const handoff = failureHandoffOf({
      error: `调用失败：Authorization: Bearer ${key} 被拒绝`,
      events: call(
        "secret",
        "computer_run_command",
        { command: `curl -H "x-api-key: ${key}" https://api.example.test` },
        JSON.stringify({ ok: false, error: `bad key ${key}` }),
      ),
      progress: `用 ${key} 试过一次`,
    });
    const text = renderFailureHandoff(handoff);
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(3, 20));
    expect(handoff.stoppedAt).not.toContain(key);
    expect(JSON.stringify(handoff)).not.toContain(key);
  });
});

describe("lastStepsOf / writtenFilesOf", () => {
  test("没有答复的调用不算做成；只记做成的写文件", () => {
    const events: BaseEvent[] = [
      ...call("w1", "computer_write_file", { path: "a.md" }, OK),
      ...call(
        "w2",
        "computer_write_file",
        { path: "b.md" },
        JSON.stringify({ ok: false, error: "denied" }),
      ),
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "w3",
        toolCallName: "computer_edit_file",
      } as BaseEvent,
    ];
    const steps = lastStepsOf(events, 5);
    expect(steps.map((step) => [step.tool, step.ok])).toEqual([
      ["computer_write_file", true],
      ["computer_write_file", false],
      ["computer_edit_file", false],
    ]);
    expect(lastStepsOf(events, 1).map((step) => step.tool)).toEqual([
      "computer_edit_file",
    ]);
    expect(writtenFilesOf(events, 10)).toEqual(["a.md"]);
  });
});

test("卡片流水的一句话：失败交接说停在哪，带过的标记不说", () => {
  const clock = { now: new Date(), timeZone: "Asia/Shanghai" };
  expect(
    taskEventSentence(
      {
        kind: "failure_handoff",
        detail: { stoppedAt: "被停下了：步数到顶", text: "……" },
      },
      clock,
    ),
  ).toBe("留了失败交接：被停下了：步数到顶");
  expect(
    taskEventSentence(
      { kind: "failure_handoff_carried", detail: { handoffId: "x" } },
      clock,
    ),
  ).toBeUndefined();
});
