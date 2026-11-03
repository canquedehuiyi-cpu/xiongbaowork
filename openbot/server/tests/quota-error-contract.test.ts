import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventSchemas, EventType } from "@ag-ui/client";
import { concat, type Observable, of, throwError } from "rxjs";
import {
  QUOTA_RUN_ERROR_CODE,
  QuotaExceeded,
  type QuotaMetric,
  quotaRunError,
  withQuotaRunErrors,
} from "../src/quota/limits";

// Serialization contract only: no quota service, database or provider is started.
const metrics: readonly { metric: QuotaMetric; words: string }[] = [
  { metric: "wakers", words: "coworkers" },
  { metric: "tasksPerMonth", words: "tasks per month" },
  { metric: "devices", words: "machines" },
  { metric: "customModels", words: "models of your own" },
];

for (const { metric, words } of metrics) {
  test(`serialized ${metric} refusal preserves its arithmetic and adds the plans route`, async () => {
    const refusal = new QuotaExceeded(metric, 2, 2, "Team");
    const response = new Response(JSON.stringify(refusal.body), {
      status: 402, headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      error: `The Team plan allows 2 ${words}; this workspace is using 2.`,
      code: "quota_exceeded", metric, used: 2, limit: 2, plan: "Team",
      upgradeUrl: "/plans",
    });
    expect(refusal.name).toBe("QuotaExceeded");
    expect(refusal.message).toBe(`The Team plan allows 2 ${words}; this workspace is using 2.`);
    expect(refusal.metric).toBe(metric);
    expect(refusal.used).toBe(2);
    expect(refusal.limit).toBe(2);
    expect(refusal.plan).toBe("Team");
  });
}

test("a zero custom-model allowance survives JSON without replacement values", () => {
  const refusal = new QuotaExceeded("customModels", 0, 0, "Free");
  expect(JSON.parse(JSON.stringify(refusal.body))).toEqual({
    error: "The Free plan allows 0 models of your own; this workspace is using 0.",
    code: "quota_exceeded", metric: "customModels", used: 0, limit: 0,
    plan: "Free", upgradeUrl: "/plans",
  });
});

test("navigation is fixed independently of the unchanged plan label", () => {
  const plan = "https://untrusted.invalid/upgrade?next=elsewhere";
  const refusal = new QuotaExceeded("devices", 7, 3, plan);
  const body = JSON.parse(JSON.stringify(refusal.body));
  expect(body.plan).toBe(plan);
  expect(body.error).toBe(`The ${plan} plan allows 3 machines; this workspace is using 7.`);
  expect(body.upgradeUrl).toBe("/plans");
  expect(Object.keys(body).sort()).toEqual([
    "code", "error", "limit", "metric", "plan", "upgradeUrl", "used",
  ]);
});

/*
 * Story K4 on a chat turn: the runtime answers a turn with an event stream, and a runner that fails
 * that stream is logged and closed with no event at all. The refusal has to be ON the stream, as the
 * RUN_ERROR every chat surface reads, with a stable code and the same body the JSON routes send.
 */
describe("a chat turn refused for quota says so on its stream", () => {
  const turn = { threadId: "t", runId: "r" } as never;
  const refusal = new QuotaExceeded("tasksPerMonth", 50, 50, "Free");

  async function drained(stream: Observable<BaseEvent>) {
    const events: BaseEvent[] = [];
    let failure: unknown;
    await new Promise<void>((resolve) =>
      stream.subscribe({
        next: (event) => events.push(event),
        error: (error) => {
          failure = error;
          resolve();
        },
        complete: resolve,
      }),
    );
    return { events, failure };
  }

  test("one RUN_ERROR with the stable code and the 402 body, then a normal close", async () => {
    const runner = {
      run: () => throwError(() => refusal),
      hydrate: async () => "hydrated",
    };
    const wrapped = withQuotaRunErrors(runner);
    const { events, failure } = await drained(wrapped.run(turn));
    expect(failure).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(QUOTA_RUN_ERROR_CODE).toBe("quota_exceeded");
    expect(events[0]).toEqual({
      type: EventType.RUN_ERROR,
      message: refusal.message,
      code: "quota_exceeded",
      rawEvent: refusal.body,
    } as BaseEvent);
    // The runner's other methods are its own.
    expect(await wrapped.hydrate()).toBe("hydrated");
  });

  test("the event survives the wire: JSON and the protocol's own schema keep the code and the body", () => {
    const parsed = EventSchemas.parse(
      JSON.parse(JSON.stringify(quotaRunError(refusal))),
    ) as { code?: string; rawEvent?: unknown; message: string };
    expect(parsed.code).toBe("quota_exceeded");
    expect(parsed.rawEvent).toEqual({
      error: refusal.message,
      code: "quota_exceeded",
      metric: "tasksPerMonth",
      used: 50,
      limit: 50,
      plan: "Free",
      upgradeUrl: "/plans",
    });
  });

  test("a refusal after the turn started is said after what was already sent", async () => {
    const started = {
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
    } as BaseEvent;
    const runner = {
      run: () => concat(of(started), throwError(() => refusal)),
    };
    const { events, failure } = await drained(
      withQuotaRunErrors(runner).run(turn),
    );
    expect(failure).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
  });

  test("any other failure still fails the stream, untouched", async () => {
    const broken = new Error("database gone");
    const { events, failure } = await drained(
      withQuotaRunErrors({ run: () => throwError(() => broken) }).run(turn),
    );
    expect(events).toEqual([]);
    expect(failure).toBe(broken);
  });
});
