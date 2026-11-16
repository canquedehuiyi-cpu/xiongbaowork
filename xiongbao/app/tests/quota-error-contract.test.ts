import { afterEach, expect, test } from "bun:test";
import {
  client, tryClient, RequestError,
  type ClientOptions, type QuotaErrorDetails,
} from "../src/lib/client";

const path = "/api/quota-contract-fixture";
const originalFetch = globalThis.fetch;
afterEach(() => {
  const restored = globalThis.fetch;
  globalThis.fetch = originalFetch;
  expect(restored).toBe(originalFetch);
});

// A dedicated in-memory Response boundary. Never forward to a server or provider.
async function withFetch<T>(response: Response | Error,
  work: (calls: RequestInit[]) => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]) => {
    expect(input).toBe(path);
    calls.push(init ?? {});
    if (response instanceof Error) throw response;
    return response;
  }, { preconnect: previous.preconnect });
  try { return await work(calls); }
  finally { globalThis.fetch = previous; }
}

const valid = {
  error: "This workspace has reached its allowance.",
  code: "quota_exceeded", metric: "wakers", used: 2, limit: 2,
  plan: "Team", upgradeUrl: "/plans",
};
function json(body: unknown, status = 402): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}
async function refusal(options: ClientOptions = {}): Promise<RequestError> {
  try { await client(path, options); }
  catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    if (!(error instanceof RequestError)) throw error;
    return error;
  }
  throw new Error("Expected a client refusal, not success");
}

for (const metric of ["wakers", "tasksPerMonth", "devices", "customModels"] as const) {
  test(`actual client preserves zero-valued 402 ${metric} details`, async () => {
    await withFetch(json({ ...valid, metric, used: 0, limit: 0, debug: "not public" }), async () => {
      const error = await refusal({ fallback: "Fallback must not replace the server message" });
      expect(error.message).toBe(valid.error);
      expect(error.status).toBe(402);
      const details: QuotaErrorDetails | undefined = error.quota;
      expect(details).toEqual({ code: "quota_exceeded", metric, used: 0,
        limit: 0, plan: "Team", upgradeUrl: "/plans" });
      expect(Object.isFrozen(details)).toBe(true);
      expect(Reflect.has(error, "debug")).toBe(false);
      expect(Reflect.has(details!, "debug")).toBe(false);
    });
  });
}

test("nonzero values and a meaningful plan label remain exact", async () => {
  await withFetch(json({ ...valid, plan: "  Team  " }), async () => {
    const error = await refusal();
    expect(error.quota).toEqual({ code: "quota_exceeded", metric: "wakers",
      used: 2, limit: 2, plan: "  Team  ", upgradeUrl: "/plans" });
  });
});

test("invalid or missing quota fields omit details without losing message or status", async () => {
  const bad: Record<string, unknown>[] = [
    { code: "other" }, { code: null }, { metric: "tasks" }, { metric: 0 },
    { used: -1 }, { used: "0" }, { used: null }, { used: true }, { used: {} },
    { limit: -1 }, { limit: "0" }, { limit: null }, { limit: false },
    { plan: "" }, { plan: "  \n " }, { plan: null }, { plan: 7 },
  ];
  for (const patch of bad) await withFetch(json({ ...valid, ...patch }), async () => {
    const error = await refusal({ fallback: "Fallback" });
    expect(error.message).toBe(valid.error);
    expect(error.status).toBe(402);
    expect(error.quota).toBeUndefined();
  });
  for (const missing of ["code", "metric", "used", "limit", "plan", "upgradeUrl"]) {
    const body: Record<string, unknown> = { ...valid };
    delete body[missing];
    await withFetch(json(body), async () => {
      const error = await refusal();
      expect(error.message).toBe(valid.error);
      expect(error.status).toBe(402);
      expect(error.quota).toBeUndefined();
    });
  }
});

test("only the exact plans route is exposed as quota navigation", async () => {
  for (const upgradeUrl of [
    "https://untrusted.invalid/plans", "http://untrusted.invalid", "//untrusted.invalid/plans",
    "javascript:alert(1)", "data:text/html,upgrade", "/admin", "/plans/",
    "/plans?next=https://untrusted.invalid", "/plans#upgrade", " /plans",
    "/pl%61ns", "\\\\untrusted.invalid", "", null, 0,
  ]) await withFetch(json({ ...valid, upgradeUrl }), async () => {
    const error = await refusal();
    expect(error.message).toBe(valid.error);
    expect(error.status).toBe(402);
    expect(error.quota).toBeUndefined();
  });
});

