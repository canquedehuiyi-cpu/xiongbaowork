import { describe, expect, test } from "bun:test";
import {
  cosine,
  embedText,
  embeddingConfigOf,
  embedTexts,
} from "../src/memory/embed";
import { rankMemories } from "../src/memory/rank";
import { createMemoryVectors, MAX_NEW_PER_CALL } from "../src/memory/vectors";
import type {
  EmbeddingStore,
  StoredEmbedding,
} from "../src/memory/embeddings-store";

const config = {
  baseUrl: "https://embed.example.test/v1",
  apiKey: "k",
  model: "m1",
};

function service(
  vectorOf: (text: string) => number[],
  calls: { inputs: string[][] } = { inputs: [] },
) {
  return {
    calls,
    fetchImpl: async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)).input as string[];
      calls.inputs.push(input);
      // Answered out of order on purpose: the order is the `index`, not the position.
      const data = input
        .map((text, index) => ({ index, embedding: vectorOf(text) }))
        .reverse();
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  };
}

describe("the embedding service", () => {
  test("configured only when base URL, key and model are all set", () => {
    expect(embeddingConfigOf({})).toBeUndefined();
    expect(
      embeddingConfigOf({
        XIONGBAO_EMBEDDING_BASE_URL: "https://x.example/v1/",
        XIONGBAO_EMBEDDING_API_KEY: "k",
      }),
    ).toBeUndefined();
    expect(
      embeddingConfigOf({
        XIONGBAO_EMBEDDING_BASE_URL: "https://x.example/v1/",
        XIONGBAO_EMBEDDING_API_KEY: "k",
        XIONGBAO_EMBEDDING_MODEL: "m",
      }),
    ).toEqual({ baseUrl: "https://x.example/v1", apiKey: "k", model: "m" });
  });

  test("a batch comes back in the order asked, whatever order the service answered in", async () => {
    const { fetchImpl } = service((text) => [text.length, 1]);
    expect(await embedTexts(["a", "bbb"], { config, fetchImpl })).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(await embedText("cc", { config, fetchImpl })).toEqual([2, 1]);
  });

  test("not configured, a failing service, or an answer that does not read as vectors is null, never a throw", async () => {
    const logs: string[] = [];
    expect(await embedText("x", { config: undefined })).toBeNull();
    const down = async () => new Response("no", { status: 503 });
    expect(
      await embedText("x", {
        config,
        fetchImpl: down,
        log: (l) => logs.push(l),
      }),
    ).toBeNull();
    const garbled = async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: ["a"] }] }));
    expect(await embedText("x", { config, fetchImpl: garbled })).toBeNull();
    const wrongCount = async () => new Response(JSON.stringify({ data: [] }));
    expect(await embedText("x", { config, fetchImpl: wrongCount })).toBeNull();
    const mixed = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 2] },
            { index: 1, embedding: [1] },
          ],
        }),
      );
    expect(
      await embedTexts(["a", "b"], { config, fetchImpl: mixed }),
    ).toBeNull();
    expect(await embedText("   ", { config })).toBeNull();
    // Said once, as a type, and without the text that was sent.
    expect(logs.length).toBeLessThanOrEqual(1);
    expect(logs.join("")).not.toContain('x"');
  });

  test("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([1, 0], [1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("ranking with vectors", () => {
  const memories = [
    {
      id: "a",
      content: "Prefers short weekly status emails",
      provenance: "You",
    },
    { id: "b", content: "Lives in Lisbon", provenance: "You" },
    { id: "c", content: "Manager is Dana", provenance: "You" },
  ];

  test("by meaning when the vectors are all there, even with no word in common", () => {
    const vectors = {
      query: [0, 1],
      byId: new Map([
        ["a", [1, 0]],
        ["b", [0.2, 0.9]],
        ["c", [0, 1]],
      ]),
    };
    const ranked = rankMemories(
      "who do I report to",
      memories,
      10_000,
      vectors,
    );
    expect(ranked.map((m) => m.id)).toEqual(["c", "b", "a"]);
  });

  test("without vectors, or with one memory short of one, it is the word ranking it always was", () => {
    const query = "weekly status emails";
    const lexical = rankMemories(query, memories, 10_000);
    expect(lexical[0]?.id).toBe("a");
    expect(rankMemories(query, memories, 10_000, null)).toEqual(lexical);
    const incomplete = {
      query: [0, 1],
      byId: new Map([
        ["b", [0, 1]],
        ["c", [0, 1]],
      ]),
    };
    expect(rankMemories(query, memories, 10_000, incomplete)).toEqual(lexical);
    const wrongLength = {
      query: [0, 1, 0],
      byId: new Map(memories.map((m) => [m.id, [1, 0]])),
    };
    expect(rankMemories(query, memories, 10_000, wrongLength)).toEqual(lexical);
  });

  test("the budget holds the same way", () => {
    const vectors = {
      query: [0, 1],
      byId: new Map([
        ["a", [1, 0]],
        ["b", [0, 1]],
        ["c", [0, 1]],
      ]),
    };
    const one = rankMemories("x", memories, 160, vectors);
    expect(one).toHaveLength(1);
  });
});

