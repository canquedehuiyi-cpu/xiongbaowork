/**
 * External agents (Codex, Claude Code, Hermes, or the owner's own) hired as XiongBao employees and
 * run on the owner's computer through the Agent Client Protocol. Shared by the runner and the
 * server; the `acp.*` frames between them are added beside these types.
 */

/** Which agent an external employee is. `custom` is the owner's own registered app (`app_…`). */
export type AcpHarness = "codex" | "claude-code" | "hermes" | "custom";

/** The five things an external employee's rules decide. */
export type AcpRuleKey =
  | "editInside"
  | "touchOutside"
  | "runCommand"
  | "network"
  | "push";

/**
 * `direct`: done without asking. `ask`: the owner approves each time. `dangerous` (only
 * `runCommand`): asked only for commands judged dangerous.
 */
export type AcpRuleValue = "direct" | "ask" | "dangerous";

/** The rules a newly hired external employee starts with. */
export const ACP_RULE_DEFAULTS: Record<AcpRuleKey, AcpRuleValue> = {
  editInside: "direct",
  touchOutside: "ask",
  runCommand: "dangerous",
  network: "ask",
  push: "ask",
};

/*
 * The `acp.*` frames on the runner socket. They belong to the tenant and device the socket was
 * authenticated as, like the live screen's; nothing in a frame can change that. Paths and commands
 * never travel: a working folder is a `fld_…` reference and an owner's own agent an `app_…`
 * reference, both resolved on the device.
 *
 * EVERY FRAME NAMES ITS EMPLOYEE. Two external employees can share one group thread on the same
 * computer, so the device keeps each `(agentId, threadId)` apart: its own session, its own turns.
 * Every frame but `acp.inventory` carries `agentId`, down and up; a down frame without one is
 * dropped.
 *
 * NO UP FRAME IS OVER 1 MB serialized. One that would be has the long strings of what the agent
 * sent (`update`, `toolCall`) cut shorter and says `truncated: true`; if that is not enough, that
 * payload becomes a stub of its ids (`{sessionUpdate?, toolCallId?, truncated: true}`), the
 * frame's own ids and `seq` kept.
 */

/**
 * Server → device: start (or reuse) the employee's adapter and give this thread its ACP session.
 * `sessionHint` is the session id the device last reported for the thread (`acp.session`): loaded
 * with `session/load` when a new process starts and the agent supports it.
 */
export type AcpOpenFrame = {
  type: "acp.open";
  agentId: string;
  threadId: string;
  harness: AcpHarness;
  workdirRef: string;
  /** Only for `custom`. */
  appRef?: string;
  sessionHint?: string;
};

/** Server → device: one turn. A `turnId` already seen is acknowledged again, never run twice. */
export type AcpPromptFrame = {
  type: "acp.prompt";
  agentId: string;
  threadId: string;
  turnId: string;
  /** ACP content blocks (`session/prompt`'s `prompt`). */
  content: unknown[];
};

/** Server → device: cancel a queued or running turn (`session/cancel` when running). */
export type AcpCancelFrame = {
  type: "acp.cancel";
  agentId: string;
  threadId: string;
  turnId: string;
};

/** Server → device: the answer to `acp.permission.request`; `null` answers `cancelled`. */
export type AcpPermissionAnswerFrame = {
  type: "acp.permission.answer";
  agentId: string;
  requestId: string;
  optionId: string | null;
};

export type AcpDownFrame =
  | AcpOpenFrame
  | AcpPromptFrame
  | AcpCancelFrame
  | AcpPermissionAnswerFrame;

/** Device → server: the turn was received and will run (the server takes it off its queue). */
export type AcpTurnAckFrame = {
  type: "acp.turn.ack";
  agentId: string;
  threadId: string;
  turnId: string;
};

/**
 * Device → server: one `session/update` of a turn, as the agent sent it. `seq` counts from 1 per
 * turn. The device keeps every frame of a turn, and of an ended turn until a heartbeat's ack proves
 * it arrived, and sends them all again, in order, each time it reconnects, so the same
 * `(turnId, seq)` (and the same `acp.turn.end`) can arrive more than once: drop repeats.
 * Past 1000 updates or 5 MB a turn keeps only the latest plan and each tool call's last state, so
 * `seq` may then skip.
 */
