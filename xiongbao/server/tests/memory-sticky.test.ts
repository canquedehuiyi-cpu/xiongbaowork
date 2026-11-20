import { describe, expect, test } from "bun:test";
import { createMemoryIngestion } from "../src/memory/ingestion";
import type { MemoryStore } from "../src/memory/store";
import type { PluginStore } from "../src/plugins/store";
import { hasSubstantiveWords } from "../src/text-tokens";

/*
 * 期 1·1.2 补：记忆注入要「粘住」。注入块是放在对话最前面的系统消息，它每轮都变，整段历史的前缀缓存就整段失效。
 * 所以同一线程里，新消息和上次挑选时的那条消息主题相同、或者根本没有实词（「好的」「继续」），就原样复用上次的
 * 注入块，逐字节不变；只有话题明显变了，或者记忆本身增删改了，才重挑。
 */

type Fact = {
  id: string;
  content: string;
  provenance: string;
  sourceId: string | null;
};

let counter = 0;
const fact = (content: string): Fact => {
  counter += 1;
  return { id: `m${counter}`, content, provenance: "You", sourceId: null };
};

/** Enough memories that the 4000-character budget forces a choice. Newest first. */
function pool(): Fact[] {
  const filler = Array.from({ length: 24 }, (_, index) =>
    fact(
      `Unrelated note ${index}: the cafeteria menu rotates weekly, the printer on floor ${index} is slow. ${"padding words ".repeat(12)}`,
    ),
  );
  return [
    ...filler.slice(0, 12),
    fact("The Orion launch is on the 14th and its owner is Dana"),
    ...filler.slice(12),
    fact(
      "Allergic to peanuts, so book a table at a restaurant with a fish menu",
    ),
  ];
}

/** One fixed set of memories, as the store would return the same rows turn after turn. */
const stable = () => {
  const fixed = pool();
  return () => fixed;
};

function ingestionOver(
  memories: () => Fact[],
  env: Record<string, string | undefined> = {},
  stickyMaxThreads?: number,
) {
  let reads = 0;
  const store = {
    sources: async () => [],
    retrieve: async () => {
      reads += 1;
      return memories();
    },
  } as unknown as MemoryStore;
  const plugins = {
    listForAgent: async () => ({ tools: [] }),
    agentOwner: async () => "owner",
  } as unknown as PluginStore;
  const ingestion = createMemoryIngestion({
    store,
    plugins,
    env,
    ...(stickyMaxThreads === undefined ? {} : { stickyMaxThreads }),
  });
  return {
    reads: () => reads,
    ask: (query: string, threadId: string | null = "thread-1") =>
      ingestion.contextFor("owner", "bot", query, threadId ?? undefined),
  };
}

describe("a thread's memory block stays byte-identical while the topic holds", () => {
  test("three messages on one topic and then short follow-ups: one block", async () => {
    const { ask, reads } = ingestionOver(stable());
    const first = await ask("who owns the Orion launch?");
    expect(first).toContain("Orion launch is on the 14th");
    const same = [
      "when is the Orion launch again",
      "Orion launch owner Dana?",
      "继续",
      "ok go on",
      "好的，继续",
      "Continue please",
    ];
    for (const message of same) expect(await ask(message)).toBe(first);
    // Memory is still read every turn: that is how a change is noticed.
    expect(reads()).toBe(same.length + 1);
  });

  test("the topic changing picks again, and the new block sticks in turn", async () => {
    const { ask } = ingestionOver(stable());
    const orion = await ask("who owns the Orion launch?");
    const restaurant = await ask("book a table at a restaurant for friday");
    expect(restaurant).not.toBe(orion);
    expect(restaurant).toContain("Allergic to peanuts");
    expect(await ask("好的，继续")).toBe(restaurant);
    expect(await ask("any restaurant table with a fish menu on friday")).toBe(
      restaurant,
    );
  });

  test("a memory edited, added or removed picks again, even on the same topic", async () => {
    let memories = pool();
    const { ask } = ingestionOver(() => memories);
    const before = await ask("who owns the Orion launch?");
    expect(await ask("继续")).toBe(before);

    memories = memories.map((memory) =>
      memory.content.includes("Orion")
        ? {
            ...memory,
            content: "The Orion launch moved to the 21st, owner is Dana",
          }
        : memory,
    );
    const edited = await ask("继续");
    expect(edited).not.toBe(before);
    expect(edited).toContain("moved to the 21st");

    memories = [fact("Orion launch budget is 40k"), ...memories];
    const added = await ask("Orion launch owner");
    expect(added).toContain("budget is 40k");

    memories = memories.filter((memory) => !memory.content.includes("budget"));
    const removed = await ask("继续");
    expect(removed).not.toContain("budget is 40k");
    expect(removed).not.toBe(added);
  });

  test("a thread that began with a message with no words picks properly once there is something to pick by", async () => {
    const { ask } = ingestionOver(stable());
    const blank = await ask("好的");
    const real = await ask("who owns the Orion launch?");
    expect(real).toContain("Orion launch is on the 14th");
    expect(real).not.toBe(blank);
    expect(await ask("继续")).toBe(real);
  });

  test("threads do not share a choice", async () => {
    const { ask } = ingestionOver(stable());
    const orion = await ask("who owns the Orion launch?", "a");
    const restaurant = await ask("book a table at a restaurant", "b");
    expect(restaurant).not.toBe(orion);
    expect(await ask("继续", "a")).toBe(orion);
    expect(await ask("继续", "b")).toBe(restaurant);
  });

  test("with no thread there is nothing to stick to: each message picks for itself", async () => {
    const { ask } = ingestionOver(stable());
    const orion = await ask("who owns the Orion launch?", null);
    const follow = await ask("继续", null);
    expect(follow).not.toBe(orion);
  });

  test("XIONGBAO_MEMORY_STICKY=off picks for every message", async () => {
    const { ask } = ingestionOver(stable(), { XIONGBAO_MEMORY_STICKY: "off" });
    const orion = await ask("who owns the Orion launch?");
    expect(await ask("继续")).not.toBe(orion);
  });

  test("a thread's cache is bounded", async () => {
    const { ask } = ingestionOver(stable(), {}, 2);
    const orion = await ask("who owns the Orion launch?", "a");
    await ask("who owns the Orion launch?", "b");
    await ask("who owns the Orion launch?", "c");
    // "a" was dropped, so a follow-up there picks afresh (by recency, no words) instead of reusing.
    expect(await ask("继续", "a")).not.toBe(orion);
    expect(await ask("继续", "c")).toContain("Orion launch is on the 14th");
  });
});

describe("hasSubstantiveWords", () => {
  test("acknowledgements, go-aheads and thanks have none", () => {
    for (const text of [
      "",
      "  ",
      "好的",
      "继续",
      "好的，继续",
      "嗯",
      "接着做吧",
      "谢谢",
      "ok",
      "OK, go on",
      "Continue please",
      "yes, thanks!",
      "go ahead",
      "👍",
    ])
      expect(hasSubstantiveWords(text)).toBe(false);
  });

  test("anything that names a thing does", () => {
    for (const text of [
      "订咖啡",
      "继续汇总第三季度的表格",
      "who owns the Orion launch?",
      "ok book a table",
      "Dana",
    ])
      expect(hasSubstantiveWords(text)).toBe(true);
  });
});
