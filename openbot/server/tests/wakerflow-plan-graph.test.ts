import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  WAKERFLOW_END,
  WAKERFLOW_STEP_KINDS,
  type WakerFlowPlan,
  type WakerFlowStep,
} from "../../shared/wakerflows";
import { stepInstruction } from "../src/pipeline/store";
import {
  createFlowGenerator,
  FlowPlanFormatError,
} from "../src/wakerflows/generator";
import {
  compiledSteps,
  conditionReferences,
  createWakerFlowPlanSchema,
  templateReferences,
  wakerFlowPlanSchema,
} from "../src/wakerflows/plan";

/**
 * WF7-1 (spec 2026-11-04-wf7 §3.1-§3.2, §6.1): the plan's step kinds, forward-only jumps, the
 * dominance check of what each step may read, CEL syntax on Save, and the worker prompt. Pure: no
 * database, no model.
 */

const FLOW_ID = "0b6f2b8e-6c1f-4c55-9d7c-3a2f0d9e8a11";
/** Every kind and jumps, as the schema will be once every WF7 stage has landed. */
const full = createWakerFlowPlanSchema({
  kinds: WAKERFLOW_STEP_KINDS,
  jumps: true,
});

const worker = (
  id: string,
  inputKeys: string[],
  outputKey: string,
  extra: Partial<Extract<WakerFlowStep, { agentId: string }>> = {},
): WakerFlowStep => ({
  id,
  agentId: "writer",
  instruction: `做 ${id}`,
  inputKeys,
  outputKey,
  ...extra,
});

const base = (steps: WakerFlowStep[]): WakerFlowPlan => ({
  name: "分支流程",
  description: "",
  members: [
    { agentId: "writer", role: "撰写" },
    { agentId: "reviewer", role: "审核" },
  ],
  inputs: [
    { key: "topic", label: "主题", required: true },
    { key: "level", label: "级别", required: false, type: "number" },
  ],
  steps,
});

/** decide → a1 (→ join) | b1 → join: the shape most tests vary. */
const branching = (
  overrides: { a1?: Partial<WakerFlowStep>; join?: string[] } = {},
): WakerFlowPlan =>
  base([
    {
      id: "decide",
      kind: "decision",
      inputKeys: ["topic"],
      branches: [{ label: "长", when: "size(inputs.topic) > 3", next: "a1" }],
      otherwise: "b1",
    },
    {
      ...worker("a1", ["topic"], "a_out"),
      next: "join",
      ...overrides.a1,
    } as WakerFlowStep,
    worker("b1", ["topic"], "b_out"),
    worker("join", overrides.join ?? ["topic"], "final"),
  ]);

function problems(plan: unknown) {
  const parsed = full.safeParse(plan);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
}

describe("plans saved before WF7", () => {
  const legacy = {
    name: "周报",
    description: "先汇总再审核",
    members: [
      { agentId: "writer", role: "汇总" },
      { agentId: "reviewer", role: "审核" },
    ],
    inputs: [{ key: "notes", label: "工作记录", required: true }],
    steps: [
      {
        id: "draft",
        agentId: "writer",
        instruction: "汇总工作记录",
        inputKeys: ["notes"],
        outputKey: "report",
      },
      {
        id: "review",
        agentId: "reviewer",
        instruction: "审核报告",
        inputKeys: ["report"],
        outputKey: "reviewed_report",
      },
    ],
  };

  test("parse to exactly what they were, with no kind added", () => {
    expect(wakerFlowPlanSchema.parse(legacy)).toEqual(legacy);
    expect(full.parse(legacy)).toEqual(legacy);
    expect(
      Object.keys(wakerFlowPlanSchema.parse(legacy).steps[0] ?? {}),
    ).not.toContain("kind");
  });

  test("compile to the same template steps as before", () => {
    expect(compiledSteps(legacy)).toEqual(legacy.steps);
  });

  test("keep every rule they were held to", () => {
    expect(
      problems({
        ...legacy,
        steps: [
          { ...legacy.steps[0], inputKeys: ["reviewed_report"] },
          legacy.steps[1],
        ],
      }).map((problem) => problem.message),
    ).toContain(
      "输入 reviewed_report 尚未产生；只能读取流程输入或前面步骤的输出。",
    );
    for (const change of [
      { agentId: "outsider" },
      { outputKey: "notes" },
      { id: "review" },
    ])
      expect(
        problems({
          ...legacy,
          steps: [{ ...legacy.steps[0], ...change }, legacy.steps[1]],
        }).length,
      ).toBeGreaterThan(0);
  });

  test("an explicit worker kind is the same step", () => {
    const explicit = {
      ...legacy,
      steps: legacy.steps.map((step) => ({ ...step, kind: "worker" })),
    };
    expect(full.safeParse(explicit).success).toBe(true);
  });
});

