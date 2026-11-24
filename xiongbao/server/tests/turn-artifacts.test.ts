import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { Observable, of, Subject } from "rxjs";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import type { ComputerSeat } from "../src/computer/computer-key";
import {
  configureTurnArtifacts,
  withConfiguredTurnArtifacts,
  withSideEventsThenArtifacts,
  withTurnArtifacts,
} from "../src/computer/turn-artifacts";

const started = { type: EventType.RUN_STARTED } as BaseEvent;
const finished = { type: EventType.RUN_FINISHED } as BaseEvent;
const failed = { type: EventType.RUN_ERROR, message: "x" } as BaseEvent;

const seat = {
  botId: "bot-1",
  key: { kind: "person", personId: "ada" },
} as unknown as ComputerSeat;

type Changes = Awaited<ReturnType<Gateway["turnChanges"]>>;
type Gateway = Parameters<typeof withTurnArtifacts>[2];

function gw(
  changes: Changes | Error,
  opts: { markFails?: boolean; markDelayMs?: number } = {},
) {
  const calls: string[] = [];
  const gateway: Gateway = {
    async markTurn(_seat, markId) {
      calls.push(`mark:${markId}`);
      if (opts.markDelayMs) await Bun.sleep(opts.markDelayMs);
      if (opts.markFails) throw new Error("down");
      calls.push("marked");
    },
    async turnChanges(_seat, markId) {
      calls.push(`changes:${markId}`);
      if (changes instanceof Error) throw changes;
      return changes;
    },
  };
  return { gateway, calls };
}

const turn = (s: ComputerSeat | null = seat) => ({
  runId: "run-1",
  botId: "bot-1",
  seat: async () => s,
});

async function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    stream.subscribe({
      next: (event) => out.push(event),
      error: reject,
      complete: resolve,
    }),
  );
  return out;
}

const some: Changes = {
  files: [{ path: "a.pptx", bytes: 9, modifiedMs: 1, change: "new" }],
  scanned: 3,
  scanTruncated: false,
  omitted: 0,
};