export type AcpUpdateFrame = {
  type: "acp.update";
  agentId: string;
  threadId: string;
  turnId: string;
  seq: number;
  update: unknown;
  /** The update was cut to fit the 1 MB limit. */
  truncated?: true;
};

export type AcpPermissionOptionFrame = {
  optionId: string;
  kind: string;
  name: string;
};

/**
 * What the device worked out about a permission request. `insideWorkdir`: whether every path the
 * tool call names is inside the working folder (after resolving `..` and symlinks), `null` when it
 * names none. `paths`: those paths relative to the working folder, or only the file name for one
 * outside it; never an absolute path.
 */
export type AcpPermissionFacts = {
  insideWorkdir: boolean | null;
  paths: string[];
};

/**
 * Device → server: a `session/request_permission`, waiting for `acp.permission.answer`. Sent again,
 * with the same `requestId`, each time the device reconnects while it still waits.
 */
export type AcpPermissionRequestFrame = {
  type: "acp.permission.request";
  agentId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  toolCall: unknown;
  options: AcpPermissionOptionFrame[];
  facts: AcpPermissionFacts;
  /** The tool call was cut to fit the 1 MB limit. */
  truncated?: true;
};

/**
 * Device → server: the turn is over. `stopReason` is the agent's (`end_turn`, `cancelled`, …), or
 * `interrupted` when the adapter's process went away mid-turn (`interrupted: true`), or `error` when
 * the turn could not run (an `acp.error` with the same `turnId` says why).
 */
export type AcpTurnEndFrame = {
  type: "acp.turn.end";
  agentId: string;
  threadId: string;
  turnId: string;
  stopReason: string;
  interrupted: boolean;
};

/**
 * Device → server: the thread's ACP session. `loaded`: the agent already has the thread's earlier
 * conversation (a live session reused, or one `session/load` brought back); `false` for a new
 * session, whose first turn needs XiongBao's own context.
 */
export type AcpSessionFrame = {
  type: "acp.session";
  agentId: string;
  threadId: string;
  sessionId: string;
  loaded: boolean;
};

/** Why the device could not open a thread or run a turn. */
export type AcpErrorCode =
  | "bad_frame"
  | "unknown_workdir"
  | "unknown_app"
  | "not_open"
  | "start_failed"
  | "turn_failed"
  /** An `acp.permission.answer` named an option the agent did not offer; answered `cancelled`. */
  | "bad_option";

/** Device → server: `acp.open` or `acp.prompt` failed. `message` is Chinese, for a person. */
export type AcpErrorFrame = {
  type: "acp.error";
  agentId: string;
  threadId: string;
  turnId?: string;
  code: AcpErrorCode;
  message: string;
};

/** A turn as `acp.inventory` reports it. `awaiting`: running, and waiting for a permission answer. */
export type AcpInventoryTurn = {
  agentId: string;
  threadId: string;
  turnId: string;
  state: "running" | "awaiting" | "ended";
};

/**
 * Device → server: the first frame of every connection, before anything is replayed, so the server
 * can reconcile. `instanceId` is random per runner process: a new one means the runner restarted,
 * and every turn the server thought was running on the old one is gone (it will not end by itself).
 * `turns`: every turn this process still remembers (a queued turn reads `running`); `requestIds`:
 * the permission requests it still waits on (each is sent again right after the replay).
 */
export type AcpInventoryFrame = {
  type: "acp.inventory";
  instanceId: string;
  turns: AcpInventoryTurn[];
  requestIds: string[];
};

export type AcpUpFrame =
  | AcpInventoryFrame
  | AcpTurnAckFrame
  | AcpUpdateFrame
  | AcpPermissionRequestFrame
  | AcpTurnEndFrame
  | AcpSessionFrame
  | AcpErrorFrame;
