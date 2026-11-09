import { describe, expect, test } from "bun:test";
import { readRunAssertion } from "../src/agents/callback-token";
import { ThreadBusyError } from "../src/agents/handoff-delivery";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import { signHandoffDeliveryRun } from "../src/agents/handoff-signing";
import type { AuditStore } from "../src/audit";
import {
  assertPersonTenant,
  currentTenant,
  requireTenant,
  runAsClaimedTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import type { WorkItem, WorkQueue } from "../src/work/queue";

/**
 * Delivering a hop, and the three ways it must not go wrong.
 *
 * Running the other Bot twice for one hop. Finishing work that is no longer this replica's. And
 * letting a lease lapse in the middle of a run, which is the same as the first with extra steps.
 */

const KEY = "test-encryption-key-not-a-real-one";

const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  depth: 1,
  task: "find the outage window",
  expecting: "a date range",
};

function runner(options?: {
  claimed?: WorkItem[];
  deliver?: (input: {
    work: HandoffWork;
    message: string;
    shown?: string;
  }) => Promise<void>;
  /** What the delivery says the Bot answered. Null — nothing worth relaying — unless a test cares. */
  answer?: string | null;
  onSettled?: () => Promise<void>;
}) {
  const calls: Array<{ verb: string; key: string; owner?: string }> = [];
  const events: string[] = [];
  const written: Array<{
    eventType: string;
    payload: Record<string, unknown>;
  }> = [];
  const delivered: Array<{ message: string; assertion: string }> = [];
  const offered: HandoffWork[] = [];
  const delays: number[] = [];
  /** The tenant each outside effect ran as: the claimed row's, or nobody's. */
  const tenants = {
    deliver: [] as string[],
    audit: [] as string[],
    offer: [] as string[],
  };
  const released: { uncounted: boolean; payload?: Record<string, unknown> }[] =
    [];
  /** Each time the asking conversation was told the queue moved, with what the queue had seen by then. */
  const settled: Array<{ threadId: string; after: string[] }> = [];

  const queue = {
    claim: async () =>
      options?.claimed ?? [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:abc", payload: WORK, attempts: 1 },
      ],
    renew: async () => true,
    finish: async ({ key, owner }: { key: string; owner: string }) => {
      calls.push({ verb: "finish", key, owner });
      return true;
    },
    release: async ({
      key,
      owner,
      delayMs,
      uncounted,
      payload,
    }: {
      key: string;
      owner: string;
      delayMs: number;
      uncounted?: boolean;
      payload?: Record<string, unknown>;
    }) => {
      calls.push({ verb: "release", key, owner });
      delays.push(delayMs);
      released.push({ uncounted: uncounted === true, payload });
      return true;
    },
    offer: async ({
      key,
      payload,
    }: {
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      calls.push({ verb: "offer", key });
      tenants.offer.push(currentTenant());
      offered.push(payload as unknown as HandoffWork);
    },
  } as unknown as WorkQueue;

  const auditStore: AuditStore = {
    insert: async (event) => {
      tenants.audit.push(currentTenant());
      events.push(event.eventType);
      written.push({
        eventType: event.eventType,
        payload: (event.payload ?? {}) as Record<string, unknown>,
      });
    },
  };

  return {
    calls,
    events,
    written,
    delivered,
    offered,
    delays,
    tenants,
    released,
    settled,
    runner: createHandoffRunner({
      queue,
      owner: "replica-a",
      sign: (work, claim) =>
        signHandoffDeliveryRun(work, KEY, "delivery-run", claim),
      auditStore,
      onSettled: async (work) => {
        settled.push({
          threadId: work.threadId,
          after: calls.map((call) => call.verb),
        });
        await options?.onSettled?.();
      },
      delivery: {
        deliver: async ({ work, message, shown, assertion }) => {
          delivered.push({ message, assertion });
          tenants.deliver.push(currentTenant());
          await options?.deliver?.({ work, message, shown });
          return { answer: options?.answer ?? null };
        },
      },
    }),
  };
}

describe("delivering a hop", () => {
  test("runs the addressed Bot and finishes the work as its owner", async () => {
    const { runner: sweep, calls, delivered } = runner();

    const report = await sweep.sweep();

    expect(report.delivered).toEqual(["researcher"]);
    expect(calls).toEqual([
      { verb: "finish", key: "run-1:abc", owner: "replica-a" },
    ]);
    expect(delivered).toHaveLength(1);
  });

  /*
   * Who is asking is stamped by the deployment, from the row it wrote. A Bot able to write its own
   * attribution is a Bot able to claim to be another one.
   */
  test("the addressed Bot is told who asked, and what for, in parts", async () => {
    const { runner: sweep, delivered } = runner();

    await sweep.sweep();

    const message = delivered[0]?.message ?? "";
    expect(message).toContain("assistant");
    expect(message).toContain("Task: find the outage window");
    // The parts stay parts: the asking model was made to name them so this one need not infer them.
    expect(message).toContain("What a good answer looks like: a date range");
  });

  test("the run it starts carries the depth this hop reached", async () => {
    const { runner: sweep, delivered } = runner();

    await sweep.sweep();

    expect(readRunAssertion(delivered[0]?.assertion, KEY)).toMatchObject({
      botId: "researcher",
      depth: 1,
      handoff: { key: "run-1:abc", owner: "replica-a" },
    });
  });

  test("the delivery assertion preserves the run initiator across the queue", async () => {
    const { runner: sweep, delivered } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:abc",
          payload: {
            ...WORK,
            initiator: { kind: "routine", id: "routine_7" },
          },
          attempts: 1,
        },
      ],
    });

    await sweep.sweep();

    expect(readRunAssertion(delivered[0]?.assertion, KEY)).toMatchObject({
      botId: "researcher",
      actorId: "user-1",
      threadId: "thread-1",
      depth: 1,
      initiator: { kind: "routine", id: "routine_7" },
    });
  });

  test("a legacy queued hop without an initiator is still read as a person's", async () => {
    const { runner: sweep, delivered } = runner();

    await sweep.sweep();

    expect(readRunAssertion(delivered[0]?.assertion, KEY)?.initiator).toEqual({
      kind: "person",
    });
  });

  /*
   * A Bot that answered has answered, whatever it said. Retrying a delivery because the answer was
   * unhelpful would ask it the same question again and bill for the same non-answer.
   */
  test("a delivery that fails is released rather than finished", async () => {
    const {
      runner: sweep,
      calls,
      events,
    } = runner({
      deliver: async () => {
        throw new Error("the gateway was unreachable");
      },
    });

    const report = await sweep.sweep();

    expect(report.delivered).toEqual([]);
    expect(calls).toEqual([
      { verb: "release", key: "run-1:abc", owner: "replica-a" },
    ]);
    expect(events).toContain("agent.handoff_failed");
  });

  test("an answer that finds its conversation busy spends no attempt and backs off to a minute", async () => {
    const busy = async () => {
      throw new ThreadBusyError("thread-1 is busy with another run");
    };
    const first = runner({ deliver: busy });
    await first.runner.sweep();
    expect(first.delays).toEqual([5_000]);
    expect(first.released).toEqual([
      { uncounted: true, payload: { busyRetries: 1 } },
    ]);
    // Waiting is not failing.
    expect(first.events).not.toContain("agent.handoff_failed");

    const waits = [];
    for (const busyRetries of [1, 2, 3, 4, 9]) {
      const later = runner({
        claimed: [
          {
            kind: "bot.message",
            tenantId: "user-1",
            key: "run-1:abc",
            payload: { ...WORK, busyRetries },
            attempts: 1,
          },
        ] as unknown as WorkItem[],
        deliver: busy,
      });
      await later.runner.sweep();
      waits.push(...later.delays);
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);

    // A real failure still spends an attempt, a minute apart, and is recorded as one.
    const other = runner({
      deliver: async () => {
        throw new Error("the gateway was unreachable");
      },
    });
    await other.runner.sweep();
    expect(other.delays).toEqual([60_000]);
    expect(other.released).toEqual([{ uncounted: false }]);
    expect(other.events).toContain("agent.handoff_failed");
  });

  /*
   * A second attempt may already have run that Bot, spent a model call and posted an answer before
   * its owner died. Somebody reading two similar answers should be able to tell which happened.
   */
  test("a second attempt says so, before it runs anything", async () => {
    const { runner: sweep, events } = runner({
      claimed: [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:abc", payload: WORK, attempts: 2 },
      ],
    });

    await sweep.sweep();

    expect(events[0]).toBe("agent.handoff_retried");
    expect(events).toContain("agent.handoff_delivered");
  });

  /*
   * The Audit screen's Bot column reads `payload.bot` and renders a dash without it, so a delivery
   * that names the Bot only under `from` is a row saying a handoff happened and not who did it.
   * Its sibling `agent.handoff_offered` is asserted the same way in `agent-handoff.test.ts`.
   */
  test("a delivery names the Bot that handed the work over", async () => {
    const { runner: sweep, written } = runner();

    await sweep.sweep();

    const delivery = written.find(
      (event) => event.eventType === "agent.handoff_delivered",
    );
    expect(delivery?.payload).toMatchObject({
      bot: WORK.fromBotId,
      from: WORK.fromBotId,
      to: WORK.toBotId,
    });
  });

  /*
   * And so do the rows either side of it, which is the half the assertion above did not reach.
   *
   * A delivery is the outcome that is also visible in the transcript. A hop that was retried or
   * that failed is visible nowhere else at all, so those are the rows somebody actually comes to
   * this screen for — and they were the ones rendering a dash where the Bot's name belongs.
   */
  test("a hop that was retried or that failed names the Bot too", async () => {
    const retried = runner({
      claimed: [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:abc", payload: WORK, attempts: 2 },
      ],
    });
    await retried.runner.sweep();

    expect(
      retried.written.find(
        (event) => event.eventType === "agent.handoff_retried",
      )?.payload,
    ).toMatchObject({ bot: WORK.fromBotId, from: WORK.fromBotId });

    const failed = runner({
      deliver: async () => {
        throw new Error("the gateway was unreachable");
      },
    });
    await failed.runner.sweep();

    expect(
      failed.written.find((event) => event.eventType === "agent.handoff_failed")
        ?.payload,
    ).toMatchObject({ bot: WORK.fromBotId, from: WORK.fromBotId });
  });

  /* Releasing an unusable row would put it back on the queue for ever. */
  test("a row that is not a hop is finished rather than released", async () => {
    const { runner: sweep, calls } = runner({
      claimed: [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:junk", payload: {}, attempts: 1 },
      ],
    });

    const report = await sweep.sweep();

    expect(report.skipped).toEqual([
      { key: "run-1:junk", reason: "not a hop" },
    ]);
    expect(calls).toEqual([
      { verb: "finish", key: "run-1:junk", owner: "replica-a" },
    ]);
  });
});

