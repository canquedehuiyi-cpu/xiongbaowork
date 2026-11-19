import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import type { Database } from "../src/db/client";
import {
  type ContextLimitDeps,
  contextBreakdownRecorder,
  contextUsageFrom,
  promptShares,
  resolveContextLimit,
  runContextSections,
  usedTokens,
} from "../src/threads/context-usage";

/*
 * 对话侧栏「上下文」一块的算法：已用口径、上限取值顺序、分类比例与预留 / 空余。纯函数，不连库；
 * 读库的部分在 context-usage.integration.test.ts。
 */

describe("used tokens", () => {
  test("used tokens are input_tokens; cached_input_tokens and cache_write_tokens are not added again", () => {
    // AI SDK v3 的 Anthropic 用量：input_tokens 已是 1 000 + 30 000 + 2 000 的总数。
    const row = {
      inputTokens: 33_000,
      cachedInputTokens: 30_000,
      cacheWriteTokens: 2_000,
    };
    expect(usedTokens({ provider: "anthropic", ...row })).toBe(33_000);
    expect(usedTokens({ provider: "anthropic.messages", ...row })).toBe(33_000);
  });

  test("openai-family usage takes input_tokens only", () => {
    for (const provider of ["openai", "deepseek", "zhipu", "custom", "google"])
      expect(
        usedTokens({
          provider,
          inputTokens: 40_000,
          cachedInputTokens: 30_000,
          cacheWriteTokens: 5,
        }),
      ).toBe(40_000);
  });

  test("unknown usage gives null", () => {
    for (const provider of ["anthropic", "openai"])
      expect(
        usedTokens({
          provider,
          inputTokens: null,
          cachedInputTokens: 30_000,
          cacheWriteTokens: 2_000,
        }),
      ).toBeNull();
  });
});

describe("context limit", () => {
  type Row = Awaited<ReturnType<ContextLimitDeps["registryRow"]>>;
  function deps(options: {
    registry?: Record<string, Row>;
    pool?: Record<string, Row>;
    catalogue?: Record<string, number>;
  }) {
    const asked: string[] = [];
    const value: ContextLimitDeps = {
      registryRow: async (id) => options.registry?.[id] ?? null,
      poolRow: async (id) => options.pool?.[id] ?? null,
      catalogue: async (provider, modelName, baseUrl) => {
        asked.push(`${provider}|${modelName}|${baseUrl ?? ""}`);
        return options.catalogue?.[`${provider}/${modelName}`];
      },
    };
    return { value, asked };
  }
  const call = {
    modelRef: "lib-1",
    platformModelRef: "pool-1",
    provider: "deepseek",
    modelName: "deepseek-chat",
  };

  test("limit prefers registry, then pool, then catalogue by provider+model, else null", async () => {
    const registry = {
      "lib-1": { contextWindow: 200_000, baseUrl: null },
    };
    const pool = { "pool-1": { contextWindow: 64_000, baseUrl: null } };
    const catalogue = { "deepseek/deepseek-chat": 128_000 };

    expect(
      await resolveContextLimit(
        call,
        deps({ registry, pool, catalogue }).value,
      ),
    ).toBe(200_000);
    // 模型库行在但没填上限：往下找平台模型池。
    expect(
      await resolveContextLimit(
        call,
        deps({
          registry: { "lib-1": { contextWindow: null, baseUrl: null } },
          pool,
          catalogue,
        }).value,
      ),
    ).toBe(64_000);
    // 两行都没有：按实际调用的服务商 + 模型名查目录。
    const both = deps({ catalogue });
    expect(await resolveContextLimit(call, both.value)).toBe(128_000);
    expect(both.asked).toEqual(["deepseek|deepseek-chat|"]);
    // 目录也没有：未知。
    expect(await resolveContextLimit(call, deps({}).value)).toBeNull();
    // 部署默认模型的调用没有模型库 / 模型池行，直接查目录。
    expect(
      await resolveContextLimit(
        { ...call, modelRef: null, platformModelRef: null },
        deps({ registry, pool, catalogue }).value,
      ),
    ).toBe(128_000);
  });

  test("the catalogue is asked with the bound row's base URL, for a custom endpoint", async () => {
    const lookup = deps({
      registry: {
        "lib-1": {
          contextWindow: null,
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        },
      },
    });
    await resolveContextLimit(
      { ...call, platformModelRef: null, provider: "custom", modelName: "q" },
      lookup.value,
    );
    expect(lookup.asked).toEqual([
      "custom|q|https://dashscope.aliyuncs.com/compatible-mode/v1",
    ]);
  });
});

