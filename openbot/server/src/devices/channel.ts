import { randomUUID } from "node:crypto";
import { computerActionOrigin } from "../computer/action-identity";
import {
  actionFingerprint,
  DEVICE_PAUSED,
  DeviceDeliveryError,
  type DeviceQueue,
} from "./queue";

/**
 * The server's side of the runner socket: who is connected here, and how to ask one of them to do
 * something (ticket 017).
 *
 * A device is reached only over a socket IT opened, so this holds no addresses and opens nothing. It
 * answers one question — can a frame be written to this machine right now, from THIS process — and
 * turns a request into a frame and its reply back into a promise. That is deliberately not a second
 * copy of presence: the screen's online/offline is `last_seen_at` in the database, which every server
 * behind a load balancer can see. A dispatch cannot use that, because only one process holds the
 * socket, and writing to a device that is alive on another replica would silently do nothing.
 */

export type RunnerSocketLike = {
  send(value: string): void;
  close?: (code?: number, reason?: string) => void;
};

export type DispatchTarget = { tenantId: string; deviceId: string };

export class DeviceOfflineError extends Error {
  constructor(readonly deviceId: string) {
    super(
      `设备 ${deviceId} 现在没有连到服务器。设备端会自己重连，电脑开机并打开设备端后就会恢复。`,
    );
    this.name = "DeviceOfflineError";
  }
}

export class DeviceActionError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "DeviceActionError";
  }
}

export type DeviceChannel = {
  /** A runner's socket opened. Returns the id `detach` is later called with. */
  attach: (
    target: DispatchTarget,
    socket: RunnerSocketLike,
    credentialVersion?: string,
  ) => string;
  revoke: (target: DispatchTarget) => void;
  validateConnections: () => Promise<void>;
  flush: (target: DispatchTarget) => Promise<number>;
  /**
   * It closed. Anything still waiting on that exact socket is failed, because an answer for a frame
   * nobody can see anymore is never coming.
   */
  detach: (connectionId: string) => void;
  /** True when a frame can be written to this device from this process right now. */
  isReachable: (target: DispatchTarget) => boolean;
  /**
   * Whether this exact connection is still the device's live one: not detached, not revoked, not
   * replaced by a reconnect. Answered from memory, for frames too frequent to ask the database about.
   */
  isAttached: (connectionId: string) => boolean;
  /**
   * Write one frame that is not an action — the live screen's start, stop and input — to the device's
   * current socket. Nothing is waited for and nothing is queued: a screen frame for a machine that is
   * away is stale by the time it returns. False when nothing could be written from this process.
   */
  notify: (target: DispatchTarget, frame: Record<string, unknown>) => boolean;
  /** Any reachable device of this tenant, for the selection that binds work to a machine. */
  reachableDevice: (tenantId: string) => string | null;
  /** Ask one machine to do something and wait for its answer. */
  dispatch: <T>(
    target: DispatchTarget,
    action: string,
    payload: unknown,
    timeoutMs?: number,
    /** Whose identity this action is, so the same one offered twice is queued and run once. */
    idempotencyKey?: string,
    caller?: AbortSignal,
    /**
     * `durable: false` is for a read that changes nothing (a local app's tool list): written straight
     * to the connected socket, never queued, never given a receipt, so losing it cannot pause the
     * device. Refused at once when the machine is not connected to this process.
     */
    mode?: { durable?: boolean },
  ) => Promise<T>;
  /**
   * A frame arrived from a runner. Delivered only when it answers a request this process sent to that
   * same tenant and device; false means the frame was not ours to consume.
   */
  settle: (
    from: DispatchTarget,
    frame: Record<string, unknown>,
    connectionId?: string,
  ) => boolean;
};

/**
 * How long an answer is waited for.
 *
 * Longer than a click, shorter than a person's patience. A command that hangs on the machine costs the
 * turn its deadline rather than the server's whole request budget — the same reason the HTTP transport
 * carries its own timeout.
 */
const DEFAULT_DISPATCH_TIMEOUT_MS = 60_000;

type Pending = {
  /** The request's own device key: a reply is accepted only from the machine it went to. */
  key: string;
  socket: RunnerSocketLike;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  clearAbort?: () => void;
};

