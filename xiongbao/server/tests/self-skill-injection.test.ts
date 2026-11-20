import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import type { SelectableSkill } from "../src/plugins/selection";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
  type ToolSelection,
} from "../src/copilot";
import {
  RELATED_SKILL_CHARS,
  relatedSelfSkills,
  relatedSkillsGuidance,
  requestTextOf,
  skillGuidanceFor,
  tokensOf,
} from "../src/plugins/picked-skill";

/*
 * 员工自己写的技能，同类任务第二次一定看得到：不必人点命令，也不必员工想起来去读，对得上的一两条
 * 直接以简短的形式进上下文。评测「重复任务」第二次没有更快，其中一环是技能只以一行索引出现在清单里。
 */

const MARKER = "SELF-SKILL-9931";
type Held = SelectableSkill;
const REPORT: Held = {
  tools: [],
  slug: "auto-1a2b3c4d5e",
  title: "动作清单做成汇总表",
  summary: "把动作清单 CSV 整理成带图表的 xlsx 汇总表交给领导的时候",
  instructions: [
    "适用场景：把动作清单 CSV 整理成带图表的 xlsx 汇总表交给领导的时候",
    `步骤：\n1. 用 python3 读 <dir>/actions.csv，第一行是说明要跳过\n2. 按负责人汇总，写 <dir>/summary.xlsx\n3. ${MARKER}`,
    "怎么确认做对了：汇总行数与原表一致",
  ].join("\n\n"),
};
const OTHER: Held = {
  tools: [],
  slug: "auto-ffffffffff",
  title: "订机票",
  summary: "出差要订机票和酒店的时候",
  instructions: "适用场景：出差要订机票和酒店的时候\n\n步骤：\n1. 打开订票页面",
};
/** 人写的、部署自带的：不是员工自己写的，不走这条路。 */
const HUMAN: Held = {
  tools: [],
  slug: "weekly-report",
  title: "动作清单做成汇总表",
  summary: "把动作清单 CSV 整理成带图表的 xlsx 汇总表交给领导的时候",
  instructions: REPORT.instructions,
};

const SECOND_RUN =
  "请把 eval/repeat-second/actions.csv 里的动作清单整理成一份 xlsx 汇总表，按负责人汇总并画一张图表，做好后交付给领导。";
const UNRELATED = "帮我写一首关于春天的短诗，四行就好。";

describe("which of the employee's own skills match what it is asked", () => {
  test("words: Latin by word, Chinese by pairs, file names split at the dot", () => {
    const tokens = tokensOf("整理 actions.CSV 到 summary_2.xlsx");
    for (const token of ["整理", "actions", "csv", "summary", "xlsx"])
      expect(tokens.has(token)).toBe(true);
    expect(tokens.has("a")).toBe(false);
  });

  test("the same kind of task matches; an unrelated one, and one that only shares a word, do not", () => {
    expect(relatedSelfSkills(SECOND_RUN, [REPORT, OTHER])).toEqual([REPORT]);
    expect(relatedSelfSkills(UNRELATED, [REPORT, OTHER])).toEqual([]);
    expect(relatedSelfSkills("把销售数据整理成周报", [REPORT])).toEqual([]);
    expect(relatedSelfSkills("", [REPORT])).toEqual([]);
  });

  test("only skills the employee wrote itself, and at most two, best first", () => {
    expect(relatedSelfSkills(SECOND_RUN, [HUMAN])).toEqual([]);
    const near = {
      ...REPORT,
      slug: "auto-0000000001",
      instructions: `适用场景：把动作清单整理成汇总表\n\n步骤：\n1. x`,
      summary: "把动作清单整理成汇总表",
      title: "汇总",
    };
    const far = {
      ...REPORT,
      slug: "auto-0000000002",
      title: "清单汇总图表",
      instructions: `适用场景：动作清单 xlsx 汇总 图表 领导 负责人 交付 其他 别的 很多 无关 的 词语 出现 在 这里 凑数\n\n步骤：\n1. y`,
      summary: "动作清单 xlsx 汇总 图表",
    };
    const third = { ...REPORT, slug: "auto-0000000003" };
    const found = relatedSelfSkills(SECOND_RUN, [far, third, REPORT, near]);
    expect(found).toHaveLength(2);
  });

  test("a short follow-up like 继续 is read together with the first thing the person asked", () => {
    const messages = [
      { role: "user", content: SECOND_RUN },
      { role: "assistant", content: "做了一半" },
      { role: "user", content: "继续" },
    ];
    expect(requestTextOf(messages)).toContain("actions.csv");
    expect(relatedSelfSkills(requestTextOf(messages), [REPORT])).toEqual([
      REPORT,
    ]);
    // A real second message stands on its own.
    expect(
      requestTextOf([
        { role: "user", content: SECOND_RUN },
        { role: "user", content: UNRELATED.repeat(4) },
      ]),
    ).not.toContain("actions.csv");
  });
});

