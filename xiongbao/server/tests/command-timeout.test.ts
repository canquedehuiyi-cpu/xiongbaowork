import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  COMMAND_TIMEOUT_MS,
  commandTimeoutMs,
} from "../../shared/computer-tool-words";
import { TURN_LIMITS, toolSegmentsFor } from "../../toolkit/src/limits";
import { createTurnRunner } from "../../toolkit/src/run-turn";
import { ABANDONED_FIRING_MS } from "../src/automations/sweep";
import { botSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import { ABANDONED_RUN_MS } from "../src/routines/sweep";
import { fetchDouble } from "./support/fetch-double";

/*
 * 期五 B: a command may be given up to ten minutes (`timeoutMs`, default two, more cut to ten), and
 * the turns that do real work (a board card's, an unattended one, a subagent's) run for 25 minutes
 * where a check-in or a patrol keeps five.
 */

describe("computer_run_command's timeoutMs", () => {
  test("the bounds: two minutes by default, ten at most, a larger ask cut rather than refused", () => {
    expect(COMMAND_TIMEOUT_MS).toEqual({
      default: 120_000,
      min: 1_000,
      max: 600_000,
    });
    expect(commandTimeoutMs(undefined)).toBe(120_000);
    expect(commandTimeoutMs(300_000)).toBe(300_000);
    expect(commandTimeoutMs(600_000)).toBe(600_000);
    expect(commandTimeoutMs(3_600_000)).toBe(600_000);
    expect(commandTimeoutMs(10)).toBe(1_000);
    expect(commandTimeoutMs(1_500.4)).toBe(1_500);
    expect(commandTimeoutMs(Number.NaN)).toBe(120_000);
  });

  function harness() {
    const sent: unknown[] = [];
    const gateway = createComputerGateway({
      provider: {
        name: "test",
        isolation: "per-person",
        locate: async () => "http://computer:4100",
        status: async (seat) => ({ botId: seat.botId, state: "ready" }),
        list: async () => [],
        stop: async () => ({ wasRunning: true }),
        reset: async () => ({ cleared: true }),
      },
      auditStore: { insert: async () => {} },
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
      fetchImpl: fetchDouble(async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/exec");
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({
          command: "make test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          truncated: false,
          timedOut: false,
          elapsedMs: 1,
        });
      }),
    });
    const tools = createHeadlessComputerTools({
      gateway,
      seat: botSeat("bot"),
      actor: {
        id: "owner",
        userId: "owner",
        initiator: { kind: "routine", id: "routine" },
      },
    });
    const command = tools.find(
      (tool) => tool.definition.name === "computer_run_command",
    );
    if (!command) throw new Error("Expected computer_run_command.");
    const run = (args: unknown) =>
      command.execute(args, {
        toolCallId: "call",
        signal: new AbortController().signal,
      });
    return { command, run, sent };
  }

  test("the unattended tool offers it, and sends what was asked, the default, or ten minutes", async () => {
    const { command, run, sent } = harness();
    const parameters = command.definition.parameters as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(Object.keys(parameters.properties)).toEqual([
      "command",
      "timeoutMs",
    ]);
    expect(parameters.required).toEqual(["command"]);
    expect(parameters.properties.timeoutMs?.description).toContain("600000");

    await run({ command: "make test", timeoutMs: 300_000 });
    await run({ command: "make test" });
    await run({ command: "make test", timeoutMs: 3_600_000 });
    expect(sent).toEqual([
      { command: "make test", timeoutMs: 300_000 },
      { command: "make test", timeoutMs: 120_000 },
      { command: "make test", timeoutMs: 600_000 },
    ]);
    // Anything but a positive number is the model's mistake, answered before the computer is asked.
    await expect(
      run({ command: "make test", timeoutMs: "600000" }),
    ).rejects.toThrow();
    await expect(
      run({ command: "make test", timeoutMs: -1 }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(3);
  });
});

describe("how long a headless turn may run", () => {
  const source = (...path: string[]) =>
    readFileSync(join(import.meta.dir, "..", "src", ...path), "utf8");
  /** The options object a named runner is built with, from its declaration to its closing line. */
  const optionsOf = (text: string, declaration: string) => {
    const start = text.indexOf(declaration);
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf("\n  });", start));
  };

  test("an unattended turn, a board task's and a follow-up run on the working clock", () => {
    const index = source("index.ts");
    expect(
      optionsOf(index, "const unattendedTurnRunner = createTurnRunner({"),
    ).toContain('turnTimeoutMs: turnTimeoutFor("unattended")');
    expect(
      optionsOf(index, "const boardTaskTurnRunner = createTurnRunner({"),
    ).toContain('turnTimeoutMs: turnTimeoutFor("board")');
    expect(
      optionsOf(index, "const wakeUpRunner = createWakeUpRunner({"),
    ).toContain('turnTimeoutMs: turnTimeoutFor("unattended")');
    // A board task's turn is the board runner; the approval resume keeps the light clock.
    expect(
      optionsOf(index, "runTask: createTaskTurn({").slice(0, 200),
    ).toContain("runTurn: boardTaskTurnRunner");
    expect(index).toContain(
      "const approvalContinuationRunner = createTurnRunner(\n    approvalContinuationOptions,\n  );",
    );
    // A card's round, a nudge and an automation all run on the unattended runner.
    for (const owner of [
      "const cardTurns = createCardTurns({",
      "const nudgeRuns = createNudgeRuns({",
      "const wakerAutomationExecutor = createWakerAutomationExecutor({",
    ])
      expect(optionsOf(index, owner)).toContain(
        "runTurn: unattendedTurnRunner",
      );
  });

  test("a subagent runs on the working clock unless its caller says otherwise", () => {
    const subagent = source("agents", "subagent.ts");
    const built = subagent.slice(
      subagent.indexOf("const runTurn = createTurnRunner({"),
    );
    expect(built.indexOf('turnTimeoutMs: turnTimeoutFor("subagent")')).toBe(
      built.indexOf("turnTimeoutMs"),
    );
    // Before the caller's options, so a test (or a caller) that gives its own still wins.
    expect(built.indexOf('turnTimeoutFor("subagent")')).toBeLessThan(
      built.indexOf("...options.turn"),
    );
  });

  test("a check-in and a patrol keep their light clocks", () => {
    const index = source("index.ts");
    expect(
      optionsOf(index, "const proactiveEngine = createProactiveEngine({"),
    ).toContain("turnTimeoutMs: 3 * 60_000");
    expect(index).toContain('turnTimeoutMs: turnTimeoutFor("patrol")');
    expect(source("responsibilities", "wiring.ts")).toContain(
      'turnTimeoutMs: turnTimeoutFor("patrol")',
    );
  });

  test("a run is declared abandoned only after twice the working clock, so a slow live turn is never closed", () => {
    expect(ABANDONED_RUN_MS).toBe(2 * TURN_LIMITS.workTurnTimeoutMs);
    expect(ABANDONED_FIRING_MS).toBe(2 * TURN_LIMITS.workTurnTimeoutMs);
    expect(source("channels", "working.ts")).toContain(
      "const ROUTINE_IN_FLIGHT_MS = 2 * TURN_LIMITS.workTurnTimeoutMs;",
    );
  });
});

describe("how many rounds of headless tools a turn may take", () => {
  const source = (...path: string[]) =>
    readFileSync(join(import.meta.dir, "..", "src", ...path), "utf8");
  const optionsOf = (text: string, declaration: string) => {
    const start = text.indexOf(declaration);
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf("\n  });", start));
  };

  /** A remote Bot asking for one more computer read every time it runs, `asks` times. */
  function botAsking(asks: number) {
    let requests = 0;
    const agent = new HttpAgent({
      agentId: "bot",
      url: "https://agent.example/ag-ui",
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as RunAgentInput;
        requests += 1;
        const id = `read-${requests}`;
        const events = [
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          },
          ...(requests <= asks
            ? [
                {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: id,
                  toolCallName: "probe",
                  parentMessageId: `m-${id}`,
                },
                { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" },
                { type: EventType.TOOL_CALL_END, toolCallId: id },
              ]
            : [
                {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: "reply",
                  role: "assistant",
                },
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "reply",
                  delta: "全部看完了。",
                },
                { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
              ]),
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    return agent;
  }

  async function turn(asks: number, maxToolSegments?: number) {
    let executed = 0;
    const runTurn = createTurnRunner({
      admission: async () => new AbortController().signal,
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner: {
        run: ({ agent, input }) =>
          new Observable((subscriber) => {
            agent
              .runAgent(input, {
                onEvent: ({ event }) => subscriber.next(event),
              })
              .then(
                () => subscriber.complete(),
                (error) => subscriber.error(error),
              );
          }),
        stop: async () => true,
      },
      buildAgentFor: async () => botAsking(asks),
      toolsForTurn: async () => [
        {
          definition: {
            name: "probe",
            description: "Look once more.",
            parameters: { type: "object", properties: {} },
          },
          execute: async () => {
            executed += 1;
            return { ok: true };
          },
        },
      ],
      ...(maxToolSegments === undefined ? {} : { maxToolSegments }),
    });
    const outcome = await runTurn({
      ownerUserId: "owner",
      routineId: "routine",
      agentId: "bot",
      threadId: `thread-${asks}-${maxToolSegments}`,
      instruction: "一项项看。",
      initiator: { kind: "routine", id: "routine" },
    }).then(
      ({ replyText }) => replyText,
      (error: Error) => error.message,
    );
    return { outcome, executed };
  }

  test("a working turn goes on past its 31st round; a light one stops at 30, as before", async () => {
    expect(await turn(31, toolSegmentsFor("unattended"))).toEqual({
      outcome: "全部看完了。",
      executed: 31,
    });
    const light = await turn(31);
    expect(light.executed).toBe(30);
    expect(light.outcome).toContain("continuation limit");
  }, 20_000);

  test("the working turns are given 80 rounds, the light ones keep 30", () => {
    expect(TURN_LIMITS.workToolSegments).toBe(80);
    expect(TURN_LIMITS.toolSegments).toBe(30);
    const index = source("index.ts");
    expect(
      optionsOf(index, "const unattendedTurnRunner = createTurnRunner({"),
    ).toContain('maxToolSegments: toolSegmentsFor("unattended")');
    expect(
      optionsOf(index, "const boardTaskTurnRunner = createTurnRunner({"),
    ).toContain('maxToolSegments: toolSegmentsFor("board")');
    expect(
      optionsOf(index, "const wakeUpRunner = createWakeUpRunner({"),
    ).toContain('maxToolSegments: toolSegmentsFor("unattended")');
    expect(source("agents", "subagent.ts")).toContain(
      'maxToolSegments: toolSegmentsFor("subagent")',
    );
    expect(source("responsibilities", "wiring.ts")).toContain(
      'maxToolSegments: toolSegmentsFor("patrol")',
    );
    // A check-in is not given more: it keeps the default.
    expect(
      optionsOf(index, "const proactiveEngine = createProactiveEngine({"),
    ).not.toContain("maxToolSegments");
  });
});
