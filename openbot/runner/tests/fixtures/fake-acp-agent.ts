import { appendFileSync } from "node:fs";

/**
 * A scriptable ACP agent for the runner's tests: newline-delimited JSON-RPC 2.0 on stdio, like the
 * real adapters (codex-acp, claude-agent-acp, `hermes acp`). Shared by every ACP test, so what it
 * does is driven entirely by a script, given as JSON in the `FAKE_ACP_SCRIPT` environment variable
 * or as the first argument:
 *
 *   loadSession      advertise `agentCapabilities.loadSession` (default false)
 *   protocolVersion  the version `initialize` answers (default 1)
 *   sessionId        the id `session/new` answers; later sessions get `-2`, `-3`… (default "sess_1")
 *   modes            the `modes` state `session/new` and `session/load` answer
 *   setMode          how `session/set_mode` answers: "ok" | "method_not_found" | "error"
 *                    (default "ok" when `modes` is given, else "method_not_found")
 *   setConfigOption  how `session/set_config_option` answers: "ok" | "method_not_found" (default)
 *   loadReplay       updates sent during `session/load`, before it answers
 *   loadFails        `session/load` answers an error (an unknown session)
 *   turns            one entry per `session/prompt`, the last one repeating: its `steps` run in
 *                    order, then the prompt answers `{stopReason}` (default "end_turn")
 *   log              a file path: every message received is appended to it as one JSON line
 *
 * Steps of a turn:
 *   {update}          send `session/update` with this update
 *   {burst}           send `burst.update` `burst.times` times (a long stream, without a long script)
 *   {permission}      ask `session/request_permission` ({toolCall, options}) and wait for the answer,
 *                     then report it as the update {sessionUpdate: "fake_permission_outcome", outcome};
 *                     with `exitAfterMs`, exit with code 4 that long after asking, still waiting
 *   {request}         send any other request ({method, params}) and report the whole response as
 *                     {sessionUpdate: "fake_request_result", response}
 *   {waitForCancel}   wait until `session/cancel` arrives
 *   {sleepMs}         wait that long
 *   {exit}            exit the process with that code, mid-turn
 *
 * Once `session/cancel` has arrived for the session, the turn stops after the current step, reports
 * {sessionUpdate: "fake_cancel_seen"} and answers `{stopReason: "cancelled"}`, as the spec demands.
 */

export type FakeStep =
  | { update: unknown }
  | { burst: { update: unknown; times: number } }
  | {
      permission: {
        toolCall: unknown;
        options: { optionId: string; name: string; kind: string }[];
      };
      exitAfterMs?: number;
    }
  | { request: { method: string; params?: unknown } }
  | { waitForCancel: true }
  | { sleepMs: number }
  | { exit: number };

export type FakeTurn = { steps?: FakeStep[]; stopReason?: string };

export type FakeAcpScript = {
  loadSession?: boolean;
  protocolVersion?: number;
  sessionId?: string;
  modes?: {
    currentModeId: string;
    availableModes: { id: string; name: string }[];
  };
  setMode?: "ok" | "method_not_found" | "error";
  setConfigOption?: "ok" | "method_not_found";
  loadReplay?: unknown[];
  loadFails?: boolean;
  turns?: FakeTurn[];
  log?: string;
};

type Json = Record<string, unknown>;

const script: FakeAcpScript = JSON.parse(
  process.env.FAKE_ACP_SCRIPT ?? process.argv[2] ?? "{}",
);

let sessions = 0;
let prompts = 0;
let nextRequest = 1;
const waiting = new Map<string, (response: Json) => void>();
const cancelled = new Set<string>();
const cancelWaiters = new Map<string, () => void>();

function send(message: Json) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId: string, value: unknown) {
  send({ method: "session/update", params: { sessionId, update: value } });
}

