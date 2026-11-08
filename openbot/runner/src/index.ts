#!/usr/bin/env bun
/**
 * The runner: this machine, offered to a tenant's coworkers (ticket 016).
 *
 * IT DIALS OUT AND LISTENS TO NOTHING. That is the whole shape of it, and it is not a convenience —
 * the machine a coworker works on is a laptop behind a router, on a café network, with a firewall that
 * should never have to be opened for a piece of software somebody installed. So the connection is
 * always initiated from here, the server answers a socket it did not open, and nothing on this machine
 * binds a port.
 *
 * The credential is a pairing code typed once, from the owner's own screen, and the device token it
 * bought — kept here, on disk, in a file this process creates for itself. There is no password to
 * enter, no login to keep alive, and nothing a screenshot could give away.
 */
import { existsSync, mkdirSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_REF, type AppEntry, type AppInput, createAppRegistry } from "./apps";
import { createAppHost } from "./app-host";
import { createRunnerBrowser, type RunnerBrowser } from "./browser";
import {
  type CredentialStore,
  createFileCredentialStore,
  deviceIdFor,
} from "./credentials";
import { createRunnerDispatcher } from "./dispatch";
// --- app discovery (sub-project 3) ---
import type { DiscoverDeps } from "./discover";
import { createDiscoverActions } from "./discover-actions";
// --- end app discovery ---
import {
  browserProfileRootFor,
  createRunnerExecutor,
  type RunnerExecutor,
} from "./execute";
import { createActionJournal } from "./journal";
import { createRootRegistry, type RootMode, type RootRegistry } from "./roots";
import { createRunnerScreens } from "./screencast";

/** The environment twin of `--data-dir`, for a desktop shell that starts the runner as a sidecar. */
export const DATA_DIR_ENV = "OPENBOT_RUNNER_DATA_DIR";

/**
 * Every place this process writes to, worked out once from the arguments.
 *
 * `dataDir` is the one root. With `--data-dir` (or its environment variable) it is that directory;
 * without, it is the directory the runner was started in, which is where a runner has always put its
 * files — so a machine started the old way finds its token where it left it. Everything else is named
 * relative to it, with the same file names as before:
 *
 *   <dataDir>/runner-state.json                 the credentials (see `credentials.ts`)
 *   <dataDir>/runner-state.json.actions.sqlite  the action journal, beside whichever state file is used
 *   <dataDir>/runner-workspace/                 what the file and shell tools reach
 *   <dataDir>/runner-browser-profiles/          browser profiles, beside the workspace, never inside
 */
export type RunnerPaths = {
  dataDir: string;
  /** True when the root was asked for, rather than defaulted to the launch directory. */
  explicitDataDir: boolean;
  workspaceDir: string;
  stateFile: string;
  journalFile: string;
};

export type Options = {
  server: string;
  name: string;
  pair?: string;
  paths: RunnerPaths;
  intervalMs: number;
  browser: {
    profileRoot: string;
    headless: boolean;
    allowPrivateHosts: boolean;
    executablePath?: string;
    channel?: string;
  };
};

const DEFAULT_INTERVAL_MS = 20_000;
/** The browsers `playwright-core` knows how to find on a machine, by the name it expects. */
const BROWSER_CHANNELS = new Set(["chrome", "msedge", "chromium"]);