/**
 * A hop that will not be tried again.
 *
 * The person was told their question had been handed on. If nothing ever comes back and nothing ever
 * says so, they cannot tell a slow Bot from a broken one, and the conversation simply stops.
 */
describe("a hop that failed for good", () => {
  test("the Bot that asked is sent back to tell the person", async () => {
    const { runner: sweeper, offered } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:abc",
          payload: { ...WORK, initiator: { kind: "routine", id: "routine_7" } },
          attempts: 5,
        },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("researcher did not finish within 300s");
      },
    });

    await sweeper.sweep();

    expect(offered).toHaveLength(1);
    // Back to the Bot that asked, in the conversation the person is watching.
    expect(offered[0]).toMatchObject({
      fromBotId: "researcher",
      toBotId: "assistant",
      answerIn: "thread-1",
      threadId: "thread-1",
      initiator: { kind: "routine", id: "routine_7" },
    });
    expect(offered[0]?.task).toContain("did not finish within 300s");
  });

  test("a hop the deployment's controls refuse ends on its first try, and the person is told", async () => {
    const {
      runner: sweeper,
      offered,
      calls,
    } = runner({
      deliver: async () => {
        const error = new Error("Use Bots is turned off for you.");
        error.name = "CapabilityRefusedError";
        throw error;
      },
    });

    await sweeper.sweep();

    // Retrying cannot change the answer, so the work ends now rather than five minutes from now.
    expect(calls.filter((call) => call.verb === "release")).toEqual([]);
    expect(calls).toContainEqual({
      verb: "finish",
      key: "run-1:abc",
      owner: "replica-a",
    });
    expect(offered).toHaveLength(1);
    expect(offered[0]?.task).toContain("Use Bots is turned off");
  });

  test("a hop to an address this deployment will not dial ends on its first try", async () => {
    const {
      runner: sweeper,
      offered,
      calls,
    } = runner({
      // As it arrives: the AG-UI client rebuilds the refusal from its RUN_ERROR, so only the
      // message survives.
      deliver: async () => {
        throw new Error(
          "This deployment will not dial http://localhost:4201/ag-ui: that address is inside OpenBot's own network, so an agent may not live there.",
        );
      },
    });

    await sweeper.sweep();

    expect(calls.filter((call) => call.verb === "release")).toEqual([]);
    expect(calls).toContainEqual({
      verb: "finish",
      key: "run-1:abc",
      owner: "replica-a",
    });
    expect(offered).toHaveLength(1);
    expect(offered[0]?.task).toContain("will not dial");
  });

  /*
   * The fan-out cap counts every row whose key starts with the run's own prefix. A notice is not one
   * of the Bots this run asked for, and a run long enough to see a hop fail for good is exactly the
   * run that still has asking to do.
   */
  test("its key is outside the run's own prefix, so it costs no fan-out budget", async () => {
    const {
      runner: sweeper,
      calls,
      offered,
    } = runner({
      claimed: [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:abc", payload: WORK, attempts: 5 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    const key = calls.find((call) => call.verb === "offer")?.key ?? "";
    expect(key.startsWith("run-1:")).toBe(false);
    expect(key).toContain("run-1:abc");
    expect(offered).toHaveLength(1);
  });

  /*
   * One run may legally ask the same Bot two different things. Keyed on the Bot alone both notices
   * are the same work to `offer`, the second is dropped on conflict, and nothing purges this kind —
   * so the person hears about one of their two lost questions, for good.
   */
  test("two lost questions to one Bot leave two notices", async () => {
    const { runner: sweeper, calls } = runner({
      claimed: [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:aaa", payload: WORK, attempts: 5 },
        { kind: "bot.message", tenantId: "user-1", key: "run-1:bbb", payload: WORK, attempts: 5 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    const keys = calls
      .filter((call) => call.verb === "offer")
      .map((call) => call.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  /*
   * Otherwise a Bot nobody can reach produces a notice that cannot be delivered either, which
   * produces a notice, for ever.
   */
  test("a notice that fails is not itself noticed", async () => {
    const { runner: sweeper, offered } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:notice:researcher",
          payload: { ...WORK, answerIn: "thread-1" },
          attempts: 5,
        },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    expect(offered).toEqual([]);
  });

  test("a hop with tries left is simply released", async () => {
    const {
      runner: sweeper,
      offered,
      calls,
    } = runner({
      claimed: [
        { kind: "bot.message", tenantId: "user-1", key: "run-1:abc", payload: WORK, attempts: 2 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("busy");
      },
    });

    await sweeper.sweep();

    expect(offered).toEqual([]);
    expect(calls.map((call) => call.verb)).toContain("release");
  });
});

/**
 * The answer coming home.
 *
 * The addressed Bot's turn runs in a scratch thread nobody is shown, so its words reach the person
 * one way: a backwards hop that runs the asking Bot, in the conversation being watched, with the
 * answer in its prompt. Attributed by the deployment, in the asking Bot's voice — the only voice
 * that thread admits.
 */
describe("relaying the answer home", () => {
  test("a delivered hop sends the answer back through the Bot that asked", async () => {
    const { runner: sweeper, offered } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:abc",
          payload: { ...WORK, initiator: { kind: "routine", id: "routine_7" } },
          attempts: 1,
        },
      ],
      answer: "The outage was Tuesday, 02:10 to 02:45.",
    });

    await sweeper.sweep();

    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({
      fromBotId: "researcher",
      toBotId: "assistant",
      answerIn: "thread-1",
      threadId: "thread-1",
      depth: 1,
      initiator: { kind: "routine", id: "routine_7" },
    });
    expect(offered[0]?.task).toContain("find the outage window");
    expect(offered[0]?.task).toContain(
      "The outage was Tuesday, 02:10 to 02:45.",
    );
  });

  test("its key is outside the run's own prefix, like the notice", async () => {
    const { runner: sweeper, calls } = runner({ answer: "Tuesday." });

    await sweeper.sweep();

    const key = calls.find((call) => call.verb === "offer")?.key ?? "";
    expect(key.startsWith("run-1:")).toBe(false);
    expect(key).toContain("run-1:abc");
  });

  /* A relay of a relay is a loop. The `answerIn` marker that stops a notice stops this too. */
  test("a relay is not itself relayed", async () => {
    const { runner: sweeper, offered } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "relay:run-1:abc",
          payload: { ...WORK, answerIn: "thread-1" },
          attempts: 1,
        },
      ] as unknown as WorkItem[],
      answer: "Understood, telling them now.",
    });

    await sweeper.sweep();

    expect(offered).toEqual([]);
  });

  test("a turn that said nothing sends nothing home", async () => {
    const { runner: sweeper, offered } = runner({ answer: null });

    await sweeper.sweep();

    expect(offered).toEqual([]);
  });

  /*
   * The answer rides inside the relaying run's prompt, and a Bot that came back with a book would
   * spend that run's whole context window repeating it.
   */
  test("an answer the length of a book is clipped, and says so", async () => {
    const { runner: sweeper, offered } = runner({
      answer: "x".repeat(20_000),
    });

    await sweeper.sweep();

    expect(offered[0]?.task).toContain("[…the answer was cut here for length]");
    expect((offered[0]?.task ?? "").length).toBeLessThan(14_000);
  });

  test("an answer cut inside a character loses the whole character, not half of it", async () => {
    // 12,000 code units are kept, and an emoji is two: its high half on the last kept unit would
    // reach the relaying run's prompt as a lone surrogate.
    const { runner: sweeper, offered } = runner({
      answer: `${"x".repeat(11_999)}😀tail`,
    });

    await sweeper.sweep();

    expect(offered[0]?.task).toContain(
      `${"x".repeat(11_999)}\n\n[…the answer was cut here for length]`,
    );
  });
});

