import { expect, test } from "bun:test";
import {
  backgroundOf,
  callTrace,
  type LearnedState,
  learningDiff,
  RETRO_WAIT_MS,
  retroLinesOf,
  waitForRetro,
} from "./learning";
import type { Capabilities } from "./metrics";
import { combineRepeat, type EvalRecord, type EvalResults } from "./records";
import { backgroundRows, learningRows, renderReport } from "./report";

const state = (
  skills: Record<string, [string, number]>,
  memories = 0,
): LearnedState => ({
  skills: new Map(
    Object.entries(skills).map(([slug, [title, useCount]]) => [
      slug,
      { title, useCount },
    ]),
  ),
  memories,
});

test("what a run learned is the difference before and after: new skills, new memories, skills whose use count rose", () => {
  const before = state({ "auto-a": ["旧技能", 1], "auto-b": ["没用的", 0] }, 2);
  const after = state(
    {
      "auto-a": ["旧技能", 2],
      "auto-b": ["没用的", 0],
      "auto-c": ["新技能", 0],
    },
    5,
  );
  expect(learningDiff(before, after)).toEqual({
    newSkills: ["新技能"],
    newMemories: 3,
    usedSkills: ["旧技能"],
  });
  expect(learningDiff(before, before)).toEqual({
    newSkills: [],
    newMemories: 0,
    usedSkills: [],
  });
});

const line = (extra: Record<string, unknown>) =>
  JSON.stringify({ type: "retrospect", ...extra });

test("the log lines of a run's retrospective are read out of a noisy server log", () => {
  const log = [
    "listening on :3000",
    line({ runId: "r1", outcome: "skipped", trigger: "steps", steps: 9 }),
    `2026-11-20T10:00:00Z ${line({ runId: "r2", outcome: "saved", trigger: "card_delivered", steps: 12 })}`,
    '{"type":"retrospect","runId":"r3","outcome":',
    JSON.stringify({ type: "retrospect-error", runId: "r2" }),
  ].join("\n");
  expect(retroLinesOf(log, ["r2"])).toEqual([
    { runId: "r2", outcome: "saved", trigger: "card_delivered", steps: 12 },
  ]);
  expect(retroLinesOf(log, ["r3", "r9"])).toEqual([]);
});

test("a held retrospective carries the reason from its retrospect-held line", () => {
  const log = [
    JSON.stringify({
      type: "retrospect-held",
      runId: "r2",
      reason: "要求访问或外发到网址或域名（rates.fx）",
    }),
    line({
      runId: "r2",
      outcome: "held",
      trigger: "card_delivered",
      steps: 20,
    }),
    JSON.stringify({ type: "retrospect-held", runId: "r9", reason: "别的轮" }),
  ].join("\n");
  expect(retroLinesOf(log, ["r2"])).toEqual([
    {
      runId: "r2",
      outcome: "held",
      trigger: "card_delivered",
      steps: 20,
      heldReason: "要求访问或外发到网址或域名（rates.fx）",
    },
  ]);
});

test("the call trace prints one line per call with sizes and the arguments cut short", () => {
  expect(
    callTrace(
      [
        {
          name: "computer_run_command",
          args: '{"command":"ls\n -la"}',
          result: "a\nb",
        },
        { name: "deliver_task", args: "x".repeat(10) },
      ],
      8,
    ),
  ).toEqual([
    ' 1. computer_run_command [参数 21 字 / 结果 3 字] {"comman…',
    " 2. deliver_task [参数 10 字] xxxxxxxx…",
  ]);
});

test("a refused or bounced call also prints the first 120 characters of its result on one line", () => {
  const bounced = JSON.stringify({
    bounced: true,
    reason: "缺必需项：A".repeat(40),
  });
  const lines = callTrace(
    [
      {
        name: "deliver_task",
        args: "{}",
        result: "[refused] 这件活\n还没接下",
      },
      { name: "deliver_task", args: "{}", result: bounced },
      { name: "deliver_task", args: "{}", result: '{"delivered":true}' },
    ],
    8,
  );
  expect(lines[0]).toBe(
    " 1. deliver_task [参数 2 字 / 结果 18 字] {} → [refused] 这件活 还没接下",
  );
  expect(lines[1]?.endsWith(` → ${bounced.slice(0, 120)}`)).toBe(true);
  expect(lines[2]).toBe(" 3. deliver_task [参数 2 字 / 结果 18 字] {}");
});

function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

