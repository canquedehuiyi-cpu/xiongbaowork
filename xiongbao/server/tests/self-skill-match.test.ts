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
import { taskPrompt } from "../../scripts/e2e/employee-eval/lib";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
  type ToolSelection,
} from "../src/copilot";
import {
  relatedSelfSkills,
  skillGuidanceFor,
} from "../src/plugins/picked-skill";
import type { SelectableSkill } from "../src/plugins/selection";
import { renderSkill } from "../src/skills/save-tool";
import {
  decodeFingerprint,
  encodeFingerprint,
  fingerprintOf,
  type SourceFingerprint,
} from "../src/skills/source-fingerprint";

/*
 * 员工第一次复盘写出的技能，第二次做同一件事却没被用上（期 2「重复任务」验收，run 44694429237）。
 * 复盘按 RETRO_SYSTEM 把人名、日期、文件名都换成了占位，技能的「什么时候用」写得很泛；而看板派活的请求只是
 * 「请完成「多步办公」这道题：先读 …/TASK.md」，题目的内容在文件里，请求里没有。两边词对不上。
 * 修法：技能保存时带上来源请求的指纹（词的哈希，不存原文），挑选时一并比。
 */

/** 复盘按 RETRO_SYSTEM 的要求写出的技能：泛化，没有人名、日期、文件名。 */
const GENERAL = renderSkill({
  name: "会议纪要转待办CSV与邮件草稿",
  when: "收到一份项目周会纪要（.md），要求把纪要里明确分派给某位负责人的待办整理成待办表（.csv，表头为负责人、截止日、事项，截止日写成 YYYY-MM-DD），再为每位负责人写一份邮件草稿（.md）时",
  steps: [
    "读 <dir>/TASK.md 和纪要文件（.md），列出明确分派给某位负责人的待办",
    "用 python3 的 csv.writer 写待办表（.csv），截止日统一写成 YYYY-MM-DD",
    "在 <dir>/drafts/ 下为每位负责人写一份邮件草稿（.md），逐条提到事项和截止日",
  ],
  pitfalls: ["纪要里的日期写法各不相同，先换算再写"],
  verify: "待办表行数与纪要里分派的事项数一致",
  scope: "self",
});

const FIRST_REQUEST = taskPrompt("repeat", "eval/repeat-first");
const SECOND_REQUEST = taskPrompt("repeat", "eval/repeat-second");

const skillWith = (
  slug: string,
  rendered: ReturnType<typeof renderSkill>,
  fingerprint?: SourceFingerprint,
): SelectableSkill => ({
  tools: [],
  slug,
  title: rendered.title,
  summary: rendered.summary,
  instructions: rendered.instructions,
  ...(fingerprint ? { sourceFingerprint: fingerprint } : {}),
});

const fingerprint = (request: string): SourceFingerprint => {
  const made = fingerprintOf(request);
  if (!made) throw new Error("request has no words");
  return made;
};

describe("the source request's fingerprint", () => {
  test("is hashed words: none of the request's text is stored", () => {
    const stored = encodeFingerprint(fingerprint(FIRST_REQUEST));
    for (const piece of [
      "多步办公",
      "办公",
      "TASK",
      "repeat",
      "first",
      "eval",
      "请完成",
      FIRST_REQUEST.slice(0, 12),
    ])
      expect(stored.toLowerCase()).not.toContain(piece.toLowerCase());
    const parsed = JSON.parse(stored) as { t: string[]; q: string[] };
    for (const word of [...parsed.t, ...parsed.q])
      expect(word).toMatch(/^[0-9a-f]{6}$/);
  });

  test("covers only the first part of a long request", () => {
    const long = `${FIRST_REQUEST}\n${"这是后面很长的一段补充说明，不该进指纹。".repeat(40)}`;
    expect(fingerprint(long).t.length).toBeLessThan(
      fingerprint(FIRST_REQUEST).t.length + 80,
    );
    // The tail does not change it.
    expect(fingerprint(long)).toEqual(
      fingerprint(`${long}再多一句，也不该变。`),
    );
  });

  test("survives a round trip, and a stored value that is not one is no fingerprint", () => {
    const made = fingerprint(FIRST_REQUEST);
    expect(decodeFingerprint(encodeFingerprint(made))).toEqual(made);
    for (const bad of [null, undefined, "", "not json", "{}", '{"t":[1]}'])
      expect(decodeFingerprint(bad)).toBeUndefined();
    expect(fingerprintOf("")).toBeUndefined();
    expect(fingerprintOf("好的")).toBeDefined();
  });
});

