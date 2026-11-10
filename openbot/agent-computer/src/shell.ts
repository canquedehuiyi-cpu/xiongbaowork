import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { win32 } from "node:path";
import { egressShellEnvironment, splitProxyCredentials } from "./egress";
import { createLiveShell, type LiveShell } from "./live-shell";
import { readableOutput } from "./shell-marks";

/**
 * Running a command on the Bot's computer.
 *
 * WHY THIS EXISTS. A browser answers questions about the web; a shell answers everything else. A Bot
 * that can install a tool and run it is a Bot that can do the task rather than describe it.
 *
 * WHAT MAKES IT SAFE IS NOT THIS FILE. Nothing here decides whether a command may run. The gateway
 * decides, against the deployment's policy, and writes the audit row before this is called at all,
 * the same as it does for a click. This file is the hands, not the judgement.
 *
 * WHAT THIS DOES DEFEND is the shape of the call rather than its content: a command cannot run
 * forever, cannot return unbounded output, runs in the workspace rather than wherever the process
 * happens to be, and does not inherit the computer's environment, so `env` cannot print the
 * deployment's secrets.
 *
 * ISOLATION IS THE CONTAINER'S JOB. A shell can reach whatever the container can reach, so the
 * deployment that gives a Bot one should give each Bot a computer of its own. In a container shared
 * between Bots, a shell is shared too.
 */

/** Long enough for an install, short enough that a hung command is not a hung Bot. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** A command has to be given long enough to start. Below this, a caller is asking for nothing. */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * How much output comes back.
 *
 * A build log is megabytes and the model that reads this has a context window. Truncated at a size
 * a person can still read, and the result says it was truncated rather than quietly ending.
 */
const MAX_OUTPUT_BYTES = 64 * 1024;

export type ShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
  /** Stopped by a person (the signal was aborted) rather than finishing or timing out. */
  stopped?: boolean;
  /** Never typed: the shell was busy with something a person started. */
  notRun?: boolean;
};

/**
 * The environment a command sees.
 *
 * WHY AN ALLOW LIST. The computer process holds the deployment's secrets when it runs inside the
 * one-container image. Spreading `process.env` into the child makes `env` print them. A deny list
 * is the secrets that existed on the day it was written; the next variable added to a deployment
 * is not on it.
 *
 * PATH, locale, terminal and the proxy variables pass because a command that cannot find `apt-get`,
 * cannot speak the operator's language, or cannot reach the network behind a corporate proxy is not
 * a shell. Proxy URLs routinely carry a password; userinfo is stripped before the value is copied, so
 * `env` cannot print it. Naming the credentialed URL in COMPUTER_SHELL_ENV is an operator's decision
 * rather than the default. Everything else is named there too, read as names.
 *
 * HOME is the workspace. A command that writes to ~ should write where the Bot's files already are.
 */
const PATH_NAMES = ["PATH"] as const;
const LOCALE_NAMES = ["LANG", "LANGUAGE"] as const;
const TERMINAL_NAMES = ["TERM", "TERMINFO", "COLORTERM"] as const;
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "ftp_proxy",
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCALE_CATEGORY = /^LC_[A-Za-z0-9_]+$/;

export function environmentForCommand(
  source: NodeJS.ProcessEnv,
  workspaceDir: string,
  platform: string = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};

  const copy = (name: string) => {
    const actual =
      platform === "win32"
        ? Object.keys(source).find(
            (key) => key.toUpperCase() === name.toUpperCase(),
          )
        : name;
    const value = actual === undefined ? undefined : source[actual];
    if (value !== undefined) env[name] = value;
  };

  const copyProxy = (name: string) => {
    const value = source[name];
    if (value !== undefined) env[name] = withoutUserinfo(value);
  };

  for (const name of PATH_NAMES) copy(name);
  for (const name of LOCALE_NAMES) copy(name);
  for (const name of Object.keys(source)) {
    if (LOCALE_CATEGORY.test(name)) copy(name);
  }
  for (const name of TERMINAL_NAMES) copy(name);
  for (const name of PROXY_NAMES) copyProxy(name);
  for (const name of extraShellEnvNames(source.COMPUTER_SHELL_ENV)) copy(name);

  env.HOME = workspaceDir;
  if (platform === "win32") {
    for (const name of [
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "TEMP",
      "TMP",
      /*
       * Which machine and account this is, and where programs are installed: none of them is a
       * credential, and without them `$env:COMPUTERNAME` is empty and tools that find themselves
       * through `ProgramFiles` fail. Found on the first real paired Windows machine (2026-11-06),
       * where a 分身 asked for the machine name and got nothing. The user's own profile folders
       * (APPDATA, LOCALAPPDATA) stay out: USERPROFILE is the workspace on purpose.
       */
      "COMPUTERNAME",
      "USERNAME",
      "USERDOMAIN",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "CommonProgramFiles",
      "ProgramData",
    ])
      copy(name);
    env.USERPROFILE = workspaceDir;
  }
  /*
   * Set rather than copied, because the deployment has no opinion about it and the command does. The
   * tool description tells the model to run `apt-get install`, which without this waits for an answer
   * to a prompt nobody is there to give: the command reaches its timeout and comes back looking like
   * a broken package rather than a question. An operator can still override it through
   * COMPUTER_SHELL_ENV, which is copied above.
   */
  if (env.DEBIAN_FRONTEND === undefined) env.DEBIAN_FRONTEND = "noninteractive";
  return env;
}

