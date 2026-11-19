import { afterEach, expect, mock, test } from "bun:test";
import { RequestError } from "../src/lib/client";
import { taskAction } from "../src/lib/tasks/actions";

// Run this focused file with --no-env-file and an allowlisted process env.
// The existing app/server preloads stay intact. No SDK or provider is imported.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const verb of ["review", "archive"] as const) {
  test(`${verb}: 200 preserves Response and posts once with session credentials`, async () => {
    const response = Response.json({ ok: true });
    const fetch = mock(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        _init?: RequestInit,
      ) => response,
    );
    globalThis.fetch = Object.assign(fetch, {
      preconnect: () => {
        throw new Error("Network preconnect forbidden in tasks-actions tests");
      },
    });
    expect(await taskAction({ id: "fixture-card", verb })).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`/api/tasks/fixture-card/${verb}`, {
      method: "POST",
      credentials: "include",
      headers: undefined,
      body: undefined,
    });
  });

  for (const status of [401, 403, 404, 409, 500]) {
    test(`${verb}: ${status} rejects with original RequestError status/message, without retry`, async () => {
      const fetch = mock(
        async (
          _input: Parameters<typeof globalThis.fetch>[0],
          _init?: RequestInit,
        ) => Response.json({ error: "fixture refusal" }, { status }),
      );
      globalThis.fetch = Object.assign(fetch, {
        preconnect: () => {
          throw new Error(
            "Network preconnect forbidden in tasks-actions tests",
          );
        },
      });
      const error = await taskAction({ id: "fixture-card", verb }).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(RequestError);
      expect(error.status).toBe(status);
      expect(error.message).toBe("fixture refusal");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  test(`${verb}: non-JSON 500 uses safe Chinese fallback, without response-body leakage`, async () => {
    const fetch = mock(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        _init?: RequestInit,
      ) =>
        new Response("<html>fixture internal detail</html>", { status: 500 }),
    );
    globalThis.fetch = Object.assign(fetch, {
      preconnect: () => {
        throw new Error("Network preconnect forbidden in tasks-actions tests");
      },
    });
    const error = await taskAction({ id: "fixture-card", verb }).catch(
      (error) => error,
    );
    expect(error).toBeInstanceOf(RequestError);
    expect(error.status).toBe(500);
    expect(error.message).toBe(
      verb === "review" ? "查收失败，请稍后重试。" : "归档失败，请稍后重试。",
    );
    expect(error.message).not.toContain("internal detail");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test(`${verb}: transport rejection preserves unknown outcome and never replays`, async () => {
    const failure = new TypeError("fixture connection lost");
    const fetch = mock(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        _init?: RequestInit,
      ) => {
        throw failure;
      },
    );
    globalThis.fetch = Object.assign(fetch, {
      preconnect: () => {
        throw new Error("Network preconnect forbidden in tasks-actions tests");
      },
    });
    const error = await taskAction({ id: "fixture-card", verb }).catch(
      (error) => error,
    );
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(RequestError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

test("task id remains one URL path segment", async () => {
  const fetch = mock(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: RequestInit,
    ) => Response.json({ ok: true }),
  );
  globalThis.fetch = Object.assign(fetch, {
    preconnect: () => {
      throw new Error("Network preconnect forbidden in tasks-actions tests");
    },
  });
  await taskAction({ id: "fixture/other?x=1", verb: "review" });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "/api/tasks/fixture%2Fother%3Fx%3D1/review",
  );
});
