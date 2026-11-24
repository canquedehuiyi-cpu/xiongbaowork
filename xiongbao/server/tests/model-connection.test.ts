import { expect, test } from "bun:test";
import { firstValueFrom, throwError } from "rxjs";
import {
  isModelAuthenticationError,
  observeModelConnection,
} from "../src/model-connection";

function providerError(statusCode: number, cause?: Error) {
  return Object.assign(new Error("provider detail", { cause }), {
    name: "AI_APICallError",
    statusCode,
  });
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
   * `false` in the last column: the failure is left as the stream's own error, for the caller's reader to
   * say as a key that does not work — the right answer for a dead key and the wrong one for a model the
   * account may not use, which is why a 403 is never treated as one (and this table keeps it that way).
   *
   * `true` in the last column: the refusal is a thing the provider SAID, and saying it is the product's
   * job — `provider-error.ts` turns it into a `RUN_ERROR` carrying the status and the provider's own
   * sentence, and the stream closes normally instead of leaving "network error" on the screen. The second
   * column is whether the error reads as authentication at all.
   */
  "model observation preserves %s without guessing authentication",
  async (_label, error, requiresAuthentication, translatedAsRefusal) => {
    expect(isModelAuthenticationError(error)).toBe(requiresAuthentication);
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
  },
);