function usage(): string {
  return [
    "usage: bun runner/src/index.ts --server https://bot.example.com [options]",
    "",
    "  --pair CODE     the pairing code shown on the owner's Devices screen",
    "  --name NAME     what this machine is called (default: its hostname)",
    "  --data-dir PATH where this runner keeps everything it writes: its token, its action journal,",
    "                  the workspace and browser profiles. Also read from OPENBOT_RUNNER_DATA_DIR.",
    "                  Default: the directory the runner is started in.",
    "  --state PATH    where to keep the device token (default: <data dir>/runner-state.json;",
    "                  a relative path is taken inside the data directory)",
    "  --interval SEC  heartbeat interval, default 20",
    "",
    "Browser. A coworker's assistant can drive a real browser on this machine. Nothing is downloaded:",
    "by default it uses the Chrome installed here, in a window you can see and can close.",
    "  --browser-executable PATH  a Chrome or Chromium binary already on this machine",
    "  --browser-channel NAME     chrome | msedge | chromium, to use an installed one by name",
    "  --browser-profile PATH     where browser profiles live (default: beside the workspace)",
    "  --browser-headless BOOL    run without a window (default: false; for tests, not for work)",
    "  --browser-private-hosts BOOL  let it open addresses on your own network (default: false)",
    "",
    "A headless browser is a browser nobody is watching: it cannot be closed by hand when it goes",
    "wrong, and a site that asks you to prove you are a person has nobody to answer. Leave it off.",
    "",
    "The private-hosts switch is for a local fixture you are throwing away, not for working days:",
    "it lets an assistant reach services on the network this machine is plugged into. Cloud metadata",
    "addresses stay refused either way.",
    "",
    "Folders. Your 分身 can read folders you name here, and only those, and never write to them.",
    "Each command below changes this machine's list and exits; a running runner picks it up.",
    "  --add-root NAME=PATH       offer the folder at PATH (absolute) under the name NAME",
    "  --root-mode read|write     with --add-root: write lets a coworker change files and run commands",
    "                             there, when a project on that folder is also set writable. Default: read.",
    "                             Your 分身 only ever reads, whatever the mode.",
    "  --remove-root REF|NAME     stop offering a folder",
    "  --list-roots               print the folders offered, as JSON",
    "The server is told each folder's name and an opaque reference, never its path.",
    "",
    "The runner makes no inbound connections: it dials out, and the server never reaches this machine.",
  ].join("\n");
}

/** A `true`/`false` switch, refused rather than guessed at when it is neither. */
function booleanFlag(
  args: Map<string, string>,
  name: string,
  fallback: boolean,
): boolean | string {
  const value = args.get(name)?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return `--${name} must be true or false.`;
}

/**
 * The browser settings, checked at startup.
 *
 * A typo'd executable and a profile directory inside the workspace both fail later, in a place where
 * the answer reaches a model as "the computer failed". Saying which field was wrong, before pairing,
 * is the only point at which a person can still fix it.
 *
 * The defaults are the owner's installed Chrome in a window they can see. Headless is a switch a test
 * may turn on, and the reason it is not the default is in `usage()`.
 */
function browserOptions(
  args: Map<string, string>,
  paths: RunnerPaths,
): Options["browser"] | string {
  const headless = booleanFlag(args, "browser-headless", false);
  if (typeof headless === "string") return headless;
  const allowPrivateHosts = booleanFlag(args, "browser-private-hosts", false);
  if (typeof allowPrivateHosts === "string") return allowPrivateHosts;

  const executablePath = args.get("browser-executable")?.trim() ?? "";
  if (executablePath && !existsSync(resolve(executablePath))) {
    return `--browser-executable is not a file I can see: ${executablePath}`;
  }
  const channel = args.get("browser-channel")?.trim().toLowerCase() ?? "";
  if (channel && !BROWSER_CHANNELS.has(channel)) {
    return `--browser-channel must be one of ${[...BROWSER_CHANNELS].join(", ")}.`;
  }

  const given = args.get("browser-profile")?.trim() ?? "";
  const workspaceDir = paths.workspaceDir;
  // The default is the same helper the executor uses when it is handed only a workspace, so the two
  // cannot drift into two profile roots on one machine. A relative path is taken inside the data
  // directory, like `--state`.
  const profileRoot = given
    ? resolve(paths.dataDir, given)
    : browserProfileRootFor(workspaceDir);
  /*
   * A profile beside the workspace is a set of live sessions the file tools can read.
   *
   * `files.read` is confined to the workspace and reaches every byte inside it, so a profile asked to
   * live in there would hand an assistant the owner's cookies. Refusing the overlap is the one rule
   * here that cannot be relaxed by a flag, because the person who would relax it is the one being
   * protected from it.
   */
  if (
    profileRoot === workspaceDir ||
    profileRoot.startsWith(workspaceDir + sep)
  ) {
    return "--browser-profile cannot be inside the runner's workspace, where the file tools reach.";
  }

  return {
    profileRoot,
    headless,
    allowPrivateHosts,
    ...(executablePath ? { executablePath } : {}),
    ...(channel ? { channel } : {}),
  };
}

