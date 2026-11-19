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

/*
 * THE EMPLOYEE'S OWN COMPUTER (the agent computer container). The same adapters run there, started
 * from the copies the image installed at build time (never `npx`, nothing is downloaded when an
 * employee starts), with the same model block turned into the same launch (`codexModelLaunch`,
 * `claudeModelLaunch`). What differs is who guards what, and it is decided here, once:
 *
 *   Codex        CODEX'S OWN SANDBOX IS OFF; THE CONTAINER IS THE SANDBOX. Codex sandboxes commands with
 *                bubblewrap (user namespaces) plus seccomp, which a container started with every
 *                capability dropped and `no-new-privileges` cannot give it, so under any of its
 *                sandboxed modes every command would fail. The generated `config.toml` defines a
 *                permission profile that grants the whole file system and the network
 *                (`:root = "write"`, `network.enabled`), selected as the session's mode
 *                (`permission-profile:xiongbao-cloud`, which the adapter lists as a mode of its own).
 *                Measured with codex-acp 2.6.0 / Codex 0.166.0: a command under that profile runs
 *                with `Seccomp: 0`, `NoNewPrivs: 0`; under `workspace-write`, `Seccomp: 2`.
 *                An unsandboxed Codex asks for nothing by itself, so what XiongBao's approval gate
 *                is asked about is made explicit in `$CODEX_HOME/rules/xiongbao.rules`: execution policy
 *                rules with `decision = "prompt"` for the programs the gate cares about (deleting,
 *                privileges, the network, installing, pushing; `CLOUD_ASK_PREFIXES`) and for a shell
 *                command Codex cannot split into plain commands (redirections, subshells, here
 *                documents). A matching command arrives as `session/request_permission`, and the
 *                permission bridge decides it with the employee's rules, as for a device. Measured: the
 *                rules fire for a command inside `a && b` and under the unsandboxed profile too.
 *                NOT COVERED: a plain command that matches no rule, and file edits (`apply_patch`, also
 *                outside the working folder), run without a question. Only the container bounds them.
 *   Claude Code  Nothing changes: the session is switched to `default`, Claude Code's own "ask before
 *                editing or running" mode, and every request reaches the bridge as on a device. Its
 *                own sandbox is off by default and stays off. The container runs as root, where Claude
 *                Code refuses only `--dangerously-skip-permissions`, which is never used.
 *
 * Both adapters get an environment built from an allow list (`cloudAdapterLaunch`): nothing of the
 * computer's own (its token, proxies with passwords) is inherited, and the harness's own update checks
 * and telemetry are switched off, so the only traffic is the model proxy and what the employee's
 * work asks for.
 */

/** The permission profile of a cloud Codex, and the session mode that selects it. */
export const CLOUD_CODEX_PROFILE = "xiongbao-cloud";
export const CLOUD_CODEX_MODE = `permission-profile:${CLOUD_CODEX_PROFILE}`;

/**
 * The programs a cloud Codex asks the approval gate about, one first word (any of `first`) or a first
 * word and a subcommand (`first` with `second`). The gate's own rules decide each one: asking is not
 * refusing.
 */
export const CLOUD_ASK_PREFIXES: readonly {
  first: readonly string[];
  second?: readonly string[];
}[] = [
  // Deleting, changing who may do what, taking the machine down.
  {
    first: [
      "rm",
      "rmdir",
      "shred",
      "unlink",
      "chmod",
      "chown",
      "chgrp",
      "sudo",
      "su",
      "dd",
      "mkfs",
      "mount",
      "umount",
      "kill",
      "pkill",
      "killall",
      "shutdown",
      "reboot",
    ],
  },
  // The network.
  {
    first: [
      "curl",
      "wget",
      "ssh",
      "scp",
      "sftp",
      "rsync",
      "nc",
      "ncat",
      "telnet",
      "ftp",
    ],
  },
  { first: ["git"], second: ["push", "clone", "fetch", "pull", "remote"] },
  // Installing and publishing.
  {
    first: ["npm", "pnpm", "yarn", "bun"],
    second: ["install", "i", "add", "publish", "exec", "dlx", "x"],
  },
  { first: ["npx", "bunx", "pnpx"] },
  { first: ["pip", "pip3", "uv", "pipx"], second: ["install", "add", "run"] },
  { first: ["apt", "apt-get", "dpkg"] },
  { first: ["cargo", "go"], second: ["install", "get", "publish"] },
  { first: ["docker", "podman"] },
];

