import { expect, test } from "bun:test";
import {
  REFINE_SKILL_TOOL,
  SAVE_SKILL_TOOL,
  SELF_SKILL_GUIDANCE,
  selfSkillGuidance,
} from "./self-skills";
import { readToolName } from "./tool-name";

test("the word on writing skills is said only to a Bot that holds save_learned_skill", () => {
  expect(selfSkillGuidance([SAVE_SKILL_TOOL, REFINE_SKILL_TOOL])).toBe(
    SELF_SKILL_GUIDANCE,
  );
  expect(selfSkillGuidance([SAVE_SKILL_TOOL])).toBe(SELF_SKILL_GUIDANCE);
  // Switched off for the employee: not taught. The browser's own save_skill is another tool and teaches nothing.
  expect(selfSkillGuidance([REFINE_SKILL_TOOL])).toBeUndefined();
  expect(selfSkillGuidance(["save_skill"])).toBeUndefined();
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
  expect(SAVE_SKILL_TOOL).toBe("save_learned_skill");
  expect(readToolName(SAVE_SKILL_TOOL, true).label).toBe("正在记下一条技能");
  expect(readToolName(SAVE_SKILL_TOOL).label).toBe("记下了一条技能");
  // The browser's own tool keeps its own name, and a name that is different.
  expect(readToolName("save_skill").label).toBe("提议了新技能");
  expect(readToolName(REFINE_SKILL_TOOL, true).label).toBe(
    "正在查看或修正技能",
  );
  expect(readToolName(REFINE_SKILL_TOOL).label).toBe("查看或修正了技能");
});
