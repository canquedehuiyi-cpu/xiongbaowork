import { describe, expect, test } from "bun:test";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  answersOnLastStep,
  MOST_NUDGES,
  type RunSteps,
} from "../src/copilotkit/last-step";
import { parametersFor } from "../src/granted-tool";

/*
 * 收尾前的提醒要看「这一轮」做过什么，而不是「这一次运行」做过什么。
 *
 * 无头的一轮（看板派活、例行）被服务器切成很多次运行：模型要一个电脑工具，服务器执行，再从历史接着跑。
 * 每次运行都从自己的开头数起，于是早先写的计划、早先改的文件，在后面的运行里都成了「历史」，收尾提醒看不到：
 * 计划里还有没做的项、改完没有校验，模型一句话收尾就真的收尾了，评测脚本只好替人发「继续」。
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
type Seen = { prompt: Message[]; tools: string[] };

/** 第一次回一句收尾的话（没有工具调用）；被提醒之后再回一句。每次请求的提示和工具名都记下来。 */
function closingModel(
  seen: Seen[],
  replies: string[],
  spec: "v2" | "v3" = "v3",
) {
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
    doGenerate: async () => {
      throw new Error("Only streamed here.");
    },
    doStream: async (options: {
      prompt: Message[];
      tools?: { name: string }[];
    }) => {
      seen.push({
        prompt: options.prompt,
        tools: (options.tools ?? []).map((tool) => tool.name),
      });
      const text = replies[Math.min(seen.length - 1, replies.length - 1)];
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: text },
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
const result = (id: string, toolName: string): Message => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName,
      output: { type: "text", value: "ok" },
    },
  ],
});
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

