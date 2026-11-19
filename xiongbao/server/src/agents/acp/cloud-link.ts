import { randomUUID } from "node:crypto";
import { acpCloudAgentOf } from "../../../../shared/acp";
import { HEADER } from "../../../../shared/wire-headers";
import { seatHeaders } from "../../computer/client";
import type { ComputerGateway } from "../../computer/gateway";
import {
  type DeviceChannel,
  type DispatchTarget,
  isRunnerAddress,
} from "../../devices/channel";
import type { AcpRelay } from "./relay";

/**
 * The road to a cloud employee's computer for the `acp.*` frames: the same frames the relay
 * (relay.ts) carries to and from a paired machine, over the computer's HTTP port instead of a socket.
 *
 * WHERE IT SITS. The relay asks its channel three things: write this frame to that "device"
 * (`notify`), is it reachable (`isReachable`), which connection would that frame go out on
 * (`connectionOf`). A cloud employee is its own device, named `cloud:<agentId>`
 * (`acpCloudDeviceId`), so its lanes, queued turns, reconciliation and adoption are the relay's own,
 * unchanged; this module answers those three for such a device, and `withCloudDevices` puts it in
 * front of the real channel, which answers for every other. Nothing above the relay (the agent, the
 * permission bridge, the delivery loop) knows which kind of device a turn is on.
 *
 * THE COMPUTER IS FOUND THE WAY EVERY CALL TO IT IS: the gateway's seat for the employee and its hirer
 * (`seatFor`), its address (`locate`, which wakes a computer that is stopped and pushes it its network
 * policy before it answers), its own token and the headers that name the seat. No pairing, no device
 * identity, and no second way to a computer.
 *
 * DOWN. Frames are POSTed to `/acp/frame`, one after another per employee (an `acp.open` must arrive
 * before its `acp.prompt`), once the stream below is open: the computer's inventory has then arrived,
 * and a prompt sent on this connection is never taken for a turn the computer lost.
 *
 * UP. One long-lived `GET /acp/events` per employee, read line by line (agent-computer/src/acp-cloud.ts).
 * Each line goes to the relay as `fromRunner` with this connection's id; each `acp.beat` is what a
 * runner's heartbeat is: the relay is drained (so every frame before the beat has been taken in),
 * the computer is told with `POST /acp/ack`, and the employee's queued turns get their chance
 * (`resumeQueued`). A beat the relay could not drain is not acknowledged and the stream is dropped, so
 * the computer sends it all again on the next one.
 *
 * HOW LONG IT STAYS OPEN. While any turn of the employee is on the computer (a turn can wait hours for
 * its hirer's permission, and the computer keeps what it has until this side has the frames), and for
 * `idleMs` after the last thing sent or heard. A stream that drops while a turn is on the computer is
 * opened again, with a growing wait. A turn found over by inventory (a computer that restarted does
 * not list it) leaves the set, and the relay ends it as it would for a device.
 *
 * WHEN A FRAME CANNOT GO. Said the way a device would say it, as frames the relay already knows: an
 * `acp.open` that could not be delivered is the open's `acp.error`; an `acp.prompt` is an `acp.error`
 * of its turn and an `acp.turn.end` with `stopReason: "error"`. So the run ends with a sentence and
 * the lane goes on, instead of waiting for a computer that was never told.
 *
 * AFTER THIS SERVER RESTARTS the link starts empty. An employee's stream is opened again by whatever
 * next goes to it, and by `ensure`, which a turn waiting behind an older one calls: the computer's
 * inventory and replay then settle what was left (the relay adopts a turn still running there, and
 * interrupts one the computer lost).
 */

/** What the link needs of the computer gateway: where an employee's computer is and how to call it. */
export type CloudComputers = Pick<
  ComputerGateway,
  "seatFor" | "locate" | "tokenFor" | "addressOf"
>;

export type CloudLinkOptions = {
  gateway: CloudComputers;
  /** The relay is built with the channel this link is part of, so it is given later. */
  relay: () =>
    | Pick<AcpRelay, "fromRunner" | "drain" | "resumeQueued">
    | undefined;
  /** False where this deployment has no computers: a cloud employee is then not reachable. */
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  /** How long a stream with nothing on the computer stays open. */
  idleMs?: number;
  /** The waits before a stream that dropped is opened again, and before a send is tried again. */
  retryMs?: readonly number[];
  now?: () => number;
  log?: (message: string) => void;
};