/**
 * What a notice leaves in the transcript.
 *
 * Nothing. The asking Bot's own sentence is the whole message; the text that prompted it is an
 * instruction to a model, and kept it appears as something the person typed and had read back.
 */
describe("what a notice shows", () => {
  test("the instruction that produced it is not shown to anybody", async () => {
    const shownTexts: Array<string | undefined> = [];
    const { runner: sweeper } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:notice:researcher",
          payload: { ...WORK, answerIn: "thread-1" },
          attempts: 1,
        },
      ] as unknown as WorkItem[],
      deliver: async (input) => {
        shownTexts.push(input.shown);
      },
    });

    await sweeper.sweep();

    expect(shownTexts).toEqual([undefined]);
  });

  test("an ordinary hop shows who asked and what for", async () => {
    const shownTexts: Array<string | undefined> = [];
    const { runner: sweeper } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:abc",
          payload: { ...WORK, fromName: "Assistant", toName: "Researcher" },
          attempts: 1,
        },
      ] as unknown as WorkItem[],
      deliver: async (input) => {
        shownTexts.push(input.shown);
      },
    });

    await sweeper.sweep();

    expect(shownTexts[0]).toBe(
      "Assistant asked Researcher for this on your behalf: find the outage window",
    );
  });
});

/**
 * G01: a hop runs as the person whose row it is.
 *
 * The sweep is a timer: it has no tenant of its own, and the claim asks as `platform`. The only
 * trustworthy answer to "whose work is this" is the tenant stamped on the claimed row, so that is
 * the frame the delivery, the trail and every follow-on hop run in. A row stamped as nobody's —
 * `system`, `platform`, or nothing — has no person to act for, and is ended without running anybody.
 */
