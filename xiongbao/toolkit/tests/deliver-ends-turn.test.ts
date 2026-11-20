import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import { answersOnLastStep } from "../src/copilotkit/last-step";
import { parametersFor } from "../src/granted-tool";

/*
 * 交付即收尾：看板卡的员工调用 `deliver_task` 被接受之后，这一轮就结束，不再为一句收尾的话多调一次模型。
 * 交付内容已经在工具参数里；那一步多出来的调用只是把整段历史再发一遍。
 *
 * 但收尾提醒的语义不变：计划里还有没做的项、改完没有校验，这两样在交付之后仍然要提醒一次，所以只有
 * 「没有提醒要发」的时候才直接收尾；被挡回的交付、交付之后又去做了别的事，都照旧让模型再走一步。
 */

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type Message = { role: string; content: unknown };

/** 「交付被接受」的判断，由宿主给（服务器认自己的 `deliver_task` 结果）；这里用同样形状的一个。 */
const endsAfter = (name: string, result: string) =>
  name === "deliver_task" && result.includes('"delivered":true');

/** 只会说一句收尾的话的模型；每次被问到都记下提示。 */
function closingModel(asked: Message[][], spec: "v2" | "v3" = "v3") {
  const finish =
    spec === "v3"
      ? {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage,
        }
      : {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
  return {
    specificationVersion: spec,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async (options: { prompt: Message[] }) => {
      asked.push(options.prompt);
      return {
        content: [{ type: "text", text: "交付好了。" }],
        finishReason: spec === "v3" ? { unified: "stop", raw: "stop" } : "stop",
        usage:
          spec === "v3"
            ? usage
            : { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    doStream: async (options: { prompt: Message[] }) => {
      asked.push(options.prompt);
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "交付好了。" },
        { type: "text-end", id: "text" },
        finish,
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

const call = (id: string, toolName: string, input: unknown): Message => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const result = (id: string, toolName: string, value = "ok"): Message => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName,
      output: { type: "text", value },
    },
  ],
});
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const DELIVERED = JSON.stringify({ delivered: true, taskId: "t1" });
const BOUNCED = JSON.stringify({ bounced: true, reason: "缺必需项" });

type Run = Parameters<typeof answersOnLastStep>[2];

function wrapped(asked: Message[][], run: Run, spec: "v2" | "v3" = "v3") {
  const configuration = answersOnLastStep(
    {
      model: closingModel(asked, spec) as never,
      prompt: "Work.",
      maxSteps: 40,
      tools: [
        {
          name: "update_plan",
          description: "Plan.",
          parameters: parametersFor({
            type: "object",
            properties: {},
          } as never),
          execute: async () => "ok",
        },
      ],
    } as BuiltInAgentConfiguration,
    {},
    run,
  );
  return configuration as {
    model: {
      doStream: (o: unknown) => Promise<{ stream: ReadableStream }>;
      doGenerate: (o: unknown) => Promise<{
        content: unknown[];
        finishReason: unknown;
        usage: unknown;
      }>;
    };
  };
}

async function drain(stream: ReadableStream) {
  const parts: { type: string; delta?: string; finishReason?: unknown }[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

async function stream(
  asked: Message[][],
  prompt: Message[],
  options: {
    run?: Run;
    tools?: string[];
    spec?: "v2" | "v3";
  } = {},
) {
  const { model } = wrapped(asked, options.run ?? {}, options.spec);
  const started = await model.doStream({
    prompt,
    tools: (options.tools ?? ["computer_run_command"]).map((name) => ({
      type: "function",
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  });
  return drain(started.stream);
}

const delivering = (value = DELIVERED): Message[] => [
  user("把活做完交付"),
  call("d1", "deliver_task", { items: [], checks: ["查过了"] }),
  result("d1", "deliver_task", value),
];

describe("交付被接受之后，这一轮直接结束", () => {
  test("交付被接受：不再问模型，流以 stop 结束、没有文字", async () => {
    const asked: Message[][] = [];
    const parts = await stream(asked, delivering(), {
      run: { endsTurnAfter: endsAfter },
    });
    expect(asked).toHaveLength(0);
    expect(parts.some((part) => part.type === "text-delta")).toBe(false);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop" },
    });
  });

  test("v2 的模型：结束原因是一个词，用量是平的数字", async () => {
    const asked: Message[][] = [];
    const parts = await stream(asked, delivering(), {
      run: { endsTurnAfter: endsAfter },
      spec: "v2",
    });
    expect(asked).toHaveLength(0);
    const finish = parts.at(-1) as { finishReason?: unknown; usage?: unknown };
    expect(finish.finishReason).toBe("stop");
    expect(finish.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  test("非流式调用同样结束，不问模型", async () => {
    const asked: Message[][] = [];
    const { model } = wrapped(asked, { endsTurnAfter: endsAfter });
    const generated = await model.doGenerate({
      prompt: delivering(),
      tools: [],
    });
    expect(asked).toHaveLength(0);
    expect(generated.content).toEqual([]);
    expect(generated.finishReason).toMatchObject({ unified: "stop" });
  });

  test("结果是 json 形状（不是文字）也认", async () => {
    const asked: Message[][] = [];
    const prompt = delivering();
    prompt[2] = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "d1",
          toolName: "deliver_task",
          output: { type: "json", value: { delivered: true } },
        },
      ],
    };
    await stream(asked, prompt, {
      run: {
        endsTurnAfter: (name, text) =>
          name === "deliver_task" && text.includes("delivered"),
      },
    });
    expect(asked).toHaveLength(0);
  });

  test("同一步里还有别的调用，交付被接受也结束", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      user("交付"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "p1",
            toolName: "update_plan",
            input: { items: [{ text: "交付", status: "done" }] },
          },
          {
            type: "tool-call",
            toolCallId: "d1",
            toolName: "deliver_task",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "p1",
            toolName: "update_plan",
            output: { type: "text", value: "已更新计划" },
          },
          {
            type: "tool-result",
            toolCallId: "d1",
            toolName: "deliver_task",
            output: { type: "text", value: DELIVERED },
          },
        ],
      },
    ];
    await stream(asked, prompt, { run: { endsTurnAfter: endsAfter } });
    expect(asked).toHaveLength(0);
  });
});

describe("该照旧走的情形一步不省", () => {
  test("被挡回的交付：模型照常再走一步", async () => {
    const asked: Message[][] = [];
    await stream(asked, delivering(BOUNCED), {
      run: { endsTurnAfter: endsAfter },
    });
    expect(asked).toHaveLength(1);
  });

  test("交付被接受之后又做了别的事：最新一步不是交付，照常走", async () => {
    const asked: Message[][] = [];
    const prompt = [
      ...delivering(),
      call("c1", "computer_run_command", { command: "ls" }),
      result("c1", "computer_run_command"),
    ];
    await stream(asked, prompt, { run: { endsTurnAfter: endsAfter } });
    expect(asked).toHaveLength(1);
  });

  test("没给判断（开关关着）：和原来一样，模型再说一句收尾的话", async () => {
    const asked: Message[][] = [];
    const parts = await stream(asked, delivering(), { run: {} });
    expect(asked).toHaveLength(1);
    expect(parts.some((part) => part.type === "text-delta")).toBe(true);
  });

  test("计划里还有没做的项：交付之后照旧被提醒一次，不直接收尾", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      user("交付"),
      call("p1", "update_plan", {
        items: [
          { text: "写产物", status: "done" },
          { text: "核对", status: "pending" },
        ],
      }),
      result("p1", "update_plan"),
      call("d1", "deliver_task", {}),
      result("d1", "deliver_task", DELIVERED),
    ];
    await stream(asked, prompt, { run: { endsTurnAfter: endsAfter } });
    // 模型被问了一次，它说的话又被计划提醒顶回去（连续提醒到上限），都是原来就有的行为。
    expect(asked.length).toBeGreaterThan(1);
    const told = JSON.stringify(asked.at(-1)?.at(-1)?.content ?? "");
    expect(told).toContain("计划里还有 1 项没做完");
  });

  test("改完文件没有校验：交付之后照旧被提醒一次，不直接收尾", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      user("改一下"),
      call("e1", "computer_edit_file", { path: "src/a.ts" }),
      result("e1", "computer_edit_file"),
      call("d1", "deliver_task", {}),
      result("d1", "deliver_task", DELIVERED),
    ];
    await stream(asked, prompt, {
      run: { endsTurnAfter: endsAfter },
      tools: ["computer_run_command", "computer_edit_file"],
    });
    expect(asked.length).toBeGreaterThan(1);
    expect(JSON.stringify(asked.at(-1)?.at(-1)?.content ?? "")).toContain(
      "没有跑任何测试",
    );
  });

  test("改完文件校验过了：交付之后直接收尾", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      user("改一下"),
      call("e1", "computer_edit_file", { path: "src/a.ts" }),
      result("e1", "computer_edit_file"),
      call("c1", "computer_run_command", { command: "bun test" }),
      result("c1", "computer_run_command"),
      call("d1", "deliver_task", {}),
      result("d1", "deliver_task", DELIVERED),
    ];
    await stream(asked, prompt, {
      run: { endsTurnAfter: endsAfter },
      tools: ["computer_run_command", "computer_edit_file"],
    });
    expect(asked).toHaveLength(0);
  });
});

