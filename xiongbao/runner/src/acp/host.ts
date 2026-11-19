import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcpErrorCode,
  AcpHarness,
  AcpInventoryFrame,
  AcpModelWire,
  AcpOpenFrame,
  AcpOpenModel,
  AcpPermissionRequestFrame,
  AcpTurnEndFrame,
} from "../../../shared/acp";
import type { AppEntry } from "../apps";
import { IDLE_MS } from "../idle";
import {
  AcpAskModeLostError,
  type AcpClient,
  type AcpHandlers,
  type AcpPermissionAnswer,
  type AcpSpawnSpec,
  createAcpClient,
} from "./client";
import { acpProcessEnv } from "./login-path";
import {
  adapterLaunch,
  claudeModelLaunch,
  cloudAdapterLaunch,
  codexModelLaunch,
  type ModelLaunch,
  prepareAdapterDir,
  withProcessPath,
  writeCloudCodexHome,
  writeCodexHome,
} from "./manifest";
import { permissionFacts } from "./paths";

/**
 * The device side of the external employees' session channel (spec §3): the `acp.*` frames the
 * server sends down the runner socket are turned into ACP calls on the employee's adapter, and what
 * the adapter says comes back up as `acp.*` frames.
 *
 * ONE PROCESS PER EMPLOYEE, ONE SESSION PER THREAD. An employee's adapter is started on the first
 * `acp.open` (or the first turn after it went away) and closed after `idleMs` with no turn running,
 * as the MCP bridge closes its apps (`IDLE_MS`). Each XiongBao thread gets its own ACP session in
 * that process. Turns of one thread run one after another; turns of different threads, and of
 * different employees, run side by side. Everything about a thread is kept per `(agentId,
 * threadId)`: two employees in one group thread are two sessions in two processes, and neither ever
 * sees (or `session/load`s) the other's session. Every frame up names its employee.
 *
 * WHAT STARTS. Codex, Claude Code and Hermes are started only from `adapterLaunch` (manifest.ts),
 * which carries the mode that makes them ask before acting and starts them in the runner's own
 * `adapterDir`, the working folder going only to `session/new` / `session/load`; an owner's own
 * agent (`custom`) from the app the owner registered on this machine (`app_…`), with no session
 * mode, in the app's own folder (else the working folder). Both get the login shell's PATH. The working folder is a
 * root the owner shared (`fld_…`). Both references are looked up on every start, so a folder or app
 * removed a moment ago is refused, and nothing is spawned for a reference this machine does not
 * have. No path or command ever comes from the server, and none goes back up: errors are generic
 * Chinese sentences, and permission facts carry only folder-relative paths (paths.ts).
 *
 * THE HOST OUTLIVES CONNECTIONS. The runner `attach`es each connection's sender and `detach`es it
 * when the connection closes; adapters and turns keep running in between. A socket can look open
 * for minutes after a laptop slept or changed network, and what is sent on it then is lost, so a
 * sent frame is not taken as delivered: every frame of a turn not over yet is kept, sent or not,
 * and every `attach` replays all kept frames in the order they were made (the server drops repeats
 * by `(turnId, seq)`). Before the replay, every `attach` sends `acp.inventory`: this process's
 * random `instanceId`, every turn it remembers with its state, and the permission requests it waits
 * on, so the server can reconcile (a new `instanceId` means the runner restarted). Once a turn has
 * ended, all its kept frames (its end included) stay, and are replayed on every `attach`, until
 * there is proof they arrived; a frame of no turn (`acp.session`, an open's `acp.error`) is kept the
 * same way. A replay is not that proof (the socket it went on may already be dead). The heartbeat
 * is: the runner tells the host when a beat went up (`heartbeatSent`) and when the server acked one
 * (`acked`, one ack per beat, in order), and since the socket is ordered, the ack of a beat proves
 * that every frame sent (or replayed, which re-stamps it) on this connection before that beat
 * arrived; those of ended turns and of no turn are then dropped. As a backstop, past `endedLimit`
 * (100 ended turns or 50 MB) the oldest ended turns are dropped first. Past `bufferLimit` updates or bytes for one turn, that turn's
 * kept updates are compacted to the latest plan and each tool call's last state (its `tool_call`
 * and updates merged into one); after that, updates of other kinds still go up live but are not
 * kept, and only a plan or tool-call update compacts again. Acks, ends, sessions and errors are
 * never compacted away. A permission request still waiting for its answer is sent again after the
 * replay on every `attach`, with the same `requestId`; an answer naming an option the agent did not
 * offer is answered `cancelled` and reported as `acp.error` `bad_option`.
 *
 * SIZE. No frame goes up over `ACP_FRAME_LIMIT` (1 MB) serialized (`capFrame`): the long strings of
 * an update or a permission request's tool call are cut shorter and the frame says `truncated`; if
 * that is not enough, the payload becomes a stub of its ids. What is kept for replay is the cut frame.
 * (The adapter's stdout lines are capped too, at 64 MB, in the transport.)
 *
 * ASK MODE. A known agent's session that leaves its ask mode and cannot be switched back
 * (client.ts) ends its turn with `acp.error` `ask_mode_lost` and `stopReason: "error"`, and is
 * forgotten (its remembered id too), so the next turn makes a session again; whichever session
 * that is, it is switched to the ask mode before use like every other.
 *
 * TURNS. `acp.turn.ack` goes up as soon as a turn arrives; a `turnId` seen before is acknowledged
 * (and, when over, ended) again but never run twice. A turn ends with the agent's `stopReason`, with
 * `interrupted: true` when the adapter's process went away under it, or with `stopReason: "error"`
 * after an `acp.error` when it could not run. Cancelling a queued turn ends it at once; cancelling
 * the running one sends `session/cancel`, and the agent ends it; one that has not ended it after
 * `cancelGraceMs` (30 s) has its process stopped, which ends the turn `interrupted: true`.
 *
 * THE EMPLOYEE'S OWN MODEL. An `acp.open` for Codex or Claude Code may carry `model` (a short-lived
 * pass to the server's model proxy, never a key): the adapter is then started with the environment
 * that points the agent at the proxy (manifest.ts), Codex with a `CODEX_HOME` of its own in a
 * temporary folder that is deleted when its process goes away, never the owner's `~/.codex`. The
 * pass lives in the process's environment, so a process is kept only while it is still good: one that
 * has run to within `MODEL_REFRESH_MS` of its pass's expiry, and is idle, is replaced by the next open
 * that brings a new one. An open with no `model` (an older server, an employee with no model of its
 * own) starts the agent on the owner's own settings, as before.
 *
 * SESSIONS. Each employee's session id for a thread is remembered for the life of the runner. When a new process
 * starts for a thread and the agent can load sessions, the remembered id (else the server's
 * `sessionHint`) is loaded; otherwise a new session is made. `acp.session.loaded` says whether the
 * agent still has the earlier conversation.
 */

