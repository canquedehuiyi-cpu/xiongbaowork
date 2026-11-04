import { parseInputMessage } from "../../agent-computer/src/request-validation";
import {
  type Screencast,
  startScreencastOn,
} from "../../agent-computer/src/screencast-session";
import {
  DEVICE_SCREENCAST,
  readScreenDownFrame,
  type ScreenUpFrame,
} from "../../shared/device-screen";
import {
  BrowserFailure,
  type BrowserIdentity,
  browserIdentityOf,
  type LivePage,
} from "./browser";

/**
 * The live screen of a coworker's browser on this machine, sent up the socket the runner already
 * opened (F2 stage 2, R-a).
 *
 * NO PORT. The container's computer serves its screen on a websocket the server dials; a laptop is
 * dialled by nobody, so here the server asks over the runner socket for a coworker's screen, the
 * frames go back up that same socket, and a person's input comes down it. Nothing on this machine
 * listens.
 *
 * The cast and the key translation are agent-computer's own (`screencast-session.ts`), so a person
 * pressing Enter on their own laptop gets the same `keyDown` the container sends. What this file adds
 * is the part a laptop needs: following the coworker's page as windows open and close, never starting
 * a browser just because somebody is watching, and dropping frames rather than queueing them when the
 * uplink is slower than Chrome.
 *
 * It decides nothing about who may watch or who may drive. The server answers both before a frame is
 * sent down — the subscription is the device's own tenant's, and input only arrives from the person
 * who took the wheel — and the input is checked here again only for shape.
 */

/** How often the cast checks it is still showing the page the coworker is on, as the container does. */
const FOLLOW_INTERVAL_MS = 1_000;

/**
 * Bytes waiting on the socket above which a frame is dropped.
 *
 * A stale frame is worse than a missing one, and a socket full of pictures is a socket on which an
 * action's answer waits behind them. Chrome only sends the next frame once this one is acknowledged,
 * which bounds the rate; this bounds the backlog.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

const NOTHING_TO_DRIVE =
  "The screen is not showing a page yet, so that input went nowhere.";

export type ScreenSource = {
  livePage: (identity: BrowserIdentity) => LivePage | undefined;
};

export type RunnerScreensOptions = {
  source: ScreenSource;
  /** Up the runner socket. A throw means the socket is gone, and the next frame is simply dropped. */
  send: (frame: ScreenUpFrame) => void;
  /** Bytes still waiting on the socket, when the socket can say. */
  buffered?: () => number;
  followMs?: number;
  maxBufferedBytes?: number;
};

export type RunnerScreens = {
  /** One frame from the server. False when it is not a screen frame, so the caller can route it on. */
  handle: (frame: Record<string, unknown>) => Promise<boolean>;
  /** Re-check every cast now, which the follow timer otherwise does once a second. */
  follow: () => Promise<void>;
  /** The socket closed: every cast stops, and the server starts them again on the next connection. */
  stopAll: () => Promise<void>;
  /** Which coworkers are being cast, for a test to read. */
  watching: () => string[];
};

type Session = {
  identity: BrowserIdentity;
  botId: string;
  cast?: Screencast;
  casting?: LivePage;
  stopped: boolean;
  /** One attach at a time, so a follow tick cannot start a second cast beside the first. */
  queue: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  lastState?: "idle" | "casting" | "error";
  lastError?: string;
};

