import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import type { AcpHarness } from "../../../../shared/acp";
import { eq } from "drizzle-orm";
import { Observable, type Subscriber } from "rxjs";
import type { Database } from "../../db/client";
import { threads } from "../../db/schema";
import type { DeviceChannel } from "../../devices/channel";
import { dueSaidIn } from "../../tasks/due-time";
import { runAsTenant } from "../../tenant/context";
import { adoptRunnerCard } from "../../threads/postgres-runner";
import { withRunSideEvents } from "../../threads/run-side-events";
import { type AcpContextLoader, messageText } from "./context";
import type { AcpDelivery, AcpDeliveryTurn } from "./delivery";
import type { AcpRelay } from "./relay";
import { createAcpTranslator } from "./translate";
import {
  type AcpTurnRow,
  type AcpTurnStore,
  acpPromptOf,
  isFinalAcpTurnStatus,
} from "./turns";

export { acpPromptOf };

/**
 * The AG-UI transport of an external employee (`device_acp`: Codex, Claude Code, Hermes or the
 * owner's own agent, on the owner's computer). A run is one ACP turn on that computer, carried by
 * the runner socket's `acp.*` frames (relay.ts) and queued per employee and thread (turns.ts).
 *
 * REACHABLE. The turn is queued (`acp_turns`), and runs now only when it is its lane's next one
 * (the employee in this thread has nothing older queued or on the device) and this run claims it.
 * Then `acp.open` (with the session id the device last reported for the lane, so a new adapter
 * process can `session/load` it) and, once the device answers with the lane's `acp.session`,
 * `acp.prompt`. A session that is new (`loaded: false`) has none of the thread's earlier
 * conversation, so that prompt starts with XiongBao's context (context.ts): who the employee is,
 * the thread's last 20 messages, the task card. What comes back is translated into the thread's
 * own events (translate.ts) until `acp.turn.end`, which ends the run.
 *
 * NOT REACHABLE, OR THE LANE IS BUSY. The turn stays queued and the run answers one sentence
 * (`CUSTOM acp.queued`: its board card stays open) and ends. When the computer is back (or the lane
 * frees), the relay claims it and `startQueuedTurn` (`createAcpTurnStarter`) posts it into the same
 * thread as a run of its own, which finishes that card, so its output lands in the conversation like
 * any other answer. A computer connected to another server of this deployment is not "away": the
 * turn is started there, and the sentence says so. A group never waits for an external employee at
 * all (`createAcpGroupTurn`).
 *
 * AWAY. A computer whose network dropped while its turn is on it keeps running it (spec §3): the
 * run stays open, a permission request keeps waiting, and the device replays what it kept when it
 * reconnects (its inventory reconciles a turn its runner lost). Stop while it is away (and not
 * connected to another server) cancels the row here, so the lane's next message is not held.
 *
 * HOW A RUN ENDS. With the device's `acp.turn.end`: `RUN_FINISHED` (a cancelled turn says so first);
 * `stopReason: "error"` → `RUN_ERROR` with the device's own sentence (`acp.error`); interrupted (the
 * adapter's process went away, or reconciliation found the turn gone) → "电脑关机，这件活中断了。"
 * and `CUSTOM acp.interrupted {turnId, prompt}` (what the person asked, to send again as a new turn)
 * before `RUN_FINISHED`. One cancel can end several turns of one employee at once: each run ends
 * on its own turn's end. `ask_mode_lost` also drops the lane's remembered session, so the next
 * turn starts a fresh one.
 *
 * WAITING. An ACP turn can run for long stretches without a word (a long command, a permission
 * request waiting hours for the owner), so the run says `CUSTOM acp.waiting` every 20 seconds
 * while it is open: anything that watches a stream for silence sees it alive. A permission request
 * is handed to `onPermission` (the permission bridge, Task 7) with the run it belongs to.
 *
 * STOP. `abortRun` sends the device `acp.cancel` and ends the run here at once.
 */

/** How often an open run says it is still waiting. */
export const ACP_WAITING_MS = 20_000;

/**
 * How long a run that ended waits for the delivery loop's hand-in before it ends anyway: a write that
 * hangs (a pool with no connection left) must not leave the thread busy for good.
 */
export const ACP_DELIVERY_SETTLE_MS = 15_000;

/** Said when the hand-in was not settled within {@link ACP_DELIVERY_SETTLE_MS}. */
export const ACP_DELIVERY_LATE_NOTE =
  "这一轮的交付还在核对，结果以看板上这件活的状态为准。";
/** What `within` answers when the hand-in ran out of time. */
const LATE = Symbol("late");

