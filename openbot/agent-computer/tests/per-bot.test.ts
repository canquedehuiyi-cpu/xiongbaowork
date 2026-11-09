import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  botHome,
  botKeyOf,
  createPerBotComputer,
  type HelperRunner,
  helperRunner,
  PerBotUnavailableError,
  perBotUsersEnabled,
  usesOwnUser,
} from "../src/per-bot";

/**
 * Which Linux user and which directory an employee's call lands in.
 *
 * The key becomes part of a user name and a path that a root helper acts on, so whatever the bot id
 * looks like, the key must be twelve lowercase hex digits and the raw id must never reach the path.
 */

const KEY = /^[0-9a-f]{12}$/;

describe("botKeyOf", () => {
  test("is the first twelve hex digits of sha256(botId)", () => {
    const key = botKeyOf("bot-a");
    expect(key).toMatch(KEY);
    expect(key).toBe(
      createHash("sha256").update("bot-a").digest("hex").slice(0, 12),
    );
  });

  test.each([
    ["a 200-character id", "x".repeat(200)],
    ["an id with a separator and dots", "a/../b"],
    ["an id in Chinese", "员工一号"],
  ])("%s still yields a usable key", (_, botId) => {
    expect(botKeyOf(botId)).toMatch(KEY);
  });

  test("is stable for one id and differs between ids", () => {
    expect(botKeyOf("bot-a")).toBe(botKeyOf("bot-a"));
    expect(botKeyOf("bot-a")).not.toBe(botKeyOf("bot-b"));
  });
});

describe("botHome", () => {
  test("never carries the raw id or a dot-dot into the path", () => {
    const home = botHome("/workspace", "a/../b", "shared", true);
    expect(home).not.toContain("..");
    expect(home).not.toContain("a/../b");
    expect(home).toBe(`/workspace/bots/${botKeyOf("a/../b")}`);
  });

  test("an employee with its own user gets a directory under bots/", () => {
    expect(botHome("/workspace", "bot-a", "shared", true)).toBe(
      `/workspace/bots/${botKeyOf("bot-a")}`,
    );
  });

  test("the default employee, and everyone with the switch off, keep the root", () => {
    expect(botHome("/workspace", "shared", "shared", true)).toBe("/workspace");
    expect(botHome("/workspace", "bot-a", "shared", false)).toBe("/workspace");
  });
});

describe("usesOwnUser", () => {
  test("only a non-default employee with the switch on", () => {
    expect(usesOwnUser("shared", "shared", true)).toBe(false);
    expect(usesOwnUser("bot-a", "shared", false)).toBe(false);
    expect(usesOwnUser("bot-a", "shared", true)).toBe(true);
  });
});

describe("perBotUsersEnabled", () => {
  test("on, read loosely, on Linux", () => {
    expect(
      perBotUsersEnabled({ COMPUTER_PER_BOT_USERS: " ON " }, "linux"),
    ).toBe(true);
  });

  test("never on another platform", () => {
    expect(perBotUsersEnabled({ COMPUTER_PER_BOT_USERS: "on" }, "win32")).toBe(
      false,
    );
  });

  test("off when unset or anything other than on", () => {
    expect(perBotUsersEnabled({}, "linux")).toBe(false);
    expect(perBotUsersEnabled({ COMPUTER_PER_BOT_USERS: "off" }, "linux")).toBe(
      false,
    );
    expect(perBotUsersEnabled({ COMPUTER_PER_BOT_USERS: "1" }, "linux")).toBe(
      false,
    );
  });
});

/**
 * Choosing the employee's file root, and asking the root helper to prepare it.
 *
 * The helper is faked: it records what it was asked and answers with whatever the test chose. The
 * real one runs as root through sudo and is tested in the image.
 */
