import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { HEADLESS_WAITING_EVENT } from "@xiongbao/toolkit/headless-tools";
import type { RunCommandResult } from "../src/computer/schema";
import {
  type CardCommandRun,
  cardCommandRuns,
  cardRoundRuns,
  claimBounce,
  createRerunRunner,
  deliveryRerunOn,
  RERUN_BOUNCE_KEY,
  rerunChecks,
  rerunClaimGateOn,
} from "../src/tasks/rerun-gate";
import { offloadCommandResult } from "../src/tool-output";

/**
 * 交付时复跑核对命令（规格 2026-11-25-borrowed-improvements §5.5）：说法门、复跑判定、从运行事件读出跑过的
 * 命令。全部用桩函数，不接电脑、不接库。
 */

const ran = (
  command: string,
  exitCode: number,
  output: string,
  at: number,
  extra: Partial<CardCommandRun> = {},
): CardCommandRun => ({
  command,
  exitCode,
  output,
  stdout: output,
  stderr: "",
  truncated: false,
  approved: false,
  at,
  toolCallId: `call-${at}`,
  ...extra,
});

const result = (
  command: string,
  exitCode: number,
  stdout: string,
  extra: Partial<RunCommandResult> = {},
): RunCommandResult => ({
  command,
  exitCode,
  stdout,
  stderr: "",
  truncated: false,
  timedOut: false,
  elapsedMs: 10,
  ...extra,
});

/** 一个记下调用次数的 `run` 桩。 */
function runner(answer: (command: string) => RunCommandResult) {
  const calls: string[] = [];
  return {
    calls,
    run: async (command: string) => {
      calls.push(command);
      return answer(command);
    },
  };
}

const allow = async () => true;

describe("开关", () => {
  test("默认开，写 off 才关", () => {
    expect(deliveryRerunOn({})).toBe(true);
    expect(deliveryRerunOn({ XIONGBAO_DELIVERY_RERUN: "off" })).toBe(false);
    expect(rerunClaimGateOn({})).toBe(true);
    expect(
      rerunClaimGateOn({ XIONGBAO_DELIVERY_RERUN_CLAIM_GATE: " OFF " }),
    ).toBe(false);
  });
});

describe("说法门", () => {
  test("说测过却没写 rerun：挡回，并说明补 rerun 或写「无法复跑：」", () => {
    const reason = claimBounce({
      rerun: [],
      checks: ["跑过 bun test，全部通过"],
      notes: [],
      alreadyBounced: false,
    });
    expect(reason).toContain("rerun");
    expect(reason).toContain("无法复跑：");
  });

  test("note 里说测过也算", () => {
    expect(
      claimBounce({
        rerun: [],
        checks: [],
        notes: ["pytest 全部通过"],
        alreadyBounced: false,
      }),
    ).not.toBeNull();
  });

  test("这一轮已经挡回过：放行", () => {
    expect(
      claimBounce({
        rerun: [],
        checks: ["跑过 bun test，全部通过"],
        notes: [],
        alreadyBounced: true,
      }),
    ).toBeNull();
  });

  test("checks 里写了「无法复跑：原因」：放行", () => {
    expect(
      claimBounce({
        rerun: [],
        checks: ["跑过 bun test，全部通过", "无法复跑：本机没有测试环境"],
        notes: [],
        alreadyBounced: false,
      }),
    ).toBeNull();
  });

  test("写了 rerun：放行", () => {
    expect(
      claimBounce({
        rerun: ["bun test"],
        checks: ["跑过 bun test，全部通过"],
        notes: [],
        alreadyBounced: false,
      }),
    ).toBeNull();
  });

  test("只是提到「测试报告」：不算声称测过（Review Focus 1）", () => {
    expect(
      claimBounce({
        rerun: [],
        checks: ["这份测试报告的格式已统一"],
        notes: [],
        alreadyBounced: false,
      }),
    ).toBeNull();
  });
});

