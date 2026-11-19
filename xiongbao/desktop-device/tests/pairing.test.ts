/**
 * The pairing window's rules (ui/pairing.js), without a window: what the form accepts, what it says
 * when it does not, which screen each state shows, and what is handed to the shell's `pair` command.
 */
import { expect, test } from "bun:test";
import {
  describeState,
  normalizeServer,
  screenFor,
  submitPairing,
  validatePairing,
} from "../ui/pairing.js";

const form = {
  server: " https://bot.example.com/ ",
  code: " AB12CD34 ",
  name: " 前台电脑 ",
};

test("a filled-in form is tidied and passed on", () => {
  expect(validatePairing(form)).toEqual({
    ok: true,
    value: {
      server: "https://bot.example.com",
      code: "AB12CD34",
      name: "前台电脑",
    },
  });
});

test("each field says what is wrong with it, in Chinese", () => {
  expect(validatePairing({ ...form, server: "bot.example.com" })).toEqual({
    ok: false,
    field: "server",
    error: "服务器地址需要以 https:// 或 http:// 开头。",
  });
  expect(validatePairing({ ...form, code: "   " })).toMatchObject({
    ok: false,
    field: "code",
    error: "请输入配对码。",
  });
  expect(validatePairing({ ...form, code: "AB 12" })).toMatchObject({
    field: "code",
  });
  expect(validatePairing({ ...form, name: "名".repeat(121) })).toMatchObject({
    field: "name",
  });
  expect(validatePairing({ ...form, name: "名".repeat(120) }).ok).toBe(true);
});

test("server addresses match the runner's own rule", () => {
  expect(normalizeServer("http://10.0.0.5:3000//")).toEqual({
    server: "http://10.0.0.5:3000",
  });
  expect(normalizeServer("https://").error).toBe("服务器地址不完整。");
  expect(normalizeServer("ftp://x").error).toBeDefined();
});

test("submitting checks first and never calls the shell with a bad form", async () => {
  const calls: unknown[] = [];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
  };
  expect(await submitPairing({ ...form, code: "" }, invoke)).toBe(
    "请输入配对码。",
  );
  expect(calls).toEqual([]);

  expect(await submitPairing(form, invoke)).toBeNull();
  expect(calls).toEqual([
    [
      "pair",
      { server: "https://bot.example.com", code: "AB12CD34", name: "前台电脑" },
    ],
  ]);
});

test("a refusal from the shell is shown as it was given", async () => {
  const invoke = async () => {
    throw "这台电脑已配对到 https://a。";
  };
  expect(await submitPairing(form, invoke)).toBe(
    "这台电脑已配对到 https://a。",
  );
});

test("the window shows the form until a pairing works, then the status", () => {
  expect(screenFor({ paired: false, state: { state: "unpaired" } })).toBe(
    "form",
  );
  expect(screenFor({ paired: false, state: { state: "pairing" } })).toBe(
    "pairing",
  );
  expect(screenFor({ paired: false, state: { state: "failed" } })).toBe("form");
  expect(screenFor({ paired: true, state: { state: "offline" } })).toBe(
    "status",
  );
});

test("every state the shell reports has words, matching the tray's", () => {
  expect(describeState({ state: "online" })).toEqual({
    text: "在线",
    tone: "ok",
  });
  expect(describeState({ state: "offline" }).text).toBe("离线，正在重连");
  expect(
    describeState({ state: "restarting", attempt: 2, inSeconds: 4 }).text,
  ).toBe("设备端服务已退出，4 秒后第 2 次重启");
  expect(describeState({ state: "failed", message: "boom" })).toEqual({
    text: "出错：boom",
    tone: "bad",
  });
  expect(describeState({ state: "unpaired" }).text).toBe("未配对");
});
