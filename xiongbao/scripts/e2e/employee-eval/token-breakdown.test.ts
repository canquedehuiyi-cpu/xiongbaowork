import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  breakdownRequest,
  type ChatRequest,
  estimateTokens,
  FIRST_RUN,
  projectTask,
  renderBreakdown,
  systemSections,
} from "./token-breakdown";

test("tokens are estimated at 0.3 per Latin character and 0.6 per Chinese one", () => {
  expect(estimateTokens("abcdefghij")).toBe(3);
  expect(estimateTokens("先想清楚再做")).toBe(4);
  expect(estimateTokens("")).toBe(0);
});

test("the system prompt is split by its tagged sections, text outside them kept apart", () => {
  const parts = systemSections(
    "<plan>\n列计划\n</plan>\n\n<delivery>\nx\n</delivery>\n\n<delivery>\ny\n</delivery>\n## 应用附上的资料",
  );
  expect(parts.map((part) => part.name)).toEqual([
    "plan",
    "delivery",
    "delivery",
    "(段外)",
  ]);
});

test("a request is split into system, tools and each kind of history", () => {
  const body: ChatRequest = {
    messages: [
      { role: "system", content: "<identity>\nI am\n</identity>" },
      { role: "user", content: "做题" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "想一想",
        tool_calls: [{ function: { name: "run", arguments: '{"a":1}' } }],
      },
      { role: "tool", content: "x".repeat(100) },
    ],
    tools: [{ function: { name: "run", description: "d", parameters: {} } }],
  };
  const b = breakdownRequest(body);
  expect(b.system).toEqual([{ name: "identity", tokens: 8 }]);
  expect(b.tools).toHaveLength(1);
  expect(b.history).toEqual({
    user: 1,
    assistantText: 0,
    toolCallArgs: 3,
    reasoning: 2,
    toolResults: 30,
  });
});

test("the committed sample is a real employee request, and the projection adds up", () => {
  const sample = JSON.parse(
    readFileSync(
      join(import.meta.dir, "samples", "step1-request.json"),
      "utf8",
    ),
  ) as ChatRequest;
  const b = breakdownRequest(sample);
  expect(b.system.map((part) => part.name)).toContain("how_to_work");
  expect(b.tools.map((tool) => tool.name)).toContain("update_plan");
  const research = FIRST_RUN[0];
  const p = projectTask(research, 10_000, 500);
  expect(p.fixed + p.output + p.history).toBe(research.total);
  expect(p.growthPerStep).toBe(Math.round(p.history / ((26 * 25) / 2)));
  expect(renderBreakdown([sample])).toContain("## 系统提示各段");
});