describe("the same kind of task finds the skill the review wrote", () => {
  test("without the fingerprint the generalised skill misses the real second request (the bug)", () => {
    expect(
      relatedSelfSkills(SECOND_REQUEST, [
        skillWith("auto-aaaaaaaaaa", GENERAL),
      ]),
    ).toEqual([]);
  });

  test("with it, the real second request hits; every other task's request does not", () => {
    const skill = skillWith(
      "auto-aaaaaaaaaa",
      GENERAL,
      fingerprint(FIRST_REQUEST),
    );
    expect(relatedSelfSkills(SECOND_REQUEST, [skill])).toEqual([skill]);
    for (const task of [
      "refactor",
      "code",
      "data",
      "docs",
      "research",
      "compare",
      "terminal",
      "webform",
    ] as const)
      expect(
        relatedSelfSkills(taskPrompt(task, `eval/${task}`), [skill]),
      ).toEqual([]);
  });

  test("a request written in the person's own words, with other details, hits by the same fingerprint", () => {
    const source =
      "把 eval/a/meeting-notes.md 里分派给各人的待办整理成 actions.csv，再给每个负责人写一份邮件草稿";
    const skill = skillWith("auto-bbbbbbbbbb", GENERAL, fingerprint(source));
    const again =
      "请把 notes/weekly-sync.md 里分派给各人的待办整理成 todo.csv，再给每个负责人写一份邮件草稿";
    expect(relatedSelfSkills(again, [skill])).toEqual([skill]);
    for (const other of [
      "把 src/utils 下的函数拆到多个文件，并更新所有引用它们的地方",
      "帮我写一首关于春天的短诗，四行就好。",
      "把销售数据按地区汇总，画一张折线图",
    ])
      expect(relatedSelfSkills(other, [skill])).toEqual([]);
  });

  test("the skill's own when and title count too: a request in its words hits with no fingerprint", () => {
    const skill = skillWith("auto-cccccccccc", GENERAL);
    expect(
      relatedSelfSkills(
        "收到项目周会纪要（.md），请把明确分派给某位负责人的待办整理成待办表（.csv，表头 负责人、截止日、事项），再为每位负责人写一份邮件草稿（.md）",
        [skill],
      ),
    ).toEqual([skill]);
  });

  test("a short follow-up is read with the first request, and still hits", () => {
    const skill = skillWith(
      "auto-aaaaaaaaaa",
      GENERAL,
      fingerprint(FIRST_REQUEST),
    );
    const found = skillGuidanceFor(
      {
        messages: [
          { id: "1", role: "user", content: SECOND_REQUEST },
          { id: "2", role: "assistant", content: "做了一半" },
          { id: "3", role: "user", content: "继续" },
        ],
        forwardedProps: {},
      },
      [skill],
    );
    expect(found).toContain("You have done this kind of work before");
  });

  test("a skill that is not the employee's own is never matched by a fingerprint", () => {
    const human = skillWith(
      "weekly-report",
      GENERAL,
      fingerprint(FIRST_REQUEST),
    );
    expect(relatedSelfSkills(SECOND_REQUEST, [human])).toEqual([]);
  });
});