export const ACP_BUFFER_LIMIT = { count: 1000, bytes: 5 * 1024 * 1024 };
/** Ended turns kept until delivered: past these the oldest ended turns are dropped first. */
export const ACP_ENDED_LIMIT = { turns: 100, bytes: 50 * 1024 * 1024 };
/**
 * No frame goes up bigger than this, serialized. The socket's own limit (Bun's 16 MB) would close
 * the connection on a bigger one, and the frame would be replayed into the next connection forever.
 */
export const ACP_FRAME_LIMIT = 1024 * 1024;
/** How long an agent has to end a turn after `session/cancel` before its process is stopped. */
export const ACP_CANCEL_GRACE_MS = 30_000;

/** How many finished turns are remembered, so a resent `acp.prompt` is not run again. */
const REMEMBERED_TURNS = 1000;

type Frame = Record<string, unknown>;

export type AcpHost = {
  /** True when the frame was an `acp.*` frame (handled, or dropped as malformed). */
  handle(frame: Record<string, unknown>): Promise<boolean>;
  attach(send: (frame: Record<string, unknown>) => void): void;
  detach(): void;
  /** A heartbeat just went up the attached connection (sent before or after `attach`). */
  heartbeatSent(): void;
  /** The server acknowledged a heartbeat of this connection (acks come one per beat). */
  acked(): void;
  closeAll(): Promise<void>;
  /**
   * The prompt a remembered turn still holds (diagnostics, tests): its content until it ends, then
   * nothing (the person's words are not kept past their turn); undefined for a turn not remembered.
   */
  heldPrompt(turnId: string): unknown[] | undefined;
};

export type AcpHostDeps = {
  /** A shared folder's path on this machine, by its `fld_…` reference. */
  roots: (ref: string) => string | null;
  /** A registered app, by its `app_…` reference. */
  apps: (ref: string) => AppEntry | null;
  /**
   * The runner's own folder adapters are started in (`<data dir>/acp-adapters`), never a working
   * folder (manifest.ts, SUPPLY CHAIN).
   */
  adapterDir: string;
  /** This process's environment with the login shell's PATH (login-path.ts); tests inject one. */
  processEnv?: () => Promise<Record<string, string | undefined>>;
  spawn?: typeof createAcpClient;
  idleMs?: number;
  bufferLimit?: { count: number; bytes: number };
  /** Told each time a turn's kept updates are compacted (tests). */
  onCompact?: (turnId: string) => void;
  /** At most this many ended turns, and bytes of them, wait for proof of delivery. */
  endedLimit?: { turns: number; bytes: number };
  /** No frame goes up bigger than this many bytes, serialized (`ACP_FRAME_LIMIT`). */
  frameLimit?: number;
  /** `ACP_CANCEL_GRACE_MS`. */
  cancelGraceMs?: number;
  /** Where Codex's own temporary `CODEX_HOME` is made; the system's temporary folder unless set. */
  tempRoot?: string;
  /** The clock a pass's expiry is read against (tests). */
  now?: () => number;
  /**
   * Set where this host runs on an employee's own cloud computer rather than on an owner's machine
   * (manifest.ts, THE EMPLOYEE'S OWN COMPUTER): the adapters are the copies the image installed in
   * `binDir`, a cloud employee has no login of its own so an open WITHOUT a `model` cannot start (an
   * owner's settings are never read there), and the adapter gets `env` and nothing else from this
   * process's environment. Codex runs with no sandbox of its own (the container is the sandbox).
   * Absent: an owner's machine, exactly as before.
   */
  cloud?: {
    binDir: string;
    /** The environment an adapter runs with (an allow list); read on every start. */
    env: () => Record<string, string>;
    /** The environment a child would inherit from, which is then unset; this process's own by default. */
    parentEnv?: Record<string, string | undefined>;
  };
};

/** An idle process whose pass has less than this left is replaced by the next open with a new one. */
export const MODEL_REFRESH_MS = 60 * 60 * 1000;

const HARNESSES: readonly AcpHarness[] = [
  "codex",
  "claude-code",
  "hermes",
  "custom",
];

const MESSAGES: Record<AcpErrorCode, string> = {
  bad_frame: "设备收到的指令格式不对。",
  unknown_workdir: "这台电脑上找不到这个工作文件夹，请在桌面端重新共享。",
  unknown_app: "这台电脑上找不到这个智能体，或它已被停用。",
  not_open: "这个对话还没有在这台电脑上打开。",
  start_failed: "智能体没能在这台电脑上启动，请确认它已安装并登录。",
  turn_failed: "智能体这一轮出错了。",
  bad_option: "这个回答不是智能体给出的选项之一，已按取消处理。",
  ask_mode_lost:
    "智能体离开了“先问再做”的模式且无法切回，这一轮已停止；下一轮会开新会话。",
};

class HostError extends Error {
  constructor(readonly code: AcpErrorCode) {
    super(MESSAGES[code]);
  }
}