describe("step limit (D4)", () => {
  const many = (count: number) =>
    base(
      Array.from({ length: count }, (_, index) =>
        worker(`s${index}`, [], `o${index}`),
      ),
    );
  test("twenty steps are accepted and twenty-one are not", () => {
    expect(wakerFlowPlanSchema.safeParse(many(20)).success).toBe(true);
    expect(problems(many(21)).map((problem) => problem.message)).toContain(
      "计划里最多 20 个步骤。",
    );
  });
});

describe("forward-only jumps (P-A)", () => {
  const valid: [string, WakerFlowPlan][] = [
    ["a branch joining a later step", branching()],
    [
      "a worker jumping to the end",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "停", when: "true", next: "a" }],
          otherwise: "b",
        },
        worker("a", [], "x", { next: WAKERFLOW_END }),
        worker("b", [], "y", { next: "c" }),
        worker("c", [], "z"),
      ]),
    ],
    [
      "a jump to the very next step",
      base([worker("a", [], "x", { next: "b" }), worker("b", ["x"], "y")]),
    ],
    [
      "a decision whose otherwise ends the run",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "继续", when: "true", next: "a" }],
          otherwise: WAKERFLOW_END,
        },
        worker("a", [], "x"),
      ]),
    ],
    [
      "two branches to the same step",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: ["topic"],
          branches: [
            { label: "一", when: 'inputs.topic == "a"', next: "b" },
            { label: "二", when: 'inputs.topic == "b"', next: "b" },
          ],
          otherwise: "b",
        },
        worker("b", ["topic"], "x"),
      ]),
    ],
    [
      "eight branches",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: Array.from({ length: 8 }, (_, index) => ({
            label: `分支${index}`,
            when: `${index} == 1`,
            next: "a",
          })),
          otherwise: "a",
        },
        worker("a", [], "x"),
      ]),
    ],
    [
      "a nested Flow jumping past a step",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "嵌套", when: "true", next: "child" }],
          otherwise: "b",
        },
        {
          id: "child",
          kind: "flow",
          targetFlowId: FLOW_ID,
          targetRevision: 2,
          inputMap: { notes: "topic" },
          outputKey: "child_out",
          next: "c",
        },
        worker("b", [], "y"),
        worker("c", ["topic"], "z"),
      ]),
    ],
    [
      "an action jumping to the end",
      base([
        {
          id: "post",
          kind: "action",
          agentId: "writer",
          tool: "slack/post_message",
          args: { text: "{{topic}}" },
          inputKeys: ["topic"],
          outputKey: "posted",
          next: WAKERFLOW_END,
        },
      ]),
    ],
    [
      "decisions in a row",
      base([
        {
          id: "d1",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "是", when: "true", next: "d2" }],
          otherwise: "a",
        },
        {
          id: "d2",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "是", when: "false", next: "a" }],
          otherwise: "b",
        },
        worker("a", [], "x", { next: WAKERFLOW_END }),
        worker("b", [], "y"),
      ]),
    ],
    [
      "a decision as the last step but one",
      base([
        worker("a", [], "x"),
        {
          id: "d",
          kind: "decision",
          inputKeys: ["x"],
          branches: [{ label: "空", when: 'outputs.x == ""', next: "b" }],
          otherwise: WAKERFLOW_END,
        },
        worker("b", [], "y"),
      ]),
    ],
  ];
  for (const [name, plan] of valid)
    test(`accepted: ${name}`, () => {
      expect(problems(plan)).toEqual([]);
    });

  const invalid: [string, WakerFlowPlan, string, string][] = [
    [
      "a worker jumping backwards",
      base([
        worker("a", [], "x"),
        worker("b", [], "y", { next: "a" }),
        worker("c", [], "z"),
      ]),
      "steps.1.next",
      "只能跳到后面的步骤；a 不在这一步之后。",
    ],
    [
      "a worker jumping to itself",
      base([worker("a", [], "x", { next: "a" }), worker("b", [], "y")]),
      "steps.0.next",
      "只能跳到后面的步骤；a 不在这一步之后。",
    ],
    [
      "a jump to a step that does not exist",
      base([worker("a", [], "x", { next: "ghost" }), worker("b", [], "y")]),
      "steps.0.next",
      "跳转目标 ghost 不存在。",
    ],
    [
      "a branch pointing backwards",
      base([
        worker("a", [], "x"),
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "回去", when: "true", next: "a" }],
          otherwise: "b",
        },
        worker("b", [], "y"),
      ]),
      "steps.1.branches.0.next",
      "只能跳到后面的步骤；a 不在这一步之后。",
    ],
    [
      "an otherwise pointing nowhere",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "是", when: "true", next: "a" }],
          otherwise: "nowhere",
        },
        worker("a", [], "x"),
      ]),
      "steps.0.otherwise",
      "跳转目标 nowhere 不存在。",
    ],
    [
      "a step no path reaches",
      base([
        worker("a", [], "x", { next: "c" }),
        worker("b", [], "y"),
        worker("c", [], "z"),
      ]),
      "steps.1",
      "没有任何路径会走到步骤 b。",
    ],
    [
      "a malformed jump target",
      base([
        worker("a", [], "x", { next: "Not A Step" }),
        worker("b", [], "y"),
      ]),
      "steps.0.next",
      "跳转目标无效。",
    ],
    [
      "a decision with no branches",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [],
          otherwise: "a",
        },
        worker("a", [], "x"),
      ]),
      "steps.0.branches",
      "判断至少需要一个分支。",
    ],
    [
      "a decision with nine branches",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: Array.from({ length: 9 }, (_, index) => ({
            label: `分支${index}`,
            when: "true",
            next: "a",
          })),
          otherwise: "a",
        },
        worker("a", [], "x"),
      ]),
      "steps.0.branches",
      "一个判断最多 8 个分支。",
    ],
    [
      "a decision carrying its own next",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "是", when: "true", next: "a" }],
          otherwise: "a",
          next: "a",
        } as WakerFlowStep,
        worker("a", [], "x"),
      ]),
      // A decision's routes are its branches; a stray `next` is a field it does not have.
      "steps.0",
      'Unrecognized key: "next"',
    ],
    [
      "an unknown kind",
      base([{ ...worker("a", [], "x"), kind: "loop" } as never]),
      "steps.0.kind",
      "未知的步骤类型。",
    ],
  ];
  for (const [name, plan, path, message] of invalid)
    test(`refused: ${name}`, () => {
      expect(problems(plan)).toContainEqual({ path, message });
    });
});

