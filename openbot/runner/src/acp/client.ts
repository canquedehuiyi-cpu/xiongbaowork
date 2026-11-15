import {
  type IncomingMessage,
  McpAppError,
  type StdioLaunch,
  StdioTransport,
} from "../mcp-client";

/**
 * The runner's Agent Client Protocol client (https://agentclientprotocol.com, protocol version 1):
 * newline-delimited JSON-RPC 2.0 on the pipes of an agent's adapter (codex-acp, claude-agent-acp,
 * `hermes acp`, or the owner's own). The process plumbing is the MCP client's `StdioTransport`:
 * the same `launchSpec` (Windows `.cmd` shims run through `cmd.exe /d /s /c`), the same
 * environment without the runner's `XIONGBAO_*` variables, and the same stop that takes the whole
 * process tree down.
 *
 * NO FS, NO TERMINAL. `initialize` declares neither capability, so the agent reads, writes and runs
 * commands with its own tools, and asks (`session/request_permission`) before the ones its mode
 * says to ask about. Any `fs/*`, `terminal/*` or other request from the agent is refused with
 * "Method not found".
 *
 * Asking. Each permission request goes to `handlers.onPermission`; its answer is sent back only if
 * it names one of the options the agent offered (anything else is answered `cancelled`). `cancel`
 * sends `session/cancel` and, as the spec requires, answers every permission request of that
 * session still waiting with `cancelled` at once. When the connection ends (`close`, or the child
 * exits) every request still waiting is settled `cancelled` too. Either way the request's `signal`
 * is aborted, so whoever shows it can withdraw it, and the handler's later answer is dropped.
 *
 * Ask mode. `spec.sessionMode` is required, so no caller can forget it: a mode id, and every
 * session `newSession` creates and `loadSession` loads is switched to that mode
 * (`session/set_mode`, else the `mode` config option) before it is handed out, a session that
 * cannot be switched being refused with an error, never used; or `null` (an owner's own agent,
 * whose modes are unknown). `adapterLaunch` (manifest.ts) gives the right one for a known agent.
 *
 * Errors are the transport's `McpAppError` (`start`, `connect` once the child has gone, `timeout`,
 * `protocol` when the agent answered an error). `prompt` has no time limit: a turn may wait hours
 * for the owner's approval.
 */

export type AcpPermissionOption = {
  optionId: string;
  kind: string;
  name: string;
};

export type AcpPermissionAnswer =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type AcpHandlers = {
  /** A `session/update` of a live session (what `session/load` replays is not passed on). */
  onUpdate(sessionId: string, update: unknown): void;
  onPermission(
    sessionId: string,
    request: {
      toolCall: unknown;
      options: AcpPermissionOption[];
      /** Aborted when the request was settled without the handler: cancelled turn, ended connection. */
      signal: AbortSignal;
    },
  ): Promise<AcpPermissionAnswer>;
};

export type AcpSpawnSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /**
   * The session mode that makes the agent ask before acting (see `ACP_MANIFEST`); `null` only for
   * an agent whose modes are unknown (`custom`). Required on purpose: never left out by accident.
   */
  sessionMode: string | null;
};

export type AcpClient = {
  initialize(): Promise<{ loadSession: boolean }>;
  newSession(cwd: string): Promise<string>;
  /** False when the agent cannot load sessions or does not know this one. */
  loadSession(sessionId: string, cwd: string): Promise<boolean>;
  prompt(
    sessionId: string,
    content: unknown[],
  ): Promise<{ stopReason: string }>;
  cancel(sessionId: string): void;
  close(): Promise<void>;
  readonly alive: boolean;
};

export const ACP_PROTOCOL_VERSION = 1;

/**
 * `initMs` is long because the first start of an npm adapter downloads it through `npx`
 * (codex-acp brings the Codex binary with it).
 */
const DEFAULT_TIMEOUTS = {
  initMs: 180_000,
  sessionMs: 120_000,
  modeMs: 30_000,
};

const CLIENT_INFO = { name: "xiongbao-runner", title: "熊宝", version: "1" };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the agent already reports `mode` as current, in its modes or its config options. */
function alreadyIn(result: unknown, mode: string): boolean {
  if (!isRecord(result)) return false;
  if (isRecord(result.modes) && result.modes.currentModeId === mode)
    return true;
  return (
    Array.isArray(result.configOptions) &&
    result.configOptions.some(
      (option) =>
        isRecord(option) &&
        option.id === "mode" &&
        option.currentValue === mode,
    )
  );
}