type Turn = {
  agentId: string;
  threadId: string;
  turnId: string;
  content: unknown[];
  state: "queued" | "running" | "ended";
  cancelled: boolean;
  seq: number;
  end?: AcpTurnEndFrame;
  /** After a `session/cancel`: stops the adapter if the turn has not ended by then. */
  backstop?: ReturnType<typeof setTimeout>;
};

type Proc = {
  agentId: string;
  /** What was started: a different harness, folder, app or model means a different process. */
  key: string;
  /** The pass the process was started with, and when it stops working (its environment is fixed). */
  modelToken?: string;
  modelExpiresAt?: number;
  /** Removes what was made for the process alone (Codex's temporary home). */
  cleanup?: () => void;
  workdir: string;
  client: AcpClient | null;
  ready: Promise<{ loadSession: boolean }>;
  /** Opens and turns using it now; idle when zero. */
  busy: number;
  idle?: ReturnType<typeof setTimeout>;
  sessions: Map<string, Thread>;
};

type Thread = {
  agentId: string;
  threadId: string;
  open: AcpOpenFrame;
  /** The process the live session is in, and the session; null when there is none. */
  proc: Proc | null;
  sessionId: string | null;
  current: Turn | null;
  /** Everything for this thread runs on this chain, one after another. */
  tail: Promise<void>;
};

/**
 * A frame kept for replay, replayed on every attach. `turn`: a frame of a turn not over yet, kept
 * (sent or not) until the turn ends. `once`: a frame of a turn that has ended (its end included), or
 * of no turn; kept until a heartbeat's ack proves it arrived (or the ended-turn cap drops it).
 */
type Entry = {
  frame: Frame;
  turnId: string | null;
  kind: "turn" | "once";
  bytes: number;
  /** The attach (connection) it last went up on, and its place in the send order; 0 when never. */
  sentOn: number;
  sentSeq: number;
};

/** A turn's kept updates, and whether they were compacted already. */
type Held = { count: number; bytes: number; compacted: boolean };

type Pending = {
  frame: AcpPermissionRequestFrame;
  settle: (answer: AcpPermissionAnswer) => void;
};

function isRecord(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const WIRE_OF: Partial<Record<AcpHarness, AcpModelWire>> = {
  codex: "responses",
  "claude-code": "messages",
};

/**
 * The model block of an open, when it is well formed and for a harness that takes one (and in the
 * format that harness speaks); anything else is ignored, which starts the agent on the owner's own
 * settings.
 */
function modelOf(harness: AcpHarness, value: unknown): AcpOpenModel | null {
  if (!isRecord(value)) return null;
  const baseUrl = str(value.baseUrl);
  const token = str(value.token);
  const model = str(value.model);
  if (!baseUrl || !token || !model) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  if (value.wire !== WIRE_OF[harness]) return null;
  const expiresAt =
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? value.expiresAt
      : undefined;
  return {
    baseUrl,
    token,
    model,
    wire: value.wire as AcpModelWire,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** What makes two opens' models the same process: everything but the pass itself. */
const modelKeyOf = (model: AcpOpenModel | undefined) =>
  model ? [model.baseUrl, model.model, model.wire] : null;

/** Host state is per employee and thread: two employees can share one group thread. */
const threadKey = (agentId: string, threadId: string): string =>
  JSON.stringify([agentId, threadId]);

function sizeOf(frame: Frame): number {
  return Buffer.byteLength(JSON.stringify(frame));
}

/** Longest string kept, tried in turn, when a frame's payload must be cut down to the limit. */
const CUTS = [65_536, 8_192, 1_024, 128];

/**
 * `value` with every string longer than `max` cut to `max` and marked with an ellipsis. A cut never
 * lands inside a surrogate pair: half an emoji is a lone surrogate, which Postgres' jsonb refuses.
 */
function cutStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    if (value.length <= max) return value;
    const last = value.charCodeAt(max - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
    return `${value.slice(0, end)}…`;
  }
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, max));
  if (isRecord(value)) {
    const out: Frame = {};
    for (const [key, item] of Object.entries(value))
      out[key] = cutStrings(item, max);
    return out;
  }
  return value;
}

/** The short identifying fields of `value`, kept by a stub. */
function pickIds(value: unknown, keys: readonly string[]): Frame {
  const out: Frame = {};
  if (!isRecord(value)) return out;
  for (const key of keys) {
    const item = value[key];
    if (
      typeof item === "number" ||
      typeof item === "boolean" ||
      (typeof item === "string" && item.length <= 256)
    )
      out[key] = item;
  }
  return out;
}

/** The field of an up frame that carries what the agent sent, which is what can be big. */
const PAYLOAD: Record<string, { field: string; ids: readonly string[] }> = {
  "acp.update": { field: "update", ids: ["sessionUpdate", "toolCallId"] },
  "acp.permission.request": { field: "toolCall", ids: ["toolCallId", "kind"] },
};

const FRAME_IDS = [
  "type",
  "agentId",
  "threadId",
  "turnId",
  "seq",
  "requestId",
  "sessionId",
  "loaded",
  "stopReason",
  "interrupted",
  "code",
  "instanceId",
] as const;

/**
 * `frame` itself when it fits in `limit` bytes serialized. Otherwise, with `truncated: true`: the
 * strings of its payload (`update`, `toolCall`: diff texts, content text, `rawInput` …) cut shorter
 * until it fits; else the payload replaced by a stub of its ids; else (whatever else made it big)
 * only the frame's ids, with empty values where the frame's shape needs one.
 */