describe("what a step may read (dominance)", () => {
  const valid: [string, WakerFlowPlan][] = [
    ["a join reading a flow input", branching()],
    [
      "a step after both branches reading what precedes the decision",
      base([
        worker("first", [], "early"),
        {
          id: "d",
          kind: "decision",
          inputKeys: ["early"],
          branches: [{ label: "有", when: 'outputs.early != ""', next: "a" }],
          otherwise: "b",
        },
        worker("a", ["early"], "a_out", { next: "join" }),
        worker("b", ["early"], "b_out"),
        worker("join", ["early"], "final"),
      ]),
    ],
    [
      "a step inside a branch reading that branch's own output",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "甲", when: "true", next: "a1" }],
          otherwise: "b1",
        },
        worker("a1", [], "a_out"),
        worker("a2", ["a_out"], "a2_out", { next: WAKERFLOW_END }),
        worker("b1", [], "b_out"),
      ]),
    ],
    [
      "a linear chain reading every earlier output",
      base([
        worker("a", ["topic"], "x"),
        worker("b", ["x", "topic"], "y"),
        worker("c", ["x", "y", "level"], "z"),
      ]),
    ],
    [
      "a join reading a key both branches produce through a common step",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "甲", when: "true", next: "a" }],
          otherwise: "b",
        },
        worker("a", [], "a_out", { next: "common" }),
        worker("b", [], "b_out"),
        worker("common", [], "both"),
        worker("join", ["both"], "final"),
      ]),
    ],
    [
      "a nested Flow mapping in an earlier output",
      base([
        worker("a", [], "x"),
        {
          id: "child",
          kind: "flow",
          targetFlowId: FLOW_ID,
          targetRevision: 1,
          inputMap: { notes: "x", title: "topic" },
          outputKey: "child_out",
          resultKey: "summary",
        },
      ]),
    ],
    [
      "an action reading an earlier output in its template",
      base([
        worker("a", [], "x"),
        {
          id: "post",
          kind: "action",
          agentId: "reviewer",
          tool: "slack/post_message",
          args: { text: "结论：{{ x }}", channel: "general" },
          inputKeys: ["x"],
          outputKey: "posted",
        },
      ]),
    ],
    [
      "a decision reading an output of an action",
      base([
        {
          id: "lookup",
          kind: "action",
          agentId: "writer",
          tool: "crm/find",
          args: { q: "{{topic}}" },
          inputKeys: ["topic"],
          outputKey: "found",
        },
        {
          id: "d",
          kind: "decision",
          inputKeys: ["found"],
          branches: [
            { label: "找到", when: 'outputs["found"] != ""', next: "a" },
          ],
          otherwise: WAKERFLOW_END,
        },
        worker("a", ["found"], "x"),
      ]),
    ],
    [
      "a step after a jump-to-end branch reading only the surviving branch",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "停", when: "true", next: "stop" }],
          otherwise: "go",
        },
        worker("stop", [], "s_out", { next: WAKERFLOW_END }),
        worker("go", [], "g_out"),
        worker("after", ["g_out"], "final"),
      ]),
    ],
    ["a join that reads nothing", branching({ join: [] })],
  ];
  for (const [name, plan] of valid)
    test(`accepted: ${name}`, () => {
      expect(problems(plan)).toEqual([]);
    });

  const partial = (key: string) =>
    `输入 ${key} 只在部分分支中产生；走到这一步的其他路径上没有它。`;
  const never = (key: string) =>
    `输入 ${key} 尚未产生；只能读取流程输入或前面步骤的输出。`;
  const invalid: [string, WakerFlowPlan, string, string][] = [
    [
      "a join reading the A branch's output",
      branching({ join: ["a_out"] }),
      "steps.3.inputKeys",
      partial("a_out"),
    ],
    [
      "a join reading the B branch's output",
      branching({ join: ["b_out"] }),
      "steps.3.inputKeys",
      partial("b_out"),
    ],
    [
      "a step in branch B reading branch A's output",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "甲", when: "true", next: "a" }],
          otherwise: "b",
        },
        worker("a", [], "a_out", { next: WAKERFLOW_END }),
        worker("b", ["a_out"], "b_out"),
      ]),
      "steps.2.inputKeys",
      never("a_out"),
    ],
    [
      "a step after a skipped-over step reading its output",
      base([
        worker("a", [], "x", { next: "c" }),
        worker("b", [], "y"),
        worker("c", ["y"], "z"),
      ]),
      "steps.2.inputKeys",
      never("y"),
    ],
    [
      "a decision reading a later output",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: ["x"],
          branches: [{ label: "有", when: 'outputs.x != ""', next: "a" }],
          otherwise: "a",
        },
        worker("a", [], "x"),
      ]),
      "steps.0.inputKeys",
      never("x"),
    ],
    [
      "a nested Flow mapping in a branch-only output",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "甲", when: "true", next: "a" }],
          otherwise: "child",
        },
        worker("a", [], "a_out"),
        {
          id: "child",
          kind: "flow",
          targetFlowId: FLOW_ID,
          targetRevision: 1,
          inputMap: { notes: "a_out" },
          outputKey: "child_out",
        },
      ]),
      "steps.2.inputMap",
      partial("a_out"),
    ],
    [
      "an action declaring a key it cannot have",
      base([
        {
          id: "post",
          kind: "action",
          agentId: "writer",
          tool: "slack/post_message",
          args: { text: "{{later}}" },
          inputKeys: ["later"],
          outputKey: "posted",
        },
        worker("a", [], "later"),
      ]),
      "steps.0.inputKeys",
      never("later"),
    ],
    [
      "two branches producing the same key",
      base([
        {
          id: "d",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "甲", when: "true", next: "a" }],
          otherwise: "b",
        },
        worker("a", [], "same", { next: "join" }),
        worker("b", [], "same"),
        worker("join", ["same"], "final"),
      ]),
      "steps.2.outputKey",
      "步骤输出不能覆盖已有输入或输出。",
    ],
    [
      "a join two decisions deep reading an inner branch's output",
      base([
        {
          id: "d1",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "甲", when: "true", next: "d2" }],
          otherwise: "join",
        },
        {
          id: "d2",
          kind: "decision",
          inputKeys: [],
          branches: [{ label: "乙", when: "true", next: "inner" }],
          otherwise: "join",
        },
        worker("inner", [], "inner_out"),
        worker("join", ["inner_out"], "final"),
      ]),
      "steps.3.inputKeys",
      partial("inner_out"),
    ],
    [
      "an action template reading an undeclared key",
      base([
        worker("a", [], "x"),
        {
          id: "post",
          kind: "action",
          agentId: "writer",
          tool: "slack/post_message",
          args: { text: "{{x}} 与 {{topic}}" },
          inputKeys: ["x"],
          outputKey: "posted",
        },
      ]),
      "steps.1.args.text",
      "参数 text 引用了 {{topic}}，但这一步没有声明读取它。",
    ],
  ];
  for (const [name, plan, path, message] of invalid)
    test(`refused: ${name}`, () => {
      expect(problems(plan)).toContainEqual({ path, message });
    });
});