/**
 * Names COMPUTER_SHELL_ENV will not pass, whatever an operator writes.
 *
 * The rest of that setting is a decision an operator is entitled to make: naming `GITHUB_TOKEN` says
 * this Bot may use that token, and they meant it. These are different in kind. They do not give a
 * command information, they give it a hook that runs before every later command, which is the
 * `.bash_profile` hole arriving through the front door.
 *
 * `BASH_ENV` is the one that survives `-c`: bash expands it for a non-interactive shell and sources
 * the file it names, before the command. `ENV` is its POSIX-mode twin, `BASH_XTRACEFD` writes where
 * it is told, `LD_PRELOAD` and `LD_LIBRARY_PATH` are the same idea one layer down, and the option
 * variables change how the shell parses what follows.
 *
 * Refused rather than dropped quietly, because an operator who wrote one of these has a reason in
 * mind and deserves to be told it did not happen.
 */
const NEVER_PASSED = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_XTRACEFD",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PS4",
]);

function extraShellEnvNames(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const named = raw.split(",").map((name) => name.trim());

  /*
   * A name that is not a name, and a name that is refused, are both worth saying out loud. Silently
   * skipping either leaves an operator with a command that fails somewhere else for a reason that
   * never mentions what they wrote.
   */
  for (const name of named) {
    if (name === "") continue;
    if (!ENV_NAME.test(name)) {
      console.warn(
        JSON.stringify({
          type: "computer-shell-env-ignored",
          name,
          reason: "not a variable name",
        }),
      );
      continue;
    }
    if (NEVER_PASSED.has(name)) {
      console.warn(
        JSON.stringify({
          type: "computer-shell-env-refused",
          name,
          reason:
            "runs before every command rather than informing one, so it is never passed",
        }),
      );
    }
  }

  return named.filter((name) => ENV_NAME.test(name) && !NEVER_PASSED.has(name));
}

/**
 * Credentials commonly arrive inside a proxy URL. They are stripped so the shell can still reach
 * the network without `env` printing a password. Same split `egress.ts` uses for the browser proxy.
 */
function withoutUserinfo(raw: string): string {
  const { server, username, password } = splitProxyCredentials(raw);
  if (username === undefined && password === undefined) return raw;
  return server;
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  // Kept from the end. A command that fails says why in its last lines, and the first 64KB of a
  // build log is the part nobody needs.
  const kept = Buffer.from(text, "utf8")
    .subarray(-MAX_OUTPUT_BYTES)
    .toString("utf8");
  return { text: kept, truncated: true };
}

/** How the root helper is reached. `-n`: never a password prompt nobody is there to answer. */
const DEFAULT_RUN_AS_LAUNCHER = ["sudo", "-n", "/usr/local/sbin/xb-bot"];

/**
 * Names the employee's own user gets from the helper rather than from here.
 *
 * HOME and TMPDIR are the employee's directory and its `.tmp`, which the helper sets; USER, LOGNAME
 * and SHELL describe the account, and passing this process's values would describe pwuser.
 */
const SET_BY_HELPER = new Set(["HOME", "TMPDIR", "USER", "LOGNAME", "SHELL"]);

/**
 * How long, after a timeout or a Stop, before the request stops waiting for the helper.
 *
 * The command runs as another user, under GNU timeout in a process group of its own, so nothing this
 * process may signal reaches it: the SIGTERM goes to sudo, sudo relays it to the helper, and the
 * helper ends the command's group (a SIGTERM, three seconds, a SIGKILL). This is the bound on the
 * case where that chain is broken, so a request cannot wait for ever on a pipe nobody closes.
 */
