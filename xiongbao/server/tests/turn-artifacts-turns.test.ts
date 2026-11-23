import { afterEach, describe, expect, test } from "bun:test";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, of } from "rxjs";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import { HeadlessToolsMiddleware } from "../../toolkit/src/headless-tools";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import {
  configureTurnArtifacts,
  withConfiguredTurnArtifacts,
  withSideEventsThenArtifacts,
} from "../src/computer/turn-artifacts";
import { createTurnRunner, type RunnerLike } from "../src/routines/run-turn";
import { runAsTenant } from "../src/tenant/context";
import { workspaceComputer } from "./support/workspace-computer";

/**
 * A turn's files are listed once over the whole turn, however the turn is cut into runs or steps.
 *
 * Three shapes of turn, each driven with the real gateway in front of a computer that keeps files
 * (`support/workspace-computer.ts`), so a snapshot that is recorded late, or dropped too early, shows
 * as a missing event:
 *  - the browser runs the Bot's computer tools: every tool call ends a run, the page runs the tool,
 *    and the result goes back in a run of its own;
 *  - the server runs them between the model's steps of one stream (a chat that declares it, a card, a
 *    group's turn, a routine);
 *  - a turn with no computer in it lists nothing.
 */

const BOT = "bot-1";
const PERSON = "ada";

afterEach(() => configureTurnArtifacts(undefined));

const run = (runId: string, body: BaseEvent[] = []): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId: "thread-1", runId } as BaseEvent,
  ...body,
  { type: EventType.RUN_FINISHED, threadId: "thread-1", runId } as BaseEvent,
];

const askFor = (id: string): BaseEvent[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: "computer_run_command",
    parentMessageId: `message-${id}`,
  } as BaseEvent,
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent,
];

const say = (text: string): BaseEvent[] => [
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "reply",
    role: "assistant",
  } as BaseEvent,
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "reply",
    delta: text,
  } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: "reply" } as BaseEvent,
];

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

const listed = (events: BaseEvent[]) =>
  events.filter(
    (event) =>
      event.type === EventType.CUSTOM &&
      (event as unknown as { name: string }).name === TURN_ARTIFACTS_EVENT,
  ) as unknown as { value: { files: { path: string }[] } }[];

const paths = (events: BaseEvent[]) =>
  listed(events).flatMap((event) => event.value.files.map((f) => f.path));

function wired() {
  const computer = workspaceComputer();
  configureTurnArtifacts({
    gateway: computer.gateway,
    seatOf: computer.seatOf,
  });
  return computer;
}

/** A run as the server's own agent stream sends it on, for one chat turn the browser drives. */
const browserRun = (
  runId: string,
  body: BaseEvent[],
  continues: boolean,
  threadId = "thread-1",
) =>
  collect(
    withSideEventsThenArtifacts(of(...run(runId, body)), {
      runId,
      botId: BOT,
      personId: PERSON,
      threadId,
      continues,
    }),
  );