describe("context usage", () => {
  const shares = {
    messages: 0.583,
    system: 0.128,
    tools: 0.18,
    skills: 0.058,
    memory: 0.051,
  };
  const lastModel = { provider: "openai", name: "gpt-x" };

  test("categories split used by the latest shares and add reserve 10% and free", () => {
    const usage = contextUsageFrom({
      used: 53_200,
      limit: 128_000,
      shares,
      lastModel,
    });
    expect(usage.used).toBe(53_200);
    expect(usage.limit).toBe(128_000);
    expect(usage.percent).toBe(41.6);
    expect(usage.untilAutoCompact).toBe(62_000);
    expect(usage.lastModel).toEqual(lastModel);
    expect(usage.categories.map((category) => category.key)).toEqual([
      "messages",
      "system",
      "tools",
      "skills",
      "memory",
      "reserve",
      "free",
    ]);
    const tokens = Object.fromEntries(
      usage.categories.map((category) => [category.key, category.tokens]),
    );
    expect(tokens.reserve).toBe(12_800);
    expect(tokens.free).toBe(62_000);
    const five = ["messages", "system", "tools", "skills", "memory"] as const;
    for (const key of five) {
      expect(Number.isInteger(tokens[key])).toBeTrue();
      expect(
        Math.abs((tokens[key] as number) - shares[key] * 53_200),
      ).toBeLessThan(1);
    }
    expect(five.reduce((sum, key) => sum + (tokens[key] as number), 0)).toBe(
      53_200,
    );
  });

  test("free never goes below zero", () => {
    const usage = contextUsageFrom({
      used: 120_000,
      limit: 128_000,
      shares,
      lastModel,
    });
    expect(usage.untilAutoCompact).toBe(0);
    expect(usage.categories.find((c) => c.key === "free")?.tokens).toBe(0);
  });

  test("no limit → percent, reserve, free and untilAutoCompact are null", () => {
    const usage = contextUsageFrom({
      used: 53_200,
      limit: null,
      shares,
      lastModel,
    });
    expect(usage.used).toBe(53_200);
    expect(usage.limit).toBeNull();
    expect(usage.percent).toBeNull();
    expect(usage.untilAutoCompact).toBeNull();
    const keys = usage.categories.map((category) => category.key);
    expect(keys).not.toContain("reserve");
    expect(keys).not.toContain("free");
    expect(usage.categories.reduce((sum, c) => sum + c.tokens, 0)).toBe(53_200);
  });

  test("no usage → nothing is made up", () => {
    const usage = contextUsageFrom({
      used: null,
      limit: 128_000,
      shares,
      lastModel: null,
    });
    expect(usage).toEqual({
      used: null,
      limit: 128_000,
      percent: null,
      categories: [],
      untilAutoCompact: null,
      lastModel: null,
    });
  });

  test("no shares yet → no five-way split, reserve and free still shown", () => {
    const usage = contextUsageFrom({
      used: 10_000,
      limit: 100_000,
      shares: null,
      lastModel,
    });
    expect(usage.categories).toEqual([
      { key: "reserve", tokens: 10_000 },
      { key: "free", tokens: 80_000 },
    ]);
  });
});