describe("whose hop it is", () => {
  test("the delivery, the trail and the relay all run as the row's tenant", async () => {
    const { runner: sweeper, tenants } = runner({
      answer: "Tuesday.",
    });

    await sweeper.sweep();

    expect(tenants.deliver).toEqual(["user-1"]);
    expect(tenants.offer).toEqual(["user-1"]);
    expect(tenants.audit.length).toBeGreaterThan(0);
    expect(new Set(tenants.audit)).toEqual(new Set(["user-1"]));
  });

  test("a hop that failed for good tells the person from inside their own tenant", async () => {
    const { runner: sweeper, tenants } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-1",
          key: "run-1:abc",
          payload: WORK,
          attempts: 5,
        },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    expect(tenants.offer).toEqual(["user-1"]);
    expect(new Set(tenants.audit)).toEqual(new Set(["user-1"]));
  });

  for (const stamped of ["system", "platform", "", undefined]) {
    test(`a hop stamped ${JSON.stringify(stamped)} is ended, not delivered`, async () => {
      const {
        runner: sweeper,
        calls,
        delivered,
        offered,
        events,
        tenants,
      } = runner({
        claimed: [
          {
            kind: "bot.message",
            tenantId: stamped,
            key: "run-1:abc",
            payload: WORK,
            attempts: 5,
          },
        ] as unknown as WorkItem[],
        answer: "should never be relayed",
      });

      const report = await sweeper.sweep();

      expect(delivered).toEqual([]);
      expect(offered).toEqual([]);
      // No trusted person to write the trail for, or to tell: one row, the platform's, says it
      // was dropped, so nobody is told and the drop is still on record.
      expect(events).toEqual(["agent.handoff_failed"]);
      expect(tenants.audit).toEqual(["platform"]);
      expect(calls).toEqual([
        { verb: "finish", key: "run-1:abc", owner: "replica-a" },
      ]);
      expect(report).toEqual({
        delivered: [],
        skipped: [{ key: "run-1:abc", reason: "tenant_unresolved" }],
      });
    });
  }

  test("a hop whose person is not the tenant on its row is ended, not delivered", async () => {
    const {
      runner: sweeper,
      delivered,
      offered,
      events,
      tenants,
    } = runner({
      claimed: [
        {
          kind: "bot.message",
          tenantId: "user-2",
          key: "run-1:abc",
          payload: WORK,
          attempts: 1,
        },
      ] as unknown as WorkItem[],
    });

    const report = await sweeper.sweep();

    expect(delivered).toEqual([]);
    expect(offered).toEqual([]);
    expect(events).toEqual(["agent.handoff_failed"]);
    expect(tenants.audit).toEqual(["platform"]);
    expect(report.skipped).toEqual([
      { key: "run-1:abc", reason: "tenant_unresolved" },
    ]);
  });
});