describe("what goes into the context", () => {
  const said = (content: string): { messages: Message[] } => ({
    messages: [{ id: "q", role: "user", content }],
  });

  test("a matching skill comes in short form with its steps, and says how to read it whole", () => {
    const guidance = relatedSkillsGuidance(said(SECOND_RUN), [REPORT, OTHER]);
    expect(guidance).toContain(MARKER);
    expect(guidance).toContain(`id: ${REPORT.slug}`);
    expect(guidance).toContain("nobody needs to send a command");
    expect(guidance).not.toContain("订机票");
    expect(relatedSkillsGuidance(said(UNRELATED), [REPORT])).toBeUndefined();
  });

  test("a long skill is cut at a fixed size and points at refine_skill for the rest", () => {
    const long = {
      ...REPORT,
      instructions: `${REPORT.instructions}\n${"很长的补充。".repeat(400)}`,
    };
    const guidance = relatedSkillsGuidance(said(SECOND_RUN), [long]) ?? "";
    expect(guidance.length).toBeLessThan(RELATED_SKILL_CHARS + 900);
    expect(guidance).toContain(`refine_skill with only the id "${long.slug}"`);
  });

  test("a command the person typed still wins over a guess", () => {
    const picked = skillGuidanceFor(
      {
        messages: [{ id: "q", role: "user", content: `/${HUMAN.slug} 做吧` }],
        forwardedProps: {},
      },
      [HUMAN, REPORT],
    );
    expect(picked).toContain("The person picked the skill");
    expect(picked).not.toContain("You have done this kind of work before");
  });
});

describe("on OpenBot's own harness, the model is sent it", () => {
  const llm = new LLMock();
  const wire: string[] = [];
  let recorder: ReturnType<typeof Bun.serve> | undefined;
  const original = process.env.OPENAI_BASE_URL;
  const selection: ToolSelection = {
    loadSkills: async () => [REPORT],
    choose: async () => null,
  };
  const bot: RegisteredAgent = {
    id: "repeat-pal",
    name: "Repeat Pal",
    type: "built_in",
    systemPrompt: "You do office work.",
  };
  const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };

  beforeAll(async () => {
    const upstream = await llm.start();
    recorder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text();
        if (body) wire.push(body);
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.delete("host");
        return fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
        });
      },
    });
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${recorder.port}`;
    llm.onMessage(/.*/, { content: "Answered." });
  });
  afterAll(async () => {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
    recorder?.stop(true);
    await llm.stop();
  });
  beforeEach(() => {
    wire.length = 0;
  });

  async function sent(text: string) {
    const agents = await buildAgents(
      [bot],
      model,
      "synthetic-key",
      undefined,
      async () => [],
      undefined,
      undefined,
      undefined,
      selection,
    );
    const agent = agents[bot.id]?.clone();
    if (!agent) throw new Error("Bot missing");
    agent.setMessages([{ id: "q", role: "user", content: text }]);
    await agent.runAgent();
    return wire.join("\n");
  }

  test("a second request of the same kind carries the skill's steps; an unrelated one does not", async () => {
    expect(await sent(SECOND_RUN)).toContain(MARKER);
    wire.length = 0;
    const unrelated = await sent(UNRELATED);
    expect(unrelated).not.toContain(MARKER);
  });
});
