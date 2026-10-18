import type { DeviceChannel } from "./channel";
import type { DeviceOwner, DeviceStore } from "./store";

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
}

/** It closed: release the registration, and fail whatever was waiting on this socket. */
export function runnerClose(
  ws: RunnerSocketLike,
  channel: DeviceChannel,
): void {
  if (ws.data.connection) channel.detach(ws.data.connection);
}

export async function runnerMessage(
  ws: RunnerSocketLike,
  store: DeviceStore,
  channel: DeviceChannel,
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): Promise<void> {
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
    await store.heartbeat(tenantId, deviceId);
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
