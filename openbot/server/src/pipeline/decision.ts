import { evaluate } from "cel-js";
import type { PipelineStepRow } from "../db/schema/pipeline";

/**
 * WF7 decision steps (spec 2026-11-04-wf7 §3.3): the condition is evaluated by the orchestrator
 * itself, with no coworker, no turn and no model.
 *
 * Pure, so the rules are pinned by a test rather than read out of the driving loop:
 *
 *  - The condition sees `inputs.<key>` and `outputs.<key>` for exactly the keys the step declares
 *    (`inputKeys`), every value a string. A key an earlier step produces is an output; any other
 *    declared key is a Flow input. Nothing else of the run is visible.
 *  - The branches are tried in order and the first that is `true` is taken; when none is, the
 *    step's `otherwise`.
 *  - Fail closed: an expression that does not parse, throws (a type error, an unknown field, a bad
 *    number), or answers anything other than a boolean fails the step; it never falls through to
 *    `otherwise`. A declared output that was not produced (its step was skipped or failed) fails it
 *    too, because a branch chosen on a gap is a guess.
 *
 * The error sentences are this product's own: cel-js puts the whole evaluation context into some of
 * its messages, and that context holds earlier steps' outputs, which a step's error (and the run
 * event that summarises it) must not carry.
 */

/** The fields of a step the decision reads. */
export type DecisionStep = Pick<
  PipelineStepRow,
  "id" | "inputKeys" | "branches" | "otherwise"
>;

/** What a decision reads of an earlier step. */
export type EarlierStep = { id: string; outputKey?: string; output?: string };

/** Which branch was taken: `index` is the branch's position, or -1 for `otherwise`. */
export type DecisionOutcome =
  | { ok: true; index: number; label: string; next: string }
  | { ok: false; error: string };

/** The label `otherwise` is recorded with. */
export const OTHERWISE_LABEL = "否则";

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * The functions a condition may call, in the call form cel-js 0.8.2 understands (it implements no
 * string methods, so `contains(a, b)` rather than `a.contains(b)`).
 */
const CONDITION_FUNCTIONS: Record<string, CallableFunction> = {
  contains: (value: unknown, part: unknown) => text(value).includes(text(part)),
  startsWith: (value: unknown, prefix: unknown) =>
    text(value).startsWith(text(prefix)),
  endsWith: (value: unknown, suffix: unknown) =>
    text(value).endsWith(text(suffix)),
  matches: (value: unknown, pattern: unknown) => {
    let expression: RegExp;
    try {
      expression = new RegExp(text(pattern));
    } catch {
      throw new Error("正则表达式无效");
    }
    return expression.test(text(value));
  },
  int: (value: unknown) => {
    const trimmed = text(value).trim();
    const number = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(number))
      throw new Error("int() 的参数不是整数");
    return number;
  },
  double: (value: unknown) => {
    const trimmed = text(value).trim();
    const number = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(number))
      throw new Error("double() 的参数不是数字");
    return number;
  },
};

/** One line saying why an expression could not be evaluated, with no value from the run in it. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /^Identifier "([^"]*)" not found/.exec(message);
  if (unknown) return `读取了未声明的 ${unknown[1]}`;
  // cel-js appends the whole context to some messages; it is cut off before anything is kept.
  const line = (message.split(" in context")[0] ?? "").split("\n")[0] ?? "";
  const cleaned = line.replace(/^(CelTypeError|CelEvaluationError): /, "");
  return cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned;
}

/**
 * What a decision may read: its declared keys, each in its namespace. `earlier` is the run's steps
 * before this one; `inputs` the run's Flow inputs.
 */
export function decisionContext(
  step: DecisionStep,
  inputs: Record<string, string>,
  earlier: EarlierStep[],
):
  | {
      ok: true;
      context: {
        inputs: Record<string, string>;
        outputs: Record<string, string>;
      };
    }
  | { ok: false; error: string } {
  const context = {
    inputs: {} as Record<string, string>,
    outputs: {} as Record<string, string>,
  };
  for (const key of step.inputKeys ?? []) {
    const producer = earlier.find((record) => record.outputKey === key);
    if (producer) {
      if (typeof producer.output !== "string")
        return {
          ok: false,
          error: `条件判断读取的 ${key} 没有产出（步骤 ${producer.id} 被跳过或已失败），无法判断。`,
        };
      context.outputs[key] = producer.output;
    } else context.inputs[key] = inputs[key] ?? "";
  }
  return { ok: true, context };
}

/** Evaluate a decision step and say which branch it takes. Never throws. */
export function decide(
  step: DecisionStep,
  inputs: Record<string, string>,
  earlier: EarlierStep[],
): DecisionOutcome {
  const read = decisionContext(step, inputs, earlier);
  if (!read.ok) return read;
  const branches = step.branches ?? [];
  for (const [index, branch] of branches.entries()) {
    let result: unknown;
    try {
      result = evaluate(branch.when, read.context, CONDITION_FUNCTIONS);
    } catch (error) {
      return {
        ok: false,
        error: `分支「${branch.label}」的条件（第 ${index + 1} 个）求值出错：${reason(error)}。这一步判为失败，没有改走「${OTHERWISE_LABEL}」。`,
      };
    }
    if (typeof result !== "boolean")
      return {
        ok: false,
        error: `分支「${branch.label}」的条件（第 ${index + 1} 个）没有得到「是」或「否」的结果。这一步判为失败，没有改走「${OTHERWISE_LABEL}」。`,
      };
    if (result)
      return { ok: true, index, label: branch.label, next: branch.next };
  }
  if (!step.otherwise)
    return { ok: false, error: "这个条件判断没有「否则」的去向。" };
  return {
    ok: true,
    index: -1,
    label: OTHERWISE_LABEL,
    next: step.otherwise,
  };
}

/** The steps of a run as the graph helpers read them. */
export type RouteStep = Pick<
  PipelineStepRow,
  "id" | "kind" | "next" | "branches" | "otherwise"
>;

/**
 * Where the run goes after the step at `index`: a position in `steps`, `steps.length` for the end.
 * `jump` is the step's chosen target (a decision's branch); absent reads the step's own `next`.
 * A target that is not a later step (which Save refuses) is treated as the end, never as a step
 * behind this one: the run must always move forward.
 */
export function routeAfter(
  steps: RouteStep[],
  index: number,
  jump?: string,
): number {
  const target = jump ?? steps[index]?.next;
  if (target === undefined) return index + 1;
  const to = steps.findIndex((step) => step.id === target);
  return to > index ? to : steps.length;
}

/**
 * The most steps that can still open a card from `from` on, over every path (D4: the month is
 * counted by the steps a run can actually execute, and a decision executes no turn and opens no
 * card; nor does a confirmation, which asks a person). A plan without decisions, confirmations or
 * jumps counts every remaining step, exactly as before.
 */
export function stepBudget(steps: RouteStep[], from = 0): number {
  const longest = new Array<number>(steps.length + 1).fill(0);
  for (let index = steps.length - 1; index >= from; index -= 1) {
    const step = steps[index];
    if (!step) continue;
    const targets =
      step.kind === "decision"
        ? [
            ...(step.branches ?? []).map((branch) =>
              routeAfter(steps, index, branch.next),
            ),
            routeAfter(steps, index, step.otherwise ?? "__end__"),
          ]
        : [routeAfter(steps, index)];
    const after = Math.max(0, ...targets.map((to) => longest[to] ?? 0));
    // A decision and a confirmation run no turn and open no card.
    longest[index] =
      (step.kind === "decision" || step.kind === "confirm" ? 0 : 1) + after;
  }
  return longest[from] ?? 0;
}