describe("整条运行链路里：交付后的一步被省掉", () => {
  function agentFor(asked: Message[][], run: Run) {
    // 第一步调交付；要是再被问一次，就说一句收尾的话。
    let step = 0;
    const model = {
      ...closingModel(asked),
      doStream: async (options: { prompt: Message[] }) => {
        asked.push(options.prompt);
        step += 1;
        const parts =
          step === 1
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "d1",
                  toolName: "deliver_task",
                  input: "{}",
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage,
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "交付好了。" },
                { type: "text-end", id: "text" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
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
    return new BuiltInAgentWithSaneHistory(
      {
        model: model as never,
        prompt: "Work.",
        maxSteps: 10,
        tools: [
          {
            name: "deliver_task",
            description: "Hand in.",
            parameters: parametersFor({
              type: "object",
              properties: {},
            } as never),
            execute: async () => DELIVERED,
          },
        ],
      } as BuiltInAgentConfiguration,
      { observe: (r) => r, ...run },
    );
  }

  async function runIt(agent: BuiltInAgentWithSaneHistory) {
    agent.threadId = "thread";
    agent.setMessages([{ id: "ask", role: "user", content: "交付它。" }]);
    const types: string[] = [];
    await agent.runAgent(
      {},
      { onEvent: ({ event }: { event: BaseEvent }) => types.push(event.type) },
    );
    return types;
  }

  test("开着：一步调交付，之后不再问模型，运行正常结束", async () => {
    const asked: Message[][] = [];
    const types = await runIt(
      agentFor(asked, { endsTurnAfter: endsAfter } as never),
    );
    expect(asked).toHaveLength(1);
    expect(types).toContain("TOOL_CALL_RESULT");
    expect(types.at(-1)).toBe("RUN_FINISHED");
  });

  test("关着：交付之后模型还被问一次，说一句收尾的话", async () => {
    const asked: Message[][] = [];
    const types = await runIt(agentFor(asked, {}));
    expect(asked).toHaveLength(2);
    expect(types.at(-1)).toBe("RUN_FINISHED");
  });
});
