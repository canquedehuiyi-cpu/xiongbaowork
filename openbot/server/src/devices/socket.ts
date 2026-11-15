import { isScreenFrameType } from "../../../shared/device-screen";
import type { AcpRelay } from "../agents/acp/relay";
import type { DeviceChannel, DispatchTarget } from "./channel";
import type { DeviceScreens } from "./screen";
import { type DeviceOwner, type DeviceStore, reportedApps, reportedRoots } from "./store";

/**
 * The frames a runner sends, and what the server does with them.
 *
 * Kept out of `index.ts` because the socket handler there is shared by three features (the computer
 * proxy, the channel rail and this) and dispatching on frame content inside that already is how the
 * other two stopped being readable.
 */
export type RunnerSocketData = {
  runner: DeviceOwner;
  /**
   * This socket's registration with the dispatch channel, taken when it opened.
   *
   * Held on the socket rather than in a side map because the close handler has to release exactly the
   * entry this connection created — a reconnect of the same machine replaces the device's entry, and
   * detaching by device id would drop the live one.
   */
  connection?: string;
  /**
   * The external agents' frames that arrived while the socket was still opening (its registration
   * waits on the database), in order, taken in once it is registered. A runner sends its inventory
   * and its whole replay the moment the socket opens, so these are the first frames of every
   * reconnect, not a corner case. Undefined once opened, or when it never will be.
   */
  held?: Record<string, unknown>[];
  /**
   * Settles once the socket has opened (or will not), with the held frames handed to the relay. A
   * heartbeat that arrives while it is opening waits for it before its ack: the ack must come after
   * those frames are taken in.
   */
  opening?: Promise<void>;
};

/** Frames held while a socket opens, at most; past that it is closed and the runner tries again. */
const HELD_LIMIT = 200_000;

export type RunnerSocketLike = {
  data: RunnerSocketData;
  send(value: string): void;
  close?: (code?: number, reason?: string) => void;
};

/**
 * A runner's socket opened: mark it alive and register it as dispatchable.
 *
 * Both, and in that order. The heartbeat is the owner's screen's answer to "is it here"; the channel
 * registration is this process's answer to "can I write to it", and they are different facts — the
 * first is shared with every replica and lives for a minute, the second dies with this socket.
 */
export async function runnerOpen(
  ws: RunnerSocketLike,
  store: DeviceStore,
  channel: DeviceChannel,
  screens?: DeviceScreens,
  acp?: Pick<AcpRelay, "fromRunner">,
): Promise<void> {
  // Before the first await: a frame can arrive while this waits on the database.
  ws.data.held = [];
  let opened = () => {};
  ws.data.opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  try {
    if (!(await store.isCurrent(ws.data.runner).catch(() => false))) {
      ws.close?.(1008, "Device access was revoked.");
      return;
    }
    const { tenantId, deviceId } = ws.data.runner;
    await store.heartbeat(tenantId, deviceId);
    const connection = channel.attach(
      { tenantId, deviceId },
      ws,
      ws.data.runner.credentialVersion,
    );
    ws.data.connection = connection;
    // Registered and handed over in one go, so nothing that arrives later can overtake them.
    for (const frame of ws.data.held ?? [])
      acp?.fromRunner({ tenantId, deviceId, connectionId: connection }, frame);
  } finally {
    ws.data.held = undefined;
    ws.data.opening = undefined;
    opened();
  }
  const { tenantId, deviceId } = ws.data.runner;
  ws.send(JSON.stringify({ type: "welcome" }));
  // Anybody still watching a coworker on this machine gets the screen back without reloading.
  screens?.resume({ tenantId, deviceId });
}

/** It closed: release the registration, and fail whatever was waiting on this socket. */
export function runnerClose(
  ws: RunnerSocketLike,
  channel: DeviceChannel,
): void {
  ws.data.held = undefined;
  if (ws.data.connection) channel.detach(ws.data.connection);
}

// --- desktop control (sub-project 2) ---
/**
 * The owner's latest stop of a desktop session, as a heartbeat carries it once (plan Task 13): which
 * Bot and person the session was for, and how it was stopped (`hotkey`, `mouse`, `button`). Untrusted
 * input from the device; never a token.
 */
export type DesktopStoppedInfo = {
  botId: string;
  actorId: string;
  reason: string;
  at?: number;
};

export type RunnerMessageOptions = {
  /** A heartbeat reported a desktop stop on this machine. Wired to the desktop write gate. */
  onDesktopStopped?: (
    target: DispatchTarget,
    info: DesktopStoppedInfo,
  ) => void | Promise<void>;
  /** The external agents' `acp.*` frames (agents/acp/relay.ts). Absent, they are dropped quietly. */
  acp?: Pick<AcpRelay, "fromRunner" | "drain" | "resumeQueued">;
};

/** A heartbeat's `desktopStopped`, kept only when it has the shape the runner sends. */
function desktopStoppedOf(value: unknown): DesktopStoppedInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { botId, actorId, reason, at } = value as Record<string, unknown>;
  const text = (field: unknown): field is string =>
    typeof field === "string" && field.length > 0 && field.length <= 200;
  if (!text(botId) || !text(actorId) || typeof reason !== "string")
    return undefined;
  return {
    botId,
    actorId,
    reason: reason.slice(0, 40),
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
  };
}
// --- end desktop control ---