/**
 * The data directory and everything named inside it.
 *
 * The flag wins over the environment, and either one means nothing is written to the launch directory:
 * a packaged app is started from wherever its launcher happens to be, and a file left there is a
 * token nobody knows to protect. A relative `--state` is taken inside the root for the same reason.
 * Absolute paths are honoured as given, because a person who typed one meant it.
 */
function runnerPaths(
  args: Map<string, string>,
  env: Record<string, string | undefined>,
  cwd: string,
): RunnerPaths | string {
  const flag = args.has("data-dir") ? (args.get("data-dir") ?? "") : undefined;
  if (flag !== undefined && !flag.trim()) {
    return "--data-dir needs a directory.";
  }
  const asked = flag?.trim() || env[DATA_DIR_ENV]?.trim() || "";
  const dataDir = resolve(cwd, asked || ".");
  const stateFile = resolve(dataDir, args.get("state") || "runner-state.json");
  const workspaceDir = join(dataDir, "runner-workspace");
  // The same reason as the browser profile below: `files.read` reaches everything in the workspace,
  // and the state file is the device token.
  if (stateFile.startsWith(workspaceDir + sep)) {
    return "--state cannot be inside the runner's workspace, where the file tools reach.";
  }
  return {
    dataDir,
    explicitDataDir: Boolean(asked),
    workspaceDir,
    stateFile,
    journalFile: `${stateFile}.actions.sqlite`,
  };
}

/**
 * The runner's own files, which no read-only folder may overlap: the token, the journal, the
 * workspace, the browser profiles, and, when a data directory was asked for, all of it (a packaged
 * app's data directory holds nothing a model should read). Without one the data directory is
 * wherever the runner was started, often a home directory, so only the files themselves are named.
 */
function runnerPrivatePaths(paths: RunnerPaths, profileRoot: string): string[] {
  return [
    paths.stateFile,
    paths.journalFile,
    paths.workspaceDir,
    profileRoot,
    ...(paths.explicitDataDir ? [paths.dataDir] : []),
  ];
}

/** One change to this machine's read-only folders, asked for on the command line. */
export type RootCommand =
  | { kind: "add"; name: string; path: string; mode: RootMode }
  | { kind: "remove"; target: string }
  | { kind: "list" };

/** The flags that are an app command rather than a run (spec §3.1), and the one that takes no value. */
const APP_FLAGS = new Set([
  "list-apps",
  "add-app",
  "remove-app",
  "test-app",
  "enable-app",
  "disable-app",
  // --- app discovery (sub-project 3) ---
  "discover-apps",
  "enable-candidate",
  // --- end app discovery ---
]);
/** The app flags that take no value. */
const VALUELESS_APP_FLAGS = new Set(["list-apps", "discover-apps"]);
const MIXED_FLAGS =
  "Folder flags (--add-root, --remove-root, --list-roots) and app flags (--list-apps, --add-app, --remove-app, --test-app, --enable-app, --disable-app, --discover-apps, --enable-candidate) cannot be used together.";

/** The flags that are a root command rather than a run, and the one of them that takes no value. */
const ROOT_FLAGS = new Set(["add-root", "remove-root", "list-roots"]);

/**
 * A root command and where its registry lives, null when the arguments are a normal run, or the
 * sentence that says what was wrong.
 *
 * No `--server`: registering a folder is a fact about this machine, and is done before, after or
 * without a pairing. The data directory is worked out exactly as a run works it out, so the command
 * and the runner read the same file; the state file and the browser profiles are named too, because
 * no folder may be registered over them.
 */
