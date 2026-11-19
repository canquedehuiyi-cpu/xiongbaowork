import { describe, expect, test } from "bun:test";
import {
  type DecisionStep,
  decide,
  decisionContext,
  OTHERWISE_LABEL,
  routeAfter,
  stepBudget,
} from "../src/pipeline/decision";
import { confirmQuestion, type StepRecord } from "../src/pipeline/store";

/**
 * WF7-2 (spec 2026-11-04-wf7 §3.3, §6.2): the decision step's evaluation, as a pure function. The
 * order of branches, `otherwise`, failing closed on any evaluation error, and that a condition sees
 * only the keys its step declares.
 */

const step = (
  branches: { label: string; when: string; next: string }[],
  inputKeys = ["topic", "draft"],
): DecisionStep => ({
  id: "decide",
  inputKeys,
  branches,
  otherwise: "fallback",
});
const earlier = [
  { id: "write", outputKey: "draft", output: "草稿：有风险" },
  { id: "other", outputKey: "secret_out", output: "不该被读到" },
];
const inputs = { topic: "周报", level: "3", hidden: "不该被读到" };

describe("which branch is taken", () => {
  test("the first true branch wins, in order", () => {
    expect(
      decide(
        step([
          { label: "否", when: "false", next: "a" },
          { label: "第一个真", when: 'inputs.topic == "周报"', next: "b" },
          { label: "第二个真", when: "true", next: "c" },
        ]),
        inputs,
        earlier,
      ),
    ).toEqual({ ok: true, index: 1, label: "第一个真", next: "b" });
  });

  test("none true is otherwise, recorded as index -1", () => {
    expect(
      decide(
        step([
          { label: "甲", when: 'inputs.topic == "日报"', next: "a" },
          { label: "乙", when: 'contains(outputs.draft, "通过")', next: "b" },
        ]),
        inputs,
        earlier,
      ),
    ).toEqual({
      ok: true,
      index: -1,
      label: OTHERWISE_LABEL,
      next: "fallback",
    });
  });

  test("conditions read outputs and call the string and number helpers", () => {
    const cases: [string, boolean][] = [
      ['contains(outputs.draft, "风险")', true],
      ['startsWith(outputs.draft, "草稿")', true],
      ['endsWith(outputs.draft, "风险")', true],
      ['matches(outputs.draft, "^草稿：")', true],
      ["size(inputs.topic) == 2", true],
      ['inputs.topic in ["周报", "月报"]', true],
      ['!(outputs.draft == "")', true],
    ];
    for (const [when, expected] of cases) {
      const outcome = decide(
        step([{ label: "是", when, next: "a" }]),
        inputs,
        earlier,
      );
      expect(outcome).toEqual(
        expected
          ? { ok: true, index: 0, label: "是", next: "a" }
          : { ok: true, index: -1, label: OTHERWISE_LABEL, next: "fallback" },
      );
    }
    expect(
      decide(
        step(
          [{ label: "高", when: "int(inputs.level) >= 3", next: "a" }],
          ["level"],
        ),
        inputs,
        earlier,
      ),
    ).toMatchObject({ ok: true, index: 0 });
    expect(
      decide(
        step(
          [{ label: "低", when: "double(inputs.level) < 2.5", next: "a" }],
          ["level"],
        ),
        inputs,
        earlier,
      ),
    ).toMatchObject({ ok: true, index: -1 });
  });
});

