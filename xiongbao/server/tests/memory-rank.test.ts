import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { lastValueFrom, type Observable, of, toArray } from "rxjs";
import { quoteMemoryContext } from "../src/memory/ingestion";
import {
  DEFAULT_MEMORY_INJECT_CHARS,
  memoryInjectBudget,
  rankMemories,
} from "../src/memory/rank";
import { createMemoryRuntime } from "../src/memory/runtime";
import { PersonalMemoryMiddleware } from "../src/memory/tools";

/*
 * 期 1·1.2：记忆按和这条消息的相关程度注入，设字符预算；放不下的靠 recall_personal_memory 按需取。
 * 先用词重叠相似度排序（向量召回是期 2 的事）。
 */

const memory = (id: string, content: string, provenance = "You") => ({
  id,
  content,
  provenance,
  sourceId: null,
});

describe("rankMemories", () => {
  const pool = [
    memory("m1", "Prefers the morning standup at 9:30"),
    memory("m2", "Allergic to peanuts, orders the fish at restaurants"),
    memory("m3", "Quarterly budget review happens every March"),
    memory("m4", "The staging database password rotates monthly"),
  ];

  test("the memory that shares words with the message comes first", () => {
    expect(rankMemories("when is the budget review?", pool, 4000)[0]?.id).toBe(
      "m3",
    );
    expect(
      rankMemories("book a table at a restaurant", pool, 4000)[0]?.id,
    ).toBe("m2");
  });

  test("Chinese is matched by character pairs, not by whole words", () => {
    const zh = [
      memory("a", "用户每周三下午开项目周会"),
      memory("b", "用户喜欢喝美式咖啡，不加糖"),
      memory("c", "报销单要发给财务部的小李"),
    ];
    expect(rankMemories("帮我订杯咖啡", zh, 4000)[0]?.id).toBe("b");
    expect(rankMemories("这个月的报销怎么提交", zh, 4000)[0]?.id).toBe("c");
  });

  test("with nothing to match, the given order (newest first) is kept", () => {
    expect(rankMemories("", pool, 4000).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(rankMemories("zzzz qqqq", pool, 4000).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  test("stops at the character budget and keeps the more relevant ones", () => {
    const big = Array.from({ length: 30 }, (_, i) =>
      memory(`n${i}`, `filler note ${i} ${"lorem ipsum ".repeat(40)}`),
    );
    big.push(memory("hit", `the invoice for Acme is due ${"x".repeat(300)}`));
    const picked = rankMemories("when is the Acme invoice due", big, 2000);
    expect(picked[0]?.id).toBe("hit");
    const cost = picked.reduce(
      (sum, m) => sum + m.content.length + m.provenance.length + 100,
      0,
    );
    expect(cost).toBeLessThanOrEqual(2000);
    expect(picked.length).toBeLessThan(big.length);
  });

  test("a top memory longer than the whole budget is still offered (it is cut when quoted)", () => {
    const picked = rankMemories(
      "acme contract",
      [
        memory("long", `acme contract ${"y".repeat(9000)}`),
        memory("s", "other"),
      ],
      1000,
    );
    expect(picked.map((m) => m.id)).toEqual(["long"]);
  });

  test("a later memory that does not fit whole is skipped, a smaller one after it is taken", () => {
    const picked = rankMemories(
      "alpha beta",
      [
        memory("first", `alpha beta ${"p".repeat(500)}`),
        memory("too-big", `alpha ${"q".repeat(900)}`),
        memory("small", "beta"),
      ],
      900,
    );
    expect(picked.map((m) => m.id)).toEqual(["first", "small"]);
  });

  test("does not change the list it is given", () => {
    const before = pool.map((m) => m.id);
    rankMemories("budget", pool, 4000);
    expect(pool.map((m) => m.id)).toEqual(before);
  });
});

describe("memoryInjectBudget", () => {
  test("defaults to 4000 characters; XIONGBAO_MEMORY_INJECT_CHARS overrides; junk falls back", () => {
    expect(DEFAULT_MEMORY_INJECT_CHARS).toBe(4000);
    expect(memoryInjectBudget({})).toBe(4000);
    expect(memoryInjectBudget({ XIONGBAO_MEMORY_INJECT_CHARS: "8000" })).toBe(
      8000,
    );
    expect(memoryInjectBudget({ XIONGBAO_MEMORY_INJECT_CHARS: "abc" })).toBe(
      4000,
    );
    expect(memoryInjectBudget({ XIONGBAO_MEMORY_INJECT_CHARS: "10" })).toBe(
      4000,
    );
  });
});

describe("quoteMemoryContext with a message", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    memory(`k${i}`, `unrelated fact number ${i}. ${"filler ".repeat(60)}`),
  );
  many.push(memory("want", "The Orion launch is on the 14th, owner is Dana"));

  test("injects the memory the message is about, within the budget, and says how to get the rest", () => {
    const context = quoteMemoryContext(many, {
      query: "who owns the Orion launch?",
      budgetChars: 2000,
    });
    expect(context).toContain("Orion launch");
    expect(context.length).toBeLessThan(2000 + 600);
    expect(context).toContain("recall_personal_memory");
    expect(context).toMatch(/\d+ more memor/);
  });

  test("by default the whole block is held to 4000 characters, not 24000", () => {
    const context = quoteMemoryContext(many, { query: "Orion" });
    expect(context.length).toBeLessThan(DEFAULT_MEMORY_INJECT_CHARS + 600);
    expect(context).toContain("Orion launch");
  });

  test("everything fits: nothing is left out and no hint is added", () => {
    const context = quoteMemoryContext(
      [memory("a", "one"), memory("b", "two")],
      { query: "one" },
    );
    expect(context).toContain('"content":"one"');
    expect(context).toContain('"content":"two"');
    expect(context).not.toContain("recall_personal_memory");
  });

  test("an empty list is still an empty string", () => {
    expect(quoteMemoryContext([], { query: "x" })).toBe("");
  });
});

class Spy extends AbstractAgent {
  readonly requests: RunAgentInput[] = [];
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.requests.push(input);
    return of(
      {
        type: EventType.RUN_STARTED,
        runId: input.runId,
        threadId: input.threadId,
      },
      {
        type: EventType.RUN_FINISHED,
        runId: input.runId,
        threadId: input.threadId,
      },
    );
  }
}

describe("the middleware asks for memory by the latest user message", () => {
  const request = (messages: RunAgentInput["messages"]): RunAgentInput => ({
    runId: "run",
    threadId: "thread",
    messages,
    context: [],
    tools: [],
    state: {},
    forwardedProps: {},
  });
  const threads: (string | undefined)[] = [];
  const ask = async (messages: RunAgentInput["messages"]) => {
    const seen: (string | undefined)[] = [];
    await lastValueFrom(
      new PersonalMemoryMiddleware("bot", async (_bot, query, threadId) => {
        seen.push(query);
        threads.push(threadId);
        return "";
      })
        .run(request(messages), new Spy({ agentId: "bot" }))
        .pipe(toArray()),
    );
    return seen[0];
  };

  test("the thread goes along, so an unchanged topic can keep its block", async () => {
    await ask([{ id: "1", role: "user", content: "hi" }]);
    expect(threads).toEqual(["thread"]);
  });

  test("a string message", async () => {
    expect(
      await ask([
        { id: "1", role: "user", content: "old question" },
        { id: "2", role: "assistant", content: "an answer" },
        { id: "3", role: "user", content: "who owns Orion?" },
      ]),
    ).toBe("who owns Orion?");
  });

  test("a message made of parts: only the text parts", async () => {
    expect(
      await ask([
        // The part list is spelled loosely: this test is about which parts are read, not their wire shape.
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "binary", mimeType: "image/png", data: "AAAA" },
            { type: "text", text: "and tell me" },
          ],
        } as unknown as RunAgentInput["messages"][number],
      ]),
    ).toBe("see this\nand tell me");
  });

  test("a very long message is cut", async () => {
    const query = await ask([
      { id: "1", role: "user", content: "w".repeat(5000) },
    ]);
    expect(query?.length).toBeLessThanOrEqual(500);
  });

  test("no user message: no query, memory still loads", async () => {
    expect(await ask([{ id: "1", role: "system", content: "x" }])).toBe("");
  });
});

test("the runtime hands the message through to the memory context", async () => {
  const asked: (string | undefined)[] = [];
  const runtime = createMemoryRuntime({
    edition: "team",
    defaults: { botTurn: () => {} },
    ingestion: {
      contextFor: async (
        _owner: string,
        _bot: string,
        query?: string,
        threadId?: string,
      ) => {
        asked.push(`${query}@${threadId}`);
        return "ctx";
      },
      syncDue: async () => {},
    },
  } as unknown as Parameters<typeof createMemoryRuntime>[0]);
  expect(
    await runtime.loadForActor?.("u1")("bot", "who owns Orion?", "t-1"),
  ).toBe("ctx");
  expect(asked).toEqual(["who owns Orion?@t-1"]);
});
