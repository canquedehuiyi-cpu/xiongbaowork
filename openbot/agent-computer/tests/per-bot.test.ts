import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  botHome,
  botKeyOf,
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