describe("decision conditions (CEL)", () => {
  const decision = (when: string, inputKeys = ["topic", "level", "draft"]) =>
    base([
      worker("draft_step", [], "draft"),
      {
        id: "d",
        kind: "decision",
        inputKeys,
        branches: [{ label: "条件", when, next: "a" }],
        otherwise: "a",
      },
      worker("a", [], "x"),
    ]);
  const valid = [
    'inputs.topic == "周报"',
    "size(inputs.topic) > 10",
    'contains(outputs.draft, "风险")',
    'startsWith(inputs.topic, "Q")',
    'matches(outputs.draft, "^通过")',
    "int(inputs.level) >= 3",
    "double(inputs.level) < 2.5",
    'inputs.topic in ["甲", "乙"]',
    '!(outputs.draft == "") && inputs.level != "0"',
    'outputs["draft"] == "好" || inputs.topic == "坏"',
    "true",
  ];
  for (const when of valid)
    test(`accepted: ${when}`, () => {
      expect(problems(decision(when))).toEqual([]);
    });

  const invalid: [string, string, string[]?][] = [
    ["1 +", "分支「条件」的条件不是有效的 CEL 表达式。"],
    ['inputs.topic == "', "分支「条件」的条件不是有效的 CEL 表达式。"],
    ["(inputs.topic", "分支「条件」的条件不是有效的 CEL 表达式。"],
    ["inputs.topic ==", "分支「条件」的条件不是有效的 CEL 表达式。"],
    ["&& true", "分支「条件」的条件不是有效的 CEL 表达式。"],
    ["size(", "分支「条件」的条件不是有效的 CEL 表达式。"],
    [
      'inputs.secret == "x"',
      "分支「条件」读取了 inputs.secret，但这一步没有声明读取 secret。",
    ],
    [
      'outputs.draft == "x"',
      "分支「条件」读取了 outputs.draft，但这一步没有声明读取 draft。",
      ["topic"],
    ],
    ['outputs.topic == "x"', "topic 是流程输入，请写成 inputs.topic。"],
    ['inputs.draft == "x"', "draft 不是流程输入，请写成 outputs.draft。"],
    ["", "请填写分支条件。"],
    ["x".repeat(501), "分支条件不能超过 500 字。"],
  ];
  for (const [when, message, keys] of invalid)
    test(`refused: ${when.slice(0, 30) || "(empty)"}`, () => {
      expect(
        problems(decision(when, keys)).map((problem) => problem.message),
      ).toContain(message);
    });

  test("branch labels are unique within a decision", () => {
    const plan = base([
      {
        id: "d",
        kind: "decision",
        inputKeys: [],
        branches: [
          { label: "同名", when: "true", next: "a" },
          { label: "同名", when: "false", next: "a" },
        ],
        otherwise: "a",
      },
      worker("a", [], "x"),
    ]);
    expect(problems(plan)).toContainEqual({
      path: "steps.0.branches.1.label",
      message: "同一个判断里的分支名称不能重复。",
    });
  });

  test("references are read from the expression as written", () => {
    expect(
      conditionReferences(
        "inputs.a == outputs.b && outputs['c'] != inputs[\"d\"]",
      ),
    ).toEqual([
      { scope: "inputs", key: "a" },
      { scope: "outputs", key: "b" },
      { scope: "outputs", key: "c" },
      { scope: "inputs", key: "d" },
    ]);
    expect(templateReferences("{{a}} {{ b }} {c} {{}}")).toEqual([
      "a",
      "b",
      "",
    ]);
  });
});

