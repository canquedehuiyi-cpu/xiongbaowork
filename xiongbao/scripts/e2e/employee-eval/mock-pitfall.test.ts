import { expect, test } from "bun:test";
import { FAST_MARK, RETRO_MARK, SKILL_MARK } from "./mock-learn";
import type { MockRequest } from "./mock-model";
import { pitfallPolicy, SOLVER } from "./mock-pitfall";

/*
 * 本机假模型的「有坑可学」剧本：第一次一步步排查再按通用做法做完，带着技能（有快路径）就一步做完；
 * copy 变体第二次照抄第一次的具体值，用来看判分会不会把它判错。
 */

const request = (
  over: Partial<MockRequest> & { raw?: object } = {},
): MockRequest => ({
  protocol: "chat",
  lastUser: "请完成「账单导入」这道题：先读 eval/repeat-pitfall-first/TASK.md",
  toolResultsSinceUser: 0,
  offeredTools: ["accept_task"],
  raw: {},
  ...over,
});

const commandsOf = (dir: string, extra: Record<string, string> = {}) => {
  const out: string[] = [];
  for (let done = 0; done < 30; done += 1) {
    const turn = pitfallPolicy(request({ toolResultsSinceUser: done }), dir, {
      ...extra,
    });
    if (turn.text) break;
    for (const tool of turn.tools ?? [])
      out.push(
        String((tool.arguments as { command?: string }).command ?? tool.name),
      );
  }
  return out;
};

test("without a skill the mock probes step by step before applying the general fix", () => {
  const steps = commandsOf("eval/repeat-pitfall-first");
  expect(steps.length).toBeGreaterThanOrEqual(8);
  expect(steps.some((step) => step.includes("bun run import"))).toBe(true);
  expect(steps.some((step) => step.includes(SOLVER))).toBe(true);
});

test("with a skill that carries a fast path it does the fix in one command", () => {
  const known = {
    raw: { messages: [`${SKILL_MARK} ... ${FAST_MARK}`] },
  };
  const turns: string[] = [];
  for (let done = 0; done < 30; done += 1) {
    const turn = pitfallPolicy(
      request({ toolResultsSinceUser: done, ...known }),
      "eval/repeat-pitfall-second",
      {},
    );
    if (turn.text) break;
    for (const tool of turn.tools ?? [])
      turns.push(
        String((tool.arguments as { command?: string }).command ?? tool.name),
      );
  }
  expect(turns.length).toBeLessThanOrEqual(4);
  expect(turns.some((step) => step.includes(SOLVER))).toBe(true);
});

test("the copy variant carries the first round's config, cache and summary into the second", () => {
  const known = { raw: { messages: [`${SKILL_MARK} ... ${FAST_MARK}`] } };
  const steps: string[] = [];
  for (let done = 0; done < 30; done += 1) {
    const turn = pitfallPolicy(
      request({ toolResultsSinceUser: done, ...known }),
      "eval/repeat-pitfall-p2-second",
      { EVAL_MOCK_PITFALL: "copy" },
    );
    if (turn.text) break;
    for (const tool of turn.tools ?? [])
      steps.push(
        String((tool.arguments as { command?: string }).command ?? tool.name),
      );
  }
  const joined = steps.join("\n");
  expect(joined).toContain("eval/repeat-pitfall-p2-first/import.config.json");
  expect(joined).toContain("eval/repeat-pitfall-p2-first/.cache/rates.json");
  expect(joined).not.toContain(SOLVER);
});

test("the review writes a general skill: no seed value, with the fast path", () => {
  const turn = pitfallPolicy(
    request({
      raw: { system: RETRO_MARK, prompt: "Request: 请完成「账单导入」这道题" },
    }),
    "eval/repeat-pitfall-first",
    {},
  );
  const skill = JSON.parse(turn.text ?? "{}").skill as {
    fastPath: string;
    steps: string[];
    when: string;
  };
  expect(skill.fastPath).toContain(SOLVER);
  expect(skill.fastPath).toContain("<dir>");
  expect(skill.steps.join("\n")).not.toMatch(/feeds|;|\|/);
});
