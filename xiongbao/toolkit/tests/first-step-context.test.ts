import { describe, expect, test } from "bun:test";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  isFirstStepOfTurn,
  type Prompt,
  withFirstStepContext,
} from "../src/copilotkit/last-step";

/*
 * 只在本轮第一步给的上下文：加在第一次调用的提示末尾，之后的调用原样；前面的内容（系统提示、历史、人的话）
 * 不动，所以前缀每一步相同。
 */

const SKILL_BODY = "### 会议纪要 (id: auto-1)\n快路径：python3 run.py";

const user = { role: "user", content: [{ type: "text", text: "整理纪要" }] };
const step = (n: number) => [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: `c${n}`,
        toolName: "t",
        input: "{}",
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `c${n}`,
        toolName: "t",
        output: { type: "text", value: "ok" },
      },
    ],
  },
];
const prompt = (steps: number) =>
  [
    { role: "system", content: "你是员工。" },
    { role: "user", content: [{ type: "text", text: "早先的话" }] },
    { role: "assistant", content: [{ type: "text", text: "好的" }] },
    user,
    ...Array.from({ length: steps }, (_, index) => step(index + 1)).flat(),
  ] as unknown as Prompt;

function wrapped(seen: Prompt[], text: string | undefined) {
  const model = {
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
  const out = withFirstStepContext(
    { model: model as never, prompt: "x" } as BuiltInAgentConfiguration,
    text,
  );
  if ("factory" in out) throw new Error("not a factory");
  return out.model as unknown as {
    doStream: (options: { prompt: Prompt }) => Promise<unknown>;
  };
}

describe("isFirstStepOfTurn", () => {
  test("人的话之后还没有模型的回答才是第一步", () => {
    expect(isFirstStepOfTurn(prompt(0))).toBe(true);
    expect(isFirstStepOfTurn(prompt(1))).toBe(false);
    expect(isFirstStepOfTurn(prompt(3))).toBe(false);
    expect(isFirstStepOfTurn([] as unknown as Prompt)).toBe(false);
  });
});

describe("withFirstStepContext", () => {
  test("第一步：提示末尾多一条带技能正文的消息，前面逐项不变；第二步起原样", async () => {
    const seen: Prompt[] = [];
    const model = wrapped(seen, SKILL_BODY);
    const first = prompt(0);
    await model.doStream({ prompt: first });
    await model.doStream({ prompt: prompt(1) });
    await model.doStream({ prompt: prompt(2) });
    const [one, two, three] = seen as [Prompt, Prompt, Prompt];
    expect(JSON.stringify(one)).toContain("快路径：python3 run.py");
    expect(one.length).toBe(first.length + 1);
    expect(JSON.stringify(one.slice(0, first.length))).toBe(
      JSON.stringify(first),
    );
    expect(JSON.stringify(two)).not.toContain("快路径");
    expect(JSON.stringify(three)).not.toContain("快路径");
    // 第二步的提示是第一步（去掉末尾那条）加上新的一步：前缀相同。
    expect(JSON.stringify(two.slice(0, first.length))).toBe(
      JSON.stringify(first),
    );
  });

  test("没有要给的就不包", () => {
    const configuration = {
      model: {} as never,
      prompt: "x",
    } as BuiltInAgentConfiguration;
    expect(withFirstStepContext(configuration, undefined)).toBe(configuration);
    expect(withFirstStepContext(configuration, "")).toBe(configuration);
  });
});