/** A request of ours to the client; string ids, so the client must not assume numbers. */
function ask(method: string, params: unknown): Promise<Json> {
  const id = `fake-${nextRequest++}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

const methodNotFound = { code: -32601, message: "Method not found" };

async function runTurn(id: unknown, sessionId: string) {
  const turns = script.turns ?? [{}];
  const turn = turns[Math.min(prompts, turns.length - 1)] ?? {};
  prompts += 1;
  cancelled.delete(sessionId);
  for (const step of turn.steps ?? []) {
    if ("update" in step) update(sessionId, step.update);
    else if ("burst" in step) {
      for (let i = 0; i < step.burst.times; i++)
        update(sessionId, step.burst.update);
    } else if ("permission" in step) {
      const answer = ask("session/request_permission", {
        sessionId,
        ...step.permission,
      });
      if (step.exitAfterMs !== undefined) {
        const delay = step.exitAfterMs;
        setTimeout(() => process.exit(4), delay);
      }
      const response = await answer;
      const result = response.result as { outcome?: unknown } | undefined;
      update(sessionId, {
        sessionUpdate: "fake_permission_outcome",
        outcome: result?.outcome ?? null,
      });
    } else if ("request" in step) {
      const response = await ask(step.request.method, step.request.params);
      update(sessionId, { sessionUpdate: "fake_request_result", response });
    } else if ("waitForCancel" in step) {
      if (!cancelled.has(sessionId)) {
        await new Promise<void>((resolve) =>
          cancelWaiters.set(sessionId, resolve),
        );
      }
    } else if ("sleepMs" in step) {
      await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
    } else if ("exit" in step) {
      process.exit(step.exit);
    }
    if (cancelled.has(sessionId)) break;
  }
  if (cancelled.has(sessionId)) {
    update(sessionId, { sessionUpdate: "fake_cancel_seen" });
    send({ id, result: { stopReason: "cancelled" } });
    return;
  }
  send({ id, result: { stopReason: turn.stopReason ?? "end_turn" } });
}

function modeAnswer(kind: "ok" | "method_not_found" | "error", id: unknown) {
  if (kind === "ok") send({ id, result: {} });
  else if (kind === "error")
    send({ id, error: { code: -32602, message: "Unknown mode" } });
  else send({ id, error: methodNotFound });
}

function onMessage(message: Json) {
  if (script.log) appendFileSync(script.log, `${JSON.stringify(message)}\n`);
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (method === undefined) {
    const resolve = waiting.get(String(id));
    waiting.delete(String(id));
    resolve?.(message);
    return;
  }
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: script.protocolVersion ?? 1,
          agentCapabilities: { loadSession: script.loadSession === true },
          authMethods: [],
        },
      });
      return;
    case "session/new": {
      sessions += 1;
      const base = script.sessionId ?? "sess_1";
      const sessionId = sessions === 1 ? base : `${base}-${sessions}`;
      send({
        id,
        result: { sessionId, ...(script.modes ? { modes: script.modes } : {}) },
      });
      return;
    }
    case "session/load": {
      if (script.loadFails) {
        send({ id, error: { code: -32002, message: "Resource not found" } });
        return;
      }
      const sessionId = String(params.sessionId);
      for (const replayed of script.loadReplay ?? [])
        update(sessionId, replayed);
      send({ id, result: script.modes ? { modes: script.modes } : {} });
      return;
    }
    case "session/set_mode":
      modeAnswer(
        script.setMode ?? (script.modes ? "ok" : "method_not_found"),
        id,
      );
      return;
    case "session/set_config_option":
      modeAnswer(script.setConfigOption ?? "method_not_found", id);
      return;
    case "session/prompt":
      void runTurn(id, String(params.sessionId));
      return;
    case "session/cancel": {
      const sessionId = String(params.sessionId);
      cancelled.add(sessionId);
      cancelWaiters.get(sessionId)?.();
      cancelWaiters.delete(sessionId);
      return;
    }
    default:
      if (id !== undefined) send({ id, error: methodNotFound });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line) onMessage(JSON.parse(line) as Json);
  }
});
process.stdin.on("end", () => process.exit(0));