function wrapped(
  seen: Seen[],
  replies: string[],
  run: Parameters<typeof answersOnLastStep>[2] = {},
  spec: "v2" | "v3" = "v3",
) {
  const steps: RunSteps = {};
  const configuration = answersOnLastStep(
    {
      model: closingModel(seen, replies, spec) as never,
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
    steps,
    run,
  );
  return configuration as { model: { doStream: (o: unknown) => unknown } };
}

async function ask(
  seen: Seen[],
  replies: string[],
  prompt: Message[],
  options: {
    tools?: string[];
    run?: Parameters<typeof answersOnLastStep>[2];
    spec?: "v2" | "v3";
  } = {},
) {
  const { model } = wrapped(seen, replies, options.run, options.spec);
  const streamed = (await model.doStream({
    prompt,
    tools: (options.tools ?? ["computer_run_command"]).map((name) => ({
      type: "function",
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  })) as { stream: ReadableStream };
  const reader = streamed.stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/** 最后一次请求末尾那条只在这一步出现的提醒。 */
function lastTold(seen: Seen[]): string {
  const prompt = seen[seen.length - 1]?.prompt ?? [];
  const last = prompt[prompt.length - 1];
  return JSON.stringify(last?.content ?? "");
}

/** 一轮：人交代、早先几次运行里写了计划、做了几步，这一次运行从这里开始。 */
function plannedEarlier(open = true): Message[] {
  return [
    user("把重构做完"),
    call("p1", "update_plan", {
      items: [
        { text: "新建 money.ts", status: open ? "pending" : "done" },
        { text: "跑测试", status: "pending" },
      ],
    }),
    result("p1", "update_plan"),
    call("c1", "computer_run_command", { command: "ls" }),
    result("c1", "computer_run_command"),
    call("c2", "computer_run_command", { command: "cat src/a.ts" }),
    result("c2", "computer_run_command"),
  ];
}

describe("计划提醒看整轮，不只看这一次运行", () => {
  test("早先的运行里写的计划还有没做的项：这一次运行一句话收尾，会被提醒", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["都做完了。", "好，继续。"], plannedEarlier());
    // 模型一直只说话不动手，提醒到上限（连续四次）为止。
    expect(seen).toHaveLength(1 + MOST_NUDGES);
    expect(lastTold(seen)).toContain("计划里还有 2 项没做完");
  });

  test("计划全部做完：不提醒", async () => {
    const seen: Seen[] = [];
    const prompt = plannedEarlier();
    prompt.push(
      call("p2", "update_plan", {
        items: [
          { text: "新建 money.ts", status: "done" },
          { text: "跑测试", status: "done" },
        ],
      }),
      result("p2", "update_plan"),
    );
    await ask(seen, ["都做完了。"], prompt);
    expect(seen).toHaveLength(1);
  });

  test("上一轮（人的上一条消息之前）留下的计划是历史，不算这一轮的", async () => {
    const seen: Seen[] = [];
    const prompt = [...plannedEarlier(), user("换个话题：1+1 等于几")];
    await ask(seen, ["2。"], prompt);
    expect(seen).toHaveLength(1);
  });

  test("部署开关 planAcrossRuns: false 回到只看这一次运行", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["都做完了。"], plannedEarlier(), {
      run: { planAcrossRuns: false },
    });
    expect(seen).toHaveLength(1);
  });
});

describe("改完必验：改过文件的一轮，收尾前没有校验动作，提醒一次", () => {
  const edited = (path = "src/money.ts"): Message[] => [
    user("把重构做完"),
    call("w1", "computer_write_file", { path, contents: "x" }),
    result("w1", "computer_write_file"),
  ];

  test("改过代码、之后没跑任何命令：提醒，并点出改过的文件", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["改好了。", "好，我跑测试。"], edited());
    expect(seen).toHaveLength(2);
    expect(lastTold(seen)).toContain("src/money.ts");
    expect(lastTold(seen)).toContain("没有");
  });

  test("改完之后跑过测试：不提醒", async () => {
    const seen: Seen[] = [];
    const prompt = [
      ...edited(),
      call("t1", "computer_run_command", { command: "bun test" }),
      result("t1", "computer_run_command"),
    ];
    await ask(seen, ["改好了，测试通过。"], prompt);
    expect(seen).toHaveLength(1);
  });

  test("测试跑在改动之前不算：最后一次改动之后还得验", async () => {
    const seen: Seen[] = [];
    const prompt = [
      user("修一下"),
      call("t0", "computer_run_command", { command: "bun test" }),
      result("t0", "computer_run_command"),
      call("e1", "computer_edit_file", { path: "src/a.ts" }),
      result("e1", "computer_edit_file"),
    ];
    await ask(seen, ["修好了。"], prompt);
    expect(seen).toHaveLength(2);
  });

  test("只写了 Markdown 文档：不提醒（没有什么可跑的）", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["写好了。"], edited("report.md"));
    expect(seen).toHaveLength(1);
  });

  test("没有 shell 的员工不提醒：它跑不了测试", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["改好了。"], edited(), { tools: ["computer_write_file"] });
    expect(seen).toHaveLength(1);
  });

  test("只提醒一次：被提醒后还是不验，第二次收尾就放行", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["改好了。", "这里没有测试可跑。"], edited());
    expect(seen).toHaveLength(2);
  });

  test("部署开关 verifyChanges: false 关掉", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["改好了。"], edited(), { run: { verifyChanges: false } });
    expect(seen).toHaveLength(1);
  });

  test("命令改的文件也算：重定向到代码文件、sed -i", async () => {
    const seen: Seen[] = [];
    const prompt = [
      user("改"),
      call("s1", "computer_run_command", {
        command: "sed -i 's/a/b/' src/a.ts",
      }),
      result("s1", "computer_run_command"),
    ];
    await ask(seen, ["改好了。"], prompt);
    expect(seen).toHaveLength(2);
  });

  test("命令只写 Markdown 或只读：不算改动", async () => {
    const seen: Seen[] = [];
    const prompt = [
      user("看看"),
      call("s1", "computer_run_command", { command: "cat a.ts > notes.md" }),
      result("s1", "computer_run_command"),
      call("s2", "computer_run_command", { command: "ls 2>&1 | head" }),
      result("s2", "computer_run_command"),
    ];
    await ask(seen, ["看完了。"], prompt);
    expect(seen).toHaveLength(1);
  });
});

describe("照着技能的快路径做：跑过技能自带的校验命令就算已校验", () => {
  const SKILL_CHECK = "awk 'END{print NR}' <dir>/actions.csv";
  const scripted = (check: boolean): Message[] => [
    user("把纪要整理成待办表"),
    call("s1", "computer_run_command", {
      command:
        "cat > /work/run.py <<'EOF'\nprint(1)\nEOF\npython3 /work/run.py",
    }),
    result("s1", "computer_run_command"),
    ...(check
      ? [
          call("s2", "computer_run_command", {
            command: "awk 'END{print NR}' /work/eval/actions.csv",
          }),
          result("s2", "computer_run_command"),
        ]
      : []),
  ];

  test("技能给了校验命令、员工跑过它：不提醒", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。"], scripted(true), {
      run: { skillChecks: [SKILL_CHECK] },
    });
    expect(seen).toHaveLength(1);
  });

  test("没跑它：照旧提醒一次", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。", "好。"], scripted(false), {
      run: { skillChecks: [SKILL_CHECK] },
    });
    expect(seen).toHaveLength(2);
  });

  test("没有技能校验时，同样的命令不算校验", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。", "好。"], scripted(true));
    expect(seen).toHaveLength(2);
  });
});

