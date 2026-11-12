import { DESKTOP_LIMITS } from "../../../shared/desktop-control";
import { type ControlChannel, sessionLabel } from "./control";

/**
 * The desktop session, as the device holds it (plan docs/plans/2026-11-12-desktop-write.md, Task 13;
 * design decision 5; ruling C5).
 *
 * THE DEVICE IS THE AUTHORITY. The server mints the token after the owner approves and hands it over
 * with `desktop.session_start`; every write carries it back. The device keeps exactly one session:
 * a new one ends the old (`replaced`). It ends after `sessionIdleMs` without a write, after
 * `sessionMaxMs` in all, when the owner stops it (hotkey, mouse, tray button), and when the server
 * ends it.
 *
 * NOT WRITABLE UNTIL THE DEVICE'S GUARD IS UP. `start` says `session-started` and waits up to
 * `sessionReadyMs` for the device to confirm its banner, stop key and mouse check; until then
 * `check` is `"none"`. Without that confirmation the session ends (`ended`) and `start` answers false.
 *
 * The token never leaves this module except to the server, through `status`: on stdout a session is
 * its label.
 */

export type DesktopSessions = {
  /**
   * 已有会话就先以 "replaced" 结束。Says `session-started` and waits for the device's guard: true once
   * it is up, false (the session already ended) when it does not come up or this one was replaced.
   */
  start(input: {
    token: string;
    botId: string;
    actorId: string;
  }): Promise<boolean>;
  status(botId: string, actorId: string): { token: string } | undefined;
  /** ok 时续期闲置时间。 */
  check(
    token: unknown,
    botId: string,
    actorId: string,
  ): "ok" | "stopped" | "expired" | "none";
  end(token: string): void;
  /** 当前会话期间的中止信号：叫停时中止，让在途动作立即停下。 */
  readonly signal: AbortSignal | undefined;
  /** 最近一次叫停，等下一次心跳带走后清除。 */
  takeStopped():
    | { botId: string; actorId: string; reason: string; at: number }
    | undefined;
};

type EndReason = "stopped" | "expired" | "ended" | "replaced";

type Session = {
  token: string;
  botId: string;
  actorId: string;
  startedAt: number;
  lastUsed: number;
  ready: boolean;
  controller: AbortController;
  /** Settles `start`'s wait early when the session ends before the device answered. */
  cancel: () => void;
};

export function createDesktopSessions(opts: {
  control: ControlChannel;
  now?: () => number;
  idleMs?: number;
  maxMs?: number;
}): DesktopSessions {
  const { control } = opts;
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? DESKTOP_LIMITS.sessionIdleMs;
  const maxMs = opts.maxMs ?? DESKTOP_LIMITS.sessionMaxMs;

  let current: Session | undefined;
  /** The last session that was stopped or expired, so a late write learns why. */
  let lastEnded: { token: string; reason: "stopped" | "expired" } | undefined;
  let stopped:
    | { botId: string; actorId: string; reason: string; at: number }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (session: Session, reason: EndReason) => {
    if (current !== session) return;
    current = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastEnded =
      reason === "stopped" || reason === "expired"
        ? { token: session.token, reason }
        : undefined;
    control.emit({ event: "session-ended", reason });
    session.controller.abort();
    session.cancel();
  };

  const deadline = (session: Session) =>
    Math.min(session.lastUsed + idleMs, session.startedAt + maxMs);

  /** Ends the current session if its time is up; true when it did. */
  const expire = (): boolean => {
    const session = current;
    if (!session?.ready) return false;
    if (now() < deadline(session)) return false;
    finish(session, "expired");
    return true;
  };

  /**
   * Ends a session the moment its time is up, even with nothing calling `check`, so the device's
   * banner goes away. Rescheduled from the latest use whenever it fires early.
   */
  const schedule = () => {
    if (timer) clearTimeout(timer);
    const session = current;
    if (!session?.ready) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!expire()) schedule();
      },
      Math.max(0, deadline(session) - now()),
    );
    (timer as { unref?: () => void }).unref?.();
  };

  control.onStop((reason) => {
    const session = current;
    if (!session) return;
    stopped = {
      botId: session.botId,
      actorId: session.actorId,
      reason,
      at: now(),
    };
    finish(session, "stopped");
  });

  return {
    async start(input) {
      if (current) finish(current, "replaced");
      const at = now();
      let cancel: () => void = () => {};
      const cancelled = new Promise<"cancelled">((resolve) => {
        cancel = () => resolve("cancelled");
      });
      const session: Session = {
        token: input.token,
        botId: input.botId,
        actorId: input.actorId,
        startedAt: at,
        lastUsed: at,
        ready: false,
        controller: new AbortController(),
        cancel,
      };
      current = session;
      const label = sessionLabel(input.token);
      const answered = control.waitReady(label);
      control.emit({ event: "session-started", label });
      const outcome = await Promise.race([answered, cancelled]);
      if (current !== session) return false;
      if (outcome !== "ready") {
        finish(session, "ended");
        return false;
      }
      session.ready = true;
      session.lastUsed = now();
      schedule();
      return true;
    },
    status(botId, actorId) {
      expire();
      const session = current;
      if (!session?.ready) return undefined;
      if (session.botId !== botId || session.actorId !== actorId)
        return undefined;
      return { token: session.token };
    },
    check(token, botId, actorId) {
      if (typeof token !== "string") return "none";
      expire();
      const session = current;
      if (
        session?.ready &&
        session.token === token &&
        session.botId === botId &&
        session.actorId === actorId
      ) {
        session.lastUsed = now();
        return "ok";
      }
      if (lastEnded?.token === token) return lastEnded.reason;
      return "none";
    },
    end(token) {
      if (current?.token === token) finish(current, "ended");
    },
    get signal() {
      return current?.controller.signal;
    },
    takeStopped() {
      const taken = stopped;
      stopped = undefined;
      return taken;
    },
  };
}
