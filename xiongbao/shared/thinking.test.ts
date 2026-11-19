import { describe, expect, test } from "bun:test";
import { THINKING_DEFAULT, thinkingOf } from "./thinking";

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