export function parseRootCommand(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
):
  | { command: RootCommand; dataDir: string; privatePaths: string[] }
  | string
  | null {
  if (!argv.some((entry) => ROOT_FLAGS.has(entry.replace(/^--/, "")))) {
    return null;
  }
  if (argv.some((entry) => APP_FLAGS.has(entry.replace(/^--/, "")))) {
    return MIXED_FLAGS;
  }
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry?.startsWith("--")) return `Unknown argument: ${entry ?? ""}`;
    const name = entry.slice(2);
    if (name === "list-roots") {
      args.set(name, "");
      continue;
    }
    args.set(name, argv[index + 1] ?? "");
    index += 1;
  }
  const asked = [...ROOT_FLAGS].filter((flag) => args.has(flag));
  if (asked.length > 1)
    return "Pass one of --add-root, --remove-root or --list-roots.";
  if (args.has("root-mode") && !args.has("add-root"))
    return "--root-mode goes with --add-root.";
  const modeFlag = (args.get("root-mode") ?? "read").trim().toLowerCase();
  if (modeFlag !== "read" && modeFlag !== "write")
    return "--root-mode must be read or write.";
  const paths = runnerPaths(args, env, cwd);
  if (typeof paths === "string") return paths;
  const profile = args.get("browser-profile")?.trim();
  const privatePaths = runnerPrivatePaths(
    paths,
    profile
      ? resolve(paths.dataDir, profile)
      : browserProfileRootFor(paths.workspaceDir),
  );
  let command: RootCommand;
  if (args.has("add-root")) {
    const value = args.get("add-root") ?? "";
    const split = value.indexOf("=");
    if (split <= 0)
      return "--add-root needs NAME=PATH, for example 周报=/Users/me/Documents/周报.";
    command = {
      kind: "add",
      name: value.slice(0, split),
      path: value.slice(split + 1),
      mode: modeFlag,
    };
  } else if (args.has("remove-root")) {
    const target = args.get("remove-root")?.trim() ?? "";
    if (!target) return "--remove-root needs the folder's reference or name.";
    command = { kind: "remove", target };
  } else {
    command = { kind: "list" };
  }
  return { command, dataDir: paths.dataDir, privatePaths };
}

/**
 * Carry out a root command and print one JSON line, which the device app reads and a person can too.
 *
 * The printed list includes each folder's path: it is printed here, on this machine, to its owner.
 * What the server is sent is `reported()`, which has no path.
 */
export function runRootCommand(
  parsed: { command: RootCommand; dataDir: string; privatePaths: string[] },
  print: (line: string) => void = (line) => console.log(line),
): number {
  const registry = createRootRegistry({
    dataDir: parsed.dataDir,
    privatePaths: parsed.privatePaths,
  });
  try {
    const { command } = parsed;
    if (command.kind === "add") {
      const root = registry.add(command.name, command.path, command.mode);
      print(JSON.stringify({ ok: true, root, roots: registry.list() }));
      return 0;
    }
    if (command.kind === "remove") {
      if (!registry.remove(command.target)) {
        print(JSON.stringify({ ok: false, error: "没有找到这个文件夹。" }));
        return 2;
      }
      print(JSON.stringify({ ok: true, roots: registry.list() }));
      return 0;
    }
    print(JSON.stringify({ ok: true, roots: registry.list() }));
    return 0;
  } catch (error) {
    print(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "操作没有成功。",
      }),
    );
    return 2;
  }
}

/** One change to, or check of, this machine's local MCP apps, asked for on the command line. */
export type AppCommand =
  | { kind: "list" }
  | { kind: "add"; input: AppInput }
  /** `--add-app -`: the app's JSON is read from stdin, so its keys are never on a command line. */
  | { kind: "add-stdin" }
  | { kind: "remove"; target: string }
  | { kind: "test"; target: string }
  | { kind: "enable"; target: string }
  | { kind: "disable"; target: string }
  /** `--discover-apps`: what this machine could offer, by name (app discovery). */
  | { kind: "discover" }
  /** `--enable-candidate <ref>`: register (or switch back on) what discovery offered, and test it. */
  | { kind: "enable-candidate"; candidate: string };

/**
 * An app command and where its registry lives, null when the arguments are not one, or the sentence
 * that says what was wrong. Like a root command it needs no `--server`, and it never mixes with a
 * root command in one invocation.
 */