export type CloudLink = {
  /** The channel for a device id, with the cloud ones answered here and the rest by `base`. */
  withCloudDevices(base: DeviceChannel): DeviceChannel;
  /** Opens the employee's stream if it is not open (a turn waiting behind an older one asks). */
  ensure(target: DispatchTarget): void;
  /**
   * Opens the employee's stream and waits until the relay has taken in what the computer said first
   * (its inventory), so a turn claimed after this is one that inventory could not have missed.
   * Rejects when the computer cannot be reached.
   */
  open(target: DispatchTarget): Promise<void>;
  /** How many employees have a link (tests, diagnostics). */
  links(): number;
  close(): void;
};

/** How long a stream with no turn on the computer stays open: the computer's own idle time. */
export const CLOUD_LINK_IDLE_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;
/** A POST that has not answered by then did not reach a computer that is working. */
const POST_TIMEOUT_MS = 30_000;
/** How many times a send is tried before it is given up on. */
const SEND_ATTEMPTS = 3;

/** The computer answered and said no: not a thing a second try changes. */
class Refused extends Error {
  override name = "CloudRefused";
}

const NOT_READY = "云电脑还没准备好，这一轮没有开始，请稍后再试。";

type Frame = Record<string, unknown>;

type Endpoint = { base: string; headers: Record<string, string> };