test("nonfinite JSON numbers cannot become quota arithmetic", async () => {
  for (const field of ["used", "limit"]) {
    const raw = JSON.stringify(valid).replace(`"${field}":2`, `"${field}":1e400`);
    await withFetch(new Response(raw, { status: 402 }), async () => {
      const error = await refusal();
      expect(error.message).toBe(valid.error);
      expect(error.quota).toBeUndefined();
    });
  }
});

test("null, arrays, primitives, malformed JSON and non-string errors use the fallback safely", async () => {
  const bodies = [null, [], [valid], "failure", 7, false, {},
    { error: null }, { error: 7 }, { error: {} }, { error: ["failure"] }];
  for (const body of bodies) await withFetch(json(body), async () => {
    const error = await refusal({ fallback: "Could not update coworkers" });
    expect(error.message).toBe("Could not update coworkers");
    expect(error.status).toBe(402);
    expect(error.quota).toBeUndefined();
  });
  await withFetch(new Response("not JSON", { status: 502 }), async () => {
    const error = await refusal();
    expect(error.message).toBe("That request failed.");
    expect(error.status).toBe(502);
    expect(error.quota).toBeUndefined();
  });
});

test("non-quota refusals and empty string server messages retain their original meaning", async () => {
  await withFetch(json({ error: "Permission denied", code: "forbidden", extra: "private" }, 403), async () => {
    const error = await refusal();
    expect(error.message).toBe("Permission denied");
    expect(error.status).toBe(403);
    expect(error.quota).toBeUndefined();
    expect(Reflect.has(error, "extra")).toBe(false);
  });
  await withFetch(json({ error: "" }, 409), async () => {
    const error = await refusal({ fallback: "Must not replace a string" });
    expect(error.message).toBe("");
    expect(error.status).toBe(409);
  });
});

test("the existing two-argument RequestError constructor remains usable", () => {
  const error = new RequestError("Old caller", 409);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("Old caller");
  expect(error.status).toBe(409);
  expect(error.quota).toBeUndefined();
});

test("success still unwraps its key and forwards credentials, body and signal", async () => {
  const controller = new AbortController();
  await withFetch(json({ item: { id: "saved" }, code: "quota_exceeded" }, 200), async calls => {
    expect(await client<{ id: string }>(path, "item", {
      method: "POST", body: { title: "Saved" }, signal: controller.signal,
    })).toEqual({ id: "saved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: '{"title":"Saved"}',
      signal: controller.signal });
  });
});

test("unkeyed success and 204 return the untouched Response without JSON parsing", async () => {
  for (const response of [new Response("plain success"), new Response(null, { status: 204 })]) {
    let parses = 0;
    response.json = async () => { parses++; throw new Error("JSON must not be read"); };
    await withFetch(response, async calls => {
      expect(await client(path)).toBe(response);
      expect(response.bodyUsed).toBe(false);
      expect(parses).toBe(0);
      expect(calls[0]?.credentials).toBe("include");
    });
  }
});

test("tryClient keeps 402 and 204 as untouched Responses", async () => {
  for (const response of [json(valid), new Response(null, { status: 204 })]) {
    let parses = 0;
    response.json = async () => { parses++; throw new Error("tryClient must not parse"); };
    await withFetch(response, async () => {
      expect(await tryClient(path)).toBe(response);
      expect(response.status).toBe(response.ok ? 204 : 402);
      expect(response.bodyUsed).toBe(false);
      expect(parses).toBe(0);
    });
  }
});

test("malformed keyed success retains its existing fallback failure", async () => {
  for (const response of [json(null, 200), json([], 200), new Response(null, { status: 204 })])
    await withFetch(response, async () => {
      await expect(client(path, "item", { fallback: "Missing response" })).rejects.toThrow("Missing response");
    });
});

test("transport failures propagate unchanged and fetch is restored on failure", async () => {
  const failure = new Error("Fixture offline");
  await withFetch(failure, async () => {
    await expect(client(path)).rejects.toBe(failure);
    await expect(tryClient(path)).rejects.toBe(failure);
  });
  expect(globalThis.fetch).toBe(originalFetch);
  await expect(withFetch(new Response(), async () => { throw failure; })).rejects.toBe(failure);
  expect(globalThis.fetch).toBe(originalFetch);
});
