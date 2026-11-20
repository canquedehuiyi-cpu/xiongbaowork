import { expect, test } from "bun:test";
import {
  REFINE_SKILL_TOOL,
  SAVE_SKILL_TOOL,
  SELF_SKILL_GUIDANCE,
  selfSkillGuidance,
} from "./self-skills";
import { readToolName } from "./tool-name";

test("the word on writing skills is said only to a Bot that holds save_skill", () => {
  expect(selfSkillGuidance([SAVE_SKILL_TOOL, REFINE_SKILL_TOOL])).toBe(
    SELF_SKILL_GUIDANCE,
  );
  expect(selfSkillGuidance([SAVE_SKILL_TOOL])).toBe(SELF_SKILL_GUIDANCE);
  // Switched off for the employee, or the browser's own save_skill stands in: not taught.
  expect(selfSkillGuidance([REFINE_SKILL_TOOL])).toBeUndefined();
  expect(selfSkillGuidance(["update_plan", "web_fetch"])).toBeUndefined();
  expect(selfSkillGuidance([])).toBeUndefined();
});

test("it says what may not go into a skill and that shared needs the person", () => {
  expect(SELF_SKILL_GUIDANCE).toContain("密钥");
  expect(SELF_SKILL_GUIDANCE).toContain("绕过审批");
  expect(SELF_SKILL_GUIDANCE).toContain("本人批准");
  expect(SELF_SKILL_GUIDANCE).toContain(REFINE_SKILL_TOOL);
});

test("both tools have a name in words", () => {
  expect(readToolName(SAVE_SKILL_TOOL).label).not.toBe("使用了工具");
  expect(readToolName(SAVE_SKILL_TOOL).label).not.toContain("save_skill");
  expect(readToolName(REFINE_SKILL_TOOL, true).label).toBe(
    "正在查看或修正技能",
  );
  expect(readToolName(REFINE_SKILL_TOOL).label).toBe("查看或修正了技能");
});