describe("other node fields", () => {
  test("a decision and a nested Flow name no coworker; worker and action steps must name a member", () => {
    const plan = base([
      {
        id: "post",
        kind: "action",
        agentId: "outsider",
        tool: "slack/post_message",
        args: {},
        inputKeys: [],
        outputKey: "posted",
      },
    ]);
    expect(problems(plan)).toContainEqual({
      path: "steps.0.agentId",
      message: "步骤只能交给计划中的员工。",
    });
  });
  test("a tool is named as server/tool", () => {
    const plan = base([
      {
        id: "post",
        kind: "action",
        agentId: "writer",
        tool: "no-slash",
        args: {},
        inputKeys: [],
        outputKey: "posted",
      },
    ]);
    expect(problems(plan)).toContainEqual({
      path: "steps.0.tool",
      message: "请选择要调用的工具。",
    });
  });
  test("an argument value is bounded", () => {
    const plan = base([
      {
        id: "post",
        kind: "action",
        agentId: "writer",
        tool: "slack/post_message",
        args: { text: "长".repeat(10001) },
        inputKeys: [],
        outputKey: "posted",
      },
    ]);
    expect(problems(plan)).toContainEqual({
      path: "steps.0.args.text",
      message: "单个参数不能超过 10000 字。",
    });
  });
  test("a nested Flow names a Flow and a saved revision", () => {
    const plan = base([
      {
        id: "child",
        kind: "flow",
        targetFlowId: "not-a-flow",
        targetRevision: 0,
        inputMap: {},
        outputKey: "out",
      },
    ]);
    const found = problems(plan).map((problem) => problem.message);
    expect(found).toContain("请选择要嵌套的子流程。");
    expect(found).toContain("子流程版本无效。");
  });
  test("a member's prompt is at most 4000 characters", () => {
    const plan = branching();
    expect(
      problems({
        ...plan,
        members: [
          { agentId: "writer", role: "撰写", prompt: "长".repeat(4001) },
        ],
      }).map((problem) => problem.message),
    ).toContain("员工提示词不能超过 4000 字。");
  });
});