export function createRunnerScreens(
  options: RunnerScreensOptions,
): RunnerScreens {
  const sessions = new Map<string, Session>();
  const followMs = options.followMs ?? FOLLOW_INTERVAL_MS;
  const ceiling = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  const send = (frame: ScreenUpFrame) => {
    try {
      options.send(frame);
    } catch {
      // The socket went away. The server stops the screen when it notices, and starts it again on the
      // next connection; there is nobody to tell in between.
    }
  };

  const report = (
    session: Session,
    state: "idle" | "casting" | "error",
    error?: string,
  ) => {
    // A status is a change, not a heartbeat: the follow timer asks every second.
    if (session.lastState === state && session.lastError === error) return;
    session.lastState = state;
    session.lastError = error;
    send({
      type: "screen.status",
      botId: session.botId,
      state,
      ...(error ? { error } : {}),
    });
  };

  const stopCast = async (session: Session) => {
    const cast = session.cast;
    session.cast = undefined;
    session.casting = undefined;
    await cast?.stop().catch(() => undefined);
  };

  /** Point the cast at the page the coworker is on now, whichever that is. */
  const attach = async (session: Session): Promise<void> => {
    if (session.stopped) return;
    const page = options.source.livePage(session.identity);
    if (page && page === session.casting && !page.isClosed()) return;
    await stopCast(session);
    if (!page || page.isClosed()) {
      report(session, "idle");
      return;
    }
    const client = await page.screencastClient();
    const cast = await startScreencastOn(
      client,
      (frame) => {
        if (session.stopped || session.cast !== cast) return;
        if ((options.buffered?.() ?? 0) > ceiling) return;
        send({
          type: "screen.frame",
          botId: session.botId,
          data: frame.data,
          width: frame.width,
          height: frame.height,
        });
      },
      DEVICE_SCREENCAST,
    );
    // Stopped while the session was being opened: the cast it produced is nobody's.
    if (session.stopped) {
      await cast.stop().catch(() => undefined);
      return;
    }
    session.cast = cast;
    session.casting = page;
    report(session, "casting");
  };

  const enqueue = (session: Session): Promise<void> => {
    const next = session.queue.then(() =>
      attach(session).catch((error) => {
        // The page went away mid-attach, or Chrome refused the session. The next tick tries again.
        session.cast = undefined;
        session.casting = undefined;
        report(
          session,
          "error",
          error instanceof Error
            ? error.message
            : "The screen could not be started.",
        );
      }),
    );
    session.queue = next;
    return next;
  };

  const stop = async (key: string) => {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.stopped = true;
    if (session.timer) clearInterval(session.timer);
    await session.queue;
    await stopCast(session);
  };

  return {
    async handle(raw) {
      const frame = readScreenDownFrame(raw);
      if (!frame) {
        if (typeof raw.type === "string" && raw.type.startsWith("screen.")) {
          // Ours, but not well formed. Consumed, so it is not mistaken for an action.
          return true;
        }
        return false;
      }
      if (frame.type === "screen.start") {
        let identity: BrowserIdentity;
        try {
          identity = browserIdentityOf({
            tenantId: frame.tenantId,
            botId: frame.botId,
          });
        } catch (error) {
          send({
            type: "screen.status",
            botId: frame.botId,
            state: "error",
            error:
              error instanceof BrowserFailure
                ? error.message
                : "The screen could not be started.",
          });
          return true;
        }
        // By Bot: a runner is paired to one tenant, and the tenant is checked below all the same.
        const key = frame.botId;
        const held = sessions.get(key);
        if (held && held.identity.tenantId === identity.tenantId) {
          /*
           * Asked again, for a second viewer: the cast is started afresh, because Chrome sends a frame
           * when a cast begins and otherwise only when the page changes. Carrying on would leave the
           * newcomer looking at nothing until something on a still page moved.
           */
          held.queue = held.queue.then(() => stopCast(held));
          held.lastState = undefined;
          await enqueue(held);
          return true;
        }
        if (held) await stop(key);
        const session: Session = {
          identity,
          botId: frame.botId,
          stopped: false,
          queue: Promise.resolve(),
        };
        sessions.set(key, session);
        session.timer = setInterval(() => {
          void enqueue(session);
        }, followMs);
        await enqueue(session);
        return true;
      }
      if (frame.type === "screen.stop") {
        await stop(frame.botId);
        return true;
      }
      // screen.input
      const session = sessions.get(frame.botId);
      const validated = parseInputMessage(frame.input);
      if (!validated.ok) {
        send({
          type: "screen.status",
          botId: frame.botId,
          state: "error",
          error: validated.error,
        });
        return true;
      }
      await session?.queue;
      const cast = session?.cast;
      if (!session || !cast) {
        send({
          type: "screen.status",
          botId: frame.botId,
          state: "error",
          error: NOTHING_TO_DRIVE,
        });
        return true;
      }
      try {
        await cast.send(validated.message);
      } catch (error) {
        // Said, not swallowed: a person whose click did nothing must not believe it landed.
        send({
          type: "screen.status",
          botId: frame.botId,
          state: "error",
          error:
            error instanceof Error
              ? error.message
              : "That input could not be applied.",
        });
      }
      return true;
    },

    async follow() {
      await Promise.all([...sessions.values()].map((s) => enqueue(s)));
    },

    async stopAll() {
      await Promise.all([...sessions.keys()].map((key) => stop(key)));
    },

    watching: () => [...sessions.keys()],
  };
}
