import { describe, expect, test } from "bun:test";
import {
  joinReasoning,
  REASONING_TEXT_LIMIT,
  readStoredReasoning,
  THINKING_DEFAULT,
  thinkingOf,
} from "./thinking";

describe("thinkingOf", () => {
  test("on unless the configuration says false", () => {
    expect(THINKING_DEFAULT).toBe(true);
    for (const configuration of [
      undefined,
      null,
      "x",
      {},
      { systemPrompt: "p" },
      { thinking: true },
      { thinking: "false" },
    ])
      expect(thinkingOf(configuration)).toBe(true);
    expect(thinkingOf({ systemPrompt: "p", thinking: false })).toBe(false);
  });
});

describe("joinReasoning", () => {
  test("joins a turn's pieces, adds up their time only when every piece was timed", () => {
    expect(joinReasoning([])).toBeNull();
    expect(joinReasoning([{ text: "  " }])).toBeNull();
    expect(
      joinReasoning([
        { text: "先查甲家。", ms: 4_000 },
        { text: "再查乙家。", ms: 8_000 },
      ]),
    ).toEqual({ text: "先查甲家。\n\n再查乙家。", ms: 12_000 });
    expect(
      joinReasoning([
        { text: "先查甲家。", ms: 4_000 },
        { text: "再查乙家。" },
      ]),
    ).toEqual({ text: "先查甲家。\n\n再查乙家。" });
  });

  test("cuts a long thought at the limit and says it was cut", () => {
    const long = "想".repeat(REASONING_TEXT_LIMIT + 10);
    const joined = joinReasoning([{ text: long, ms: 1_000 }]);
    expect([...(joined?.text ?? "")]).toHaveLength(REASONING_TEXT_LIMIT);
    expect(joined?.truncated).toBe(true);
    expect(joined?.ms).toBe(1_000);
  });
});

describe("readStoredReasoning", () => {
  test("reads what a reply row keeps, and nothing that is not it", () => {
    expect(readStoredReasoning({ text: "想", ms: 3_000 })).toEqual({
      text: "想",
      ms: 3_000,
    });
    expect(
      readStoredReasoning({ text: "想", ms: -1, truncated: true }),
    ).toEqual({ text: "想", truncated: true });
    for (const value of [null, "想", {}, { text: "" }, { text: 3 }])
      expect(readStoredReasoning(value)).toBeNull();
  });
});
