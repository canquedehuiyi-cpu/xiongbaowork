import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type MiddlewareFunction,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import {
  COMPUTER_TOOLS_PROP,
  SEGMENTS_NOTICE,
  SERVER_COMPUTER_TOOLS,
  TURN_LIMIT_EVENT,
  type TurnLimitReason,
  timeUpNotice,
} from "../../../shared/turn-notices";
import {
  HeadlessToolsMiddleware,
  SEGMENT_LIMIT_MESSAGE,
} from "../../../toolkit/src/headless-tools";
import { TURN_LIMITS } from "../../../toolkit/src/limits";
import type { AgentActor } from "../agents/profile-types";
import { type AuditInitiator, PERSON_INITIATOR } from "../audit";
import type { ComputerToolsForTurn } from "../computer/turn-tools";
import { runAsTenant } from "../tenant/context";
import { openTracker } from "./open-tracker";

/**
 * A person's chat in the browser, with its computer tools run by the server.
 *
 * The browser used to run every computer tool of a chat itself: the Bot's run ended at each call,
 * the page ran it and started the next run. Close the page and the next run never came. A run that
 * says in its `forwardedProps` that the computer is the server's (`computerTools: "server"`) is run
 * here instead, from the first model step to the last, the way a group's turn is: the tools are the
 * group turn's (`createComputerToolsForTurn`), every action goes through the gateway's approval
 * gate, and the browser is only a viewer. A run that does not say so, on a deployment that has not
 * switched this on, is left exactly as it was, so a tool is never run twice.
 */

/** Where a run says the server runs its computer tools. */
export { COMPUTER_TOOLS_PROP };

/** Whether a run's `forwardedProps` hand its computer tools to the server. */
export function declaresServerComputerTools(forwardedProps: unknown): boolean {
  return (
    typeof forwardedProps === "object" &&
    forwardedProps !== null &&
    (forwardedProps as Record<string, unknown>)[COMPUTER_TOOLS_PROP] ===
      SERVER_COMPUTER_TOOLS
  );
}

/** The browser's own names for the tools the server now holds: they are offered once, by the server. */
const isComputerToolName = (name: string) =>
  name.startsWith("computer_") || name === "report_refusal";

const NOT_RUN_TIME = "本轮时间已到，这一步没有执行。";
const NOT_RUN_SEGMENTS = "本轮调用工具的次数已到上限，这一步没有执行。";
const NOT_RUN_STOPPED = "已停止，这一步没有执行完。";

/** The event a limit leaves in the conversation, for whatever tells the person a turn stopped. */
export { TURN_LIMIT_EVENT };

type Why = TurnLimitReason;

export type ChatServerTools = {
  /** Put the server's computer on each Bot a person's chat runs, for the person asking. */
  attach(agents: Record<string, AbstractAgent>, actor: AgentActor): void;
  /**
   * Carry the person's Stop to the tool a run is in the middle of. A runner's `stop` aborts the
   * agent, which ends the model's stream and nothing else: a tool the server is running for the
   * turn would go on to its end. Wrapped over the runner's `run` as the other run watchers are.
   */
  watch<Request extends WatchedRequest, Events>(
    runner: WatchedRunner<Request, Events>,
  ): void;
};

type WatchedRequest = {
  agent: { abortRun?: () => void };
  input: { runId: string };
};
type WatchedRunner<Request, Events> = {
  run: (request: Request) => Events;
  runWithStartupBoundary?: (request: Request) => Events;
};