export function parseAppCommand(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): { command: AppCommand; dataDir: string } | string | null {
  if (!argv.some((entry) => APP_FLAGS.has(entry.replace(/^--/, "")))) {
    return null;
  }
  if (argv.some((entry) => ROOT_FLAGS.has(entry.replace(/^--/, "")))) {
    return MIXED_FLAGS;
  }
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry?.startsWith("--")) return `Unknown argument: ${entry ?? ""}`;
    const name = entry.slice(2);
    if (VALUELESS_APP_FLAGS.has(name)) {
      args.set(name, "");
      continue;
    }
    args.set(name, argv[index + 1] ?? "");
    index += 1;
  }
  const asked = [...APP_FLAGS].filter((flag) => args.has(flag));
  if (asked.length > 1)
    return "Pass one of --list-apps, --add-app, --remove-app, --test-app, --enable-app, --disable-app, --discover-apps or --enable-candidate.";
  const paths = runnerPaths(args, env, cwd);
  if (typeof paths === "string") return paths;
  const flag = asked[0] ?? "";
  const value = args.get(flag)?.trim() ?? "";
  let command: AppCommand;
  if (flag === "add-app") {
    if (value === "-") {
      command = { kind: "add-stdin" };
    } else {
      const input = parseAppInput(args.get(flag) ?? "");
      if (typeof input === "string") return input;
      command = { kind: "add", input };
    }
  } else if (flag === "list-apps") {
    command = { kind: "list" };
  } else if (flag === "discover-apps") {
    command = { kind: "discover" };
  } else if (flag === "enable-candidate") {
    if (!value) return "--enable-candidate needs the candidate's reference.";
    command = { kind: "enable-candidate", candidate: value };
  } else {
    if (!value) return `--${flag} needs the app's name or reference.`;
    command = {
      kind: flag.replace("-app", "") as "remove" | "test" | "enable" | "disable",
      target: value,
    };
  }
  return { command, dataDir: paths.dataDir };
}

/** The app `--add-app` was given, as JSON text, or the sentence that says what was wrong. */
function parseAppInput(text: string): AppInput | string {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return '--add-app needs the app as a JSON object, for example \'{"kind":"stdio","name":"笔记","command":"npx","args":["-y","some-mcp"],"env":{}}\'.';
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return "--add-app needs the app as a JSON object.";
  return input as AppInput;
}

/** All of stdin, as UTF-8 text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Every environment value hidden: what is printed is read on screen, and a key must not be. */
function maskedApp(app: AppEntry): AppEntry {
  if (app.kind !== "stdio") return app;
  return {
    ...app,
    env: Object.fromEntries(Object.keys(app.env).map((key) => [key, "••••"])),
  };
}

