import { createHash } from "node:crypto";
import {
  DESKTOP_LIMITS,
  desktopMessage,
} from "../../../shared/desktop-control";
import { DesktopHelperError } from "./host";

/**
 * The control channel between the runner and the device app that started it (plan
 * docs/plans/2026-11-12-desktop-write.md, Task 13; design decisions 5 and 9; ruling C5).
 *
 * The runner speaks on stdout, one line per event: `runner: desktop <json>`. The device app reads
 * those lines anyway (it shows the runner's state in its tray), so stdout also reaches its logs:
 * NOTHING SECRET IS EVER WRITTEN HERE. A session is named by its label, the first eight hex digits of
 * the token's sha256, never by the token.
 *
 * The device answers on the runner's stdin, one JSON object per line: a stop (hotkey, mouse, tray
 * button), an ack that its mouse check is paused for a `--headed` step, and whether its banner, stop
 * key and mouse check came up for a new session. Anything else on stdin is ignored.
 *
 * A runner not started by the device app has no channel (`NO_CONTROL`): no banner and no stop key,
 * so no session can start and nothing physical can run.
 */

export const CONTROL_LINE_PREFIX = "runner: desktop ";

export type ControlEvent =
  /** `label`: the first 8 hex digits of the token's sha256, never the token (stdout reaches logs). */
  | { event: "session-started"; label: string }
  | {
      event: "session-ended";
      reason: "stopped" | "expired" | "ended" | "replaced";
    }
  | { event: "headed-begin"; seq: number }
  | { event: "headed-end"; seq: number }
  | { event: "permission-needed" };

export type ControlInput =
  | { control: "stop"; reason: "hotkey" | "mouse" | "button" }
  | { control: "headed-ack"; seq: number }
  /** The banner is up, the stop key registered and the mouse check running for this session. */
  | { control: "session-ready"; label: string }
  /** The device could not bring its guard up for this session. */
  | { control: "session-failed"; label: string; reason: string };

export type ReadyOutcome = "ready" | "failed" | "timeout";

export type ControlChannel = {
  readonly available: boolean;
  emit(event: ControlEvent): void;
  onStop(listener: (reason: string) => void): void;
  /**
   * Waits up to `sessionReadyMs` for the device's `session-ready` (or `session-failed`) naming this
   * label. Call it before emitting `session-started`, so an answer cannot slip past.
   */
  waitReady(label: string): Promise<ReadyOutcome>;
  /** 发 headed-begin，等 headed-ack（最多 headedAckMs），执行 run，最后不管成败都发 headed-end。等不到确认时抛 headed_unconfirmed，run 不执行。 */
  headed<T>(run: () => Promise<T>): Promise<T>;
};

const STOP_REASONS: ReadonlySet<string> = new Set([
  "hotkey",
  "mouse",
  "button",
]);
const LABEL = /^[0-9a-f]{8}$/;

/** A session's name on stdout: the first 8 hex digits of its token's sha256. */
export function sessionLabel(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/** One device line as a known input, or nothing. */
export function parseControlInput(line: string): ControlInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  switch (input.control) {
    case "stop":
      return typeof input.reason === "string" && STOP_REASONS.has(input.reason)
        ? {
            control: "stop",
            reason: input.reason as "hotkey" | "mouse" | "button",
          }
        : undefined;
    case "headed-ack":
      return Number.isSafeInteger(input.seq) && (input.seq as number) > 0
        ? { control: "headed-ack", seq: input.seq as number }
        : undefined;
    case "session-ready":
      return typeof input.label === "string" && LABEL.test(input.label)
        ? { control: "session-ready", label: input.label }
        : undefined;
    case "session-failed":
      return typeof input.label === "string" && LABEL.test(input.label)
        ? {
            control: "session-failed",
            label: input.label,
            reason: typeof input.reason === "string" ? input.reason : "",
          }
        : undefined;
    default:
      return undefined;
  }
}

/** UTF-8 chunks (the runner's stdin) as lines split on `\n`, a trailing `\r` dropped. */
export async function* linesOf(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of chunks) {
    buffered +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      yield buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered !== "") yield buffered;
}

function refusal(code: "headed_unconfirmed" | "no_control_channel") {
  return new DesktopHelperError(code, desktopMessage(code), false);
}

export function createControlChannel(opts: {
  lines: AsyncIterable<string>;
  write: (line: string) => void;
  ackMs?: number;
  /** A test hook; `DESKTOP_LIMITS.sessionReadyMs` by default. */
  readyMs?: number;
}): ControlChannel {
  const ackMs = opts.ackMs ?? DESKTOP_LIMITS.headedAckMs;
  const readyMs = opts.readyMs ?? DESKTOP_LIMITS.sessionReadyMs;
  const stopListeners: Array<(reason: string) => void> = [];
  const acks = new Map<number, () => void>();
  const readies = new Map<string, (outcome: ReadyOutcome) => void>();
  let seq = 0;
  let available = true;

  const stop = (reason: string) => {
    for (const listener of stopListeners) {
      try {
        listener(reason);
      } catch {
        // One listener failing must not keep the stop from the others.
      }
    }
  };

  const handle = (input: ControlInput) => {
    switch (input.control) {
      case "stop":
        stop(input.reason);
        return;
      case "headed-ack":
        acks.get(input.seq)?.();
        return;
      case "session-ready":
        readies.get(input.label)?.("ready");
        return;
      case "session-failed":
        readies.get(input.label)?.("failed");
        return;
    }
  };

  void (async () => {
    try {
      for await (const line of opts.lines) {
        const input = parseControlInput(line);
        if (input) handle(input);
      }
    } catch {
      // A broken stdin is the same as a closed one.
    }
    // The device app is gone: no banner, no stop key. Whatever session there is ends as stopped.
    available = false;
    for (const resolve of readies.values()) resolve("failed");
    stop("closed");
  })();

  const emit = (event: ControlEvent) => {
    opts.write(`${CONTROL_LINE_PREFIX}${JSON.stringify(event)}`);
  };

  return {
    get available() {
      return available;
    },
    emit,
    onStop(listener) {
      stopListeners.push(listener);
    },
    waitReady(label) {
      if (!available) return Promise.resolve("failed");
      return new Promise<ReadyOutcome>((resolve) => {
        const timer = setTimeout(() => settle("timeout"), readyMs);
        const settle = (outcome: ReadyOutcome) => {
          if (readies.get(label) !== settle) return;
          readies.delete(label);
          clearTimeout(timer);
          resolve(outcome);
        };
        // A second wait for the same label replaces the first, which fails.
        readies.get(label)?.("failed");
        readies.set(label, settle);
      });
    },
    async headed<T>(run: () => Promise<T>): Promise<T> {
      if (!available) throw refusal("no_control_channel");
      seq += 1;
      const mine = seq;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const acked = new Promise<boolean>((resolve) => {
        acks.set(mine, () => resolve(true));
        timer = setTimeout(() => resolve(false), ackMs);
      });
      emit({ event: "headed-begin", seq: mine });
      try {
        const ok = await acked;
        clearTimeout(timer);
        acks.delete(mine);
        if (!ok) throw refusal("headed_unconfirmed");
        return await run();
      } finally {
        emit({ event: "headed-end", seq: mine });
      }
    },
  };
}

/** No device app: nothing is said, no stop ever comes, and nothing physical runs. */
export const NO_CONTROL: ControlChannel = {
  available: false,
  emit() {},
  onStop() {},
  waitReady: async () => "failed",
  headed: async () => {
    throw refusal("no_control_channel");
  },
};
