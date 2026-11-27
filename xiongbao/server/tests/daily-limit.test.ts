import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { createDailyLimiter, dailyLimitOf } from "../src/learning/daily-limit";
import {
  createRetrospector,
  type RetroTurn,
  traceStepsOf,
} from "../src/learning/retrospect";
import { createMemoryExtractor } from "../src/memory/extract";

const model = {} as LanguageModel;

describe("the daily limiter", () => {
  test("a positive whole number is the limit, anything else is the default", () => {
    expect(dailyLimitOf("X", 6, {})).toBe(6);
    expect(dailyLimitOf("X", 6, { X: "3" })).toBe(3);
    expect(dailyLimitOf("X", 6, { X: "0" })).toBe(6);
    expect(dailyLimitOf("X", 6, { X: "-2" })).toBe(6);
    expect(dailyLimitOf("X", 6, { X: "many" })).toBe(6);
    expect(dailyLimitOf("X", 6, { X: "2.5" })).toBe(6);
  });

  test("each key gets its own count, and a new UTC day starts again", () => {
    let clock = new Date("2026-11-20T10:00:00Z");
    const limiter = createDailyLimiter({ limit: () => 2, now: () => clock });
    expect([1, 2, 3].map(() => limiter.take("a"))).toEqual([true, true, false]);
    expect(limiter.take("b")).toBe(true);
    clock = new Date("2026-11-20T23:59:59Z");
    expect(limiter.take("a")).toBe(false);
    clock = new Date("2026-11-21T00:00:01Z");
    expect(limiter.take("a")).toBe(true);
  });

  test("the limit is read each time it is asked, so a changed setting applies without a restart", () => {
    let limit = 1;
    const limiter = createDailyLimiter({ limit: () => limit });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    limit = 2;
    expect(limiter.take("a")).toBe(true);
  });
});

describe("automatic memory: XIONGBAO_MEMORY_EXTRACT_PER_DAY", () => {
  const turn = (agentId: string) => ({
    ownerUserId: "u1",
    agentId,
    threadId: "t",
    runId: "r",
    messages: [
      { role: "user", content: "我每周五都要发周报给团队，用要点的格式" },
    ],
    reply: "好的，已经按要点格式整理好了",
    failed: false,
  });

  function extractor(limit: number) {
    let modelCalls = 0;
    const logs: string[] = [];
    const run = createMemoryExtractor({
      store: {
        list: async () => [],
        bumpCorrection: async () => {},
        formMemory: async () => ({
          id: "m",
          duplicate: false,
          forgotten: false,
        }),
      },
      modelFor: async () => model,
      call: async () => {
        modelCalls += 1;
        return { text: JSON.stringify({ memories: [] }) };
      },
      limiter: createDailyLimiter({ limit: () => limit }),
      log: (line) => logs.push(line),
    });
    return { run, calls: () => modelCalls, logs };
  }

  test("past the limit it skips quietly: no model call, no error, nothing logged", async () => {
    const { run, calls, logs } = extractor(2);
    for (let index = 0; index < 5; index += 1)
      expect(await run(turn("bot"))).toEqual({ saved: 0 });
    expect(calls()).toBe(2);
    expect(logs).toEqual([]);
  });

  test("per employee, and only a turn that reached the model counts", async () => {
    const { run, calls } = extractor(1);
    await run({
      ...turn("bot"),
      messages: [{ role: "user", content: "你好" }],
    });
    await run({ ...turn("bot"), failed: true });
    expect(calls()).toBe(0);
    await run(turn("bot"));
    await run(turn("second-bot"));
    await run(turn("bot"));
    expect(calls()).toBe(2);
  });

  test("the default is 40 and the environment variable is read", async () => {
    const before = process.env.XIONGBAO_MEMORY_EXTRACT_PER_DAY;
    process.env.XIONGBAO_MEMORY_EXTRACT_PER_DAY = "2";
    try {
      let calls = 0;
      const run = createMemoryExtractor({
        store: {
          list: async () => [],
          bumpCorrection: async () => {},
          formMemory: async () => ({
            id: "m",
            duplicate: false,
            forgotten: false,
          }),
        },
        modelFor: async () => model,
        call: async () => {
          calls += 1;
          return { text: '{"memories":[]}' };
        },
      });
      for (let index = 0; index < 4; index += 1) await run(turn("env-bot"));
      expect(calls).toBe(2);
    } finally {
      if (before === undefined)
        delete process.env.XIONGBAO_MEMORY_EXTRACT_PER_DAY;
      else process.env.XIONGBAO_MEMORY_EXTRACT_PER_DAY = before;
    }
    expect(dailyLimitOf("XIONGBAO_MEMORY_EXTRACT_PER_DAY", 40, {})).toBe(40);
  });
});

describe("the retrospective: XIONGBAO_RETRO_PER_DAY", () => {
  const steps = traceStepsOf(
    Array.from({ length: 16 }, (_, index) => [
      {
        type: "TOOL_CALL_START",
        toolCallId: `c${index}`,
        toolCallName: "computer_run_command",
      },
      {
        type: "TOOL_CALL_RESULT",
        toolCallId: `c${index}`,
        content: '{"ok":true}',
      },
    ]).flat() as never,
  );
  const turn = (agentId: string): RetroTurn => ({
    ownerUserId: "u1",
    agentId,
    threadId: "t",
    runId: "r",
    request: "整理",
    reply: "好了",
    steps,
    failed: false,
    trigger: "steps",
  });

  test("past the limit it skips quietly: no model call, no error, nothing logged; the cooldown is not what stops it", async () => {
    let calls = 0;
    const logs: string[] = [];
    const run = createRetrospector({
      database: {} as never,
      selfSkill: () => ({}) as never,
      modelFor: async () => model,
      call: async () => {
        calls += 1;
        return { text: '{"skill":null}' };
      },
      cooldownMs: 0,
      limiter: createDailyLimiter({ limit: () => 2 }),
      log: (line) => logs.push(line),
    });
    const outcomes = [];
    for (let index = 0; index < 4; index += 1)
      outcomes.push(await run(turn("bot")));
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "nothing",
      "nothing",
      "skipped",
      "skipped",
    ]);
    expect(calls).toBe(2);
    expect(logs).toEqual([]);
    // Another employee has its own count.
    expect((await run(turn("second-bot"))).outcome).toBe("nothing");
  });

  test("the default is 6", () => {
    expect(dailyLimitOf("XIONGBAO_RETRO_PER_DAY", 6, {})).toBe(6);
  });
});