describe("a turn the browser drives, one run per tool call", () => {
  test("one event on the run that ends the turn, listing what every earlier run's tool left", async () => {
    const computer = wired();
    const seat = await computer.seatOf(BOT, PERSON);

    const first = await browserRun("run-1", askFor("call-1"), false);
    expect(listed(first)).toEqual([]);
    await computer.run(seat, "write out/first.txt one");

    const second = await browserRun("run-2", askFor("call-2"), true);
    expect(listed(second)).toEqual([]);
    await computer.run(seat, "write out/second.txt two");

    const last = await browserRun("run-3", say("done"), true);
    expect(paths(last).sort()).toEqual(["out/first.txt", "out/second.txt"]);
    // Before the run's own end, where the chat reads it.
    expect(last.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(last.at(-2)?.type).toBe(EventType.CUSTOM);
  });

  test("a person's next message begins a new turn: files the unfinished one left are not listed again", async () => {
    const computer = wired();
    const seat = await computer.seatOf(BOT, PERSON);

    // A turn the page never finished: the tool ran, no run followed.
    await browserRun("run-1", askFor("call-1"), false);
    await computer.run(seat, "write out/old.txt old");

    const fresh = await browserRun("run-2", askFor("call-2"), false);
    expect(listed(fresh)).toEqual([]);
    await computer.run(seat, "write out/new.txt new");
    const done = await browserRun("run-3", say("done"), true);
    expect(paths(done)).toEqual(["out/new.txt"]);
  });

  test("a turn that never used the computer lists nothing, and does not wake it", async () => {
    const computer = wired();
    const out = await browserRun("run-1", say("hello"), false);
    expect(listed(out)).toEqual([]);
    expect(computer.asked).toEqual([]);
  });

  test("two conversations of the same Bot keep their own turns", async () => {
    const computer = wired();
    const seat = await computer.seatOf(BOT, PERSON);
    await browserRun("run-a1", askFor("a"), false, "thread-a");
    await browserRun("run-b1", askFor("b"), false, "thread-b");
    await computer.run(seat, "write out/shared.txt x");
    const b = await browserRun("run-b2", say("done"), true, "thread-b");
    const a = await browserRun("run-a2", say("done"), true, "thread-a");
    expect(paths(b)).toEqual(["out/shared.txt"]);
    expect(paths(a)).toEqual(["out/shared.txt"]);
  });
});

/** The agent as `copilot.ts` builds it: each step's stream goes out through the per-run observer. */
class ObservedAgent extends HttpAgent {
  override run(input: RunAgentInput): Observable<BaseEvent> {
    return withSideEventsThenArtifacts(super.run(input), {
      runId: input.runId,
      botId: BOT,
      personId: PERSON,
      threadId: input.threadId,
      continues: (input.messages.at(-1)?.role ?? "user") !== "user",
    });
  }
}

/** A model that asks for the computer `asks` times, one step each, then answers. */
function modelAsking(asks: number) {
  let steps = 0;
  const agent = new ObservedAgent({
    agentId: BOT,
    url: "https://agent.example/ag-ui",
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as RunAgentInput;
      steps += 1;
      const body = steps <= asks ? askFor(`call-${steps}`) : say("done");
      return new Response(
        run(input.runId, body)
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return agent;
}

const computerTool = (
  computer: ReturnType<typeof workspaceComputer>,
  name: string,
) => ({
  definition: {
    name: "computer_run_command",
    description: "Run a command.",
    parameters: { type: "object", properties: {} },
  },
  execute: async () => {
    await computer.run(await computer.seatOf(BOT, PERSON), `write ${name} x`);
    return { ok: true };
  },
});

describe("a turn the server runs in steps, tools between the steps", () => {
  test("a stream wrapped as a whole lists the files once, whatever its steps observe", async () => {
    const computer = wired();
    const agent = modelAsking(2);
    let wrote = 0;
    const tool = computerTool(computer, "report.md");
    const counting = {
      ...tool,
      execute: async () => {
        wrote += 1;
        return computer.run(
          await computer.seatOf(BOT, PERSON),
          `write out/step-${wrote}.md x`,
        );
      },
    };
    const input: RunAgentInput = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [{ id: "m1", role: "user", content: "Go." }],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const middleware = new HeadlessToolsMiddleware([counting]);
    const whole = withConfiguredTurnArtifacts(middleware.run(input, agent), {
      runId: "run-1",
      botId: BOT,
      personId: PERSON,
      wholeTurn: true,
    });
    const out = await collect(whole);
    expect(wrote).toBe(2);
    expect(paths(out).sort()).toEqual(["out/step-1.md", "out/step-2.md"]);
    expect(listed(out)).toHaveLength(1);
    expect(out.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(out.at(-2)?.type).toBe(EventType.CUSTOM);
  });

  test("a turn with no computer in its steps lists nothing", async () => {
    const computer = wired();
    const input: RunAgentInput = {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [{ id: "m1", role: "user", content: "Go." }],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const out = await collect(
      withConfiguredTurnArtifacts(
        new HeadlessToolsMiddleware([computerTool(computer, "x")]).run(
          input,
          modelAsking(0),
        ),
        { runId: "run-1", botId: BOT, personId: PERSON, wholeTurn: true },
      ),
    );
    expect(listed(out)).toEqual([]);
    expect(computer.asked).toEqual([]);
  });
});

describe("an unattended turn (a card, a group's turn, a routine)", () => {
  /** The server's own turn runner, over an agent whose steps are observed as a chat's are. */
  function unattended(
    asks: number,
    computer: ReturnType<typeof workspaceComputer>,
  ) {
    const persisted: BaseEvent[] = [];
    const runner: RunnerLike = {
      run: ({ agent, input }) =>
        new Observable<BaseEvent>((subscriber) => {
          agent
            .runAgent(input, {
              onEvent: ({ event }) => {
                persisted.push(event);
                subscriber.next(event);
              },
            })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        }),
      stop: async () => true,
    };
    const start = createTurnRunner({
      admission: serverTurnAdmission,
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner,
      buildAgentFor: async () => modelAsking(asks),
      toolsForTurn: async () => [computerTool(computer, "unused")],
    });
    return {
      persisted,
      turn: () =>
        runAsTenant(PERSON, () =>
          start({
            ownerUserId: PERSON,
            routineId: "routine",
            agentId: BOT,
            threadId: "thread-1",
            instruction: "Make the report",
          }),
        ),
    };
  }

  test("lists what the tools between its steps left, once, before the turn's own end", async () => {
    const computer = wired();
    const { persisted, turn } = unattended(2, computer);
    await turn();
    expect(computer.files.size).toBe(1);
    expect(listed(persisted)).toHaveLength(1);
    expect(paths(persisted)).toEqual(["unused"]);
    const finished = persisted
      .map((event) => event.type)
      .lastIndexOf(EventType.RUN_FINISHED);
    expect(persisted[finished - 1]?.type).toBe(EventType.CUSTOM);
  });

  test("a turn that answers without touching the computer lists nothing", async () => {
    const computer = wired();
    const { persisted, turn } = unattended(0, computer);
    await turn();
    expect(listed(persisted)).toEqual([]);
    expect(computer.asked).toEqual([]);
  });
});
