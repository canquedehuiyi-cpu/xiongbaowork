import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import { providerFailureAsRunError } from "../src/provider-error";

/**
 * A provider's refusal has to arrive as a sentence, not as a disconnected stream (audit N3).
 *
 * Only HTTP 401 had a branch (`desktop-connection-failure.ts`), so a 400 "you passed a model name this
 * endpoint does not have", a 402 "the account has no balance" and a 429 "slow down" all left the run
 * by way of an errored observable. The person saw "network error", the card recorded a failure with no
 * reason in it, and the one party who actually said what was wrong — the provider, in its own body —
 * was never shown. That is the difference between a deployment you can fix and one you cannot.
 *
 * These are driven by an observable that fails the way `AI_APICallError` does, because the whole subject
 * is what happens AFTER the refusal: the shape of the event, and the fact that the stream then closes
 * normally so the run is finished rather than abandoned.
 */
function failing(error: unknown) {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
    } as unknown as BaseEvent);
    subscriber.error(error);
  });
}

/** Everything the subscriber received, and how it ended. */
async function drain(
  stream: ReturnType<typeof providerFailureAsRunError>,
): Promise<{ events: BaseEvent[]; errored: unknown }> {
  const events: BaseEvent[] = [];
  let errored: unknown;
  await new Promise<void>((resolve) => {
    stream.subscribe({
      next: (event) => events.push(event),
      error: (error) => {
        errored = error;
        resolve();
      },
      complete: () => resolve(),
    });
  });
  return { events, errored };
}

function apiCallError(statusCode: number, responseBody: string) {
  // `AI_APICallError` from the AI SDK: the name is what identifies it, the two fields are what the
  // person needs. Constructed rather than imported so the case does not depend on a live provider.
  const error = new Error(`AI SDK api call failed (${statusCode})`);
  error.name = "AI_APICallError";
  Object.assign(error, {
    statusCode,
    responseBody,
    url: "https://example.test/v1",
  });
  return error;
}

describe("a provider's refusal becomes a readable RUN_ERROR", () => {
  test("a 400 names the status and quotes the provider", async () => {
    const { events, errored } = await drain(
      providerFailureAsRunError(
        failing(
          apiCallError(
            400,
            '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed gpt-5.6-terra"}}',
          ),
        ),
      ),
    );

    // Ended, not dropped: the subscriber must see a closing event, not a broken pipe.
    expect(errored).toBeUndefined();
    const refusal = events[events.length - 1] as unknown as {
      type: string;
      message: string;
      code: string;
    };
    expect(refusal.type).toBe(EventType.RUN_ERROR);
    expect(refusal.code).toBe("OPENBOT_PROVIDER_REQUEST_REFUSED");
    // Chinese, because this sentence is shown to a person using this product in Chinese.
    expect(refusal.message).toContain("HTTP 400");
    expect(refusal.message).toContain("gpt-5.6-terra");
  });

  test("a 402 says the account is out of balance, and a 429 says it was rate limited", async () => {
    const billing = await drain(
      providerFailureAsRunError(
        failing(apiCallError(402, '{"error":"insufficient balance"}')),
      ),
    );
    expect(billing.errored).toBeUndefined();
    expect(
      (billing.events[billing.events.length - 1] as { message: string })
        .message,
    ).toContain("余额");

    const limited = await drain(
      providerFailureAsRunError(
        failing(apiCallError(429, "Too Many Requests")),
      ),
    );
    expect(
      (limited.events[limited.events.length - 1] as { message: string })
        .message,
    ).toContain("限流");
  });

  test("a long body is cut short, and a key echoed back by a provider is not carried along", async () => {
    const long = "x".repeat(4_000);
    const { events } = await drain(
      providerFailureAsRunError(
        failing(
          apiCallError(
            400,
            `Bearer sk-abcdefghijklmnopqrstuvwx rejected. ${long}`,
          ),
        ),
      ),
    );
    const message = (events[events.length - 1] as { message: string }).message;
    // The card carries this into the board, and the transcript into a person's window — neither wants
    // a four-kilobyte blob, and least of all one that might contain the deployment's own credential.
    expect(Array.from(message).length).toBeLessThanOrEqual(600);
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  test("an unrecognised failure still goes up as a failure", async () => {
    const thrown = new TypeError(
      "Unable to connect. Is the computer able to access the url?",
    );
    const { errored } = await drain(providerFailureAsRunError(failing(thrown)));
    // Not folded into a provider refusal we did not see: a connection failure has its own branch, and
    // inventing a provider sentence here would point the person at a setting that is not the problem.
    expect(errored).toBe(thrown);
  });

  test("a 401 keeps the authentication path it already had", async () => {
    const unauthorized = apiCallError(401, '{"error":"invalid api key"}');
    const { errored } = await drain(
      providerFailureAsRunError(failing(unauthorized)),
    );
    // The existing branch (recordDesktopConnectionFailure) answers 401, and this one must not steal it:
    // the native host reads that signal and opens the model settings for the person.
    expect(errored).toBe(unauthorized);
  });

  test("a refusal carried by the cause chain is read as the same refusal", async () => {
    // `BuiltInAgent` wraps the SDK error before rethrowing, so the status usually arrives one deep.
    const inner = apiCallError(400, '{"error":{"message":"model not found"}}');
    const wrapper = new Error("agent run failed");
    Object.assign(wrapper, { cause: inner });
    const { events } = await drain(providerFailureAsRunError(failing(wrapper)));
    const refusal = events[events.length - 1] as {
      message: string;
      code: string;
    };
    expect(refusal.code).toBe("OPENBOT_PROVIDER_REQUEST_REFUSED");
    expect(refusal.message).toContain("model not found");
  });
});
