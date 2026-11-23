import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { type Observable, of } from "rxjs";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import { withTurnArtifacts } from "../src/computer/turn-artifacts";
import type { ComputerSeat } from "../src/computer/computer-key";

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

  test("RUN_ERROR adds nothing", async () => {
    const { gateway, calls } = gw(some);
    const out = await collect(
      withTurnArtifacts(of(started, failed), turn(), gateway),
    );
    expect(out.map((e) => String(e.type))).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
    expect(calls.some((c) => c.startsWith("changes:"))).toBe(false);
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
});