/** `work`, or `fallback` once `ms` have passed without it. */
async function within<T>(
  work: Promise<T> | undefined,
  ms: number,
  fallback: T,
): Promise<T> {
  if (!work) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A group's turn runner: an external employee's turns go to `external` (`createAcpGroupTurn`, which
 * never holds the group's sweep), every other Bot's to `normal`.
 */
export function routeExternalTurns<
  Input extends { agentId: string },
  Output,
>(options: {
  isExternal: (agentId: string) => Promise<boolean>;
  normal: (input: Input) => Promise<Output>;
  external: (input: Input) => Promise<Output>;
}): (input: Input) => Promise<Output> {
  return async (input) =>
    (await options.isExternal(input.agentId))
      ? options.external(input)
      : options.normal(input);
}

/**
 * An external employee's turn in a group, ASYNCHRONOUS. A group answers its Bots one after another
 * on one sweep, and an external employee's turn can take hours (a permission answer the owner has
 * not given yet), so the group never waits for it: the turn is queued in the employee's own group
 * thread (its lane), the group is told at once that it started (`detached: true`: the group leaves
 * the turn's card open), and the relay starts it (`resumeQueued` now, else the next heartbeat).
 * `createAcpTurnStarter` runs it in that thread, finishes the card, and its answer reaches the group
 * through `announce` (the group's own share check). The prompt is the group's framed message: who
 * said what since, and who is in the group.
 */
export function createAcpGroupTurn(options: {
  turns: AcpTurnStore;
  relay: Pick<AcpRelay, "resumeQueued">;
  channel: Pick<DeviceChannel, "isReachable">;
  employeeFor: (agentId: string) => Promise<DeviceAcpEmployee | null>;
  onlineElsewhere?: (target: {
    tenantId: string;
    deviceId: string;
  }) => Promise<boolean>;
  newTurnId?: () => string;
  log?: (message: string) => void;
  /** The delivery loop's part for external employees (delivery.ts): work asked of it here is followed at once. */
  delivery?: Pick<AcpDelivery, "queued">;
}): (input: {
  agentId: string;
  threadId: string;
  instruction: string;
  userMessage?: Message;
  runId?: string;
  /** Who started the turn: a peer's hop (`handoff`) is a 转交, which the delivery loop does not follow. */
  initiator?: { kind: string };
}) => Promise<{ replyText: string; detached: true }> {
  const log = options.log ?? ((message: string) => console.warn(message));
  return async (input) => {
    const employee = await options.employeeFor(input.agentId);
    if (!employee) throw new Error("That Bot is not available to this owner.");
    /*
     * The turn is the employee's, in the tenant its hirer hired it and paired its computer in,
     * whoever asked in the group: that is where the relay finds its device's queue. The answer still
     * goes back to the group thread it was asked in (`announceExternal`).
     */
    const tenantId = employee.ownerUserId;
    const target = { tenantId, deviceId: employee.deviceId };
    const text = messageText(input.userMessage?.content) || input.instruction;
    await options.turns.enqueue({
      tenantId,
      agentId: employee.id,
      threadId: input.threadId,
      deviceId: employee.deviceId,
      turnId: (options.newTurnId ?? randomUUID)(),
      prompt: {
        content: [{ type: "text", text }],
        ...(input.runId ? { runRef: input.runId } : {}),
      },
    });
    /*
     * 派出 · 待接下 from the moment it is queued: the group's card for it (filed under its run id). Not a
     * peer's hop: 员工互相 @ 的转交 is not followed by itself (spec 2026-11-15-delivery-loop §1).
     */
    if (input.runId && input.initiator?.kind !== "handoff")
      await options.delivery?.queued(
        {
          tenantId,
          agentId: employee.id,
          threadId: input.threadId,
          runId: input.runId,
        },
        "group",
      );
    let replyText: string;
    if (options.channel.isReachable(target)) {
      replyText = `${employee.name}开始干这件活了，做完会在群里回复。`;
      void options.relay
        .resumeQueued(target)
        .catch((error: unknown) =>
          log(
            `acp: a group turn of ${employee.id} waits for the next heartbeat: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    } else if (
      await (options.onlineElsewhere?.(target) ?? Promise.resolve(false)).catch(
        () => false,
      )
    )
      replyText = `${employee.name}的这件活已排队，马上开始。`;
    else
      replyText = `${employee.name}的电脑现在离线，这件活已排队，电脑回来后自动继续。`;
    return { replyText, detached: true };
  };
}

/** A permission request of a turn, with the run it belongs to: what the permission bridge gets. */
export type AcpPermissionRequest = {
  frame: Record<string, unknown>;
  tenantId: string;
  ownerUserId: string;
  agentId: string;
  deviceId: string;
  threadId: string;
  turnId: string;
  runId: string;
  /**
   * The board card this turn answers for (`tasks.run_ref`), which is where its approval parks: the
   * run's own id, or, for a turn that waited in the queue (or was asked in a group), the card of the
   * run that queued it (`adoptRunnerCard`).
   */
  runRef: string;
  /** What this turn has done so far: the steps it finished and the files it changed. */
  progress?: { done: string[]; files: string[] };
  /** Says one sentence in the conversation while the run is open (a refusal, with its rule). */
  say?: (text: string) => void;
};

export type AcpPermissionHook = (request: AcpPermissionRequest) => void;

/**
 * A permission request of a turn no run carries (the relay's `permission`), as the bridge takes it:
 * the turn's tenant is its hirer's, and its approval parks on the card the turn answers for.
 */
export function acpPermissionRequestOf(
  row: AcpTurnRow,
  frame: Record<string, unknown>,
): AcpPermissionRequest {
  const runRef = acpPromptOf(row).runRef ?? `acp-${row.turnId}`;
  return {
    frame,
    tenantId: row.tenantId,
    ownerUserId: row.tenantId,
    agentId: row.agentId,
    deviceId: row.deviceId,
    threadId: row.threadId,
    turnId: row.turnId,
    runId: runRef,
    runRef,
  };
}

type AcpLane = { tenantId: string; agentId: string; threadId: string };

/**
 * The session id the device last reported for each lane (`acp.session`), sent back as the next
 * `acp.open`'s `sessionHint`. In this process only: after a restart the device's own memory (it
 * keeps each lane's session for its life) is what reuses a session; past that, a new one starts
 * and gets XiongBao's context.
 */
export type AcpSessionHints = {
  get(lane: AcpLane): string | undefined;
  set(lane: AcpLane, sessionId: string): void;
  drop(lane: AcpLane): void;
};

export function createAcpSessionHints(limit = 10_000): AcpSessionHints {
  const hints = new Map<string, string>();
  const key = (lane: AcpLane) =>
    JSON.stringify([lane.tenantId, lane.agentId, lane.threadId]);
  return {
    get: (lane) => hints.get(key(lane)),
    set(lane, sessionId) {
      const id = key(lane);
      hints.delete(id);
      hints.set(id, sessionId);
      if (hints.size > limit) {
        const oldest = hints.keys().next().value;
        if (oldest !== undefined) hints.delete(oldest);
      }
    },
    drop: (lane) => {
      hints.delete(key(lane));
    },
  };
}

export type DeviceAcpAgentConfig = {
  agentId: string;
  ownerUserId: string;
  tenantId: string;
  deviceId: string;
  harness: AcpHarness;
  workdirRef: string;
  appRef?: string;
  relay: AcpRelay;
  turns: AcpTurnStore;
  reachable: () => boolean;
  /** The context blocks a new session's first turn starts with (context.ts). */
  context: (threadId: string, runId?: string) => Promise<unknown[]>;
  /** For the sentences the run answers itself. */
  name?: string;
  sessions?: AcpSessionHints;
  onPermission?: AcpPermissionHook;
  /**
   * A turn the relay already claimed (`sent`): this run starts it instead of queueing a new one,
   * and `started` settles once its prompt is written (`startQueuedTurn`).
   */
  claimed?: AcpTurnRow;
  /**
   * With `claimed`: the turn is already on the device and no run follows it (the server restarted,
   * or its device reconnected here from another server). This run sends nothing: it follows the
   * turn from now on, and `started` settles once it does (the relay's `adoptTurn`).
   */
  adopted?: boolean;
  waitingMs?: number;
  /**
   * Whether the computer is connected to another server of this deployment (`reachable` asks only
   * this process). Absent: it is not.
   */
  onlineElsewhere?: () => Promise<boolean>;
  /** Calls `tick` every `ms` until the returned function is called. Injected for a test's clock. */
  every?: (ms: number, tick: () => void) => () => void;
  newTurnId?: () => string;
  log?: (message: string) => void;
  /**
   * The delivery loop's three steps, walked by the server for this employee (delivery.ts): the queued
   * turn's card followed when it is work handed to the employee (派活), the card's first prompt told the rules and taken on when it starts, the first
   * 「预计」 its due time, and what the turn changed handed in when it ends. Absent: none of it.
   */
  delivery?: AcpDelivery;
  /** How long the end waits for the hand-in ({@link ACP_DELIVERY_SETTLE_MS}). Injected for a test. */
  deliverySettleMs?: number;
};

const defaultEvery = (ms: number, tick: () => void) => {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** Whether the prompt of a run reached the device: what `startQueuedTurn` waits for. */
type StartHandle = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function startHandle(): StartHandle {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Nobody has to wait for it: a run that is not a claimed turn's never is.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** What the person asked: the last user message, as ACP content blocks. */
function promptOf(messages: readonly Message[]): unknown[] {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return [{ type: "text", text: messageText(last?.content) }];
}

const promptText = (prompt: unknown[]) =>
  prompt
    .map((block) =>
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter((text) => text !== "")
    .join("\n");

type OpenOutcome = "session" | "error" | "over";

/** One run: one turn, from queueing (or its claim) to its end. */
class AcpRun {
  private readonly translator: ReturnType<typeof createAcpTranslator>;
  private readonly lane: AcpLane;
  private readonly target: { tenantId: string; deviceId: string };
  private turnId: string | null = null;
  private prompt: unknown[] = [];
  private phase: "starting" | "opening" | "running" | "over" = "starting";
  private loaded = true;
  private openError: string | null = null;
  private turnError: string | null = null;
  private opened: ((outcome: OpenOutcome) => void) | null = null;
  private stopWaiting: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private notes = 0;
  private aborted = false;
  /** The board card this run answers for: its own, or the one the run that queued it left open. */
  private readonly cardRef: string;
  /** The heartbeat before found the turn over with no end told to this run. */
  private endedUnseen = false;
  /** What the turn has done, for a permission request's card: titles by tool call, steps done, files changed. */
  private readonly titles = new Map<string, string>();
  private readonly done: string[] = [];
  private readonly doneIds = new Set<string>();
  private readonly changed = new Set<string>();
  /** What the agent said in this turn (its own messages, not the sentences the run adds), for 「预计」 and 「自查」. */
  private reply = "";
  /** What the translator emitted, for the hand-in at the end (its `acp.diff`s). */
  private readonly produced: BaseEvent[] = [];
  /** The delivery loop's writes in flight, which the turn's end waits for. */
  private startedWrite: Promise<void> | undefined;
  private dueWrite: Promise<void> | undefined;
  private dueSeen = false;
  /** The turn ended and the run is settling its hand-in before it finishes. */
  private ending = false;

  constructor(
    private readonly config: DeviceAcpAgentConfig,
    private readonly input: RunAgentInput,
    private readonly subscriber: Subscriber<BaseEvent>,
    private readonly handle: StartHandle,
  ) {
    this.translator = createAcpTranslator({ idPrefix: input.runId });
    this.lane = {
      tenantId: config.tenantId,
      agentId: config.agentId,
      threadId: input.threadId,
    };
    this.target = { tenantId: config.tenantId, deviceId: config.deviceId };
    this.cardRef =
      (config.claimed ? acpPromptOf(config.claimed).runRef : undefined) ??
      input.runId;
  }

  private log(message: string) {
    (this.config.log ?? ((line: string) => console.warn(line)))(
      `acp agent ${this.config.agentId}: ${message}`,
    );
  }

  private emit(event: BaseEvent) {
    if (this.phase === "over" || this.subscriber.closed) return;
    this.subscriber.next(event);
  }

  private note(text: string): BaseEvent[] {
    this.notes += 1;
    const messageId = `${this.input.runId}-acp-note-${this.notes}`;
    return [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text,
      } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
    ];
  }

  /** Ends the run: whatever the translator holds open, then `events`, then the stream. */
  private finish(events: BaseEvent[]) {
    if (this.phase === "over") return;
    for (const event of this.translator.close()) this.out(event);
    for (const event of events) this.emit(event);
    this.release();
    this.phase = "over";
    if (!this.subscriber.closed) this.subscriber.complete();
  }

  private finished(): BaseEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
    } as BaseEvent;
  }

  private release() {
    this.stopWaiting?.();
    this.stopWaiting = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const opened = this.opened;
    this.opened = null;
    opened?.("over");
  }

  /** Asked after an await, where the phase may have moved under the narrowing. */
  private isOver(): boolean {
    return this.phase === "over";
  }

  private get name() {
    return this.config.name?.trim() || "这位外部员工";
  }

  /** This run as the delivery loop's hooks know it. */
  private get deliveryTurn(): AcpDeliveryTurn {
    return {
      tenantId: this.config.tenantId,
      agentId: this.config.agentId,
      threadId: this.input.threadId,
      runId: this.input.runId,
      ...(this.cardRef !== this.input.runId ? { cardRef: this.cardRef } : {}),
    };
  }

  /** The turn is on the computer: the delivery loop takes the work on (once per card) and hangs this round on it. */
  private startedOnCard() {
    const { delivery } = this.config;
    if (delivery) this.startedWrite = delivery.started(this.deliveryTurn);
  }

  /**
   * An event the agent's own words produced (the translator's), on its way out: its text is kept for
   * the delivery loop, and a message that closes with a 「预计」 in it reports the turn's due time.
   */
  private out(event: BaseEvent) {
    this.produced.push(event);
    const { delta } = event as { delta?: unknown };
    if (
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      typeof delta === "string"
    )
      this.reply += delta;
    else if (event.type === EventType.TEXT_MESSAGE_END) {
      this.reply += "\n";
      const { delivery } = this.config;
      const due = delivery && !this.dueSeen ? dueSaidIn(this.reply) : undefined;
      if (delivery && due) {
        this.dueSeen = true;
        const turn = this.deliveryTurn;
        this.dueWrite = Promise.resolve(this.startedWrite).then(() =>
          delivery.reported(turn, due),
        );
      }
    }
    this.emit(event);
  }

  start() {
    this.emit({
      type: EventType.RUN_STARTED,
      threadId: this.input.threadId,
      runId: this.input.runId,
    } as BaseEvent);
    const waitingMs = this.config.waitingMs ?? ACP_WAITING_MS;
    this.stopWaiting = (this.config.every ?? defaultEvery)(waitingMs, () => {
      this.emit({
        type: EventType.CUSTOM,
        name: "acp.waiting",
        value: { turnId: this.turnId },
      } as BaseEvent);
      void this.checkEnded();
    });
    this.begin().catch((error: unknown) => {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.log(`the run failed: ${reason.message}`);
      this.handle.reject(reason);
      this.finish([
        {
          type: EventType.RUN_ERROR,
          message: `${this.name}这一轮没能开始，请稍后再试。`,
        } as BaseEvent,
      ]);
    });
  }

  private async begin() {
    const { config, input } = this;
    const { turns, relay } = config;
    let turnId: string;
    if (config.claimed) {
      turnId = config.claimed.turnId;
      this.prompt = acpPromptOf(config.claimed).content;
    } else {
      turnId = (config.newTurnId ?? randomUUID)();
      this.prompt = promptOf(input.messages);
      const turn = {
        tenantId: config.tenantId,
        agentId: config.agentId,
        threadId: input.threadId,
        deviceId: config.deviceId,
        turnId,
        // This run's card waits for the run that does the work (`acp.queued`, `adoptRunnerCard`).
        prompt: { content: this.prompt, runRef: input.runId },
      };
      if (!config.reachable()) {
        await turns.enqueue(turn);
        await config.delivery?.queued(this.deliveryTurn, "conversation");
        if (this.aborted) {
          await turns.setStatus(config.tenantId, turnId, "cancelled");
          return;
        }
        this.queued(
          (await this.onlineElsewhere())
            ? `${this.name}的这件活已排队，马上开始。`
            : `${this.name}的电脑现在离线，这件活已排队，电脑回来后自动继续。`,
          turnId,
        );
        return;
      }
      await turns.enqueue(turn);
      /*
       * Work handed to it (派活) is 派出 · 待接下 from the moment it is queued, whether it starts now or
       * waits; a question asked in its own conversation is not followed (`AcpDelivery.queued`).
       */
      await config.delivery?.queued(this.deliveryTurn, "conversation");
      const next = await turns.nextForThread(
        config.tenantId,
        input.threadId,
        config.agentId,
      );
      if (
        next?.turnId !== turnId ||
        !(await turns.claim(config.tenantId, turnId))
      ) {
        this.queued(
          `${this.name}在这个对话里还有一件活没做完，这件活已排队，前面的做完后自动继续。`,
          turnId,
        );
        return;
      }
    }
    if (this.isOver()) {
      // An adopted turn is the device's: nothing to put back, and a stop already told the device.
      if (config.adopted) return;
      // Stopped while it was being claimed: cancelled. Merely let go of: back in its lane.
      if (this.aborted)
        await turns.setStatus(config.tenantId, turnId, "cancelled");
      else await turns.unclaim(config.tenantId, turnId);
      return;
    }
    this.turnId = turnId;
    this.unsubscribe = relay.subscribe(turnId, (frame) => this.onFrame(frame), {
      run: true,
    });
    if (config.adopted) {
      // Already on the device: what it does from here on comes to this run.
      this.phase = "running";
      this.handle.resolve();
      this.startedOnCard();
      return;
    }
    this.phase = "opening";
    const opened = new Promise<OpenOutcome>((resolve) => {
      this.opened = resolve;
    });
    const sessionHint = config.sessions?.get(this.lane);
    const open = {
      type: "acp.open",
      agentId: config.agentId,
      threadId: input.threadId,
      harness: config.harness,
      workdirRef: config.workdirRef,
      ...(config.appRef ? { appRef: config.appRef } : {}),
      ...(sessionHint ? { sessionHint } : {}),
    };
    if (!relay.send(this.target, open)) return this.backToQueue();
    const outcome = await opened;
    if (outcome === "over" || this.isOver()) return;
    let content = this.prompt;
    if (outcome === "session" && !this.loaded) {
      try {
        content = [
          ...(await config.context(input.threadId, this.cardRef)),
          ...this.prompt,
        ];
      } catch (error) {
        this.log(
          `the context of a new session could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // The card's first round is told the rules first (once per card, whatever the session).
    const rules = await config.delivery?.opening(this.deliveryTurn);
    if (rules) content = [{ type: "text", text: rules }, ...content];
    if (this.phase !== "opening") return;
    const sent = relay.send(this.target, {
      type: "acp.prompt",
      agentId: config.agentId,
      threadId: input.threadId,
      turnId,
      content,
    });
    if (!sent) return this.backToQueue();
    this.phase = "running";
    this.handle.resolve();
    this.startedOnCard();
  }

  /**
   * The turn waits in its lane: said in one sentence, and the run is over. `acp.queued` tells the
   * thread runner to leave this run's card open for the run that will do the work.
   */
  private queued(text: string, turnId: string | null = this.turnId) {
    this.handle.reject(new Error("the turn is still queued"));
    // Stopped while the sentence was being decided: the queued row goes too.
    if (this.aborted && turnId) {
      void this.config.turns
        .setStatus(this.config.tenantId, turnId, "cancelled")
        .catch(() => undefined);
      return;
    }
    this.finish([
      ...this.note(text),
      {
        type: EventType.CUSTOM,
        name: "acp.queued",
        value: { turnId: this.turnId },
      } as BaseEvent,
      this.finished(),
    ]);
  }

  /** Connected to another server of this deployment (its socket is there): it will be started there. */
  private async onlineElsewhere(): Promise<boolean> {
    try {
      return (await this.config.onlineElsewhere?.()) ?? false;
    } catch {
      return false;
    }
  }

  /** The computer went away before the turn reached it: back in the queue, said so. */
  private async backToQueue() {
    const { turnId } = this;
    if (turnId)
      await this.config.turns
        .unclaim(this.config.tenantId, turnId)
        .catch(() => undefined);
    this.queued(
      (await this.onlineElsewhere())
        ? `${this.name}的这件活已排队，马上开始。`
        : `${this.name}的电脑现在离线，这件活已排队，电脑回来后自动继续。`,
    );
  }

  private onFrame(frame: Record<string, unknown>) {
    if (this.phase === "over" || this.ending) return;
    switch (frame.type) {
      case "acp.session": {
        const sessionId = str(frame.sessionId);
        if (sessionId) this.config.sessions?.set(this.lane, sessionId);
        if (this.phase === "opening" && this.opened) {
          this.loaded = frame.loaded === true;
          const opened = this.opened;
          this.opened = null;
          opened("session");
        }
        return;
      }
      case "acp.error": {
        const message = str(frame.message) ?? "外部员工没能完成这件活。";
        if (frame.turnId === undefined) {
          // The open's: the prompt still goes, and the device ends the turn with an error.
          if (this.phase === "opening" && this.opened) {
            this.openError = message;
            const opened = this.opened;
            this.opened = null;
            opened("error");
          }
          return;
        }
        if (frame.code === "bad_option") {
          this.log(`turn ${this.turnId}: ${message}`);
          return;
        }
        if (frame.code === "ask_mode_lost")
          this.config.sessions?.drop(this.lane);
        this.turnError = message;
        return;
      }
      case "acp.update":
        this.track(frame.update);
        for (const event of this.translator.update(frame.update)) {
          this.trackDiff(event);
          this.out(event);
        }
        return;
      case "acp.permission.request": {
        const requestId = str(frame.requestId);
        this.emit({
          type: EventType.CUSTOM,
          name: "acp.waiting",
          value: { turnId: this.turnId, requestId },
        } as BaseEvent);
        try {
          this.config.onPermission?.({
            frame,
            tenantId: this.config.tenantId,
            ownerUserId: this.config.ownerUserId,
            agentId: this.config.agentId,
            deviceId: this.config.deviceId,
            threadId: this.input.threadId,
            turnId: this.turnId as string,
            runId: this.input.runId,
            runRef: this.cardRef,
            progress: { done: [...this.done], files: [...this.changed] },
            say: (text) => this.say(text),
          });
        } catch (error) {
          this.log(
            `the permission hook threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      case "acp.turn.end":
        this.end(frame);
        return;
      default:
        return;
    }
  }

  /** A step the agent finished, by its tool call's title. */
  private track(update: unknown) {
    const value =
      update && typeof update === "object" && !Array.isArray(update)
        ? (update as Record<string, unknown>)
        : null;
    if (
      value?.sessionUpdate !== "tool_call" &&
      value?.sessionUpdate !== "tool_call_update"
    )
      return;
    const id = str(value.toolCallId);
    if (!id) return;
    const title = str(value.title);
    if (title && (this.titles.has(id) || this.titles.size < 1000))
      this.titles.set(id, title);
    if (value.status !== "completed" || this.doneIds.has(id)) return;
    this.doneIds.add(id);
    const step = this.titles.get(id);
    if (!step) return;
    this.done.push(step);
    if (this.done.length > 50) this.done.shift();
  }

  /** A file the turn changed (`acp.diff`). */
  private trackDiff(event: BaseEvent) {
    const { name, value } = event as { name?: unknown; value?: unknown };
    if (event.type !== EventType.CUSTOM || name !== "acp.diff") return;
    const files = (value as { files?: unknown } | undefined)?.files;
    if (!Array.isArray(files)) return;
    for (const file of files) {
      const path = str((file as { path?: unknown } | null)?.path);
      if (path && this.changed.size < 200) this.changed.add(path);
    }
  }

  /** One sentence in the conversation while the run is open. */
  private say(text: string) {
    if (this.phase === "over") return;
    for (const event of this.translator.pause()) this.out(event);
    for (const event of this.note(text)) this.emit(event);
  }

  private end(frame: Record<string, unknown>) {
    // Over before its prompt was written (reconciled away): there is nothing to put back.
    this.handle.resolve();
    if (frame.interrupted === true) {
      this.finish([
        ...this.note("电脑关机，这件活中断了。"),
        {
          type: EventType.CUSTOM,
          name: "acp.interrupted",
          value: { turnId: this.turnId, prompt: promptText(this.prompt) },
        } as BaseEvent,
        this.finished(),
      ]);
      return;
    }
    if (frame.stopReason === "error") {
      this.finish([
        {
          type: EventType.RUN_ERROR,
          message:
            this.turnError ?? this.openError ?? `${this.name}没能完成这件活。`,
        } as BaseEvent,
      ]);
      return;
    }
    if (frame.stopReason === "cancelled") {
      this.finish([...this.note("这件活已取消。"), this.finished()]);
      return;
    }
    const { delivery } = this.config;
    if (!delivery) {
      this.finish([this.finished()]);
      return;
    }
    // The hand-in is settled before the run ends: the round is still the card's until then.
    this.ending = true;
    for (const event of this.translator.close()) this.out(event);
    const turn = this.deliveryTurn;
    const cap = this.config.deliverySettleMs ?? ACP_DELIVERY_SETTLE_MS;
    void (async () => {
      const sentence = await within<string | undefined | typeof LATE>(
        (async () => {
          await this.startedWrite;
          await this.dueWrite;
          return delivery.ended(turn, {
            events: this.produced,
            reply: this.reply,
            name: this.name,
          });
        })(),
        cap,
        LATE,
      );
      if (this.isOver()) return;
      if (sentence === LATE)
        this.log(
          `turn ${this.turnId}: the hand-in took over ${cap}ms; the run ended without waiting for it`,
        );
      // Too slow to wait for: said, so a card that moves later (or does not) is not a surprise.
      const said = sentence === LATE ? ACP_DELIVERY_LATE_NOTE : sentence;
      this.finish([...(said ? this.note(said) : []), this.finished()]);
    })();
  }

  /**
   * A turn that is over in the database whose end this run was never told (it reached another
   * server's relay, or ended in the moment before this run subscribed) ends the run all the same.
   * Seen on two heartbeats in a row, so the end the relay is delivering right after its write wins.
   */
  private async checkEnded() {
    const { turnId } = this;
    if (
      !turnId ||
      this.ending ||
      (this.phase !== "opening" && this.phase !== "running")
    )
      return;
    let status: string | undefined;
    try {
      status = (await this.config.turns.get(this.config.tenantId, turnId))
        ?.status;
    } catch {
      return;
    }
    if (!status || !isFinalAcpTurnStatus(status)) {
      this.endedUnseen = false;
      return;
    }
    if (!this.endedUnseen) {
      this.endedUnseen = true;
      return;
    }
    if (this.isOver()) return;
    this.log(`turn ${turnId} is ${status} with no end told to this run`);
    this.end({
      type: "acp.turn.end",
      turnId,
      stopReason:
        status === "cancelled"
          ? "cancelled"
          : status === "interrupted"
            ? "interrupted"
            : "end_turn",
      interrupted: status === "interrupted",
    });
  }

  /** Stop: the device is told to cancel, and the run ends here now. */
  abort() {
    if (this.phase === "over") return;
    this.aborted = true;
    const { turnId } = this;
    const cancelHere = (id: string) =>
      void this.config.turns
        .setStatus(this.config.tenantId, id, "cancelled")
        .catch(() => undefined);
    if (turnId && this.phase === "running") {
      const sent = this.config.relay.send(this.target, {
        type: "acp.cancel",
        agentId: this.config.agentId,
        threadId: this.input.threadId,
        turnId,
      });
      // Not connected here, nor to another server: ended here, so the lane's next message is not
      // held behind it. Connected elsewhere, the turn is left to the device (no cross-server cancel).
      if (!sent)
        void this.onlineElsewhere().then((elsewhere) => {
          if (!elsewhere) cancelHere(turnId);
        });
    }
    // Its prompt never went out: the device has nothing to cancel, the row is ended here.
    else if (turnId && this.phase === "opening") cancelHere(turnId);
    this.handle.reject(new Error("the run was stopped"));
    this.finish([...this.note("这件活已停止。"), this.finished()]);
  }

  /** The consumer went away: nothing more is said, the turn itself is left to the device. */
  dispose() {
    if (this.phase === "over") return;
    this.release();
    this.phase = "over";
  }
}

export class DeviceAcpAgent extends AbstractAgent {
  private config: DeviceAcpAgentConfig;
  private handle: StartHandle;
  private current: AcpRun | undefined;

  constructor(config: DeviceAcpAgentConfig) {
    super({
      agentId: config.agentId,
      ...(config.name ? { description: config.name } : {}),
    });
    this.config = config;
    this.handle = startHandle();
  }

  /** For a claimed turn: settles once its prompt is written to the device (or it could not be). */
  get started(): Promise<void> {
    return this.handle.promise;
  }

  /** The device this employee works on is connected to this server now. */
  reachable(): boolean {
    return this.config.reachable();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    /*
     * With room for the server's own events (the delivery loop's cards, `emitRunEvent`), and what the
     * run carried so far readable by the evidence gate (`runEventsSoFar`), as for a built-in coworker.
     */
    return withRunSideEvents(
      input.runId,
      new Observable<BaseEvent>((subscriber) => {
        const run = new AcpRun(this.config, input, subscriber, this.handle);
        this.current = run;
        run.start();
        return () => {
          run.dispose();
          if (this.current === run) this.current = undefined;
        };
      }),
    );
  }

  override abortRun(): void {
    this.current?.abort();
    super.abortRun();
  }

  /** Carried by hand: the base clone copies only the base class's own fields. */
  override clone(): DeviceAcpAgent {
    const cloned = super.clone() as DeviceAcpAgent;
    cloned.config = this.config;
    cloned.handle = this.handle;
    cloned.current = undefined;
    return cloned;
  }
}

/** An external employee as the runtime knows it: what `deviceAcpAgentFor` builds a run from. */
export type DeviceAcpEmployee = {
  id: string;
  name: string;
  ownerUserId: string;
  deviceId: string;
  harness: AcpHarness;
  workdirRef: string;
  appRef?: string;
  /** Who it is in the team, for a new session's context (`acpPersonaText`). */
  persona: string;
};

/** What this server runs external employees with, handed over once at boot. */
export type DeviceAcpRuntime = {
  relay: AcpRelay;
  turns: AcpTurnStore;
  channel: Pick<DeviceChannel, "isReachable">;
  sessions: AcpSessionHints;
  context: AcpContextLoader;
  /** Whether a device is connected to another server of this deployment. */
  onlineElsewhere?: (target: {
    tenantId: string;
    deviceId: string;
  }) => Promise<boolean>;
  /** Set by the permission bridge; read on every request, so it can be attached after boot. */
  onPermission?: AcpPermissionHook;
  /** The delivery loop's part (delivery.ts), attached once the loop exists; read when an agent is built. */
  delivery?: AcpDelivery;
};

let installed: DeviceAcpRuntime | null = null;

/**
 * Hand the transport its dependencies, once (same seam as `useSkillAssetTools`): the runtime builds
 * agents deep inside `copilot.ts`, which has never held the relay or the database. `null` lets a
 * test uninstall again.
 */
export function useDeviceAcp(runtime: DeviceAcpRuntime | null): void {
  installed = runtime;
}

/** The installed runtime, for wiring that attaches to it (the permission bridge). */
export function deviceAcpRuntime(): DeviceAcpRuntime | null {
  return installed;
}

/** What a run of an external employee is refused with where no runtime is installed. */
export const ACP_UNAVAILABLE_REASON = "外部员工在这台服务器上还不能运行。";

/**
 * The agent for one external employee, in a tenant: a `DeviceAcpAgent` on the installed runtime, or
 * null where none is installed (the caller refuses the run, `ACP_UNAVAILABLE_REASON`).
 */
export function deviceAcpAgentFor(
  employee: DeviceAcpEmployee,
  options: { tenantId: string; claimed?: AcpTurnRow; adopted?: boolean },
): DeviceAcpAgent | null {
  const runtime = installed;
  if (!runtime) return null;
  const { tenantId } = options;
  const target = { tenantId, deviceId: employee.deviceId };
  return new DeviceAcpAgent({
    agentId: employee.id,
    ownerUserId: employee.ownerUserId,
    tenantId,
    deviceId: employee.deviceId,
    harness: employee.harness,
    workdirRef: employee.workdirRef,
    ...(employee.appRef ? { appRef: employee.appRef } : {}),
    name: employee.name,
    relay: runtime.relay,
    turns: runtime.turns,
    reachable: () => runtime.channel.isReachable(target),
    ...(runtime.onlineElsewhere
      ? {
          onlineElsewhere: () =>
            (
              runtime.onlineElsewhere as NonNullable<
                DeviceAcpRuntime["onlineElsewhere"]
              >
            )(target),
        }
      : {}),
    context: (threadId, runId) =>
      runtime.context({
        tenantId,
        agentId: employee.id,
        threadId,
        ...(runId ? { runId } : {}),
        persona: employee.persona,
      }),
    sessions: runtime.sessions,
    onPermission: (request) => runtime.onPermission?.(request),
    ...(runtime.delivery ? { delivery: runtime.delivery } : {}),
    ...(options.claimed ? { claimed: options.claimed } : {}),
    ...(options.claimed && options.adopted ? { adopted: true } : {}),
  });
}

/** Just enough of the deployment's thread runner (`threads/postgres-runner.ts`) to post one run. */
export type AcpThreadRunner = {
  hydrate: () => Promise<void>;
  isRunning: (request: { threadId: string }) => Promise<boolean>;
  getThreadMessages: (threadId: string) => Message[];
  run: (request: {
    threadId: string;
    agent: AbstractAgent;
    input: {
      threadId: string;
      runId: string;
      messages: Message[];
      tools: [];
      context: [];
      state: Record<string, never>;
      forwardedProps: Record<string, never>;
    };
  }) => Observable<BaseEvent>;
};

/**
 * `startQueuedTurn` (relay.ts): a turn queued while the computer was away (or its lane busy, or by
 * a group, which never waits for an external employee: `createAcpGroupTurn`), now claimed, is posted
 * into its own thread as a run of its own, through the runner a person's turn runs through (as
 * `queued-results.ts` posts a queued action's outcome), so its output is in the transcript, the
 * history the next turn reads, and on the board, where it finishes the card of the run that queued
 * it (`adoptRunnerCard`): one card for one piece of work. Resolves once its prompt is on the device;
 * throws (the turn goes back in the queue, tried again on the next heartbeat) when the thread is
 * mid-run or the device went away again. An employee that is gone or moved to another computer, or
 * a thread that is another tenant's or another employee's, cancels the turn (`abandoned` is told,
 * to close the card it left open).
 *
 * Once the run is over, `announce` is told its answer, or that it failed (to bump the roster, or put
 * it in a group's shared transcript). A run that only found the turn queued again says nothing.
 *
 * `adopt` (the relay's `adoptTurn`): the same, for a turn ALREADY ON THE DEVICE that no run of this
 * process follows (after a restart, or a reconnect from another server). The run sends nothing: it
 * follows the turn from now on, finishes the card the turn answers for, and its answer is announced
 * the same way. Resolves true once it follows the turn; false, changing nothing, when the turn has no
 * employee, computer or thread to go on in (the relay then cancels it); throws when the thread is
 * mid-run here (tried again on the device's next replay).
 */
export type AcpTurnStarter = ((row: AcpTurnRow) => Promise<void>) & {
  adopt: (row: AcpTurnRow) => Promise<boolean>;
};

export function createAcpTurnStarter(options: {
  database: Database;
  turns: AcpTurnStore;
  runner: AcpThreadRunner;
  employeeFor: (row: AcpTurnRow) => Promise<DeviceAcpEmployee | null>;
  agentFor?: (
    employee: DeviceAcpEmployee,
    row: AcpTurnRow,
    adopted: boolean,
  ) => AbstractAgent | DeviceAcpAgent | null;
  announce?: (input: {
    tenantId: string;
    agentId: string;
    threadId: string;
    ownerUserId: string;
    text: string;
    failed: boolean;
  }) => Promise<void>;
  abandoned?: (row: AcpTurnRow, runRef: string | undefined) => Promise<void>;
  log?: (message: string) => void;
}): AcpTurnStarter {
  const { database, turns, runner } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const agentFor =
    options.agentFor ??
    ((employee: DeviceAcpEmployee, row: AcpTurnRow, adopted: boolean) =>
      deviceAcpAgentFor(employee, {
        tenantId: row.tenantId,
        claimed: row,
        adopted,
      }));
  /** False: the turn has nowhere to go on (not started, nothing changed). */
  const post = (row: AcpTurnRow, adopted: boolean): Promise<boolean> =>
    runAsTenant(row.tenantId, async () => {
      const { runRef } = acpPromptOf(row);
      const employee = await options.employeeFor(row);
      const [thread] = await database
        .select({ agentId: threads.agentId, tenantId: threads.tenantId })
        .from(threads)
        .where(eq(threads.id, row.threadId))
        .limit(1);
      // A thread not stored yet (an employee's first turn in a group) is made by the run itself.
      if (
        !employee ||
        employee.deviceId !== row.deviceId ||
        (thread &&
          (thread.tenantId !== row.tenantId || thread.agentId !== row.agentId))
      ) {
        if (adopted) return false;
        log(
          `acp: queued turn ${row.turnId} has no employee, computer or thread to run in any more; cancelled`,
        );
        await turns.setStatus(row.tenantId, row.turnId, "cancelled");
        await options.abandoned?.(row, runRef)?.catch(() => undefined);
        return false;
      }
      const agent = agentFor(employee, row, adopted);
      if (!(agent instanceof DeviceAcpAgent))
        throw new Error("external employees cannot run on this server");
      await runner.hydrate();
      if (await runner.isRunning({ threadId: row.threadId }))
        throw new Error(`thread ${row.threadId} is mid-run`);
      const history = runner.getThreadMessages(row.threadId);
      agent.threadId = row.threadId;
      agent.setMessages(history);
      const runId = `acp-${row.turnId}-${randomUUID().slice(0, 8)}`;
      const said: string[] = [];
      let error: string | null = null;
      let queuedAgain = false;
      let prompted = false;
      agent.started.then(
        () => {
          prompted = true;
        },
        () => undefined,
      );
      let runFailed!: (error: unknown) => void;
      const failed = new Promise<never>((_resolve, reject) => {
        runFailed = reject;
      });
      failed.catch(() => undefined);
      const tell = (text: string, failedRun: boolean) => {
        if (!options.announce) return;
        void runAsTenant(row.tenantId, () =>
          (options.announce as NonNullable<typeof options.announce>)({
            tenantId: row.tenantId,
            agentId: row.agentId,
            threadId: row.threadId,
            ownerUserId: employee.ownerUserId,
            text,
            failed: failedRun,
          }),
        ).catch((reason: unknown) =>
          log(
            `acp: the answer of turn ${row.turnId} could not be announced: ${reason instanceof Error ? reason.message : String(reason)}`,
          ),
        );
      };
      const start = () =>
        runner.run({
          threadId: row.threadId,
          agent,
          input: {
            threadId: row.threadId,
            runId,
            messages: history,
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
        });
      (runRef ? adoptRunnerCard(runRef, start) : start()).subscribe({
        next: (event) => {
          const { delta, message, name } = event as {
            delta?: unknown;
            message?: unknown;
            name?: unknown;
          };
          if (
            event.type === EventType.TEXT_MESSAGE_CONTENT &&
            typeof delta === "string"
          )
            said.push(delta);
          else if (event.type === EventType.RUN_ERROR)
            error =
              typeof message === "string" && message
                ? message
                : `${employee.name}没能完成这件活。`;
          else if (event.type === EventType.CUSTOM && name === "acp.queued")
            queuedAgain = true;
        },
        error: (reason) => {
          runFailed(reason);
          // Before its prompt went out it goes back in the queue and is tried again: nothing to say.
          if (prompted) tell(`${employee.name}没能完成这件活。`, true);
        },
        complete: () => {
          runFailed(new Error("the run ended before its prompt was written"));
          // Before its prompt went out the turn is back in the queue: nothing to say yet.
          if (queuedAgain || !prompted) return;
          const text = said.join("").trim();
          if (error) tell(text ? `${text}\n\n${error}` : error, true);
          else if (text) tell(text, false);
        },
      });
      await Promise.race([agent.started, failed]);
      return true;
    });
  const starter = (async (row: AcpTurnRow) => {
    await post(row, false);
  }) as AcpTurnStarter;
  starter.adopt = (row) => post(row, true);
  return starter;
}