describe("createPerBotComputer", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "per-bot-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fakeHelper(answer: () => { code: number; stderr?: string }) {
    const calls: string[][] = [];
    const helper: HelperRunner = async (args) => {
      calls.push(args);
      const { code, stderr = "" } = answer();
      // What the real `ensure` does: the employee's directory exists once it answers 0.
      if (code === 0 && args[0] === "ensure")
        await mkdir(join(root, "bots", String(args[1])), { recursive: true });
      return { code, stdout: code === 0 ? "20001\n" : "", stderr };
    };
    return { calls, helper };
  }

  test("switched off: every employee's files are rooted at the workspace and the helper is never asked", async () => {
    const { calls, helper } = fakeHelper(() => ({ code: 0 }));
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: false,
      helper,
    });
    await (await perBot.workspaceFor("bot-a")).write("a.txt", "a");
    await (await perBot.workspaceFor("shared")).write("b.txt", "b");
    const listed = await (await perBot.workspaceFor("bot-b")).list();
    expect(listed.entries.map((entry) => entry.path).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
    expect(perBot.homeFor("bot-a")).toBe(root);
    expect(calls).toEqual([]);
    expect(await perBot.status()).toEqual({ enabled: false, ready: true });
  });

  test("switched on: an employee is ensured once, and the default employee never", async () => {
    const { calls, helper } = fakeHelper(() => ({ code: 0 }));
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper,
    });
    await perBot.workspaceFor("bot-a");
    await perBot.workspaceFor("bot-a");
    expect(calls).toEqual([["ensure", botKeyOf("bot-a")]]);
    await perBot.workspaceFor("shared");
    expect(calls).toEqual([["ensure", botKeyOf("bot-a")]]);
    expect(perBot.homeFor("bot-a")).toBe(join(root, "bots", botKeyOf("bot-a")));
    expect(perBot.homeFor("shared")).toBe(root);
  });

  test("a helper that fails is an unavailable computer, and the next call asks again", async () => {
    let code = 1;
    const { calls, helper } = fakeHelper(() => ({
      code,
      stderr: "sudo: a password is required\n",
    }));
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper,
    });
    const failure = await perBot.workspaceFor("bot-a").catch((error) => error);
    expect(failure).toBeInstanceOf(PerBotUnavailableError);
    expect((failure as Error).message).toStartWith("员工独立电脑未就绪：");
    expect((failure as Error).message).toContain(
      "sudo: a password is required",
    );
    code = 0;
    await perBot.workspaceFor("bot-a");
    expect(calls).toEqual([
      ["ensure", botKeyOf("bot-a")],
      ["ensure", botKeyOf("bot-a")],
    ]);
  });

  test("a helper that cannot be started is an unavailable computer too", async () => {
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper: async () => {
        throw new Error("spawn sudo ENOENT");
      },
    });
    const failure = await perBot.ensure("bot-a").catch((error) => error);
    expect(failure).toBeInstanceOf(PerBotUnavailableError);
    expect((failure as Error).message).toContain("spawn sudo ENOENT");
  });

  test.each([
    [0, true],
    [1, false],
  ])(
    "status follows the helper's answer (exit %d → ready %p), asked once",
    async (code, ready) => {
      const { calls, helper } = fakeHelper(() => ({
        code,
        stderr: "no helper",
      }));
      const perBot = createPerBotComputer({
        workspaceRoot: root,
        defaultBotId: "shared",
        enabled: true,
        helper,
      });
      const status = await perBot.status();
      expect(status.enabled).toBe(true);
      expect(status.ready).toBe(ready);
      // The detail is the helper's stderr, which /health (open to anyone) must not repeat.
      if (!ready) expect(status.reason).toBe("员工独立电脑的辅助程序不可用");
      await perBot.status();
      expect(calls).toEqual([["ensure", botKeyOf("__probe__")]]);
    },
  );

  test("one employee's file is not in another employee's listing", async () => {
    const { helper } = fakeHelper(() => ({ code: 0 }));
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper,
    });
    await (await perBot.workspaceFor("bot-a")).write("x.txt", "from a");
    const seenByB = await (await perBot.workspaceFor("bot-b")).list();
    expect(seenByB.entries.map((entry) => entry.path)).not.toContain("x.txt");
    const seenByA = await (await perBot.workspaceFor("bot-a")).list();
    expect(seenByA.entries.map((entry) => entry.path)).toContain("x.txt");
  });

  test("shellFor: the default employee keeps the shared shell, and nobody is ensured for it", async () => {
    const { calls, helper } = fakeHelper(() => ({ code: 0 }));
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper,
    });
    const shell = await perBot.shellFor("shared");
    expect(await perBot.shellFor("shared")).toBe(shell);
    const result = await shell.run({ command: "pwd" });
    expect(result.stdout.trim()).toBe(root);
    expect(calls).toEqual([]);
  });

  test("shellFor: an employee is ensured once, then its commands go to the helper as its own key, in its own directory", async () => {
    const { calls, helper } = fakeHelper(() => ({ code: 0 }));
    const launcher = join(root, "fake-xb.sh");
    await writeFile(
      launcher,
      [
        "#!/bin/sh",
        'echo "$@"',
        'while IFS= read -r line; do [ -z "$line" ] && break; done',
        'exec sh -c "$(cat)"',
        "",
      ].join("\n"),
    );
    await chmod(launcher, 0o755);
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper,
      launcher: [launcher],
    });
    const shell = await perBot.shellFor("bot-a");
    expect(await perBot.shellFor("bot-a")).toBe(shell);
    expect(calls).toEqual([["ensure", botKeyOf("bot-a")]]);
    const result = await shell.run({ command: "pwd", timeoutMs: 5_000 });
    expect(result.stdout).toContain(`run ${botKeyOf("bot-a")} 5\n`);
    expect(result.stdout).toContain(
      `${join(root, "bots", botKeyOf("bot-a"))}\n`,
    );
  });

  test("shellFor: an unavailable helper is an error, never the shared shell", async () => {
    const { helper } = fakeHelper(() => ({ code: 65, stderr: "no user" }));
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper,
    });
    const failure = await perBot.shellFor("bot-a").catch((error) => error);
    expect(failure).toBeInstanceOf(PerBotUnavailableError);
  });
});

