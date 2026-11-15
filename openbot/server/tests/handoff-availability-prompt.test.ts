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
import { z } from "zod";
import {
  buildAgents,
  type HandoffForRun,
  type RegisteredAgent,
  type RuntimeModel,
} from "../src/copilot";

/*
 * 派不出去的时候，得告诉员工派不出去。
 *
 * L4-2 例 2（2026-11-15，本地 deepseek，`humanize-ppt-team` 的主理人被问打不开的
 * `frontend-slides` 技能）采样 A 的原话是「唯一真缺的是上线分享和 PDF 导出」，然后去派活——
 * 那个 run 里根本没有 `message_bot`：`handoffTool` 在没有可问的 Bot 或部署关掉时返回 null，
 * 这是有意的（不把用不上的工具摆在模型面前）。
 *
 * 但「不给工具」只挡住了「调用」，挡不住「许诺」。模型没有任何一句话告诉它这条路不存在，于是它
 * 把「我打算派」说成了「我派了」。`server/src/agents/handoff-tool.ts` 的注释预判了前者
 * （"a model offered a tool it may never use ... tells the person it tried"），漏掉了后者。
 *
 * 这一段只在真的没有 `message_bot` 时出现：有它的时候工具自己的 description 已经说清怎么用。
 */

const bot: RegisteredAgent = {
  id: "studio-lead",
  name: "主理人",
  type: "built_in",
  systemPrompt: "You lead a small studio and answer in Chinese.",
};

const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };

/** 一次不派给任何人的 run：`handoff` 缺省，`passing` 为空，和真机上那次一样。 */
async function promptSent(withHandoff: boolean) {
  const handoff: HandoffForRun | undefined = withHandoff
    ? async () => [
        {
          name: "message_bot",
          description: "Hand a piece of work to another Bot in this workspace.",
          parameters: z.object({ bot: z.string(), task: z.string() }),
          execute: async () => "HANDED-OVER",
        },
      ]
    : undefined;

  const agents = await buildAgents(
    [bot],
    model,
    "synthetic-key",
    undefined,
    async () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    handoff,
  );
  const agent = agents[bot.id]?.clone();
  if (!agent) throw new Error("Bot missing");
  const messages: Message[] = [
    { id: "q", role: "user", content: "用 frontend-slides 做个能分享的 PPT" },
  ];
  agent.setMessages(messages);
  await agent.runAgent();
  return wire.join("\n");
}

const llm = new LLMock();
const wire: string[] = [];
let recorder: ReturnType<typeof Bun.serve> | undefined;
const original = process.env.OPENAI_BASE_URL;

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
  llm.onMessage(/.*/, { content: "好的。" });
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

describe("这一轮派不出去的时候", () => {
  test("明确告诉它：这里没有能把活交给另一个 Bot 的工具", async () => {
    const sent = await promptSent(false);
    expect(sent).toContain("<handing_over>");
    expect(sent).toContain("no tool here for handing work to another Bot");
  });

  /*
   * 只写「没有工具」不够。那次翻车不是它调了工具被拒，是它从头到尾没调、却把话说了出去。所以还得
   * 点名这个具体的说法：不要把「打算派」说成「已经派」。
   */
  test("并且点名那个具体说法：没真发出去就不许说已经交代给同事", async () => {
    const sent = await promptSent(false);
    expect(sent).toContain("Do not say you have asked");
  });

  test("也告诉它该怎么做：自己能做的做完，做不了的说清缺什么", async () => {
    const sent = await promptSent(false);
    expect(sent).toContain("finish everything else and say which part is not done");
    expect(sent).toContain("what it would need");
  });
});

describe("这一轮派得出去的时候", () => {
  test("一个字都不说：工具自己的 description 已经讲清怎么用", async () => {
    const sent = await promptSent(true);
    expect(sent).toContain("message_bot");
    expect(sent).not.toContain("<handing_over>");
    expect(sent).not.toContain("no tool here for handing work to another Bot");
  });
});
