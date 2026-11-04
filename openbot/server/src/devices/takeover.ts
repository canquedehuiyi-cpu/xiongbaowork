import { randomUUID } from "node:crypto";
import type {
  ComputerControlState,
  HandoffRequest,
  HandoffSource,
} from "../../../shared/computer-control";
import { HandoffRequestError } from "../computer/client";
import type { DispatchTarget } from "./channel";

/**
 * Who holds the wheel of a coworker's browser on a tenant's own machine (F2 stage 2).
 *
 * The container's computer keeps this state itself (`agent-computer/src/control.ts`) and refuses the
 * Bot there. A device has no such thing to ask: it is a laptop that answers frames, and asking it
 * "may the Bot act" would be asking the machine to judge the very action the gateway is deciding. So
 * the state lives here, beside the relay, and the gateway asks it before it sends anything at all. A
 * refusal is a row in the trail and no frame on the wire.
 *
 * Per device AND per Bot. A person who took the wheel of one coworker's browser on their laptop has
 * not taken another coworker's, and a takeover on one machine says nothing about the same Bot's work
 * on another.
 *
 * The shape is the container's `ComputerControlState`, so the surface that already says 接管 and 交还
 * reads it unchanged and a Bot suspended for a handback resumes the same way.
 *
 * In memory, in the process that holds the screen. A deployment with several replicas has to route a
 * tenant's device traffic to one of them, which the runner channel already requires: a frame can
 * only be written from the process holding the machine's socket.
 */

/** Said to the Bot, and written on the refusal row. */
export const DEVICE_HUMAN_HAS_CONTROL =
  "A person has taken over this coworker's browser on its machine, or has been asked to. Wait for them to hand it back before acting.";

/** A request nobody answered goes back to the Bot after this, as the container's does. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** A person whose last screen closed has this long to come back before the wheel is handed back. */
const DEFAULT_RELEASE_GRACE_MS = 15_000;
/** The finished requests kept per Bot, so a suspended turn can still read how its request ended. */
const KEPT_REQUESTS = 32;
/** Entries kept at all; the oldest idle ones go first. */
const MAX_ENTRIES = 10_000;

type Entry = {
  holder: "bot" | "human";
  since: string;
  /** The person holding the wheel, when a person is. */
  userId?: string;
  currentId?: string;
  requests: HandoffRequest[];
  grace?: ReturnType<typeof setTimeout>;
};

export type TakeoverRelease = {
  target: DispatchTarget;
  botId: string;
  userId: string;
  requestId: string;
};

export type DeviceTakeoversOptions = {
  now?: () => number;
  releaseGraceMs?: number;
  /** Whether this person still has a screen open for this Bot on this device. */
  stillWatching?: (
    target: DispatchTarget,
    botId: string,
    userId: string,
  ) => boolean;
  /** The wheel went back because the person's screen closed. For the audit trail. */
  onReleasedOnDisconnect?: (release: TakeoverRelease) => void;
};

export type DeviceTakeovers = {
  state: (
    target: DispatchTarget,
    botId: string,
    requestId?: string,
  ) => ComputerControlState;
  request: (
    target: DispatchTarget,
    botId: string,
    reason: string,
    source?: HandoffSource,
    toolCallId?: string,
  ) => ComputerControlState;
  take: (
    target: DispatchTarget,
    botId: string,
    userId: string,
    requestId: string,
  ) => ComputerControlState;
  release: (
    target: DispatchTarget,
    botId: string,
    requestId: string,
  ) => ComputerControlState;
  cancel: (
    target: DispatchTarget,
    botId: string,
    requestId: string,
  ) => ComputerControlState;
  /** Whether the Bot must not act on this device right now: a person holds it or has been asked to. */
  blocks: (target: DispatchTarget, botId: string) => boolean;
  /** The person holding the wheel, or null while the Bot does. */
  holder: (target: DispatchTarget, botId: string) => string | null;
  /** The current request, for the refusal the Bot is handed. */
  current: (
    target: DispatchTarget,
    botId: string,
  ) => HandoffRequest | undefined;
  /** A person's last screen for this Bot on this device closed. */
  viewerGone: (watch: {
    target: DispatchTarget;
    botId: string;
    userId: string;
  }) => void;
};

const keyOf = (target: DispatchTarget, botId: string) =>
  `${target.tenantId}\u0000${target.deviceId}\u0000${botId}`;