/**
 * Readiness, as /health reports it.
 *
 * /health needs no token, so a probe is not run per request; but a failure that happens once (two
 * `useradd`s racing at start-up) must not leave the computer unready until it restarts.
 */
describe("createPerBotComputer status", () => {
  const PROBE = ["ensure", botKeyOf("__probe__")];
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "per-bot-status-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function setup(answer: () => Promise<{ code: number; stderr?: string }>) {
    const calls: string[][] = [];
    const options: ({ timeoutMs?: number } | undefined)[] = [];
    const logged: string[] = [];
    let clock = 1_000_000;
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper: async (args, given) => {
        calls.push(args);
        options.push(given);
        const { code, stderr = "" } = await answer();
        return { code, stdout: "", stderr };
      },
      now: () => clock,
      log: (detail) => logged.push(detail),
    });
    return {
      perBot,
      calls,
      options,
      logged,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test("a failure is remembered for 30 seconds, then asked again; a success for good", async () => {
    let code = 1;
    const { perBot, calls, logged, advance } = setup(async () => ({
      code,
      stderr: "useradd: cannot lock /etc/passwd",
    }));
    expect(await perBot.status()).toEqual({
      enabled: true,
      ready: false,
      reason: "员工独立电脑的辅助程序不可用",
    });
    expect(logged.join("\n")).toContain("cannot lock /etc/passwd");
    advance(29_000);
    expect((await perBot.status()).ready).toBe(false);
    expect(calls).toEqual([PROBE]);

    code = 0;
    advance(2_000);
    expect(await perBot.status()).toEqual({ enabled: true, ready: true });
    expect(calls).toEqual([PROBE, PROBE]);
    advance(86_400_000);
    expect((await perBot.status()).ready).toBe(true);
    expect(calls).toEqual([PROBE, PROBE]);
  });

  test("callers at the same moment share one probe", async () => {
    const { perBot, calls } = setup(async () => {
      await Bun.sleep(20);
      return { code: 0 };
    });
    const [a, b] = await Promise.all([perBot.status(), perBot.status()]);
    expect(a.ready && b.ready).toBe(true);
    expect(calls).toEqual([PROBE]);
  });

  test("a probe gets five seconds, and one that hangs is unready rather than a hung /health", async () => {
    const { perBot, options, logged } = setup(() => new Promise(() => {}));
    const started = Date.now();
    const status = await perBot.status();
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(status).toEqual({
      enabled: true,
      ready: false,
      reason: "员工独立电脑的辅助程序不可用",
    });
    expect(options[0]?.timeoutMs).toBe(5_000);
    expect(logged.join("\n")).toContain("超时");
  }, 15_000);

  test("an employee prepared successfully is proof enough that the helper works", async () => {
    let code = 1;
    const { perBot, calls, advance } = setup(async () => ({ code }));
    expect((await perBot.status()).ready).toBe(false);
    code = 0;
    await perBot.ensure("bot-a");
    expect((await perBot.status()).ready).toBe(true);
    advance(60_000);
    expect((await perBot.status()).ready).toBe(true);
    expect(calls).toEqual([PROBE, ["ensure", botKeyOf("bot-a")]]);
  });

  test("a workspace that is not the helper's is never ready, and nobody is prepared in it", async () => {
    const calls: string[][] = [];
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helperRoot: "/workspace",
      helper: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(await perBot.status()).toEqual({
      enabled: true,
      ready: false,
      reason: "每员工模式要求工作目录为 /workspace",
    });
    const failure = await perBot.workspaceFor("bot-a").catch((error) => error);
    expect(failure).toBeInstanceOf(PerBotUnavailableError);
    expect((failure as Error).message).toContain(
      "每员工模式要求工作目录为 /workspace",
    );
    expect(
      await perBot.shellFor("bot-a").catch((error) => error),
    ).toBeInstanceOf(PerBotUnavailableError);
    expect(calls).toEqual([]);
    // The default employee is not the helper's business, and keeps working.
    await (await perBot.workspaceFor("shared")).write("ok.txt", "ok");
  });

  test("the helper's own root, however it is written, is accepted", async () => {
    const perBot = createPerBotComputer({
      workspaceRoot: `${root}/`,
      defaultBotId: "shared",
      enabled: true,
      helperRoot: root,
      helper: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect((await perBot.status()).ready).toBe(true);
  });
});

/**
 * The helper refusing to run a command is the computer not being ready, not the command failing.
 *
 * 64 is the helper refusing its arguments and 65 the employee's user missing (deleted, or a restore
 * that has not run). Reported as the command's exit code, a model would rewrite and retry a command
 * that never ran.
 */
describe("createPerBotComputer, when the helper refuses to run", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "per-bot-refused-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function computerWhoseHelperExits(code: number) {
    const calls: string[][] = [];
    const launcher = join(root, "fake-xb.sh");
    await writeFile(
      launcher,
      ["#!/bin/sh", "cat >/dev/null", `exit ${code}`, ""].join("\n"),
    );
    await chmod(launcher, 0o755);
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      launcher: [launcher],
      helper: async (args) => {
        calls.push(args);
        await mkdir(join(root, "bots", String(args[1])), { recursive: true });
        return { code: 0, stdout: "20001\n", stderr: "" };
      },
    });
    return { perBot, calls };
  }

  test.each([
    [64, "64"],
    [65, "65"],
  ])("exit %d is an unavailable computer", async (code, shown) => {
    const { perBot } = await computerWhoseHelperExits(code);
    const shell = await perBot.shellFor("bot-a");
    const failure = await shell
      .run({ command: "echo hi" })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(PerBotUnavailableError);
    expect((failure as Error).message).toStartWith("员工独立电脑未就绪：");
    expect((failure as Error).message).toContain(shown);
  });

  test("a missing user is prepared again on the next call", async () => {
    const { perBot, calls } = await computerWhoseHelperExits(65);
    await (await perBot.shellFor("bot-a"))
      .run({ command: "true" })
      .catch(() => {});
    await perBot.shellFor("bot-a");
    expect(calls).toEqual([
      ["ensure", botKeyOf("bot-a")],
      ["ensure", botKeyOf("bot-a")],
    ]);
  });

  test("any other exit is the command's own answer", async () => {
    const { perBot } = await computerWhoseHelperExits(1);
    const result = await (await perBot.shellFor("bot-a")).run({
      command: "false",
    });
    expect(result.exitCode).toBe(1);
  });

  test("the default employee's own exit 65 is just its exit code", async () => {
    const { perBot } = await computerWhoseHelperExits(0);
    const result = await (await perBot.shellFor("shared")).run({
      command: "exit 65",
    });
    expect(result.exitCode).toBe(65);
  });
});

