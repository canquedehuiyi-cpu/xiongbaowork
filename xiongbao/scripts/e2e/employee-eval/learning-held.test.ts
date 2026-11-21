import { expect, test } from "bun:test";
import {
  concludesRetro,
  type LearnedState,
  learningDiff,
  waitForRetro,
} from "./learning";
import type { Capabilities } from "./metrics";
import { combineRepeat, type EvalRecord, type EvalResults } from "./records";
import { learningRows, renderReport } from "./report";

/*
 * 「学没学到」表把复盘的结果分成三类：存为自用并生效（saved）、转待审没授予（held）、被拒没存（refused）；
 * 转待审的技能单独列出来，不混进「新增的自写技能」。
 */

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
  steps: 18,
  toolCalls: 17,
  modelCalls: 18,
  tokens: { input: 218_463, output: 4_000, total: 222_463, cachedInput: 0 },
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

const firstRunCell = (
  outcome: string,
  extra: {
    newSkills?: string[];
    heldSkills?: string[];
    replaced?: number;
  } = {},
) => {
  const repeated = combineRepeat(
    record({
      learning: {
        newSkills: extra.newSkills ?? [],
        ...(extra.heldSkills ? { heldSkills: extra.heldSkills } : {}),
        newMemories: 0,
        usedSkills: [],
        retro: {
          waitedMs: 15_000,
          ended: "logged",
          outcome,
          trigger: "card_delivered",
          steps: 19,
          ...(extra.replaced ? { replaced: extra.replaced } : {}),
        },
      },
    }),
    record({
      steps: 16,
      learning: { newSkills: [], newMemories: 0, usedSkills: [] },
    }),
  );
  return learningRows([["熊宝", side([repeated])]])[0] ?? [];
};

test("saved 照旧：技能进了账，行里写新增的技能名", () => {
  const row = firstRunCell("saved", { newSkills: ["办公题做法"] });
  expect(row[1]).toBe("saved（card_delivered / 19 步），等了 15 s");
  expect(row[2]).toBe("技能 1（「办公题做法」） / 记忆 0");
});

test("saved 且替换了员工自存的技能：行里写替换了几条", () => {
  const row = firstRunCell("saved", {
    newSkills: ["办公题做法"],
    replaced: 1,
  });
  expect(row[1]).toBe(
    "saved（card_delivered / 19 步），替换了员工自存的 1 条，等了 15 s",
  );
});

test("held：说明转待审、没授予；待审的技能单独列，不算新增的自写技能", () => {
  const row = firstRunCell("held", { heldSkills: ["办公题做法"] });
  expect(row[1]).toContain("held");
  expect(row[1]).toContain("待审");
  expect(row[1]).toContain("没授予");
  expect(row[1]).toContain("card_delivered / 19 步");
  expect(row[2]).toBe("技能 0 / 记忆 0 / 待审 1（「办公题做法」）");
});

test("refused：说明被拒、没存", () => {
  const row = firstRunCell("refused");
  expect(row[1]).toContain("refused");
  expect(row[1]).toContain("被拒");
  expect(row[1]).toContain("没存");
  expect(row[2]).toBe("技能 0 / 记忆 0");
});

test("三类的行互不相同，报告正文说明三类", () => {
  const cells = ["saved", "held", "refused"].map(
    (outcome) => firstRunCell(outcome)[1],
  );
  expect(new Set(cells).size).toBe(3);
  const markdown = renderReport([
    side([
      combineRepeat(
        record({
          learning: {
            newSkills: [],
            heldSkills: ["办公题做法"],
            newMemories: 0,
            usedSkills: [],
            retro: {
              waitedMs: 1000,
              ended: "logged",
              outcome: "held",
              trigger: "card_delivered",
              steps: 19,
            },
          },
        }),
        record({ steps: 16 }),
      ),
    ]),
  ]);
  expect(markdown).toContain("## 重复任务：学没学到");
  expect(markdown).toContain("待审");
});

test("没有待审技能时，学习记录里没有这一项", () => {
  const state = (skills: [string, string][], held: [string, string][] = []) =>
    ({
      skills: new Map(
        skills.map(([slug, title]) => [slug, { title, useCount: 0 }]),
      ),
      held: new Map(held),
      memories: 0,
    }) satisfies LearnedState;
  const plain = learningDiff(state([]), state([["a", "技能 A"]]));
  expect(plain).not.toHaveProperty("heldSkills");
  const withHeld = learningDiff(state([]), state([], [["h", "待审 H"]]));
  expect(withHeld.heldSkills).toEqual(["待审 H"]);
  expect(withHeld.newSkills).toEqual([]);
  // 运行前就在待审里的不算这次新增的。
  expect(
    learningDiff(state([], [["h", "待审 H"]]), state([], [["h", "待审 H"]])),
  ).not.toHaveProperty("heldSkills");
});

test("held 和 refused 的日志行都算复盘有结论，等待就此结束", async () => {
  for (const outcome of ["held", "refused"]) {
    expect(
      concludesRetro(
        { outcome, runId: "r1", trigger: "card_delivered", steps: 19 },
        true,
      ),
    ).toBe(true);
    const result = await waitForRetro({
      runIds: ["r1"],
      readLog: () =>
        `${JSON.stringify({ type: "retrospect", runId: "r1", outcome, trigger: "card_delivered", steps: 19 })}\n`,
      skillCount: async () => 0,
      skillsBefore: 0,
      now: () => 0,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ended: "logged", outcome });
  }
});
