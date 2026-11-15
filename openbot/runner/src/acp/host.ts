import { randomUUID } from "node:crypto";
import type {
  AcpErrorCode,
  AcpHarness,
  AcpOpenFrame,
  AcpPermissionRequestFrame,
  AcpTurnEndFrame,
} from "../../../shared/acp";
import { IDLE_MS } from "../app-host";
import type { AppEntry } from "../apps";
import {
  type AcpClient,
  type AcpHandlers,
  type AcpPermissionAnswer,
  type AcpSpawnSpec,
  createAcpClient,
} from "./client";
import { adapterLaunch } from "./manifest";
import { permissionFacts } from "./paths";

/**
 * The device side of the external employees' session channel (spec §3): the `acp.*` frames the
 * server sends down the runner socket are turned into ACP calls on the employee's adapter, and what
 * the adapter says comes back up as `acp.*` frames.
 *
 * ONE PROCESS PER EMPLOYEE, ONE SESSION PER THREAD. An employee's adapter is started on the first
 * `acp.open` (or the first turn after it went away) and closed after `idleMs` with no turn running,
 * as the MCP bridge closes its apps (`IDLE_MS`). Each XiongBao thread gets its own ACP session in
 * that process. Turns of one thread run one after another; turns of different threads, and of
 * different employees, run side by side.
 *
 * WHAT STARTS. Codex, Claude Code and Hermes are started only from `adapterLaunch` (manifest.ts),
 * which carries the mode that makes them ask before acting; an owner's own agent (`custom`) from the
 * app the owner registered on this machine (`app_…`), with no session mode. The working folder is a
 * root the owner shared (`fld_…`). Both references are looked up on every start, so a folder or app
 * removed a moment ago is refused, and nothing is spawned for a reference this machine does not
 * have. No path or command ever comes from the server, and none goes back up: errors are generic
 * Chinese sentences, and permission facts carry only folder-relative paths (paths.ts).
 *
 * THE HOST OUTLIVES CONNECTIONS. The runner `attach`es each connection's sender and `detach`es it
 * when the connection closes; adapters and turns keep running in between. A socket can look open
 * for minutes after a laptop slept or changed network, and what is sent on it then is lost, so a
 * sent frame is not taken as delivered: every frame of a turn not over yet is kept, sent or not,
 * and every `attach` replays all kept frames in the order they were made (the server drops repeats
 * by `(turnId, seq)`). Once a turn has ended, all its kept frames (its end included) stay until one
 * `attach` has replayed them, then the turn is forgotten; a frame of no turn (`acp.session`, an
 * open's `acp.error`) is kept the same way. Past `bufferLimit` updates or bytes for one turn, that turn's
 * kept updates are compacted to the latest plan and each tool call's last state (its `tool_call`
 * and updates merged into one); after that, updates of other kinds still go up live but are not
 * kept, and only a plan or tool-call update compacts again. Acks, ends, sessions and errors are
 * never compacted away. A permission request still waiting for its answer is sent again after the
 * replay on every `attach`, with the same `requestId`; an answer naming an option the agent did not
 * offer is answered `cancelled` and reported as `acp.error` `bad_option`.
 *
 * TURNS. `acp.turn.ack` goes up as soon as a turn arrives; a `turnId` seen before is acknowledged
 * (and, when over, ended) again but never run twice. A turn ends with the agent's `stopReason`, with
 * `interrupted: true` when the adapter's process went away under it, or with `stopReason: "error"`
 * after an `acp.error` when it could not run. Cancelling a queued turn ends it at once; cancelling
 * the running one sends `session/cancel`, and the agent ends it.
 *
 * SESSIONS. Each thread's session id is remembered for the life of the runner. When a new process
 * starts for a thread and the agent can load sessions, the remembered id (else the server's
 * `sessionHint`) is loaded; otherwise a new session is made. `acp.session.loaded` says whether the
 * agent still has the earlier conversation.
 */

export const ACP_BUFFER_LIMIT = { count: 1000, bytes: 5 * 1024 * 1024 };

/** How many finished turns are remembered, so a resent `acp.prompt` is not run again. */
const REMEMBERED_TURNS = 1000;

type Frame = Record<string, unknown>;

export type AcpHost = {
  /** True when the frame was an `acp.*` frame (handled, or dropped as malformed). */
  handle(frame: Record<string, unknown>): Promise<boolean>;
  attach(send: (frame: Record<string, unknown>) => void): void;
  detach(): void;
  closeAll(): Promise<void>;
};

