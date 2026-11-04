import { parseInputMessage } from "../../../agent-computer/src/request-validation";
import {
  readScreenUpFrame,
  type ScreenDownFrame,
} from "../../../shared/device-screen";
import type { DispatchTarget } from "./channel";

/**
 * The live screen of a coworker's browser on a tenant's own machine, relayed to the people watching
 * it (F2 stage 2, R-a).
 *
 * The container's computer serves its own screen on a socket this server dials. A device cannot be
 * dialled, so here the runner sends its frames up the socket it opened (`runner/src/screencast.ts`)
 * and this fans them out to the viewers' sockets, and a person's input travels the other way.
 *
 * WHOSE SCREEN IS DECIDED HERE, AND ONLY FROM FACTS. A viewer is admitted for exactly one device of
 * exactly one tenant: the one the upgrade located for a Bot the person may see, and only when that
 * device's tenant is the person's own frame. A frame from a runner is keyed by the tenant and device
 * its socket authenticated as, never by anything inside it, so a runner cannot paint another tenant's
 * screen and a viewer cannot be pointed at another tenant's device by naming it.
 *
 * Input is forwarded only from the person who holds the wheel for that Bot on that device, which the
 * takeover registry answers. Watching is not driving.
 */

/** The one call this needs of a viewer's socket: Bun's `ServerWebSocket` has all three. */
export type ScreenViewer = {
  send(value: string): unknown;
  close?: (code?: number, reason?: string) => void;
  getBufferedAmount?: () => number;
};

/** Who is watching what, fixed at upgrade. */
export type ScreenWatch = {
  /** The tenant frame of the person signed in. Compared with the device's, never assumed equal. */
  viewerTenant: string;
  /** The signed-in person, which is who input is attributed to and who a takeover belongs to. */
  userId: string;
  target: DispatchTarget;
  botId: string;
};

export class ScreenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenRefusedError";
  }
}

/**
 * Said to a stranger. The same words as a Bot that does not exist, because the difference between
 * "not yours" and "not there" is itself a fact about another tenant.
 */
export const NOT_YOUR_SCREEN = "There is no such Bot.";
export const DEVICE_AWAY =
  "This coworker's machine is not connected right now. The screen starts by itself when it is back.";
/** The same words the container's computer uses, so the surface explains it the same way. */
export const TAKE_CONTROL_FIRST =
  "Take control before driving the computer yourself.";
const NOT_JSON = "Input is not JSON.";

/**
 * Bytes waiting for a viewer above which a frame is skipped for that viewer.
 *
 * A slow browser gets the next frame instead of a backlog: a stale frame is worse than a missing one.
 */
const MAX_VIEWER_BUFFERED_BYTES = 2 * 1024 * 1024;

export type DeviceScreensOptions = {
  /** Write a screen frame to the device's current socket. False when it is not here. */
  notify: (target: DispatchTarget, frame: ScreenDownFrame) => boolean;
  /** Who holds the wheel for this Bot on this device, as a user id; null for the Bot. */
  holderOf?: (target: DispatchTarget, botId: string) => string | null;
  /** A person's last screen for this Bot on this device closed. The takeover may end with it. */
  onViewerGone?: (watch: ScreenWatch) => void;
  maxViewerBufferedBytes?: number;
};

export type DeviceScreens = {
  /** Admit a viewer, or throw `ScreenRefusedError`. Starts the device's cast for the first one. */
  subscribe: (viewer: ScreenViewer, watch: ScreenWatch) => void;
  /** A viewer closed. The last one stops the cast. */
  unsubscribe: (viewer: ScreenViewer) => void;
  /** One message from a viewer: input, forwarded only for the person holding the wheel. */
  input: (
    viewer: ScreenViewer,
    raw: string | Buffer | ArrayBuffer | Uint8Array,
  ) => void;
  /**
   * One screen frame from a runner. `from` is the identity its socket authenticated as. True when the
   * frame was a screen frame, consumed whether or not anybody is watching.
   */
  fromRunner: (from: DispatchTarget, frame: Record<string, unknown>) => boolean;
  /** A runner (re)connected: start the casts somebody is still waiting on. */
  resume: (target: DispatchTarget) => void;
  /** How many viewers this Bot's screen on this device has. */
  viewers: (target: DispatchTarget, botId: string) => number;
  /** Whether this person has a screen open for this Bot on this device. */
  watching: (target: DispatchTarget, botId: string, userId: string) => boolean;
};

const keyOf = (target: DispatchTarget, botId: string) =>
  `${target.tenantId}\u0000${target.deviceId}\u0000${botId}`;

