/**
 * External employees (Claude Code) on THIS computer: the receiving end of the server's `acp.*`
 * frames for an employee whose runtime is `cloud`.
 *
 * WHAT IT IS. The runner's ACP host (`runner/src/acp/host.ts`) is the same code an owner's machine
 * runs: it starts the employee's adapter, gives each thread an ACP session, keeps every frame of a
 * turn until the server has proved it arrived, and replays them on reconnect. Only the road differs.
 * A runner dials the server and is known by its pairing; a computer is dialled by the server, over
 * this HTTP port, behind the computer token every route here already needs (index.ts refuses an
 * unauthorised request before it reaches this module). There is no pairing and no device identity.
 *
 *   POST /acp/frame    one frame from the server (`acp.open`, `acp.prompt`, `acp.cancel`,
 *                      `acp.permission.answer`). Answers `{handled}` once the host has taken it; the
 *                      work itself goes on in the host.
 *   GET  /acp/events   the frames up, one JSON object per line, for as long as the server holds the
 *                      response open. First `acp.stream` (this connection's id), then what the host has
 *                      (its inventory, everything kept), then each new frame; `acp.beat` every
 *                      `beatMs`. A newer stream for the same employee replaces the older one.
 *   POST /acp/ack      `{connectionId}`: the server took in every frame before the latest beat. Matched
 *                      to beats in order, one ack per beat, exactly as a runner's heartbeat ack.
 *
 * ONE HOST PER EMPLOYEE. A computer can carry several employees (a person's computer carries every
 * Bot that person uses), and the host keeps one adapter process per employee already, but its buffer
 * and its connection are one each. A host per seat keeps every employee's frames, replay and
 * acknowledgements apart, and the seat is the employee: a frame whose `agentId` is not the seat that
 * sent it is refused, so one employee's route cannot speak for another.
 *
 * WHERE IT WORKS. The employee's working folder is the folder its file tools and shell already use
 * (the seat's folder in the workspace), named by one fixed reference (`ACP_CLOUD_WORKDIR_REF`); no
 * path comes from the server and `apps` is empty (a cloud computer has no registered apps of an
 * owner's). An employee with a Linux user of its own (`COMPUTER_PER_BOT_USERS`) is refused: the adapter
 * would run as this process's user in that employee's folder, which is the isolation that setting
 * exists to keep.
 *
 * WHAT THE ADAPTER IS GIVEN. Not this process's environment: an allow list (the same one a shell
 * command gets, with the egress filter's proxy variables so the employee's own network use is judged
 * by the network policy like any command's) and a home folder of its own (`homeRoot/<seat>`,
 * outside the working folder), so the agent's own state (Claude Code's sessions) neither lands in the
 * employee's files nor in another employee's.
 *
 * Imports no browser driver, so it can be tested without Chrome.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AcpHost,
  type AcpHostDeps,
  createAcpHost,
} from "../../runner/src/acp/host";
import { ACP_CLOUD_WORKDIR_REF } from "../../shared/acp";

/** The largest frame accepted from the server: a prompt with a thread's context can be long. */
export const ACP_FRAME_BODY_LIMIT = 8 * 1024 * 1024;
/** How often an open stream says it is alive, and asks to be acknowledged. */
export const ACP_BEAT_MS = 4_000;

const PATHS = new Set(["/acp/frame", "/acp/events", "/acp/ack"]);

/** Whether this path is one of the employee channel's. */
export function isAcpPath(pathname: string): boolean {
  return PATHS.has(pathname);
}

export type CloudAcpOptions = {
  /**
   * The seat's working folder (made when missing), or null when this seat cannot run an external
   * employee here (it has a Linux user of its own).
   */
  workdirFor: (seat: string) => Promise<string | null>;
  /** The image's adapters: `<install folder>/node_modules/.bin`. */
  binDir: string;
  /** Where adapters are started from, never a working folder (manifest.ts `prepareAdapterDir`). */
  adapterDir: string;
  /** The folder the agents' own homes are made in, one per seat. */
  homeRoot: string;
  /** The environment an adapter runs with, as an allow list; `home` is this seat's own home. */
  env: (seat: string, workdir: string, home: string) => Record<string, string>;
  /** `process.env` unless a test passes one: its names are unset for the adapter. */
  parentEnv?: Record<string, string | undefined>;
  beatMs?: number;
  /** Tests: a stand-in for starting the adapter process. */
  spawn?: AcpHostDeps["spawn"];
  tempRoot?: string;
  idleMs?: number;
  cancelGraceMs?: number;
};

export type CloudAcp = {
  handle(request: Request, url: URL, seat: string): Promise<Response>;
  /** How many employees have a host here (tests, diagnostics). */
  hosts(): number;
  closeAll(): Promise<void>;
};

type Stream = {
  id: string;
  /** Ends the response; nothing more is written to it. */
  close: () => void;
};

