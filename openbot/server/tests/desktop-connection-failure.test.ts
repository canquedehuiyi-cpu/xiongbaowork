import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventType } from "@ag-ui/client";
import { Hono } from "hono";
import { firstValueFrom, of, throwError } from "rxjs";
import {
  clearDesktopConnectionFailure,
  isModelAuthenticationError,
  mountDesktopConnectionFailure,
  observeModelConnection,
  recordDesktopConnectionFailure,
} from "../src/desktop-connection-failure";

function clearFailures() {
  for (const connection of ["model", "intelligence", "organization"] as const)
    clearDesktopConnectionFailure(connection);
}
beforeEach(clearFailures);
afterEach(clearFailures);

function endpoint() {
  const app = new Hono();
  mountDesktopConnectionFailure(app, "native-session-token");
  return {
    app,
    read: () =>
      app.request("/api/desktop/connection-failure", {
        headers: { "x-openbot-desktop-host-token": "native-session-token" },
      }),
  };
}

test("only the native session token can read typed failures; reads retain no error details", async () => {
  const { app, read } = endpoint();
  recordDesktopConnectionFailure({
    connection: "model",
    code: "provider_authentication_failed",
  });
  expect((await app.request("/api/desktop/connection-failure")).status).toBe(
    401,
  );
  const response = await read();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    connection: "model",
    code: "provider_authentication_failed",
  });
});

test("typed provider failures trigger refresh and successful model output clears only model failure", async () => {
  const { read } = endpoint();
  await firstValueFrom(
    observeModelConnection(
      of({
        type: EventType.RUN_ERROR,
        code: "OPENBOT_MODEL_AUTH_REQUIRED",
        message: "provider authentication failed",
      }),
    ),
  );
  recordDesktopConnectionFailure({
    connection: "intelligence",
    code: "intelligence_authentication_failed",
  });
  expect(await (await read()).json()).toMatchObject({ connection: "model" });
  await firstValueFrom(
    observeModelConnection(
      of({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "result",
        delta: "Authenticated model reply",
      }),
    ),
  );
  expect(await (await read()).json()).toMatchObject({
    connection: "intelligence",
  });
});

function providerError(statusCode: number, cause?: Error) {
  return Object.assign(
    new Error("provider detail must not enter native status", { cause }),
    {
      name: "AI_APICallError",
      statusCode,
    },
  );
}

function explicitAuthenticationError() {
  return Object.assign(new Error("provider authentication failed"), {
    name: "OpenBotModelAuthenticationError",
  });
}

test("HTTP status and error prose from unrelated services are not model authentication", () => {
  expect(
    isModelAuthenticationError(
      Object.assign(new Error("401 model unauthorized"), { statusCode: 401 }),
    ),
  ).toBe(false);
  for (const statusCode of [400, 403, 404, 429, 500]) {
    const error = providerError(statusCode);
    expect(isModelAuthenticationError(error)).toBe(false);
    expect(
      isModelAuthenticationError(
        new Error("wrapped provider issue", { cause: error }),
      ),
    ).toBe(false);
  }
});

test("provider 401 and explicit authentication markers survive SDK wrapping", () => {
  for (const error of [providerError(401), explicitAuthenticationError()]) {
    expect(isModelAuthenticationError(error)).toBe(true);
    expect(
      isModelAuthenticationError(
        new Error("wrapped provider issue", { cause: error }),
      ),
    ).toBe(true);
  }
  expect(
    isModelAuthenticationError(
      providerError(403, explicitAuthenticationError()),
    ),
  ).toBe(true);
});

test.each([
  ["provider 403 permission denial", providerError(403), false, true],
  [
    "wrapped provider 403 permission denial",
    new Error("wrapped provider issue", { cause: providerError(403) }),
    false,
    true,
  ],
  ["provider 401 invalid credentials", providerError(401), true, false],
  [
    "explicit authentication failure",
    explicitAuthenticationError(),
    true,
    false,
  ],
] as const)(
  /*
   * Two properties, and the third column is which one a row is about.
   *
   * `false` in the last column: the failure is left as the stream's own error, because the desktop host
   * reads the signal raised on the way and opens the credential screen — that is the right answer for a
   * key that does not work and the wrong one for a model the account may not use, which is why a 403 was
   * never routed through it (and this table is what keeps it that way).
   *
   * `true` in the last column: the refusal is a thing the provider SAID, and saying it is the product's
   * job now — `provider-error.ts` turns it into a `RUN_ERROR` carrying the status and the provider's own
   * sentence, and the stream closes normally instead of leaving "network error" on the screen. What is
   * still asserted for those rows is the half that was always the point: no authentication is inferred.
   */
  "model observation preserves %s without guessing authentication",
  async (_label, error, requiresAuthentication, translatedAsRefusal) => {
    const { read } = endpoint();
    const observed = firstValueFrom(
      observeModelConnection(throwError(() => error)),
    );
    if (translatedAsRefusal) {
      const event = (await observed) as unknown as {
        type: string;
        message: string;
      };
      expect(event.type).toBe("RUN_ERROR");
      expect(event.message).toContain("无权使用该模型");
    } else {
      await expect(observed).rejects.toBe(error);
    }
    expect(await (await read()).json()).toEqual(
      requiresAuthentication
        ? {
            connection: "model",
            code: "provider_authentication_failed",
          }
        : null,
    );
  },
);