const RUN_AS_GIVE_UP_MS = 15_000;

/**
 * How long the output may keep arriving after the helper has exited.
 *
 * The helper ends what the command left in its group, so the pipes normally close with it. Something
 * that left the group (a `setsid` daemon) can hold them open for ever, and this process may not end
 * it. Whatever the command wrote before it exited is already in the pipe; this is time to read it.
 */
const RUN_AS_DRAIN_MS = 1_000;

/** The hash part of `xb-<key>`; anything else never reaches the helper's argv. */
const RUN_AS_KEY = /^[0-9a-f]{12}$/;

/**
 * The environment the helper is given: the command's, without what the helper sets itself, and
 * without a value that cannot be one line (a newline, or a NUL, which no environment can carry).
 */
function runAsEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        ENV_NAME.test(name) &&
        !SET_BY_HELPER.has(name) &&
        !value.includes("\n") &&
        !value.includes("\0"),
    ),
  );
}

/**
 * What the helper reads on stdin: `NAME=VALUE` lines, an empty line, then the command exactly as
 * written.
 */
function runAsInput(env: Record<string, string>, command: string): string {
  const lines = Object.entries(env).map(
    ([name, value]) => `${name}=${value}\n`,
  );
  return `${lines.join("")}\n${command}`;
}

export type RunAs = {
  /** The employee's botKey: twelve hex digits, the hash part of its user name `xb-<key>`. */
  key: string;
  /** What is spawned before `run <key> <timeout_s>`. Defaults to `sudo -n /usr/local/sbin/xb-bot`. */
  launcher?: string[];
};