export function capFrame(frame: Frame, limit = ACP_FRAME_LIMIT): Frame {
  if (sizeOf(frame) <= limit) return frame;
  const payload = PAYLOAD[frame.type as string];
  if (payload) {
    for (const max of CUTS) {
      const cut = {
        ...frame,
        [payload.field]: cutStrings(frame[payload.field], max),
        truncated: true,
      };
      if (sizeOf(cut) <= limit) return cut;
    }
    const stub = {
      ...frame,
      [payload.field]: {
        ...pickIds(frame[payload.field], payload.ids),
        truncated: true,
      },
      truncated: true,
    };
    if (sizeOf(stub) <= limit) return stub;
  }
  const bare: Frame = { ...pickIds(frame, FRAME_IDS), truncated: true };
  if (payload) bare[payload.field] = { truncated: true };
  if (frame.type === "acp.permission.request") {
    bare.options = [];
    bare.facts = { insideWorkdir: null, paths: [] };
  }
  if (frame.type === "acp.inventory") {
    bare.turns = [];
    bare.requestIds = [];
  }
  if (frame.type === "acp.error") bare.message = MESSAGES.turn_failed;
  return bare;
}

/**
 * `acp.inventory` within `limit`: as it is when it fits. Otherwise the oldest ended turns go first,
 * as many as it takes, and it says `truncated: true` (the server then interrupts nothing because a
 * turn is missing from it). When even its unfinished turns and waiting requests do not fit, it is
 * `capFrame`'s: empty lists, `truncated: true`.
 */
export function fitInventory(
  inventory: AcpInventoryFrame,
  limit = ACP_FRAME_LIMIT,
): Frame {
  if (sizeOf(inventory) <= limit) return inventory;
  const marked = { ...inventory, truncated: true };
  // Listed in the order this process first saw them: the oldest first.
  const ended = inventory.turns.filter((turn) => turn.state === "ended");
  let over = sizeOf(marked) - limit;
  let drop = 0;
  while (over > 0 && drop < ended.length) {
    over -= Buffer.byteLength(JSON.stringify(ended[drop])) + 1;
    drop += 1;
  }
  for (; drop <= ended.length; drop += 1) {
    const gone = new Set(ended.slice(0, drop));
    const cut = {
      ...marked,
      turns: inventory.turns.filter((turn) => !gone.has(turn)),
    };
    if (sizeOf(cut) <= limit) return cut;
  }
  return capFrame(marked, limit);
}