export type AcpHostDeps = {
  /** A shared folder's path on this machine, by its `fld_…` reference. */
  roots: (ref: string) => string | null;
  /** A registered app, by its `app_…` reference. */
  apps: (ref: string) => AppEntry | null;
  spawn?: typeof createAcpClient;
  idleMs?: number;
  bufferLimit?: { count: number; bytes: number };
  /** Told each time a turn's kept updates are compacted (tests). */
  onCompact?: (turnId: string) => void;
};

const HARNESSES: readonly AcpHarness[] = [
  "codex",
  "claude-code",
  "hermes",
  "custom",
];

const MESSAGES: Record<AcpErrorCode, string> = {
  bad_frame: "设备收到的指令格式不对。",
  unknown_workdir: "这台电脑上找不到这个工作文件夹，请在桌面端重新共享。",
  unknown_app: "这台电脑上找不到这个智能体，或它已被停用。",
  not_open: "这个对话还没有在这台电脑上打开。",
  start_failed: "智能体没能在这台电脑上启动，请确认它已安装并登录。",
  turn_failed: "智能体这一轮出错了。",
  bad_option: "这个回答不是智能体给出的选项之一，已按取消处理。",
};

class HostError extends Error {
  constructor(readonly code: AcpErrorCode) {
    super(MESSAGES[code]);
  }
}

type Turn = {
  threadId: string;
  turnId: string;
  content: unknown[];
  state: "queued" | "running" | "ended";
  cancelled: boolean;
  seq: number;
  end?: AcpTurnEndFrame;
};

type Proc = {
  agentId: string;
  /** What was started: a different harness, folder or app means a different process. */
  key: string;
  workdir: string;
  client: AcpClient | null;
  ready: Promise<{ loadSession: boolean }>;
  /** Opens and turns using it now; idle when zero. */
  busy: number;
  idle?: ReturnType<typeof setTimeout>;
  sessions: Map<string, Thread>;
};

type Thread = {
  threadId: string;
  open: AcpOpenFrame;
  /** The process the live session is in, and the session; null when there is none. */
  proc: Proc | null;
  sessionId: string | null;
  current: Turn | null;
  /** Everything for this thread runs on this chain, one after another. */
  tail: Promise<void>;
};

/**
 * A frame kept for replay. `turn`: a frame of a turn not over yet, kept (sent or not) and replayed
 * on every attach. `once`: a frame of a turn that has ended (its end included), or of no turn;
 * kept until one attach has replayed it.
 */
type Entry = {
  frame: Frame;
  turnId: string | null;
  kind: "turn" | "once";
  bytes: number;
};

/** A turn's kept updates, and whether they were compacted already. */
type Held = { count: number; bytes: number; compacted: boolean };

type Pending = {
  frame: AcpPermissionRequestFrame;
  settle: (answer: AcpPermissionAnswer) => void;
};