describe("what the server runs today", () => {
  test("every step kind and jumps are accepted on Save now that each one runs", () => {
    expect(wakerFlowPlanSchema.safeParse(branching()).success).toBe(true);
    const later = base([
      {
        id: "child",
        kind: "flow",
        targetFlowId: FLOW_ID,
        targetRevision: 1,
        inputMap: {},
        outputKey: "child_out",
      },
      {
        id: "post",
        kind: "action",
        agentId: "writer",
        tool: "slack/post_message",
        args: {},
        inputKeys: [],
        outputKey: "posted",
      },
    ]);
    expect(wakerFlowPlanSchema.safeParse(later).success).toBe(true);
  });

  test("an action calls an MCP tool only, never a computer, host or hand-off action (D7)", () => {
    for (const tool of [
      "host/run_command",
      "bot/handoff",
      "openbot/share_private_information",
    ])
      expect(
        problems(
          base([
            {
              id: "post",
              kind: "action",
              agentId: "writer",
              tool,
              args: {},
              inputKeys: [],
              outputKey: "posted",
            },
          ]),
        ).map((problem) => problem.path),
      ).toContain("steps.0.tool");
  });

  test("the planning model is held to coworker steps without jumps (D9)", async () => {
    const answer = (plan: WakerFlowPlan) =>
      createFlowGenerator({
        generate: async () => ({ text: JSON.stringify(plan) }),
      }).plan({
        model: "fake/planner" as unknown as LanguageModel,
        idea: "分支",
        members: [
          { agentId: "writer", name: "小写", role: "撰写" },
          { agentId: "reviewer", name: "小审", role: "审核" },
        ],
      });
    await expect(answer(branching())).rejects.toBeInstanceOf(
      FlowPlanFormatError,
    );
    const linear = base([worker("a", ["topic"], "x"), worker("b", ["x"], "y")]);
    await expect(answer(linear)).resolves.toEqual(linear);
    await expect(
      answer(
        base([
          worker("a", ["topic"], "x", { next: "c" }),
          worker("b", [], "y"),
          worker("c", [], "z"),
        ]),
      ),
    ).rejects.toBeInstanceOf(FlowPlanFormatError);
  });
});

