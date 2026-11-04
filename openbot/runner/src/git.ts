import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COMMIT_PATTERN,
  gitBranchProblem,
  gitUrlProblem,
} from "../../shared/projects";

/**
 * `git` on this machine, for a Git project (story RES2, spec §3.3, decision D4).
 *
 * THE CLONE IS HERE, NEVER ON THE SERVER. The repository is fetched by this machine, with its owner's
 * own SSH keys and credential helper, into `<dataDir>/runner-projects/<ref>/`. The server only checks
 * an address's shape and never connects to it, so it never holds a credential.
 *
 * WHAT `git` IS ALLOWED TO DO.
 *  - Only `https` and `ssh`: `GIT_ALLOW_PROTOCOL=https:ssh`, which `git` applies to every transport it
 *    would use, the redirects and submodules of a clone included, and `protocol.file.allow=never`
 *    besides. `file://`, a bare path and `ext::` are refused before `git` runs, and again by `git`.
 *    The list is fixed: nothing on the command line, in the environment or from the server changes it.
 *  - No submodules (decision D5): a clone does not recurse, and nothing here asks it to.
 *  - No hooks: `core.hooksPath` is set empty for every command, so a repository cannot make this
 *    machine run anything by being cloned or checked out.
 *  - Never a prompt: `GIT_TERMINAL_PROMPT=0`, so a repository that needs a password this machine does
 *    not have fails instead of waiting for a terminal nobody is looking at.
 *  - Arguments are an array handed to the process, never a string through a shell, and the address
 *    and branch are checked with the same `shared/projects.ts` rules as the server's before anything
 *    starts: a branch called `main;rm -rf ~` is refused, and no process is started for it.
 *
 * The owner's own network is not refused: a company GitLab on the office network is a fine place for
 * a repository, and it is this machine reaching its owner's network.
 *
 * No pull before a task (decision D6): a project is fetched only when its owner presses 同步.
 */

/** The transports `git` may use. Fixed: not an option, not an environment variable, not a flag. */
export const GIT_ALLOW_PROTOCOL = "https:ssh";
/** Enough history to read recent changes, little enough for a home connection. */
const CLONE_DEPTH = "50";
/** A clone of a large repository over a slow connection takes a while; a hung one does not. */
const GIT_TIMEOUT_MS = 9 * 60_000;
const OUTPUT_LIMIT = 256 * 1024;
const BRANCH_LIMIT = 500;

/** A refusal or failure a person can read. Chinese, because the app shows it as it stands. */
export class GitFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFailure";
  }
}

export type GitResult = { code: number; stdout: string; stderr: string };
/** How a command is run: `git` and an argument array, never a shell. The seam a test replaces. */
export type GitSpawn = (
  args: readonly string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<GitResult>;

export type GitOptions = {
  /** The `git` binary. Default: `git` on PATH. */
  binary?: string;
  spawn?: GitSpawn;
  /**
   * FOR TESTS ONLY: a plain-HTTP repository on 127.0.0.1, served by the test itself, because no test
   * may reach the network. Not reachable from the command line or the environment: only code that
   * constructs this module directly can pass it. `file://` stays refused with it.
   */
  testOnlyLoopbackHttp?: boolean;
};

function spawnWith(binary: string): GitSpawn {
  return (args, options) =>
    new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(binary, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: GIT_TIMEOUT_MS,
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          reject(
            new GitFailure("这台设备上没有安装 git，请先安装 git 后再同步。"),
          );
        else reject(new GitFailure(`git 没有运行成功：${error.message}`));
      });
      child.on("close", (code) =>
        resolve({ code: code ?? -1, stdout, stderr }),
      );
    });
}

export type Git = {
  /** Clone `branch` of `url` into `dir`, or bring an existing clone there to it. The commit after. */
  sync: (input: {
    url: string;
    branch: string;
    dir: string;
    signal?: AbortSignal;
  }) => Promise<{ commit: string }>;
  /** The repository's branch names, as `git ls-remote --heads` lists them. */
  branches: (input: { url: string; signal?: AbortSignal }) => Promise<string[]>;
};

