import { afterEach, describe, expect, test } from "bun:test";
import { learnPolicy, RETRO_MARK } from "./mock-learn";
import type { MockRequest } from "./mock-model";
import { taskPrompt } from "./lib";

/*
 * 假模型复盘员的 `general` 变体：照 RETRO_SYSTEM 的泛化要求写技能，名字和「什么时候用」里没有这次请求里的词。
 * 真模型第一次复盘写出来的就是这样（run 44694429237）；原来的默认变体把请求原话当作「什么时候用」，
 * 同类请求永远对得上，看不出匹配有没有毛病。
 */
const retroRequest = (request: string): MockRequest => ({
  protocol: "chat",
  lastUser: "",
  toolResultsSinceUser: 0,
  offeredTools: [],
  raw: { system: RETRO_MARK, prompt: `Request: ${request}\n\nTrace` },
});

const original = process.env.EVAL_MOCK_RETRO;
afterEach(() => {
  if (original === undefined) delete process.env.EVAL_MOCK_RETRO;
  else process.env.EVAL_MOCK_RETRO = original;
});

const skillOf = (request: string) =>
  JSON.parse(learnPolicy(retroRequest(request), "/tmp/none").text ?? "{}")
    .skill as { name: string; when: string };

describe("the mock review's skill", () => {
  test("by default its 'when' is the request's own words", () => {
    delete process.env.EVAL_MOCK_RETRO;
    const request = taskPrompt("repeat", "eval/repeat-first");
    expect(skillOf(request).when).toContain("TASK.md");
  });

  test("general: written the way the review prompt asks, with none of the request's words", () => {
    process.env.EVAL_MOCK_RETRO = "general";
    const request = taskPrompt("repeat", "eval/repeat-first");
    const skill = skillOf(request);
    expect(skill.name).toBe("会议纪要转待办CSV与邮件草稿");
    for (const word of ["TASK.md", "repeat-first", "多步办公", "eval/"]) {
      expect(skill.when).not.toContain(word);
      expect(skill.name).not.toContain(word);
    }
    expect(skill.when).toContain("YYYY-MM-DD");
  });
});