/** The command a caller hands a shell, and the Stop that ends it. */
export type CommandInput = {
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ShellOptions = {
  /** The bash the live shell starts, where it is not the one on PATH. */
  bash?: string;
  /** Each command in a shell of its own (`runOnce`) instead of the live one. */
  oneShot?: boolean;
  /** Run each command as an employee's own Linux user, through the root helper. See below. */
  runAs?: RunAs;
};

/**
 * A shell that only runs commands: no live terminal behind it.
 *
 * What `createShell` gives for an employee's own user (`runAs`). The live shell (live-shell.ts) is
 * one bash in a pseudo-terminal that this process starts, so it runs as this process's user, pwuser,
 * and the root helper's `run` takes a command and its environment on stdin rather than a terminal.
 * An employee's live terminal made that way would be pwuser's bash in the employee's directory: every
 * other employee's files, the browser profiles, and `sudo openbot-apt`. So its commands run one at a
 * time through the helper, and the terminal a person watches is a separate bash the helper starts as
 * the employee (`xb-bot shell`, index.ts `ownUserTerminal`), into which the employee's own commands
 * are not typed.
 */
export type CommandShell = {
  run(input: CommandInput): Promise<ShellResult>;
  /** Never set: the employee's commands are not typed into a terminal; see `ownUserTerminal`. */
  terminal?: undefined;
  dispose(): void;
};

/**
 * A shell for one workspace.
 *
 * Without `runAs`, the Bot's commands are typed into one live shell (live-shell.ts), or with
 * `oneShot` each runs in a shell of its own.
 *
 * With `runAs`, the command runs as the employee's own Linux user rather than this process's: it is
 * handed to the root helper as `run <key> <timeout_s>` with the environment and the command on stdin,
 * never in argv. Always one shell per command, and no live terminal (`CommandShell`), whatever
 * `oneShot` says.
 */
export function createShell(
  workspaceDir: string,
  sourceEnv: NodeJS.ProcessEnv,
  options: ShellOptions & { runAs: RunAs },
): CommandShell;
export function createShell(
  workspaceDir: string,
  sourceEnv?: NodeJS.ProcessEnv,
  options?: ShellOptions & { runAs?: undefined },
): LiveBackedShell;
export function createShell(
  workspaceDir: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  options: ShellOptions = {},
): CommandShell | LiveBackedShell {
  const runAs = options.runAs;
  if (runAs) {
    // Checked here as well as by the helper, so a caller with the wrong idea of a key finds out at once.
    if (!RUN_AS_KEY.test(runAs.key)) {
      throw new Error(
        "An employee's key must be twelve lowercase hexadecimal digits.",
      );
    }
    const launcher = runAs.launcher ?? DEFAULT_RUN_AS_LAUNCHER;
    return {
      async run(input: CommandInput): Promise<ShellResult> {
        const started = Date.now();
        if (input.signal?.aborted) return stoppedBeforeStart(input, started);
        await mkdir(workspaceDir, { recursive: true });
        return runOnce({
          command: input.command,
          signal: input.signal,
          workspaceDir,
          sourceEnv,
          started,
          timeoutMs: commandTimeoutMs(input.timeoutMs),
          runAs: { key: runAs.key, launcher },
        });
      },
      dispose() {},
    };
  }

  /*
   * A command in a shell of its own (`runOnce`) instead of the live one: always on Windows, where
   * there is no pseudo-terminal bash, and wherever the caller asks for it. The device runner on a
   * person's own machine asks, because a Mac's own bash is too old for the live shell.
   */
  const oneShot = options.oneShot ?? process.platform === "win32";
  /*
   * One live shell for this Bot, which its commands are typed into and a person can watch and take
   * over (live-shell.ts). It used to be a fresh `bash -c` for each command.
   *
   * The shell is interactive now, and still never reads a startup file from the workspace: it starts
   * with one the computer writes elsewhere, because HOME is the workspace and a Bot writes files
   * there. A `.bash_profile` or `.bashrc` it left behind would otherwise run before every later
   * command while the audit row recorded only what was asked for. The allow-list above means such a
   * file can no longer recover a secret, but it could still change what a command does.
   *
   * The environment is built when a shell starts, with the egress filter's address last, so a command
   * cannot be pointed around it.
   */
  const live = createLiveShell({
    cwd: workspaceDir,
    env: () => ({
      ...environmentForCommand(sourceEnv, workspaceDir),
      ...egressShellEnvironment(),
    }),
    ...(options.bash ? { bash: options.bash } : {}),
  });

  return {
    async run(input: CommandInput): Promise<ShellResult> {
      const started = Date.now();
      if (input.signal?.aborted) return stoppedBeforeStart(input, started);
      await mkdir(workspaceDir, { recursive: true });
      const timeoutMs = commandTimeoutMs(input.timeoutMs);

      /*
       * Through a shell on purpose. A Bot writes `apt-get install -y jq && jq --version`, and pipes,
       * redirection and `&&` are most of why a shell is useful. Refusing them would leave something
       * that runs one binary and calls itself a shell.
       *
       * This is the argument for the container boundary rather than for string parsing: there is no
       * safe way to read a command's intent from its text, so nothing here tries. The policy decides
       * whether this Bot may run commands at all and what they may say; the container decides what a
       * command can reach.
       *
       * The deadline starts now, not when the command is typed: a command waiting behind another of
       * the Bot's own is still inside the time it was given.
       *
       * The person's Stop reaches the command too: the shell presses Ctrl-C for it, then stops its
       * process group, then the shell, so nothing the command started outlives it.
       */
      if (oneShot)
        return runOnce({
          command: input.command,
          signal: input.signal,
          workspaceDir,
          sourceEnv,
          started,
          timeoutMs,
        });

      const outcome = await live.run({
        command: input.command,
        deadline: started + timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      /*
       * One stream, because a terminal has one: stdout and stderr arrive interleaved, as a person
       * watching sees them, so they come back as `stdout`.
       */
      const text = outcome.busy
        ? ""
        : readableOutput(outcome.raw) +
          (outcome.incomplete ? INCOMPLETE_COMMAND : "");
      const out = clamp(text);
      return {
        command: input.command,
        exitCode: outcome.exitCode,
        stdout: out.text,
        stderr: outcome.busy ? SHELL_BUSY : "",
        // Either point it was cut: while arriving, or on the way out.
        truncated: out.truncated || outcome.dropped,
        timedOut: outcome.timedOut,
        // The device runner reports a person's Stop as such rather than as a failed command.
        ...(outcome.stopped || input.signal?.aborted ? { stopped: true } : {}),
        elapsedMs: Date.now() - started,
        ...(outcome.busy ? { notRun: true } : {}),
      };
    },
    /** What a person watching or driving the shell reaches. See live-shell.ts. */
    terminal: live,
    /** End this shell for good. */
    dispose: () => live.dispose(),
  };
}

/** A shell with a live terminal behind it: every Bot's but an employee's own user's. */
export type LiveBackedShell = {
  run(input: CommandInput): Promise<ShellResult>;
  terminal: LiveShell;
  dispose(): void;
};

function stoppedBeforeStart(input: CommandInput, started: number): ShellResult {
  return {
    command: input.command,
    exitCode: -1,
    stdout: "",
    stderr: "The command was stopped before it started.",
    truncated: false,
    timedOut: false,
    stopped: true,
    elapsedMs: Date.now() - started,
  };
}

/*
 * Bounded at both ends. Only `Math.min` was applied, so a zero or negative `timeoutMs` from a caller
 * made the timer fire immediately: the command was killed before it did anything and the answer said
 * it had timed out, which is true and useless.
 *
 * A non-finite value is the same failure one step earlier: `Math.max(NaN, 1000)` is `NaN`. The HTTP
 * layer rejects those with a 400, so this is defence in depth for a direct caller — fall back to the
 * default rather than run a command that is already out of time.
 */
function commandTimeoutMs(timeoutMs: number | undefined): number {
  const requested =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * One command in a shell of its own, which ends with it: PowerShell on Windows, `bash -c` elsewhere,
 * or, with `runAs`, the root helper running it as an employee's own user.
 *
 * The live shell (live-shell.ts) needs a pseudo-terminal and bash 4.4 or newer, which a person's
 * Windows machine does not have and a Mac's own `/bin/bash` (3.2) is not. The device runner on such a
 * machine runs each command this way, as every command ran before the live shell. So does every
 * employee with its own user, which the live shell cannot be.
 */
async function runOnce(input: {
  command: string;
  signal: AbortSignal | undefined;
  workspaceDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  started: number;
  timeoutMs: number;
  runAs?: { key: string; launcher: string[] };
}): Promise<ShellResult> {
  const { workspaceDir, sourceEnv, started, timeoutMs, runAs } = input;
  /*
   * `-c`, not `-lc`. A login shell sources `$HOME/.bash_profile`, and HOME is the workspace a Bot
   * writes with `computer_write_file`. That let a Bot leave a file which every later command ran
   * first: it could put its own `apt-get` earlier on PATH, and the audit row would still read
   * `apt-get --version`. A permissive shell is a decision a deployment can make. A trail that
   * describes something other than what ran is not.
   *
   * Its own process group, so stopping it stops what it started. `child.kill` signals bash alone.
   * `bash -c "sleep 600 | cat"` leaves the sleep and the cat holding the inherited pipes, so `close`
   * never fires and the await never settles. Killing the negative pid signals the whole group.
   */
  // The egress filter's address last, so a command cannot be pointed around it.
  const fullEnv = {
    ...environmentForCommand(sourceEnv, workspaceDir),
    ...egressShellEnvironment(),
  };
  // sudo resets its own environment; the helper is given the same map on stdin.
  const commandEnv = runAs ? runAsEnvironment(fullEnv) : fullEnv;
  const shell = runAs
    ? {
        executable: runAs.launcher[0] ?? DEFAULT_RUN_AS_LAUNCHER[0],
        args: [
          ...runAs.launcher.slice(1),
          "run",
          runAs.key,
          String(Math.ceil(timeoutMs / 1000)),
        ],
      }
    : commandShell(input.command, process.platform, sourceEnv);
  const windows = process.platform === "win32" && !runAs;
  const codePage = windows
    ? await windowsCodePage(shell.executable)
    : undefined;
  const child = spawn(shell.executable, shell.args, {
    cwd: workspaceDir,
    env: commandEnv,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (runAs) {
    // A helper that refused before reading all of it closes the pipe; that is its exit code's story.
    child.stdin?.on("error", () => {});
    child.stdin?.end(runAsInput(commandEnv, input.command));
  }

  let timedOut = false;

  /*
   * Trimmed while it arrives, not at the end, and carrying the fact that it happened: output that
   * quietly ends is output a model reads as the whole answer.
   */
  const collect = () => {
    let text = "";
    let dropped = false;
    return {
      add(chunk: unknown) {
        text += String(chunk);
        if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES * 2) return;
        text = Buffer.from(text, "utf8")
          .subarray(-MAX_OUTPUT_BYTES)
          .toString("utf8");
        dropped = true;
      },
      get text() {
        return text;
      },
      get dropped() {
        return dropped;
      },
    };
  };

  const outBuffer = collect();
  const errBuffer = collect();
  const outDecoder = windows ? windowsOutputDecoder(codePage) : undefined;
  const errDecoder = windows ? windowsOutputDecoder(codePage) : undefined;

  child.stdout.on("data", (chunk) => {
    outBuffer.add(outDecoder ? outDecoder.write(chunk) : chunk);
  });
  child.stderr.on("data", (chunk) => {
    errBuffer.add(errDecoder ? errDecoder.write(chunk) : chunk);
  });

  let failStop: (error: Error) => void = () => {};
  const stopFailure = new Promise<never>((_, reject) => {
    failStop = reject;
  });
  let stopping: Promise<void> | undefined;
  /*
   * Running as the employee, the request ends on one of three things: the pipes closing, which is
   * the ordinary end; the output having drained after the helper exited; or giving up on a helper
   * that did not end after a timeout or a Stop. The last two stop reading rather than wait.
   */
  let stopRequested = false;
  let finished = false;
  let exitedWith: number | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  let abandon: () => void = () => {};
  const abandoned = new Promise<number>((resolve) => {
    abandon = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(exitedWith ?? -1);
    };
  });
  if (runAs) {
    child.once("exit", (code) => {
      exitedWith = code ?? -1;
      if (!finished) drainTimer = setTimeout(abandon, RUN_AS_DRAIN_MS);
    });
  }
  const stop = () => {
    const { pid } = child;
    if (pid === undefined) return;
    if (stopping) return;
    if (runAs) {
      /*
       * To sudo alone, which relays it to the helper; the helper ends the command's group. The
       * group is not signalled from here: it is another user's, under a process group of its own.
       */
      if (stopRequested) return;
      stopRequested = true;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Gone already, or EPERM: the deadline below still ends the request.
      }
      giveUpTimer = setTimeout(abandon, RUN_AS_GIVE_UP_MS);
      return;
    }
    if (process.platform === "win32") {
      stopping = new Promise<void>((resolve, reject) => {
        const systemRoot =
          sourceEnv.SystemRoot ?? sourceEnv.SYSTEMROOT ?? "C:\\Windows";
        const killer = spawn(
          win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
            env: environmentForCommand(sourceEnv, workspaceDir),
          },
        );
        killer.once("error", () =>
          reject(new Error("The command's process tree could not be stopped.")),
        );
        killer.once("close", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                "The command's process tree could not be confirmed stopped.",
              ),
            );
        });
      });
      // A failed tree kill must not leave the request waiting forever on inherited pipes.
      void stopping.catch((error: Error) => {
        child.kill();
        child.stdout.destroy();
        child.stderr.destroy();
        failStop(error);
      });
      return;
    }
    try {
      // The group, so nothing the command backgrounded outlives it.
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, or the group went with it. Either way there is nothing left to stop.
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);

  // The person's Stop reaches the command, not just the request that started it.
  const onAbort = stop;
  input.signal?.addEventListener("abort", onAbort, { once: true });
  // A listener added to an already-aborted signal never fires, so listening alone only honours a
  // Stop that arrives from here on. The abort can beat the spawn above: the surface aborts, the
  // server aborts the request it made to this computer, and Bun aborts this one in turn, which
  // happens before this line whenever the person was quick. Reading the flag is what makes the
  // Stop mean the same thing whenever it landed.
  if (input.signal?.aborted) stop();

  let exitCode: number;
  try {
    exitCode = await Promise.race([
      new Promise<number>((resolve, reject) => {
        child.on("close", (code) => resolve(code ?? -1));
        child.on("error", (error: NodeJS.ErrnoException) =>
          reject(
            new Error(
              `The command shell could not start (${error.code ?? "unknown error"}).`,
            ),
          ),
        );
      }),
      stopFailure,
      ...(runAs ? [abandoned] : []),
    ]);
    await stopping;
  } finally {
    finished = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    if (drainTimer) clearTimeout(drainTimer);
    if (giveUpTimer) clearTimeout(giveUpTimer);
  }

  if (outDecoder) outBuffer.add(outDecoder.end());
  if (errDecoder) errBuffer.add(errDecoder.end());
  const out = clamp(outBuffer.text);
  const err = clamp(
    windows ? plainPowerShellStderr(errBuffer.text) : errBuffer.text,
  );
  return {
    command: input.command,
    exitCode,
    stdout: out.text,
    stderr: err.text,
    // Either end of the pipe, and either point it was cut: while arriving, or on the way out.
    truncated:
      out.truncated || err.truncated || outBuffer.dropped || errBuffer.dropped,
    timedOut,
    ...(input.signal?.aborted ? { stopped: true } : {}),
    elapsedMs: Date.now() - started,
  };
}

