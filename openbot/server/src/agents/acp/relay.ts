import type { DeviceChannel, DispatchTarget } from "../../devices/channel";
import {
  type AcpTurnRow,
  type AcpTurnStore,
  acpPromptOf,
  isFinalAcpTurnStatus,
} from "./turns";

/**
 * The `acp.*` frames between the server and the runners (shared/acp.ts): up from a device to
 * whoever follows a turn, down from the server to a device, and the queued turns of a device that
 * has come back.
 *
 * A FRAME IS THE SOCKET'S TENANT'S AND DEVICE'S, OR NOBODY'S. The tenant and device are the
 * socket's (`from`), never the frame's. A frame of a turn is taken in only when that turn is this
 * tenant's, queued for this device, and of the employee and thread the frame names; a frame of no
 * turn (`acp.session`, an `acp.error` of an open) only when this device has had a turn of that
 * employee in that thread. Anything else is dropped and logged.
 *
 * THE DEVICE REPEATS ITSELF. On every reconnect the runner sends `acp.inventory` first, then
 * everything it kept: every frame of every turn not over yet, and of every ended turn whose end it
 * has no proof of delivery for; then the permission requests it still waits on. So an
 * `acp.update` whose `seq` is not above the last one taken in for its turn is dropped (a gap is
 * fine: past its buffer limit the device compacts and `seq` skips), an ack or an end of a turn that
 * is already over is dropped, and a frame of no turn that was already taken in is dropped until the
 * server sends that lane a new `acp.open`.
 *
 * IN ORDER, PER DEVICE. Taking a frame in can ask the database (whose turn is it), so everything of
 * one device (its frames, and the work of `resumeQueued`) runs on one chain, one step after
 * another. `drain` waits for that chain: the runner lets an ended turn's frames go when a
 * heartbeat's ack comes back, so the heartbeat is acked only once what came before it is taken in.
 *
 * RECONCILING. `acp.inventory` lists every turn the runner process remembers. A turn the server
 * has as `sent`, `running` or `awaiting` on that device that the inventory does not list is gone
 * (the runner restarted, or never got it) and becomes `interrupted`, unless it was prompted on the
 * very connection the inventory came on (the runner wrote its inventory before that prompt
 * arrived) or is being started right now. A turn listed as `ended` whose end does not come with
 * the replay (its frames were let go) becomes `interrupted` too, two heartbeats later. A truncated
 * inventory (`truncated: true`, the runner could not fit it in one frame) interrupts nothing.
 * Whoever follows a turn ended this way gets an `acp.turn.end` with `interrupted: true` and
 * `reconciled: true`. One cancel can stop an employee's whole process, so several turns of one
 * employee can end `interrupted` together; each is ended once.
 *
 * NOBODY FOLLOWS IT HERE (an orphan). A turn's run lives in the process that started it. After this
 * server restarted (every deploy of a single replica), or when the device reconnects to another
 * server of the deployment, a frame or an inventory entry can arrive for a turn that is still live in
 * the database with no run of this process following it (`subscribe` with `run: true`) and none
 * being started. Its frames are not swallowed: `adoptTurn` starts a run that follows the turn from
 * here on (posted into its thread, finishing the board card the turn answers for), and the frame is
 * then taken in for it. A permission request with no run to carry it goes straight to `permission`
 * (the bridge), so its hirer still gets the card. A turn that cannot be adopted (its employee is
 * gone, moved, or the thread is not its own any more) is cancelled on the device (`acp.cancel`) and
 * ended `interrupted`. An adoption that throws takes nothing in (the device sends it all again).
 *
 * WHEN NOBODY WAS FOLLOWING A TURN THAT ENDS, `closed` is told (its open approvals expire, the card
 * the turn answers for is closed). `cancelTurn` (the hirer's stop of a queued or running turn, also
 * the way out of anything left stuck) ends a turn `cancelled` here and tells the device.
 *
 * STOPPED HERE, STILL RUNNING THERE. A turn the server already ended (`cancelled`, or `interrupted`)
 * that the device still works on (its inventory lists it running or awaiting, or it sends updates or
 * permission requests for it) is cancelled on the device: once per connection, so the device's lane
 * is not held behind a turn nobody waits for.
 *
 * EVERY JOB HAS A DEADLINE (`jobTimeoutMs`). A query that hangs must not hold one device's chain for
 * ever (every later frame and heartbeat of the device waits on it, reconnecting included): past the
 * deadline the job counts as failed (its frame is not taken in, so `drain` answers false and the
 * device sends it again on its next connection) and the chain goes on.
 */