describe("when the employee holds only a few skills of its own, it is told what they are", () => {
  const said = (...contents: string[]) => ({
    messages: contents.map(
      (content, index): Message =>
        index % 2 === 0
          ? { id: `u${index}`, role: "user", content }
          : { id: `a${index}`, role: "assistant", content },
    ),
    forwardedProps: {},
  });
  const mine = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      skillWith(
        `auto-${String(index).padStart(10, "0")}`,
        renderSkill({
          name: `做法${index}`,
          when: `第${index}种事情出现的时候`,
          steps: ["做"],
          pitfalls: [],
          verify: "查",
          scope: "self",
        }),
      ),
    );
  const NEW_TASK = "帮我把仓库里所有的旧接口调用换成新接口，换完跑一遍测试";

  test("an unmatched request gets one line per skill: title and when, and how to read it whole", () => {
    const guidance = skillGuidanceFor(said(NEW_TASK), mine(3)) ?? "";
    for (let index = 0; index < 3; index += 1) {
      expect(guidance).toContain(`做法${index}`);
      expect(guidance).toContain(`第${index}种事情出现的时候`);
      expect(guidance).toContain(`auto-${String(index).padStart(10, "0")}`);
    }
    expect(guidance).toContain("refine_skill");
    // The list is not the matched section: no skill's steps are pasted in.
    expect(guidance).not.toContain("You have done this kind of work before");
    expect(guidance).not.toContain("步骤：");
  });

  test("six or more skills are too many to list; none held is nothing to list", () => {
    expect(skillGuidanceFor(said(NEW_TASK), mine(6))).toBeUndefined();
    expect(skillGuidanceFor(said(NEW_TASK), mine(5))).toBeDefined();
    expect(skillGuidanceFor(said(NEW_TASK), [])).toBeUndefined();
  });

  test("only the employee's own skills are listed, and a matched skill replaces the list", () => {
    const human = { ...mine(1)[0], slug: "weekly-report" } as SelectableSkill;
    expect(skillGuidanceFor(said(NEW_TASK), [human])).toBeUndefined();
    const matched = skillWith(
      "auto-aaaaaaaaaa",
      GENERAL,
      fingerprint(FIRST_REQUEST),
    );
    const guidance =
      skillGuidanceFor(said(SECOND_REQUEST), [matched, ...mine(2)]) ?? "";
    expect(guidance).toContain("You have done this kind of work before");
    expect(guidance).not.toContain("做法0");
  });

  test("a short reply like 继续 does not repeat the list", () => {
    expect(
      skillGuidanceFor(said(NEW_TASK, "做了一半", "继续"), mine(2)),
    ).toBeUndefined();
    expect(
      skillGuidanceFor(said(NEW_TASK, "做了一半", "好的，接着做"), mine(2)),
    ).toBeUndefined();
    // A new, real message does bring it.
    expect(
      skillGuidanceFor(
        said(NEW_TASK, "做了一半", "再帮我把文档里的旧接口名也换掉"),
        mine(2),
      ),
    ).toContain("做法0");
  });

  test("the same message gives the same bytes every time, whatever order the skills arrive in", () => {
    const held = mine(4);
    const once = skillGuidanceFor(said(NEW_TASK), held);
    expect(skillGuidanceFor(said(NEW_TASK), held)).toBe(once);
    expect(skillGuidanceFor(said(NEW_TASK), [...held].reverse())).toBe(once);
  });
});

describe("on OpenBot's own harness the list rides on the message, not on the prefix", () => {
  const llm = new LLMock();
  const wire: string[] = [];
  let recorder: ReturnType<typeof Bun.serve> | undefined;
  const original = process.env.OPENAI_BASE_URL;
  const own = skillWith(
    "auto-1111111111",
    renderSkill({
      name: "订机票",
      when: "出差要订机票和酒店的时候",
      steps: ["打开订票页面"],
      pitfalls: [],
      verify: "拿到订单号",
      scope: "self",
    }),
  );
  const selection: ToolSelection = {
    loadSkills: async () => [own],
    choose: async () => null,
  };
  const bot: RegisteredAgent = {
    id: "list-pal",
    name: "List Pal",
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

  async function sent(messages: Message[]) {
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
    agent.setMessages(messages);
    await agent.runAgent();
    return wire.join("\n");
  }

  test("a new kind of task carries the list; 继续 on it does not", async () => {
    const task = "帮我把仓库里所有的旧接口调用换成新接口，换完跑一遍测试";
    const first = await sent([{ id: "q", role: "user", content: task }]);
    // The standing index of held skills carries the name and summary every time; the list is this
    // message's own section, told apart by its opening line and the id in parentheses.
    // 用户 2026-11-21 批准：清单换了开头那句（现在叫员工用 read_skill 读全文）。
    expect(first).toContain("Skills you wrote down from earlier work");
    expect(first).toContain("(id: auto-1111111111)");
    wire.length = 0;
    const follow = await sent([
      { id: "q", role: "user", content: task },
      { id: "a", role: "assistant", content: "做了一半" },
      { id: "q2", role: "user", content: "继续" },
    ]);
    expect(follow).not.toContain("Skills you wrote down from earlier work");
    expect(follow).not.toContain("(id: auto-1111111111)");
  });
});
