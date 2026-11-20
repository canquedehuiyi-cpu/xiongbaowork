import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_BRANCH_TOOL,
  GIT_COMMIT_TOOL,
  GIT_DIFF_SUMMARY_TOOL,
  GIT_TOOLS,
  OPEN_PULL_REQUEST_TOOL,
} from "../../shared/git-tools";
import {
  type GitComputer,
  findPullRequestTool,
  gitTools,
  isSecretFileName,
  secretKindsIn,
  shellQuote,
  validRefName,
} from "../src/computer/git-tools";
import { DEFERRED_TOOLS, isDeferredTool } from "../src/agents/prompt-slim";
import type { GrantedTool } from "../src/plugins/tools";

/*
 * 期 4 · Task 4.2：员工的 Git 工作流工具。用真的 git 和一个临时目录当「工作区」，命令经和电脑网关同形的
 * `run` 跑（bash -c，工作目录是工作区根）。这里不碰数据库，也不碰网络。
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sh(cwd: string, command: string): string {
  const result = Bun.spawnSync(["bash", "-c", command], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return `${result.stdout}${result.stderr}`;
}

/** 一个工作区：根目录里有一个 `app` 仓库，已有一次提交。 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "git-tools-"));
  roots.push(root);
  mkdirSync(join(root, "app"));
  sh(
    root,
    "cd app && git init -q -b main && git config user.name t && git config user.email t@example.com && echo one > a.txt && git add a.txt && git commit -q -m init",
  );
  return root;
}

/** What the tools answer, as the tests read it. */
type Answer = {
  ok: boolean;
  error: string;
  refused?: boolean;
  needsConnector?: boolean;
  path?: string;
  action: string;
  branch: string;
  branches: string[];
  commit: string;
  mode: string;
  files: { path: string; added: number | null; deleted: number | null }[];
  totals: { files: number; added: number; deleted: number };
  untracked: string[];
  diff: string;
  diffTruncated: boolean;
};

const ran: string[] = [];

function computerIn(root: string): GitComputer {
  return {
    async run(command) {
      ran.push(command);
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
    async read(path) {
      try {
        const text = readFileSync(join(root, path), "utf8");
        return { text, truncated: false, bytes: Buffer.byteLength(text) };
      } catch {
        return null;
      }
    },
  };
}

function toolsFor(
  root: string | undefined,
  connectors: readonly GrantedTool[] = [],
) {
  const tools = gitTools({
    computer: async () => (root ? computerIn(root) : undefined),
    connectorTools: async () => connectors,
  });
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return async (args: unknown) =>
      JSON.parse(await tool.execute(args)) as Answer;
  };
  return { tools, byName };
}

beforeEach(() => {
  ran.length = 0;
});

describe("the four tools", () => {
  test("wait behind search_tools, found by words a person would use", () => {
    for (const name of GIT_TOOLS) {
      expect(isDeferredTool(name)).toBe(true);
      expect(DEFERRED_TOOLS[name]).toContain("git");
    }
  });

  test("are named for the employee's permissions as bot/<name>", () => {
    const { tools } = toolsFor(undefined);
    expect(tools.map((tool) => tool.name)).toEqual([...GIT_TOOLS]);
    expect(tools.map((tool) => tool.ref)).toEqual(
      [...GIT_TOOLS].map((name) => `bot/${name}`),
    );
  });

  test("say so when the employee has no computer", async () => {
    const { byName } = toolsFor(undefined);
    const answer = await byName(GIT_BRANCH_TOOL)({});
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("没有可用的电脑");
  });
});

