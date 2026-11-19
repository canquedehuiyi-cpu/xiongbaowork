import { describe, expect, test } from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import {
  readSubagentResult,
  SUBAGENT_MODEL_GUIDANCE,
  SUBAGENT_TOOL,
  subagentGuidance,
  subagentModelGuidance,
} from "@openbot/shared/subagent";
import type { RunnerLike } from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { hardModelOf } from "../../shared/hard-model";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createSubagents } from "../src/agents/subagent";
import { resolveSubagentModel } from "../src/agents/subagent-model";
import { modelForRun } from "../src/copilot";
import { modelOf } from "../src/models/runtime-resolver";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import { runAsTenant } from "../src/tenant/context";

/*
 * 期七：`run_subagent` 可以指定模型。"hard" 是这位员工设置里的难任务模型，没设置就退回默认模型并说明；
 * 本租户可用模型里的名字也行；别的名字（包括别的租户的）用中文拒绝，不启动、不占名额、不抛异常。
 */

const ALLOWED = ["gpt-5.5", "gpt-5.5-mini", "claude-opus-5"];

describe("model 怎么解析", () => {
  const base = { hardModel: "claude-opus-5", allowed: ALLOWED };

  test("不写、或者写 default：员工平时的模型，什么都不改", () => {
    expect(resolveSubagentModel({ ...base, requested: undefined })).toEqual({});
    expect(resolveSubagentModel({ ...base, requested: "" })).toEqual({});
    expect(resolveSubagentModel({ ...base, requested: "default" })).toEqual({});
    expect(resolveSubagentModel({ ...base, requested: " Default " })).toEqual(
      {},
    );
  });

  test("hard：解析成这位员工的难任务模型", () => {
    expect(resolveSubagentModel({ ...base, requested: "hard" })).toEqual({
      use: "claude-opus-5",
    });
  });

  test("hard 但没设置难任务模型：退回默认模型，并说明", () => {
    const chosen = resolveSubagentModel({
      ...base,
      hardModel: undefined,
      requested: "hard",
    });
    expect(chosen.use).toBeUndefined();
    expect(chosen.refusal).toBeUndefined();
    expect(chosen.note).toContain("还没有设置难任务模型");
    expect(chosen.note).toContain("平时的模型");
  });

  test("hard 但设置的那个模型现在不可用了：退回默认模型，并说明是哪一个", () => {
    const chosen = resolveSubagentModel({
      ...base,
      hardModel: "retired-model",
      requested: "hard",
    });
    expect(chosen.use).toBeUndefined();
    expect(chosen.note).toContain("retired-model");
    expect(chosen.note).toContain("不在可用的模型里");
  });

  test("可用的模型名：用它", () => {
    expect(
      resolveSubagentModel({ ...base, requested: "gpt-5.5-mini" }),
    ).toEqual({ use: "gpt-5.5-mini" });
  });

  test("不认识的名字：中文拒绝，并说哪些可以写", () => {
    const chosen = resolveSubagentModel({ ...base, requested: "gpt-9-ultra" });
    expect(chosen.use).toBeUndefined();
    expect(chosen.refusal).toContain("没有启动子代理");
    expect(chosen.refusal).toContain("gpt-9-ultra");
    expect(chosen.refusal).toContain('"hard"');
    expect(chosen.refusal).toContain("gpt-5.5-mini");
  });

  test("难任务模型存在员工配置里：只认非空的字符串", () => {
    expect(hardModelOf({ hardModel: " claude-opus-5 " })).toBe("claude-opus-5");
    for (const configuration of [
      undefined,
      null,
      {},
      { hardModel: "" },
      { hardModel: "  " },
      { hardModel: 5 },
      "hardModel",
    ])
      expect(hardModelOf(configuration)).toBeUndefined();
  });

  test("提示词那一句：只给持有 run_subagent 的员工，不动原来那段", () => {
    expect(subagentModelGuidance([])).toBeUndefined();
    expect(subagentModelGuidance(["web_fetch"])).toBeUndefined();
    expect(subagentModelGuidance([SUBAGENT_TOOL])).toBe(
      SUBAGENT_MODEL_GUIDANCE,
    );
    expect(SUBAGENT_MODEL_GUIDANCE).toContain('model: "hard"');
    expect(subagentGuidance([SUBAGENT_TOOL])).not.toContain("hard");
  });
});