function memoryStore() {
  const rows = new Map<string, StoredEmbedding>();
  const store: EmbeddingStore = {
    load: async (ids) => new Map([...rows].filter(([id]) => ids.includes(id))),
    save: async (batch) => {
      for (const row of batch)
        rows.set(row.memoryId, {
          vector: [...row.vector],
          model: row.model,
          digest: row.digest,
        });
    },
  };
  return { rows, store };
}

describe("the vectors of one pick", () => {
  const memories = [
    { id: "m1", content: "alpha", formedBy: "person" },
    { id: "m2", content: "beta", formedBy: "person" },
  ];
  const vectorOf = (text: string) => [text.length, 1];

  test("a memory is embedded once and kept: the next pick asks only for the message", async () => {
    const { rows, store } = memoryStore();
    const { fetchImpl, calls } = service(vectorOf);
    const vectors = createMemoryVectors({
      store,
      config: () => config,
      embed: { fetchImpl },
    });
    const first = await vectors.vectorsFor(memories, "hello");
    expect(first?.query).toEqual([5, 1]);
    expect([...rows.keys()].sort()).toEqual(["m1", "m2"]);
    expect(calls.inputs).toEqual([["hello", "alpha", "beta"]]);
    await vectors.vectorsFor(memories, "again");
    expect(calls.inputs[1]).toEqual(["again"]);
  });

  test("a memory whose text changed, or one embedded by another model, is embedded again", async () => {
    const { store } = memoryStore();
    const { fetchImpl, calls } = service(vectorOf);
    const make = (model: string) =>
      createMemoryVectors({
        store,
        config: () => ({ ...config, model }),
        embed: { fetchImpl },
      });
    await make("m1").vectorsFor(memories, "q");
    calls.inputs.length = 0;
    await make("m1").vectorsFor(
      [{ id: "m1", content: "alpha edited", formedBy: "person" }, memories[1]!],
      "q",
    );
    expect(calls.inputs).toEqual([["q", "alpha edited"]]);
    calls.inputs.length = 0;
    await make("m2").vectorsFor(memories, "q");
    expect(calls.inputs).toEqual([["q", "alpha", "beta"]]);
  });

  test("a memory only the back end holds is embedded for this pick and not stored", async () => {
    const { rows, store } = memoryStore();
    const { fetchImpl } = service(vectorOf);
    const vectors = createMemoryVectors({
      store,
      config: () => config,
      embed: { fetchImpl },
    });
    const picked = await vectors.vectorsFor(
      [{ id: "remote-1", content: "only remote", formedBy: "intelligence" }],
      "q",
    );
    expect(picked?.byId.get("remote-1")).toEqual([11, 1]);
    expect(rows.size).toBe(0);
  });

  test("no service, a failing service, or no message: null, so the caller ranks by words", async () => {
    const { store } = memoryStore();
    const none = createMemoryVectors({ store, config: () => undefined });
    expect(await none.vectorsFor(memories, "q")).toBeNull();
    const down = createMemoryVectors({
      store,
      config: () => config,
      embed: {
        fetchImpl: async () => new Response("x", { status: 500 }),
        log: () => {},
      },
    });
    expect(await down.vectorsFor(memories, "q")).toBeNull();
    const { fetchImpl } = service(vectorOf);
    const ok = createMemoryVectors({
      store,
      config: () => config,
      embed: { fetchImpl },
    });
    expect(await ok.vectorsFor(memories, "  ")).toBeNull();
    expect(await ok.vectorsFor([], "q")).toBeNull();
  });

  test("a first pick over a great many memories warms up a batch at a time, and ranks by words until it is whole", async () => {
    const many = Array.from({ length: MAX_NEW_PER_CALL * 2 + 5 }, (_, i) => ({
      id: `n${i}`,
      content: `note ${i}`,
      formedBy: "person",
    }));
    const { rows, store } = memoryStore();
    const { fetchImpl, calls } = service(vectorOf);
    const vectors = createMemoryVectors({
      store,
      config: () => config,
      embed: { fetchImpl },
    });
    expect(await vectors.vectorsFor(many, "q")).toBeNull();
    expect(rows.size).toBe(MAX_NEW_PER_CALL);
    expect(calls.inputs[0]).toHaveLength(MAX_NEW_PER_CALL + 1);
    expect(await vectors.vectorsFor(many, "q")).toBeNull();
    expect(rows.size).toBe(MAX_NEW_PER_CALL * 2);
    const whole = await vectors.vectorsFor(many, "q");
    expect(whole?.byId.size).toBe(many.length);
  });
});