type Link = {
  key: string;
  target: DispatchTarget;
  agentId: string;
  /** The relay's id for the open stream, or for the one being opened; null when there is none. */
  connectionId: string | null;
  /** The computer's own id for the open stream, which its acknowledgements quote. */
  streamId: string | null;
  endpoint: Endpoint | null;
  opening: Promise<void> | null;
  abort: AbortController | null;
  /** Frames down, one after another. */
  sends: Promise<void>;
  /** Beats, one after another: an ack answers one beat. */
  beats: Promise<void>;
  /** The turns this employee has on its computer, as far as this process knows. */
  inflight: Set<string>;
  lastWork: number;
  retry: ReturnType<typeof setTimeout> | null;
  attempts: number;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export function createCloudLink(options: CloudLinkOptions): CloudLink {
  const { gateway } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const enabled = options.enabled !== false;
  const idleMs = options.idleMs ?? CLOUD_LINK_IDLE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  const links = new Map<string, Link>();
  let closed = false;

  const keyOf = (target: DispatchTarget) =>
    JSON.stringify([target.tenantId, target.deviceId]);

  /** The link for a cloud device, made on first use; undefined for any other device id. */
  function linkFor(target: DispatchTarget, make: boolean): Link | undefined {
    const agentId = acpCloudAgentOf(target.deviceId);
    if (!agentId) return undefined;
    const key = keyOf(target);
    let link = links.get(key);
    if (!link && make) {
      link = {
        key,
        target: { tenantId: target.tenantId, deviceId: target.deviceId },
        agentId,
        connectionId: null,
        streamId: null,
        endpoint: null,
        opening: null,
        abort: null,
        sends: Promise.resolve(),
        beats: Promise.resolve(),
        inflight: new Set(),
        lastWork: now(),
        retry: null,
        attempts: 0,
      };
      links.set(key, link);
    }
    return link;
  }

  /** Where the employee's computer is, woken if it was stopped; named as every call to it is. */
  async function endpointOf(link: Link): Promise<Endpoint> {
    if (link.endpoint) return link.endpoint;
    const seat = await gateway.seatFor(link.agentId, link.target.tenantId);
    const address = await gateway.locate(seat);
    // A paired machine is not this: an employee that runs in the cloud is not on a device.
    if (isRunnerAddress(address)) throw new Refused(NOT_READY);
    const token = gateway.tokenFor(seat);
    link.endpoint = {
      base: address.replace(/\/$/, ""),
      headers: {
        ...seatHeaders(gateway.addressOf(seat)),
        ...(token ? { [HEADER.computerToken]: token } : {}),
      },
    };
    return link.endpoint;
  }

  const source = (link: Link, connectionId = link.connectionId) => ({
    ...link.target,
    connectionId: connectionId ?? randomUUID(),
  });

  /** A frame in the words a device would send it in, for the relay. */
  const say = (link: Link, frame: Frame, connectionId?: string | null) =>
    options.relay()?.fromRunner(source(link, connectionId), frame);

  function wanted(link: Link): boolean {
    return link.inflight.size > 0 || now() - link.lastWork < idleMs;
  }

  function schedule(link: Link) {
    if (link.retry || closed) return;
    const wait = retryMs[Math.min(link.attempts, retryMs.length - 1)] ?? 30_000;
    link.attempts += 1;
    link.retry = setTimeout(() => {
      link.retry = null;
      if (closed || link.opening || !wanted(link)) return;
      ensureStream(link).catch(() => schedule(link));
    }, wait);
    (link.retry as { unref?: () => void }).unref?.();
  }

  /** Reads the stream: each line to the relay, each beat to the beat's own job. */
  async function read(
    link: Link,
    connectionId: string,
    response: Response,
    opened: () => void,
  ) {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          continue;
        }
        if (link.connectionId !== connectionId) return;
        onLine(link, connectionId, frame, opened);
      }
    }
  }

  function onLine(
    link: Link,
    connectionId: string,
    frame: Frame,
    opened: () => void,
  ) {
    const type = text(frame.type);
    if (type === "acp.stream") {
      link.streamId = text(frame.connectionId) ?? null;
      opened();
      return;
    }
    if (type === "acp.beat") {
      link.beats = link.beats
        .then(() => beat(link, connectionId))
        .catch(() => {});
      return;
    }
    if (!type?.startsWith("acp.")) return;
    // What is on the computer, as far as it says: what keeps the stream open.
    const turnId = text(frame.turnId);
    if (type === "acp.inventory" && Array.isArray(frame.turns)) {
      link.inflight = new Set(
        (frame.turns as { turnId?: unknown; state?: unknown }[])
          .filter((turn) => turn.state !== "ended")
          .flatMap((turn) => (text(turn.turnId) ? [text(turn.turnId)] : []))
          .filter((id): id is string => id !== undefined),
      );
    } else if (turnId) {
      if (type === "acp.turn.end") link.inflight.delete(turnId);
      else link.inflight.add(turnId);
    }
    if (type !== "acp.inventory") link.lastWork = now();
    options.relay()?.fromRunner(source(link, connectionId), frame);
  }

  /** One beat: the relay has every frame before it, then the computer is told, then queued turns go. */
  async function beat(link: Link, connectionId: string) {
    const relay = options.relay();
    if (!relay || link.connectionId !== connectionId) return;
    const taken = await relay
      .drain(source(link, connectionId))
      .catch(() => false);
    if (link.connectionId !== connectionId) return;
    if (!taken) {
      // Not acknowledged: the stream is dropped and the computer sends everything again.
      link.abort?.abort();
      return;
    }
    const { endpoint, streamId } = link;
    if (endpoint && streamId) {
      await doFetch(`${endpoint.base}/acp/ack`, {
        method: "POST",
        headers: { ...endpoint.headers, "content-type": "application/json" },
        body: JSON.stringify({ connectionId: streamId }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    void relay.resumeQueued(link.target).catch(() => undefined);
    if (link.inflight.size === 0 && !wanted(link)) stop(link);
  }

  /** The stream ended, however it did. */
  function ended(link: Link, connectionId: string, reason: unknown) {
    if (link.connectionId !== connectionId) return;
    const wasOpen = link.streamId !== null;
    link.streamId = null;
    link.endpoint = null;
    link.opening = null;
    link.abort = null;
    // A stream that was open is a connection that is over; one that never opened keeps its id for
    // the next try, which the frames waiting to go out were told.
    if (wasOpen) link.connectionId = null;
    if (reason !== undefined && !closed)
      log(
        `acp cloud ${link.agentId}: the stream ended: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    if (!closed && wanted(link)) schedule(link);
    else if (link.inflight.size === 0 && !link.retry) links.delete(link.key);
  }

  /** Opens the employee's stream, once; resolves when the computer has said it is open. */
  function ensureStream(link: Link): Promise<void> {
    if (link.opening) return link.opening;
    if (closed) return Promise.reject(new Error("closed"));
    const connectionId = link.connectionId ?? randomUUID();
    link.connectionId = connectionId;
    const abort = new AbortController();
    link.abort = abort;
    const opening = new Promise<void>((resolve, reject) => {
      let settled = false;
      const opened = () => {
        if (settled) return;
        settled = true;
        link.attempts = 0;
        resolve();
      };
      void (async () => {
        try {
          const endpoint = await endpointOf(link);
          const response = await doFetch(`${endpoint.base}/acp/events`, {
            method: "GET",
            headers: endpoint.headers,
            signal: abort.signal,
          });
          if (!response.ok || !response.body) {
            const said = (await response.json().catch(() => null)) as {
              error?: unknown;
            } | null;
            throw new Refused(
              response.status === 409 && text(said?.error)
                ? (text(said?.error) as string)
                : NOT_READY,
            );
          }
          await read(link, connectionId, response, opened);
          if (!settled) throw new Error("the stream closed before it opened");
          ended(link, connectionId, undefined);
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          ended(link, connectionId, abort.signal.aborted ? undefined : error);
        }
      })();
    });
    link.opening = opening;
    // Nobody may be waiting on it (a reconnect); its failure is handled by `ended`.
    opening.catch(() => undefined);
    return opening;
  }

  /** Closes the stream of an employee with nothing on its computer. */
  function stop(link: Link) {
    const abort = link.abort;
    link.connectionId = null;
    link.streamId = null;
    link.endpoint = null;
    link.opening = null;
    link.abort = null;
    abort?.abort();
    if (link.inflight.size === 0 && !link.retry) links.delete(link.key);
  }

  async function post(link: Link, frame: Frame) {
    const endpoint = await endpointOf(link);
    let response: Response;
    try {
      response = await doFetch(`${endpoint.base}/acp/frame`, {
        method: "POST",
        headers: { ...endpoint.headers, "content-type": "application/json" },
        body: JSON.stringify(frame),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (error) {
      // The address may be a computer that has gone: look for it again next time.
      link.endpoint = null;
      throw error;
    }
    if (response.ok) return;
    const said = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    if (response.status >= 400 && response.status < 500)
      throw new Refused(text(said?.error) ?? NOT_READY);
    link.endpoint = null;
    throw new Error(`the computer answered ${response.status}`);
  }

  /** One frame down: the stream first, then the POST; tried again where a second try can help. */
  async function deliver(link: Link, frame: Frame) {
    let last: unknown;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
      if (closed) throw new Error("closed");
      try {
        await ensureStream(link);
        await post(link, frame);
        return;
      } catch (error) {
        last = error;
        if (error instanceof Refused) throw error;
        const wait = retryMs[Math.min(attempt, retryMs.length - 1)] ?? 1_000;
        if (attempt + 1 < SEND_ATTEMPTS)
          await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw last;
  }

  /** A frame that could not go, told to the relay the way a device would have told it. */
  function failed(link: Link, frame: Frame, error: unknown) {
    const reason = error instanceof Refused ? error.message : NOT_READY;
    log(
      `acp cloud ${link.agentId}: a ${String(frame.type)} could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
    );
    const agentId = text(frame.agentId) ?? link.agentId;
    const threadId = text(frame.threadId);
    if (frame.type === "acp.open" && threadId) {
      say(link, {
        type: "acp.error",
        agentId,
        threadId,
        code: "start_failed",
        message: reason,
      });
    } else if (frame.type === "acp.prompt" && threadId) {
      const turnId = text(frame.turnId);
      if (!turnId) return;
      link.inflight.delete(turnId);
      say(link, {
        type: "acp.error",
        agentId,
        threadId,
        turnId,
        code: "start_failed",
        message: reason,
      });
      say(link, {
        type: "acp.turn.end",
        agentId,
        threadId,
        turnId,
        stopReason: "error",
        interrupted: false,
      });
    }
  }

  return {
    withCloudDevices(base) {
      return {
        ...base,
        isReachable(target) {
          // Answered without waking anything: presence asks it of every cloud employee in a roster.
          return acpCloudAgentOf(target.deviceId)
            ? enabled && !closed
            : base.isReachable(target);
        },
        connectionOf(target) {
          const link = linkFor(target, true);
          if (!link) return base.connectionOf(target);
          // The id the stream will be opened under, so a frame sent now is on that connection.
          link.connectionId ??= randomUUID();
          return link.connectionId;
        },
        notify(target, frame) {
          const link = linkFor(target, true);
          if (!link) return base.notify(target, frame);
          if (!enabled || closed) return false;
          link.lastWork = now();
          if (frame.type === "acp.prompt") {
            const turnId = text(frame.turnId);
            if (turnId) link.inflight.add(turnId);
          }
          link.sends = link.sends
            .then(() => deliver(link, frame))
            .catch((error) => failed(link, frame, error));
          return true;
        },
      };
    },
    ensure(target) {
      const link = linkFor(target, true);
      if (!link || !enabled || closed) return;
      link.lastWork = now();
      ensureStream(link).catch(() => schedule(link));
    },
    async open(target) {
      const link = linkFor(target, true);
      if (!link || !enabled || closed) return;
      link.lastWork = now();
      await ensureStream(link);
      const relay = options.relay();
      if (relay && link.connectionId)
        await relay.drain(source(link, link.connectionId));
    },
    links: () => links.size,
    close() {
      closed = true;
      for (const link of links.values()) {
        if (link.retry) clearTimeout(link.retry);
        link.abort?.abort();
      }
      links.clear();
    },
  };
}