/** Shells a command is wrapped in. A wrapped command Codex cannot split asks as a whole. */
const SHELL_WRAPPERS = ["bash", "sh", "zsh"].flatMap((name) => [
  name,
  `/bin/${name}`,
  `/usr/bin/${name}`,
]);

const starlark = (values: readonly string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

/** `$CODEX_HOME/rules/xiongbao.rules`: the questions a cloud Codex puts to the approval gate. */
export function cloudCodexRules(): string {
  const justification = JSON.stringify(
    "Asked of the approval gate, which applies this employee's own rules.",
  );
  const rule = (pattern: string) =>
    `prefix_rule(\n    pattern = ${pattern},\n    decision = "prompt",\n    justification = ${justification},\n)\n`;
  return [
    // A shell command Codex could not split into plain commands is asked about whole.
    rule(`[${starlark(SHELL_WRAPPERS)}, ${starlark(["-c", "-lc"])}]`),
    ...CLOUD_ASK_PREFIXES.map(({ first, second }) =>
      rule(
        second
          ? `[${starlark(first)}, ${starlark(second)}]`
          : `[${starlark(first)}]`,
      ),
    ),
  ].join("\n");
}

/** A cloud Codex's `config.toml`: the proxy as its only provider, and no sandbox of its own. */
export function cloudCodexConfigToml(model: AcpOpenModel): string {
  return [
    `model_provider = ${toml(MODEL_PROVIDER_ID)}`,
    `model = ${toml(model.model)}`,
    'approval_policy = "on-request"',
    `default_permissions = ${toml(CLOUD_CODEX_PROFILE)}`,
    "check_for_update_on_startup = false",
    "",
    `[model_providers.${MODEL_PROVIDER_ID}]`,
    `name = ${toml(MODEL_PROVIDER_ID)}`,
    `base_url = ${toml(`${withoutTrailingSlash(model.baseUrl)}/v1`)}`,
    `env_key = ${toml(MODEL_TOKEN_ENV)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    "# The container is the sandbox: the whole file system and the network, as the container allows.",
    `[permissions.${CLOUD_CODEX_PROFILE}.filesystem]`,
    '":root" = "write"',
    "",
    `[permissions.${CLOUD_CODEX_PROFILE}.network]`,
    "enabled = true",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
  ].join("\n");
}

/** `codexHome` made ready for a cloud Codex: its config and its rules, nothing else. */
export function writeCloudCodexHome(
  codexHome: string,
  model: AcpOpenModel,
): void {
  mkdirSync(join(codexHome, "rules"), { recursive: true, mode: 0o700 });
  writeFileSync(join(codexHome, "config.toml"), cloudCodexConfigToml(model), {
    mode: 0o600,
  });
  writeFileSync(join(codexHome, "rules", "xiongbao.rules"), cloudCodexRules(), {
    mode: 0o600,
  });
}

/** The adapters' bin names inside the image's install folder. */
const CLOUD_ADAPTER_BIN = {
  codex: "codex-acp",
  "claude-code": "claude-agent-acp",
} as const;

/**
 * The spec that starts `harness`'s adapter on the employee's cloud computer: the copy installed in
 * the image (`binDir/<adapter>`, run by `node`), with `env` (already an allow list) plus the model's
 * environment and the harness's own settings, and EVERY OTHER VARIABLE OF THIS PROCESS UNSET (the
 * computer's token and the like): `childEnv` hands a child the parent's environment unless told not to.
 */
export function cloudAdapterLaunch(
  harness: "codex" | "claude-code",
  place: { adapterDir: string },
  opts: {
    binDir: string;
    env: Record<string, string>;
    model: ModelLaunch;
    /** The environment `childEnv` would inherit from; this process's own unless a test passes one. */
    parentEnv?: Record<string, string | undefined>;
  },
): AcpSpawnSpec {
  const harnessEnv: Record<string, string> =
    harness === "codex"
      ? { INITIAL_AGENT_MODE: CLOUD_CODEX_MODE, NO_BROWSER: "1" }
      : {
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        };
  const env = { ...opts.env, ...opts.model.env, ...harnessEnv };
  return {
    command: "node",
    args: [join(opts.binDir, CLOUD_ADAPTER_BIN[harness])],
    env,
    unsetEnv: [
      ...new Set([
        ...Object.keys(opts.parentEnv ?? process.env),
        ...opts.model.unsetEnv,
      ]),
    ],
    cwd: place.adapterDir,
    sessionMode: harness === "codex" ? CLOUD_CODEX_MODE : "default",
  };
}