export function createAcpHost(deps: AcpHostDeps): AcpHost {
  const spawn = deps.spawn ?? createAcpClient;
  const processEnv = deps.processEnv ?? acpProcessEnv;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const limit = deps.bufferLimit ?? ACP_BUFFER_LIMIT;
  const endedLimit = deps.endedLimit ?? ACP_ENDED_LIMIT;
  const frameLimit = deps.frameLimit ?? ACP_FRAME_LIMIT;
  const cancelGraceMs = deps.cancelGraceMs ?? ACP_CANCEL_GRACE_MS;
  /** Random per runner process: a new one tells the server every earlier turn is gone. */
  const instanceId = randomUUID();

  /** Where an owner's own agent starts when its app names no folder: the adapters' own. */
  function adapterHome(): string {
    prepareAdapterDir(deps.adapterDir);
    return deps.adapterDir;
  }

  const procs = new Map<string, Proc>();
  const threads = new Map<string, Thread>();
  const turns = new Map<string, Turn>();
  /** Each (employee, thread)'s latest session id, kept after its process has gone. */
  const known = new Map<string, string>();
  const pending = new Map<string, Pending>();
  let outbox: Entry[] = [];
  const held = new Map<string, Held>();
  let send: ((frame: Frame) => void) | null = null;
  let closed = false;
  /** Which attach this is, and how many frames have gone up so far (the send order). */
  let connection = 0;
  let sendSeq = 0;
  /** `sendSeq` when each heartbeat of this connection went up, oldest first, until its ack. */
  let beats: number[] = [];
  /** When each turn still kept as ended ended, for dropping the oldest first. */
  const endedAt = new Map<string, number>();
  let ends = 0;

  // --- up the socket ---

  function trySend(frame: Frame): boolean {
    if (!send) return false;
    try {
      send(frame);
      return true;
    } catch {
      // The connection is gone; what follows waits, in order, for the next one.
      send = null;
      return false;
    }
  }

  /** A turn whose end has been emitted (one forgotten long ago is over too). */
  function over(turnId: string): boolean {
    const state = turns.get(turnId)?.state;
    return state === undefined || state === "ended";
  }

  /**
   * Kept, so the next attach replays it whether or not this send got through. A turn's end turns
   * all its kept frames into `once`: replayed whole on every attach until a beat's ack lets it go.
   */
  function emit(made: Frame, turnId: string | null = null) {
    const frame = capFrame(made, frameLimit);
    const isEnd = frame.type === "acp.turn.end";
    // A late frame of a turn that is over is not sent and not kept: nothing would clear it.
    if (turnId !== null && !isEnd && over(turnId)) return;
    const entry: Entry = {
      frame,
      turnId,
      kind: turnId === null || isEnd ? "once" : "turn",
      bytes: sizeOf(frame),
      sentOn: 0,
      sentSeq: 0,
    };
    // Sent first, so the stamp is on whatever entry ends up kept (a compaction copies it).
    if (trySend(frame)) stamp(entry);
    if (
      entry.kind === "turn" &&
      frame.type === "acp.update" &&
      turnId !== null
    ) {
      // Past the limit, a chunk of text is not kept (it went up above if it could).
      hold(entry, turnId);
    } else outbox.push(entry);
    if (isEnd && turnId !== null) {
      for (const kept of outbox) if (kept.turnId === turnId) kept.kind = "once";
      held.delete(turnId);
      endedAt.set(turnId, ++ends);
      capEnded();
    }
  }

  function stamp(entry: Entry) {
    entry.sentOn = connection;
    entry.sentSeq = ++sendSeq;
  }

  /** Drops kept frames for which `gone` is true, and forgets ended turns with nothing left. */
  function drop(gone: (entry: Entry) => boolean) {
    outbox = outbox.filter((entry) => !gone(entry));
    if (endedAt.size === 0) return;
    const left = new Set(outbox.map((entry) => entry.turnId));
    for (const turnId of endedAt.keys())
      if (!left.has(turnId)) endedAt.delete(turnId);
  }

  /** The backstop on a connection that never ends: the oldest ended turns go first. */
  function capEnded() {
    const bytes = new Map<string, number>();
    let total = 0;
    for (const entry of outbox) {
      if (entry.kind !== "once" || entry.turnId === null) continue;
      if (!endedAt.has(entry.turnId)) continue;
      bytes.set(entry.turnId, (bytes.get(entry.turnId) ?? 0) + entry.bytes);
      total += entry.bytes;
    }
    if (bytes.size <= endedLimit.turns && total <= endedLimit.bytes) return;
    const oldest = [...bytes.keys()].sort(
      (a, b) => (endedAt.get(a) ?? 0) - (endedAt.get(b) ?? 0),
    );
    const evicted = new Set<string>();
    let turnsLeft = bytes.size;
    for (const turnId of oldest) {
      if (turnsLeft <= endedLimit.turns && total <= endedLimit.bytes) break;
      evicted.add(turnId);
      turnsLeft -= 1;
      total -= bytes.get(turnId) ?? 0;
    }
    drop(
      (entry) =>
        entry.kind === "once" &&
        entry.turnId !== null &&
        evicted.has(entry.turnId),
    );
  }

  /** Sent now if possible, never kept (a repeated acknowledgement). */
  function sendLive(frame: Frame) {
    trySend(capFrame(frame, frameLimit));
  }

  /** An update kept for its turn, compacted past the limit; false when it is not kept at all. */
  function hold(entry: Entry, turnId: string): boolean {
    const stats = held.get(turnId) ?? { count: 0, bytes: 0, compacted: false };
    held.set(turnId, stats);
    if (stats.compacted && !keptKind(entry.frame.update)) return false;
    outbox.push(entry);
    stats.count += 1;
    stats.bytes += entry.bytes;
    if (stats.count > limit.count || stats.bytes > limit.bytes) compact(turnId);
    return true;
  }

  /** Plans and tool-call states survive compaction; everything else of a turn does not. */
  function keptKind(update: unknown): boolean {
    if (!isRecord(update)) return false;
    const kind = update.sessionUpdate;
    return (
      kind === "plan" ||
      ((kind === "tool_call" || kind === "tool_call_update") &&
        typeof update.toolCallId === "string")
    );
  }

  /** The turn's kept updates cut to the latest plan and each tool call's last state. */
  function compact(turnId: string) {
    deps.onCompact?.(turnId);
    const isMine = (entry: Entry) =>
      entry.turnId === turnId &&
      entry.kind === "turn" &&
      entry.frame.type === "acp.update";
    let plan: Entry | undefined;
    const calls = new Map<
      string,
      { last: Entry; merged: Frame; created: boolean }
    >();
    for (const entry of outbox) {
      if (!isMine(entry)) continue;
      const update = entry.frame.update;
      if (!keptKind(update) || !isRecord(update)) continue;
      if (update.sessionUpdate === "plan") {
        plan = entry;
        continue;
      }
      const id = update.toolCallId as string;
      const before = calls.get(id);
      const created =
        (before?.created ?? false) || update.sessionUpdate === "tool_call";
      calls.set(id, {
        last: entry,
        created,
        merged: {
          ...before?.merged,
          ...update,
          sessionUpdate: created ? "tool_call" : "tool_call_update",
        },
      });
    }
    const kept = new Map<Entry, Entry>();
    if (plan) kept.set(plan, plan);
    for (const { last, merged } of calls.values()) {
      // Merged fields of several updates can add up past the limit.
      const frame = capFrame({ ...last.frame, update: merged }, frameLimit);
      kept.set(last, { ...last, frame, bytes: sizeOf(frame) });
    }
    const stats = { count: 0, bytes: 0, compacted: true };
    outbox = outbox.flatMap((entry) => {
      if (!isMine(entry)) return [entry];
      const replacement = kept.get(entry);
      if (!replacement) return [];
      stats.count += 1;
      stats.bytes += replacement.bytes;
      return [replacement];
    });
    held.set(turnId, stats);
  }

  function emitError(
    agentId: string,
    threadId: string,
    code: AcpErrorCode,
    turnId?: string,
  ) {
    emit(
      {
        type: "acp.error",
        agentId,
        threadId,
        ...(turnId === undefined ? {} : { turnId }),
        code,
        message: MESSAGES[code],
      },
      turnId ?? null,
    );
  }

  // --- turns ---

  function remember(turn: Turn) {
    turns.set(turn.turnId, turn);
    if (turns.size <= REMEMBERED_TURNS) return;
    for (const [turnId, old] of turns) {
      if (turns.size <= REMEMBERED_TURNS) break;
      if (old.state === "ended") turns.delete(turnId);
    }
  }

  function endTurn(turn: Turn, stopReason: string, interrupted: boolean) {
    if (turn.state === "ended") return;
    turn.state = "ended";
    // A replay needs only the turn's frames and its end: the person's words go with the turn.
    turn.content = [];
    if (turn.backstop) clearTimeout(turn.backstop);
    turn.end = {
      type: "acp.turn.end",
      agentId: turn.agentId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      stopReason,
      interrupted,
    };
    emit(turn.end, turn.turnId);
  }

  function failTurn(turn: Turn, code: AcpErrorCode) {
    emitError(turn.agentId, turn.threadId, code, turn.turnId);
    endTurn(turn, "error", false);
  }

  function enqueue(thread: Thread, job: () => Promise<void>) {
    thread.tail = thread.tail.then(() => job().catch(() => {}));
  }

  // --- processes and sessions ---

  /** The folder and, for `custom`, the app an open names; a HostError when either is unknown. */
  function target(open: AcpOpenFrame): {
    workdir: string;
    app: AppEntry | null;
  } {
    const workdir = deps.roots(open.workdirRef);
    if (!workdir) throw new HostError("unknown_workdir");
    if (open.harness !== "custom") return { workdir, app: null };
    const app = open.appRef ? deps.apps(open.appRef) : null;
    if (app?.kind !== "stdio" || !app.enabled)
      throw new HostError("unknown_app");
    return { workdir, app };
  }

  function arm(proc: Proc) {
    if (proc.idle) clearTimeout(proc.idle);
    proc.idle = setTimeout(() => {
      if (proc.busy === 0) retire(proc);
    }, idleMs);
    proc.idle.unref?.();
  }

  function retire(proc: Proc): Promise<void> {
    if (proc.idle) clearTimeout(proc.idle);
    if (procs.get(proc.agentId) === proc) procs.delete(proc.agentId);
    for (const thread of proc.sessions.values()) {
      if (thread.proc === proc) {
        thread.proc = null;
        thread.sessionId = null;
      }
    }
    proc.sessions.clear();
    const stop = () => proc.client?.close() ?? Promise.resolve();
    // What was made for the process alone goes once it is stopped (or failed to start).
    const clean = () => {
      try {
        proc.cleanup?.();
      } catch {
        // A folder that cannot be removed now is only a leftover in the temporary folder.
      }
      proc.cleanup = undefined;
    };
    // A process still being looked up is stopped as soon as it exists.
    return (proc.client ? stop() : proc.ready.then(stop, stop)).then(
      clean,
      clean,
    );
  }

  function handlersFor(proc: Proc): AcpHandlers {
    return {
      onUpdate(sessionId, update) {
        const thread = proc.sessions.get(sessionId);
        const turn = thread?.current;
        if (!thread || !turn || turn.state === "ended") return;
        turn.seq += 1;
        emit(
          {
            type: "acp.update",
            agentId: turn.agentId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            seq: turn.seq,
            update,
          },
          turn.turnId,
        );
      },
      onPermission(sessionId, request) {
        const turn = proc.sessions.get(sessionId)?.current;
        if (!turn || turn.state === "ended" || request.signal.aborted)
          return Promise.resolve({ outcome: "cancelled" });
        const requestId = `perm_${randomUUID()}`;
        const frame = capFrame(
          {
            type: "acp.permission.request",
            agentId: turn.agentId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            requestId,
            toolCall: request.toolCall,
            options: request.options,
            facts: permissionFacts(proc.workdir, request.toolCall),
          } satisfies AcpPermissionRequestFrame,
          frameLimit,
        ) as AcpPermissionRequestFrame;
        return new Promise((resolve) => {
          const settle = (answer: AcpPermissionAnswer) => {
            if (!pending.delete(requestId)) return;
            resolve(answer);
          };
          pending.set(requestId, { frame, settle });
          // Withdrawn by a cancel or the process ending: not asked again on the next connection.
          request.signal.addEventListener(
            "abort",
            () => settle({ outcome: "cancelled" }),
            { once: true },
          );
          // Not in the outbox: every attach sends what is still pending, after the replay.
          trySend(frame);
        });
      },
    };
  }

  function start(
    open: AcpOpenFrame,
    key: string,
    workdir: string,
    app: AppEntry | null,
  ): Proc {
    const proc: Proc = {
      agentId: open.agentId,
      key,
      workdir,
      client: null,
      ready: Promise.resolve({ loadSession: false }),
      busy: 0,
      sessions: new Map(),
    };
    const harness = open.harness;
    const { model } = open;
    if (model) {
      proc.modelToken = model.token;
      if (model.expiresAt !== undefined) proc.modelExpiresAt = model.expiresAt;
    }
    proc.ready = (async () => {
      // Made inside the process's own start, so a process that is retired meanwhile still removes it.
      let launch: ModelLaunch | undefined;
      if (model && harness === "codex") {
        const home = mkdtempSync(
          join(deps.tempRoot ?? tmpdir(), "xiongbao-codex-"),
        );
        proc.cleanup = () => rmSync(home, { recursive: true, force: true });
        if (deps.cloud) writeCloudCodexHome(home, model);
        else writeCodexHome(home, model);
        launch = codexModelLaunch(model, home);
      } else if (model && harness === "claude-code") {
        launch = claudeModelLaunch(model);
      }
      if (deps.cloud) {
        // A cloud computer starts only the two agents it carries, and only on the employee's model.
        if (!launch || (harness !== "codex" && harness !== "claude-code"))
          throw new HostError("start_failed");
        const cloud = deps.cloud;
        prepareAdapterDir(deps.adapterDir);
        const spec = cloudAdapterLaunch(
          harness,
          { adapterDir: deps.adapterDir },
          {
            binDir: cloud.binDir,
            env: cloud.env(),
            model: launch,
            ...(cloud.parentEnv ? { parentEnv: cloud.parentEnv } : {}),
          },
        );
        if (closed) throw new HostError("start_failed");
        proc.client = spawn(spec, handlersFor(proc));
        return proc.client.initialize();
      }
      const spec: AcpSpawnSpec =
        harness === "custom" && app?.kind === "stdio"
          ? {
              command: app.command,
              args: app.args,
              // Found on the owner's login PATH like the known agents, unless the app sets PATH.
              env: withProcessPath(app.env, await processEnv()),
              // Like the known agents, never in the working folder unless the owner chose it:
              // that reaches the agent only as the session's `cwd`.
              cwd: app.cwd ?? adapterHome(),
              sessionMode: null,
            }
          : await adapterLaunch(
              harness as Exclude<AcpHarness, "custom">,
              { adapterDir: deps.adapterDir, workdir },
              { processEnv, ...(launch ? { model: launch } : {}) },
            );
      if (closed) throw new HostError("start_failed");
      proc.client = spawn(spec, handlersFor(proc));
      return proc.client.initialize();
    })();
    proc.ready.catch((error) => {
      console.log(
        `runner: an external agent could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      void retire(proc);
    });
    procs.set(open.agentId, proc);
    return proc;
  }

  /** The employee's running process, started when needed, and counted busy until `release`. */
  async function acquire(thread: Thread): Promise<Proc> {
    if (closed) throw new HostError("start_failed");
    const { workdir, app } = target(thread.open);
    const key = JSON.stringify([
      thread.open.harness,
      workdir,
      app?.kind === "stdio" ? [app.command, app.args, app.env, app.cwd] : null,
      modelKeyOf(thread.open.model),
    ]);
    let proc = procs.get(thread.open.agentId);
    // The pass is in the process's environment and cannot be renewed there: an idle process whose pass
    // is nearly spent is replaced when the open brings a new one.
    const model = thread.open.model;
    const spent =
      proc !== undefined &&
      proc.busy === 0 &&
      model !== undefined &&
      proc.modelToken !== model.token &&
      proc.modelExpiresAt !== undefined &&
      (deps.now ?? Date.now)() > proc.modelExpiresAt - MODEL_REFRESH_MS;
    if (
      proc &&
      (proc.key !== key || spent || (proc.client && !proc.client.alive))
    ) {
      void retire(proc);
      proc = undefined;
    }
    proc ??= start(thread.open, key, workdir, app);
    proc.busy += 1;
    if (proc.idle) clearTimeout(proc.idle);
    try {
      await proc.ready;
    } catch {
      release(proc);
      throw new HostError("start_failed");
    }
    return proc;
  }

  function release(proc: Proc) {
    proc.busy -= 1;
    if (proc.busy === 0 && procs.get(proc.agentId) === proc) arm(proc);
  }

  /**
   * The thread's live session, made or loaded when there is none; `announce` reports a live one
   * again (a repeated `acp.open`). The caller releases the process.
   */
  async function session(
    thread: Thread,
    announce: boolean,
  ): Promise<{ proc: Proc; client: AcpClient; sessionId: string }> {
    const proc = await acquire(thread);
    try {
      const client = proc.client as AcpClient;
      if (thread.proc === proc && thread.sessionId) {
        if (announce) {
          emit({
            type: "acp.session",
            agentId: thread.agentId,
            threadId: thread.threadId,
            sessionId: thread.sessionId,
            loaded: true,
          });
        }
        return { proc, client, sessionId: thread.sessionId };
      }
      if (thread.proc && thread.sessionId)
        thread.proc.sessions.delete(thread.sessionId);
      const { loadSession } = await proc.ready;
      const key = threadKey(thread.agentId, thread.threadId);
      const earlier = known.get(key) ?? thread.open.sessionHint;
      let sessionId = "";
      let loaded = false;
      if (earlier && loadSession) {
        try {
          loaded = await client.loadSession(earlier, proc.workdir);
        } catch {
          loaded = false;
        }
        if (loaded) sessionId = earlier;
      }
      if (!loaded) sessionId = await client.newSession(proc.workdir);
      if (procs.get(proc.agentId) !== proc || !client.alive)
        throw new HostError("start_failed");
      thread.proc = proc;
      thread.sessionId = sessionId;
      proc.sessions.set(sessionId, thread);
      known.set(key, sessionId);
      emit({
        type: "acp.session",
        agentId: thread.agentId,
        threadId: thread.threadId,
        sessionId,
        loaded,
      });
      return { proc, client, sessionId };
    } catch (error) {
      release(proc);
      throw error instanceof HostError ? error : new HostError("start_failed");
    }
  }

  /**
   * The thread's session, gone for good: neither reused nor loaded again, not even as the open's
   * `sessionHint` (the session the server last heard of, which this one superseded or was).
   */
  function forgetSession(thread: Thread, proc: Proc, sessionId: string) {
    proc.sessions.delete(sessionId);
    if (thread.sessionId === sessionId) {
      thread.proc = null;
      thread.sessionId = null;
    }
    const key = threadKey(thread.agentId, thread.threadId);
    if (known.get(key) === sessionId) known.delete(key);
    if (thread.open.sessionHint !== undefined) {
      const { sessionHint: _forgotten, ...open } = thread.open;
      thread.open = open;
    }
  }

  async function runTurn(thread: Thread, turn: Turn) {
    if (turn.state === "ended") return;
    turn.state = "running";
    let opened: Awaited<ReturnType<typeof session>>;
    try {
      opened = await session(thread, false);
    } catch (error) {
      if (turn.cancelled) endTurn(turn, "cancelled", false);
      else
        failTurn(
          turn,
          error instanceof HostError ? error.code : "start_failed",
        );
      return;
    }
    const { proc, client, sessionId } = opened;
    try {
      if (turn.cancelled) {
        endTurn(turn, "cancelled", false);
        return;
      }
      thread.current = turn;
      const { stopReason } = await client.prompt(sessionId, turn.content);
      endTurn(turn, stopReason, false);
    } catch (error) {
      if (error instanceof AcpAskModeLostError) {
        // Never used again: the next turn makes a new session (in the ask mode).
        forgetSession(thread, proc, sessionId);
        failTurn(turn, "ask_mode_lost");
      } else if (!client.alive) endTurn(turn, "interrupted", true);
      else failTurn(turn, "turn_failed");
    } finally {
      if (thread.current === turn) thread.current = null;
      release(proc);
    }
  }

  /** `acp.inventory`: this process, every turn it remembers, and the requests it waits on. */
  function inventory(): AcpInventoryFrame {
    const awaiting = new Set(
      [...pending.values()].map(({ frame }) => frame.turnId),
    );
    return {
      type: "acp.inventory",
      instanceId,
      turns: [...turns.values()].map((turn) => ({
        agentId: turn.agentId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        state:
          turn.state === "ended"
            ? "ended"
            : awaiting.has(turn.turnId)
              ? "awaiting"
              : "running",
      })),
      requestIds: [...pending.keys()],
    };
  }

  // --- frames from the server ---

  function onOpen(frame: Frame) {
    const threadId = str(frame.threadId);
    const agentId = str(frame.agentId);
    // Nobody to answer: an error must name the employee and the thread.
    if (!threadId || !agentId) return;
    const workdirRef = str(frame.workdirRef);
    const harness = HARNESSES.find((known) => known === frame.harness);
    if (!workdirRef || !harness) {
      emitError(agentId, threadId, "bad_frame");
      return;
    }
    const appRef = str(frame.appRef);
    const sessionHint = str(frame.sessionHint);
    const model = modelOf(harness, frame.model);
    const open: AcpOpenFrame = {
      type: "acp.open",
      agentId,
      threadId,
      harness,
      workdirRef,
      ...(appRef ? { appRef } : {}),
      ...(sessionHint ? { sessionHint } : {}),
      ...(model ? { model } : {}),
    };
    try {
      target(open);
    } catch (error) {
      // A thread already open keeps its session and its turns; only this open is refused.
      emitError(agentId, threadId, (error as HostError).code);
      return;
    }
    const key = threadKey(agentId, threadId);
    let thread = threads.get(key);
    if (thread) thread.open = open;
    else {
      thread = {
        agentId,
        threadId,
        open,
        proc: null,
        sessionId: null,
        current: null,
        tail: Promise.resolve(),
      };
      threads.set(key, thread);
    }
    const opening = thread;
    enqueue(opening, async () => {
      try {
        const { proc } = await session(opening, true);
        release(proc);
      } catch (error) {
        emitError(
          agentId,
          threadId,
          error instanceof HostError ? error.code : "start_failed",
        );
      }
    });
  }

  function ackOf(turn: Turn): Frame {
    return {
      type: "acp.turn.ack",
      agentId: turn.agentId,
      threadId: turn.threadId,
      turnId: turn.turnId,
    };
  }

  function onPrompt(frame: Frame) {
    const agentId = str(frame.agentId);
    const threadId = str(frame.threadId);
    const turnId = str(frame.turnId);
    if (!agentId || !threadId || !turnId) return;
    // A turnId is the server's and unique: seen once in this process, never run again.
    const seen = turns.get(turnId);
    if (seen) {
      sendLive(ackOf(seen));
      if (!seen.end) return;
      // An end still in the outbox goes up again on the next attach anyway.
      if (outbox.some((entry) => entry.frame === seen.end)) sendLive(seen.end);
      else emit(seen.end, turnId);
      return;
    }
    const turn: Turn = {
      agentId,
      threadId,
      turnId,
      content: Array.isArray(frame.content) ? frame.content : [],
      state: "queued",
      cancelled: false,
      seq: 0,
    };
    remember(turn);
    emit(ackOf(turn), turnId);
    const thread = threads.get(threadKey(agentId, threadId));
    if (!Array.isArray(frame.content)) failTurn(turn, "bad_frame");
    else if (!thread) failTurn(turn, "not_open");
    else enqueue(thread, () => runTurn(thread, turn));
  }

  function onCancel(frame: Frame) {
    const turn = turns.get(str(frame.turnId) ?? "");
    if (
      !turn ||
      turn.state === "ended" ||
      turn.agentId !== frame.agentId ||
      turn.threadId !== frame.threadId
    )
      return;
    turn.cancelled = true;
    if (turn.state === "queued") {
      endTurn(turn, "cancelled", false);
      return;
    }
    const thread = threads.get(threadKey(turn.agentId, turn.threadId));
    const proc = thread?.proc;
    if (thread?.current !== turn || !proc?.client || !thread.sessionId) return;
    proc.client.cancel(thread.sessionId);
    // An agent that ignores the cancel would hold the thread for ever: its process is stopped,
    // which ends the turn `interrupted` (and any other turn running in that process with it).
    if (turn.backstop) return;
    turn.backstop = setTimeout(() => {
      if (turn.state !== "ended") void retire(proc);
    }, cancelGraceMs);
    turn.backstop.unref?.();
  }

  function onAnswer(frame: Frame) {
    const waitingFor = pending.get(str(frame.requestId) ?? "");
    if (!waitingFor || waitingFor.frame.agentId !== frame.agentId) return;
    const optionId = str(frame.optionId);
    if (optionId === null) {
      waitingFor.settle({ outcome: "cancelled" });
      return;
    }
    const { agentId, threadId, turnId, options } = waitingFor.frame;
    if (!options.some((option) => option.optionId === optionId)) {
      waitingFor.settle({ outcome: "cancelled" });
      emitError(agentId, threadId, "bad_option", turnId);
      return;
    }
    waitingFor.settle({ outcome: "selected", optionId });
  }

  return {
    async handle(frame) {
      const type = frame.type;
      if (typeof type !== "string" || !type.startsWith("acp.")) return false;
      if (type === "acp.open") onOpen(frame);
      else if (type === "acp.prompt") onPrompt(frame);
      else if (type === "acp.cancel") onCancel(frame);
      else if (type === "acp.permission.answer") onAnswer(frame);
      return true;
    },

    attach(sender) {
      send = sender;
      connection += 1;
      // First what this process is and has, so the server can reconcile before the replay.
      if (!trySend(fitInventory(inventory(), frameLimit))) return;
      // Everything kept, in the order it was made: the server drops what it already has by seq.
      // Nothing is let go for having been replayed: only a beat's ack (or the cap) does that.
      for (const entry of outbox) {
        if (!trySend(entry.frame)) return;
        stamp(entry);
      }
      for (const { frame } of pending.values()) {
        if (!trySend(frame)) return;
      }
    },

    detach() {
      send = null;
      // Acks of a connection that is gone never come.
      beats = [];
    },

    heartbeatSent() {
      beats.push(sendSeq);
    },

    acked() {
      // The socket is ordered: the ack of a beat proves everything sent before the beat arrived.
      const mark = beats.shift();
      if (mark === undefined) return;
      drop(
        (entry) =>
          entry.kind === "once" &&
          entry.sentOn === connection &&
          entry.sentSeq > 0 &&
          entry.sentSeq <= mark,
      );
    },

    async closeAll() {
      closed = true;
      await Promise.allSettled([...procs.values()].map(retire));
    },

    heldPrompt(turnId) {
      return turns.get(turnId)?.content;
    },
  };
}
