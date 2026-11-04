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
import { createRunnerBrowser } from "./browser";
import {
  type CredentialStore,
  createFileCredentialStore,
  deviceIdFor,
} from "./credentials";
import { createRunnerDispatcher } from "./dispatch";
import {
  browserProfileRootFor,
  createRunnerExecutor,
  type RunnerExecutor,
} from "./execute";
import { createActionJournal } from "./journal";

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
): Promise<void> {
  return new Promise((resolve) => {
    const url = `${options.server.replace(/^http/, "ws")}/api/runner/ws?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    let beat: ReturnType<typeof setInterval> | undefined;
    let open = false;

    const stop = () => {
      if (beat) clearInterval(beat);
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
      socket.send(JSON.stringify({ type: "heartbeat" }));
      beat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "heartbeat" }));
        } catch {
          stop();
        }
      }, options.intervalMs);
    });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      void handleFrame(socket, text, dispatch, `${options.server}/${deviceId}`);
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
  const executor = createRunnerExecutor(
    paths.workspaceDir,
    createRunnerBrowser(parsed.browser),
  );
  running = executor;

  // Backoff between dials, capped: a deployment that is down should cost one request every half
  // minute, not one per second for a day.
  const journal = createActionJournal(paths.journalFile);
  const dispatch = createRunnerDispatcher(journal, executor);
  let delay = 1_000;
  for (;;) {
    await connect(parsed, token, deviceId, dispatch);
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
    await Promise.race([running?.closeBrowser() ?? Promise.resolve(), budget]);
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