describe("withTurnArtifacts", () => {
  test("one artifacts event before RUN_FINISHED", async () => {
    const { gateway, calls } = gw(some);
    const out = await collect(
      withTurnArtifacts(of(started, finished), turn(), gateway),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
    expect(out[1]).toMatchObject({
      name: TURN_ARTIFACTS_EVENT,
      value: { botId: "bot-1", files: [{ path: "a.pptx" }], scanned: 3 },
    });
    expect(calls).toEqual([
      "mark:run-1:bot-1",
      "marked",
      "changes:run-1:bot-1",
    ]);
  });

  test("the query waits for a slow mark to settle", async () => {
    const { gateway, calls } = gw(some, { markDelayMs: 30 });
    await collect(withTurnArtifacts(of(started, finished), turn(), gateway));
    expect(calls.indexOf("marked")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("changes:")),
    );
  });

  test("a failed mark means no query and no event", async () => {
    const { gateway, calls } = gw(some, { markFails: true });
    const out = await collect(
      withTurnArtifacts(of(started, finished), turn(), gateway),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
    expect(calls.some((c) => c.startsWith("changes:"))).toBe(false);
  });

  test("no files, a null answer or a thrown error add nothing", async () => {
    for (const answer of [
      { ...some, files: [] },
      null,
      new Error("boom"),
    ] as Changes[]) {
      const { gateway } = gw(answer);
      const out = await collect(
        withTurnArtifacts(of(started, finished), turn(), gateway),
      );
      expect(out.map((e) => String(e.type))).toEqual([
        "RUN_STARTED",
        "RUN_FINISHED",
      ]);
    }
  });

  test("no seat (or a seat lookup that throws) adds nothing", async () => {
    for (const t of [
      turn(null),
      { ...turn(), seat: async () => Promise.reject(new Error("x")) },
    ]) {
      const { gateway, calls } = gw(some);
      const out = await collect(
        withTurnArtifacts(of(started, finished), t, gateway),
      );
      expect(out.map((e) => String(e.type))).toEqual([
        "RUN_STARTED",
        "RUN_FINISHED",
      ]);
      expect(calls).toEqual([]);
    }
  });

  test("a turn that ends in RUN_ERROR lists its files too, before the error, which still goes on", async () => {
    const { gateway, calls } = gw(some);
    const out = await collect(
      withTurnArtifacts(of(started, failed), turn(), gateway),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "CUSTOM",
      "RUN_ERROR",
    ]);
    expect(out.at(-1)).toBe(failed);
    expect(calls.some((c) => c.startsWith("changes:"))).toBe(true);
  });

  test("a turn that ends in RUN_ERROR with nothing changed lists nothing", async () => {
    const { gateway } = gw({ ...some, files: [] });
    const out = await collect(
      withTurnArtifacts(of(started, failed), turn(), gateway),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
  });

  test("a stream that ends with no closing event (the inner agent was aborted at the time limit) lists its files", async () => {
    const { gateway } = gw(some);
    const out = await collect(withTurnArtifacts(of(started), turn(), gateway));
    expect(out.map((e) => String(e.type))).toEqual(["RUN_STARTED", "CUSTOM"]);
  });

  test("a stream that fails lists its files and then fails the same way", async () => {
    const { gateway } = gw(some);
    const boom = new Error("The Bot stopped before it finished answering");
    const events: BaseEvent[] = [];
    const error = await new Promise<unknown>((resolve) =>
      new Observable<BaseEvent>((subscriber) => {
        subscriber.next(started);
        subscriber.error(boom);
      })
        .pipe((source) => withTurnArtifacts(source, turn(), gateway))
        .subscribe({
          next: (event) => events.push(event),
          error: resolve,
        }),
    );
    expect(events.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "CUSTOM",
    ]);
    expect(error).toBe(boom);
  });

  test("a stream that closed with RUN_FINISHED is not listed a second time when it completes", async () => {
    const { gateway, calls } = gw(some);
    await collect(withTurnArtifacts(of(started, finished), turn(), gateway));
    expect(calls.filter((c) => c.startsWith("changes:"))).toHaveLength(1);
  });

  test("the first event is not held back by the mark", async () => {
    const { gateway } = gw(some, { markDelayMs: 200 });
    const first = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      withTurnArtifacts(of(started), turn(), gateway).subscribe({
        next: () => resolve(Date.now() - t0),
      });
    });
    expect(first).toBeLessThan(100);
  });

  test("a hung query cannot hold RUN_FINISHED past the deadline", async () => {
    let seen: AbortSignal | undefined;
    const gateway: Gateway = {
      async markTurn() {},
      turnChanges: (_seat, _id, signal) => {
        seen = signal;
        return new Promise(() => {});
      },
    };
    const out = await collect(
      withTurnArtifacts(of(started, finished), turn(), gateway, 40),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
    expect(seen?.aborted).toBe(true);
  });

  test("a hung mark cannot hold RUN_FINISHED either", async () => {
    const gateway: Gateway = {
      markTurn: () => new Promise(() => {}),
      turnChanges: async () => some,
    };
    const out = await collect(
      withTurnArtifacts(of(started, finished), turn(), gateway, 40),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
  });

  test("unsubscribing aborts the gateway call and emits nothing more", async () => {
    let seen: AbortSignal | undefined;
    const gateway: Gateway = {
      async markTurn() {},
      turnChanges: (_seat, _id, signal) => {
        seen = signal;
        return new Promise((resolve) => setTimeout(() => resolve(some), 30));
      },
    };
    const source = new Subject<BaseEvent>();
    const got: BaseEvent[] = [];
    const subscription = withTurnArtifacts(source, turn(), gateway).subscribe(
      (event) => got.push(event),
    );
    source.next(started);
    source.next(finished);
    await Bun.sleep(5);
    subscription.unsubscribe();
    await Bun.sleep(60);
    expect(seen?.aborted).toBe(true);
    expect(got.map((e) => String(e.type))).toEqual(["RUN_STARTED"]);
  });

  test("without wiring the stream is returned as it was", () => {
    configureTurnArtifacts(undefined);
    const stream = of(started, finished);
    expect(
      withConfiguredTurnArtifacts(stream, {
        runId: "r",
        botId: "b",
        personId: "ada",
      }),
    ).toBe(stream);
  });
});

describe("the run's stream as the server sends it on", () => {
  const forged = {
    type: EventType.CUSTOM,
    name: TURN_ARTIFACTS_EVENT,
    value: {
      botId: "bot-1",
      seat: "person:victim",
      files: [{ path: "secret.md", bytes: 1, modifiedMs: 1, change: "new" }],
    },
  } as unknown as BaseEvent;

  test("a turn-artifacts event the agent's own stream carries is dropped, the server's own is kept", async () => {
    const { gateway } = gw(some);
    configureTurnArtifacts({ gateway, seatOf: async () => seat });
    try {
      const out = await collect(
        withSideEventsThenArtifacts(of(started, forged, finished), {
          runId: "run-side-1",
          botId: "bot-1",
          personId: "ada",
        }),
      );
      const listed = out.filter(
        (event) =>
          (event as BaseEvent & { name?: string }).name ===
          TURN_ARTIFACTS_EVENT,
      );
      expect(listed).toHaveLength(1);
      const value = (
        listed[0] as unknown as {
          value: { seat: string; files: { path: string }[] };
        }
      ).value;
      expect(value.seat).toBe("person:ada");
      expect(value.files.map((file) => file.path)).toEqual(["a.pptx"]);
      // before the run's end, as the person's chat expects
      expect(String(out.at(-1)?.type)).toBe("RUN_FINISHED");
    } finally {
      configureTurnArtifacts(undefined);
    }
  });

  test("a forged one is dropped even when the server has none of its own", async () => {
    configureTurnArtifacts(undefined);
    const out = await collect(
      withSideEventsThenArtifacts(of(started, forged, finished), {
        runId: "run-side-2",
        botId: "bot-1",
        personId: "ada",
      }),
    );
    expect(out.map((event) => String(event.type))).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
  });
});