/** Said when the shell was left waiting for the rest of a command the Bot sent. */
const INCOMPLETE_COMMAND =
  "\nbash: the command was incomplete (an unclosed quote, bracket or here-document), so it did not run.\n";

/** Said when a person left something running in the shell's foreground and handed it back. */
const SHELL_BUSY =
  "The command was not run: the shell is still running something a person started. Ask them to finish it.";

export type Shell = LiveBackedShell;

/** What runs a command and nothing more: a live-backed shell, or an employee's `CommandShell`. */
export type CommandRunner = {
  run(input: CommandInput): Promise<ShellResult>;
};

/** The upper half of the two Western OEM code pages, which have no `TextDecoder` label. */
const OEM_UPPER_HALF: Record<number, string> = {
  437: "\xc7\xfc\xe9\xe2\xe4\xe0\xe5\xe7\xea\xeb\xe8\xef\xee\xec\xc4\xc5\xc9\xe6\xc6\xf4\xf6\xf2\xfb\xf9\xff\xd6\xdc\xa2\xa3\xa5\u20a7\u0192\xe1\xed\xf3\xfa\xf1\xd1\xaa\xba\xbf\u2310\xac\xbd\xbc\xa1\xab\xbb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\xdf\u0393\u03c0\u03a3\u03c3\xb5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\xb1\u2265\u2264\u2320\u2321\xf7\u2248\xb0\u2219\xb7\u221a\u207f\xb2\u25a0\xa0",
  850: "\xc7\xfc\xe9\xe2\xe4\xe0\xe5\xe7\xea\xeb\xe8\xef\xee\xec\xc4\xc5\xc9\xe6\xc6\xf4\xf6\xf2\xfb\xf9\xff\xd6\xdc\xf8\xa3\xd8\xd7\u0192\xe1\xed\xf3\xfa\xf1\xd1\xaa\xba\xbf\xae\xac\xbd\xbc\xa1\xab\xbb\u2591\u2592\u2593\u2502\u2524\xc1\xc2\xc0\xa9\u2563\u2551\u2557\u255d\xa2\xa5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\xe3\xc3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\xa4\xf0\xd0\xca\xcb\xc8\u0131\xcd\xce\xcf\u2518\u250c\u2588\u2584\xa6\xcc\u2580\xd3\xdf\xd4\xd2\xf5\xd5\xb5\xfe\xde\xda\xdb\xd9\xfd\xdd\xaf\xb4\xad\xb1\u2017\xbe\xb6\xa7\xf7\xb8\xb0\xa8\xb7\xb9\xb3\xb2\u25a0\xa0",
};