describe("the tenant guard", () => {
  test("asking for the tenant outside any frame is an error, not `system`", () => {
    expect(() => requireTenant()).toThrow(TenantContextError);
    expect(runAsTenant("user-1", () => requireTenant())).toBe("user-1");
  });

  test("work already running for one person cannot resolve into another", () => {
    expect(() =>
      runAsTenant("user-2", () => assertPersonTenant("user-1")),
    ).toThrow(TenantContextError);
    expect(runAsTenant("user-1", () => assertPersonTenant("user-1"))).toBe(
      "user-1",
    );
    // A worker's own frame is nobody's, so it may hand work to whoever the row names.
    expect(runAsTenant("platform", () => assertPersonTenant("user-1"))).toBe(
      "user-1",
    );
    expect(assertPersonTenant("user-1", "user-1")).toBe("user-1");
    expect(() => assertPersonTenant("user-1", "user-2")).toThrow(
      TenantContextError,
    );
    for (const nobody of ["system", "platform", "", undefined, null, 7])
      expect(() => assertPersonTenant(nobody)).toThrow(TenantContextError);
  });

  /*
   * The approval.resume and person.response loops (G01-B) go through this: a row stamped A runs as
   * A, and everything else is handed back without running.
   */
  test("a claimed item runs as the tenant stamped on its row, and nothing else runs", async () => {
    const ran: Array<{ tenant: string; frame: string }> = [];
    const work = async (tenant: string) => {
      await Promise.resolve();
      ran.push({ tenant, frame: currentTenant() });
      return "done";
    };
    expect(
      await runAsTenant("platform", () =>
        runAsClaimedTenant({ tenantId: "tenant-a" }, "tenant-a", work),
      ),
    ).toEqual({ ran: true, value: "done" });
    expect(ran).toEqual([{ tenant: "tenant-a", frame: "tenant-a" }]);

    const refused = [
      // The payload names somebody else: B never runs A's row, nor A B's.
      runAsClaimedTenant({ tenantId: "tenant-a" }, "tenant-b", work),
      runAsClaimedTenant({ tenantId: "tenant-b" }, "tenant-a", work),
      // Rows that belong to nobody.
      runAsClaimedTenant({ tenantId: "system" }, "tenant-a", work),
      runAsClaimedTenant({ tenantId: "platform" }, "tenant-a", work),
      runAsClaimedTenant({ tenantId: "" }, "tenant-a", work),
      runAsClaimedTenant({}, "tenant-a", work),
      // A payload with no owner names nobody to act as.
      runAsClaimedTenant({ tenantId: "tenant-a" }, undefined, work),
      runAsClaimedTenant({ tenantId: "tenant-a" }, 7, work),
      // Already acting for B, A's row may not be picked up.
      runAsTenant("tenant-b", () =>
        runAsClaimedTenant({ tenantId: "tenant-a" }, "tenant-a", work),
      ),
    ];
    for (const outcome of await Promise.all(refused))
      expect(outcome.ran).toBe(false);
    expect(ran).toHaveLength(1);
  });

  test("a claimed item's failure surfaces from inside its tenant", async () => {
    let failedAs: string | undefined;
    await expect(
      runAsClaimedTenant({ tenantId: "tenant-a" }, "tenant-a", async () => {
        try {
          throw new Error("turn failed");
        } finally {
          failedAs = currentTenant();
        }
      }),
    ).rejects.toThrow("turn failed");
    expect(failedAs).toBe("tenant-a");
  });
});