/** Where an up frame came from: the socket's tenant and device, and which connection of it. */
export type AcpFrameSource = DispatchTarget & { connectionId?: string };

export type AcpFrameListener = (frame: Record<string, unknown>) => void;

export type AcpRelay = {
  /** An `acp.*` frame from a runner's socket. Never throws; what is not taken in is logged. */
  fromRunner(from: AcpFrameSource, frame: Record<string, unknown>): void;
  /**
   * Every frame taken in for this turn, from now on: its own (ack, updates, permission requests,
   * errors, its end, once) and those of no turn of its lane while it is not over (`acp.session`, an
   * open's `acp.error`). A turn the inventory shows gone gets a made-up end (`reconciled: true`).
   * `run: true`: this listener is the run that carries the turn (an orphan is one with none).
   */
  subscribe(
    turnId: string,
    listener: AcpFrameListener,
    options?: { run?: boolean },
  ): () => void;
  /** Writes a frame to the device from this process now; false when it is not connected here. */
  send(target: DispatchTarget, frame: Record<string, unknown>): boolean;
  /**
   * Called once per heartbeat. Starts, through `startQueuedTurn`, the oldest queued turn of every
   * lane of this device with no turn on the device, and answers how many started. A turn is
   * claimed (`queued` → `sent`) before `startQueuedTurn` gets it, and put back in the queue when
   * that throws. Also called by the relay itself whenever a turn ends.
   */
  resumeQueued(target: DispatchTarget): Promise<number>;
  /**
   * Resolves once every frame from this device so far has been dealt with: false when a frame of
   * this connection (`target.connectionId`) could not be taken in (the database failed) since this
   * connection's last `drain`, true otherwise.
   */
  drain(target: AcpFrameSource): Promise<boolean>;
  /**
   * Stops one of the tenant's turns: a queued one never runs, a running one is cancelled on its
   * device (`acp.cancel`, when connected here) and ended `cancelled` here at once, so its lane goes
   * on. Whoever follows it gets an `acp.turn.end` with `stopReason: "cancelled"`; `closed` is told.
   */
  cancelTurn(tenantId: string, turnId: string): Promise<AcpCancelOutcome>;
};

/** `cancelTurn`: stopped now, already over, or no such turn of this tenant. */
export type AcpCancelOutcome = "cancelled" | "over" | "missing";

/** A turn that ended here, for `closed`. */
export type AcpClosedTurn = {
  tenantId: string;
  deviceId: string;
  agentId: string;
  threadId: string;
  turnId: string;
  /** The board card the turn answers for (`acpPromptOf(row).runRef`). */
  runRef?: string;
  status: AcpTurnRow["status"];
};

/** A deadline for one job of a device's chain (see the header). */
export const ACP_RELAY_JOB_TIMEOUT_MS = 10_000;

export type AcpRelayDeps = {
  channel: Pick<DeviceChannel, "notify" | "isReachable" | "connectionOf">;
  turns: AcpTurnStore;
  /**
   * Starts a claimed turn (status `sent`): sends its `acp.open` / `acp.prompt` through `send`, and
   * resolves once the prompt is written (not when the turn ends). A throw puts the turn back.
   */
  startQueuedTurn: (row: AcpTurnRow) => Promise<void>;
  /**
   * A live turn no run of this process follows (see the header): starts one that follows it and
   * resolves true once it is subscribed, or false when the turn cannot go on (the relay cancels
   * it). A throw takes the frame not in. Absent: frames are taken in for whoever listens, as before.
   */
  adoptTurn?: (row: AcpTurnRow) => Promise<boolean>;
  /** A permission request taken in with no run to carry it: straight to the permission bridge. */
  permission?: (row: AcpTurnRow, frame: Record<string, unknown>) => void;
  /**
   * A turn ended here: `followed` says whether a run of this process was following it (that run
   * closes its card; nobody else does otherwise). Never throws into the relay.
   */
  closed?: (turn: AcpClosedTurn, info: { followed: boolean }) => Promise<void>;
  /** `ACP_RELAY_JOB_TIMEOUT_MS` unless set. */
  jobTimeoutMs?: number;
  log?: (message: string) => void;
};