/** Carry out an app command and print one JSON line, as `runRootCommand` does. */
export async function runAppCommand(
  parsed: { command: AppCommand; dataDir: string },
  print: (line: string) => void = (line) => console.log(line),
  /** Where `--add-app -` reads the app from. Tests hand in their own. */
  stdin: () => Promise<string> = readStdin,
  /** What `--discover-apps` and `--enable-candidate` read instead of this machine. Tests hand in their own. */
  discoverDeps?: Partial<DiscoverDeps>,
): Promise<number> {
  const registry = createAppRegistry({ dataDir: parsed.dataDir });
  const apps = () => registry.list().map(maskedApp);
  try {
    let { command } = parsed;
    // --- app discovery (sub-project 3) ---
    if (command.kind === "discover") {
      const outcome = await createDiscoverActions({
        dataDir: parsed.dataDir,
        registry,
        ...(discoverDeps ? { deps: discoverDeps } : {}),
      })("apps.discover", {});
      print(
        JSON.stringify(
          outcome.ok
            ? { ok: true, ...(outcome.output as object) }
            : { ok: false, error: outcome.error },
        ),
      );
      return outcome.ok ? 0 : 2;
    }
    if (command.kind === "enable-candidate") {
      const host = createAppHost(registry);
      try {
        const outcome = await createDiscoverActions({
          dataDir: parsed.dataDir,
          registry,
          host,
          // Printed for the device window on this machine only: why it failed, in full.
          detailedErrors: true,
          ...(discoverDeps ? { deps: discoverDeps } : {}),
        })("apps.enable", { candidate: command.candidate });
        if (!outcome.ok) {
          print(JSON.stringify({ ok: false, error: outcome.error }));
          return 2;
        }
        const { app, tools } = outcome.output as {
          app: { ref: string; name: string };
          tools: { name: string }[];
        };
        print(
          JSON.stringify({
            ok: true,
            app,
            tools: tools.map((tool) => tool.name),
            apps: apps(),
          }),
        );
        return 0;
      } finally {
        await host.closeAll();
      }
    }
    // --- end app discovery ---
    if (command.kind === "add-stdin") {
      const input = parseAppInput(await stdin());
      if (typeof input === "string") {
        print(JSON.stringify({ ok: false, error: input }));
        return 2;
      }
      command = { kind: "add", input };
    }
    if (command.kind === "add") {
      const app = maskedApp(registry.add(command.input));
      print(JSON.stringify({ ok: true, app, apps: apps() }));
      return 0;
    }
    if (command.kind === "remove") {
      if (!registry.remove(command.target)) {
        print(JSON.stringify({ ok: false, error: "没有找到这个应用。" }));
        return 2;
      }
      print(JSON.stringify({ ok: true, apps: apps() }));
      return 0;
    }
    if (command.kind === "enable" || command.kind === "disable") {
      registry.setEnabled(command.target, command.kind === "enable");
      print(JSON.stringify({ ok: true, apps: apps() }));
      return 0;
    }
    if (command.kind === "test") {
      const app = APP_REF.test(command.target)
        ? registry.byRef(command.target)
        : registry.byName(command.target);
      if (!app) {
        print(JSON.stringify({ ok: false, error: "没有找到这个应用。" }));
        return 2;
      }
      const host = createAppHost(registry);
      try {
        const tools = await host.tools(app.ref);
        print(
          JSON.stringify({
            ok: true,
            tools: tools.map((tool) => tool.name),
            count: tools.length,
          }),
        );
        return 0;
      } finally {
        await host.closeAll();
      }
    }
    print(JSON.stringify({ ok: true, apps: apps() }));
    return 0;
  } catch (error) {
    print(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : "操作没有成功。",
      }),
    );
    return 2;
  }
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Options | string {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry?.startsWith("--")) return `Unknown argument: ${entry ?? ""}`;
    args.set(entry.slice(2), argv[index + 1] ?? "");
    index += 1;
  }
  if (args.has("help")) return usage();
  const server = args.get("server") ?? "";
  if (!/^https?:\/\//.test(server)) {
    return "Pass --server with the http(s) address of your deployment.";
  }
  const interval = Number(args.get("interval") ?? DEFAULT_INTERVAL_MS / 1000);
  if (!Number.isFinite(interval) || interval < 5) {
    return "--interval must be at least 5 seconds.";
  }
  const paths = runnerPaths(args, env, cwd);
  if (typeof paths === "string") return paths;
  const browser = browserOptions(args, paths);
  if (typeof browser === "string") return browser;
  return {
    server: server.replace(/\/+$/, ""),
    name: (args.get("name") || hostname()).slice(0, 120),
    ...(args.get("pair") ? { pair: args.get("pair") as string } : {}),
    paths,
    intervalMs: interval * 1000,
    browser,
  };
}

