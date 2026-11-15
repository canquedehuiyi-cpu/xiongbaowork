import type { DeviceChannel, DispatchTarget } from "../../devices/channel";
import { runAsTenant } from "../../tenant/context";
import {
  type AcpTurnRow,
  type AcpTurnStore,
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
   */
  subscribe(turnId: string, listener: AcpFrameListener): () => void;
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
   * Resolves once every frame from this device so far has been dealt with: true when all were
   * taken in, false when one could not be (the database failed) since the last `drain`.
   */
  drain(target: DispatchTarget): Promise<boolean>;
};

export type AcpRelayDeps = {
  channel: Pick<DeviceChannel, "notify" | "isReachable" | "connectionOf">;
  turns: AcpTurnStore;
  /**
   * Starts a claimed turn (status `sent`): sends its `acp.open` / `acp.prompt` through `send`, and
   * resolves once the prompt is written (not when the turn ends). A throw puts the turn back.
   */
  startQueuedTurn: (row: AcpTurnRow) => Promise<void>;
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

  const chains = new Map<string, Promise<void>>();
  /** Devices where a frame could not be taken in since the last `drain`. */
  const failed = new Set<string>();
  const known = new Map<string, Turn>();
  const listeners = new Map<string, Set<AcpFrameListener>>();
  /** turnId → the connection its `acp.prompt` last went out on. */
  const promptedOn = new Map<string, string | null>();
  /** Claimed by `resumeQueued`, `startQueuedTurn` not settled yet. */
  const starting = new Set<string>();
  /** device → turnId → heartbeats left before a turn listed `ended` with no end is gone. */
  const endedPending = new Map<string, Map<string, number>>();
  /** lane → frames of no turn taken in since the lane's last `acp.open`. */
  const turnless = new Map<string, Set<string>>();
  const requestTurn = new Map<string, string>();

  /** Runs `job` after everything queued for this device. `critical`: a failure fails `drain`. */
  function serial<T>(
    target: DispatchTarget,
    job: () => Promise<T>,
    critical: boolean,
  ): Promise<T> {
    const key = keyOf(target);
    const run = (chains.get(key) ?? Promise.resolve()).then(job);
    const tail = run.then(
      () => undefined,
      (error) => {
        if (critical) failed.add(key);
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

  const fromRow = (row: AcpTurnRow): Turn => ({
    tenantId: row.tenantId,
    deviceId: row.deviceId,
    agentId: row.agentId,
    threadId: row.threadId,
    turnId: row.turnId,
    status: row.status,
    lastSeq: row.lastSeq,
    requests: new Set(),
    errors: new Set(),
    saving: false,
    dirty: false,
  });

  /** Everything held about a turn that is over. */
  function forget(turn: Turn) {
    if (known.get(turn.turnId) === turn) known.delete(turn.turnId);
    promptedOn.delete(turn.turnId);
    for (const requestId of turn.requests) requestTurn.delete(requestId);
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
    if (!turn) {
      const row = await turns.get(from.tenantId, turnId);
      if (!row) return null;
      turn = fromRow(row);
      if (!isFinalAcpTurnStatus(row.status)) known.set(turnId, turn);
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
    const changed = await runAsTenant(turn.tenantId, () =>
      turns.setStatus(turn.turnId, status, turn.lastSeq),
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

  /** The turn is over: final in the database first, then told, then forgotten. */
  async function finish(
    turn: Turn,
    status: AcpTurnRow["status"],
    frame: Frame,
  ): Promise<void> {
    if (!(await setStatus(turn, status))) return;
    deliver(turn.turnId, frame);
    forget(turn);
    void resume(turn, false).catch(() => undefined);
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
    // A turn that is over takes nothing in: what comes now is a replay.
    if (isFinalAcpTurnStatus(turn.status)) return;

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
      turn.lastSeq = seq;
      if (arrived(turn) && !(await setStatus(turn, "running"))) return;
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
      requestTurn.set(requestId, turnId);
      if (turn.status !== "awaiting" && !(await setStatus(turn, "awaiting")))
        return;
      // Every report, repeats included: one the device sends again after a reconnect is still
      // waiting. Whoever opens the approval keys it by `requestId`.
      deliver(turnId, frame);
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
        if (turn.status !== state) await setStatus(turn, state);
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

    subscribe(turnId, listener) {
      const set = listeners.get(turnId) ?? new Set<AcpFrameListener>();
      set.add(listener);
      listeners.set(turnId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(turnId) === set)
          listeners.delete(turnId);
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
        const turnId = requestId ? requestTurn.get(requestId) : undefined;
        const turn = turnId ? known.get(turnId) : undefined;
        if (requestId) requestTurn.delete(requestId);
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

    async drain(target) {
      const key = keyOf(target);
      await (chains.get(key) ?? Promise.resolve());
      const ok = !failed.has(key);
      failed.delete(key);
      return ok;
    },
  };
}
