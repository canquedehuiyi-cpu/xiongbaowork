import { describe, expect, test } from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import type { RunnerLike } from "@xiongbao/toolkit/run-turn";
import { Observable } from "rxjs";
import { readSubagentResult } from "../../shared/subagent";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createSubagents } from "../src/agents/subagent";
import { runAsTenant } from "../src/tenant/context";
import { OUTPUT_INLINE_BYTES, type OutputSink } from "../src/tool-output";

/*
 * 子代理的答复回到员工的对话里，在那之后的每一步里都要再发一遍。答复超过 16KB（和别的大段工具输出同一个
 * 阈值）就存进工作区，回传里给开头、结尾和路径；存不了就原样给，不丢内容。
 */

/** 一个真的内置员工当子代理跑：模型是 aimock，回 `reply` 就结束。 */
async function fixture(options: { reply: string; sink?: OutputSink }) {
  const llm = new LLMock({ host: "127.0.0.1", port: 0 });
  llm.on({ predicate: () => true }, () => ({ content: options.reply }));
  const originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "员工", type: "built_in", systemPrompt: "做事。" },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: () => async () => [],
  });
  const runner: RunnerLike = {
    run: ({ agent, input }) =>
      new Observable((observer) => {
        agent
          .runAgent(input, { onEvent: ({ event }) => observer.next(event) })
          .then(
            () => observer.complete(),
            (error) => observer.error(error),
          );
      }),
    stop: async () => true,
  };
  const sinkFor: string[] = [];
  const subagents = createSubagents({
    turn: {
      admission: async ({ signal }) => signal ?? new AbortController().signal,
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner,
    },
    buildAgentFor: async ({ ownerUserId, agentId, initiator }) =>
      resolver.resolveAgentForActor(
        { id: ownerUserId, role: "user" },
        agentId,
        { initiator, subagent: true },
      ),
    withdrawApprovals: async () => undefined,
    ...(options.sink
      ? {
          outputSinkFor: (parent: { botId: string }) => {
            sinkFor.push(parent.botId);
            return options.sink;
          },
        }
      : {}),
  });
  const tool = subagents.toolForRun({
    actorId: "owner",
    botId: "bot",
    threadId: "conversation",
    initiator: { kind: "person" },
  });
  return {
    sinkFor,
    ask: () =>
      runAsTenant(
        "owner",
        () =>
          tool.execute(
            { task: "查一件事", answer: "一张表" },
            { toolCallId: "sub-1", signal: new AbortController().signal },
          ) as Promise<string>,
      ),
    async [Symbol.asyncDispose]() {
      await llm.stop();
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
    },
  };
}

/** 比阈值大的一份答复：每行一条，头尾各有标记。 */
const longReply = `头部标记\n${Array.from({ length: 1_500 }, (_, index) => `第 ${index} 行：公司 ${index} 的定价和来源链接`).join("\n")}\n尾部标记`;

describe("子代理答复的长度上限", () => {
  test("测试用的答复确实超过阈值", () => {
    expect(Buffer.byteLength(longReply)).toBeGreaterThan(OUTPUT_INLINE_BYTES);
  });

  test("超过阈值：全文存进工作区，回传里只有头尾、路径和怎么读", async () => {
    const written: { tool: string; id: string; contents: string }[] = [];
    await using f = await fixture({
      reply: longReply,
      sink: async (file) => {
        written.push(file);
        return "tool-outputs/20261119-101010-run_subagent-sub-1.txt";
      },
    });
    const raw = await f.ask();
    const result = readSubagentResult(raw);
    if (!result || !("answer" in result)) throw new Error("it finished");
    expect(written).toHaveLength(1);
    expect(written[0]?.tool).toBe("run_subagent");
    expect(written[0]?.id).toBe("sub-1");
    expect(written[0]?.contents).toBe(longReply);
    expect(result.savedTo).toBe(
      "tool-outputs/20261119-101010-run_subagent-sub-1.txt",
    );
    expect(result.truncated).toContain("computer_read_file");
    expect(result.answer).toContain("头部标记");
    expect(result.answer).toContain("尾部标记");
    expect(Buffer.byteLength(result.answer)).toBeLessThan(
      OUTPUT_INLINE_BYTES / 2,
    );
    expect(result.steps).toBe(0);
    expect(f.sinkFor).toEqual(["bot"]);
  });

  test("没超过阈值：原样给，不存盘，结果里没有 savedTo", async () => {
    const written: unknown[] = [];
    await using f = await fixture({
      reply: "三家公司的表在这里。",
      sink: async (file) => {
        written.push(file);
        return "tool-outputs/x.txt";
      },
    });
    const result = JSON.parse(await f.ask()) as Record<string, unknown>;
    expect(result.answer).toBe("三家公司的表在这里。");
    expect(result).not.toHaveProperty("savedTo");
    expect(result).not.toHaveProperty("truncated");
    expect(written).toHaveLength(0);
  });

  test("存不了（没有电脑、策略不让写）：答复原样给，一个字不丢", async () => {
    await using f = await fixture({
      reply: longReply,
      sink: async () => undefined,
    });
    const result = JSON.parse(await f.ask()) as Record<string, unknown>;
    expect(result.answer).toBe(longReply);
    expect(result).not.toHaveProperty("savedTo");
    expect(result).not.toHaveProperty("truncated");
  });

  test("没给存盘的办法：和以前一样，答复原样给", async () => {
    await using f = await fixture({ reply: longReply });
    const result = JSON.parse(await f.ask()) as Record<string, unknown>;
    expect(result.answer).toBe(longReply);
    expect(result).not.toHaveProperty("savedTo");
  });
});