async function pair(options: Options, deviceId: string): Promise<string> {
  const response = await fetch(`${options.server}/api/runner/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: options.pair,
      deviceId,
      name: options.name,
      platform: platform(),
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    token?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.token) {
    throw new Error(
      body?.error ??
        `The deployment refused the pairing (HTTP ${response.status}).`,
    );
  }
  return body.token;
}

/**
 * A heartbeat, and the folders this machine offers: their references and names, never their paths.
 *
 * Carried on every beat rather than once, so a folder added or removed with `--add-root` while this
 * runs reaches the owner's screen within one interval, without a restart.
 */
export function heartbeatFrame(
  roots: Pick<RootRegistry, "reported">,
  apps?: Pick<ReturnType<typeof createAppRegistry>, "reported">,
): string {
  return JSON.stringify({
    type: "heartbeat",
    roots: roots.reported(),
    ...(apps ? { apps: apps.reported() } : {}),
  });
}

/**
 * One connection's life, resolved when the socket closes.
 *
 * Heartbeats on a timer, and a beat is also the way this finds out the socket has gone away quietly:
 * a write to a dead socket throws, and the throw closes the connection so the outer loop can dial
 * again. Reconnecting is the normal case, not the failure — a laptop sleeping does that to any
 * long-lived connection it owns.
 */
function connect(
  options: Options,
  token: string,
  deviceId: string,
  dispatch: ReturnType<typeof createRunnerDispatcher>,
  browser: RunnerBrowser,
  roots: RootRegistry,
  apps: ReturnType<typeof createAppRegistry>,
): Promise<void> {
  return new Promise((resolve) => {
    const url = `${options.server.replace(/^http/, "ws")}/api/runner/ws?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    let beat: ReturnType<typeof setInterval> | undefined;
    let open = false;
    /*
     * The live screen, per connection: it rides this socket and dies with it. The server starts it
     * again on the next connection for whoever is still watching, so nothing is cast to a socket that
     * is gone.
     */
    const screens = createRunnerScreens({
      source: browser,
      send: (frame) => socket.send(JSON.stringify(frame)),
      buffered: () => socket.bufferedAmount,
    });

    const stop = () => {
      if (beat) clearInterval(beat);
      void screens.stopAll();
      // Said once per connection that was up. A desktop shell reads these lines for its tray
      // (desktop-device/src-tauri/src/supervise.rs `classify`): without it, a dropped connection would
      // look online until the next dial failed, which can be half a minute away.
      if (open) {
        open = false;
        console.log("runner: disconnected");
      }
      try {
        if (socket.readyState === WebSocket.OPEN) socket.close();
      } catch {
        // Already gone, which is what closing means.
      }
      resolve();
    };

    socket.addEventListener("open", () => {
      open = true;
      console.log(`runner: connected as ${deviceId}`);
      socket.send(heartbeatFrame(roots, apps));
      beat = setInterval(() => {
        try {
          socket.send(heartbeatFrame(roots, apps));
        } catch {
          stop();
        }
      }, options.intervalMs);
    });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      void handleFrame(
        socket,
        text,
        dispatch,
        `${options.server}/${deviceId}`,
        screens,
      );
    });
    socket.addEventListener("close", stop);
    socket.addEventListener("error", () => {
      // Reported as a closed connection rather than a stack: with no server to name, the useful part
      // is that this run will try again.
      console.log("runner: the connection failed; retrying in a moment");
    });
  });
}