const LEGACY_LABELS: Record<number, string> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  54936: "gb18030",
};

/** A decoder for one Windows code page, or `undefined` when this side knows none for it. */
function codePageDecoder(
  codePage: number | undefined,
): ((bytes: Uint8Array) => string) | undefined {
  if (codePage === undefined) return undefined;
  const upper = OEM_UPPER_HALF[codePage];
  if (upper)
    return (bytes) =>
      Array.from(bytes, (byte) =>
        byte < 0x80
          ? String.fromCharCode(byte)
          : (upper[byte - 0x80] ?? "\uFFFD"),
      ).join("");
  const label = LEGACY_LABELS[codePage];
  if (!label) return undefined;
  try {
    const decoder = new TextDecoder(label);
    return (bytes) => decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Bytes from a Windows command, decoded a line at a time.
 *
 * Two writers share the pipe. PowerShell writes its own text as UTF-8; a native program that is the
 * last step of the command (`hostname`, `ipconfig`, `ping`) writes straight into the pipe in the
 * machine's OEM code page, GBK on a Chinese Windows, and PowerShell never sees those bytes. A line
 * that is valid UTF-8 is read as UTF-8; any other is read in the machine's code page. GBK text that
 * also happens to be valid UTF-8 is rare, and a line that is neither still arrives, with U+FFFD.
 */
export function windowsOutputDecoder(codePage: number | undefined) {
  const legacy = codePageDecoder(codePage);
  const strict = new TextDecoder("utf-8", { fatal: true });
  const lenient = new TextDecoder("utf-8");
  let pending: Uint8Array = new Uint8Array(0);
  const line = (bytes: Uint8Array) => {
    try {
      return strict.decode(bytes);
    } catch {
      return legacy ? legacy(bytes) : lenient.decode(bytes);
    }
  };
  return {
    write(chunk: Uint8Array): string {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      const end = joined.lastIndexOf(0x0a);
      if (end === -1) {
        pending = joined;
        return "";
      }
      pending = joined.slice(end + 1);
      let text = "";
      let start = 0;
      for (let at = 0; at <= end; at += 1)
        if (joined[at] === 0x0a) {
          text += line(joined.subarray(start, at + 1));
          start = at + 1;
        }
      return text;
    },
    end(): string {
      const rest = pending;
      pending = new Uint8Array(0);
      return rest.length === 0 ? "" : line(rest);
    },
  };
}

let machineCodePage: Promise<number | undefined> | undefined;

/** Forget the remembered code page. For tests; nothing in the product calls it. */
export function resetWindowsCodePageCache(): void {
  machineCodePage = undefined;
}

/**
 * The machine's console code page, asked of PowerShell and remembered once it is known. A command's
 * console keeps it (nothing here changes it), so it is the code page native programs write in.
 *
 * Only an answer is remembered. A query that fails or times out (a cold runner can be slow to start
 * PowerShell) resolves `undefined` for the callers waiting on it, then is forgotten so the next
 * command asks again; remembering "unknown" would leave every later command decoding OEM bytes as
 * UTF-8.
 */
export function windowsCodePage(
  executable: string,
): Promise<number | undefined> {
  if (machineCodePage) return machineCodePage;
  const query: Promise<number | undefined> = new Promise((resolve) => {
    execFile(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding.CodePage",
      ],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout) => {
        const value = Number(String(stdout).trim());
        const codePage =
          !error && Number.isSafeInteger(value) && value > 0
            ? value
            : undefined;
        // Forget a failure, but only if it is still the remembered query (a reset may have replaced it).
        if (codePage === undefined && machineCodePage === query) {
          machineCodePage = undefined;
        }
        resolve(codePage);
      },
    );
  });
  machineCodePage = query;
  return query;
}

