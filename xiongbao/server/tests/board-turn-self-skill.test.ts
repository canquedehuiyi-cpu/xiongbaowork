import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import { taskPrompt } from "../../scripts/e2e/employee-eval/lib";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
  type ToolSelection,
} from "../src/copilot";
import {
  matchedSkillChecks,
  readSkillText,
  skillGuidanceFor,
} from "../src/plugins/picked-skill";
import { renderSkill } from "../src/skills/save-tool";
import { fingerprintOf } from "../src/skills/source-fingerprint";
import { asBoardTurn } from "../src/threads/unattended-card";

/*
 * 看板卡的一轮（`asBoardTurn`），员工自己写的、对得上的技能第一次调用时就以清单的形式在提示里（标 MATCH），
 * 和单聊的一轮一样，并且带着不排在检索后面的 `read_skill`：员工一步读出全文、快路径的提示和校验命令，它们留在
 * 对话历史里；不是等员工自己 `search_tools` 去找 `refine_skill` 再读，也不是每一步都把正文放进提示。
 */

const FIRST_REQUEST = taskPrompt("repeat", "eval/repeat-pitfall-first");
const SECOND_REQUEST = taskPrompt("repeat", "eval/repeat-pitfall-p1-second");
const SCRIPT = "python3 - <<'PY'\nprint('BOARD-FAST-PATH-7731')\nPY";
const CHECK = "awk 'END{print NR}' <dir>/actions.csv";

const rendered = renderSkill({
  name: "会议纪要转待办",
  when: "收到会议纪要，要整理成待办表时",
  steps: ["读纪要", "写 CSV"],
  pitfalls: ["第一行是标题"],
  verify: "行数对得上",
  scope: "self",
  fastPath: SCRIPT,
  fastPathNeeds: "目录里有纪要",
  fastPathCheck: CHECK,
});
const fingerprint = fingerprintOf(FIRST_REQUEST);
const own = {
  tools: [],
  slug: "auto-2222222222",
  title: rendered.title,
  summary: rendered.summary,
  instructions: rendered.instructions,
  ...(fingerprint ? { sourceFingerprint: fingerprint } : {}),
};

describe("the guidance a card turn's second run is given", () => {
  test("rendered text: the advice, then the skill with its fast path and its check", () => {
    const guidance =
      skillGuidanceFor(
        {
          messages: [{ id: "q", role: "user", content: SECOND_REQUEST }],
          forwardedProps: {},
        },
        [own],
      ) ?? "";
    expect(guidance).toContain("先按技能的快路径做");
    expect(guidance).toContain("BOARD-FAST-PATH-7731");
    expect(guidance).toContain(CHECK);
  });
});

describe("what read_skill hands back, and the check the server takes from the skill", () => {
  test("the whole skill with the fast path and its check, and the advice to follow it first", () => {
    const text = readSkillText({
      slug: own.slug,
      title: own.title,
      instructions: own.instructions,
    });
    expect(text).toContain("BOARD-FAST-PATH-7731");
    expect(text).toContain(CHECK);
    expect(text).toContain("先按技能的快路径做");
    expect(text).toContain("不要先逐个打开文件");
  });

  test("the verify check comes from the skill, not from the prompt text", () => {
    expect(
      matchedSkillChecks(
        {
          messages: [{ id: "q", role: "user", content: SECOND_REQUEST }],
        },
        [own],
      ),
    ).toEqual([CHECK]);
  });
});

describe("on the built-in harness, the first call of a board-card turn lists it", () => {
  const llm = new LLMock();
  const wire: string[] = [];
  let recorder: ReturnType<typeof Bun.serve> | undefined;
  const original = process.env.OPENAI_BASE_URL;
  const selection: ToolSelection = {
    loadSkills: async () => [own],
    choose: async () => null,
  };
  const bot: RegisteredAgent = {
    id: "board-pal",
    name: "Board Pal",
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

  const readSkill = {
    name: "read_skill",
    ref: "bot/read_skill",
    description: "Read one of your own skills in full, by id.",
    parameters: z.object({ id: z.string() }),
    execute: async () => "",
  };

  async function sent(board: boolean) {
    return asBoardTurn(board, async () => {
      const agents = await buildAgents(
        [bot],
        model,
        "synthetic-key",
        undefined,
        async () => [readSkill],
        undefined,
        undefined,
        undefined,
        selection,
      );
      const agent = agents[bot.id]?.clone();
      if (!agent) throw new Error("Bot missing");
      agent.setMessages([{ id: "q", role: "user", content: SECOND_REQUEST }]);
      await agent.runAgent();
      return wire.join("\n");
    });
  }

  for (const board of [false, true])
    test(`${board ? "board-card" : "chat"} turn: the skill is listed as a match with read_skill at hand, its body is not in the prompt`, async () => {
      const prompt = await sent(board);
      expect(prompt).toContain(`(id: ${own.slug})`);
      expect(prompt).toContain("[MATCH]");
      expect(prompt).toContain('"name":"read_skill"');
      // 正文、快路径和提示在 read_skill 的结果里，不在每一步都发的提示里。
      expect(prompt).not.toContain("BOARD-FAST-PATH-7731");
      expect(prompt).not.toContain("先按技能的快路径做");
      expect(prompt).not.toContain(CHECK);
    });
});
