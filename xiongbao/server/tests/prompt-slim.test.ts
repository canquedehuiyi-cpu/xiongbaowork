import { describe, expect, test } from "bun:test";
import { RUNTIME_STATE_TOOLS } from "@xiongbao/toolkit/runtime/agents";
import { z } from "zod";
import {
  deferredNames,
  HIDDEN_TOOLS,
  isDeploymentTool,
  promptSlimOn,
  slimModelTools,
} from "../src/agents/prompt-slim";
import {
  isSearchingModel,
  SEARCH_TOOLS,
  searchToolsTool,
  toolsForStep,
} from "../src/agents/tool-search";

/** 提示词瘦身的几个小零件（体积守卫在 prompt-budget.test.ts）。 */

test("隐藏的就是运行时每次都加的那两个状态工具", () => {
  expect([...HIDDEN_TOOLS].sort()).toEqual([...RUNTIME_STATE_TOOLS].sort());
});

describe("开关", () => {
  test("默认开，只有 off 才关", () => {
    expect(promptSlimOn({})).toBe(true);
    expect(promptSlimOn({ XIONGBAO_PROMPT_SLIM: "on" })).toBe(true);
    expect(promptSlimOn({ XIONGBAO_PROMPT_SLIM: "off" })).toBe(false);
    expect(promptSlimOn({ XIONGBAO_PROMPT_SLIM: " OFF " })).toBe(false);
  });

  test("关着时没有任何工具排到后面", () => {
    const names = ["computer_navigate", "computer_run_command"];
    expect(deferredNames(names, {})).toEqual(new Set(["computer_navigate"]));
    expect(deferredNames(names, { XIONGBAO_PROMPT_SLIM: "off" })).toEqual(
      new Set(),
    );
  });

  test("名单外的工具（应用的、测试里的）从不排到后面，也不当作熊宝自带的", () => {
    expect(deferredNames(["mcp__a__DO", "get_weather"], {})).toEqual(new Set());
    expect(isDeploymentTool("get_weather")).toBe(false);
    expect(isDeploymentTool("computer_snapshot")).toBe(true);
  });
});

describe("发给模型的工具定义", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 9007199254740991 },
      maximum: { type: "integer" },
    },
    required: ["path"],
    additionalProperties: false,
  };

  test("去掉每个工具都带的 $schema 和满格的 maximum，参数名一个不改，参数叫 maximum 也留着", () => {
    const [tool] = slimModelTools([
      {
        type: "function",
        name: "x_tool",
        description: "d",
        inputSchema: schema,
      },
    ]);
    const out = tool?.inputSchema as typeof schema;
    expect(out).not.toHaveProperty("$schema");
    expect(out.properties.limit).not.toHaveProperty("maximum");
    expect(Object.keys(out.properties)).toEqual(["path", "limit", "maximum"]);
    expect(out.required).toEqual(["path"]);
    expect(out).not.toHaveProperty("additionalProperties");
  });

  test("OpenAI 的 Responses 接口要求每个对象写明 additionalProperties，那条路径上留着", () => {
    const [tool] = slimModelTools(
      [{ type: "function", name: "x_tool", inputSchema: schema }],
      { strict: true },
    );
    expect(
      (tool as { inputSchema: typeof schema }).inputSchema.additionalProperties,
    ).toBe(false);
  });

  test("常驻工具换短描述、参数说明，别的工具描述不动；运行时状态工具不发", () => {
    const tools = slimModelTools([
      {
        type: "function",
        name: "computer_run_command",
        description: "x".repeat(500),
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutMs: { type: "number", description: "long" },
          },
        },
      },
      { type: "function", name: "other", description: "keep me" },
      { type: "function", name: "AGUISendStateDelta", description: "state" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "computer_run_command",
      "other",
    ]);
    expect(tools[0]?.description?.length).toBeLessThan(500);
    const props = (
      (tools[0] as { inputSchema: unknown }).inputSchema as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(Object.keys(props)).toEqual(["command", "timeoutMs"]);
    expect(props.timeoutMs?.description).not.toBe("long");
    expect(tools[1]?.description).toBe("keep me");
  });
});

describe("search_tools 取随运行来的电脑工具", () => {
  const client = (name: string, description: string) => ({
    name,
    ref: `client/${name}`,
    description,
    parameters: z.object({ url: z.string() }),
    execute: async () => "",
  });
  const waiting = [
    client("computer_navigate", "Open a web page."),
    client("computer_snapshot", "List the fields of a page."),
    client("generate_image", "Make a picture."),
  ];

  // 用户 2026-11-21 批准：描述里不再逐个列名字，只用一行说有哪几类；名字在搜到的结果里，搜不到时给整张清单。
  test("描述只说有哪几类；用「browser」这样的词整类都找得到；搜不到就把清单给它", async () => {
    const tool = searchToolsTool(waiting, { slim: true });
    expect(tool.description).toContain("browser");
    expect(tool.description).toContain("image/video");
    for (const name of waiting)
      expect(tool.description).not.toContain(name.name);
    const found = String(await tool.execute({ query: "browser" }));
    expect(found.split("\n")[0]).toBe(
      "Tools found: computer_navigate, computer_snapshot",
    );
    const none = String(await tool.execute({ query: "zzz" }));
    expect(none).toContain("Tools you can load: computer_navigate");
  });

  test("找到以后，同一轮后面的每一步都还带着它，没找的仍然不带", () => {
    const waits = new Set(waiting.map((tool) => tool.name));
    const modelTools = [
      ...waiting.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: "",
        inputSchema: {},
      })),
      {
        type: "function" as const,
        name: "computer_run_command",
        description: "",
        inputSchema: {},
      },
      {
        type: "function" as const,
        name: SEARCH_TOOLS,
        description: "",
        inputSchema: {},
      },
    ];
    const step = (prompt: unknown[]) =>
      toolsForStep(modelTools as never, prompt as never, waits)?.map(
        (tool) => (tool as { name: string }).name,
      );
    const asked = { role: "user", content: [{ type: "text", text: "go" }] };
    expect(step([asked])).toEqual(["computer_run_command", SEARCH_TOOLS]);
    const searched = [
      asked,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: SEARCH_TOOLS,
            toolCallId: "1",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: SEARCH_TOOLS,
            toolCallId: "1",
            output: {
              type: "text",
              value: "Tools found: computer_navigate\n…",
            },
          },
        ],
      },
    ];
    expect(step(searched)).toEqual([
      "computer_navigate",
      "computer_run_command",
      SEARCH_TOOLS,
    ]);
    // 又过了几步（调用、结果），仍然在。
    const later = [
      ...searched,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "computer_navigate",
            toolCallId: "2",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "computer_navigate",
            toolCallId: "2",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];
    expect(step(later)).toContain("computer_navigate");
    expect(step(later)).not.toContain("generate_image");
  });
});

describe("检索包装认哪些模型", () => {
  test("关着瘦身只认 v3（和以前一样），开着再认 v2", () => {
    const v2 = { specificationVersion: "v2" };
    const v3 = { specificationVersion: "v3" };
    expect(isSearchingModel(v3)).toBe(true);
    expect(isSearchingModel(v2)).toBe(false);
    expect(isSearchingModel(v2, { v2: true })).toBe(true);
    expect(isSearchingModel("openai/gpt-5.5", { v2: true })).toBe(false);
  });
});