describe("prompt shares", () => {
  test("shares are the fraction of characters per category and sum to 1", () => {
    const shares = promptShares([
      { key: "system", chars: 300 },
      { key: "messages", chars: 500 },
      { key: "system", chars: 100 },
      { key: "tools", chars: 100 },
    ]);
    expect(shares).toEqual({
      messages: 0.5,
      system: 0.4,
      tools: 0.1,
      skills: 0,
      memory: 0,
    });
  });

  test("no characters gives all zeros", () => {
    expect(promptShares([])).toEqual({
      messages: 0,
      system: 0,
      tools: 0,
      skills: 0,
      memory: 0,
    });
  });

  test("a run is split by prompt section, context entry, message and tool", () => {
    const prompt = [
      "<identity>\nI am Bot.\n</identity>",
      "<apps>\nYou hold Linear.\n</apps>",
      "<computer>\nA browser.\n</computer>",
      "<learned_skills>\nSkill A.\n</learned_skills>",
      "<model_and_date>\nToday.\n</model_and_date>",
    ].join("\n\n");
    const appsBlock = "<apps>\nYou hold Linear.\n</apps>";
    const skillsBlock = "<learned_skills>\nSkill A.\n</learned_skills>";
    const sections = runContextSections({
      configuration: {
        prompt,
        tools: [
          {
            name: "linear_search",
            description: "Search Linear.",
            parameters: z.object({ query: z.string() }),
          },
          {
            name: "waiting_tool",
            description: "Waits behind search.",
            parameters: z.object({}),
          },
        ],
      },
      input: {
        messages: [
          { id: "m0", role: "system", content: "dropped before the model" },
          { id: "m1", role: "user", content: "hello" },
          {
            id: "m2",
            role: "assistant",
            content: "hi",
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "x", arguments: '{"a":1}' },
              },
            ],
          },
          { id: "m3", role: "tool", content: "result", toolCallId: "c1" },
        ],
        context: [
          { description: "OpenBot personal memory", value: "likes tea" },
          { description: "Name", value: "Ann" },
        ],
        state: {},
        tools: [
          {
            name: "computer_read",
            description: "Read the page.",
            parameters: { type: "object" },
          },
        ],
      },
      waiting: new Set(["waiting_tool"]),
    });
    const total = (key: string) =>
      sections
        .filter((section) => section.key === key)
        .reduce((sum, section) => sum + section.chars, 0);
    expect(total("skills")).toBe(skillsBlock.length);
    expect(total("memory")).toBe("likes tea".length);
    expect(total("system")).toBe(
      prompt.length -
        appsBlock.length -
        skillsBlock.length +
        "Name".length +
        "Ann".length,
    );
    // 历史消息：系统消息不发给模型，不算；工具调用的名字和参数算。
    expect(total("messages")).toBe(
      "hello".length +
        "hi".length +
        "x".length +
        '{"a":1}'.length +
        "result".length,
    );
    // 工具：apps 段 + 实际发出的工具说明与 schema；等在搜索后面的不算。
    const tools = total("tools");
    expect(tools).toBeGreaterThan(
      appsBlock.length + "linear_search".length + "computer_read".length,
    );
    const withWaiting = runContextSections({
      configuration: {
        prompt: "",
        tools: [
          {
            name: "waiting_tool",
            description: "Waits behind search.",
            parameters: z.object({}),
          },
        ],
      },
      input: { messages: [], context: [], state: {}, tools: [] },
      waiting: new Set(["waiting_tool"]),
    });
    expect(withWaiting).toEqual([]);
  });
});

describe("breakdown recorder", () => {
  const run = {
    runId: "run-1",
    threadId: "thread-1",
    agentId: "agent-1",
    configuration: { prompt: "<identity>\nBot\n</identity>" },
    input: { messages: [], context: [], state: {}, tools: [] },
  };

  test("a failed write is logged without the error and never reaches the run", async () => {
    let inserts = 0;
    const database = {
      insert: () => {
        inserts += 1;
        throw new Error("connection string postgres://secret@db");
      },
    } as unknown as Database;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        contextBreakdownRecorder(database, "person-1")(run),
      ).not.toThrow();
      for (let i = 0; i < 50 && logged.mock.calls.length === 0; i++)
        await Bun.sleep(5);
      expect(inserts).toBe(1);
      expect(logged).toHaveBeenCalledTimes(1);
      const entry = JSON.stringify(logged.mock.calls[0]);
      expect(entry).toContain("thread_context_breakdown_write_failed");
      expect(entry).not.toContain("secret");
    } finally {
      logged.mockRestore();
    }
  });

  test("nothing is written for a tenant that is nobody's", async () => {
    let inserts = 0;
    const database = {
      insert: () => {
        inserts += 1;
        throw new Error("should not be called");
      },
    } as unknown as Database;
    for (const tenant of ["system", "platform", "team", ""])
      contextBreakdownRecorder(database, tenant)(run);
    await Bun.sleep(20);
    expect(inserts).toBe(0);
  });
});
