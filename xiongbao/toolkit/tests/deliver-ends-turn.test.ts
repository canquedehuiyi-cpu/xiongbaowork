import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { parametersFor } from "../src/granted-tool";
import { BuiltInAgentWithSaneHistory } from "../src/runtime/agents";
import { answersOnLastStep } from "../src/runtime/last-step";

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

  test("没给判断（开关关着）：交付之后又做了别的事，照常再走一步", async () => {
    const asked: Message[][] = [];
    const prompt = [
      ...delivering(),
      call("c1", "computer_run_command", { command: "ls" }),
      result("c1", "computer_run_command"),
    ];
    await stream(asked, prompt, { run: {} });
    expect(asked).toHaveLength(1);
  });

  test("被挡回的交付之后又做了别的事：不算已交付，照常再走一步", async () => {
    const asked: Message[][] = [];
    const prompt = [
      ...delivering(BOUNCED),
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

describe("交付被接受之后有提醒：只放行一步，这一步之后结束", () => {
  const openPlan = (): Message[] => [
    call("p1", "update_plan", {
      items: [
        { text: "写产物", status: "done" },
        { text: "核对", status: "pending" },
      ],
    }),
    result("p1", "update_plan"),
  ];

  test("交付后又走了一步（有提醒时放行的那一步）：下一步不再问模型", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      user("交付"),
      ...openPlan(),
      call("d1", "deliver_task", {}),
      result("d1", "deliver_task", DELIVERED),
      call("c1", "computer_run_command", { command: "ls" }),
      result("c1", "computer_run_command"),
    ];
    const parts = await stream(asked, prompt, {
      run: { endsTurnAfter: endsAfter },
    });
    expect(asked).toHaveLength(0);
    expect(parts.at(-1)).toMatchObject({ type: "finish" });
  });

  test("放行的那一步里又交付了一次、被接受：同样结束，不再放行", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      user("交付"),
      ...openPlan(),
      call("d1", "deliver_task", {}),
      result("d1", "deliver_task", DELIVERED),
      call("d2", "deliver_task", {}),
      result("d2", "deliver_task", DELIVERED),
    ];
    await stream(asked, prompt, { run: { endsTurnAfter: endsAfter } });
    expect(asked).toHaveLength(0);
  });

  test("非流式调用同样：放行的一步之后结束", async () => {
    const asked: Message[][] = [];
    const { model } = wrapped(asked, { endsTurnAfter: endsAfter });
    const generated = await model.doGenerate({
      prompt: [
        user("交付"),
        ...openPlan(),
        call("d1", "deliver_task", {}),
        result("d1", "deliver_task", DELIVERED),
        call("c1", "computer_run_command", { command: "ls" }),
        result("c1", "computer_run_command"),
      ],
      tools: [],
    });
    expect(asked).toHaveLength(0);
    expect(generated.content).toEqual([]);
  });

  test("之前的一次被挡回、后来才被接受：从被接受那一次算起", async () => {
    const asked: Message[][] = [];
    const prompt: Message[] = [
      ...delivering(BOUNCED),
      ...openPlan(),
      call("d2", "deliver_task", {}),
      result("d2", "deliver_task", DELIVERED),
    ];
    await stream(asked, prompt, { run: { endsTurnAfter: endsAfter } });
    // 刚被接受、还有提醒：这一步放行（问模型），而不是结束。
    expect(asked.length).toBeGreaterThan(0);
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

describe("整条运行链路里：交付后有提醒，只多走一步", () => {
  const tool = (id: string, name: string, input: unknown) => ({
    type: "tool-call",
    toolCallId: id,
    toolName: name,
    input: JSON.stringify(input),
  });
  const toolsFinish = {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage,
  };
  const stopFinish = {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage,
  };
  const said = [
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "好了。" },
    { type: "text-end", id: "text" },
  ];

  /** 每一步按脚本说话；脚本用完就说一句话收尾。 */
  function scripted(script: Record<string, unknown>[][], asked: number[]) {
    return {
      ...closingModel([]),
      doStream: async () => {
        asked.push(1);
        const parts = script[asked.length - 1] ?? [...said, stopFinish];
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    };
  }

  async function runScript(
    script: Record<string, unknown>[][],
    options: { on: boolean; deliveries?: string[] },
  ) {
    const asked: number[] = [];
    const ran: string[] = [];
    const deliveries = [...(options.deliveries ?? [DELIVERED])];
    const make = (name: string, execute: () => Promise<string>) => ({
      name,
      description: name,
      parameters: parametersFor({ type: "object", properties: {} } as never),
      execute: async () => {
        ran.push(name);
        return execute();
      },
    });
    const agent = new BuiltInAgentWithSaneHistory(
      {
        model: scripted(script, asked) as never,
        prompt: "Work.",
        maxSteps: 20,
        tools: [
          make("update_plan", async () => "ok"),
          make("computer_run_command", async () => "ok"),
          make("deliver_task", async () => deliveries.shift() ?? DELIVERED),
        ],
      } as BuiltInAgentConfiguration,
      {
        observe: (r) => r,
        ...(options.on ? { endsTurnAfter: endsAfter } : {}),
      },
    );
    agent.threadId = "thread";
    agent.setMessages([{ id: "ask", role: "user", content: "交付它。" }]);
    const types: string[] = [];
    await agent.runAgent(
      {},
      { onEvent: ({ event }: { event: BaseEvent }) => types.push(event.type) },
    );
    return { asked: asked.length, ran, types };
  }

  const plan = (status: string) => ({
    items: [
      { text: "写产物", status: "done" },
      { text: "核对", status },
    ],
  });
  /** 第 1 步：计划里留一项没做，同一步交付（被接受）；第 2 步照提醒做点事。 */
  const deliverWithOpenPlan = [
    tool("p1", "update_plan", plan("pending")),
    tool("d1", "deliver_task", {}),
    toolsFinish,
  ];

  test("无提醒：交付后 0 步结束", async () => {
    const result = await runScript(
      [[tool("d1", "deliver_task", {}), toolsFinish]],
      { on: true },
    );
    expect(result.asked).toBe(1);
    expect(result.types.at(-1)).toBe("RUN_FINISHED");
  });

  test("有提醒：恰好再问 1 次模型，这一步里的工具照常执行，之后结束", async () => {
    const result = await runScript(
      [
        deliverWithOpenPlan,
        [tool("p2", "update_plan", plan("done")), toolsFinish],
        [tool("c1", "computer_run_command", { command: "ls" }), toolsFinish],
      ],
      { on: true },
    );
    expect(result.asked).toBe(2);
    expect(result.ran).toEqual(["update_plan", "deliver_task", "update_plan"]);
    expect(result.types.at(-1)).toBe("RUN_FINISHED");
  });

  test("放行的那一步里又交付一次、被接受：结束，不再问", async () => {
    const result = await runScript(
      [deliverWithOpenPlan, [tool("d2", "deliver_task", {}), toolsFinish]],
      { on: true },
    );
    expect(result.asked).toBe(2);
    expect(result.types.at(-1)).toBe("RUN_FINISHED");
  });

  test("开关关着（不给判断）：照旧，不限步数", async () => {
    const result = await runScript(
      [
        deliverWithOpenPlan,
        [tool("p2", "update_plan", plan("done")), toolsFinish],
        [tool("c1", "computer_run_command", { command: "ls" }), toolsFinish],
      ],
      { on: false },
    );
    // 第 3 步调了工具，第 4 步（说一句话）照问。
    expect(result.asked).toBe(4);
    expect(result.types.at(-1)).toBe("RUN_FINISHED");
  });

  test("被挡回的交付：不受影响，模型照常继续，直到交付被接受", async () => {
    const result = await runScript(
      [
        [tool("d1", "deliver_task", {}), toolsFinish],
        [tool("c1", "computer_run_command", { command: "ls" }), toolsFinish],
        [tool("d2", "deliver_task", {}), toolsFinish],
      ],
      { on: true, deliveries: [BOUNCED, DELIVERED] },
    );
    expect(result.asked).toBe(3);
    expect(result.ran).toEqual([
      "deliver_task",
      "computer_run_command",
      "deliver_task",
    ]);
  });
});