export async function runnerMessage(
  ws: RunnerSocketLike,
  store: DeviceStore,
  channel: DeviceChannel,
  raw: string | Buffer | ArrayBuffer | Uint8Array,
  screens?: DeviceScreens,
  options: RunnerMessageOptions = {},
): Promise<void> {
  /*
   * The live screen, before the database is asked anything.
   *
   * A frame arrives many times a second, and awaiting a registration read for each one would let them
   * overtake each other on the way to the viewer. The connection is checked in memory instead: it is
   * this device's current socket, not detached, revoked or replaced, which the channel's own periodic
   * validation keeps true against the database. A screen frame from anything else is dropped.
   */
  const early = readFrame(raw);
  if (screens && early && isScreenFrameType(early.type)) {
    if (ws.data.connection && channel.isAttached(ws.data.connection)) {
      screens.fromRunner(
        {
          tenantId: ws.data.runner.tenantId,
          deviceId: ws.data.runner.deviceId,
        },
        early,
      );
    }
    return;
  }
  /*
   * The external agents' frames, checked the same way and for the same reason: their order is
   * their meaning (an update's `seq`, an end after its updates), and frames that each waited on the
   * database here could overtake each other. The relay keeps one device's frames in order from
   * here on. None of them is ever "nothing handles": a runner that sends one is not waiting for an
   * answer, and an unknown `acp.*` type is the relay's to log.
   */
  if (
    early &&
    typeof early.type === "string" &&
    early.type.startsWith("acp.")
  ) {
    const held = ws.data.held;
    if (held) {
      if (held.length < HELD_LIMIT) held.push(early);
      else ws.close?.(1011, "Too many frames before the socket opened.");
      return;
    }
    if (
      options.acp &&
      ws.data.connection &&
      channel.isAttached(ws.data.connection)
    ) {
      options.acp.fromRunner(
        {
          tenantId: ws.data.runner.tenantId,
          deviceId: ws.data.runner.deviceId,
          connectionId: ws.data.connection,
        },
        early,
      );
    }
    return;
  }
  if (!(await store.isCurrent(ws.data.runner).catch(() => false))) {
    if (ws.data.connection) channel.detach(ws.data.connection);
    ws.close?.(1008, "Device access was revoked.");
    return;
  }
  const frame = early;
  if (frame && frame.type === "result") {
    // An answer to something this process asked. It is consumed whether or not a request is waiting:
    // a late reply to a deadline that already passed must not be read as an unknown frame.
    channel.settle(ws.data.runner, frame, ws.data.connection);
    return;
  }
  if (!frame || typeof frame.type !== "string") {
    ws.send(
      JSON.stringify({ type: "error", error: "Frames must be JSON objects." }),
    );
    return;
  }
  const { tenantId, deviceId } = ws.data.runner;
  if (frame.type === "heartbeat") {
    // A runner that offers read-only folders lists them on every beat (story F1, stage 2): a
    // reference and a name each, checked in `reportedRoots`. A beat without the field changes none.
    await store.heartbeat(
      tenantId,
      deviceId,
      reportedRoots(frame.roots),
      reportedApps(frame.apps),
    );
    // --- desktop control (sub-project 2) ---
    // The owner stopped a desktop session: forget it here and record it. A failure here never costs
    // the beat its ack.
    const stopped = desktopStoppedOf(frame.desktopStopped);
    if (stopped && options.onDesktopStopped) {
      try {
        await options.onDesktopStopped({ tenantId, deviceId }, stopped);
      } catch {
        // Recorded or not, the device has already ended its session.
      }
    }
    // --- end desktop control ---
    /*
     * The external agents' runner lets an ended turn's frames go when this beat's ack comes back,
     * so the ack waits until the relay has taken in every frame that arrived before the beat. One
     * that could not be taken in (the database failed) must not be let go: the socket is closed
     * instead, and the runner reconnects and sends it all again.
     */
    // A beat that came while the socket was opening: the held frames go in first.
    if (ws.data.opening) await ws.data.opening;
    if (
      options.acp &&
      !(await options.acp.drain({
        tenantId,
        deviceId,
        connectionId: ws.data.connection,
      }))
    ) {
      if (ws.data.connection) channel.detach(ws.data.connection);
      ws.close?.(1011, "Some frames could not be taken in; send them again.");
      return;
    }
    // THE ONLY `ack` THE SERVER SENDS. The runner matches acks to its heartbeats in order, one ack
    // per heartbeat (runner/src/acp/host.ts `acked`): an ack sent for anything else, or a beat
    // acked twice, would let it drop frames that have not arrived.
    ws.send(JSON.stringify({ type: "ack" }));
    void channel.flush({ tenantId, deviceId }).catch(() => undefined);
    // External agents' turns that waited for this machine, oldest first per thread.
    void options.acp
      ?.resumeQueued({ tenantId, deviceId })
      .catch(() => undefined);
    return;
  }
  /*
   * Named rather than dropped.
   *
   * A frame the server ignores is a runner that believes it said something. Ticket 017 adds the
   * frames that carry work, and until then the honest answer to an unknown one is that nothing here
   * handles it.
   */
  ws.send(
    JSON.stringify({
      type: "error",
      error: `Nothing handles a "${frame.type}" frame yet.`,
    }),
  );
}

function readFrame(
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): Record<string, unknown> | null {
  let text: string;
  try {
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Uint8Array)
      text = Buffer.from(raw).toString("utf8");
    else text = Buffer.from(raw).toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