describe("git_branch", () => {
  test("lists, creates and switches", async () => {
    const root = workspace();
    const branch = toolsFor(root).byName(GIT_BRANCH_TOOL);
    const listed = await branch({ repo: "app" });
    expect(listed).toMatchObject({ ok: true, action: "list", branch: "main" });
    expect(listed.branches).toEqual(["main"]);
    const created = await branch({
      action: "create",
      name: "feat/x",
      repo: "app",
    });
    expect(created).toMatchObject({ ok: true, branch: "feat/x" });
    expect(created.branches).toEqual(["feat/x", "main"]);
    const switched = await branch({
      action: "switch",
      name: "main",
      repo: "app",
    });
    expect(switched).toMatchObject({ ok: true, branch: "main" });
  });

  test("refuses bad names without running anything", async () => {
    const root = workspace();
    const branch = toolsFor(root).byName(GIT_BRANCH_TOOL);
    for (const name of ["", "-rf", "a b", "x;rm", "a..b", "$(id)"]) {
      const answer = await branch({ action: "create", name, repo: "app" });
      expect(answer.ok).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  test("says why a switch failed", async () => {
    const root = workspace();
    const answer = await toolsFor(root).byName(GIT_BRANCH_TOOL)({
      action: "switch",
      name: "nope",
      repo: "app",
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("nope");
  });

  test("only works on a repository inside the workspace", async () => {
    const root = workspace();
    // The workspace itself is not a repository: the one above it must not be used.
    const outer = mkdtempSync(join(tmpdir(), "git-outer-"));
    roots.push(outer);
    sh(outer, "git init -q -b main");
    mkdirSync(join(outer, "ws"));
    const branch = toolsFor(join(outer, "ws")).byName(GIT_BRANCH_TOOL);
    const outside = await branch({});
    expect(outside.ok).toBe(false);
    expect(outside.error).toContain("不在你的工作区里面");
    // A link inside the workspace that leads out of it is no way in either.
    symlinkSync(join(outer), join(outer, "ws", "link"));
    const linked = await branch({ repo: "link" });
    expect(linked.ok).toBe(false);
    // And the repository inside a real workspace works.
    expect(
      (await toolsFor(root).byName(GIT_BRANCH_TOOL)({ repo: "app" })).ok,
    ).toBe(true);
    for (const repo of ["..", "../x", "/etc", "~/x", "-x"]) {
      const answer = await branch({ repo });
      expect(answer.ok).toBe(false);
    }
  });

  test("reports a directory that is not a repository", async () => {
    const root = workspace();
    mkdirSync(join(root, "plain"));
    const answer = await toolsFor(root).byName(GIT_BRANCH_TOOL)({
      repo: "plain",
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("不是 git 仓库");
  });
});

describe("git_diff_summary", () => {
  test("lists changed files with added and deleted lines, and untracked files", async () => {
    const root = workspace();
    writeFileSync(join(root, "app", "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "app", "new.txt"), "fresh\n");
    const answer = await toolsFor(root).byName(GIT_DIFF_SUMMARY_TOOL)({
      repo: "app",
    });
    expect(answer).toMatchObject({
      ok: true,
      mode: "worktree",
      branch: "main",
    });
    expect(answer.files).toEqual([{ path: "a.txt", added: 2, deleted: 0 }]);
    expect(answer.totals).toEqual({ files: 1, added: 2, deleted: 0 });
    expect(answer.untracked).toEqual(["new.txt"]);
    expect(answer).not.toHaveProperty("diff");
  });

  test("brings a truncated diff when asked", async () => {
    const root = workspace();
    writeFileSync(
      join(root, "app", "a.txt"),
      `${Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n")}\n`,
    );
    const answer = await toolsFor(root).byName(GIT_DIFF_SUMMARY_TOOL)({
      repo: "app",
      include_diff: true,
      max_diff_chars: 500,
    });
    expect(answer.diff).toContain("+line 0");
    expect(answer.diffTruncated).toBe(true);
    expect(Buffer.byteLength(answer.diff)).toBeLessThanOrEqual(500);
  });

  test("compares a branch with a base, and only staged changes on request", async () => {
    const root = workspace();
    sh(
      join(root, "app"),
      "git switch -q -c feat && echo two >> a.txt && git commit -q -am more && echo three > b.txt && git add b.txt",
    );
    const { byName } = toolsFor(root);
    const summary = byName(GIT_DIFF_SUMMARY_TOOL);
    const based = await summary({ repo: "app", base: "main" });
    expect(based.mode).toBe("base");
    expect(based.files).toEqual([{ path: "a.txt", added: 1, deleted: 0 }]);
    const staged = await summary({ repo: "app", staged: true });
    expect(staged.mode).toBe("staged");
    expect(staged.files).toEqual([{ path: "b.txt", added: 1, deleted: 0 }]);
    const missing = await summary({ repo: "app", base: "nowhere" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("base");
  });

  test("works before the first commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-empty-"));
    roots.push(root);
    sh(root, "git init -q -b main && echo x > f.txt && git add f.txt");
    const answer = await toolsFor(root).byName(GIT_DIFF_SUMMARY_TOOL)({});
    expect(answer.ok).toBe(true);
    expect(answer.files).toEqual([{ path: "f.txt", added: 1, deleted: 0 }]);
  });
});

describe("git_commit", () => {
  test("commits only the named files", async () => {
    const root = workspace();
    writeFileSync(join(root, "app", "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "app", "b.txt"), "other\n");
    sh(join(root, "app"), "git add b.txt");
    const answer = await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      repo: "app",
      paths: ["a.txt"],
      message: "改 a 文件 with 'quotes' and $(echo no)",
    });
    expect(answer).toMatchObject({
      ok: true,
      branch: "main",
      files: ["a.txt"],
    });
    expect(answer.commit).toMatch(/^[0-9a-f]{40}$/);
    const log = sh(
      join(root, "app"),
      "git log -1 --format=%s && git show --stat --format= HEAD",
    );
    expect(log).toContain("改 a 文件 with 'quotes' and $(echo no)");
    expect(log).toContain("a.txt");
    expect(log).not.toContain("b.txt");
    // b.txt stays staged, untouched by the commit.
    expect(sh(join(root, "app"), "git status --porcelain")).toContain(
      "A  b.txt",
    );
  });

  test("uses a fixed identity when the repository has none", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-noid-"));
    roots.push(root);
    sh(root, "git init -q -b main && echo x > f.txt");
    const answer = await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      paths: ["f.txt"],
      message: "first",
    });
    expect(answer.ok).toBe(true);
    expect(sh(root, "git log -1 --format=%an")).toContain("xiongbao");
  });

  test("refuses a file that looks like it holds a key, and commits nothing", async () => {
    const root = workspace();
    const token = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`;
    writeFileSync(
      join(root, "app", "config.ts"),
      `export const t = "${token}";\n`,
    );
    writeFileSync(join(root, "app", "fine.ts"), "export const x = 1;\n");
    const before = sh(join(root, "app"), "git rev-parse HEAD");
    const answer = await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      repo: "app",
      paths: ["fine.ts", "config.ts"],
      message: "add config",
    });
    expect(answer).toMatchObject({
      ok: false,
      refused: true,
      path: "config.ts",
    });
    expect(answer.error).toContain("密钥或令牌");
    expect(sh(join(root, "app"), "git rev-parse HEAD")).toBe(before);
    // Nothing was run on the machine at all: the check came first.
    expect(ran).toEqual([]);
  });

  test("refuses a private key, a password and a secret file name", async () => {
    const root = workspace();
    const commit = toolsFor(root).byName(GIT_COMMIT_TOOL);
    writeFileSync(
      join(root, "app", "k.pem.txt"),
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n",
    );
    writeFileSync(
      join(root, "app", "p.ts"),
      'const password = "hunter2hunter2";\n',
    );
    writeFileSync(join(root, "app", ".env"), "A=1\n");
    const priv = await commit({
      repo: "app",
      paths: ["k.pem.txt"],
      message: "m",
    });
    expect(priv.error).toContain("私钥");
    const pass = await commit({ repo: "app", paths: ["p.ts"], message: "m" });
    expect(pass.error).toContain("口令");
    const env = await commit({ repo: "app", paths: [".env"], message: "m" });
    expect(env.refused).toBe(true);
    expect(env.error).toContain(".env");
    expect(ran).toEqual([]);
  });

  test("refuses a key in the commit message", async () => {
    const root = workspace();
    writeFileSync(join(root, "app", "a.txt"), "x\n");
    const answer = await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      repo: "app",
      paths: ["a.txt"],
      message: `use ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`,
    });
    expect(answer.refused).toBe(true);
    expect(ran).toEqual([]);
  });

  test("an email address in code is not a reason to refuse", async () => {
    const root = workspace();
    writeFileSync(join(root, "app", "a.txt"), "contact: someone@example.com\n");
    const answer = await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      repo: "app",
      paths: ["a.txt"],
      message: "contact",
    });
    expect(answer.ok).toBe(true);
  });

  test("refuses directories, globs, paths that leave the repository, and too many files", async () => {
    const root = workspace();
    mkdirSync(join(root, "app", "dir"));
    writeFileSync(join(root, "app", "dir", "x.txt"), "x\n");
    const commit = toolsFor(root).byName(GIT_COMMIT_TOOL);
    const dir = await commit({ repo: "app", paths: ["dir"], message: "m" });
    expect(dir.ok).toBe(false);
    expect(dir.error).toContain("目录");
    for (const path of [
      "*",
      "dir/*.txt",
      "../a",
      "/etc/passwd",
      "-A",
      ":(top)a",
      "",
    ]) {
      const answer = await commit({ repo: "app", paths: [path], message: "m" });
      expect(answer.ok).toBe(false);
    }
    const many = await commit({
      repo: "app",
      paths: Array.from({ length: 51 }, (_, index) => `f${index}`),
      message: "m",
    });
    expect(many.error).toContain("分批");
    const empty = await commit({ repo: "app", paths: [], message: "m" });
    expect(empty.ok).toBe(false);
  });

  test("says when there is nothing to commit", async () => {
    const root = workspace();
    const answer = await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      repo: "app",
      paths: ["a.txt"],
      message: "again",
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("nothing to commit");
  });

  test("a file too large to check is not committed", async () => {
    const root = workspace();
    const computer = computerIn(root);
    const tools = gitTools({
      computer: async () => ({
        ...computer,
        read: async () => ({ text: "x", truncated: true, bytes: 900_000 }),
      }),
      connectorTools: async () => [],
    });
    const commit = tools.find((tool) => tool.name === GIT_COMMIT_TOOL);
    const answer = JSON.parse(
      (await commit?.execute({
        repo: "app",
        paths: ["a.txt"],
        message: "m",
      })) ?? "{}",
    );
    expect(answer.refused).toBe(true);
    expect(answer.error).toContain("太大");
  });

  test("issues exactly one command, so an approval covers the whole call", async () => {
    const root = workspace();
    writeFileSync(join(root, "app", "a.txt"), "two\n");
    await toolsFor(root).byName(GIT_COMMIT_TOOL)({
      repo: "app",
      paths: ["a.txt"],
      message: "m",
    });
    expect(ran).toHaveLength(1);
  });
});

describe("open_pull_request", () => {
  const args = {
    owner: "acme",
    repo: "app",
    title: "Add x",
    head: "feat/x",
    base: "main",
    body: "details",
  };

  function connector(ref: string, calls: unknown[]): GrantedTool {
    return {
      name: `mcp__${ref.replace("/", "__")}`,
      ref,
      description: "",
      parameters: undefined as never,
      async execute(call) {
        calls.push(call);
        return "created https://github.com/acme/app/pull/1";
      },
    };
  }

  test("tells the employee to ask the person to connect when there is no connector", async () => {
    const answer = await toolsFor(undefined, [
      connector("linear/create_issue", []),
    ]).byName(OPEN_PULL_REQUEST_TOOL)(args);
    expect(answer).toMatchObject({ ok: false, needsConnector: true });
    expect(answer.error).toContain("请本人");
    expect(answer.error).toContain("接入");
  });

  test("hands the request to the connector's own create-pull-request tool, unchanged", async () => {
    const calls: unknown[] = [];
    const tool = toolsFor(undefined, [
      connector("github/get_me", []),
      connector("github/create_pull_request", calls),
    ]).tools.find((candidate) => candidate.name === OPEN_PULL_REQUEST_TOOL);
    const answer = await tool?.execute(args);
    expect(answer).toContain("pull/1");
    expect(calls).toEqual([args]);
  });

  test("recognises the other spellings of the same action", () => {
    const calls: unknown[] = [];
    for (const ref of [
      "composio-github/GITHUB_CREATE_A_PULL_REQUEST",
      "github-app/create-pull-request",
    ])
      expect(findPullRequestTool([connector(ref, calls)])?.ref).toBe(ref);
    for (const ref of [
      "github/create_pull_request_with_copilot",
      "github/merge_pull_request",
      "gitlab/create_pull_request",
    ])
      expect(findPullRequestTool([connector(ref, calls)])).toBeUndefined();
  });

  test("does not send a key out in a title or description", async () => {
    const calls: unknown[] = [];
    const tool = toolsFor(undefined, [
      connector("github/create_pull_request", calls),
    ]).byName(OPEN_PULL_REQUEST_TOOL);
    const answer = await tool({
      ...args,
      body: `token ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`,
    });
    expect(answer.refused).toBe(true);
    expect(calls).toEqual([]);
  });

  test("needs the repository, branches and title", async () => {
    const answer = await toolsFor(undefined, [
      connector("github/create_pull_request", []),
    ]).byName(OPEN_PULL_REQUEST_TOOL)({ title: "only a title" });
    expect(answer.ok).toBe(false);
  });
});

describe("the helpers", () => {
  test("shellQuote keeps a value a single word", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(sh(tmpdir(), `printf %s ${shellQuote("x'; echo hi; '")}`)).toBe(
      "x'; echo hi; '",
    );
  });

  test("validRefName", () => {
    for (const ok of ["main", "feat/x-1", "release_1.2", "origin/main"])
      expect(validRefName(ok)).toBe(true);
    for (const bad of [
      "",
      "-x",
      "a b",
      "a..b",
      "a//b",
      "x/",
      "x.",
      "x.lock",
      "$(x)",
    ])
      expect(validRefName(bad)).toBe(false);
  });

  test("isSecretFileName spares templates", () => {
    for (const name of [
      ".env",
      "app/.env.local",
      "id_rsa",
      "a/server.pem",
      "credentials.json",
    ])
      expect(isSecretFileName(name)).toBe(true);
    for (const name of [".env.example", "src/env.ts", "README.md"])
      expect(isSecretFileName(name)).toBe(false);
  });

  test("secretKindsIn reads past the first twenty thousand characters", () => {
    const padding = "const x = 1;\n".repeat(3_000);
    expect(
      secretKindsIn(
        `${padding}const t = "ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}";`,
      ),
    ).toContain("密钥或令牌");
    expect(secretKindsIn(padding)).toEqual([]);
  });
});
