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

/**
 * An employee's saved rules (`agents.configuration.permissions`), as the permission bridge and every
 * screen read them: the default where a rule is missing, "ask" where a value is one that rule cannot
 * take. One reading, so what a screen shows is what the bridge applies.
 */
export function acpRulesFrom(
  configuration: unknown,
): Record<AcpRuleKey, AcpRuleValue> {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const saved = object(object(configuration)?.permissions) ?? {};
  const rules = { ...ACP_RULE_DEFAULTS };
  for (const key of Object.keys(ACP_RULE_DEFAULTS) as AcpRuleKey[]) {
    if (!(key in saved)) continue;
    const value = saved[key];
    rules[key] =
      value === "direct" ||
      value === "ask" ||
      (value === "dangerous" && key === "runCommand")
        ? value
        : "ask";
  }
  return rules;
}

/**
 * Where an external employee runs: `cloud` is the employee's own XiongBao computer (the agent
 * computer container, reached through the computer gateway), `device` the owner's paired machine
 * (the runner socket). Saved in `agents.configuration.runtime`; an employee saved before there was a
 * choice has none and runs on its device.
 */
export type AcpRuntime = "cloud" | "device";

/** An employee's runtime as a screen or the server reads it: `device` unless it says `cloud`. */
export function acpRuntimeFrom(configuration: unknown): AcpRuntime {
  const saved =
    configuration &&
    typeof configuration === "object" &&
    !Array.isArray(configuration)
      ? (configuration as Record<string, unknown>).runtime
      : undefined;
  return saved === "cloud" ? "cloud" : "device";
}

/**
 * The working folder reference of a cloud employee's `acp.open`. There is one working folder on a
 * cloud computer, the employee's own folder in its workspace, so the reference is fixed and the
 * computer resolves it itself; no path ever travels.
 */
export const ACP_CLOUD_WORKDIR_REF = "cloud:workspace";

/**
 * The device id a cloud employee's turns are queued under (`acp_turns.device_id`), so the relay's
 * lanes, queues and reconciliation work for it exactly as for a paired machine: one "device" per
 * cloud employee, never colliding with a real device id (those never start with `cloud:`).
 */
export const ACP_CLOUD_DEVICE_PREFIX = "cloud:";

export function acpCloudDeviceId(agentId: string): string {
  return `${ACP_CLOUD_DEVICE_PREFIX}${agentId}`;
}

/** The employee a cloud device id stands for, or null for a real device id. */
export function acpCloudAgentOf(deviceId: string): string | null {
  return deviceId.startsWith(ACP_CLOUD_DEVICE_PREFIX) &&
    deviceId.length > ACP_CLOUD_DEVICE_PREFIX.length
    ? deviceId.slice(ACP_CLOUD_DEVICE_PREFIX.length)
    : null;
}

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
  /**
   * Only for `codex` and `claude-code`, and only when the employee has a model of its own in
   * XiongBao: the agent's model requests then go to the server's model proxy instead of the owner's
   * own settings. Absent, the agent runs on what the owner configured on the computer, as before.
   */
  model?: AcpOpenModel;
};

/** The request format a harness speaks to its model: Codex `responses`, Claude Code `messages`. */
export type AcpModelWire = "responses" | "messages";

/**
 * Where an external employee's model requests go (`acp.open.model`). NO REAL KEY EVER TRAVELS: `token`
 * is a short-lived pass the server signed for this one employee in this one thread, good only at the
 * model proxy, which swaps in the real credential on the server and counts the usage. A device that
 * keeps it past `expiresAt`, or after the employee is gone, holds nothing that works.
 */
export type AcpOpenModel = {
  /** The proxy's address without a version segment (`https://host/api/agent-model`). */
  baseUrl: string;
  token: string;
  /** The employee's model, as the harness may show it; the server uses its own regardless. */
  model: string;
  wire: AcpModelWire;
  /** When `token` stops working, milliseconds since the epoch. */
  expiresAt?: number;
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
  | "bad_option"
  /**
   * The agent left the mode that makes it ask before acting and would not go back: the turn ends
   * `error` and the session is never used again (the next turn gets a new one).
   */
  | "ask_mode_lost";

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
  /**
   * The inventory did not fit in 1 MB: ended turns were left out first (oldest first), and past
   * that both lists may be empty. A turn missing from a truncated inventory may still be running.
   */
  truncated?: boolean;
};

export type AcpUpFrame =
  | AcpInventoryFrame
  | AcpTurnAckFrame
  | AcpUpdateFrame
  | AcpPermissionRequestFrame
  | AcpTurnEndFrame
  | AcpSessionFrame
  | AcpErrorFrame;

/*
 * THE CLOUD COMPUTER'S TRANSPORT. A cloud employee's frames are the same `acp.*` frames, carried over
 * the computer's HTTP port instead of a socket: down frames are POSTed to `/acp/frame`, up frames are
 * read from a long-lived NDJSON response (`GET /acp/events`), one frame per line. Two lines only the
 * stream itself uses: `acp.stream` first (naming the connection, which the acknowledgements quote) and
 * `acp.beat` every few seconds, which the server answers with `POST /acp/ack` once it has taken in
 * every frame before it, exactly as a runner's heartbeat is acked.
 */
export type AcpStreamOpenFrame = { type: "acp.stream"; connectionId: string };
export type AcpStreamBeatFrame = { type: "acp.beat" };
