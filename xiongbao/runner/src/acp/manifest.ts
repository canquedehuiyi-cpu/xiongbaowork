import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AcpHarness, AcpOpenModel } from "../../../shared/acp";
import type { AcpSpawnSpec } from "./client";
import { acpProcessEnv } from "./login-path";

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
 *
 * SUPPLY CHAIN. The npm adapters are pinned to the exact version checked (no range, so a new release
 * is never picked up unreviewed), and `npx` runs them from a folder of the runner's own
 * (`<data dir>/acp-adapters`, marked as a project root with an empty `package.json`), never from the
 * working folder: a repository's `.npmrc` or `node_modules/.bin` there could otherwise replace the
 * adapter. The working folder reaches the agent only as the `cwd` of `session/new` / `session/load`.
 * The registry is set explicitly (`XIONGBAO_NPM_REGISTRY`, default the public npm registry), and any
 * inherited `npm_config_*` variable that points into the working folder is unset; the owner's
 * user-level npm config is kept.
 */

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

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
      args: ["-y", "@agentclientprotocol/codex-acp@2.6.0"],
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
   */
  "claude-code": {
    binary: "claude",
    adapter: {
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.107.0"],
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
 * THE EMPLOYEE'S OWN MODEL (`acp.open.model`). When the server hands an agent a model block, the agent's
 * requests go to the server's model proxy with the short-lived pass in the block, and the owner's own
 * settings and keys are not read for it. Only the adapter's child process is changed; nothing of the
 * owner's is written or edited.
 *
 *   Codex        a `CODEX_HOME` of its own for this process: a `config.toml` naming a provider whose
 *                address is the proxy (`wire_api = "responses"`) and whose key is read from an
 *                environment variable, which carries the pass. The owner's `~/.codex` is not touched.
 *                (codex-acp 2.6.0 bundles Codex 0.166.0, which reads `model_provider` and
 *                `[model_providers.*]` with `base_url`, `env_key` and `wire_api` from `config.toml`.)
 *   Claude Code  `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in the adapter's environment (the
 *                adapter hands its own environment to the Claude Code process), `ANTHROPIC_MODEL`
 *                and the model variables of the other tiers, and the variables that would send the
 *                request elsewhere unset.
 */

/** The variable Codex reads the pass from (`env_key` in the generated `config.toml`). */
export const MODEL_TOKEN_ENV = "XIONGBAO_AGENT_MODEL_TOKEN";

/** The provider id the generated `config.toml` defines. */
export const MODEL_PROVIDER_ID = "xiongbao";

/** What a model block adds to an adapter's launch. */
export type ModelLaunch = {
  env: Record<string, string>;
  /** Inherited variables that would send the agent's requests somewhere else. */
  unsetEnv: string[];
};

/** A TOML basic string: JSON's escapes are TOML's. */
const toml = (value: string): string => JSON.stringify(value);

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/** Codex's `config.toml` for a model block: the proxy as its only provider. */
export function codexConfigToml(model: AcpOpenModel): string {
  return [
    `model_provider = ${toml(MODEL_PROVIDER_ID)}`,
    `model = ${toml(model.model)}`,
    "",
    `[model_providers.${MODEL_PROVIDER_ID}]`,
    `name = ${toml(MODEL_PROVIDER_ID)}`,
    `base_url = ${toml(`${withoutTrailingSlash(model.baseUrl)}/v1`)}`,
    `env_key = ${toml(MODEL_TOKEN_ENV)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

/** `codexHome` made ready for Codex: an empty folder of ours holding only the generated config. */
export function writeCodexHome(codexHome: string, model: AcpOpenModel): void {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(codexHome, "config.toml"), codexConfigToml(model), {
    mode: 0o600,
  });
}

export function codexModelLaunch(
  model: AcpOpenModel,
  codexHome: string,
): ModelLaunch {
  return {
    env: { CODEX_HOME: codexHome, [MODEL_TOKEN_ENV]: model.token },
    unsetEnv: [],
  };
}

export function claudeModelLaunch(model: AcpOpenModel): ModelLaunch {
  return {
    env: {
      ANTHROPIC_BASE_URL: withoutTrailingSlash(model.baseUrl),
      ANTHROPIC_AUTH_TOKEN: model.token,
      ANTHROPIC_MODEL: model.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model.model,
      ANTHROPIC_SMALL_FAST_MODEL: model.model,
    },
    // A key of the owner's would win over the pass, and a cloud-provider switch would skip the proxy.
    unsetEnv: [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ],
  };
}

/** Where an adapter is started and which working folder its sessions are for. */
export type AdapterPlace = {
  /** The runner's own folder for adapters (`<data dir>/acp-adapters`); created when missing. */
  adapterDir: string;
  /** The shared working folder: only `session/new` / `session/load` get it, never the process. */
  workdir: string;
};

/**
 * `dir` made ready to start adapters in: created (owner only) with an empty `package.json`, so npm
 * takes it as the project root and reads no `.npmrc` or `node_modules` from a folder above it.
 */
export function prepareAdapterDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: "xiongbao-acp-adapters", private: true }, null, 2)}\n`,
    );
  }
}

function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `env` with PATH = `processEnv.PATH` (this process's with the login shell's ahead of it,
 * login-path.ts) when that differs from this process's own PATH and `env` sets none itself.
 */
export function withProcessPath(
  env: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  // Set only when it differs, so Windows (and a PATH with nothing to add) is left exactly as it was.
  if (
    env.PATH === undefined &&
    processEnv.PATH !== undefined &&
    processEnv.PATH !== process.env.PATH
  ) {
    return { ...env, PATH: processEnv.PATH };
  }
  return env;
}

/**
 * The spec `createAcpClient` takes to start `harness`'s adapter so that it asks before acting: the
 * adapter's arguments with `askMode`, `env` (the owner's own, if any) with `askEnv` laid over it,
 * and `askSessionMode`. It starts in `place.adapterDir`, never in the working folder, with the npm
 * registry set and the working folder's npm settings unset (see SUPPLY CHAIN above). On darwin and
 * linux `env.PATH` is the owner's login-shell PATH ahead of the inherited one (login-path.ts), so an
 * adapter or `npx` installed through Homebrew or npm is found even when the app was opened from
 * Finder.
 */
export async function adapterLaunch(
  harness: Exclude<AcpHarness, "custom">,
  place: AdapterPlace,
  opts: {
    env?: Record<string, string>;
    /** The environment whose PATH the adapter is looked up in; this process's with the login PATH. */
    processEnv?: () => Promise<Record<string, string | undefined>>;
    /** The employee's own model (see above): its environment is laid over `env`. */
    model?: ModelLaunch;
  } = {},
): Promise<AcpSpawnSpec> {
  const entry = ACP_MANIFEST[harness];
  const processEnv = await (opts.processEnv ?? acpProcessEnv)();
  prepareAdapterDir(place.adapterDir);
  const registry =
    processEnv.XIONGBAO_NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY;
  const env: Record<string, string> = {
    ...withProcessPath({ ...opts.env }, processEnv),
    ...opts.model?.env,
    ...entry.askEnv,
    npm_config_registry: registry,
  };
  // npm reads `npm_config_*` in any case: another spelling of the registry must not win, and
  // nothing inherited may point npm into the working folder.
  const unsetEnv = [
    ...Object.entries(processEnv)
      .filter(
        ([key, value]) =>
          /^npm_config_/i.test(key) &&
          key !== "npm_config_registry" &&
          (key.toLowerCase() === "npm_config_registry" ||
            (value !== undefined &&
              isAbsolute(value) &&
              inside(place.workdir, value))),
      )
      .map(([key]) => key),
    ...(opts.model?.unsetEnv ?? []),
  ];
  return {
    command: entry.adapter.command,
    args: [...entry.adapter.args, ...entry.askMode],
    env,
    unsetEnv,
    cwd: place.adapterDir,
    sessionMode: entry.askSessionMode,
  };
}