/** 一个真的内置员工当子代理跑：模型是 aimock，回一句话就结束。 */
async function fixture(models: {
  allowed: (owner: string) => Promise<readonly string[]>;
  hardModel?: string;
}) {
  const llm = new LLMock({ host: "127.0.0.1", port: 0 });
  let modelCalls = 0;
  llm.on({ predicate: () => true }, () => {
    modelCalls += 1;
    return { content: "子任务做完了。" };
  });
  const originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "员工", type: "built_in", systemPrompt: "做事。" },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: () => async () => [],
  });
  const runner: RunnerLike = {
    run: ({ agent, input }) =>
      new Observable((observer) => {
        agent
          .runAgent(input, { onEvent: ({ event }) => observer.next(event) })
          .then(
            () => observer.complete(),
            (error) => observer.error(error),
          );
      }),
    stop: async () => true,
  };
  const pins = new Map<string, string>();
  /** 子代理这一次运行建出来的时候，它的线程上记着哪个模型。 */
  const builtWith: (string | undefined)[] = [];
  const subagents = createSubagents({
    turn: {
      admission: async ({ signal }) => signal ?? new AbortController().signal,
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner,
    },
    buildAgentFor: async ({ ownerUserId, agentId, initiator }) => {
      builtWith.push([...pins.values()][0]);
      return resolver.resolveAgentForActor(
        { id: ownerUserId, role: "user" },
        agentId,
        { initiator, subagent: true },
      );
    },
    withdrawApprovals: async () => undefined,
    models: {
      allowed: models.allowed,
      hardModelOf: async () => models.hardModel,
      pin: (threadId, model) => {
        pins.set(threadId, model);
        return () => pins.delete(threadId);
      },
    },
  });
  const tool = (owner = "owner") =>
    subagents.toolForRun({
      actorId: owner,
      botId: "bot",
      threadId: "conversation",
      initiator: { kind: "person" },
    });
  return {
    pins,
    builtWith,
    tool,
    modelCalls: () => modelCalls,
    async [Symbol.asyncDispose]() {
      await llm.stop();
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
    },
  };
}

const asOwner = <T>(work: () => T) => runAsTenant("owner", work);
const ask = (
  tool: ReturnType<Awaited<ReturnType<typeof fixture>>["tool"]>,
  args: Record<string, unknown>,
  toolCallId = "sub-1",
) =>
  tool.execute(
    { task: "查一件事", answer: "一句话", ...args },
    { toolCallId, signal: new AbortController().signal },
  ) as Promise<string>;

