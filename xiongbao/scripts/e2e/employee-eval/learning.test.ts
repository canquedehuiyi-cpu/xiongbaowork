import { expect, test } from "bun:test";
import {
  type LearnedState,
  learningDiff,
  RETRO_WAIT_MS,
  retroLinesOf,
  waitForRetro,
} from "./learning";
import { renderReport, learningRows } from "./report";
import { combineRepeat, type EvalRecord, type EvalResults } from "./records";
import type { Capabilities } from "./metrics";

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
  let counts = [0, 0, 1];
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