describe("worker prompt (D2)", () => {
  const plan: WakerFlowPlan = {
    ...base([
      worker("draft", ["topic"], "report"),
      worker("polish", ["report"], "final"),
      worker("review", ["final"], "verdict", { agentId: "reviewer" }),
    ]),
    members: [
      {
        agentId: "writer",
        role: "撰写",
        prompt: "你负责初稿和润色，语气正式。",
      },
      { agentId: "reviewer", role: "审核" },
    ],
  };

  test("a member's prompt is compiled onto each of that coworker's steps, and only theirs", () => {
    const steps = compiledSteps(plan);
    expect(steps[0]?.rolePrompt).toBe("撰写\n你负责初稿和润色，语气正式。");
    expect(steps[1]?.rolePrompt).toBe("撰写\n你负责初稿和润色，语气正式。");
    expect(steps[2]).not.toHaveProperty("rolePrompt");
  });

  test("an empty prompt is no prompt", () => {
    const steps = compiledSteps({
      ...plan,
      members: [
        { agentId: "writer", role: "撰写", prompt: "   " },
        { agentId: "reviewer", role: "审核" },
      ],
    });
    expect(steps.some((step) => "rolePrompt" in step)).toBe(false);
  });

  test("each of that coworker's steps is told its role first, before its own instruction", () => {
    const steps = compiledSteps(plan);
    const records = steps.map((step) => ({
      ...step,
      state: "pending" as const,
    }));
    for (const [index, record] of records.entries()) {
      const instruction = stepInstruction({
        record,
        task: "写周报",
        inputs: { topic: "周报" },
        earlier: records.slice(0, index),
        prior: [],
        missing: [],
      });
      if (record.agentId === "writer") {
        expect(
          instruction.startsWith(
            "本流程中你的角色：撰写\n你负责初稿和润色，语气正式。\n\n",
          ),
        ).toBe(true);
        expect(instruction).toContain(`${record.instruction}\n\n任务：写周报`);
      } else {
        expect(instruction.startsWith(record.instruction)).toBe(true);
        expect(instruction).not.toContain("本流程中你的角色");
      }
    }
  });
});