/*
 * The asking conversation reads what it is waiting on from the queue, so it is told after the queue
 * moved and not before. Told from inside the delivery, the row would still say the hop was in
 * flight, and "Asking Ana…" would stay on screen for a hop that had finished.
 */
describe("telling the asking conversation", () => {
  test("after a delivered hop is finished and its answer is on its way back", async () => {
    const { runner: sweep, settled } = runner({
      answer: "Tuesday 02:00 to 04:00.",
    });

    await sweep.sweep();

    expect(settled).toEqual([
      { threadId: WORK.threadId, after: ["finish", "offer"] },
    ]);
  });

  test("after a failed delivery is released for another try", async () => {
    const { runner: sweep, settled } = runner({
      deliver: async () => {
        throw new Error("the model stopped");
      },
    });

    await sweep.sweep();

    expect(settled).toEqual([{ threadId: WORK.threadId, after: ["release"] }]);
  });

  test("a conversation that cannot be told does not fail the hop", async () => {
    const { runner: sweep, calls } = runner({
      onSettled: async () => {
        throw new Error("the socket is down");
      },
    });

    const report = await sweep.sweep();

    expect(report.delivered).toEqual(["researcher"]);
    expect(calls).toEqual([
      { verb: "finish", key: "run-1:abc", owner: "replica-a" },
    ]);
  });
});