/**
 * Run the runner until it is stopped.
 *
 * `credentialsAt` is the seam a desktop shell replaces: it is handed the state file path this run
 * would use and answers with the store to keep the token in. The default is the 0600 file.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  credentialsAt: (
    stateFile: string,
  ) => CredentialStore = createFileCredentialStore,
): Promise<number> {
  const rootCommand = parseRootCommand(argv);
  if (typeof rootCommand === "string") {
    console.error(rootCommand);
    return 2;
  }
  if (rootCommand) return runRootCommand(rootCommand);
  const appCommand = parseAppCommand(argv);
  if (typeof appCommand === "string") {
    console.error(appCommand);
    return 2;
  }
  if (appCommand) return runAppCommand(appCommand);
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 2;
  }
  const { paths } = parsed;
  if (paths.explicitDataDir) {
    // Private by default, like the token inside it. An existing directory keeps the mode it has.
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  }
  const credentials = credentialsAt(paths.stateFile);
  const stored = await credentials.load();
  const deviceId = deviceIdFor(stored);

  let token = stored?.token ?? "";
  if (parsed.pair) {
    token = await pair(parsed, deviceId);
    await credentials.save({ deviceId, token, server: parsed.server });
    console.log(`runner: paired as ${deviceId}`);
  } else if (!token) {
    console.error(
      "runner: no device token yet. Ask for a pairing code on the Devices screen, then run with --pair CODE.",
    );
    return 2;
  } else if (stored && stored.server !== parsed.server) {
    console.error(
      `runner: this machine is already paired to ${stored.server}. Remove it on that deployment's Devices screen before pointing it somewhere else.`,
    );
    return 2;
  }

  // Made now rather than by the first command: listing the files of a machine that was just paired
  // is an empty folder, not an error about a folder that does not exist yet.
  mkdirSync(paths.workspaceDir, { recursive: true });

  /*
   * Built after the arguments are known, and held for the shutdown handler.
   *
   * It used to be a module-level constant, which was fine while it could only ever be handed a
   * workspace directory. Now it can also be given a browser profile root, and building it at module
   * scope would read those settings before `parseArgs` had run: the runner would make a profile
   * directory for the default path and then be told to use another one, leaving a coworker's cookies
   * in a folder nothing was looking at.
   */
  const browser = createRunnerBrowser(parsed.browser);
  // The owner's read-only folders. Never over the runner's own files: see roots.ts.
  const roots = createRootRegistry({
    dataDir: paths.dataDir,
    privatePaths: runnerPrivatePaths(paths, parsed.browser.profileRoot),
  });
  // The owner's local MCP apps: registered with --add-app, started only when a call needs one.
  const apps = createAppRegistry({ dataDir: paths.dataDir });
  // One host for the executor and for discovery, so an app is never started twice.
  const appHost = createAppHost(apps);
  const executor = createRunnerExecutor(
    paths.workspaceDir,
    browser,
    roots,
    undefined,
    appHost,
    // --- app discovery (sub-project 3) ---
    {
      discovery: createDiscoverActions({
        dataDir: paths.dataDir,
        registry: apps,
        host: appHost,
      }),
    },
    // --- end app discovery ---
  );
  running = executor;

  // Backoff between dials, capped: a deployment that is down should cost one request every half
  // minute, not one per second for a day.
  const journal = createActionJournal(paths.journalFile);
  const dispatch = createRunnerDispatcher(journal, executor);
  let delay = 1_000;
  for (;;) {
    await connect(parsed, token, deviceId, dispatch, browser, roots, apps);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

/** How long a browser is given to write its profile before a Ctrl-C stops waiting for it. */
const SHUTDOWN_BUDGET_MS = 8_000;

let running: RunnerExecutor | undefined;
let stopping = false;

/**
 * Hand every browser back, then leave.
 *
 * Chromium batches its cookie writes and commits them as it exits, so a SIGKILL a second after a
 * Ctrl-C is how a person closing a terminal ends up signed out of everything. The budget is what keeps
 * a browser that has stopped answering from turning that Ctrl-C into a hung terminal.
 *
 * SIGTERM as well as SIGINT: a laptop stops this with Ctrl-C, and a service manager on Linux sends
 * SIGTERM. Both mean the same thing here — finish, then go.
 */
async function shutDown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(
    `runner: ${reason}; closing any open browser so it can save its state`,
  );
  const budget = new Promise((wait) => setTimeout(wait, SHUTDOWN_BUDGET_MS));
  try {
    await Promise.race([
      // allSettled: a browser that fails to close must not stop the apps' process trees being killed.
      Promise.allSettled([
        running?.closeBrowser() ?? Promise.resolve(),
        running?.closeApps() ?? Promise.resolve(),
        // --- desktop control (sub-project 2) ---
        running?.closeDesktop() ?? Promise.resolve(),
        // --- end desktop control ---
      ]),
      budget,
    ]);
  } catch {
    // Best effort. A browser that would not close is not a reason to stay alive.
  }
  process.exit(0);
}

/**
 * One frame from the deployment: a heartbeat answer, or work it has already decided to allow.
 *
 * The answer goes back with the same id it arrived with and nothing else attached — no session, no
 * token — because the socket it travels on is the credential.
 */
async function handleFrame(
  socket: WebSocket,
  text: string,
  dispatch: ReturnType<typeof createRunnerDispatcher>,
  scope: string,
  screens: ReturnType<typeof createRunnerScreens>,
): Promise<void> {
  let frame: {
    type?: unknown;
    id?: unknown;
    key?: unknown;
    action?: unknown;
    payload?: unknown;
  };
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
  if (frame?.type === "error") {
    console.log(`runner: the deployment said ${JSON.stringify(frame)}`);
    return;
  }
  // The live screen is not an action: nothing is journalled, and nothing is answered with a result.
  if (await screens.handle(frame as Record<string, unknown>).catch(() => true))
    return;
  try {
    await dispatch(scope, frame as Record<string, unknown>, (result) =>
      socket.send(JSON.stringify(result)),
    );
  } catch {
    // The socket died mid-action. The server's own deadline settles the request.
    console.log(
      `runner: lost the connection while running ${String(frame.action)}`,
    );
  }
}

/*
 * Started, not imported. A test reads `parseArgs` without dialling anything, and the compiled binary
 * (`bun build --compile`) reports itself as the main module the same way `bun src/index.ts` does.
 */
if (import.meta.main) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutDown(signal);
    });
  }
  process.exit(await main());
}
