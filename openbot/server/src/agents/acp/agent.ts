import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import type { AcpHarness } from "@openbot/shared/acp";
import { UnavailableAgent } from "@openbot/toolkit/copilotkit/agents";
import { eq } from "drizzle-orm";
import { Observable, type Subscriber } from "rxjs";
import type { Database } from "../../db/client";
import { threads } from "../../db/schema";
import type { DeviceChannel } from "../../devices/channel";
import { runAsTenant } from "../../tenant/context";
import { type AcpContextLoader, messageText } from "./context";
import type { AcpRelay } from "./relay";
import { createAcpTranslator } from "./translate";
import {
  type AcpTurnRow,
  type AcpTurnStore,
  isFinalAcpTurnStatus,
} from "./turns";

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
 * NOT REACHABLE, OR THE LANE IS BUSY. The turn stays queued and the run answers one sentence and
 * ends. When the computer is back (or the lane frees), the relay claims it and `startQueuedTurn`
 * (`createAcpTurnStarter`) posts it into the same thread as a run of its own, so its output lands
 * in the conversation like any other answer.
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
 * How long a headless turn of an external employee may run (a group turn): a turn waits for a
 * permission answer as long as the owner takes, so this is a backstop, not a budget.
 */
export const ACP_TURN_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

/**
 * A headless turn runner (a group's) that runs an external employee's turns on `external`, made with
 * `ACP_TURN_TIMEOUT_MS`, and every other Bot's on `normal`: the default five-minute deadline would
 * stop a turn that is only waiting for its owner's permission.
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
};

export type AcpPermissionHook = (request: AcpPermissionRequest) => void;

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
  waitingMs?: number;
  /** Calls `tick` every `ms` until the returned function is called. Injected for a test's clock. */
  every?: (ms: number, tick: () => void) => () => void;
  newTurnId?: () => string;
  log?: (message: string) => void;
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
  /** The heartbeat before found the turn over with no end told to this run. */
  private endedUnseen = false;

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
    const closing = [...this.translator.close(), ...events];
    for (const event of closing) this.emit(event);
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
      this.prompt = Array.isArray(config.claimed.prompt)
        ? config.claimed.prompt
        : [];
    } else {
      turnId = (config.newTurnId ?? randomUUID)();
      this.prompt = promptOf(input.messages);
      const turn = {
        tenantId: config.tenantId,
        agentId: config.agentId,
        threadId: input.threadId,
        deviceId: config.deviceId,
        turnId,
        prompt: this.prompt,
      };
      if (!config.reachable()) {
        await turns.enqueue(turn);
        this.queued(
          `${this.name}的电脑现在离线，这件活已排队，电脑回来后自动继续。`,
        );
        return;
      }
      await turns.enqueue(turn);
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
        );
        return;
      }
    }
    if (this.isOver()) {
      // Stopped while it was being claimed: cancelled. Merely let go of: back in its lane.
      if (this.aborted)
        await turns.setStatus(config.tenantId, turnId, "cancelled");
      else await turns.unclaim(config.tenantId, turnId);
      return;
    }
    this.turnId = turnId;
    this.unsubscribe = relay.subscribe(turnId, (frame) => this.onFrame(frame));
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
          ...(await config.context(input.threadId, input.runId)),
          ...this.prompt,
        ];
      } catch (error) {
        this.log(
          `the context of a new session could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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
  }

  /** The turn waits in its lane: said in one sentence, and the run is over. */
  private queued(text: string) {
    this.handle.reject(new Error("the turn is still queued"));
    this.finish([...this.note(text), this.finished()]);
  }

  /** The computer went away before the turn reached it: back in the queue, said so. */
  private async backToQueue() {
    const { turnId } = this;
    if (turnId)
      await this.config.turns
        .unclaim(this.config.tenantId, turnId)
        .catch(() => undefined);
    this.queued(
      `${this.name}的电脑现在离线，这件活已排队，电脑回来后自动继续。`,
    );
  }

  private onFrame(frame: Record<string, unknown>) {
    if (this.phase === "over") return;
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
        for (const event of this.translator.update(frame.update))
          this.emit(event);
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
    this.finish([this.finished()]);
  }

  /**
   * A turn that is over in the database whose end this run was never told (it reached another
   * server's relay, or ended in the moment before this run subscribed) ends the run all the same.
   * Seen on two heartbeats in a row, so the end the relay is delivering right after its write wins.
   */
  private async checkEnded() {
    const { turnId } = this;
    if (!turnId || (this.phase !== "opening" && this.phase !== "running"))
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
    if (turnId && this.phase === "running")
      this.config.relay.send(this.target, {
        type: "acp.cancel",
        agentId: this.config.agentId,
        threadId: this.input.threadId,
        turnId,
      });
    // Its prompt never went out: the device has nothing to cancel, the row is ended here.
    else if (turnId && this.phase === "opening")
      void this.config.turns
        .setStatus(this.config.tenantId, turnId, "cancelled")
        .catch(() => undefined);
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
    return new Observable<BaseEvent>((subscriber) => {
      const run = new AcpRun(this.config, input, subscriber, this.handle);
      this.current = run;
      run.start();
      return () => {
        run.dispose();
        if (this.current === run) this.current = undefined;
      };
    });
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
  /** Set by the permission bridge; read on every request, so it can be attached after boot. */
  onPermission?: AcpPermissionHook;
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

/**
 * The agent for one external employee, in a tenant: a `DeviceAcpAgent` on the installed runtime, or
 * an agent that refuses every run where none is installed.
 */
export function deviceAcpAgentFor(
  employee: DeviceAcpEmployee,
  options: { tenantId: string; claimed?: AcpTurnRow },
): AbstractAgent {
  const runtime = installed;
  if (!runtime)
    return new UnavailableAgent({
      id: employee.id,
      name: employee.name,
      reason: "外部员工在这台服务器上还不能运行。",
    });
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
    ...(options.claimed ? { claimed: options.claimed } : {}),
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
 * `startQueuedTurn` (relay.ts): a turn queued while the computer was away (or its lane busy), now
 * claimed, is posted into its own thread as a run of its own, through the runner a person's turn
 * runs through (as `queued-results.ts` posts a queued action's outcome), so its output is in the
 * transcript, the history the next turn reads, and on the board. Resolves once its prompt is on the
 * device; throws (the turn goes back in the queue, tried again on the next heartbeat) when the
 * thread is mid-run or the device went away again. An employee that is gone, has moved to another
 * computer, or a thread that is not that employee's in that tenant cancels the turn.
 *
 * Once the run is over, `announce` is told its answer (to bump the roster, or put it in a group's
 * shared transcript).
 */
export function createAcpTurnStarter(options: {
  database: Database;
  turns: AcpTurnStore;
  runner: AcpThreadRunner;
  employeeFor: (row: AcpTurnRow) => Promise<DeviceAcpEmployee | null>;
  agentFor?: (
    employee: DeviceAcpEmployee,
    row: AcpTurnRow,
  ) => AbstractAgent | DeviceAcpAgent;
  announce?: (input: {
    tenantId: string;
    agentId: string;
    threadId: string;
    ownerUserId: string;
    text: string;
  }) => Promise<void>;
  log?: (message: string) => void;
}): (row: AcpTurnRow) => Promise<void> {
  const { database, turns, runner } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const agentFor =
    options.agentFor ??
    ((employee: DeviceAcpEmployee, row: AcpTurnRow) =>
      deviceAcpAgentFor(employee, { tenantId: row.tenantId, claimed: row }));
  return (row) =>
    runAsTenant(row.tenantId, async () => {
      const employee = await options.employeeFor(row);
      const [thread] = await database
        .select({ agentId: threads.agentId, tenantId: threads.tenantId })
        .from(threads)
        .where(eq(threads.id, row.threadId))
        .limit(1);
      if (
        !employee ||
        employee.deviceId !== row.deviceId ||
        !thread ||
        thread.tenantId !== row.tenantId ||
        thread.agentId !== row.agentId
      ) {
        log(
          `acp: queued turn ${row.turnId} has no employee, computer or thread to run in any more; cancelled`,
        );
        await turns.setStatus(row.tenantId, row.turnId, "cancelled");
        return;
      }
      const agent = agentFor(employee, row);
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
      let runFailed!: (error: unknown) => void;
      const failed = new Promise<never>((_resolve, reject) => {
        runFailed = reject;
      });
      failed.catch(() => undefined);
      runner
        .run({
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
        })
        .subscribe({
          next: (event) => {
            const { delta } = event as { delta?: unknown };
            if (
              event.type === EventType.TEXT_MESSAGE_CONTENT &&
              typeof delta === "string"
            )
              said.push(delta);
          },
          error: (error) => runFailed(error),
          complete: () => {
            const text = said.join("").trim();
            if (!text || !options.announce) return;
            void runAsTenant(row.tenantId, () =>
              (options.announce as NonNullable<typeof options.announce>)({
                tenantId: row.tenantId,
                agentId: row.agentId,
                threadId: row.threadId,
                ownerUserId: employee.ownerUserId,
                text,
              }),
            ).catch((error: unknown) =>
              log(
                `acp: the answer of turn ${row.turnId} could not be announced: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          },
        });
      await Promise.race([agent.started, failed]);
    });
}
