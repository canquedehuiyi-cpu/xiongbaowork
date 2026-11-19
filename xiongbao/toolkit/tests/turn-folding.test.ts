import { describe, expect, test } from "bun:test";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import { foldingEarlyResults, type Prompt } from "../src/copilotkit/last-step";
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateTokens,
  FIXED_PROMPT_TOKENS,
  FOLD_BUDGET_TOKENS,
  FOLD_KEEP_STEPS,
  FOLDED_PREFIX,
  foldBudgetFrom,
  foldEarlyResults,
  foldedSummary,
} from "../src/copilotkit/turn-folding";
import { parametersFor } from "../src/granted-tool";

/*
 * 期七：一轮里越过窗口的 70% 才折叠较早的工具结果；最近几步不动；折叠之后下一步和上一步共享前缀；
 * 没越线时历史逐字节不变。
 */

const WINDOW = 20_000;

/** 第 i 步的工具结果：每个都不一样，长度可调。 */
function resultText(index: number, chars: number): string {
  return `第${index}步的输出：${"x".repeat(chars)}结尾${index}`;
}

/** 一轮里前 `steps` 步的提示：系统、用户，之后每步一条带工具调用的 assistant 和它的结果。 */
function promptAfter(
  steps: number,
  chars = 4_000,
  tool = "computer_run_command",
) {
  const prompt: unknown[] = [
    { role: "system", content: "你是员工。" },
    { role: "user", content: [{ type: "text", text: "查一下" }] },
  ];
  for (let index = 1; index <= steps; index += 1) {
    prompt.push({
      role: "assistant",
      content: [
        { type: "text", text: `第${index}步` },
        {
          type: "tool-call",
          toolCallId: `call-${index}`,
          toolName: tool,
          input: JSON.stringify({ command: `cmd ${index}` }),
        },
      ],
    });
    prompt.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${index}`,
          toolName: tool,
          output: { type: "text", value: resultText(index, chars) },
        },
      ],
    });
  }
  return prompt as Prompt;
}

const outputOf = (prompt: Prompt, step: number) => {
  const message = prompt[2 + (step - 1) * 2 + 1] as {
    content: { output: { type: string; value: string } }[];
  };
  return message.content[0]?.output.value ?? "";
};

/** 第一次折叠发生在第几步：这一步的提示折完和原来不一样。 */
function firstFoldAt(window: number, max = 60, chars = 4_000): number {
  for (let steps = 1; steps <= max; steps += 1) {
    const raw = promptAfter(steps, chars);
    if (
      JSON.stringify(foldEarlyResults(raw, { window })) !== JSON.stringify(raw)
    )
      return steps;
  }
  return 0;
}

describe("没越线", () => {
  test("历史逐字节不变，返回的就是同一个数组", () => {
    const prompt = promptAfter(5);
    const before = JSON.stringify(prompt);
    const folded = foldEarlyResults(prompt, { window: WINDOW });
    expect(folded).toBe(prompt);
    expect(JSON.stringify(folded)).toBe(before);
  });

  test("窗口大到 70% 远没到时，再长的历史也不动", () => {
    const prompt = promptAfter(30);
    expect(foldEarlyResults(prompt, { window: 1_000_000 })).toBe(prompt);
  });
});

describe("越过 70%", () => {
  test("越线的那一步折叠较早的结果，最近几步原样", () => {
    const crossing = firstFoldAt(WINDOW);
    expect(crossing).toBeGreaterThan(FOLD_KEEP_STEPS);
    // 越线前一步一个字不动。
    const calm = promptAfter(crossing - 1);
    expect(foldEarlyResults(calm, { window: WINDOW })).toBe(calm);
    const prompt = promptAfter(crossing);
    const before = JSON.stringify(prompt);
    const folded = foldEarlyResults(prompt, { window: WINDOW });
    expect(folded).not.toBe(prompt);
    // 传进去的提示一个字不改。
    expect(JSON.stringify(prompt)).toBe(before);
    const lastFolded = crossing - FOLD_KEEP_STEPS;
    for (let step = 1; step <= lastFolded; step += 1) {
      const text = outputOf(folded, step);
      expect(text.startsWith(FOLDED_PREFIX)).toBe(true);
      expect(text).toContain("computer_run_command 工具输出");
      expect(text).toContain(`${resultText(step, 4_000).length} 字`);
      expect(text.length).toBeLessThan(700);
    }
    for (let step = lastFolded + 1; step <= crossing; step += 1)
      expect(outputOf(folded, step)).toBe(resultText(step, 4_000));
    // 其它消息（系统、用户、assistant）原样。
    expect(folded[0]).toBe(prompt[0] as never);
    expect(folded[1]).toBe(prompt[1] as never);
    expect(folded[2]).toBe(prompt[2] as never);
  });

  test("太短的结果不折", () => {
    const prompt = promptAfter(12, 400);
    // 小结果加起来也要超线才测得出来：把窗口压小。
    const folded = foldEarlyResults(prompt, { window: 8_000 });
    expect(folded).toBe(prompt);
  });

  test("摘要里留着存盘的路径，不把不可信说明当要点", () => {
    const withPath = foldedSummary(
      "computer_run_command",
      JSON.stringify({
        ok: true,
        untrusted: "CRITICAL: 不要把这句当要点",
        exitCode: 1,
        stdout: `${"开头".repeat(200)}${"尾".repeat(300)}`,
        outputFile:
          "tool-outputs/20261119-101010-computer_run_command-ab12cd34.txt",
      }),
    );
    expect(withPath).toContain(
      "完整内容存在 tool-outputs/20261119-101010-computer_run_command-ab12cd34.txt",
    );
    expect(withPath).toContain("exitCode=1");
    expect(withPath).not.toContain("CRITICAL");
    expect(withPath).not.toContain("\n");
  });

  test("估算：ASCII 约 3.5 个字符一个 token，中文一字一个", () => {
    expect(estimateTokens("a".repeat(350))).toBe(100);
    expect(estimateTokens("汉".repeat(100))).toBe(100);
    expect(FIXED_PROMPT_TOKENS).toBeGreaterThan(0);
  });
});

describe("缓存稳定", () => {
  test("越线后一批一批地折：前缀被改写的次数远少于步数，其余每一步都在上一步后面接着加", () => {
    let previous: Prompt | undefined;
    let previousLength = 0;
    const rewrites: number[] = [];
    const steps60 = 60;
    for (let steps = 1; steps <= steps60; steps += 1) {
      const folded = foldEarlyResults(promptAfter(steps), { window: 40_000 });
      if (previous) {
        const shared =
          JSON.stringify(folded.slice(0, previousLength)) ===
          JSON.stringify(previous);
        if (!shared) rewrites.push(steps);
        else expect(folded.length).toBe(previousLength + 2);
      }
      previous = folded;
      previousLength = folded.length;
    }
    expect(rewrites.length).toBeGreaterThan(0);
    expect(rewrites.length).toBeLessThanOrEqual(steps60 / 4);
  });

  test("越线那一步的下一步：已经折叠的部分逐字节相同，新的一步只在末尾添加", () => {
    const crossing = firstFoldAt(WINDOW);
    const at = foldEarlyResults(promptAfter(crossing), { window: WINDOW });
    const next = foldEarlyResults(promptAfter(crossing + 1), {
      window: WINDOW,
    });
    expect(JSON.stringify(next.slice(0, at.length))).toBe(JSON.stringify(at));
    expect(next.length).toBe(at.length + 2);
  });

  test("下一轮从存起来的完整历史重新开始，重放出同样的折叠", () => {
    // 同一份完整历史，任何时候重放，折叠结果一样：不靠实例里的状态。
    const a = foldEarlyResults(promptAfter(20), { window: WINDOW });
    const b = foldEarlyResults(promptAfter(20), { window: WINDOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("绝对预算：窗口再大也有一条线", () => {
  /** 窗口大到 70% 永远到不了；预算压得小，几十步的提示就能越线。 */
  const HUGE = 1_000_000;
  const BUDGET = 20_000;

  /** 第一次折叠发生在第几步。 */
  function crossingAt(options: { window: number; budget?: number }, max = 80) {
    for (let steps = 1; steps <= max; steps += 1) {
      const raw = promptAfter(steps);
      if (foldEarlyResults(raw, options) !== raw) return steps;
    }
    return 0;
  }

  test("窗口很大时，估算超过预算就折叠；没超过一个字不动，返回同一个数组", () => {
    const crossing = crossingAt({ window: HUGE, budget: BUDGET });
    expect(crossing).toBeGreaterThan(FOLD_KEEP_STEPS);
    const calm = promptAfter(crossing - 1);
    expect(foldEarlyResults(calm, { window: HUGE, budget: BUDGET })).toBe(calm);
    const prompt = promptAfter(crossing);
    const before = JSON.stringify(prompt);
    const folded = foldEarlyResults(prompt, { window: HUGE, budget: BUDGET });
    expect(folded).not.toBe(prompt);
    expect(JSON.stringify(prompt)).toBe(before);
    expect(outputOf(folded, 1).startsWith(FOLDED_PREFIX)).toBe(true);
  });

  test("不传预算就用默认的 FOLD_BUDGET_TOKENS：大窗口下重的一轮折叠，轻的一轮不动", () => {
    expect(FOLD_BUDGET_TOKENS).toBeGreaterThanOrEqual(48_000);
    expect(FOLD_BUDGET_TOKENS).toBeLessThanOrEqual(64_000);
    // 每步约 4.6K token，30 步远超预算，窗口 1M 的 70% 却远没到。
    const heavy = promptAfter(30, 16_000);
    const folded = foldEarlyResults(heavy, { window: HUGE });
    expect(folded).not.toBe(heavy);
    expect(outputOf(folded, 1).startsWith(FOLDED_PREFIX)).toBe(true);
    expect(outputOf(folded, 30)).toBe(resultText(30, 16_000));
    // 每步约 1.2K token，十几步加起来也在预算以内。
    const light = promptAfter(12);
    expect(foldEarlyResults(light, { window: HUGE })).toBe(light);
  });

  test("预算取窗口比例和绝对预算里小的那个：窗口小时还是按窗口比例", () => {
    // 窗口 20k 的 70% 是 14k，比默认预算小得多：折叠发生的那一步和没有预算时一样。
    const byWindow = crossingAt({ window: WINDOW, budget: 0 });
    expect(byWindow).toBeGreaterThan(FOLD_KEEP_STEPS);
    expect(crossingAt({ window: WINDOW })).toBe(byWindow);
    expect(crossingAt({ window: WINDOW, budget: 10 ** 9 })).toBe(byWindow);
    // 预算比窗口比例还小，预算说了算。
    expect(crossingAt({ window: WINDOW, budget: 8_000 })).toBeLessThan(
      byWindow,
    );
  });

  test("预算为 0：和期七原来一样，大窗口不折，小窗口折叠的位置和内容都不变", () => {
    const long = promptAfter(60);
    expect(foldEarlyResults(long, { window: HUGE, budget: 0 })).toBe(long);
    for (let steps = 1; steps <= 40; steps += 1) {
      const raw = promptAfter(steps);
      const off = foldEarlyResults(raw, { window: WINDOW, budget: 0 });
      // 一个大到永远越不到的预算，等于没有预算。
      const never = foldEarlyResults(raw, { window: WINDOW, budget: 10 ** 12 });
      expect(JSON.stringify(off)).toBe(JSON.stringify(never));
      // 窗口比例比默认预算小时，默认预算也不改变结果。
      expect(JSON.stringify(foldEarlyResults(raw, { window: WINDOW }))).toBe(
        JSON.stringify(off),
      );
    }
  });

  test("折叠前缀稳定：重放两次逐字节相同，下一步只在末尾追加", () => {
    const crossing = crossingAt({ window: HUGE, budget: BUDGET });
    const options = { window: HUGE, budget: BUDGET };
    const a = foldEarlyResults(promptAfter(crossing + 3), options);
    const b = foldEarlyResults(promptAfter(crossing + 3), options);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const at = foldEarlyResults(promptAfter(crossing), options);
    const next = foldEarlyResults(promptAfter(crossing + 1), options);
    expect(JSON.stringify(next.slice(0, at.length))).toBe(JSON.stringify(at));
    expect(next.length).toBe(at.length + 2);
  });

  test("一批一批地折：前缀被改写的次数远少于步数，两次改写之间隔着几步，其余每步只在末尾追加", () => {
    const options = { window: HUGE, budget: BUDGET };
    const total = 60;
    let previous: Prompt | undefined;
    const rewrites: number[] = [];
    for (let steps = 1; steps <= total; steps += 1) {
      const folded = foldEarlyResults(promptAfter(steps), options);
      if (previous) {
        const shared =
          JSON.stringify(folded.slice(0, previous.length)) ===
          JSON.stringify(previous);
        if (!shared) rewrites.push(steps);
        else expect(folded.length).toBe(previous.length + 2);
      }
      previous = folded;
    }
    // 不止折一次：窗口比例算的「再涨 15% 窗口」在这里是 15 万，按它一次之后就再也不折了。
    expect(rewrites.length).toBeGreaterThanOrEqual(2);
    expect(rewrites.length).toBeLessThanOrEqual(total / 4);
    for (let index = 1; index < rewrites.length; index += 1)
      expect(
        (rewrites[index] ?? 0) - (rewrites[index - 1] ?? 0),
      ).toBeGreaterThan(2);
  });

  test("最近 4 步原样，不论折过几批", () => {
    for (const steps of [20, 33, 47, 60]) {
      const raw = promptAfter(steps);
      const folded = foldEarlyResults(raw, { window: HUGE, budget: BUDGET });
      expect(folded).not.toBe(raw);
      for (let step = steps - FOLD_KEEP_STEPS + 1; step <= steps; step += 1)
        expect(outputOf(folded, step)).toBe(resultText(step, 4_000));
    }
  });

  test("摘要指向存盘的文件：存了盘的写明用 computer_read_file 读，没存盘的不编路径", () => {
    const saved = foldedSummary(
      "web_fetch",
      JSON.stringify({
        url: "https://example.com",
        content: "正文".repeat(400),
        saved_to: "tool-outputs/20261119-101010-web_fetch-ab12cd34.txt",
      }),
    );
    expect(saved).toContain(
      "tool-outputs/20261119-101010-web_fetch-ab12cd34.txt",
    );
    expect(saved).toContain("computer_read_file");
    const unsaved = foldedSummary("web_fetch", "正文".repeat(400));
    expect(unsaved).not.toContain("tool-outputs/");
    expect(unsaved).toContain("重新调用工具");
  });

  test("环境变量：没设、空、不是数字、负数用默认值，0 关掉，其余取整", () => {
    expect(foldBudgetFrom(undefined)).toBeUndefined();
    expect(foldBudgetFrom("")).toBeUndefined();
    expect(foldBudgetFrom("  ")).toBeUndefined();
    expect(foldBudgetFrom("lots")).toBeUndefined();
    expect(foldBudgetFrom("-5")).toBeUndefined();
    expect(foldBudgetFrom("0")).toBe(0);
    expect(foldBudgetFrom(" 48000 ")).toBe(48_000);
    expect(foldBudgetFrom("48000.9")).toBe(48_000);
  });
});

describe("包在模型外面", () => {
  function recordingModel(seen: Prompt[]) {
    return {
      specificationVersion: "v3" as const,
      provider: "fake",
      modelId: "fake-model",
      supportedUrls: {},
      doGenerate: async (options: { prompt: Prompt }) => {
        seen.push(options.prompt);
        return {} as never;
      },
      doStream: async (options: { prompt: Prompt }) => {
        seen.push(options.prompt);
        return { stream: new ReadableStream() } as never;
      },
    };
  }
  const configurationFor = (seen: Prompt[]) =>
    ({
      model: recordingModel(seen) as never,
      prompt: "x",
    }) as BuiltInAgentConfiguration;

  test("模型窗口问一次；越线就把折叠后的提示交给模型，调用方手里的提示不变", async () => {
    const seen: Prompt[] = [];
    const asked: string[] = [];
    const wrapped = foldingEarlyResults(configurationFor(seen), {
      windowFor: (provider, modelId) => {
        asked.push(`${provider}/${modelId}`);
        return WINDOW;
      },
    });
    if ("factory" in wrapped) throw new Error("not a factory");
    const model = wrapped.model as unknown as {
      doStream: (options: { prompt: Prompt }) => Promise<unknown>;
    };
    const prompt = promptAfter(12);
    const before = JSON.stringify(prompt);
    await model.doStream({ prompt });
    await model.doStream({ prompt });
    expect(asked).toEqual(["fake/fake-model"]);
    expect(JSON.stringify(prompt)).toBe(before);
    expect(outputOf(seen[0] as Prompt, 1).startsWith(FOLDED_PREFIX)).toBe(true);
    expect(outputOf(seen[0] as Prompt, 12)).toBe(resultText(12, 4_000));
  });

  test("没越线时模型收到的就是原来那份", async () => {
    const seen: Prompt[] = [];
    const wrapped = foldingEarlyResults(configurationFor(seen), {
      windowFor: () => 1_000_000,
    });
    if ("factory" in wrapped) throw new Error("not a factory");
    const prompt = promptAfter(12);
    await (
      wrapped.model as unknown as {
        doGenerate: (options: { prompt: Prompt }) => Promise<unknown>;
      }
    ).doGenerate({ prompt });
    expect(seen[0]).toBe(prompt);
  });

  test("窗口很大时，预算也折叠；预算 0 关掉；不给预算用默认值", async () => {
    const run = async (budget?: number) => {
      const seen: Prompt[] = [];
      const wrapped = foldingEarlyResults(configurationFor(seen), {
        windowFor: () => 1_000_000,
        ...(budget === undefined ? {} : { budget }),
      });
      if ("factory" in wrapped) throw new Error("not a factory");
      const prompt = promptAfter(30);
      await (
        wrapped.model as unknown as {
          doStream: (options: { prompt: Prompt }) => Promise<unknown>;
        }
      ).doStream({ prompt });
      return { prompt, sent: seen[0] as Prompt };
    };
    const small = await run(20_000);
    expect(outputOf(small.sent, 1).startsWith(FOLDED_PREFIX)).toBe(true);
    expect(outputOf(small.sent, 30)).toBe(resultText(30, 4_000));
    const off = await run(0);
    expect(off.sent).toBe(off.prompt);
    // 默认预算比这一轮的总量大：一个字不动。
    const byDefault = await run();
    expect(byDefault.sent).toBe(byDefault.prompt);
  });

  test("读不到窗口（没给、返回空、抛错）就用保守的默认值", async () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
    for (const windowFor of [
      undefined,
      () => undefined,
      () => {
        throw new Error("目录读不到");
      },
    ]) {
      const seen: Prompt[] = [];
      const wrapped = foldingEarlyResults(
        configurationFor(seen),
        windowFor ? { windowFor } : {},
      );
      if ("factory" in wrapped) throw new Error("not a factory");
      // 默认 128k：70% 约 9 万 token。三十步每步约 5 万字符估出来远不到，也要折得动：加大每步的量。
      const prompt = promptAfter(30, 30_000);
      await (
        wrapped.model as unknown as {
          doStream: (options: { prompt: Prompt }) => Promise<unknown>;
        }
      ).doStream({ prompt });
      expect(outputOf(seen[0] as Prompt, 1).startsWith(FOLDED_PREFIX)).toBe(
        true,
      );
    }
  });
});

describe("接在员工的运行里", () => {
  /** 一个什么都不做的模型：把每一步收到的提示记下来，答一句话就结束。 */
  function listening(seen: Prompt[]) {
    return {
      specificationVersion: "v3" as const,
      provider: "fake.chat",
      modelId: "fake-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("Only streamed here.");
      },
      doStream: async (options: { prompt: Prompt }) => {
        seen.push(options.prompt);
        const parts = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "好了。" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ];
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    };
  }

  /** 已经跑了十二步的一轮：用户一句话，之后每步一次工具调用和它的结果。 */
  const turn = () => [
    { id: "ask", role: "user" as const, content: "查一下" },
    ...Array.from({ length: 12 }, (_, index) => index + 1).flatMap((n) => [
      {
        id: `call-message-${n}`,
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: `call-${n}`,
            type: "function" as const,
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      {
        id: `result-${n}`,
        role: "tool" as const,
        toolCallId: `call-${n}`,
        content: resultText(n, 4_000),
      },
    ]),
  ];

  async function promptSeen(hooks: Record<string, unknown>) {
    const seen: Prompt[] = [];
    const agent = new BuiltInAgentWithSaneHistory(
      {
        model: listening(seen) as never,
        prompt: "查资料。",
        maxSteps: 3,
        tools: [
          {
            name: "search",
            description: "Search the web.",
            parameters: parametersFor({
              type: "object",
              properties: {},
            } as never),
            execute: async () => "A result.",
          },
        ],
      } as BuiltInAgentConfiguration,
      { observe: (run) => run, ...hooks },
    );
    agent.threadId = "thread";
    agent.setMessages(turn());
    await agent.runAgent({}, {});
    const prompt = seen[0];
    if (!prompt) throw new Error("The model was never asked.");
    return JSON.stringify(prompt);
  }

  test("越过窗口的 70%，模型收到的是折叠后的；存起来的对话不动", async () => {
    const seen = await promptSeen({ contextWindowFor: () => WINDOW });
    expect(seen).toContain(FOLDED_PREFIX);
    expect(seen).not.toContain(resultText(1, 4_000));
    // 最近几步原样。
    expect(seen).toContain(resultText(12, 4_000));
  });

  test("窗口够大：和没有这个功能一样，模型收到的是原样", async () => {
    const seen = await promptSeen({ contextWindowFor: () => 1_000_000 });
    expect(seen).not.toContain(FOLDED_PREFIX);
    expect(seen).toContain(resultText(1, 4_000));
  });

  test("窗口再大，预算小了也折：foldBudgetTokens；0 关掉", async () => {
    const small = await promptSeen({
      contextWindowFor: () => 1_000_000,
      foldBudgetTokens: 10_000,
    });
    expect(small).toContain(FOLDED_PREFIX);
    expect(small).not.toContain(resultText(1, 4_000));
    expect(small).toContain(resultText(12, 4_000));
    const off = await promptSeen({
      contextWindowFor: () => 1_000_000,
      foldBudgetTokens: 0,
    });
    expect(off).not.toContain(FOLDED_PREFIX);
    expect(off).toContain(resultText(1, 4_000));
  });

  test("部署的环境变量 XIONGBAO_TURN_FOLD_BUDGET_TOKENS 设预算；这一次运行的设置优先", async () => {
    const saved = process.env.XIONGBAO_TURN_FOLD_BUDGET_TOKENS;
    try {
      process.env.XIONGBAO_TURN_FOLD_BUDGET_TOKENS = "10000";
      const small = await promptSeen({ contextWindowFor: () => 1_000_000 });
      expect(small).toContain(FOLDED_PREFIX);
      // 运行的设置压过环境变量。
      const off = await promptSeen({
        contextWindowFor: () => 1_000_000,
        foldBudgetTokens: 0,
      });
      expect(off).not.toContain(FOLDED_PREFIX);
      process.env.XIONGBAO_TURN_FOLD_BUDGET_TOKENS = "0";
      const disabled = await promptSeen({ contextWindowFor: () => 1_000_000 });
      expect(disabled).not.toContain(FOLDED_PREFIX);
    } finally {
      if (saved === undefined)
        delete process.env.XIONGBAO_TURN_FOLD_BUDGET_TOKENS;
      else process.env.XIONGBAO_TURN_FOLD_BUDGET_TOKENS = saved;
    }
  });

  test("foldResults: false 关掉", async () => {
    const seen = await promptSeen({
      contextWindowFor: () => WINDOW,
      foldResults: false,
    });
    expect(seen).not.toContain(FOLDED_PREFIX);
    expect(seen).toContain(resultText(1, 4_000));
  });
});
