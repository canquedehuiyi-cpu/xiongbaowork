import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { taskPrompt } from "../../scripts/e2e/employee-eval/lib";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
  type ToolSelection,
} from "../src/copilot";
import { skillGuidanceFor } from "../src/plugins/picked-skill";
import { renderSkill } from "../src/skills/save-tool";
import { fingerprintOf } from "../src/skills/source-fingerprint";
import { asBoardTurn } from "../src/threads/unattended-card";

/*
 * 看板卡的一轮（`asBoardTurn`），员工自己写的、对得上的技能连同快路径和校验，第一次调用时就在提示里，和
 * 单聊的一轮一样；不是等员工自己 `search_tools` 去找 `refine_skill` 再读。
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

describe("on OpenBot's own harness, the first call of a board-card turn carries it", () => {
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

  async function sent(board: boolean) {
    return asBoardTurn(board, async () => {
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
      agent.setMessages([{ id: "q", role: "user", content: SECOND_REQUEST }]);
      await agent.runAgent();
      return wire.join("\n");
    });
  }

  for (const board of [false, true])
    test(`${board ? "board-card" : "chat"} turn: fast path, its check and the advice are in the prompt`, async () => {
      const prompt = await sent(board);
      expect(prompt).toContain("BOARD-FAST-PATH-7731");
      expect(prompt).toContain("先按技能的快路径做");
      expect(prompt).toContain("不要先逐个打开文件");
      expect(prompt).toContain(CHECK);
    });
});