type Frame = Record<string, unknown>;

/** What the relay holds about a turn that is not over. */
type Turn = {
  tenantId: string;
  deviceId: string;
  agentId: string;
  threadId: string;
  turnId: string;
  status: AcpTurnRow["status"];
  lastSeq: number;
  /** The board card the turn answers for. */
  runRef?: string;
  /** Kept to hand to `adoptTurn` / `permission` without reading it again. */
  row: AcpTurnRow;
  /** Permission requests waiting for an answer. */
  requests: Set<string>;
  /** Errors taken in for this turn, serialized: a replay of one is dropped. */
  errors: Set<string>;
  saving: boolean;
  dirty: boolean;
};

/** Heartbeats after an inventory before a turn it listed as ended, with no end since, is gone. */
const ENDED_GRACE_BEATS = 2;
/** Frames of no turn remembered per lane, to drop their replays. */
const TURNLESS_KEPT = 32;
/** Turns found over, remembered so a replay of their frames does not ask the database each time. */
const FINALS_KEPT = 1000;
/** (connection, turn) pairs a cancel already went to, remembered at most. */
const CANCELS_KEPT = 1000;

class RelayJobTimeout extends Error {
  override name = "RelayJobTimeout";
}

/** `work`, or a rejection once `ms` have passed (`work` itself is left to settle on its own). */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RelayJobTimeout(
            `a job took longer than ${ms} ms and was given up on`,
          ),
        ),
      ms,
    );
    timer.unref?.();
  });
  // A late failure of the abandoned job is not an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const keyOf = (target: DispatchTarget) =>
  JSON.stringify([target.tenantId, target.deviceId]);

const laneOf = (
  target: DispatchTarget,
  agentId: string,
  threadId: string,
): string =>
  JSON.stringify([target.tenantId, target.deviceId, agentId, threadId]);

/** Frames that belong to one turn and carry its `turnId`. */
const TURN_FRAMES = new Set([
  "acp.turn.ack",
  "acp.update",
  "acp.permission.request",
  "acp.turn.end",
]);

