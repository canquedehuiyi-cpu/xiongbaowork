import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  botHome,
  botKeyOf,
  createPerBotComputer,
  type HelperRunner,
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
      if (!ready) expect(status.reason).toContain("no helper");
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
});