export function createDeviceTakeovers(
  options: DeviceTakeoversOptions = {},
): DeviceTakeovers {
  const now = options.now ?? Date.now;
  const grace = options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS;
  const entries = new Map<string, Entry>();
  const iso = () => new Date(now()).toISOString();

  const active = (request: HandoffRequest | undefined) =>
    request?.status === "waiting" || request?.status === "taken";

  const entryOf = (target: DispatchTarget, botId: string): Entry => {
    const key = keyOf(target, botId);
    let entry = entries.get(key);
    if (entry) {
      // Most recently used last, so the trim below takes the oldest.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    }
    entry = { holder: "bot", since: iso(), requests: [] };
    entries.set(key, entry);
    for (const [old, held] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (held.holder === "human" || active(current(held))) continue;
      entries.delete(old);
    }
    return entry;
  };

  const current = (entry: Entry) =>
    entry.requests.find((request) => request.id === entry.currentId);

  const finish = (
    entry: Entry,
    request: HandoffRequest,
    status: "completed" | "cancelled" | "expired",
  ) => {
    const at = iso();
    request.status = status;
    request.updatedAt = at;
    request.finishedAt = at;
    if (entry.currentId === request.id) entry.currentId = undefined;
    if (entry.holder === "human") {
      entry.holder = "bot";
      entry.since = at;
      entry.userId = undefined;
    }
    if (entry.grace) {
      clearTimeout(entry.grace);
      entry.grace = undefined;
    }
    while (entry.requests.length > KEPT_REQUESTS + 1) {
      const oldest = entry.requests.findIndex((r) => r.id !== entry.currentId);
      if (oldest < 0) break;
      entry.requests.splice(oldest, 1);
    }
  };

  const expire = (entry: Entry) => {
    const request = current(entry);
    if (
      request?.status === "waiting" &&
      request.expiresAt &&
      Date.parse(request.expiresAt) <= now()
    )
      finish(entry, request, "expired");
  };

  const stateOf = (entry: Entry, requestId?: string): ComputerControlState => {
    expire(entry);
    const live = current(entry);
    const request = requestId
      ? entry.requests.find((r) => r.id === requestId)
      : live;
    if (requestId && !request)
      throw new HandoffRequestError("That request is not known here.", 404);
    return {
      holder: entry.holder,
      since: entry.since,
      requested: live?.status === "waiting",
      ...(live?.reason ? { reason: live.reason } : {}),
      ...(request ? { request: { ...request } } : {}),
      // A device answers between frames: there is no in-flight action to drain before a person drives.
      transitioning: false,
      resumeSnapshotRequired: false,
    };
  };

  /** The request a call names, which must be the current one. */
  const intended = (entry: Entry, requestId: string): HandoffRequest => {
    const request = entry.requests.find((r) => r.id === requestId);
    if (!request)
      throw new HandoffRequestError("That request is not known here.", 404);
    return request;
  };

  return {
    state: (target, botId, requestId) =>
      stateOf(entryOf(target, botId), requestId),

    request(target, botId, reason, source = "manual", toolCallId) {
      const entry = entryOf(target, botId);
      expire(entry);
      // One request at a time. Asking again while one is open is answered with the one already open.
      if (active(current(entry))) return stateOf(entry);
      const at = iso();
      const request: HandoffRequest = {
        id: randomUUID(),
        reason,
        source,
        status: "waiting",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(now() + REQUEST_TTL_MS).toISOString(),
        ...(toolCallId ? { toolCallId } : {}),
      };
      entry.requests.push(request);
      entry.currentId = request.id;
      return stateOf(entry);
    },

    take(target, botId, userId, requestId) {
      const entry = entryOf(target, botId);
      expire(entry);
      const request = intended(entry, requestId);
      if (request.status === "taken" && entry.userId === userId)
        return stateOf(entry);
      if (request.status !== "waiting" || entry.currentId !== request.id)
        throw new HandoffRequestError("That request is no longer active.", 409);
      const at = iso();
      request.status = "taken";
      request.updatedAt = at;
      entry.holder = "human";
      entry.since = at;
      entry.userId = userId;
      return stateOf(entry);
    },

    release(target, botId, requestId) {
      const entry = entryOf(target, botId);
      const request = intended(entry, requestId);
      if (request.status === "completed") return stateOf(entry);
      if (!active(request))
        throw new HandoffRequestError("That request is no longer active.", 409);
      finish(entry, request, "completed");
      return stateOf(entry);
    },

    cancel(target, botId, requestId) {
      const entry = entryOf(target, botId);
      const request = intended(entry, requestId);
      if (request.status === "cancelled") return stateOf(entry);
      if (!active(request))
        throw new HandoffRequestError("That request is no longer active.", 409);
      finish(entry, request, "cancelled");
      return stateOf(entry);
    },

    blocks(target, botId) {
      const entry = entries.get(keyOf(target, botId));
      if (!entry) return false;
      expire(entry);
      return entry.holder === "human" || active(current(entry));
    },

    holder(target, botId) {
      const entry = entries.get(keyOf(target, botId));
      return entry?.holder === "human" ? (entry.userId ?? null) : null;
    },

    current(target, botId) {
      const entry = entries.get(keyOf(target, botId));
      const request = entry ? current(entry) : undefined;
      return request ? { ...request } : undefined;
    },

    viewerGone({ target, botId, userId }) {
      const entry = entries.get(keyOf(target, botId));
      if (entry?.holder !== "human" || entry.userId !== userId) return;
      if (entry.grace) clearTimeout(entry.grace);
      /*
       * Not at once: a screen reconnecting after a dropped packet closes and reopens within a second,
       * and taking the wheel away in between would hand the page back to the Bot under a person's
       * hands. Past the grace with no screen of theirs open, nobody is driving, and a Bot left waiting
       * on a person who closed the tab would wait for ever.
       */
      entry.grace = setTimeout(() => {
        entry.grace = undefined;
        if (entry.holder !== "human" || entry.userId !== userId) return;
        if (options.stillWatching?.(target, botId, userId)) return;
        const request = current(entry);
        if (!request) return;
        finish(entry, request, "completed");
        options.onReleasedOnDisconnect?.({
          target,
          botId,
          userId,
          requestId: request.id,
        });
      }, grace);
    },
  };
}