export function createAcpRelay(deps: AcpRelayDeps): AcpRelay {
  const { channel, turns, startQueuedTurn } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const jobTimeoutMs = deps.jobTimeoutMs ?? ACP_RELAY_JOB_TIMEOUT_MS;

  const chains = new Map<string, Promise<void>>();
  /**
   * device → the connections (or, for a source without one, the device itself) whose frame could
   * not be taken in since that connection's last `drain`. Per connection: a failure on a connection that
   * is gone was replayed on the new one, and must not close that one too.
   */
  const failed = new Map<string, Set<string>>();
  const failKey = (source: AcpFrameSource) =>
    source.connectionId === undefined ? "" : source.connectionId;
  const known = new Map<string, Turn>();
  const listeners = new Map<string, Set<AcpFrameListener>>();
  /** turnId → how many of its listeners are runs carrying it (`subscribe` with `run: true`). */
  const runs = new Map<string, number>();
  /** turnId → a turn found over (see `FINALS_KEPT`). */
  const finals = new Map<string, Turn>();
  /** `[connection, turnId]` → a cancel already sent there for a turn the server ended. */
  const cancelled = new Map<string, true>();
  /** turnId → the connection its `acp.prompt` last went out on. */
  const promptedOn = new Map<string, string | null>();
  /** Claimed by `resumeQueued`, `startQueuedTurn` not settled yet. */
  const starting = new Set<string>();
  /** device → turnId → heartbeats left before a turn listed `ended` with no end is gone. */
  const endedPending = new Map<string, Map<string, number>>();
  /** lane → frames of no turn taken in since the lane's last `acp.open`. */
  const turnless = new Map<string, Set<string>>();
  /** (tenant, device, requestId) → turnId: a request id is the device's, never global. */
  const requestTurn = new Map<string, string>();
  const requestKey = (target: DispatchTarget, requestId: string) =>
    JSON.stringify([target.tenantId, target.deviceId, requestId]);

  /** Runs `job` after everything queued for this device. `critical`: a failure fails `drain`. */
  function serial<T>(
    target: AcpFrameSource,
    job: () => Promise<T>,
    critical: boolean,
  ): Promise<T> {
    const key = keyOf(target);
    const run = (chains.get(key) ?? Promise.resolve()).then(() =>
      withDeadline(job(), jobTimeoutMs),
    );
    const tail = run.then(
      () => undefined,
      (error) => {
        if (critical) {
          const set = failed.get(key) ?? new Set<string>();
          set.add(failKey(target));
          failed.set(key, set);
        }
        log(
          `acp: ${target.tenantId}/${target.deviceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  function deliver(turnId: string, frame: Frame) {
    for (const listener of [...(listeners.get(turnId) ?? [])]) {
      try {
        listener(frame);
      } catch (error) {
        log(
          `acp: a listener of turn ${turnId} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const followed = (turnId: string) => (runs.get(turnId) ?? 0) > 0;

  const fromRow = (row: AcpTurnRow): Turn => ({
    tenantId: row.tenantId,
    deviceId: row.deviceId,
    agentId: row.agentId,
    threadId: row.threadId,
    turnId: row.turnId,
    status: row.status,
    lastSeq: row.lastSeq,
    ...(acpPromptOf(row).runRef ? { runRef: acpPromptOf(row).runRef } : {}),
    row,
    requests: new Set(),
    errors: new Set(),
    saving: false,
    dirty: false,
  });

  /** Everything held about a turn that is over. */
  function forget(turn: Turn) {
    if (known.get(turn.turnId) === turn) known.delete(turn.turnId);
    if (isFinalAcpTurnStatus(turn.status))
      remember(finals, turn.turnId, turn, FINALS_KEPT);
    promptedOn.delete(turn.turnId);
    for (const requestId of turn.requests)
      requestTurn.delete(requestKey(turn, requestId));
    endedPending.get(keyOf(turn))?.delete(turn.turnId);
  }

  /** The turn, when it is this source's: its tenant and device, and the frame's employee and thread. */
  async function own(
    from: DispatchTarget,
    agentId: string,
    threadId: string,
    turnId: string,
  ): Promise<Turn | null> {
    let turn = known.get(turnId);
    const over = finals.get(turnId);
    if (!turn && over && over.tenantId === from.tenantId) turn = over;
    if (!turn) {
      const row = await turns.get(from.tenantId, turnId);
      if (!row) return null;
      turn = fromRow(row);
      if (!isFinalAcpTurnStatus(row.status)) known.set(turnId, turn);
      else remember(finals, turnId, turn, FINALS_KEPT);
    }
    if (
      turn.tenantId !== from.tenantId ||
      turn.deviceId !== from.deviceId ||
      turn.agentId !== agentId ||
      turn.threadId !== threadId
    )
      return null;
    return turn;
  }

  async function setStatus(
    turn: Turn,
    status: AcpTurnRow["status"],
  ): Promise<boolean> {
    const changed = await turns.setStatus(
      turn.tenantId,
      turn.turnId,
      status,
      turn.lastSeq,
    );
    if (changed) turn.status = status;
    // Already final (ended or cancelled elsewhere): nothing of it is taken in any more.
    else forget(turn);
    return changed;
  }

  /** `lastSeq` written behind the stream, one write at a time per turn. */
  function saveSeq(turn: Turn) {
    if (turn.saving) {
      turn.dirty = true;
      return;
    }
    turn.saving = true;
    const seq = turn.lastSeq;
    turns
      .recordSeq(turn.tenantId, turn.turnId, seq)
      .catch((error) =>
        log(
          `acp: lastSeq of turn ${turn.turnId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        turn.saving = false;
        if (turn.dirty && known.get(turn.turnId) === turn) {
          turn.dirty = false;
          saveSeq(turn);
        }
      });
  }

  /**
   * The turn is over: final in the database first, then told, then forgotten. Nobody following it
   * here (`closed`), or `always`: `closed` is told too.
   */
  async function finish(
    turn: Turn,
    status: AcpTurnRow["status"],
    frame: Frame,
    always = false,
  ): Promise<void> {
    const carried = followed(turn.turnId);
    if (!(await setStatus(turn, status))) return;
    deliver(turn.turnId, frame);
    forget(turn);
    if (!carried || always) await tellClosed(turn, carried);
    void resume(turn, false).catch(() => undefined);
  }

  async function tellClosed(turn: Turn, carried: boolean) {
    if (!deps.closed) return;
    try {
      await deps.closed(
        {
          tenantId: turn.tenantId,
          deviceId: turn.deviceId,
          agentId: turn.agentId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          ...(turn.runRef ? { runRef: turn.runRef } : {}),
          status: turn.status,
        },
        { followed: carried },
      );
    } catch (error) {
      log(
        `acp: what turn ${turn.turnId} left behind could not be closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Tells the device to stop a turn the server no longer waits for. `force`: whatever was sent
   * before; otherwise once per connection (a replay of its frames would ask again and again).
   */
  function cancelOnDevice(target: DispatchTarget, turn: Turn, force = false) {
    const connection = channel.connectionOf(target);
    const key = JSON.stringify([connection, turn.turnId]);
    if (!force && cancelled.has(key)) return;
    const sent = channel.notify(target, {
      type: "acp.cancel",
      agentId: turn.agentId,
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    if (sent) remember(cancelled, key, true, CANCELS_KEPT);
  }

  /**
   * A run of this process follows this live turn, or it is ended here (false: its frame is not taken
   * in). See NOBODY FOLLOWS IT HERE in the header.
   */
  async function follow(from: DispatchTarget, turn: Turn): Promise<boolean> {
    if (!deps.adoptTurn) return true;
    if (followed(turn.turnId) || starting.has(turn.turnId)) return true;
    // Read again: it may have ended on another server, and the adopted run starts from the stored row.
    const row = await turns.get(turn.tenantId, turn.turnId);
    if (!row || isFinalAcpTurnStatus(row.status)) {
      if (row) turn.status = row.status;
      forget(turn);
      if (row?.status === "cancelled" || row?.status === "interrupted")
        cancelOnDevice(from, turn);
      return false;
    }
    turn.row = row;
    if (await deps.adoptTurn(row)) {
      if (followed(turn.turnId)) return true;
      throw new Error(`turn ${turn.turnId}: the run that adopted it is gone`);
    }
    log(
      `acp: turn ${turn.turnId} has no run, employee or thread to go on in any more; cancelled on its device`,
    );
    cancelOnDevice(from, turn, true);
    await interrupt(turn);
    return false;
  }

  async function interrupt(turn: Turn): Promise<void> {
    await finish(turn, "interrupted", {
      type: "acp.turn.end",
      agentId: turn.agentId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      stopReason: "interrupted",
      interrupted: true,
      reconciled: true,
    });
  }

  const arrived = (turn: Turn) =>
    turn.status === "queued" || turn.status === "sent";

  async function onTurnFrame(from: AcpFrameSource, frame: Frame) {
    const type = frame.type as string;
    const agentId = text(frame.agentId);
    const threadId = text(frame.threadId);
    const turnId = text(frame.turnId);
    if (!agentId || !threadId || !turnId) {
      log(`acp: dropped a ${type} without its employee, thread or turn`);
      return;
    }
    const turn = await own(from, agentId, threadId, turnId);
    if (!turn) {
      log(
        `acp: dropped ${type} of turn ${turnId} from ${from.tenantId}/${from.deviceId}: not this device's turn`,
      );
      return;
    }
    // A turn that is over takes nothing in: what comes now is a replay. A device still working on a
    // turn the server stopped (it sends updates or asks) is told to stop.
    if (isFinalAcpTurnStatus(turn.status)) {
      if (
        (type === "acp.update" || type === "acp.permission.request") &&
        (turn.status === "cancelled" || turn.status === "interrupted")
      )
        cancelOnDevice(from, turn);
      return;
    }
    // An update already taken in needs nobody: a replay is dropped before anything is adopted.
    if (
      type === "acp.update" &&
      typeof frame.seq === "number" &&
      frame.seq <= turn.lastSeq
    )
      return;
    if (!(await follow(from, turn))) return;

    if (type === "acp.turn.ack") {
      if (!arrived(turn)) return;
      if (await setStatus(turn, "running")) deliver(turnId, frame);
      return;
    }
    if (type === "acp.update") {
      const seq = frame.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
        log(`acp: dropped an update of turn ${turnId} with no usable seq`);
        return;
      }
      if (seq <= turn.lastSeq) return;
      // Taken in only once the status is written: a write that fails leaves `lastSeq` where it was,
      // so the replay that follows the closed socket is not mistaken for a repeat.
      if (arrived(turn) && !(await setStatus(turn, "running"))) return;
      turn.lastSeq = seq;
      deliver(turnId, frame);
      saveSeq(turn);
      return;
    }
    if (type === "acp.permission.request") {
      const requestId = text(frame.requestId);
      if (!requestId) {
        log(`acp: dropped a permission request of turn ${turnId} with no id`);
        return;
      }
      turn.requests.add(requestId);
      requestTurn.set(requestKey(turn, requestId), turnId);
      if (turn.status !== "awaiting" && !(await setStatus(turn, "awaiting")))
        return;
      // Every report, repeats included: one the device sends again after a reconnect is still
      // waiting. Whoever opens the approval keys it by `requestId`.
      deliver(turnId, frame);
      // No run to carry it (nothing adopts here): the bridge gets it all the same.
      if (!followed(turnId)) deps.permission?.(turn.row, frame);
      return;
    }
    if (type === "acp.error") {
      const serialized = JSON.stringify(frame);
      if (turn.errors.has(serialized)) return;
      turn.errors.add(serialized);
      deliver(turnId, frame);
      return;
    }
    // acp.turn.end
    const status =
      frame.interrupted === true
        ? "interrupted"
        : frame.stopReason === "cancelled"
          ? "cancelled"
          : "done";
    await finish(turn, status, frame);
  }

  /** `acp.session`, or an `acp.error` of an open: to the lane's turns that are not over. */
  async function onLaneFrame(from: AcpFrameSource, frame: Frame) {
    const type = frame.type as string;
    const agentId = text(frame.agentId);
    const threadId = text(frame.threadId);
    if (!agentId || !threadId) {
      log(`acp: dropped a ${type} without its employee or thread`);
      return;
    }
    const open = await turns.openInLane(
      from.tenantId,
      from.deviceId,
      agentId,
      threadId,
    );
    if (open === null) {
      log(
        `acp: dropped ${type} from ${from.tenantId}/${from.deviceId}: no turn of ${agentId} in ${threadId} on this device`,
      );
      return;
    }
    const lane = laneOf(from, agentId, threadId);
    const serialized = JSON.stringify(frame);
    const seen = turnless.get(lane) ?? new Set<string>();
    if (seen.has(serialized)) return;
    seen.add(serialized);
    if (seen.size > TURNLESS_KEPT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    turnless.set(lane, seen);
    for (const row of open) deliver(row.turnId, frame);
  }

  async function onInventory(from: AcpFrameSource, frame: Frame) {
    const listed = new Map<string, Frame>();
    if (Array.isArray(frame.turns)) {
      for (const item of frame.turns) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const entry = item as Frame;
        const turnId = text(entry.turnId);
        if (turnId) listed.set(turnId, entry);
      }
    }
    const truncated = frame.truncated === true;
    const rows = await turns.activeForDevice(from.tenantId, from.deviceId);
    const pending = new Map<string, number>();
    for (const row of rows) {
      const turn = known.get(row.turnId) ?? fromRow(row);
      if (isFinalAcpTurnStatus(turn.status)) continue;
      known.set(row.turnId, turn);
      const item = listed.get(row.turnId);
      // Listed under another employee or thread is not this turn.
      const state =
        item && item.agentId === row.agentId && item.threadId === row.threadId
          ? item.state
          : null;
      if (state === "running" || state === "awaiting") {
        if (turn.status !== state && !(await setStatus(turn, state))) continue;
        // Still working on the device: somebody here follows it from now on, or it is stopped.
        await follow(from, turn);
        continue;
      }
      if (state === "ended") {
        pending.set(row.turnId, ENDED_GRACE_BEATS);
        continue;
      }
      if (truncated || starting.has(row.turnId)) continue;
      const prompted = promptedOn.get(row.turnId);
      if (from.connectionId !== undefined && prompted === from.connectionId)
        continue;
      await interrupt(turn);
    }
    endedPending.set(keyOf(from), pending);
    // Listed as still working, but over on the server (stopped while the device was away): stopped.
    const active = new Set(rows.map((row) => row.turnId));
    for (const [turnId, item] of listed) {
      if (active.has(turnId)) continue;
      if (item.state !== "running" && item.state !== "awaiting") continue;
      const agentId = text(item.agentId);
      const threadId = text(item.threadId);
      if (!agentId || !threadId) continue;
      const turn = await own(from, agentId, threadId, turnId);
      if (turn && isFinalAcpTurnStatus(turn.status)) cancelOnDevice(from, turn);
    }
  }

  /** A heartbeat: turns listed `ended` by an inventory whose end has not come since. */
  async function settleEnded(target: DispatchTarget) {
    const pending = endedPending.get(keyOf(target));
    if (!pending) return;
    for (const [turnId, left] of [...pending]) {
      if (left > 1) {
        pending.set(turnId, left - 1);
        continue;
      }
      pending.delete(turnId);
      const turn =
        known.get(turnId) ??
        (await turns
          .get(target.tenantId, turnId)
          .then((row) => (row ? fromRow(row) : null)));
      if (!turn || isFinalAcpTurnStatus(turn.status)) continue;
      await interrupt(turn);
    }
    if (pending.size === 0) endedPending.delete(keyOf(target));
  }

  async function resume(
    target: DispatchTarget,
    beat: boolean,
  ): Promise<number> {
    const { tenantId, deviceId } = target;
    const source = { tenantId, deviceId };
    const claimed = await serial(
      source,
      async () => {
        if (beat) await settleEnded(source);
        if (!channel.isReachable(source)) return [];
        const queued = await turns.queuedForDevice(tenantId, deviceId);
        if (queued.length === 0) return [];
        const busy = new Set(
          (await turns.activeForDevice(tenantId, deviceId)).map((row) =>
            laneOf(source, row.agentId, row.threadId),
          ),
        );
        const picked: AcpTurnRow[] = [];
        for (const row of queued) {
          const lane = laneOf(source, row.agentId, row.threadId);
          if (busy.has(lane)) continue;
          // The lane's oldest queued turn, and nothing after it in the same lane.
          busy.add(lane);
          const got = await turns.claim(tenantId, row.turnId);
          if (!got) continue;
          starting.add(got.turnId);
          known.set(got.turnId, fromRow(got));
          picked.push(got);
        }
        return picked;
      },
      false,
    );
    const outcomes = await Promise.allSettled(
      claimed.map((row) => startQueuedTurn(row)),
    );
    let started = 0;
    for (const [index, outcome] of outcomes.entries()) {
      const row = claimed[index] as AcpTurnRow;
      starting.delete(row.turnId);
      if (outcome.status === "fulfilled") {
        started += 1;
        continue;
      }
      log(
        `acp: turn ${row.turnId} could not be started and waits again: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      );
      const turn = known.get(row.turnId);
      if (turn) forget(turn);
      await turns.unclaim(tenantId, row.turnId).catch(() => undefined);
    }
    return started;
  }

  return {
    fromRunner(from, frame) {
      const type = frame.type;
      if (typeof type !== "string" || !type.startsWith("acp.")) return;
      let job: () => Promise<void>;
      if (type === "acp.inventory") job = () => onInventory(from, frame);
      else if (
        TURN_FRAMES.has(type) ||
        (type === "acp.error" && frame.turnId !== undefined)
      )
        job = () => onTurnFrame(from, frame);
      else if (type === "acp.session" || type === "acp.error")
        job = () => onLaneFrame(from, frame);
      else {
        log(`acp: dropped an unknown ${type} frame`);
        return;
      }
      void serial(from, job, true).catch(() => undefined);
    },

    subscribe(turnId, listener, options) {
      const set = listeners.get(turnId) ?? new Set<AcpFrameListener>();
      // The same function twice is one listener (a Set), and one run.
      const fresh = !set.has(listener);
      set.add(listener);
      listeners.set(turnId, set);
      const isRun = options?.run === true && fresh;
      if (isRun) runs.set(turnId, (runs.get(turnId) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set.delete(listener);
        if (set.size === 0 && listeners.get(turnId) === set)
          listeners.delete(turnId);
        if (isRun) {
          const left = (runs.get(turnId) ?? 1) - 1;
          if (left > 0) runs.set(turnId, left);
          else runs.delete(turnId);
        }
      };
    },

    send(target, frame) {
      const connection = channel.connectionOf(target);
      if (!channel.notify(target, frame)) return false;
      const agentId = text(frame.agentId);
      if (frame.type === "acp.prompt") {
        const turnId = text(frame.turnId);
        if (turnId) promptedOn.set(turnId, connection);
      } else if (frame.type === "acp.open") {
        const threadId = text(frame.threadId);
        if (agentId && threadId)
          turnless.delete(laneOf(target, agentId, threadId));
      } else if (frame.type === "acp.permission.answer") {
        const requestId = text(frame.requestId);
        const key = requestId ? requestKey(target, requestId) : null;
        const turnId = key ? requestTurn.get(key) : undefined;
        const found = turnId ? known.get(turnId) : undefined;
        // Only a turn of the device the answer goes to.
        const turn =
          found &&
          found.tenantId === target.tenantId &&
          found.deviceId === target.deviceId
            ? found
            : undefined;
        if (key && turn) requestTurn.delete(key);
        if (turn && requestId) {
          turn.requests.delete(requestId);
          if (turn.requests.size === 0 && turn.status === "awaiting")
            void serial(
              target,
              async () => {
                if (turn.status === "awaiting" && turn.requests.size === 0)
                  await setStatus(turn, "running");
              },
              false,
            ).catch(() => undefined);
        }
      }
      return true;
    },

    resumeQueued(target) {
      return resume(target, true);
    },

    async cancelTurn(tenantId, turnId) {
      const found = await turns.get(tenantId, turnId);
      if (!found) return "missing";
      const target = { tenantId, deviceId: found.deviceId };
      return serial(
        target,
        async (): Promise<AcpCancelOutcome> => {
          const row = await turns.get(tenantId, turnId);
          if (!row) return "missing";
          if (isFinalAcpTurnStatus(row.status)) return "over";
          const turn = known.get(turnId) ?? fromRow(row);
          // On the device already (or being started there): it is told to stop.
          if (row.status !== "queued") cancelOnDevice(target, turn, true);
          await finish(
            turn,
            "cancelled",
            {
              type: "acp.turn.end",
              agentId: turn.agentId,
              threadId: turn.threadId,
              turnId,
              stopReason: "cancelled",
            },
            true,
          );
          return turn.status === "cancelled" ? "cancelled" : "over";
        },
        false,
      );
    },

    async drain(target) {
      const key = keyOf(target);
      await (chains.get(key) ?? Promise.resolve());
      const marks = failed.get(key);
      // Only this connection's mark: another connection's is for that one's own drain to report.
      const ok = !marks?.delete(failKey(target));
      if (marks?.size === 0) failed.delete(key);
      return ok;
    },
  };
}
