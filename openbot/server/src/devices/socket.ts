import { isScreenFrameType } from "../../../shared/device-screen";
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
};

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
): Promise<void> {
  if (!(await store.isCurrent(ws.data.runner).catch(() => false))) {
    ws.close?.(1008, "Device access was revoked.");
    return;
  }
  const { tenantId, deviceId } = ws.data.runner;
  await store.heartbeat(tenantId, deviceId);
  ws.data.connection = channel.attach(
    { tenantId, deviceId },
    ws,
    ws.data.runner.credentialVersion,
  );
  ws.send(JSON.stringify({ type: "welcome" }));
  // Anybody still watching a coworker on this machine gets the screen back without reloading.
  screens?.resume({ tenantId, deviceId });
}

/** It closed: release the registration, and fail whatever was waiting on this socket. */
export function runnerClose(
  ws: RunnerSocketLike,
  channel: DeviceChannel,
): void {
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
  const early = screens ? readFrame(raw) : null;
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
  if (!(await store.isCurrent(ws.data.runner).catch(() => false))) {
    if (ws.data.connection) channel.detach(ws.data.connection);
    ws.close?.(1008, "Device access was revoked.");
    return;
  }
  const frame = readFrame(raw);
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
    ws.send(JSON.stringify({ type: "ack" }));
    void channel.flush({ tenantId, deviceId }).catch(() => undefined);
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
