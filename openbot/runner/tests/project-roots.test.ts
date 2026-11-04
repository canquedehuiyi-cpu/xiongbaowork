import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportedRoots } from "../../server/src/devices/store";
import {
  createRunnerExecutor,
  PROJECT_BRANCHES_ACTION,
  PROJECT_SYNC_ACTION,
} from "../src/execute";
import {
  createGit,
  GIT_ALLOW_PROTOCOL,
  type GitResult,
  type GitSpawn,
} from "../src/git";
import { heartbeatFrame, parseRootCommand, runRootCommand } from "../src/index";
import { createRootRegistry, PROJECTS_DIR } from "../src/roots";

/*
 * Story RES2, phase 2 (spec §5 RES2-2): a project's folder on this machine. A folder its owner
 * registered for writing, written to only when the server's frame also says the project is writable;
 * a command run in it; and a Git project cloned and synced here, by this machine's own `git`.
 *
 * No network. The repository is a bare one in a temporary directory, served on 127.0.0.1 by `git
 * http-backend` behind `Bun.serve`, and reached through the one test-only switch that admits plain
 * HTTP on the loopback address (`testOnlyLoopbackHttp`). The production list is `https:ssh` and is
 * checked to be exactly that.
 */

const scratch = mkdtempSync(join(tmpdir(), "openbot-project-roots-"));
let made = 0;

/** Run the test's own `git` (fixture setup only), failing loudly. */
function fixtureGit(args: string[], cwd?: string): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=测试", "-c", "user.email=t@example.test", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  if (result.status !== 0)
    throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A data directory with a workspace, an owner's folder of each mode, and an executor over them. */
function machine(git = createGit({ testOnlyLoopbackHttp: true })) {
  made += 1;
  const base = join(scratch, `m${made}`);
  const dataDir = join(base, "data");
  const workspace = join(dataDir, "runner-workspace");
  const readable = join(base, "合同");
  const writable = join(base, "后端代码");
  mkdirSync(workspace, { recursive: true });
  for (const folder of [readable, writable]) {
    mkdirSync(join(folder, "src"), { recursive: true });
    writeFileSync(join(folder, "src", "app.ts"), "export const a = 1;\n");
  }
  writeFileSync(join(base, "outside.txt"), "outside\n");
  writeFileSync(join(dataDir, "runner-state.json"), '{"token":"secret"}\n');
  const roots = createRootRegistry({
    dataDir,
    privatePaths: [join(dataDir, "runner-state.json"), workspace, dataDir],
  });
  const read = roots.add("合同", readable);
  const write = roots.add("后端代码", writable, "write");
  const execute = createRunnerExecutor(workspace, undefined, roots, git);
  return {
    base,
    dataDir,
    workspace,
    readable,
    writable,
    roots,
    read,
    write,
    execute,
  };
}

/** Every file under a directory with its bytes, so "nothing changed" is checked, not assumed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        out[full.slice(dir.length)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

// --- a repository on 127.0.0.1, served by `git http-backend` --------------------------------------

const repos = join(scratch, "repos");
const work = join(scratch, "work");
let server: ReturnType<typeof Bun.serve> | undefined;
let repoUrl = "";

/** One CGI request to `git http-backend`, which speaks the smart protocol a shallow clone needs. */
async function backend(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: repos,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.byteLength),
      HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
      GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
    stdin: body,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = Buffer.from(await new Response(child.stdout).arrayBuffer());
  await child.exited;
  let split = out.indexOf("\r\n\r\n");
  let gap = 4;
  if (split < 0) {
    split = out.indexOf("\n\n");
    gap = 2;
  }
  const headers = new Headers();
  let status = 200;
  for (const line of out.subarray(0, split).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return new Response(out.subarray(split + gap), { status, headers });
}