export function createDeviceChannel(options?: {
  /**
   * Where an action goes when the machine is not here (ticket 018).
   *
   * Absent keeps the old answer — a refusal — which is right for a deployment with no devices to
   * queue for, and wrong to invent a default for: silently parking work nobody asked to keep is its
   * own kind of surprise.
   */
  queue?: DeviceQueue;
  /** Fresh durable registration check. Omitted only for deployments without authenticated devices. */
  authorize?: (
    target: DispatchTarget,
    credentialVersion?: string,
  ) => Promise<boolean>;
  validationIntervalMs?: number;
  /**
   * Called after every flush, drained or not, so the outcome of each action that waited for this
   * machine is told to the conversation that queued it. Its own failures never fail the flush.
   */
  afterFlush?: (target: DispatchTarget) => Promise<unknown>;
}): DeviceChannel {
  const sockets = new Map<string, RunnerSocketLike>();
  const identities = new Map<
    string,
    { target: DispatchTarget; credentialVersion?: string }
  >();
  let validationTimer: ReturnType<typeof setInterval> | undefined;
  let validating: Promise<void> | undefined;
  /** `tenant/device` → connectionId, so a machine that reconnects replaces its own entry. */
  const byDevice = new Map<string, string>();
  const pending = new Map<string, Pending>();
  const queue = options?.queue;
  const actions = new Map<
    string,
    { fingerprint: string; result: Promise<unknown> }
  >();

  const keyOf = (target: DispatchTarget) =>
    `${target.tenantId}/${target.deviceId}`;

  const drop = (id: string, error: Error) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.clearAbort?.();
    entry.reject(error);
  };

  const sendDirect = async <T>(
    target: DispatchTarget,
    action: string,
    payload: unknown,
    timeoutMs: number | undefined,
    actionId: string,
    caller?: AbortSignal,
  ): Promise<T> => {
    if (caller?.aborted)
      throw new DeviceActionError(
        "The device action was stopped before dispatch.",
      );
    const connectionId = byDevice.get(keyOf(target));
    const socket = connectionId ? sockets.get(connectionId) : undefined;
    if (options?.authorize) {
      const version = connectionId
        ? identities.get(connectionId)?.credentialVersion
        : undefined;
      const valid = await options.authorize(target, version).catch(() => false);
      if (!valid) {
        if (connectionId && byDevice.get(keyOf(target)) === connectionId)
          self.revoke(target);
        throw new DeviceActionError(
          "This device registration is no longer valid.",
        );
      }
      if (socket && byDevice.get(keyOf(target)) !== connectionId)
        throw new DeviceActionError(
          "The device connection changed before dispatch.",
        );
    }
    if (!socket) throw new DeviceOfflineError(target.deviceId);
    if (caller?.aborted)
      throw new DeviceActionError(
        "The device action was stopped before dispatch.",
      );
    const id = randomUUID();
    const budget = timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        try {
          socket.send(JSON.stringify({ type: "cancel", key: actionId }));
        } catch {
          /* The receipt stays unknown. */
        }
      };
      const abort = () => {
        cancel();
        drop(
          id,
          new DeviceActionError(
            "The device action was stopped after dispatch; its outcome is unknown.",
            true,
          ),
        );
      };
      caller?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        key: keyOf(target),
        socket,
        resolve: (value) => resolve(value as T),
        reject,
        clearAbort: () => caller?.removeEventListener("abort", abort),
        timer: setTimeout(() => {
          cancel();
          drop(
            id,
            new DeviceActionError(
              `${target.deviceId} did not answer the ${action} within ${budget / 1000}s; the action outcome is unknown.`,
              true,
            ),
          );
        }, budget),
      });
      try {
        socket.send(
          JSON.stringify({
            type: "action",
            id,
            key: actionId,
            action,
            payload,
          }),
        );
      } catch {
        drop(
          id,
          new DeviceActionError(
            "The action could not be confirmed on the device; its outcome is unknown.",
            true,
          ),
        );
      }
    });
  };

  const self: DeviceChannel = {
    attach(target, socket, credentialVersion) {
      if (options?.authorize && !credentialVersion)
        throw new DeviceActionError(
          "The device connection has no credential identity.",
        );
      self.revoke(target);
      const connectionId = randomUUID();
      sockets.set(connectionId, socket);
      identities.set(connectionId, { target, credentialVersion });
      byDevice.set(keyOf(target), connectionId);
      if (options?.authorize && !validationTimer)
        validationTimer = setInterval(() => {
          if (validating) return;
          validating = self.validateConnections().finally(() => {
            validating = undefined;
          });
        }, options.validationIntervalMs ?? 1000);
      if (queue) {
        // What waited, run now, oldest first, through the socket that just opened. The lease owner is
        // this connection, so a second reconnect cannot take over an action the first is running.
        void self.flush(target).catch(() => undefined);
      }
      return connectionId;
    },

    async flush(target) {
      const connectionId = byDevice.get(keyOf(target));
      if (!queue || !connectionId) return 0;
      try {
        return await queue.drain(target, connectionId, (item) =>
          sendDirect(target, item.action, item.payload, undefined, item.key),
        );
      } finally {
        await options?.afterFlush?.(target).catch(() => undefined);
      }
    },

    detach(connectionId) {
      const socket = sockets.get(connectionId);
      sockets.delete(connectionId);
      identities.delete(connectionId);
      if (sockets.size === 0 && validationTimer) {
        clearInterval(validationTimer);
        validationTimer = undefined;
      }
      for (const [key, id] of byDevice) {
        if (id === connectionId) byDevice.delete(key);
      }
      if (!socket) return;
      for (const [id, entry] of pending) {
        if (entry.socket !== socket) continue;
        drop(
          id,
          new DeviceActionError(
            "The connection to the machine went away; the action outcome is unknown.",
            true,
          ),
        );
      }
    },

    revoke(target) {
      const id = byDevice.get(keyOf(target));
      if (!id) return;
      const socket = sockets.get(id);
      self.detach(id);
      try {
        socket?.close?.(1008, "Device access was revoked.");
      } catch {
        /* Already closed. */
      }
    },

    async validateConnections() {
      if (!options?.authorize) return;
      for (const [id, identity] of [...identities]) {
        const valid = await options
          .authorize(identity.target, identity.credentialVersion)
          .catch(() => false);
        if (!valid && byDevice.get(keyOf(identity.target)) === id)
          self.revoke(identity.target);
      }
    },

    isReachable(target) {
      const connectionId = byDevice.get(keyOf(target));
      return connectionId !== undefined && sockets.has(connectionId);
    },

    isAttached(connectionId) {
      const identity = identities.get(connectionId);
      return (
        identity !== undefined &&
        sockets.has(connectionId) &&
        byDevice.get(keyOf(identity.target)) === connectionId
      );
    },

    notify(target, frame) {
      const connectionId = byDevice.get(keyOf(target));
      const socket = connectionId ? sockets.get(connectionId) : undefined;
      if (!socket) return false;
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    },

    reachableDevice(tenantId) {
      const prefix = `${tenantId}/`;
      for (const [key, connectionId] of byDevice) {
        if (!key.startsWith(prefix)) continue;
        if (!sockets.has(connectionId)) continue;
        return key.slice(prefix.length);
      }
      return null;
    },

    dispatch<T>(
      target: DispatchTarget,
      action: string,
      payload: unknown,
      timeoutMs?: number,
      idempotencyKey?: string,
      caller?: AbortSignal,
      mode?: { durable?: boolean },
    ): Promise<T> {
      if (caller?.aborted)
        return Promise.reject(
          new DeviceActionError(
            "The device action was stopped before dispatch.",
          ),
        );
      const key = idempotencyKey ?? randomUUID();
      if (mode?.durable === false) {
        if (!self.isReachable(target))
          return Promise.reject(new DeviceOfflineError(target.deviceId));
        return (async () => {
          /*
           * A paused device takes nothing new, not even a read: the person has not checked the
           * action whose outcome is unknown yet, and a read can still start a program there.
           */
          if (queue && (await queue.uncertain(target)) > 0)
            throw new DeviceDeliveryError(DEVICE_PAUSED, false);
          // `sendDirect` asks `authorize` itself before writing the frame.
          return sendDirect<T>(target, action, payload, timeoutMs, key, caller);
        })();
      }
      const offer = (): Promise<T> => {
        if (!self.isReachable(target)) {
          if (!queue)
            return Promise.reject(new DeviceOfflineError(target.deviceId));
          return (async () => {
            const origin = computerActionOrigin.getStore();
            await queue.enqueue(target, {
              key,
              action,
              payload,
              ...(origin ? { origin } : {}),
            });
            const receipt = await queue.receipt(target, key);
            if (receipt?.state === "completed") return receipt.output as T;
            if (receipt?.state === "unknown" || receipt?.state === "failed")
              throw new DeviceDeliveryError(
                "上一次的同一操作没有确认成功的结果。请先在设备上核查，再重新发起。",
                receipt.state === "unknown",
              );
            if (await queue.uncertain(target))
              throw new DeviceDeliveryError(
                "这台设备已暂停：有一项结果不明的操作等待核查。请设备的主人先在「设置 › 我的设备」里核查并恢复，之后才会接受新的操作。",
              );
            return { queued: true, key } as T;
          })();
        }
        const identity = `${keyOf(target)}/${key}`;
        const fingerprint = actionFingerprint(action, payload);
        const previous = queue ? undefined : actions.get(identity);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return Promise.reject(
              new DeviceDeliveryError(
                "This action id already belongs to a different request.",
                false,
              ),
            );
          return previous.result as Promise<T>;
        }
        const result = queue
          ? queue.executeOnce<T>(
              target,
              { key, action, payload },
              () =>
                sendDirect<T>(target, action, payload, timeoutMs, key, caller),
              timeoutMs,
            )
          : sendDirect<T>(target, action, payload, timeoutMs, key, caller);
        if (!queue) actions.set(identity, { fingerprint, result });
        return result;
      };
      if (!options?.authorize) return offer();
      const connectionId = byDevice.get(keyOf(target));
      const version = connectionId
        ? identities.get(connectionId)?.credentialVersion
        : undefined;
      return options
        .authorize(target, version)
        .catch(() => false)
        .then((valid) => {
          if (!valid) {
            if (connectionId && byDevice.get(keyOf(target)) === connectionId)
              self.revoke(target);
            throw new DeviceActionError(
              "This device registration is no longer valid.",
            );
          }
          return offer();
        });
    },

    settle(from, frame, connectionId) {
      const id = typeof frame.id === "string" ? frame.id : "";
      const entry = pending.get(id);
      if (!entry) return false;
      if (entry.key !== keyOf(from)) return false;
      if (connectionId && entry.socket !== sockets.get(connectionId))
        return false;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.clearAbort?.();
      if (frame.ok === true) {
        entry.resolve(frame.output ?? null);
        return true;
      }
      const reason =
        typeof frame.error === "string" && frame.error
          ? frame.error
          : "The machine refused the action.";
      entry.reject(
        new DeviceActionError(reason, frame.outcomeUnknown === true),
      );
      return true;
    },
  };
  return self;
}

/**
 * The address a located runner-backed computer carries.
 *
 * Not a URL, and that is the point: nothing here can be `fetch`ed. The scheme exists so the gateway can
 * tell a machine it dispatches to from a host it sends HTTP to, and so a device id can never be
 * mistaken for an address by the code that checks one.
 */
const RUNNER_ADDRESS_PREFIX = "runner:";

export function runnerAddress(target: DispatchTarget): string {
  return `${RUNNER_ADDRESS_PREFIX}${target.tenantId}/${target.deviceId}`;
}

export function isRunnerAddress(address: string): boolean {
  return address.startsWith(RUNNER_ADDRESS_PREFIX);
}

export function parseRunnerAddress(address: string): DispatchTarget | null {
  if (!isRunnerAddress(address)) return null;
  const body = address.slice(RUNNER_ADDRESS_PREFIX.length);
  const separator = body.indexOf("/");
  if (separator < 1 || separator === body.length - 1) return null;
  const tenantId = body.slice(0, separator);
  // A device id may itself contain a slash: it is minted as `hostname-8hex`, but a hostname is
  // permitted to hold one, and the tail is whatever is left rather than the next segment.
  const deviceId = body.slice(separator + 1);
  return { tenantId, deviceId };
}
