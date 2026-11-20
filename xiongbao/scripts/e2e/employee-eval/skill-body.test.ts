import { afterEach, describe, expect, test } from "bun:test";
import {
  type LearnedState,
  newSkillBodies,
  SKILL_BODY_CHARS,
  skillBodyLog,
} from "./learning";
import type { Capabilities } from "./metrics";
import { FAST_MARK, learnPolicy, RETRO_MARK, SKILL_MARK } from "./mock-learn";
import type { MockRequest } from "./mock-model";
import { combineRepeat, type EvalRecord, type EvalResults } from "./records";
import { renderReport, skillBodyBlocks } from "./report";

/*
 * 重复任务第二次没有更快，要先看到技能到底写了什么：「学没学到」表下面列出第一次之后存下的技能正文的
 * 前 800 字，日志里同样打一份。再用本地假模型演示第二次照快路径走、步数更少。
 */

const body = (marker: string, length: number) =>
  `适用场景：${marker}\n\n快路径（先照这个做）：\n${"x".repeat(length)}`;

const state = (
  skills: Record<string, [string, number, string]>,
): LearnedState => ({
  skills: new Map(
    Object.entries(skills).map(([slug, [title, useCount, instructions]]) => [
      slug,
      { title, useCount, instructions },
    ]),
  ),
  memories: 0,
});

describe("新存下的技能正文的前 800 字", () => {
  test("只取第一次之后新增的技能，每条最多 800 字", () => {
    const before = state({ "auto-old": ["旧技能", 0, "旧正文"] });
    const after = state({
      "auto-old": ["旧技能", 1, "旧正文"],
      "auto-new": ["新技能", 0, body("NEW-1", 2000)],
    });
    const bodies = newSkillBodies(before, after);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.title).toBe("新技能");
    expect(bodies[0]?.text).toHaveLength(SKILL_BODY_CHARS);
    expect(SKILL_BODY_CHARS).toBe(800);
    expect(bodies[0]?.text).toContain("NEW-1");
    expect(bodies[0]?.text).not.toContain("旧正文");
  });

  test("不到 800 字的原样给；读不到正文的技能不列", () => {
    const after = state({ "auto-new": ["新技能", 0, "很短"] });
    after.skills.set("auto-blank", { title: "没正文", useCount: 0 });
    expect(newSkillBodies(state({}), after)).toEqual([
      { title: "新技能", text: "很短" },
    ]);
  });

  test("日志里同样打一份，带技能名", () => {
    const log = skillBodyLog([{ title: "新技能", text: "适用场景：LOG-1" }]);
    expect(log).toContain("新技能");
    expect(log).toContain("LOG-1");
    expect(skillBodyLog([])).toBe("");
  });
});

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
  tokens: { input: 200_000, output: 4_000, total: 204_000, cachedInput: 0 },
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

const repeated = (skillBodies?: { title: string; text: string }[]) =>
  combineRepeat(
    record({
      learning: {
        newSkills: ["会议纪要转待办"],
        newMemories: 0,
        usedSkills: [],
        ...(skillBodies ? { skillBodies } : {}),
        retro: { waitedMs: 9_000, ended: "logged", outcome: "saved" },
      },
    }),
    record({
      steps: 15,
      learning: {
        newSkills: [],
        newMemories: 0,
        usedSkills: ["会议纪要转待办"],
      },
    }),
  );

describe("评测报告带出技能正文", () => {
  test("「学没学到」表下面有一段：每条新技能一个标题和正文", () => {
    const markdown = renderReport([
      side([
        repeated([{ title: "会议纪要转待办", text: "适用场景：REPORT-1" }]),
      ]),
    ]);
    const table = markdown.indexOf("## 重复任务：学没学到");
    const section = markdown.indexOf("技能正文", table);
    expect(table).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(table);
    expect(markdown.indexOf("REPORT-1")).toBeGreaterThan(section);
    expect(markdown).toContain("会议纪要转待办");
  });

  test("没记正文的结果（旧结果文件、Codex）不出这一段", () => {
    expect(skillBodyBlocks([["熊宝", side([repeated()])]])).toEqual([]);
    expect(renderReport([side([repeated()])])).not.toContain("技能正文");
  });

  test("正文里的反引号围栏不会冲破报告的代码块", () => {
    const block = skillBodyBlocks([
      ["熊宝", side([repeated([{ title: "技能", text: "a\n```\nb" }])])],
    ]).join("\n");
    expect(block).toContain("````");
  });
});

describe("本地假模型：第二次照快路径做，步数更少", () => {
  const original = process.env.EVAL_MOCK_RETRO;
  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_MOCK_RETRO;
    else process.env.EVAL_MOCK_RETRO = original;
  });

  const requestWith = (
    text: string,
    toolResultsSinceUser: number,
  ): MockRequest => ({
    protocol: "chat",
    lastUser: "",
    toolResultsSinceUser,
    offeredTools: ["accept_task"],
    raw: { messages: [{ role: "system", content: text }] },
  });
  /** 一轮到出文字为止一共走了几步（每步一次模型调用）。 */
  const stepsOf = (text: string) => {
    for (let done = 0; done < 40; done += 1)
      if (learnPolicy(requestWith(text, done), "/w/eval/x").text)
        return done + 1;
    return 40;
  };

  test("复盘员写的技能带快路径、前提和一条命令的校验", () => {
    delete process.env.EVAL_MOCK_RETRO;
    const turn = learnPolicy(
      {
        protocol: "chat",
        lastUser: "",
        toolResultsSinceUser: 0,
        offeredTools: [],
        raw: {
          system: RETRO_MARK,
          prompt: "Request: 把纪要整理成待办表\n\nTrace",
        },
      },
      "/w/eval/x",
    );
    const skill = JSON.parse(turn.text ?? "{}").skill as Record<string, string>;
    expect(skill.fastPath).toBeTruthy();
    expect(skill.fastPathNeeds).toBeTruthy();
    expect(skill.fastPathCheck).toContain("<dir>");
    expect(skill.fastPathCheck).not.toContain("\n");
  });

  test("没技能 > 只有技能 > 技能带快路径的提示：步数一级比一级少", () => {
    const none = stepsOf("没有技能");
    const skill = stepsOf(`${SKILL_MARK} ...`);
    const fast = stepsOf(`${SKILL_MARK} ... ${FAST_MARK} ...`);
    expect(fast).toBeLessThan(skill);
    expect(skill).toBeLessThan(none);
    expect(fast).toBeLessThanOrEqual(4);
  });
});