beforeAll(() => {
  mkdirSync(repos, { recursive: true });
  fixtureGit(["init", "--bare", "-b", "main", join(repos, "site.git")]);
  fixtureGit(["init", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "# 官网\n");
  fixtureGit(["add", "."], work);
  fixtureGit(["commit", "-m", "第一版"], work);
  fixtureGit(["checkout", "-b", "release/1.0"], work);
  writeFileSync(join(work, "CHANGELOG.md"), "1.0\n");
  fixtureGit(["add", "."], work);
  fixtureGit(["commit", "-m", "发布 1.0"], work);
  fixtureGit(["checkout", "main"], work);
  fixtureGit(["remote", "add", "origin", join(repos, "site.git")], work);
  fixtureGit(["push", "origin", "main", "release/1.0"], work);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: backend });
  repoUrl = `http://127.0.0.1:${server.port}/site.git`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const tip = (branch: string) =>
  fixtureGit(["rev-parse", `refs/heads/${branch}`], join(repos, "site.git"));

// --- acceptance 1: a writable project root, and a read-only one ----------------------------------

test("acceptance 1: files.write lands in a root registered for writing when the frame says writable; a read-only root refuses it and its disk does not change", async () => {
  const { execute, read, write, readable, writable, workspace } = machine();
  const written = await execute({
    action: "files.write",
    payload: {
      root: write.ref,
      writable: true,
      path: "src/new.ts",
      contents: "export const b = 2;\n",
    },
  });
  expect(written).toMatchObject({ ok: true });
  expect(readFileSync(join(writable, "src", "new.ts"), "utf8")).toBe(
    "export const b = 2;\n",
  );

  const before = snapshot(readable);
  const beforeWritable = snapshot(writable);
  const workspaceBefore = snapshot(workspace);
  for (const attempt of [
    // The owner registered it read-only: the server's `writable` cannot widen that.
    {
      action: "files.write",
      payload: {
        root: read.ref,
        writable: true,
        path: "src/app.ts",
        contents: "x",
      },
    },
    {
      action: "exec",
      payload: { root: read.ref, writable: true, command: "touch made" },
    },
    // Writable on the machine, but the frame does not say the project is: read-only.
    {
      action: "files.write",
      payload: { root: write.ref, path: "src/app.ts", contents: "x" },
    },
    {
      action: "files.write",
      payload: {
        root: write.ref,
        writable: "true",
        path: "src/app.ts",
        contents: "x",
      },
    },
    { action: "exec", payload: { root: write.ref, command: "touch made" } },
    // Never anything but a write or a command, and never a root as a bare `cwd`.
    {
      action: "files.delete",
      payload: { root: write.ref, writable: true, path: "src/app.ts" },
    },
    {
      action: "exec",
      payload: { cwd: write.ref, writable: true, command: "touch made" },
    },
  ]) {
    expect(await execute(attempt)).toMatchObject({
      ok: false,
      error: expect.stringContaining("read-only"),
    });
  }
  expect(snapshot(readable)).toEqual(before);
  expect(snapshot(writable)).toEqual(beforeWritable);
  expect(snapshot(workspace)).toEqual(workspaceBefore);
});

// --- acceptance 2: a command runs in the project's folder, the file tools stay inside it -----------

test("acceptance 2: exec runs in the project's folder; after cd .., the file tools still cannot reach outside it", async () => {
  const { execute, write, writable, base } = machine();
  const where = await execute({
    action: "exec",
    payload: { root: write.ref, writable: true, command: "pwd" },
  });
  expect(where).toMatchObject({ ok: true });
  expect(
    realpathSync(
      String((where as { output: { stdout: string } }).output.stdout).trim(),
    ),
  ).toBe(realpathSync(writable));

  const wandered = await execute({
    action: "exec",
    payload: { root: write.ref, writable: true, command: "cd .. && pwd" },
  });
  expect(
    String((wandered as { output: { stdout: string } }).output.stdout).trim(),
  ).toBe(realpathSync(base));
  for (const path of ["../outside.txt", join(base, "outside.txt"), ".."]) {
    expect(
      await execute({
        action: "files.read",
        payload: { root: write.ref, path },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await execute({
        action: "files.write",
        payload: { root: write.ref, writable: true, path, contents: "x" },
      }),
    ).toMatchObject({ ok: false });
  }
  expect(readFileSync(join(base, "outside.txt"), "utf8")).toBe("outside\n");
});

// --- acceptance 3: clone and sync over a local repository ----------------------------------------

test("acceptance 3: a sync clones the branch into runner-projects, registers it as a writable root, and reports the commit; the next sync fetches the new tip", async () => {
  const { execute, roots, dataDir } = machine();
  const first = await execute({
    action: PROJECT_SYNC_ACTION,
    payload: { rootRef: null, url: repoUrl, branch: "release/1.0" },
  });
  expect(first).toMatchObject({ ok: true });
  const { rootRef, commit } = (
    first as { output: { rootRef: string; commit: string } }
  ).output;
  expect(rootRef).toMatch(/^fld_[A-Za-z0-9_-]{22}$/);
  expect(commit).toBe(tip("release/1.0"));
  const dir = join(dataDir, PROJECTS_DIR, rootRef);
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe("1.0\n");
  expect(roots.clone(rootRef)).toMatchObject({ mode: "write", origin: "git" });
  // A clone is the machine's own copy, not an owner's folder: not reported, not listed.
  expect(roots.reported().map((root) => root.ref)).not.toContain(rootRef);
  expect(roots.list().map((root) => root.ref)).not.toContain(rootRef);

  // Its files are reached as a writable project root.
  expect(
    await execute({
      action: "files.read",
      payload: { root: rootRef, path: "README.md" },
    }),
  ).toMatchObject({ ok: true, output: { text: "# 官网\n" } });

  // A new commit on the branch, then 同步 again: fetched and checked out.
  fixtureGit(["checkout", "release/1.0"], work);
  writeFileSync(join(work, "CHANGELOG.md"), "1.0\n1.0.1\n");
  fixtureGit(["commit", "-am", "1.0.1"], work);
  fixtureGit(["push", "origin", "release/1.0"], work);
  fixtureGit(["checkout", "main"], work);
  const second = await execute({
    action: PROJECT_SYNC_ACTION,
    payload: { rootRef, url: repoUrl, branch: "release/1.0" },
  });
  expect(second).toMatchObject({
    ok: true,
    output: { rootRef, commit: tip("release/1.0") },
  });
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe("1.0\n1.0.1\n");

  // And the branch list is the repository's, asked of this machine.
  expect(
    await execute({
      action: PROJECT_BRANCHES_ACTION,
      payload: { url: repoUrl },
    }),
  ).toEqual({ ok: true, output: { branches: ["main", "release/1.0"] } });
});

test("acceptance 3: file:// and a bare path are refused, with the test switch on and off; the production protocols are exactly https and ssh", async () => {
  const bare = join(repos, "site.git");
  for (const git of [createGit(), createGit({ testOnlyLoopbackHttp: true })]) {
    const { execute, dataDir } = machine(git);
    for (const url of [`file://${bare}`, bare, "ext::sh -c id"]) {
      const outcome = await execute({
        action: PROJECT_SYNC_ACTION,
        payload: { rootRef: null, url, branch: "main" },
      });
      expect(outcome).toMatchObject({ ok: false });
    }
    // Nothing was cloned, and nothing was left behind.
    const clones = join(dataDir, PROJECTS_DIR);
    expect(existsSync(clones) ? readdirSync(clones) : []).toEqual([]);
  }
  // Without the test switch, plain HTTP on the loopback address is refused too.
  const { execute } = machine(createGit());
  expect(
    await execute({
      action: PROJECT_SYNC_ACTION,
      payload: { rootRef: null, url: repoUrl, branch: "main" },
    }),
  ).toMatchObject({ ok: false });
  expect(GIT_ALLOW_PROTOCOL).toBe("https:ssh");
});

// --- acceptance 4: arguments never go through a shell -------------------------------------------

test("acceptance 4: a branch carrying a shell command is refused and no process starts; a good one is an argument array with the guards", async () => {
  const calls: Array<{ args: readonly string[]; env: Record<string, string> }> =
    [];
  const fake: GitSpawn = async (args, options) => {
    calls.push({ args, env: options.env });
    const result: GitResult = {
      code: 0,
      stdout: args.includes("rev-parse")
        ? "0123456789abcdef0123456789abcdef01234567\n"
        : "",
      stderr: "",
    };
    return result;
  };
  const { execute, dataDir } = machine(createGit({ spawn: fake }));
  for (const branch of [
    "main;rm -rf ~",
    "$(touch /tmp/pwned)",
    "`id`",
    "main && id",
    "--upload-pack=touch /tmp/pwned",
    "../../etc",
  ]) {
    expect(
      await execute({
        action: PROJECT_SYNC_ACTION,
        payload: {
          rootRef: null,
          url: "https://git.example.test/a.git",
          branch,
        },
      }),
    ).toMatchObject({ ok: false });
  }
  for (const url of [
    "-oProxyCommand=id@host:a",
    "https://user:token@git.example.test/a.git",
  ])
    expect(
      await execute({
        action: PROJECT_BRANCHES_ACTION,
        payload: { url },
      }),
    ).toMatchObject({ ok: false });
  expect(calls).toEqual([]);
  const clones = join(dataDir, PROJECTS_DIR);
  expect(existsSync(clones) ? readdirSync(clones) : []).toEqual([]);

  const synced = await execute({
    action: PROJECT_SYNC_ACTION,
    payload: {
      rootRef: null,
      url: "git@git.example.test:team/a.git",
      branch: "feat/x",
    },
  });
  expect(synced).toMatchObject({ ok: true });
  const clone = calls[0];
  expect(clone?.args).toEqual([
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.hooksPath=",
    "-c",
    "submodule.recurse=false",
    "clone",
    "--branch",
    "feat/x",
    "--single-branch",
    "--depth",
    "50",
    "--no-recurse-submodules",
    "--",
    "git@git.example.test:team/a.git",
    expect.stringContaining(PROJECTS_DIR),
  ]);
  expect(clone?.env.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
  expect(clone?.env.GIT_TERMINAL_PROMPT).toBe("0");
});

// --- acceptance 5: no absolute path leaves the machine --------------------------------------------

test("acceptance 5: what the server is told carries the folder's mode and never a path, and the server keeps the mode and drops anything else", async () => {
  const { roots, read, write, readable, writable, base } = machine();
  const frame = heartbeatFrame(roots);
  expect(JSON.parse(frame)).toEqual({
    type: "heartbeat",
    roots: [
      { ref: read.ref, name: "合同" },
      { ref: write.ref, name: "后端代码", mode: "write" },
    ],
  });
  for (const path of [readable, writable, base])
    expect(frame).not.toContain(path);
  // What the server stores from that report (devices/store.ts `reportedRoots`).
  const kept = reportedRoots(JSON.parse(frame).roots);
  expect(kept).toEqual([
    { ref: read.ref, name: "合同" },
    { ref: write.ref, name: "后端代码", mode: "write" },
  ]);
  expect(
    reportedRoots([
      { ref: write.ref, name: "后端代码", mode: "admin", path: writable },
    ]),
  ).toEqual([{ ref: write.ref, name: "后端代码" }]);
});

test("the command line registers a folder for writing only when asked, and refuses a mode that is not read or write", () => {
  made += 1;
  const base = join(scratch, `cli${made}`);
  const dataDir = join(base, "data");
  const folder = join(base, "代码");
  mkdirSync(folder, { recursive: true });
  const lines: string[] = [];
  const run = (argv: string[]) => {
    const parsed = parseRootCommand(argv, {}, base);
    if (typeof parsed === "string" || parsed === null)
      throw new Error(String(parsed));
    return runRootCommand(parsed, (line) => lines.push(line));
  };
  expect(
    run([
      "--data-dir",
      dataDir,
      "--add-root",
      `代码=${folder}`,
      "--root-mode",
      "write",
    ]),
  ).toBe(0);
  expect(JSON.parse(lines.at(-1) as string).root).toMatchObject({
    name: "代码",
    mode: "write",
  });
  expect(
    parseRootCommand(
      ["--add-root", `x=${folder}`, "--root-mode", "admin"],
      {},
      base,
    ),
  ).toContain("read or write");
  expect(
    parseRootCommand(["--list-roots", "--root-mode", "write"], {}, base),
  ).toContain("--add-root");
  // A folder inside this runner's own project clones cannot be offered as one of the owner's.
  const inside = join(dataDir, PROJECTS_DIR, "x");
  mkdirSync(inside, { recursive: true });
  const registry = createRootRegistry({ dataDir });
  expect(() => registry.add("克隆", inside)).toThrow("数据目录");
});