describe("createPerBotComputer, an employee's own files", () => {
  test("are opened and then checked, as only the confined workspace does", async () => {
    const root = await mkdtemp(join(tmpdir(), "per-bot-confined-"));
    try {
      const perBot = createPerBotComputer({
        workspaceRoot: root,
        defaultBotId: "shared",
        enabled: true,
        helper: async (args) => {
          await mkdir(join(root, "bots", String(args[1])), { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      const workspace = await perBot.workspaceFor("bot-a");
      // A named pipe: the shared workspace's open would wait for a writer; the confined one refuses.
      execFileSync("mkfifo", [join(perBot.homeFor("bot-a"), "pipe")]);
      const outcome = await Promise.race([
        workspace.read("pipe").then(
          () => "read",
          () => "refused",
        ),
        Bun.sleep(3_000).then(() => "hung"),
      ]);
      expect(outcome).toBe("refused");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The helper's own time limit, when whatever it started keeps its output open.
 *
 * Killing the launcher is not enough: a child that inherited its stdout keeps the pipe open, `close`
 * never comes, and an `ensure` that never settles is cached, so every later call for that employee
 * waits on it too.
 */
describe("helperRunner", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "per-bot-helper-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function launcherWithLingeringChild() {
    const path = join(root, "fake-xb.sh");
    await writeFile(
      path,
      [
        "#!/bin/sh",
        `echo called >> '${root}/calls'`,
        // A child that holds the inherited pipes for two seconds, and a launcher that waits for it.
        "sleep 2 &",
        "wait",
        "",
      ].join("\n"),
    );
    await chmod(path, 0o755);
    return path;
  }

  test("past its limit it answers at once as a failure, not when the pipes finally close", async () => {
    const run = helperRunner([await launcherWithLingeringChild()]);
    const started = Date.now();
    const result = await run(["ensure", "0123456789ab"], { timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.code).not.toBe(0);
  });

  test("an ensure that ran out of time is not remembered: the next call asks again", async () => {
    const perBot = createPerBotComputer({
      workspaceRoot: root,
      defaultBotId: "shared",
      enabled: true,
      helper: helperRunner([await launcherWithLingeringChild()], 100),
    });
    const started = Date.now();
    await expect(perBot.ensure("bot-a")).rejects.toBeInstanceOf(
      PerBotUnavailableError,
    );
    await expect(perBot.ensure("bot-a")).rejects.toBeInstanceOf(
      PerBotUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(1_500);
    const calls = (await readFile(join(root, "calls"), "utf8")).trim();
    expect(calls.split("\n")).toHaveLength(2);
  });
});