const CLIXML_HEADER = "#< CLIXML";

/** `_x000D_`-style escapes and the five XML entities, as PowerShell's serializer writes them. */
function decodeClixmlText(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * What Windows PowerShell wrote to a redirected stderr, as text a person or a model can read.
 *
 * With stderr redirected it writes `#< CLIXML` and then XML: progress records ("正在准备首次使用模块",
 * which is not an error at all) and error, warning and verbose lines as `<S S="Error">…</S>`.
 * Progress is dropped; every `<S>` line keeps its words. Anything this does not recognise, a stream
 * cut off mid-element included, is returned exactly as it came, so nothing is ever lost to parsing.
 */
export function plainPowerShellStderr(stderr: string): string {
  const at = stderr.indexOf(CLIXML_HEADER);
  if (at === -1) return stderr;
  const before = stderr.slice(0, at);
  const body = stderr
    .slice(at + CLIXML_HEADER.length)
    .replace(/<Obj S="progress"[^>]*>[\s\S]*?<\/Obj>/g, "");
  const lines: string[] = [];
  const rest = body
    .replace(/<S S="[A-Za-z]+">([\s\S]*?)<\/S>/g, (_, text: string) => {
      lines.push(decodeClixmlText(text));
      return "";
    })
    .replace(/<Objs\b[^>]*>|<\/Objs>/g, "")
    .trim();
  if (rest !== "") return stderr;
  return before + lines.join("");
}

/** Native Windows commands use PowerShell without profiles; Unix retains the existing bash contract. */
export function commandShell(
  command: string,
  platform: string,
  source: NodeJS.ProcessEnv,
) {
  if (platform !== "win32")
    return { executable: "/bin/bash", args: ["-c", command] };
  const root = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
  /*
   * `$ProgressPreference` off: with stderr redirected, Windows PowerShell serialises progress records
   * ("正在准备首次使用模块") into stderr as CLIXML, which the model then reads as an error. It is not
   * enough on its own (the first-use record is written before the script runs), so
   * `plainPowerShellStderr` also takes CLIXML apart on the way out.
   *
   * Encoding: PowerShell decodes what a native program prints with `[Console]::OutputEncoding`, and
   * `hostname.exe`, `ipconfig` and the other built-ins print in the machine's OEM code page (GBK on a
   * Chinese Windows) whatever that property says. Setting it to UTF-8 turned their Chinese into
   * U+FFFD before this process ever saw it. So the property keeps the machine's own code page, and
   * PowerShell's own writes go out as UTF-8 through `SetOut` / `SetError` instead. A native program
   * that is the command's last step bypasses PowerShell and writes its code page straight into the
   * pipe; `windowsOutputDecoder` reads those lines.
   */
  const script = `$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $openbotOut = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.UTF8Encoding]::new($false)); $openbotOut.AutoFlush = $true; [Console]::SetOut($openbotOut); $openbotErr = [System.IO.StreamWriter]::new([Console]::OpenStandardError(), [System.Text.UTF8Encoding]::new($false)); $openbotErr.AutoFlush = $true; [Console]::SetError($openbotErr); ${command}\n$openbotCommandSucceeded = $?; $openbotCommandExit = $LASTEXITCODE; if ($openbotCommandExit) { exit $openbotCommandExit }; if (-not $openbotCommandSucceeded) { exit 1 }`;
  return {
    executable: win32.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}
