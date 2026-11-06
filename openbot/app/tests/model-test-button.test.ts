import { afterEach, expect, test } from "bun:test";
import { testModelMutationOptions } from "../src/lib/models/mutations";

/**
 * The 「测试」 button on a connected model.
 *
 * The server serves the probe at `POST /api/models/:id/test` (server/src/models/routes.ts) and nothing
 * else. The button used to send a GET, which no route answers, so every press read "The connectivity
 * test could not be run." whatever the key and model were -- found on the first real deployment,
 * 2026-11-06, with a working DeepSeek key.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the connectivity test is sent as a POST to the model's own test route", async () => {
  const seen: { url: string; method: string | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const options = testModelMutationOptions();
  const answer = await options.mutationFn?.("m-1", {} as never);

  expect(seen).toEqual([{ url: "/api/models/m-1/test", method: "POST" }]);
  expect(answer).toEqual({ ok: true, error: undefined });
});

test("a provider refusal reported by the probe reaches the screen as the probe's own words", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: "HTTP 401" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const answer = await testModelMutationOptions().mutationFn?.(
    "m-1",
    {} as never,
  );

  expect(answer).toEqual({ ok: false, error: "HTTP 401" });
});