describe("规格 v2 的模型（自定义地址、Moonshot、智谱、OpenRouter）同样收到提醒", () => {
  test("包出来的模型仍是 v2：运行时按 v2 转换，流的格式对得上", () => {
    const { model } = wrapped([], ["好。"], {}, "v2") as unknown as {
      model: { specificationVersion: string };
    };
    expect(model.specificationVersion).toBe("v2");
  });

  test("计划里还有没做的项：被提醒，提醒到上限为止", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["都做完了。", "好，继续。"], plannedEarlier(), {
      spec: "v2",
    });
    expect(seen).toHaveLength(1 + MOST_NUDGES);
    expect(lastTold(seen)).toContain("计划里还有 2 项没做完");
  });

  test("改完没验：提醒一次，点出文件", async () => {
    const seen: Seen[] = [];
    const prompt = [
      user("把重构做完"),
      call("w1", "computer_write_file", { path: "src/money.ts" }),
      result("w1", "computer_write_file"),
    ];
    await ask(seen, ["改好了。", "没有测试可跑。"], prompt, { spec: "v2" });
    expect(seen).toHaveLength(2);
    expect(lastTold(seen)).toContain("src/money.ts");
  });

  test("没有要提醒的：一次请求，原样通过", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["你好。"], [user("你好")], { spec: "v2" });
    expect(seen).toHaveLength(1);
  });
});

describe("看板卡的轮要结束却没交付：提醒一次", () => {
  const TOOLS = ["computer_run_command", "deliver_task"];
  const due = { deliveryDue: true };
  const worked = (): Message[] => [
    user("做这张卡"),
    call("c1", "computer_run_command", { command: "ls" }),
    result("c1", "computer_run_command"),
  ];
  const handedIn = (id: string, value: string): Message[] => [
    call(id, "deliver_task", { deliverables: ["x"] }),
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "deliver_task",
          output: { type: "text", value },
        },
      ],
    },
  ];
  const DELIVERED = JSON.stringify({ delivered: true, taskId: "t1" });
  const BOUNCED = JSON.stringify({ bounced: true, reason: "缺必需项" });

  test("没交付要结束：提醒，用的是约定的文案", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。", "好。"], worked(), {
      tools: TOOLS,
      run: due,
    });
    expect(seen).toHaveLength(2);
    expect(lastTold(seen)).toContain(
      "这件活还没交付：用 deliver_task 列出交付物和自查，交付后再结束。",
    );
  });

  test("只提醒一次：提醒过之后再要结束，放行", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。", "还是做完了。", "真的做完了。"], worked(), {
      tools: TOOLS,
      run: due,
    });
    expect(seen).toHaveLength(2);
  });

  test("交付成功：不提醒", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["交付了。"], [...worked(), ...handedIn("d1", DELIVERED)], {
      tools: TOOLS,
      run: due,
    });
    expect(seen).toHaveLength(1);
  });

  test("宿主没说是看板卡的活：不提醒", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。"], worked(), { tools: TOOLS });
    expect(seen).toHaveLength(1);
  });

  test("这一步手里没有 deliver_task：不提醒", async () => {
    const seen: Seen[] = [];
    await ask(seen, ["做完了。"], worked(), { run: due });
    expect(seen).toHaveLength(1);
  });

  test("被挡回或被拒之后要结束：提醒", async () => {
    for (const value of [BOUNCED, "Refused. 这张卡不是你的。"]) {
      const seen: Seen[] = [];
      await ask(
        seen,
        ["好吧。", "好。"],
        [...worked(), ...handedIn("d1", value)],
        {
          tools: TOOLS,
          run: due,
        },
      );
      expect(seen).toHaveLength(2);
      expect(lastTold(seen)).toContain("deliver_task");
    }
  });
});
