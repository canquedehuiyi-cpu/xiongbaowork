import { expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  PLATFORM_FLOW_MODEL_ID,
  WAKERFLOW_PLAN_FORMAT_MESSAGE,
  WAKERFLOW_SUGGESTIONS,
  type WakerFlowPlan,
} from "../../shared/wakerflows";
import type { Database } from "../src/db/client";
import {
  createFlowGenerator,
  type FlowGenerateCall,
  FlowGenerationCancelledError,
  FlowGenerationRefusedError,
  FlowGenerationUncertainError,
  FlowPlanFormatError,
  firstJsonObject,
} from "../src/wakerflows/generator";
import {
  createFlowModelResolver,
  FlowModelUnavailableError,
} from "../src/wakerflows/model";

/**
 * WF-B (spec D10, stories WF2/WF3): the planning call and the model pick, with an injected fake in
 * place of the provider. Nothing here reaches a network or a database.
 */
const model = "fake/planner" as unknown as LanguageModel;
const members = [
  { agentId: "writer-1", name: "小记", role: "记录员" },
  { agentId: "reviewer-1", name: "小审", role: "复核员" },
];
const plan: WakerFlowPlan = {
  name: "会议纪要",
  description: "整理与复核",
  members: [
    { agentId: "writer-1", role: "记录员" },
    { agentId: "reviewer-1", role: "复核员" },
  ],
  inputs: [{ key: "notes", label: "会议内容", required: true }],
  steps: [
    {
      id: "draft",
      agentId: "writer-1",
      instruction: "整理纪要",
      inputKeys: ["notes"],
      outputKey: "summary",
    },
    {
      id: "review",
      agentId: "reviewer-1",
      instruction: "复核纪要",
      inputKeys: ["summary"],
      outputKey: "result",
    },
  ],
};

function answering(text: string) {
  const calls: Parameters<FlowGenerateCall>[0][] = [];
  const generate: FlowGenerateCall = async (input) => {
    calls.push(input);
    return { text };
  };
  return { calls, generate };
}

test("the one call carries the idea, every offered coworker and the chosen scenario", async () => {
  const fake = answering(
    `好的，这是计划：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n祝顺利 {不是 JSON}`,
  );
  const generator = createFlowGenerator({ generate: fake.generate });
  const scenario = WAKERFLOW_SUGGESTIONS[1];
  const result = await generator.plan({
    model,
    idea: "整理每周例会",
    members,
    scenario,
  });
  expect(result).toEqual(plan);
  expect(fake.calls).toHaveLength(1);
  const [call] = fake.calls;
  expect(call?.model).toBe(model);
  expect(call?.abortSignal).toBeInstanceOf(AbortSignal);
  expect(call?.prompt).toContain("整理每周例会");
  expect(call?.prompt).toContain(scenario);
  for (const member of members) {
    expect(call?.prompt).toContain(member.agentId);
    expect(call?.prompt).toContain(member.name);
    expect(call?.prompt).toContain(member.role);
  }
  expect(call?.system).toContain("JSON");
});

test("an answer that is not a valid plan is a retryable format error, not the provider's words", async () => {
  for (const text of [
    "抱歉，我无法生成计划。",
    "{ 不完整的 JSON",
    JSON.stringify({ ...plan, steps: [] }),
    JSON.stringify({ ...plan, extra: true }),
    // A coworker nobody offered must not slip into the plan.
    JSON.stringify({
      ...plan,
      members: [{ agentId: "someone-else", role: "外人" }],
      steps: [{ ...plan.steps[0], agentId: "someone-else", inputKeys: [] }],
    }),
  ]) {
    const generator = createFlowGenerator({
      generate: answering(text).generate,
    });
    const failure = await generator
      .plan({ model, idea: "整理会议", members })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(FlowPlanFormatError);
    expect((failure as FlowPlanFormatError).retryable).toBeTrue();
    expect((failure as Error).message).toBe(WAKERFLOW_PLAN_FORMAT_MESSAGE);
    expect(WAKERFLOW_PLAN_FORMAT_MESSAGE).toContain("计划格式无效，请重试");
  }
});

