import { describe, expect, test } from "bun:test";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { TURN_LIMITS } from "../../toolkit/src/limits";
import type { createTurnRunner } from "../src/routines/run-turn";
import { createContinuationRunner } from "../src/threads/continuation-clock";

/*
 * What an approval carries a turn on with: the light turn's clock, five minutes, unless the run it
 * continues was a chat whose computer the server runs (期九·三), which is a long turn and gets
 * twenty-five. The runners are made by a stand-in that records what each was built with, and a small
 * clock is injected, so nothing here waits for a real one.
 */

type Options = Parameters<typeof createTurnRunner>[0];

function harness(config: { serverComputerTools: boolean; clockMs?: number }) {
  const built: {
    timeoutMs: number | undefined;
    segments: number | undefined;
    name: string;
  }[] = [];
  const ran: string[] = [];
  const make = ((options: Options) => {
    const name = built.length === 0 ? "light" : "long";
    built.push({
      timeoutMs: options.turnTimeoutMs,
      segments: options.maxToolSegments,
      name,
    });
    const runner: TurnRunner = async () => {
      ran.push(name);
      return { replyText: name } as never;
    };
    return runner;
  }) as unknown as typeof createTurnRunner;
  const runner = createContinuationRunner({
    options: {} as Options,
    serverComputerTools: config.serverComputerTools,
    ...(config.clockMs === undefined
      ? {}
      : { serverChatTurnTimeoutMs: config.clockMs }),
    make,
  });
  const continuing = (forwardedProps: unknown) =>
    runner({
      ownerUserId: "o",
      routineId: "approval",
      agentId: "a",
      threadId: "t",
      instruction: "",
      continuation: {
        snapshot: { forwardedProps } as never,
        result: { content: "{}" },
        messageId: "m",
      },
    });
  return { built, ran, runner, continuing };
}

describe("the clock an approval's continuation runs under", () => {
  test("a chat the server runs the computer for is carried on under the working turn's clock", async () => {
    const h = harness({ serverComputerTools: true });
    await h.continuing({ computerTools: "server" });
    expect(h.ran).toEqual(["long"]);
    expect(h.built[1]).toEqual({
      name: "long",
      timeoutMs: TURN_LIMITS.workTurnTimeoutMs,
      segments: TURN_LIMITS.workToolSegments,
    });
    expect(TURN_LIMITS.workTurnTimeoutMs).toBe(25 * 60_000);
  });

  test("the clock is the one injected, so a test never waits for twenty-five minutes", async () => {
    const h = harness({ serverComputerTools: true, clockMs: 40 });
    await h.continuing({ computerTools: "server" });
    expect(h.built[1]?.timeoutMs).toBe(40);
    // The light runner is untouched by it.
    expect(h.built[0]?.timeoutMs).toBeUndefined();
  });

  test("every other continuation keeps the light clock", async () => {
    const h = harness({ serverComputerTools: true });
    await h.continuing({});
    await h.continuing(undefined);
    await h.continuing({ computerTools: "browser" });
    await h.runner({
      ownerUserId: "o",
      routineId: "r",
      agentId: "a",
      threadId: "t",
      instruction: "go",
    });
    expect(h.ran).toEqual(["light", "light", "light", "light"]);
    expect(h.built[0]?.timeoutMs).toBeUndefined();
  });

  test("with the deployment's switch off, a declaration changes nothing", async () => {
    const h = harness({ serverComputerTools: false });
    await h.continuing({ computerTools: "server" });
    expect(h.ran).toEqual(["light"]);
  });
});