type Seat = {
  host: AcpHost;
  stream: Stream | null;
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

export function createCloudAcp(options: CloudAcpOptions): CloudAcp {
  const beatMs = options.beatMs ?? ACP_BEAT_MS;
  const seats = new Map<string, Promise<Seat | null>>();
  const encoder = new TextEncoder();

  /** The seat's host, made on first use; null when the seat cannot run an employee here. */
  function seatFor(seat: string): Promise<Seat | null> {
    let known = seats.get(seat);
    if (!known) {
      known = (async () => {
        const workdir = await options.workdirFor(seat);
        if (workdir === null) return null;
        const home = join(options.homeRoot, seat);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const host = createAcpHost({
          roots: (ref) => (ref === ACP_CLOUD_WORKDIR_REF ? workdir : null),
          apps: () => null,
          adapterDir: options.adapterDir,
          cloud: {
            binDir: options.binDir,
            env: () => options.env(seat, workdir, home),
            ...(options.parentEnv ? { parentEnv: options.parentEnv } : {}),
          },
          ...(options.spawn ? { spawn: options.spawn } : {}),
          ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
          ...(options.idleMs ? { idleMs: options.idleMs } : {}),
          ...(options.cancelGraceMs
            ? { cancelGraceMs: options.cancelGraceMs }
            : {}),
        });
        return { host, stream: null } satisfies Seat;
      })();
      // A seat that could not be made is tried again next time rather than refused for good.
      known.catch(() => seats.delete(seat));
      seats.set(seat, known);
    }
    return known;
  }

  const refusedSeat = () =>
    json(
      {
        error:
          "这台电脑上的这位员工有自己独立的 Linux 用户，外部员工暂时不能在这样的电脑上运行。",
      },
      409,
    );

  async function frame(request: Request, seat: string): Promise<Response> {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > ACP_FRAME_BODY_LIMIT)
      return json({ error: "The frame is too large." }, 413);
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json({ error: "A frame has to be a JSON object." }, 400);
    // The seat is the employee: its route speaks for it and for nobody else.
    if (body.agentId !== seat)
      return json({ error: "That frame is not for this employee." }, 400);
    const held = await seatFor(seat);
    if (!held) return refusedSeat();
    return json({ handled: await held.host.handle(body) });
  }

  async function events(request: Request, seat: string): Promise<Response> {
    const held = await seatFor(seat);
    if (!held) return refusedSeat();
    const id = randomUUID();
    let timer: ReturnType<typeof setInterval> | undefined;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let over = false;
    const stop = () => {
      if (over) return;
      over = true;
      if (timer) clearInterval(timer);
      try {
        controller.close();
      } catch {
        // Already closed by the other end.
      }
    };
    const write = (value: Record<string, unknown>) => {
      if (over) throw new Error("the stream is over");
      controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    };
    const stream = new ReadableStream<Uint8Array>({
      start(made) {
        controller = made;
      },
      cancel() {
        // The server went away. A newer stream has already replaced this one when it is not current.
        if (over) return;
        over = true;
        if (timer) clearInterval(timer);
        if (held.stream?.id === id) {
          held.stream = null;
          held.host.detach();
        }
      },
    });
    // One stream per employee: the older one is ended without detaching, the host's one connection
    // now belongs to the new one.
    held.stream?.close();
    held.stream = { id, close: stop };
    write({ type: "acp.stream", connectionId: id });
    held.host.attach((frameUp) => write(frameUp));
    timer = setInterval(() => {
      try {
        write({ type: "acp.beat" });
        held.host.heartbeatSent();
      } catch {
        stop();
      }
    }, beatMs);
    timer.unref?.();
    request.signal.addEventListener(
      "abort",
      () => {
        if (held.stream?.id === id) {
          held.stream = null;
          held.host.detach();
        }
        stop();
      },
      { once: true },
    );
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      },
    });
  }

  async function ack(request: Request, seat: string): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      connectionId?: unknown;
    } | null;
    const held = await seatFor(seat);
    if (!held) return refusedSeat();
    // An ack of a stream that is gone proves nothing about the one that replaced it.
    if (
      typeof body?.connectionId !== "string" ||
      held.stream?.id !== body.connectionId
    )
      return json({ acked: false }, 409);
    held.host.acked();
    return json({ acked: true });
  }

  return {
    async handle(request, url, seat) {
      const path = url.pathname;
      if (path === "/acp/events" && request.method === "GET")
        return events(request, seat);
      if (path === "/acp/frame" && request.method === "POST")
        return frame(request, seat);
      if (path === "/acp/ack" && request.method === "POST")
        return ack(request, seat);
      return json({ error: "Not found." }, 404);
    },
    hosts: () => seats.size,
    async closeAll() {
      const made = await Promise.all(
        [...seats.values()].map((seat) => seat.catch(() => null)),
      );
      for (const seat of made) {
        seat?.stream?.close();
        await seat?.host.closeAll();
      }
      seats.clear();
    },
  };
}
