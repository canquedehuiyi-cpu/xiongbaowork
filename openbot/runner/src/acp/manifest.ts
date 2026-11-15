import type { AcpHarness } from "../../../shared/acp";

/**
 * How each known agent is reached over ACP, checked against each adapter's own source and docs on
 * 2026-11-15. The adapters are npm packages run through `npx` (their bin needs Node either way) or,
 * for Hermes, its own CLI.
 *
 *   binary          the agent's own CLI, looked for on PATH by `agents.discover`
 *   adapter         the command that speaks ACP on stdio
 *   askMode         extra adapter arguments that make it ask before every non-read action
 *   askEnv          environment for the same, where the adapter takes it from there
 *   askSessionMode  the ACP session mode set on every new or loaded session for the same
 *                   (`session/set_mode`, or `session/set_config_option` "mode" on agents that
 *                   have config options instead); `createAcpClient` refuses a session it cannot
 *                   switch, so an agent that would act without asking is never used
 *
 * NONE OF THE THREE ADAPTERS TAKES A COMMAND-LINE FLAG FOR THIS: `askMode` is empty for all of them,
 * and the guarantee comes from `askEnv` and `askSessionMode`. Use `adapterLaunch` to get a spec that
 * carries all three.
 */

export type AcpManifestEntry = {
  binary: string;
  adapter: { command: string; args: string[] };
  askMode: string[];
  askEnv: Record<string, string>;
  askSessionMode: string | null;
};

export const ACP_MANIFEST: Record<
  Exclude<AcpHarness, "custom">,
  AcpManifestEntry
> = {
  /*
   * Codex through codex-acp (npm @agentclientprotocol/codex-acp, bin `codex-acp`, 2.6.0; it bundles
   * @openai/codex and reads the owner's ~/.codex login).
   * Source: https://github.com/agentclientprotocol/codex-acp (README "npx -y
   * @agentclientprotocol/codex-acp"; `INITIAL_AGENT_MODE` in README and src/AgentMode.ts).
   * The adapter reads no flags (src/index.ts starts the server for any argv but `cli`). Its mode
   * "read-only" is approval policy `on-request` with a read-only sandbox: "Requires approval to edit
   * files and access the internet." Commands that only read run inside the sandbox without asking.
   * Its default mode is "agent" ("Auto review": only actions judged unsafe ask), hence both the
   * environment variable and the session mode.
   */
  codex: {
    binary: "codex",
    adapter: {
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@2"],
    },
    askMode: [],
    askEnv: { INITIAL_AGENT_MODE: "read-only" },
    askSessionMode: "read-only",
  },
  /*
   * Claude Code through claude-agent-acp (npm @agentclientprotocol/claude-agent-acp, bin
   * `claude-agent-acp`, 0.107.0; the Claude CLI comes with its SDK, or CLAUDE_CODE_EXECUTABLE).
   * Source: https://github.com/agentclientprotocol/claude-agent-acp (package.json bin;
   * src/session-mode.ts `resolveInitialPermissionMode`, src/v1/acp-agent.ts).
   * The adapter has no permission flag (argv: only --cli, --version, --hide-claude-auth), and the
   * `permissionMode` of session/new `_meta` is ignored. Without a `permissions.defaultMode` setting a
   * session starts in "auto" (a classifier decides, mostly without asking), so the session is
   * switched to "default": Claude Code's standard mode, which asks before edits and commands. It is
   * still the owner's settings (`permissions.allow`) that may pre-approve some tools.
   * The npm package is 0.x, so the range is pinned to its current minor.
   */
  "claude-code": {
    binary: "claude",
    adapter: {
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.107"],
    },
    askMode: [],
    askEnv: {},
    askSessionMode: "default",
  },
  /*
   * Hermes Agent (Nous Research) speaks ACP itself: `hermes acp` (the `acp` extra must be
   * installed; `hermes acp --check` verifies it).
   * Source: https://github.com/NousResearch/hermes-agent website/docs/user-guide/features/acp.md
   * ("Launching the ACP server", "Approvals") and acp_adapter/modes.py, acp_adapter/entry.py.
   * NOT CONFIRMED THAT EVERY NON-READ ACTION ASKS: `hermes acp` takes no approval flag (only
   * --version, --check, --setup, --setup-browser, --yes). Its session mode "default" is "Ask before
   * edits."; terminal commands ask only when Hermes flags them as dangerous, and how is set by
   * `approvals.mode` in the owner's ~/.hermes/config.yaml (smart, the default, lets an auxiliary
   * model approve low-risk flagged commands; manual asks for every flagged one). No launch option
   * makes an unflagged command ask.
   */
  hermes: {
    binary: "hermes",
    adapter: { command: "hermes", args: ["acp"] },
    askMode: [],
    askEnv: {},
    askSessionMode: "default",
  },
};

/**
 * The spec `createAcpClient` takes to start `harness`'s adapter in `cwd` so that it asks before
 * acting: the adapter's arguments with `askMode`, `env` (the owner's own, if any) with `askEnv`
 * laid over it, and `askSessionMode`.
 */
export function adapterLaunch(
  harness: Exclude<AcpHarness, "custom">,
  cwd: string,
  env: Record<string, string> = {},
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sessionMode?: string;
} {
  const entry = ACP_MANIFEST[harness];
  return {
    command: entry.adapter.command,
    args: [...entry.adapter.args, ...entry.askMode],
    env: { ...env, ...entry.askEnv },
    cwd,
    ...(entry.askSessionMode === null
      ? {}
      : { sessionMode: entry.askSessionMode }),
  };
}