describe("复跑", () => {
  test("最近一次退出码 0、复跑输出一致：通过", async () => {
    const stub = runner((command) =>
      result(command, 0, "Ran 12 tests in 2.10s\n12 passed"),
    );
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun test", 0, "Ran 12 tests in 0.53s\n12 passed", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome).toEqual({
      bounce: null,
      outcomes: [{ command: "bun test", result: "passed" }],
    });
    expect(stub.calls).toEqual(["bun test"]);
  });

  test("复跑的是基准那次的原命令", async () => {
    const stub = runner((command) => result(command, 0, "3 passed"));
    await rerunChecks({
      commands: ["cd app && bun test | tail -5"],
      runs: [ran("cd app &&  bun test  | tail -5", 0, "3 passed", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(stub.calls).toEqual(["cd app &&  bun test  | tail -5"]);
  });

  test("最近一次失败、更早一次成功：按最近一次挡回（Review Focus 2）", async () => {
    const stub = runner((command) => result(command, 0, "12 passed"));
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [
        ran("bun test", 0, "12 passed", 1),
        ran("bun test", 1, "11 passed\n1 failed", 5),
      ],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome.bounce).toContain("这条命令最近一次没有成功");
    expect(outcome.outcomes).toEqual([
      {
        command: "bun test",
        result: "mismatch",
        why: "这条命令最近一次没有成功",
      },
    ]);
    expect(stub.calls).toEqual([]);
  });

  test("这张卡里没跑过：未复核，不挡回", async () => {
    const stub = runner((command) => result(command, 0, ""));
    const outcome = await rerunChecks({
      commands: ["pytest -q"],
      runs: [ran("bun test", 0, "1 passed", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome).toEqual({
      bounce: null,
      outcomes: [
        {
          command: "pytest -q",
          result: "unverified",
          why: "这张卡里没跑过这条命令",
        },
      ],
    });
    expect(stub.calls).toEqual([]);
  });

  test("基准是经审批才执行的：未复核，一次都不执行", async () => {
    const stub = runner((command) => result(command, 0, "12 passed"));
    let asked = 0;
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun test", 0, "12 passed", 1, { approved: true })],
      canExecute: true,
      wouldAllow: async () => {
        asked++;
        return true;
      },
      run: stub.run,
    });
    expect(outcome.bounce).toBeNull();
    expect(outcome.outcomes[0]?.result).toBe("unverified");
    expect(outcome.outcomes[0]?.why).toContain("审批");
    expect(stub.calls).toEqual([]);
    expect(asked).toBe(0);
  });

  test("按现在的规则要审批：未复核，不执行", async () => {
    const stub = runner((command) => result(command, 0, "12 passed"));
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun test", 0, "12 passed", 1)],
      canExecute: true,
      wouldAllow: async () => false,
      run: stub.run,
    });
    expect(outcome.bounce).toBeNull();
    expect(outcome.outcomes[0]?.result).toBe("unverified");
    expect(stub.calls).toEqual([]);
  });

  test("电脑不能由服务器执行：全部未复核", async () => {
    const stub = runner((command) => result(command, 0, "1"));
    const outcome = await rerunChecks({
      commands: ["bun test", "pytest -q"],
      runs: [ran("bun test", 0, "1", 1), ran("pytest -q", 0, "1", 2)],
      canExecute: false,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome.bounce).toBeNull();
    expect(outcome.outcomes.map((one) => one.result)).toEqual([
      "unverified",
      "unverified",
    ]);
    expect(stub.calls).toEqual([]);
  });

  test("改动类命令：未复核，原因取 isRerunnable 的", async () => {
    const stub = runner((command) => result(command, 0, "1"));
    const outcome = await rerunChecks({
      commands: ["bun test > out.txt"],
      runs: [ran("bun test > out.txt", 0, "", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome.outcomes).toEqual([
      {
        command: "bun test > out.txt",
        result: "unverified",
        why: "命令把输出写进文件",
      },
    ]);
    expect(stub.calls).toEqual([]);
  });

  test("复跑退出码变成 1：挡回，写命令、两次退出码、两边输出末尾", async () => {
    const stub = runner((command) =>
      result(command, 1, "11 passed\n1 failed: tests/a.test.ts"),
    );
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun test", 0, "12 passed\n0 failed", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome.bounce).toContain("bun test");
    expect(outcome.bounce).toContain("原来退出码 0");
    expect(outcome.bounce).toContain("复跑退出码 1");
    expect(outcome.bounce).toContain("12 passed\n0 failed");
    expect(outcome.bounce).toContain("1 failed: tests/a.test.ts");
    expect(outcome.outcomes[0]?.result).toBe("mismatch");
  });

  test("输出末尾至多 20 行", async () => {
    const long = Array.from({ length: 50 }, (_, index) => `line ${index}`).join(
      "\n",
    );
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun test", 0, long, 1)],
      canExecute: true,
      wouldAllow: allow,
      run: async (command) => result(command, 2, "boom"),
    });
    expect(outcome.bounce).toContain("line 49");
    expect(outcome.bounce).toContain("line 30");
    expect(outcome.bounce).not.toContain("line 29\n");
  });

  test("复跑超时：未复核，不挡回", async () => {
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun test", 0, "1 passed", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: async (command) => result(command, -1, "", { timedOut: true }),
    });
    expect(outcome.bounce).toBeNull();
    expect(outcome.outcomes[0]?.result).toBe("unverified");
  });

  test("至多复跑 3 条", async () => {
    const stub = runner((command) => result(command, 0, "1"));
    const commands = ["bun test", "pytest -q", "go test ./...", "cargo test"];
    const outcome = await rerunChecks({
      commands,
      runs: commands.map((command, index) => ran(command, 0, "1", index)),
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome.outcomes).toHaveLength(3);
    expect(stub.calls).toHaveLength(3);
  });
});

describe("复跑：允许名单和截断对齐（评审 C1、I2）", () => {
  test("基准只认整条命令解析后同一个核对：含有声明命令的复合命令不当基准", async () => {
    const stub = runner((command) => result(command, 0, "12 passed"));
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [
        ran("bun test", 0, "12 passed", 1),
        ran("npm install && bun test", 0, "12 passed", 5),
        ran("git clean -fdx && bun test", 0, "12 passed", 6),
      ],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(stub.calls).toEqual(["bun test"]);
    expect(outcome.outcomes).toEqual([
      { command: "bun test", result: "passed" },
    ]);
  });

  test("声明的命令不在允许名单里：未复核，什么都不执行", async () => {
    const stub = runner((command) => result(command, 0, ""));
    const outcome = await rerunChecks({
      commands: ["bunx biome check --write .", "jest -u", "make clean"],
      runs: [
        ran("bunx biome check --write .", 0, "", 1),
        ran("jest -u", 0, "", 2),
        ran("make clean", 0, "", 3),
      ],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(outcome.outcomes.map((one) => one.result)).toEqual([
      "unverified",
      "unverified",
      "unverified",
    ]);
    expect(stub.calls).toEqual([]);
  });

  test("执行的命令和声明的不同：交付记录另记实际执行的", async () => {
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("bun  test", 0, "3 passed", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: async (command) => result(command, 0, "3 passed"),
    });
    expect(outcome.outcomes).toEqual([
      { command: "bun test", result: "passed", ran: "bun  test" },
    ]);
  });

  test("声明 bun test、最近一次跑的是 cd app && bun test 且失败：挡回，ran 记原始命令（裁定）", async () => {
    const stub = runner((command) => result(command, 0, "3 pass"));
    const outcome = await rerunChecks({
      commands: ["bun test"],
      runs: [
        ran("bun test", 0, "3 pass", 1),
        ran("cd app && bun test", 1, "1 fail", 2),
      ],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    // 整条对得上的那次更早且成功，但先按整条找：整条对上的优先。
    expect(outcome.bounce).toBeNull();
    const fallback = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("cd app && bun test 2>&1 | tail -5", 1, "1 fail", 2)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(fallback.bounce).toContain("这条命令最近一次没有成功");
    expect(fallback.outcomes).toEqual([
      {
        command: "bun test",
        result: "mismatch",
        why: "这条命令最近一次没有成功",
        ran: "cd app && bun test 2>&1 | tail -5",
      },
    ]);
  });

  test("按去掉 cd 找到的基准成功了：执行与否仍按原始命令走允许名单", async () => {
    const stub = runner((command) => result(command, 0, "3 pass"));
    const runnable = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("cd app && bun test", 0, "3 pass", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(runnable.outcomes).toEqual([
      { command: "bun test", result: "passed", ran: "cd app && bun test" },
    ]);
    const refused = await rerunChecks({
      commands: ["bun test"],
      runs: [ran("cd app && bun test 2>&1 | tail -5", 0, "3 pass", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(refused.outcomes[0]?.result).toBe("unverified");
    expect(refused.outcomes[0]?.ran).toBe("cd app && bun test 2>&1 | tail -5");
    expect(stub.calls).toEqual(["cd app && bun test"]);
  });

  test("名单外的命令最近一次失败照样挡回（复审回归）；成功的记未复核、不执行", async () => {
    const stub = runner((command) => result(command, 0, "ok"));
    const failed = await rerunChecks({
      commands: ["npm run lint"],
      runs: [
        ran("npm run lint", 0, "ok", 1),
        ran("npm run lint", 1, "3 problems", 2),
      ],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(failed.bounce).toContain("这条命令最近一次没有成功");
    expect(failed.outcomes).toEqual([
      {
        command: "npm run lint",
        result: "mismatch",
        why: "这条命令最近一次没有成功",
      },
    ]);
    const passed = await rerunChecks({
      commands: ["npm run lint"],
      runs: [ran("npm run lint", 0, "ok", 1)],
      canExecute: true,
      wouldAllow: allow,
      run: stub.run,
    });
    expect(passed.bounce).toBeNull();
    expect(passed.outcomes[0]?.result).toBe("unverified");
    expect(passed.outcomes[0]?.why).toContain("package 脚本");
    expect(stub.calls).toEqual([]);
  });

  /** 一大段测试输出：每行一个用例，最后一行是通过数。 */
  const suite = (cases: number, passed = cases) =>
    `${Array.from({ length: cases }, (_, i) => `case ${i + 1} ok (${i % 7} assertions)`).join("\n")}\n${passed} pass\n`;
  /** 员工那次的结果，经真实的工具结果收紧（`tool-output.ts`）后存下的样子。 */
  const stored = async (stdout: string, truncated = false) => {
    const kept = await offloadCommandResult(
      { command: "bun test", exitCode: 0, stdout, stderr: "", truncated },
      { id: "call-1" },
    );
    return ran("bun test", 0, kept.stdout, 1, {
      stdout: kept.stdout,
      stderr: kept.stderr,
      truncated,
    });
  };
  /** 电脑截掉前面、只留最后 64KB（`agent-computer/src/shell.ts` 的 `clamp`）。 */
  const clamp = (text: string) =>
    Buffer.from(text, "utf8")
      .subarray(-64 * 1024)
      .toString("utf8");
  const check = async (baseline: CardCommandRun, rerun: string, cut = false) =>
    rerunChecks({
      commands: ["bun test"],
      runs: [baseline],
      canExecute: true,
      wouldAllow: allow,
      run: async (command) =>
        result(command, 0, cut ? clamp(rerun) : rerun, { truncated: cut }),
    });

  test("长输出留头尾（真实的 excerpt 形状）：开头结尾各自对齐，一致就通过", async () => {
    const baseline = await stored(suite(2000));
    // 真的被收紧成了头尾，标记里的行数、字节数不当数字比。
    expect(baseline.stdout).toContain("…（中间省略");
    expect((await check(baseline, suite(2000))).outcomes).toEqual([
      { command: "bun test", result: "passed" },
    ]);
  });

  test("长输出留头尾：结尾的通过数真的变了，照样挡回", async () => {
    const baseline = await stored(suite(2000));
    const changed = await check(baseline, suite(2000, 1500));
    expect(changed.outcomes[0]?.result).toBe("mismatch");
    expect(changed.bounce).toContain("结尾");
  });

  test("长输出只留尾（电脑截掉前面，切在行中间）：按结尾比", async () => {
    const full = suite(6000);
    const baseline = await stored(clamp(full), true);
    expect(baseline.truncated).toBe(true);
    expect((await check(baseline, full)).outcomes[0]?.result).toBe("passed");
    // 复跑也被电脑截了：两边都只比结尾。
    expect((await check(baseline, full, true)).outcomes[0]?.result).toBe(
      "passed",
    );
    expect((await check(baseline, suite(6000, 5000))).outcomes[0]?.result).toBe(
      "mismatch",
    );
  });

  test("截断后对不齐：未复核，不挡回", async () => {
    const baseline = await stored(suite(2000));
    const outcome = await check(baseline, "only 5 pass");
    expect(outcome.bounce).toBeNull();
    expect(outcome.outcomes[0]?.result).toBe("unverified");
    expect(outcome.outcomes[0]?.why).toContain("对不齐");
  });
});

describe("cardCommandRuns", () => {
  const call = (
    id: string,
    command: string,
    content?: unknown,
  ): BaseEvent[] => [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: "computer_run_command",
    } as BaseEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify({ command }),
    } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent,
    ...(content === undefined
      ? []
      : [
          {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: id,
            messageId: `m-${id}`,
            content: JSON.stringify(content),
          } as BaseEvent,
        ]),
  ];

  test("读出命令、退出码、输出，按先后排", () => {
    const runs = cardCommandRuns([
      ...call("a", "bun test", {
        ok: true,
        command: "bun test",
        exitCode: 0,
        stdout: "3 pass",
        stderr: "warn",
        truncated: false,
        timedOut: false,
      }),
      ...call("b", "pytest -q", {
        ok: true,
        command: "pytest -q",
        exitCode: 1,
        stdout: "1 failed",
        stderr: "",
        truncated: true,
      }),
    ]);
    expect(runs).toEqual([
      {
        command: "bun test",
        exitCode: 0,
        output: "3 pass\nwarn",
        stdout: "3 pass",
        stderr: "warn",
        truncated: false,
        approved: false,
        at: 0,
        toolCallId: "a",
      },
      {
        command: "pytest -q",
        exitCode: 1,
        output: "1 failed",
        stdout: "1 failed",
        stderr: "",
        truncated: true,
        approved: false,
        at: 4,
        toolCallId: "b",
      },
    ]);
  });

  test("别的工具和没有结果的调用不算", () => {
    const runs = cardCommandRuns([
      ...call("a", "bun test"),
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "x",
        toolCallName: "computer_read_file",
      } as BaseEvent,
    ]);
    expect(runs).toEqual([]);
  });

  test("存下的两路输出原样留着（省略标记交给比较时按截断方式对齐）", () => {
    const stdout = "start 1\n…（中间省略 9 行，约 99 字节）…\nend 2";
    const [only] = cardCommandRuns(
      call("a", "bun test", {
        ok: true,
        exitCode: 0,
        stdout,
        stderr: "",
        truncated: false,
        outputNote: "完整内容存到工作区",
      }),
    );
    expect(only?.stdout).toBe(stdout);
    expect(only?.truncated).toBe(false);
  });

  test("等过审批的调用记为经审批执行（等人事件或中断里写着 approval）", () => {
    const runs = cardCommandRuns([
      ...call("a", "bun test"),
      {
        type: EventType.CUSTOM,
        name: HEADLESS_WAITING_EVENT,
        value: {
          kind: "approval",
          approvalId: "ap1",
          continuation: { toolCallId: "a" },
        },
      } as BaseEvent,
      ...call("b", "pytest -q", { ok: true, exitCode: 0, stdout: "1 passed" }),
      {
        type: EventType.RUN_FINISHED,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "b",
              toolCallId: "b",
              metadata: { xiongbaoWaiting: { kind: "approval" } },
            },
          ],
        },
      } as unknown as BaseEvent,
      ...call("c", "make check", { ok: true, exitCode: 0, stdout: "ok" }),
    ]);
    expect(runs.map((run) => [run.command, run.approved])).toEqual([
      ["bun test", true],
      ["pytest -q", true],
      ["make check", false],
    ]);
  });

  test("一轮一轮地读：同一个调用 id 在不同轮里是两次运行，先后接着排", () => {
    const runs = cardRoundRuns([
      {
        runId: "r1",
        events: call("a", "bun test", {
          ok: true,
          exitCode: 0,
          stdout: "1 passed",
        }),
      },
      {
        runId: "r2",
        events: call("a", "bun test", {
          ok: true,
          exitCode: 1,
          stdout: "1 failed",
        }),
      },
    ]);
    expect(runs.map((run) => [run.exitCode, run.at, run.runId])).toEqual([
      [0, 0, "r1"],
      [1, 4, "r2"],
    ]);
  });

  test("跨轮的审批（评审 I1）：第 1 轮等审批，第 2 轮这条命令再跑，也记经审批", () => {
    const runs = cardRoundRuns([
      {
        runId: "r1",
        events: [
          ...call("a", "bun test"),
          {
            type: EventType.CUSTOM,
            name: HEADLESS_WAITING_EVENT,
            value: { kind: "approval", continuation: { toolCallId: "a" } },
          } as BaseEvent,
        ],
      },
      {
        runId: "r2",
        events: call("x", "bun  test", {
          ok: true,
          exitCode: 0,
          stdout: "1 passed",
        }),
      },
    ]);
    expect(runs.map((run) => [run.runId, run.approved])).toEqual([
      ["r1", true],
      ["r2", true],
    ]);
  });

  test("审批存储里经审批执行过的（按运行号加调用 id，或按命令）：记经审批；两种来源取并集", () => {
    const rounds = [
      {
        runId: "r1",
        events: call("a", "pytest -q", { ok: true, exitCode: 0, stdout: "1" }),
      },
      {
        runId: "r2",
        events: [
          ...call("b", "go test ./...", { ok: true, exitCode: 0, stdout: "2" }),
          ...call("c", "make test", { ok: true, exitCode: 0, stdout: "3" }),
        ],
      },
    ];
    const runs = cardRoundRuns(rounds, [
      // 按运行号加调用 id 对上。
      { runId: "r1", toolCallId: "a", command: "pytest  -q" },
      // 审批执行的那次不在任何一轮的事件里，只按命令对上同一条命令。
      { command: "go test ./..." },
    ]);
    expect(runs.map((run) => [run.command, run.approved])).toEqual([
      ["pytest -q", true],
      ["go test ./...", true],
      ["make test", false],
    ]);
    // 另一轮里的同一个调用 id 不算。
    expect(
      cardRoundRuns(rounds, [
        { runId: "r9", toolCallId: "c", command: "rm -rf x" },
      ]).map((run) => run.approved),
    ).toEqual([false, false, false]);
  });

  test("被拒绝或出错的调用记为没成功", () => {
    const [only] = cardCommandRuns(
      call("a", "bun test", { ok: false, error: "refused" }),
    );
    expect(only?.exitCode).not.toBe(0);
    expect(only?.output).toBe("refused");
  });
});

describe("createRerunRunner", () => {
  const seat = { botId: "bot-1", key: { kind: "bot", id: "bot-1" } } as never;
  const actor = { id: "person-1", userId: "person-1" };

  test("配对的个人电脑（statFile 答 null）或不在线（抛错）：不能执行", async () => {
    for (const statFile of [
      async () => null,
      async () => {
        throw new Error("offline");
      },
    ]) {
      const rerun = createRerunRunner({
        gateway: {
          statFile,
          runCommand: async () => result("x", 0, ""),
        } as never,
        resolve: async () => ({ seat, actor }),
        wouldAllow: allow,
        withoutAsking: (work) => work(),
      });
      expect(await rerun.canExecute()).toBe(false);
    }
  });

  test("执行时走员工的座位和身份、120 秒超时，包在 withoutAsking 里", async () => {
    const seen: unknown[] = [];
    let wrapped = 0;
    const rerun = createRerunRunner({
      gateway: {
        statFile: async () => ({ kind: "folder", bytes: 0 }),
        runCommand: async (...args: unknown[]) => {
          seen.push(args);
          return result("bun test", 0, "1 passed");
        },
      } as never,
      resolve: async () => ({ seat, actor }),
      wouldAllow: allow,
      withoutAsking: async (work) => {
        wrapped++;
        return await work();
      },
    });
    expect(await rerun.canExecute()).toBe(true);
    const signal = new AbortController().signal;
    await rerun.run("bun test", signal);
    expect(wrapped).toBe(1);
    expect(seen).toEqual([
      [seat, actor, { command: "bun test", timeoutMs: 120_000 }, signal],
    ]);
  });

  test("预判问的是 computer_run_command 的写动作", async () => {
    const asked: unknown[] = [];
    const rerun = createRerunRunner({
      gateway: {} as never,
      resolve: async () => ({ seat, actor }),
      wouldAllow: async (candidate) => {
        asked.push(candidate);
        return false;
      },
      withoutAsking: (work) => work(),
    });
    expect(await rerun.wouldAllow("bun test")).toBe(false);
    expect(asked).toMatchObject([
      {
        actorId: "person-1",
        botId: "bot-1",
        toolRef: "computer_run_command",
        effect: "write",
        scope: "workspace",
        subject: { command: "bun test" },
      },
    ]);
  });

  test("挡回标记的名字", () => {
    expect(RERUN_BOUNCE_KEY).toBe("rerunBounce");
  });
});
