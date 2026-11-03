import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { probe } from "../src/models/routes";
import { languageModelFor } from "../src/models/runtime-resolver";

/**
 * Audit defect #6, at the two places a tenant's model key is sent: the library's probe and every run.
 *
 * Nothing here touches the network or a database. The resolver and the network are stand-ins that
 * record every request they were handed, which is how "nothing was sent" is asserted rather than
 * assumed.
 */

function recordingFetch(answer: (url: string) => Response) {
  const calls: { url: string; headers: Headers; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, headers: new Headers(init?.headers), init });
    return answer(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const lookup = async (hostname: string) =>
  hostname === "inside.example.test"
    ? [{ address: "10.0.0.5", family: 4 }]
    : hostname === "loop.example.test"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }];

describe("the probe", () => {
  test("google's key travels in a header, never in the URL", async () => {
    const network = recordingFetch(() => new Response("{}", { status: 200 }));
    const answer = await probe("google", null, "gemini-9", "AIza-secret-key", {
      lookup,
      fetchImpl: network.impl,
    });
    expect(answer.ok).toBeTrue();
    expect(network.calls).toHaveLength(1);
    const [call] = network.calls;
    expect(call?.url).not.toContain("key=");
    expect(call?.url).not.toContain("AIza-secret-key");
    expect(call?.headers.get("x-goog-api-key")).toBe("AIza-secret-key");
    expect(call?.init?.redirect).toBe("manual");
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("anthropic is not followed through a redirect", async () => {
    const network = recordingFetch(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/" },
        }),
    );
    const answer = await probe("anthropic", null, "claude-x", "sk-ant-secret", {
      lookup,
      fetchImpl: network.impl,
    });
    expect(answer.ok).toBeFalse();
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(network.calls[0]?.init?.redirect).toBe("manual");
  });

  for (const baseUrl of [
    "http://169.254.169.254/latest",
    "https://10.0.0.5/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[fe80::1]/v1",
    "https://inside.example.test/v1",
    "https://loop.example.test/v1",
    "http://api.example.test/v1",
  ]) {
    test(`a custom base URL at ${baseUrl} is refused and nothing is sent`, async () => {
      const network = recordingFetch(() => new Response("{}"));
      const answer = await probe("custom", baseUrl, "m", "sk-custom-secret", {
        lookup,
        fetchImpl: network.impl,
      });
      expect(answer.ok).toBeFalse();
      expect(answer.refused).toBeTrue();
      expect(answer.error ?? "").not.toContain("sk-custom-secret");
      expect(network.calls).toHaveLength(0);
    });
  }

  test("a custom endpoint whose name does not resolve is unreachable, not refused", async () => {
    const network = recordingFetch(() => new Response("{}"));
    const answer = await probe(
      "custom",
      "https://gone.example.test/v1",
      "m",
      "sk-custom-secret",
      {
        lookup: async () => {
          throw new Error("EAI_AGAIN gone.example.test");
        },
        viaProxy: () => false,
        fetchImpl: network.impl,
      },
    );
    expect(answer.ok).toBeFalse();
    expect(answer.refused).toBeUndefined();
    expect(answer.error ?? "").toContain("could not be resolved");
    expect(network.calls).toHaveLength(0);
  });

  test("a resolver that never answers is bounded by the probe's deadline, and nothing is sent", async () => {
    const network = recordingFetch(() => new Response("{}"));
    const started = Date.now();
    const answer = await probe(
      "custom",
      "https://stalled.example.test/v1",
      "m",
      "sk-custom-secret",
      {
        // Never settles: the deadline has to cover resolution, not only the request after it.
        lookup: () => new Promise(() => undefined),
        viaProxy: () => false,
        fetchImpl: network.impl,
        timeoutMs: 50,
      },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer).toEqual({
      ok: false,
      error: "The provider did not answer in time.",
    });
    expect(network.calls).toHaveLength(0);
  });

  test("a custom endpoint that redirects is not followed, and the key goes no further", async () => {
    const network = recordingFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.5/steal" },
        }),
    );
    const answer = await probe(
      "custom",
      "https://api.example.test/v1",
      "m",
      "sk-custom-secret",
      { lookup, fetchImpl: network.impl },
    );
    expect(answer.ok).toBeFalse();
    expect(answer.refused).toBeUndefined();
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.url).toBe(
      "https://api.example.test/v1/chat/completions",
    );
    expect(network.calls.some((call) => call.url.includes("10.0.0.5"))).toBe(
      false,
    );
  });

  test("a public custom endpoint is probed with the key, once", async () => {
    const network = recordingFetch(() => new Response("{}", { status: 200 }));
    const answer = await probe(
      "custom",
      "https://api.example.test/v1/",
      "m",
      "sk-custom-secret",
      { lookup, fetchImpl: network.impl },
    );
    expect(answer).toEqual({ ok: true });
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.headers.get("authorization")).toBe(
      "Bearer sk-custom-secret",
    );
  });

  test("a local provider is allowed where the deployment opted into private hosts", async () => {
    const network = recordingFetch(() => new Response("{}", { status: 200 }));
    const answer = await probe(
      "custom",
      "http://127.0.0.1:11434/v1",
      "m",
      "sk-local",
      { lookup, fetchImpl: network.impl, allowPrivateHosts: true },
    );
    expect(answer.ok).toBeTrue();
    expect(network.calls).toHaveLength(1);
  });
});

describe("a run on a tenant's model", () => {
  test("an endpoint that resolves inside the deployment is never sent the key", async () => {
    const network = recordingFetch(() => new Response("{}"));
    const model = languageModelFor(
      "custom",
      "https://inside.example.test/v1",
      "m",
      "sk-run-secret",
      { lookup, fetchImpl: network.impl },
    );
    await expect(
      generateText({ model, prompt: "ping", maxRetries: 0 }),
    ).rejects.toBeDefined();
    expect(network.calls).toHaveLength(0);
  });

  test("a redirect from the endpoint is not followed", async () => {
    const network = recordingFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    );
    const model = languageModelFor(
      "openai",
      "https://api.example.test/v1",
      "m",
      "sk-run-secret",
      { lookup, fetchImpl: network.impl },
    );
    await expect(
      generateText({ model, prompt: "ping", maxRetries: 0 }),
    ).rejects.toBeDefined();
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.init?.redirect).toBe("manual");
  });
});