describe("fail closed", () => {
  const failing: [string, string][] = [
    ["a type error", "inputs.topic > 3"],
    ["an unknown field", 'inputs.nothing == "x"'],
    ["a number that is not one", "int(inputs.topic) > 1"],
    ["a non-boolean answer", "inputs.topic"],
    ["a syntax error", "1 +"],
    ["division by zero", "1 / 0 > 1"],
    ["a bad pattern", 'matches(inputs.topic, "(")'],
  ];
  for (const [name, when] of failing)
    test(`${name} fails the step and never takes otherwise`, () => {
      const outcome = decide(
        step([
          { label: "坏条件", when, next: "a" },
          { label: "本来为真", when: "true", next: "b" },
        ]),
        inputs,
        earlier,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("分支「坏条件」的条件（第 1 个）");
      expect(outcome.error).toContain("没有改走「否则」");
    });

  test("the error never carries a value the condition read", () => {
    const outcome = decide(
      step([{ label: "坏", when: 'inputs.nothing == "x"', next: "a" }]),
      inputs,
      earlier,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("读取了未声明的 nothing");
    expect(outcome.error).not.toContain("周报");
    expect(outcome.error).not.toContain("风险");
  });

  test("a declared output that was never produced fails the step", () => {
    const outcome = decide(
      step([{ label: "是", when: 'outputs.draft == ""', next: "a" }]),
      inputs,
      [{ id: "write", outputKey: "draft" }],
    );
    expect(outcome).toEqual({
      ok: false,
      error:
        "条件判断读取的 draft 没有产出（步骤 write 被跳过或已失败），无法判断。",
    });
  });
});

describe("what a condition can see", () => {
  test("only the declared keys, each in its namespace", () => {
    const read = decisionContext(step([]), inputs, earlier);
    expect(read).toEqual({
      ok: true,
      context: {
        inputs: { topic: "周报" },
        outputs: { draft: "草稿：有风险" },
      },
    });
  });

  test("an undeclared input or output is not there to read", () => {
    for (const when of [
      'inputs.hidden == "不该被读到"',
      'outputs.secret_out == "不该被读到"',
      'inputs.level == "3"',
    ]) {
      const outcome = decide(
        step([{ label: "偷看", when, next: "a" }]),
        inputs,
        earlier,
      );
      expect(outcome.ok).toBe(false);
    }
  });

  test("a declared optional input left empty reads as the empty string", () => {
    expect(
      decide(
        step([{ label: "空", when: 'inputs.note == ""', next: "a" }], ["note"]),
        {},
        [],
      ),
    ).toMatchObject({ ok: true, index: 0 });
  });
});

describe("routes and the month's budget", () => {
  // decide → a1 (→ join) | b1 → b2 → join
  const steps = [
    {
      id: "decide",
      kind: "decision" as const,
      branches: [{ label: "甲", when: "true", next: "a1" }],
      otherwise: "b1",
    },
    { id: "a1", next: "join" },
    { id: "b1" },
    { id: "b2" },
    { id: "join" },
  ];

  test("a step goes to its jump, the next step, or the end", () => {
    expect(routeAfter(steps, 1)).toBe(4);
    expect(routeAfter(steps, 2)).toBe(3);
    expect(routeAfter(steps, 4)).toBe(5);
    expect(routeAfter(steps, 0, "b1")).toBe(2);
    expect(routeAfter(steps, 0, "__end__")).toBe(5);
    // A target behind the step (which Save refuses) ends the run rather than loop.
    expect(routeAfter(steps, 3, "a1")).toBe(5);
  });

  test("the budget is the longest path's card-opening steps; a decision opens none", () => {
    // decide(0) + max(a1 + join, b1 + b2 + join) = 3
    expect(stepBudget(steps)).toBe(3);
    expect(stepBudget(steps, 1)).toBe(2);
    expect(stepBudget(steps, 2)).toBe(3);
  });

  test("a plan without decisions counts every remaining step, as before", () => {
    const linear = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(stepBudget(linear)).toBe(3);
    expect(stepBudget(linear, 1)).toBe(2);
  });
});

describe("a confirmation step (WF8 §3.3)", () => {
  test("asks a person, so it opens no card and costs nothing of the month's budget", () => {
    const steps = [
      { id: "draft" },
      { id: "ask", kind: "confirm" as const },
      { id: "publish" },
    ];
    expect(stepBudget(steps)).toBe(2);
    expect(stepBudget(steps, 1)).toBe(1);
    expect(stepBudget(steps, 2)).toBe(1);
    // A run of nothing but a question reserves no step at all.
    expect(stepBudget([{ id: "ask", kind: "confirm" as const }])).toBe(0);
  });

  test("on a branch, only the card-opening steps of the longest path count", () => {
    // decide → ask (→ join) | b1 → b2 → join
    const steps = [
      {
        id: "decide",
        kind: "decision" as const,
        branches: [{ label: "甲", when: "true", next: "ask" }],
        otherwise: "b1",
      },
      { id: "ask", kind: "confirm" as const, next: "join" },
      { id: "b1" },
      { id: "b2" },
      { id: "join" },
    ];
    expect(stepBudget(steps)).toBe(3);
    expect(stepBudget(steps, 1)).toBe(1);
  });

  const earlierSteps = [
    {
      id: "draft",
      agentId: "writer",
      instruction: "起草",
      outputKey: "drafted",
      output: "草稿正文",
      state: "done",
    },
    {
      id: "polish",
      agentId: "writer",
      instruction: "润色",
      outputKey: "polished",
      state: "skipped",
      skipReason: "person",
    },
  ] satisfies StepRecord[];

  test("fills each declared {{key}} from the inputs and earlier outputs, as text", () => {
    expect(
      confirmQuestion({
        record: {
          instruction: "主题「{{ topic }}」的草稿是：{{drafted}}。可以发布吗？",
          inputKeys: ["topic", "drafted"],
        },
        inputs: { topic: "发布会" },
        earlier: earlierSteps,
      }),
    ).toBe("主题「发布会」的草稿是：草稿正文。可以发布吗？");
  });

  test("a value that is itself a placeholder is not filled a second time", () => {
    expect(
      confirmQuestion({
        record: {
          instruction: "{{topic}} / {{drafted}}",
          inputKeys: ["topic", "drafted"],
        },
        inputs: { topic: "{{drafted}}" },
        earlier: earlierSteps,
      }),
    ).toBe("{{drafted}} / 草稿正文");
  });

  test("a key with no value reads as missing, and an undeclared one is left as written", () => {
    expect(
      confirmQuestion({
        record: {
          instruction: "润色稿：{{polished}}；{{secret}}",
          inputKeys: ["polished"],
        },
        inputs: { secret: "不该被读到" },
        earlier: earlierSteps,
      }),
    ).toBe("润色稿：（此输入未产生）；{{secret}}");
  });

  test("is never empty and is bounded", () => {
    expect(
      confirmQuestion({
        record: { instruction: "{{topic}}", inputKeys: ["topic"] },
        inputs: { topic: "  " },
        earlier: [],
      }),
    ).toBe("{{topic}}");
    const long = confirmQuestion({
      record: { instruction: "看一下：{{drafted}}", inputKeys: ["drafted"] },
      inputs: { drafted: "长".repeat(30000) },
      earlier: [],
    });
    expect(Array.from(long)).toHaveLength(20000);
    expect(long.endsWith("…")).toBe(true);
  });
});