export function createGit(options: GitOptions = {}): Git {
  const run = options.spawn ?? spawnWith(options.binary ?? "git");
  const loopback = options.testOnlyLoopbackHttp === true;
  const allowProtocol = loopback
    ? `${GIT_ALLOW_PROTOCOL}:http`
    : GIT_ALLOW_PROTOCOL;

  /** The owner's environment (PATH, HOME, the SSH agent), with every rule above laid over it. */
  const environment = (): Record<string, string> => {
    const env: Record<string, string> = {};
    /*
     * No other `GIT_*` variable is passed on: one such as `GIT_DIR`, `GIT_WORK_TREE` or
     * `GIT_CONFIG_PARAMETERS` would point a command somewhere else or undo a setting below. The two
     * the owner may need to reach a private repository with their own key are kept.
     */
    for (const [key, value] of Object.entries(process.env))
      if (
        value !== undefined &&
        (!key.startsWith("GIT_") ||
          key === "GIT_SSH" ||
          key === "GIT_SSH_COMMAND")
      )
        env[key] = value;
    return {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: allowProtocol,
    };
  };

  /** Settings on every command, ahead of the subcommand. */
  const guarded = (args: string[]) => [
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.hooksPath=",
    "-c",
    "submodule.recurse=false",
    ...args,
  ];

  function checkedUrl(url: unknown): string {
    if (
      loopback &&
      typeof url === "string" &&
      /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/[A-Za-z0-9._/-]+$/.test(url)
    )
      return url;
    const problem = gitUrlProblem(url);
    if (problem) throw new GitFailure(problem);
    return String(url).trim();
  }

  function checkedBranch(branch: unknown): string {
    const problem = gitBranchProblem(branch);
    if (problem) throw new GitFailure(problem);
    return String(branch).trim();
  }

  async function git(args: string[], cwd?: string, signal?: AbortSignal) {
    const result = await run(guarded(args), {
      ...(cwd ? { cwd } : {}),
      env: environment(),
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0) {
      const said = result.stderr.trim().split("\n").slice(-3).join(" ");
      throw new GitFailure(
        `git ${args[0]} 没有成功：${said || `退出码 ${result.code}`}`,
      );
    }
    return result.stdout;
  }

  return {
    async sync({ url, branch, dir, signal }) {
      const address = checkedUrl(url);
      const name = checkedBranch(branch);
      if (!existsSync(join(dir, ".git"))) {
        await git(
          [
            "clone",
            "--branch",
            name,
            "--single-branch",
            "--depth",
            CLONE_DEPTH,
            "--no-recurse-submodules",
            "--",
            address,
            dir,
          ],
          undefined,
          signal,
        );
      } else {
        /*
         * An existing clone is brought to the branch's tip on the stored address, fetched by address
         * rather than by the clone's own remote, so the same protocol rules apply whatever the
         * clone's configuration says. Local changes a coworker made are kept by `checkout` when they
         * do not clash, and a clash fails the sync rather than overwriting them.
         */
        await git(
          [
            "fetch",
            "--depth",
            CLONE_DEPTH,
            "--no-recurse-submodules",
            "--",
            address,
            `+refs/heads/${name}:refs/remotes/origin/${name}`,
          ],
          dir,
          signal,
        );
        await git(
          ["checkout", "-B", name, `refs/remotes/origin/${name}`, "--"],
          dir,
          signal,
        );
      }
      const commit = (await git(["rev-parse", "HEAD"], dir, signal)).trim();
      if (!COMMIT_PATTERN.test(commit))
        throw new GitFailure("没有读到同步后的 commit。");
      return { commit };
    },

    async branches({ url, signal }) {
      const address = checkedUrl(url);
      const out = await git(
        ["ls-remote", "--heads", "--", address],
        undefined,
        signal,
      );
      const names: string[] = [];
      for (const line of out.split("\n")) {
        const ref = line.split("\t")[1]?.trim() ?? "";
        if (!ref.startsWith("refs/heads/")) continue;
        const name = ref.slice("refs/heads/".length);
        // Only names this module would also accept back as a branch to sync.
        if (gitBranchProblem(name) === null) names.push(name);
        if (names.length >= BRANCH_LIMIT) break;
      }
      return names;
    },
  };
}