describe("run_subagent 的 model 参数", () => {
  test("model 是可选的：参数里有，也不在必填里", async () => {
    await using f = await fixture({ allowed: async () => ALLOWED });
    const parameters = f.tool().parameters as unknown as {
      toJSONSchema: () => {
        properties: Record<string, unknown>;
        required: string[];
      };
    };
    const schema = parameters.toJSONSchema();
    expect(Object.keys(schema.properties)).toEqual(["task", "answer", "model"]);
    expect(schema.required).toEqual(["task", "answer"]);
  });

  test('"hard" 解析成员工的 hardModel：这个子代理的线程用它跑，跑完撤销，结果里写明', () =>
    asOwner(async () => {
      await using f = await fixture({
        allowed: async () => ALLOWED,
        hardModel: "claude-opus-5",
      });
      const result = readSubagentResult(await ask(f.tool(), { model: "hard" }));
      expect(result && "answer" in result && result.answer).toBe(
        "子任务做完了。",
      );
      expect(result?.model).toBe("claude-opus-5");
      expect(result && "modelNote" in result).toBe(false);
      // 子代理建出来的时候，它的线程上记着难任务模型；跑完就撤销了。
      expect(f.builtWith).toEqual(["claude-opus-5"]);
      expect(f.pins.size).toBe(0);
    }));

  test("hard 但没配置难任务模型：退回默认模型，照常做完，结果里说明", () =>
    asOwner(async () => {
      await using f = await fixture({ allowed: async () => ALLOWED });
      const result = readSubagentResult(await ask(f.tool(), { model: "hard" }));
      expect(result && "answer" in result && result.answer).toBe(
        "子任务做完了。",
      );
      expect(result && "model" in result).toBe(false);
      expect(result?.modelNote).toContain("还没有设置难任务模型");
      expect(f.builtWith).toEqual([undefined]);
    }));

  test("本租户可用的模型名：用它", () =>
    asOwner(async () => {
      await using f = await fixture({ allowed: async () => ALLOWED });
      const result = readSubagentResult(
        await ask(f.tool(), { model: "gpt-5.5-mini" }),
      );
      expect(result?.model).toBe("gpt-5.5-mini");
      expect(f.builtWith).toEqual(["gpt-5.5-mini"]);
    }));

  test("不写 model：和以前一样，不查模型也不记模型", () =>
    asOwner(async () => {
      let asked = 0;
      await using f = await fixture({
        allowed: async () => {
          asked += 1;
          return ALLOWED;
        },
      });
      const result = readSubagentResult(await ask(f.tool(), {}));
      expect(result && "answer" in result).toBe(true);
      expect(result && "model" in result).toBe(false);
      expect(asked).toBe(0);
      expect(f.builtWith).toEqual([undefined]);
    }));

  test("不认识的模型名：中文说明，不抛，没有启动子代理，也不占这一轮的名额", () =>
    asOwner(async () => {
      await using f = await fixture({ allowed: async () => ALLOWED });
      const tool = f.tool();
      const refused = await ask(tool, { model: "gpt-9-ultra" });
      expect(refused.startsWith(REFUSAL_MARKER)).toBe(true);
      expect(refused).toContain("没有启动子代理");
      expect(refused).toContain("gpt-9-ultra");
      expect(f.modelCalls()).toBe(0);
      expect(f.builtWith).toEqual([]);
      // 名额没被占：之后还能启动满五个。
      for (let index = 1; index <= 5; index += 1) {
        const result = readSubagentResult(await ask(tool, {}, `sub-${index}`));
        expect(result && "answer" in result).toBe(true);
      }
      expect(await ask(tool, {}, "sub-6")).toContain("up to 5 subagents");
    }));

  test("别的租户的模型名被拒：可用的模型按发起的人这一边的租户查", () =>
    asOwner(async () => {
      const byTenant: Record<string, string[]> = {
        owner: ["gpt-5.5"],
        "other-tenant": ["other-tenant-private-model"],
      };
      await using f = await fixture({
        allowed: async (owner) => byTenant[owner] ?? [],
      });
      const refused = await ask(f.tool("owner"), {
        model: "other-tenant-private-model",
      });
      expect(refused.startsWith(REFUSAL_MARKER)).toBe(true);
      expect(refused).toContain("不在可用的模型里");
      // 说的是这个租户自己可用的，不是别的租户的。
      expect(refused).toContain("gpt-5.5");
      expect(f.builtWith).toEqual([]);
    }));
});

describe("指定的模型怎么真的用上", () => {
  const model = { provider: "openai" as const, defaultModel: "gpt-5.5" };
  const input = { threadId: "t", runId: "r" } as never;

  test("服务器定的模型带着 forced 一路到这一次运行；对话里的选择从不带", async () => {
    const forced = await modelForRun(model, input, async () => ({
      model: "claude-opus-5",
      listed: true,
      forced: true,
    }));
    expect(forced.defaultModel).toBe("claude-opus-5");
    expect(forced.forced).toBe(true);
    // 指定的就是部署默认的那个：也带上，绑定照样排在后面。
    const sameAsDefault = await modelForRun(model, input, async () => ({
      model: "gpt-5.5",
      listed: true,
      forced: true,
    }));
    expect(sameAsDefault.forced).toBe(true);
    const picked = await modelForRun(model, input, async () => ({
      model: "gpt-5.5-mini",
      listed: true,
    }));
    expect(picked.defaultModel).toBe("gpt-5.5-mini");
    expect("forced" in picked).toBe(false);
  });

  test("ignoreBinding：员工绑了模型库里的模型也不取，给的是部署模型的计量版本", async () => {
    const bound = { name: "bound-model" } as never;
    const deployment = {
      model: { name: "deployment-model" } as never,
      provider: "openai",
      modelName: "claude-opus-5",
      baseUrl: null,
      apiKey: "k",
    };
    const resolve = modelOf(
      async () => ({ model: bound, name: "openai/bound" }),
      { insert: async () => undefined } as never,
    );
    // 平时：绑定的模型。
    expect(await resolve("bot", deployment)).toBe(bound);
    // 指定了模型：跳过绑定。
    expect(await resolve("bot", deployment, { ignoreBinding: true })).toBe(
      deployment.model,
    );
    // 没有部署模型可给时没有可答的。
    expect(await resolve("bot", undefined, { ignoreBinding: true })).toBeNull();
  });
});
