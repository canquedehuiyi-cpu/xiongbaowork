import { expect, test } from "bun:test";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { HeadlessToolsMiddleware } from "../src/headless-tools";
import { TURN_LIMITS, toolSegmentsFor } from "../src/limits";

/*
 * 期五: how many rounds of headless tool calls one turn may take. A working turn (a board card's, an
 * unattended one, a subagent's) gets 80, the order of a person's chat (40 steps, extended once by as
 * many again); a light one (a check-in, a patrol) keeps 30.
 */

/** A remote Bot that asks for one more `probe` every time it is run, `asks` times, then answers. */
function botAsking(asks: number) {
  let requests = 0;
  const agent = new HttpAgent({
    agentId: "bot",
    url: "https://agent.example/ag-ui",
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as RunAgentInput;
      requests += 1;
      const id = `probe-${requests}`;
      const body: BaseEvent[] =
        requests <= asks
          ? ([
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: id,
                toolCallName: "probe",
                parentMessageId: `message-${id}`,
              },
              { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" },
              { type: EventType.TOOL_CALL_END, toolCallId: id },
            ] as BaseEvent[])
          : ([
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId: "reply",
                role: "assistant",
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "reply",
                delta: "done",
              },
              { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
            ] as BaseEvent[]);
      const events = [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        ...body,
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
  return { agent, requests: () => requests };
}

async function turn(asks: number, maxSegments?: number) {
  const { agent, requests } = botAsking(asks);
  let executed = 0;
  agent.use(
    new HeadlessToolsMiddleware(
      [
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
      undefined,
      maxSegments === undefined ? undefined : { maxSegments },
    ),
  );
  agent.threadId = "thread";
  // The limit ends the run with an error, which reaches a subscriber as RUN_ERROR or a rejection.
  let ended: string | undefined;
  const outcome = await agent
    .runAgent(
      { runId: "run", tools: [] },
      {
        onEvent: ({ event }) => {
          if (event.type === EventType.RUN_ERROR)
            ended = String((event as { message?: unknown }).message);
        },
      },
    )
    .then(
      () => ended ?? "answered",
      (error: Error) => ended ?? error.message,
    );
  return { outcome, executed, requests: requests() };
}

test("the two ceilings: 30 rounds for a light turn, 80 for a working one", () => {
  expect(TURN_LIMITS.toolSegments).toBe(30);
  expect(TURN_LIMITS.workToolSegments).toBe(80);
  expect(toolSegmentsFor("board")).toBe(80);
  expect(toolSegmentsFor("unattended")).toBe(80);
  expect(toolSegmentsFor("subagent")).toBe(80);
  expect(toolSegmentsFor("check-in")).toBe(30);
  expect(toolSegmentsFor("patrol")).toBe(30);
});

test("a light turn still stops after its 30th round, as it always did", async () => {
  expect(await turn(30)).toEqual({
    outcome: "answered",
    executed: 30,
    requests: 31,
  });
  expect(await turn(31)).toEqual({
    outcome: "The headless tool continuation limit was reached.",
    executed: 30,
    requests: 31,
  });
});

test("a working turn goes on past the 31st round and stops only at 80", async () => {
  expect(await turn(31, 80)).toEqual({
    outcome: "answered",
    executed: 31,
    requests: 32,
  });
  expect(await turn(80, 80)).toEqual({
    outcome: "answered",
    executed: 80,
    requests: 81,
  });
  expect(await turn(81, 80)).toEqual({
    outcome: "The headless tool continuation limit was reached.",
    executed: 80,
    requests: 81,
  });
}, 20_000);