export function createChatServerTools(options: {
  toolsForTurn: ComputerToolsForTurn;
  /** Whether this run was asked for by a person (`isAskedRun`): the runtime's own runs hold nothing. */
  holds: (input: RunAgentInput) => boolean;
  /** How long one turn may take. The working turn's clock, unless a test says otherwise. */
  turnTimeoutMs?: number;
  /** How many rounds of tool calls one turn may take. The working turn's, unless a test says otherwise. */
  maxSegments?: number;
  initiator?: AuditInitiator;
}): ChatServerTools {
  const turnTimeoutMs = options.turnTimeoutMs ?? TURN_LIMITS.workTurnTimeoutMs;
  const maxSegments = options.maxSegments ?? TURN_LIMITS.workToolSegments;
  const initiator = options.initiator ?? PERSON_INITIATOR;
  /** The stop of each run the server is running tools for, by run id. */
  const stops = new Map<string, () => void>();

  const withoutDeclaration = (input: RunAgentInput): RunAgentInput => {
    const { [COMPUTER_TOOLS_PROP]: _declared, ...rest } =
      (input.forwardedProps ?? {}) as Record<string, unknown>;
    return { ...input, forwardedProps: rest };
  };

  const serverRun = (
    agentId: string,
    actor: AgentActor,
    input: RunAgentInput,
    next: AbstractAgent,
  ) =>
    new Observable<BaseEvent>((subscriber) => {
      const seen = openTracker();
      let inner: Subscription | undefined;
      let ended = false;
      let clock: ReturnType<typeof setTimeout> | undefined;
      const emit = (event: BaseEvent) => {
        seen.see(event);
        subscriber.next(event);
      };
      const end = () => {
        if (ended) return;
        ended = true;
        if (clock) clearTimeout(clock);
        stops.delete(input.runId);
        subscriber.complete();
      };
      /** Stops what is running for the turn and says so in the conversation, as a finished turn. */
      const wrapUp = (why: Why) => {
        if (ended) return;
        inner?.unsubscribe();
        const run = { threadId: input.threadId, runId: input.runId };
        if (!seen.started)
          emit({ type: EventType.RUN_STARTED, ...run } as BaseEvent);
        for (const event of seen.closing(
          why === "time" ? NOT_RUN_TIME : NOT_RUN_SEGMENTS,
        ))
          emit(event);
        const messageId = crypto.randomUUID();
        for (const event of [
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta:
              why === "time"
                ? timeUpNotice(Math.max(1, Math.round(turnTimeoutMs / 60_000)))
                : SEGMENTS_NOTICE,
          },
          { type: EventType.TEXT_MESSAGE_END, messageId },
          {
            type: EventType.CUSTOM,
            name: TURN_LIMIT_EVENT,
            value: { reason: why },
          },
          { type: EventType.RUN_FINISHED, ...run },
        ])
          emit(event as BaseEvent);
        end();
      };
      /** A Stop: what runs is torn down, its calls answered, and the runner closes the run as stopped. */
      const stop = () => {
        if (ended) return;
        inner?.unsubscribe();
        for (const event of seen.closing(NOT_RUN_STOPPED)) emit(event);
        end();
      };
      stops.set(input.runId, stop);
      clock = setTimeout(() => wrapUp("time"), turnTimeoutMs);
      clock.unref?.();

      void runAsTenant(actor.id, () =>
        options.toolsForTurn({
          ownerUserId: actor.id,
          agentId,
          initiator,
        }),
      ).then(
        (tools) => {
          if (ended) return;
          const held = new Set(tools.map((tool) => tool.definition.name));
          /*
           * What the person's permissions switched off is not offered, and neither is the browser's
           * own copy of anything the server holds: the list the model sees is the server's.
           */
          const request: RunAgentInput = {
            ...input,
            tools: (input.tools ?? []).filter(
              (tool) => !isComputerToolName(tool.name) || held.has(tool.name),
            ),
          };
          const run =
            tools.length > 0
              ? new HeadlessToolsMiddleware(tools, initiator, {
                  maxSegments,
                }).run(request, next)
              : next.run(request);
          // Subscribed in the person's frame, so every tool the turn runs reads and writes as them.
          inner = runAsTenant(actor.id, () =>
            run.subscribe({
              next: (event) => {
                if (ended) return;
                if (
                  event.type === EventType.RUN_ERROR &&
                  (event as unknown as { message?: string }).message ===
                    SEGMENT_LIMIT_MESSAGE
                )
                  return wrapUp("segments");
                emit(event);
              },
              error: (error) => {
                if (ended) return;
                ended = true;
                if (clock) clearTimeout(clock);
                stops.delete(input.runId);
                subscriber.error(error);
              },
              complete: end,
            }),
          );
        },
        (error) => {
          if (ended) return;
          ended = true;
          if (clock) clearTimeout(clock);
          stops.delete(input.runId);
          subscriber.error(error);
        },
      );
      return () => {
        ended = true;
        if (clock) clearTimeout(clock);
        stops.delete(input.runId);
        inner?.unsubscribe();
      };
    });

  const middlewareFor =
    (agentId: string, actor: AgentActor): MiddlewareFunction =>
    (input, next) => {
      if (!declaresServerComputerTools(input.forwardedProps))
        return next.run(input);
      if (!options.holds(input)) return next.run(withoutDeclaration(input));
      return serverRun(agentId, actor, input, next);
    };

  return {
    attach(agents, actor) {
      for (const [agentId, agent] of Object.entries(agents))
        agent.use(middlewareFor(agentId, actor));
    },
    watch(runner) {
      const watch = (request: WatchedRequest) => {
        const { agent } = request;
        const abort = agent.abortRun;
        if (typeof abort !== "function") return;
        agent.abortRun = () => {
          try {
            stops.get(request.input.runId)?.();
          } finally {
            abort.call(agent);
          }
        };
      };
      const run = runner.run.bind(runner);
      runner.run = (request) => {
        watch(request);
        return run(request);
      };
      const startup = runner.runWithStartupBoundary?.bind(runner);
      if (startup)
        runner.runWithStartupBoundary = (request) => {
          watch(request);
          return startup(request);
        };
    },
  };
}