describe("confirmation steps (WF8 §3.3's 确认节点)", () => {
  const ask = (
    extra: Partial<Extract<WakerFlowStep, { kind: "confirm" }>> = {},
  ): WakerFlowStep => ({
    id: "ask",
    kind: "confirm",
    question: "主题「{{topic}}」的草稿：{{draft}}。可以发布吗？",
    inputKeys: ["topic", "draft"],
    outputKey: "approved",
    ...extra,
  });
  const three = (middle: WakerFlowStep, last?: WakerFlowStep) =>
    base([
      worker("write", ["topic"], "draft"),
      middle,
      last ?? worker("publish", ["approved"], "final"),
    ]);

  test("is accepted on Save, names no coworker, and its output is read like any other", () => {
    expect(wakerFlowPlanSchema.safeParse(three(ask())).success).toBe(true);
    // The planning model's own kinds are untouched: still workers only (D9).
    expect(problems(three(ask()))).toEqual([]);
  });

  test("compiles to a template step that holds its question and no coworker", () => {
    const plan = three(ask({ next: WAKERFLOW_END }));
    expect(compiledSteps(plan)[1]).toEqual({
      id: "ask",
      kind: "confirm",
      agentId: "",
      instruction: "主题「{{topic}}」的草稿：{{draft}}。可以发布吗？",
      inputKeys: ["topic", "draft"],
      outputKey: "approved",
      next: WAKERFLOW_END,
    });
  });

  test("refused: an empty question, or one over 2000 characters", () => {
    expect(problems(three(ask({ question: "   " })))).toContainEqual({
      path: "steps.1.question",
      message: "请填写要确认的问题。",
    });
    expect(
      problems(three(ask({ question: "长".repeat(2001), inputKeys: [] }))),
    ).toContainEqual({
      path: "steps.1.question",
      message: "确认问题不能超过 2000 字。",
    });
    expect(
      problems(three(ask({ question: "长".repeat(2000), inputKeys: [] }))),
    ).toEqual([]);
  });

  test("refused: a {{key}} the step does not declare reading", () => {
    expect(
      problems(three(ask({ inputKeys: ["topic"] }))).map(
        (problem) => problem.message,
      ),
    ).toContain("问题引用了 {{draft}}，但这一步没有声明读取它。");
  });

  test("refused: a coworker, an instruction or an unknown field (it is not a worker)", () => {
    for (const extra of [
      { agentId: "writer" },
      { instruction: "做点什么" },
      { branches: [] },
    ])
      expect(
        problems(three({ ...ask(), ...extra } as unknown as WakerFlowStep))
          .length,
      ).toBeGreaterThan(0);
  });

  test("joins the forward-only and dominance checks like the other kinds", () => {
    // Reading an output nobody has produced yet.
    expect(
      problems(
        base([
          ask({ question: "{{draft}}?", inputKeys: ["draft"] }),
          worker("write", ["topic"], "draft"),
        ]),
      ).map((problem) => problem.message),
    ).toContain("输入 draft 尚未产生；只能读取流程输入或前面步骤的输出。");
    // A backward jump.
    expect(
      problems(three(ask({ next: "write" }))).map((problem) => problem.path),
    ).toContain("steps.1.next");
    // On one branch only: the step after the join may not read its answer.
    const branched = base([
      {
        id: "decide",
        kind: "decision",
        inputKeys: ["topic"],
        branches: [
          { label: "问", when: "size(inputs.topic) > 3", next: "ask" },
        ],
        otherwise: "join",
      },
      ask({ question: "{{topic}}?", inputKeys: ["topic"] }),
      worker("join", ["approved"], "final"),
    ]);
    expect(problems(branched).map((problem) => problem.message)).toContain(
      "输入 approved 只在部分分支中产生；走到这一步的其他路径上没有它。",
    );
    // A jump that passes over the only way into a step leaves that step unreachable.
    expect(
      problems(
        base([
          ask({ question: "{{topic}}?", inputKeys: ["topic"], next: "end" }),
          worker("middle", ["approved"], "mid"),
          worker("end", ["approved"], "final"),
        ]),
      ).map((problem) => problem.message),
    ).toContain("没有任何路径会走到步骤 middle。");
  });

  test("its output may not overwrite an input or another output", () => {
    expect(
      problems(three(ask({ outputKey: "draft" }))).map(
        (problem) => problem.message,
      ),
    ).toContain("步骤输出不能覆盖已有输入或输出。");
  });

  test("the planning model still makes coworker steps only (D9)", async () => {
    const generated = createFlowGenerator({
      generate: async () => ({ text: JSON.stringify(three(ask())) }),
    }).plan({
      model: "fake/planner" as unknown as LanguageModel,
      idea: "确认",
      members: [
        { agentId: "writer", name: "小写", role: "撰写" },
        { agentId: "reviewer", name: "小审", role: "审核" },
      ],
    });
    await expect(generated).rejects.toBeInstanceOf(FlowPlanFormatError);
  });
});