test("it waits until the last round's retrospective line shows up", async () => {
  const time = clock();
  let reads = 0;
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => {
      reads += 1;
      return reads < 4
        ? line({ runId: "r1", outcome: "skipped" })
        : line({
            runId: "r2",
            outcome: "saved",
            trigger: "card_delivered",
            steps: 11,
          });
    },
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({
    waitedMs: 3000,
    ended: "logged",
    outcome: "saved",
    trigger: "card_delivered",
    steps: 11,
  });
});

test("a new skill in the table also ends the wait", async () => {
  const time = clock();
  const counts = [0, 0, 1];
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () => "",
    skillCount: async () => counts.shift() ?? 1,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({ waitedMs: 2000, ended: "skill" });
});

test("no retrospective in time: it stops at the cap and the second run starts as usual", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () => {
      throw new Error("log unreadable");
    },
    skillCount: async () => {
      throw new Error("db down");
    },
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({ waitedMs: RETRO_WAIT_MS, ended: "timeout" });
  expect(RETRO_WAIT_MS).toBe(90_000);
});

// --- the report ---------------------------------------------------------------------------------

const capabilities: Capabilities = {
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
};
const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "repeat-first",
  title: "重复任务",
  passed: true,
  wallMs: 40_000,
  timedOut: false,
  steps: 13,
  toolCalls: 12,
  modelCalls: 13,
  tokens: { input: 253_068, output: 4_000, total: 257_068, cachedInput: 0 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities,
  checks: [],
  ...over,
});
const side = (records: EvalRecord[]): EvalResults => ({
  side: "xiongbao",
  suite: "tasks",
  provider: "deepseek",
  model: "m",
  baseUrl: null,
  runner: "x",
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("the repeat report says what was learned between the two runs and what the second run used", () => {
  const repeated = combineRepeat(
    record({
      learning: {
        newSkills: ["动作清单做成汇总表"],
        newMemories: 0,
        usedSkills: [],
        retro: {
          waitedMs: 12_000,
          ended: "logged",
          outcome: "saved",
          trigger: "card_delivered",
          steps: 11,
        },
      },
    }),
    record({
      steps: 8,
      learning: {
        newSkills: [],
        newMemories: 1,
        usedSkills: ["动作清单做成汇总表"],
      },
    }),
  );
  expect(repeated.firstRun?.learning?.newSkills).toEqual([
    "动作清单做成汇总表",
  ]);
  const mine = side([repeated]);
  expect(learningRows([["熊宝", mine]])).toEqual([
    [
      "熊宝",
      "saved（card_delivered / 11 步），等了 12 s",
      "技能 1（「动作清单做成汇总表」） / 记忆 0",
      "「动作清单做成汇总表」",
      "技能 0 / 记忆 1",
    ],
  ]);
  const markdown = renderReport([mine]);
  expect(markdown).toContain("## 重复任务：学没学到");
  expect(markdown).toContain("动作清单做成汇总表");
});

test("a retrospective that never came, and a run that learned nothing, read plainly; a side with no learning has no row", () => {
  const repeated = combineRepeat(
    record({
      learning: {
        newSkills: [],
        newMemories: 0,
        usedSkills: [],
        retro: { waitedMs: 90_000, ended: "timeout" },
      },
    }),
    record({ learning: { newSkills: [], newMemories: 0, usedSkills: [] } }),
  );
  const [row] = learningRows([["熊宝", side([repeated])]]);
  expect(row?.[1]).toBe("等满 90 s，没等到复盘结果");
  expect(row?.[3]).toBe("没有");
  expect(
    learningRows([["Codex", side([combineRepeat(record(), record())])]]),
  ).toEqual([]);
  expect(learningRows([["Codex", undefined]])).toEqual([]);
});

// --- background calls -----------------------------------------------------------------------------

test("background calls are counted apart: how many, how many input tokens, a missing count reads as zero", () => {
  expect(backgroundOf([])).toEqual({ count: 0, inputTokens: 0 });
  expect(
    backgroundOf([
      { inputTokens: 1200 },
      { inputTokens: null },
      { inputTokens: 300 },
    ]),
  ).toEqual({ count: 3, inputTokens: 1500 });
});

test("the report lists background calls and the total with them; two runs of a repeat add up", () => {
  const repeated = combineRepeat(
    record({ backgroundCalls: { count: 1, inputTokens: 2_000 } }),
    record({ backgroundCalls: { count: 1, inputTokens: 1_500 } }),
  );
  expect(repeated.backgroundCalls).toEqual({ count: 2, inputTokens: 3_500 });
  expect(repeated.firstRun?.backgroundCalls).toEqual({
    count: 1,
    inputTokens: 2_000,
  });
  const mine = side([repeated]);
  expect(backgroundRows([["熊宝", mine]])).toEqual([
    [
      "重复任务（多步办公连做两次）（熊宝）",
      "506,136",
      "2 次 / 3,500",
      "509,636",
    ],
  ]);
  expect(backgroundRows([["Codex", side([record()])]])).toEqual([]);
  const markdown = renderReport([mine]);
  expect(markdown).toContain("## 后台调用（复盘、自动抽记忆）");
  expect(markdown).toContain("2 次 / 3,500");
});

// --- waiting for the card's review, not for any line ------------------------------------------

const stepsSkip = (runId: string, extra: Record<string, unknown> = {}) =>
  line({
    runId,
    outcome: "skipped",
    trigger: "steps",
    reason: "steps",
    steps: 14,
    ...extra,
  });

test("the log lines carry the card and why a review was skipped", () => {
  const log = line({
    runId: "r1",
    outcome: "skipped",
    trigger: "card_delivered",
    reason: "steps",
    cardId: "c1",
    steps: 3,
  });
  expect(retroLinesOf(log, ["r1"])).toEqual([
    {
      runId: "r1",
      outcome: "skipped",
      trigger: "card_delivered",
      reason: "steps",
      cardId: "c1",
      steps: 3,
    },
  ]);
});

test("a plain turn skipped for too few steps does not end the wait; the card's review that follows does", async () => {
  const time = clock();
  let reads = 0;
  const result = await waitForRetro({
    runIds: ["r1"],
    readLog: () => {
      reads += 1;
      return reads < 5
        ? stepsSkip("r1")
        : [
            stepsSkip("r1"),
            line({
              runId: "r1",
              outcome: "saved",
              trigger: "card_delivered",
              cardId: "c1",
              steps: 11,
            }),
          ].join("\n");
    },
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toMatchObject({
    ended: "logged",
    outcome: "saved",
    trigger: "card_delivered",
    waitedMs: 4000,
  });
});

test("only plain turns skipped for steps: it waits the whole cap, and says what it last saw", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => [stepsSkip("r1"), stepsSkip("r2")].join("\n"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result).toEqual({
    waitedMs: RETRO_WAIT_MS,
    ended: "timeout",
    outcome: "skipped",
    trigger: "steps",
    steps: 14,
  });
});

test("a card's review skipped for too few steps in an earlier round does not end the wait either", async () => {
  const time = clock();
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () =>
      [
        stepsSkip("r1", { trigger: "card_delivered", cardId: "c1", steps: 3 }),
        stepsSkip("r2"),
      ].join("\n"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...time,
  });
  expect(result.ended).toBe("timeout");
});

test("a skip that is not about steps (cooldown, card already reviewed) is a conclusion", async () => {
  for (const extra of [
    { trigger: "card_delivered", cardId: "c1" },
    { trigger: "card_delivered", cardId: "c1", reason: "card_done" },
  ]) {
    const result = await waitForRetro({
      runIds: ["r1", "r2"],
      readLog: () => line({ runId: "r1", outcome: "skipped", ...extra }),
      skillCount: async () => 0,
      skillsBefore: 0,
      ...clock(),
    });
    expect(result).toMatchObject({
      ended: "logged",
      outcome: "skipped",
      waitedMs: 0,
    });
  }
  // The last round of a plain turn skipped without the step reason (cooldown, switched off): also over.
  const last = await waitForRetro({
    runIds: ["r1"],
    readLog: () =>
      line({ runId: "r1", outcome: "skipped", trigger: "steps", steps: 20 }),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(last).toMatchObject({ ended: "logged", waitedMs: 0 });
});

test("a failed earlier round is not the card's review, but a failed last round has nothing more coming", async () => {
  const failedLine = (runId: string) =>
    line({
      runId,
      outcome: "skipped",
      trigger: "steps",
      reason: "failed",
      steps: 4,
    });
  const early = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => failedLine("r1"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(early.ended).toBe("timeout");
  const last = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () => failedLine("r2"),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(last).toMatchObject({ ended: "logged", waitedMs: 0 });
});

test("a review saved in an earlier round ends the wait", async () => {
  const result = await waitForRetro({
    runIds: ["r1", "r2"],
    readLog: () =>
      line({
        runId: "r1",
        outcome: "saved",
        trigger: "card_delivered",
        steps: 8,
      }),
    skillCount: async () => 0,
    skillsBefore: 0,
    ...clock(),
  });
  expect(result).toMatchObject({
    ended: "logged",
    outcome: "saved",
    waitedMs: 0,
  });
});