test("aborting the caller's signal mid-call is a cancellation", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const generator = createFlowGenerator({
    generate: (input) =>
      new Promise((_, reject) => {
        started();
        input.abortSignal.addEventListener("abort", () =>
          reject(new Error("synthetic socket closed")),
        );
      }),
  });
  const pending = generator.plan({
    model,
    idea: "整理会议",
    members,
    signal: controller.signal,
  });
  await running;
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(FlowGenerationCancelledError);

  let called = 0;
  const already = new AbortController();
  already.abort();
  await expect(
    createFlowGenerator({
      generate: async () => {
        called += 1;
        return { text: JSON.stringify(plan) };
      },
    }).plan({ model, idea: "整理会议", members, signal: already.signal }),
  ).rejects.toBeInstanceOf(FlowGenerationCancelledError);
  expect(called).toBe(0);
});

test("provider failures are classified without ever repeating the provider's text", async () => {
  const secret = "synthetic-secret-sk-123";
  const failing = (statusCode?: number) =>
    createFlowGenerator({
      generate: async () => {
        throw Object.assign(new Error(`upstream said ${secret}`), {
          statusCode,
          responseBody: secret,
        });
      },
    }).plan({ model, idea: "整理会议", members });
  for (const [status, kind] of [
    [401, FlowGenerationRefusedError],
    [429, FlowGenerationRefusedError],
    [503, FlowGenerationUncertainError],
    [408, FlowGenerationUncertainError],
    [undefined, FlowGenerationUncertainError],
  ] as const) {
    const error = await failing(status).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(kind);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain("upstream");
  }
  const timedOut = await createFlowGenerator({
    timeoutMs: 20,
    generate: (input) =>
      new Promise((_, reject) => {
        input.abortSignal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  })
    .plan({ model, idea: "整理会议", members })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
  expect(timedOut).toBeInstanceOf(FlowGenerationUncertainError);
});

test("the first JSON object is found past prose and braces inside strings", () => {
  expect(
    firstJsonObject('前言 {"a": "}{", "b": {"c": 1}} 后记 {"d": 2}'),
  ).toEqual({ a: "}{", b: { c: 1 } });
  expect(firstJsonObject("没有对象")).toBeNull();
  expect(firstJsonObject('{"a": ')).toBeNull();
});

test("the platform model is off by default: neither accepted nor substituted, and checked before any query", async () => {
  // A database that fails every touch proves the refusals happen before any row is read.
  const untouchable = new Proxy(
    {},
    {
      get() {
        throw new Error("The resolver must not reach the database here.");
      },
    },
  ) as unknown as Database;
  const resolver = createFlowModelResolver({
    database: untouchable,
    encryptionKey: "",
    platform: { name: "custom/platform-plan", model: () => model },
  });
  for (const ref of [PLATFORM_FLOW_MODEL_ID, "not-a-uuid", "", null]) {
    const error = await resolver.resolve("tenant-a", ref).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(FlowModelUnavailableError);
    expect((error as FlowModelUnavailableError).status).toBe(400);
  }
  await expect(
    resolver.resolve("tenant-a", PLATFORM_FLOW_MODEL_ID),
  ).rejects.toThrow("未配置");

  const allowed = createFlowModelResolver({
    database: untouchable,
    encryptionKey: "",
    allowPlatformModel: true,
    platform: { name: "custom/platform-plan", model: () => model },
  });
  expect(
    await allowed.resolve("tenant-a", PLATFORM_FLOW_MODEL_ID),
  ).toMatchObject({
    modelRef: PLATFORM_FLOW_MODEL_ID,
    name: "custom/platform-plan",
    model,
  });
  // Allowed but not configured is still a refusal, never a silent default.
  await expect(
    createFlowModelResolver({
      database: untouchable,
      encryptionKey: "",
      allowPlatformModel: true,
    }).resolve("tenant-a", PLATFORM_FLOW_MODEL_ID),
  ).rejects.toThrow("未配置");
});
