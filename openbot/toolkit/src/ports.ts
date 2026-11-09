import type { BaseEvent, Message } from "@ag-ui/client";
import type { HeadlessTool } from "./headless-tools";
import type { AuditInitiator } from "./initiator";

/**
 * What the toolkit needs from its host, named so the turn code can be read without the server.
 *
 * Each port is the narrowest shape the turn code calls. The server supplies the implementations.
 */

/**
 * Whether a turn may start, and the signal that stops it if that changes while it runs.
 *
 * Throws to refuse: a paused Bot, or a person without "Use Bots" or on a model off the allowlist.
 * Resolves with a signal that aborts when the Bot is paused mid-turn, joined with the caller's own
 * signal when there is one.
 */
export type TurnAdmission = (input: {
  ownerUserId: string;
  agentId: string;
  /** The conversation whose saved model the host should judge. Absent uses the default. */
  threadId?: string;
  signal?: AbortSignal;
}) => Promise<AbortSignal>;

/**
 * The display components a Bot can draw in a turn with no browser, so it can still answer with a
 * chart. The server's catalog is `headlessComponentCatalog` in components/headless.ts.
 */
export type ComponentCatalog = {
  /** Every component's tool name, so a turn can tell which of its tool calls drew one. */
  names: ReadonlySet<string>;
  /** The component tools this Bot is offered, decided as the browser would decide them. */
  toolsForTurn: (input: {
    agentId: string;
    ownerUserId: string;
    initiator: AuditInitiator;
  }) => Promise<HeadlessTool[]>;
};

/**
 * The conversation's run lock.
 *
 * ONE RUN AT A TIME PER CONVERSATION, taken before anything is streamed. The platform hands the lock
 * out through an ordinary authenticated call and hands back the token that proves it: a run that
 * skips this and starts streaming is refused, because it is claiming to be a run nobody was told
 * about. That is what every delivery did before this existed, and the refusal read like a platform
 * limitation rather than a missing step.
 *
 * Taken with `NX`, so a conversation somebody else is already running in refuses rather than queues.
 * That is the right answer and the hop simply waits its turn: it is released back to the queue and
 * tried again, which is a wait rather than a failure.
 */
export type ThreadLock = {
  /**
   * The run id the platform issued, or null when somebody else is running in this conversation.
   *
   * ITS OWN ID, NOT THE ONE ASKED FOR. That id is what the gateway checks every streamed event
   * against, so a run that used the local one would be claiming to be a run nobody was told about.
   */
  acquire: (input: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    /** The run's analytics context, for the platform to record with the run. Never the agent's. */
    analyticsContext?: Record<string, unknown>;
  }) => Promise<{ runId: string } | null>;
  /** Keep it while the addressed Bot works. The lock expires on its own otherwise. */
  renew: (input: { threadId: string; runId: string }) => Promise<void>;
  /** Give it back, so the next run does not wait out the whole expiry. */
  release: (input: { threadId: string; runId: string }) => Promise<void>;
};

/**
 * The model a streamed event names, when it names one. A remote Bot chooses its own model, so the
 * stream is the only place a headless turn learns what it actually answered with.
 */
export type ModelObserver = (event: BaseEvent) => string | undefined;

/**
 * What the host does with a turn that answered, beyond handing back the reply.
 *
 * Called once, after the lock is released, and only for a turn that answered. The server writes the
 * usage row that names the turn's model (so a board card started off a timer still names one) and
 * reads back the files the Bot handed over. Whatever it returns as `attachments` rides on the reply.
 */
export type TurnAnswered = (input: {
  ownerUserId: string;
  agentId: string;
  threadId: string;
  /** The run id the turn locked and streamed under. */
  runId: string;
  /** The board card's own reference, when the caller keyed the card by something else. */
  runRef?: string;
  /** The tenant the caller named; absent, the host reads its own frame. */
  tenantId?: string;
  /** The first model the stream named, when one was. */
  observedModel?: string;
  /** The messages this turn added. */
  added: Message[];
}) => Promise<{ attachments?: string[] }>;

/**
 * Runs a whole turn inside whatever per-turn context the host keeps — on the server, whether the turn's
 * board card belongs to the caller (`cardOwnedByCaller`) or to the runner.
 */
export type TurnScope = <T>(
  input: { cardOwnedByCaller?: boolean },
  run: () => Promise<T>,
) => Promise<T>;