function isRecord(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

function sizeOf(frame: Frame): number {
  return Buffer.byteLength(JSON.stringify(frame));
}

export function createAcpHost(deps: AcpHostDeps): AcpHost {
  const spawn = deps.spawn ?? createAcpClient;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const limit = deps.bufferLimit ?? ACP_BUFFER_LIMIT;

  const procs = new Map<string, Proc>();
  const threads = new Map<string, Thread>();
  const turns = new Map<string, Turn>();
  /** Each thread's latest session id, kept after its process has gone. */
  const known = new Map<string, string>();
  const pending = new Map<string, Pending>();
  let outbox: Entry[] = [];
  const held = new Map<string, Held>();
  let send: ((frame: Frame) => void) | null = null;
  let closed = false;

  // --- up the socket ---

  function trySend(frame: Frame): boolean {
    if (!send) return false;
    try {
      send(frame);
      return true;
    } catch {
      // The connection is gone; what follows waits, in order, for the next one.
      send = null;
      return false;
    }
  }

  /** A turn whose end has been emitted (one forgotten long ago is over too). */
  function over(turnId: string): boolean {
    const state = turns.get(turnId)?.state;
    return state === undefined || state === "ended";
  }

  /**
   * Kept, so the next attach replays it whether or not this send got through. A turn's end turns
   * all its kept frames into `once`: the next attach replays the whole turn, then forgets it.
   */
  function emit(frame: Frame, turnId: string | null = null) {
    const isEnd = frame.type === "acp.turn.end";
    // A late frame of a turn that is over is not sent and not kept: nothing would clear it.
    if (turnId !== null && !isEnd && over(turnId)) return;
    const entry: Entry = {
      frame,
      turnId,
      kind: turnId === null || isEnd ? "once" : "turn",
      bytes: sizeOf(frame),
    };
    if (
      entry.kind === "turn" &&
      frame.type === "acp.update" &&
      turnId !== null
    ) {
      if (!hold(entry, turnId)) {
        // Past the limit, a chunk of text is not kept; it still goes up now if it can.
        trySend(frame);
        return;
      }
    } else outbox.push(entry);
    if (isEnd && turnId !== null) {
      for (const kept of outbox) if (kept.turnId === turnId) kept.kind = "once";
      held.delete(turnId);
    }
    trySend(frame);
  }

  /** Sent now if possible, never kept (a repeated acknowledgement). */
  function sendLive(frame: Frame) {
    trySend(frame);
  }

  /** An update kept for its turn, compacted past the limit; false when it is not kept at all. */
  function hold(entry: Entry, turnId: string): boolean {
    const stats = held.get(turnId) ?? { count: 0, bytes: 0, compacted: false };
    held.set(turnId, stats);
    if (stats.compacted && !keptKind(entry.frame.update)) return false;
    outbox.push(entry);
    stats.count += 1;
    stats.bytes += entry.bytes;
    if (stats.count > limit.count || stats.bytes > limit.bytes) compact(turnId);
    return true;
  }

  /** Plans and tool-call states survive compaction; everything else of a turn does not. */
  function keptKind(update: unknown): boolean {
    if (!isRecord(update)) return false;
    const kind = update.sessionUpdate;
    return (
      kind === "plan" ||
      ((kind === "tool_call" || kind === "tool_call_update") &&
        typeof update.toolCallId === "string")
    );
  }

  /** The turn's kept updates cut to the latest plan and each tool call's last state. */
  function compact(turnId: string) {
    deps.onCompact?.(turnId);
    const isMine = (entry: Entry) =>
      entry.turnId === turnId &&
      entry.kind === "turn" &&
      entry.frame.type === "acp.update";
    let plan: Entry | undefined;
    const calls = new Map<
      string,
      { last: Entry; merged: Frame; created: boolean }
    >();
    for (const entry of outbox) {
      if (!isMine(entry)) continue;
      const update = entry.frame.update;
      if (!keptKind(update) || !isRecord(update)) continue;
      if (update.sessionUpdate === "plan") {
        plan = entry;
        continue;
      }
      const id = update.toolCallId as string;
      const before = calls.get(id);
      const created =
        (before?.created ?? false) || update.sessionUpdate === "tool_call";
      calls.set(id, {
        last: entry,
        created,
        merged: {
          ...before?.merged,
          ...update,
          sessionUpdate: created ? "tool_call" : "tool_call_update",
        },
      });
    }
    const kept = new Map<Entry, Entry>();
    if (plan) kept.set(plan, plan);
    for (const { last, merged } of calls.values()) {
      const frame = { ...last.frame, update: merged };
      kept.set(last, { ...last, frame, bytes: sizeOf(frame) });
    }
    const stats = { count: 0, bytes: 0, compacted: true };
    outbox = outbox.flatMap((entry) => {
      if (!isMine(entry)) return [entry];
      const replacement = kept.get(entry);
      if (!replacement) return [];
      stats.count += 1;
      stats.bytes += replacement.bytes;
      return [replacement];
    });
    held.set(turnId, stats);
  }

  function emitError(threadId: string, code: AcpErrorCode, turnId?: string) {
    emit(
      {
        type: "acp.error",
        threadId,
        ...(turnId === undefined ? {} : { turnId }),
        code,
        message: MESSAGES[code],
      },
      turnId ?? null,
    );
  }

  // --- turns ---

  function remember(turn: Turn) {
    turns.set(turn.turnId, turn);
    if (turns.size <= REMEMBERED_TURNS) return;
    for (const [turnId, old] of turns) {
      if (turns.size <= REMEMBERED_TURNS) break;
      if (old.state === "ended") turns.delete(turnId);
    }
  }

  function endTurn(turn: Turn, stopReason: string, interrupted: boolean) {
    if (turn.state === "ended") return;
    turn.state = "ended";
    turn.end = {
      type: "acp.turn.end",
      threadId: turn.threadId,
      turnId: turn.turnId,
      stopReason,
      interrupted,
    };
    emit(turn.end, turn.turnId);
  }

  function failTurn(turn: Turn, code: AcpErrorCode) {
    emitError(turn.threadId, code, turn.turnId);
    endTurn(turn, "error", false);
  }

  function enqueue(thread: Thread, job: () => Promise<void>) {
    thread.tail = thread.tail.then(() => job().catch(() => {}));
  }

  // --- processes and sessions ---

  /** The folder and, for `custom`, the app an open names; a HostError when either is unknown. */
  function target(open: AcpOpenFrame): {
    workdir: string;
    app: AppEntry | null;
  } {
    const workdir = deps.roots(open.workdirRef);
    if (!workdir) throw new HostError("unknown_workdir");
    if (open.harness !== "custom") return { workdir, app: null };
    const app = open.appRef ? deps.apps(open.appRef) : null;
    if (app?.kind !== "stdio" || !app.enabled)
      throw new HostError("unknown_app");
    return { workdir, app };
  }

  function arm(proc: Proc) {
    if (proc.idle) clearTimeout(proc.idle);
    proc.idle = setTimeout(() => {
      if (proc.busy === 0) retire(proc);
    }, idleMs);
    proc.idle.unref?.();
  }

  function retire(proc: Proc): Promise<void> {
    if (proc.idle) clearTimeout(proc.idle);
    if (procs.get(proc.agentId) === proc) procs.delete(proc.agentId);
    for (const thread of proc.sessions.values()) {
      if (thread.proc === proc) {
        thread.proc = null;
        thread.sessionId = null;
      }
    }
    proc.sessions.clear();
    const stop = () => proc.client?.close() ?? Promise.resolve();
    // A process still being looked up is stopped as soon as it exists.
    return proc.client ? stop() : proc.ready.then(stop, stop);
  }

  function handlersFor(proc: Proc): AcpHandlers {
    return {
      onUpdate(sessionId, update) {
        const thread = proc.sessions.get(sessionId);
        const turn = thread?.current;
        if (!thread || !turn || turn.state === "ended") return;
        turn.seq += 1;
        emit(
          {
            type: "acp.update",
            threadId: turn.threadId,
            turnId: turn.turnId,
            seq: turn.seq,
            update,
          },
          turn.turnId,
        );
      },
      onPermission(sessionId, request) {
        const turn = proc.sessions.get(sessionId)?.current;
        if (!turn || turn.state === "ended" || request.signal.aborted)
          return Promise.resolve({ outcome: "cancelled" });
        const requestId = `perm_${randomUUID()}`;
        const frame: AcpPermissionRequestFrame = {
          type: "acp.permission.request",
          threadId: turn.threadId,
          turnId: turn.turnId,
          requestId,
          toolCall: request.toolCall,
          options: request.options,
          facts: permissionFacts(proc.workdir, request.toolCall),
        };
        return new Promise((resolve) => {
          const settle = (answer: AcpPermissionAnswer) => {
            if (!pending.delete(requestId)) return;
            resolve(answer);
          };
          pending.set(requestId, { frame, settle });
          // Withdrawn by a cancel or the process ending: not asked again on the next connection.
          request.signal.addEventListener(
            "abort",
            () => settle({ outcome: "cancelled" }),
            { once: true },
          );
          // Not in the outbox: every attach sends what is still pending, after the replay.
          trySend(frame);
        });
      },
    };
  }

  function start(
    open: AcpOpenFrame,
    key: string,
    workdir: string,
    app: AppEntry | null,
  ): Proc {
    const proc: Proc = {
      agentId: open.agentId,
      key,
      workdir,
      client: null,
      ready: Promise.resolve({ loadSession: false }),
      busy: 0,
      sessions: new Map(),
    };
    const harness = open.harness;
    proc.ready = (async () => {
      const spec: AcpSpawnSpec =
        harness === "custom" && app?.kind === "stdio"
          ? {
              command: app.command,
              args: app.args,
              env: app.env,
              cwd: app.cwd ?? workdir,
              sessionMode: null,
            }
          : await adapterLaunch(
              harness as Exclude<AcpHarness, "custom">,
              workdir,
            );
      if (closed) throw new HostError("start_failed");
      proc.client = spawn(spec, handlersFor(proc));
      return proc.client.initialize();
    })();
    proc.ready.catch((error) => {
      console.log(
        `runner: an external agent could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      void retire(proc);
    });
    procs.set(open.agentId, proc);
    return proc;
  }

  /** The employee's running process, started when needed, and counted busy until `release`. */
  async function acquire(thread: Thread): Promise<Proc> {
    if (closed) throw new HostError("start_failed");
    const { workdir, app } = target(thread.open);
    const key = JSON.stringify([
      thread.open.harness,
      workdir,
      app?.kind === "stdio" ? [app.command, app.args, app.env, app.cwd] : null,
    ]);
    let proc = procs.get(thread.open.agentId);
    if (proc && (proc.key !== key || (proc.client && !proc.client.alive))) {
      void retire(proc);
      proc = undefined;
    }
    proc ??= start(thread.open, key, workdir, app);
    proc.busy += 1;
    if (proc.idle) clearTimeout(proc.idle);
    try {
      await proc.ready;
    } catch {
      release(proc);
      throw new HostError("start_failed");
    }
    return proc;
  }

  function release(proc: Proc) {
    proc.busy -= 1;
    if (proc.busy === 0 && procs.get(proc.agentId) === proc) arm(proc);
  }

  /**
   * The thread's live session, made or loaded when there is none; `announce` reports a live one
   * again (a repeated `acp.open`). The caller releases the process.
   */
  async function session(
    thread: Thread,
    announce: boolean,
  ): Promise<{ proc: Proc; client: AcpClient; sessionId: string }> {
    const proc = await acquire(thread);
    try {
      const client = proc.client as AcpClient;
      if (thread.proc === proc && thread.sessionId) {
        if (announce) {
          emit({
            type: "acp.session",
            threadId: thread.threadId,
            sessionId: thread.sessionId,
            loaded: true,
          });
        }
        return { proc, client, sessionId: thread.sessionId };
      }
      if (thread.proc && thread.sessionId)
        thread.proc.sessions.delete(thread.sessionId);
      const { loadSession } = await proc.ready;
      const earlier = known.get(thread.threadId) ?? thread.open.sessionHint;
      let sessionId = "";
      let loaded = false;
      if (earlier && loadSession) {
        try {
          loaded = await client.loadSession(earlier, proc.workdir);
        } catch {
          loaded = false;
        }
        if (loaded) sessionId = earlier;
      }
      if (!loaded) sessionId = await client.newSession(proc.workdir);
      if (procs.get(proc.agentId) !== proc || !client.alive)
        throw new HostError("start_failed");
      thread.proc = proc;
      thread.sessionId = sessionId;
      proc.sessions.set(sessionId, thread);
      known.set(thread.threadId, sessionId);
      emit({
        type: "acp.session",
        threadId: thread.threadId,
        sessionId,
        loaded,
      });
      return { proc, client, sessionId };
    } catch (error) {
      release(proc);
      throw error instanceof HostError ? error : new HostError("start_failed");
    }
  }

  async function runTurn(thread: Thread, turn: Turn) {
    if (turn.state === "ended") return;
    turn.state = "running";
    let opened: Awaited<ReturnType<typeof session>>;
    try {
      opened = await session(thread, false);
    } catch (error) {
      if (turn.cancelled) endTurn(turn, "cancelled", false);
      else
        failTurn(
          turn,
          error instanceof HostError ? error.code : "start_failed",
        );
      return;
    }
    const { proc, client, sessionId } = opened;
    try {
      if (turn.cancelled) {
        endTurn(turn, "cancelled", false);
        return;
      }
      thread.current = turn;
      const { stopReason } = await client.prompt(sessionId, turn.content);
      endTurn(turn, stopReason, false);
    } catch {
      if (!client.alive) endTurn(turn, "interrupted", true);
      else failTurn(turn, "turn_failed");
    } finally {
      if (thread.current === turn) thread.current = null;
      release(proc);
    }
  }

  // --- frames from the server ---

  function onOpen(frame: Frame) {
    const threadId = str(frame.threadId);
    if (!threadId) return;
    const agentId = str(frame.agentId);
    const workdirRef = str(frame.workdirRef);
    const harness = HARNESSES.find((known) => known === frame.harness);
    if (!agentId || !workdirRef || !harness) {
      emitError(threadId, "bad_frame");
      return;
    }
    const appRef = str(frame.appRef);
    const sessionHint = str(frame.sessionHint);
    const open: AcpOpenFrame = {
      type: "acp.open",
      agentId,
      threadId,
      harness,
      workdirRef,
      ...(appRef ? { appRef } : {}),
      ...(sessionHint ? { sessionHint } : {}),
    };
    try {
      target(open);
    } catch (error) {
      // A thread already open keeps its session and its turns; only this open is refused.
      emitError(threadId, (error as HostError).code);
      return;
    }
    let thread = threads.get(threadId);
    if (thread) thread.open = open;
    else {
      thread = {
        threadId,
        open,
        proc: null,
        sessionId: null,
        current: null,
        tail: Promise.resolve(),
      };
      threads.set(threadId, thread);
    }
    const opening = thread;
    enqueue(opening, async () => {
      try {
        const { proc } = await session(opening, true);
        release(proc);
      } catch (error) {
        emitError(
          threadId,
          error instanceof HostError ? error.code : "start_failed",
        );
      }
    });
  }

  function onPrompt(frame: Frame) {
    const threadId = str(frame.threadId);
    const turnId = str(frame.turnId);
    if (!threadId || !turnId) return;
    const seen = turns.get(turnId);
    if (seen) {
      sendLive({ type: "acp.turn.ack", turnId });
      if (!seen.end) return;
      // An end still in the outbox goes up again on the next attach anyway.
      if (outbox.some((entry) => entry.frame === seen.end)) sendLive(seen.end);
      else emit(seen.end, turnId);
      return;
    }
    const turn: Turn = {
      threadId,
      turnId,
      content: Array.isArray(frame.content) ? frame.content : [],
      state: "queued",
      cancelled: false,
      seq: 0,
    };
    remember(turn);
    emit({ type: "acp.turn.ack", turnId }, turnId);
    const thread = threads.get(threadId);
    if (!Array.isArray(frame.content)) failTurn(turn, "bad_frame");
    else if (!thread) failTurn(turn, "not_open");
    else enqueue(thread, () => runTurn(thread, turn));
  }

  function onCancel(frame: Frame) {
    const turn = turns.get(str(frame.turnId) ?? "");
    if (!turn || turn.state === "ended" || turn.threadId !== frame.threadId)
      return;
    turn.cancelled = true;
    if (turn.state === "queued") {
      endTurn(turn, "cancelled", false);
      return;
    }
    const thread = threads.get(turn.threadId);
    if (thread?.current === turn && thread.proc?.client && thread.sessionId)
      thread.proc.client.cancel(thread.sessionId);
  }

  function onAnswer(frame: Frame) {
    const waitingFor = pending.get(str(frame.requestId) ?? "");
    if (!waitingFor) return;
    const optionId = str(frame.optionId);
    if (optionId === null) {
      waitingFor.settle({ outcome: "cancelled" });
      return;
    }
    const { threadId, turnId, options } = waitingFor.frame;
    if (!options.some((option) => option.optionId === optionId)) {
      waitingFor.settle({ outcome: "cancelled" });
      emitError(threadId, "bad_option", turnId);
      return;
    }
    waitingFor.settle({ outcome: "selected", optionId });
  }

  return {
    async handle(frame) {
      const type = frame.type;
      if (typeof type !== "string" || !type.startsWith("acp.")) return false;
      if (type === "acp.open") onOpen(frame);
      else if (type === "acp.prompt") onPrompt(frame);
      else if (type === "acp.cancel") onCancel(frame);
      else if (type === "acp.permission.answer") onAnswer(frame);
      return true;
    },

    attach(sender) {
      send = sender;
      // Everything kept, in the order it was made: the server drops what it already has by seq.
      const replayed = new Set<Entry>();
      let through = true;
      for (const entry of [...outbox]) {
        if (!trySend(entry.frame)) {
          through = false;
          break;
        }
        if (entry.kind === "once") replayed.add(entry);
      }
      // Ended turns and frames of no turn have now been replayed once.
      if (replayed.size > 0)
        outbox = outbox.filter((entry) => !replayed.has(entry));
      if (!through) return;
      for (const { frame } of pending.values()) {
        if (!trySend(frame)) return;
      }
    },

    detach() {
      send = null;
    },

    async closeAll() {
      closed = true;
      await Promise.allSettled([...procs.values()].map(retire));
    },
  };
}