export function createDeviceScreens(
  options: DeviceScreensOptions,
): DeviceScreens {
  /** Bot screen key → the viewers watching it. */
  const rooms = new Map<
    string,
    { target: DispatchTarget; botId: string; viewers: Set<ScreenViewer> }
  >();
  const watches = new Map<ScreenViewer, ScreenWatch>();
  const ceiling = options.maxViewerBufferedBytes ?? MAX_VIEWER_BUFFERED_BYTES;

  const tell = (viewer: ScreenViewer, message: Record<string, unknown>) => {
    try {
      viewer.send(JSON.stringify(message));
    } catch {
      // Gone. Its close handler unsubscribes it.
    }
  };

  const start = (target: DispatchTarget, botId: string): boolean =>
    options.notify(target, {
      type: "screen.start",
      tenantId: target.tenantId,
      botId,
    });

  const self: DeviceScreens = {
    subscribe(viewer, watch) {
      /*
       * The device's tenant, against the frame of the person asking. The upgrade only reaches here for
       * a Bot the person may see, and a Bot's machine is its owner's; this is the line that keeps it so
       * if either of those ever stops being true, rather than trusting that it is.
       */
      if (
        !watch.viewerTenant ||
        watch.viewerTenant !== watch.target.tenantId ||
        !watch.userId ||
        !watch.botId
      ) {
        throw new ScreenRefusedError(NOT_YOUR_SCREEN);
      }
      const key = keyOf(watch.target, watch.botId);
      let room = rooms.get(key);
      if (!room) {
        room = { target: watch.target, botId: watch.botId, viewers: new Set() };
        rooms.set(key, room);
      }
      room.viewers.add(viewer);
      watches.set(viewer, watch);
      // Asked every time, not only for the first viewer: a second viewer is owed a fresh frame, and
      // the runner treats a repeated start as "say where you stand".
      if (!start(watch.target, watch.botId))
        tell(viewer, { type: "error", error: DEVICE_AWAY });
    },

    unsubscribe(viewer) {
      const watch = watches.get(viewer);
      if (!watch) return;
      watches.delete(viewer);
      const key = keyOf(watch.target, watch.botId);
      const room = rooms.get(key);
      room?.viewers.delete(viewer);
      if (room && room.viewers.size === 0) {
        rooms.delete(key);
        options.notify(watch.target, {
          type: "screen.stop",
          botId: watch.botId,
        });
      }
      if (!self.watching(watch.target, watch.botId, watch.userId)) {
        options.onViewerGone?.(watch);
      }
    },

    input(viewer, raw) {
      const watch = watches.get(viewer);
      if (!watch) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          typeof raw === "string"
            ? raw
            : Buffer.from(raw as Uint8Array).toString("utf8"),
        );
      } catch {
        tell(viewer, { type: "error", error: NOT_JSON });
        return;
      }
      const validated = parseInputMessage(parsed);
      if (!validated.ok) {
        tell(viewer, { type: "error", error: validated.error });
        return;
      }
      // Watching is not driving: only the person who took the wheel, for this Bot, on this machine.
      if (options.holderOf?.(watch.target, watch.botId) !== watch.userId) {
        tell(viewer, { type: "error", error: TAKE_CONTROL_FIRST });
        return;
      }
      if (
        !options.notify(watch.target, {
          type: "screen.input",
          botId: watch.botId,
          input: validated.message,
        })
      ) {
        tell(viewer, { type: "error", error: DEVICE_AWAY });
      }
    },

    fromRunner(from, frame) {
      if (typeof frame.type !== "string" || !frame.type.startsWith("screen."))
        return false;
      const read = readScreenUpFrame(frame);
      if (!read) return true;
      const room = rooms.get(keyOf(from, read.botId));
      // Nobody asked for this Bot's screen from this device: dropped, never relayed elsewhere.
      if (!room) return true;
      const message =
        read.type === "screen.frame"
          ? JSON.stringify({
              type: "frame",
              data: read.data,
              width: read.width,
              height: read.height,
            })
          : JSON.stringify(
              read.state === "error"
                ? {
                    type: "error",
                    error: read.error ?? "The screen could not be shown.",
                  }
                : { type: "status", state: read.state },
            );
      for (const viewer of room.viewers) {
        if (
          read.type === "screen.frame" &&
          (viewer.getBufferedAmount?.() ?? 0) > ceiling
        )
          continue;
        try {
          viewer.send(message);
        } catch {
          // Its close handler unsubscribes it.
        }
      }
      return true;
    },

    resume(target) {
      for (const room of rooms.values()) {
        if (
          room.target.tenantId === target.tenantId &&
          room.target.deviceId === target.deviceId
        )
          start(target, room.botId);
      }
    },

    viewers(target, botId) {
      return rooms.get(keyOf(target, botId))?.viewers.size ?? 0;
    },

    watching(target, botId, userId) {
      const room = rooms.get(keyOf(target, botId));
      if (!room) return false;
      for (const viewer of room.viewers) {
        if (watches.get(viewer)?.userId === userId) return true;
      }
      return false;
    },
  };
  return self;
}
