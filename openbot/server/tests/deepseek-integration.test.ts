import { describe, expect, test } from "bun:test";
import type { RuntimeModel } from "../src/copilot";
import { effectiveDeploymentModel, DedicatedModelConfigurationError } from "../src/models/effective-deployment";
import { createModelCompleter } from "../src/routing/model";
import { probeDeepSeek } from "../src/models/deepseek-probe";

const original: RuntimeModel = { provider: "openai", defaultModel: "old-model" };
const fakeEnvironment = () => ({
  OPENBOT_MODEL_UPSTREAM: "deepseek", DEEPSEEK_API_KEY: "fake-deepseek",
  OPENAI_API_KEY: "fake-wrong-key", OPENAI_BASE_URL: "https://example.invalid/v1",
});
describe("effective DeepSeek deployment (fake configuration only)", () => {
  test("absence leaves original selection and credential resolution to the caller", () => {
    expect(effectiveDeploymentModel(original, { DEEPSEEK_API_KEY: "fake" })).toBeUndefined();
  });
  test("unknown selection and incompatible plan transport refuse", () => {
    expect(() => effectiveDeploymentModel(original, {
      OPENBOT_MODEL_UPSTREAM: "other", DEEPSEEK_API_KEY: "fake",
    })).toThrow(DedicatedModelConfigurationError);
    expect(() => effectiveDeploymentModel({ ...original, plan: {} as NonNullable<RuntimeModel["plan"]> },
      fakeEnvironment())).toThrow(DedicatedModelConfigurationError);
  });
  test("one sealed selection supplies upstream, official base, model and dedicated key", async () => {
    const selected = effectiveDeploymentModel(original, fakeEnvironment())!;
    expect(selected.upstream).toBe("deepseek");
    expect(selected.baseUrl).toBe("https://api.deepseek.com");
    expect(selected.modelName).toBe("deepseek-flash");
    expect(selected.credentialSource).toBe("DEEPSEEK_API_KEY");
    expect(`${selected.upstream}/${selected.modelName}`).toBe("deepseek/deepseek-flash");
    expect(selected.model.defaultModel).toBe("deepseek-flash");
    expect(await selected.resolveApiKey()).toBe("fake-deepseek");
    expect(Object.isFrozen(selected.model)).toBe(true);
    expect(() => { selected.model.defaultModel = "fake-mutated"; }).toThrow();
    expect(selected.model.defaultModel).toBe("deepseek-flash");
    expect(original.defaultModel).toBe("old-model");
    expect(Object.isFrozen(original)).toBe(false);
    const model = await selected.wrapAgentResolver(async () => null)("default");
    expect(model?.modelId).toBe("deepseek-flash");
    expect(model?.provider).toBe("deepseek.chat");
  });
  test("existing employee SDK model keeps its own credential instead of the deployment key", async () => {
    const selected = effectiveDeploymentModel(original, fakeEnvironment())!;
    const ownModel = { modelId: "own-model", provider: "own-provider" } as Awaited<ReturnType<ReturnType<typeof selected.wrapAgentResolver>>>;
    expect(await selected.wrapAgentResolver(async () => ownModel)("bound")).toBe(ownModel);
    const missing = effectiveDeploymentModel(original, { OPENBOT_MODEL_UPSTREAM: "deepseek" })!;
    expect(await missing.wrapAgentResolver(async () => ownModel)("bound")).toBe(ownModel);
    await expect(missing.wrapAgentResolver(async () => null)("default"))
      .rejects.toBeInstanceOf(DedicatedModelConfigurationError);
  });
  test("rotation to missing key or binding failure never silently becomes an OpenAI fallback", async () => {
    const environment = fakeEnvironment();
    const selected = effectiveDeploymentModel(original, environment)!;
    environment.DEEPSEEK_API_KEY = "";
    await expect(selected.resolveApiKey()).rejects.toBeInstanceOf(DedicatedModelConfigurationError);
    await expect(selected.wrapAgentResolver(async () => null)("default"))
      .rejects.toBeInstanceOf(DedicatedModelConfigurationError);
    await expect(selected.wrapAgentResolver(async () => { throw new Error("fake-never-echo"); })("default"))
      .rejects.toThrow("Dedicated DeepSeek deployment configuration is unavailable or incompatible.");
  });
  test("router and skill completer use the same selected key, upstream and model", async () => {
    const selected = effectiveDeploymentModel(original, fakeEnvironment())!;
    let calls = 0;
    const transport = (async (url: unknown, init?: RequestInit) => {
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fake-deepseek");
      expect(JSON.parse(String(init?.body)).model).toBe("deepseek-flash");
      calls++;
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    }) as typeof fetch;
    for (const prompt of ["fake-router", "fake-skills"]) {
      const complete = createModelCompleter({
        model: selected.model, resolveApiKey: selected.resolveApiKey,
        upstream: selected.upstream, transport,
      });
      expect(await complete(prompt)).toBe("{}");
    }
    expect(calls).toBe(2);
  });
});
describe("DeepSeek probe fake HTTP responses", () => {
  const transport = (reply: () => Response | Promise<Response>) =>
    (async () => reply()) as typeof fetch;
  for (const status of [400, 401, 402, 429, 500, 503]) {
    test(`HTTP ${status} is not success and body is not echoed`, async () => {
      expect(await probeDeepSeek(null, "deepseek-flash", "fake",
        transport(() => new Response("fake-never-echo", { status })),
      )).toEqual({ ok: false, error: `HTTP ${status}` });
    });
  }
  test("malformed HTTP200 and transport exceptions never succeed", async () => {
    for (const body of ["not-json", "null", "{}", '{"choices":[]}']) {
      expect(await probeDeepSeek(null, "deepseek-flash", "fake",
        transport(() => new Response(body, { status: 200 })),
      )).toEqual({ ok: false, error: "DeepSeek probe failed." });
    }
    expect(await probeDeepSeek(null, "deepseek-flash", "fake",
      transport(() => { throw new Error("fake-never-echo"); }),
    )).toEqual({ ok: false, error: "DeepSeek probe failed." });
  });
  test("valid completion succeeds and foreign endpoint is refused", async () => {
    expect(await probeDeepSeek(null, "deepseek-flash", "fake",
      transport(() => Response.json({
        id: "fake", object: "chat.completion", model: "deepseek-flash",
        choices: [{ message: { role: "assistant", content: "" } }],
      })),
    )).toEqual({ ok: true });
    expect(await probeDeepSeek("https://example.invalid", "deepseek-flash", "fake",
      transport(() => { throw new Error("must not call"); }),
    )).toEqual({ ok: false, error: "DeepSeek configuration unavailable." });
  });
});