export function createAcpClient(
  spec: AcpSpawnSpec,
  handlers: AcpHandlers,
  opts: { timeouts?: Partial<typeof DEFAULT_TIMEOUTS> } = {},
): AcpClient {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  /** Permission requests not answered yet, by the agent's request id. */
  const waiting = new Map<
    string | number,
    { sessionId: string; settle: (answer: AcpPermissionAnswer) => void }
  >();
  /** Sessions being loaded: what the agent replays meanwhile is history the server already has. */
  const loading = new Set<string>();
  let loadSupported = false;

  const launch: StdioLaunch = {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
  };
  const transport: StdioTransport = new StdioTransport(launch, {
    onMessage: (message) => onMessage(message),
    // Nobody can answer any more: what still waits is withdrawn.
    onEnd: () => {
      for (const pending of [...waiting.values()]) {
        pending.settle({ outcome: "cancelled" });
      }
    },
    cancelNotice: (requestId) => ({
      method: "$/cancel_request",
      params: { requestId },
    }),
  });

  function onMessage(message: IncomingMessage) {
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === "session/update" && message.id === undefined) {
      const { sessionId } = params;
      if (typeof sessionId !== "string" || loading.has(sessionId)) return;
      try {
        handlers.onUpdate(sessionId, params.update);
      } catch {
        // The handler's own failure is not the agent's business.
      }
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "session/request_permission") {
      askPermission(message.id, params);
      return;
    }
    transport.reply(message.id, {
      error: { code: -32601, message: "Method not found" },
    });
  }

  function askPermission(id: string | number, params: Json) {
    const { sessionId, toolCall } = params;
    const options = Array.isArray(params.options)
      ? params.options.flatMap((option): AcpPermissionOption[] =>
          isRecord(option) &&
          typeof option.optionId === "string" &&
          typeof option.kind === "string"
            ? [
                {
                  optionId: option.optionId,
                  kind: option.kind,
                  name: typeof option.name === "string" ? option.name : "",
                },
              ]
            : [],
        )
      : [];
    if (typeof sessionId !== "string" || options.length === 0) {
      transport.reply(id, {
        error: { code: -32602, message: "Invalid params" },
      });
      return;
    }
    let answered = false;
    const withdrawn = new AbortController();
    const settle = (answer: AcpPermissionAnswer, byHandler = false) => {
      if (answered) return;
      answered = true;
      waiting.delete(id);
      if (!byHandler) withdrawn.abort();
      const offered =
        answer.outcome === "selected" &&
        options.some((option) => option.optionId === answer.optionId);
      transport.reply(id, {
        result: {
          outcome: offered
            ? {
                outcome: "selected",
                optionId: (answer as { optionId: string }).optionId,
              }
            : { outcome: "cancelled" },
        },
      });
    };
    waiting.set(id, { sessionId, settle });
    Promise.resolve()
      .then(() =>
        handlers.onPermission(sessionId, {
          toolCall,
          options,
          signal: withdrawn.signal,
        }),
      )
      .then(
        (answer) => settle(answer, true),
        () => settle({ outcome: "cancelled" }, true),
      );
  }

  /** Puts the session in the ask mode, or throws: such a session must not be used. */
  async function applyMode(sessionId: string, answered: unknown) {
    const mode = spec.sessionMode;
    if (mode === null || alreadyIn(answered, mode)) return;
    try {
      await transport.request(
        "session/set_mode",
        { sessionId, modeId: mode },
        timeouts.modeMs,
      );
      return;
    } catch (error) {
      if (!(error instanceof McpAppError) || error.kind !== "protocol")
        throw error;
    }
    try {
      await transport.request(
        "session/set_config_option",
        { sessionId, configId: "mode", value: mode },
        timeouts.modeMs,
      );
    } catch (error) {
      if (!(error instanceof McpAppError) || error.kind !== "protocol")
        throw error;
      throw new McpAppError(
        "protocol",
        `The agent would not switch session ${sessionId} to mode "${mode}": ${error.message}`,
      );
    }
  }

  return {
    get alive() {
      return !transport.closed;
    },

    async initialize() {
      const result = await transport.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: CLIENT_INFO,
        },
        timeouts.initMs,
      );
      if (
        !isRecord(result) ||
        result.protocolVersion !== ACP_PROTOCOL_VERSION
      ) {
        throw new McpAppError(
          "protocol",
          `The agent does not speak ACP version ${ACP_PROTOCOL_VERSION}.`,
          transport.stderrTail(),
        );
      }
      transport.markReady();
      const capabilities = isRecord(result.agentCapabilities)
        ? result.agentCapabilities
        : {};
      loadSupported = capabilities.loadSession === true;
      return { loadSession: loadSupported };
    },

    async newSession(cwd) {
      const result = await transport.request(
        "session/new",
        { cwd, mcpServers: [] },
        timeouts.sessionMs,
      );
      if (!isRecord(result) || typeof result.sessionId !== "string") {
        throw new McpAppError("protocol", "session/new answered no sessionId.");
      }
      await applyMode(result.sessionId, result);
      return result.sessionId;
    },

    async loadSession(sessionId, cwd) {
      if (!loadSupported) return false;
      let result: unknown;
      loading.add(sessionId);
      try {
        result = await transport.request(
          "session/load",
          { sessionId, cwd, mcpServers: [] },
          timeouts.sessionMs,
        );
      } catch (error) {
        // The agent answered: it does not know the session. Anything else is the connection's.
        if (error instanceof McpAppError && error.kind === "protocol")
          return false;
        throw error;
      } finally {
        loading.delete(sessionId);
      }
      await applyMode(sessionId, result);
      return true;
    },

    async prompt(sessionId, content) {
      const result = await transport.request(
        "session/prompt",
        { sessionId, prompt: content },
        Number.POSITIVE_INFINITY,
      );
      if (!isRecord(result) || typeof result.stopReason !== "string") {
        throw new McpAppError(
          "protocol",
          "session/prompt answered no stopReason.",
        );
      }
      return { stopReason: result.stopReason };
    },

    cancel(sessionId) {
      transport.notify("session/cancel", { sessionId }).catch(() => {});
      for (const pending of [...waiting.values()]) {
        if (pending.sessionId === sessionId)
          pending.settle({ outcome: "cancelled" });
      }
    },

    close() {
      return transport.close();
    },
  };
}
