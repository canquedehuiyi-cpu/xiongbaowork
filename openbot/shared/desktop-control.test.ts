import { describe, expect, test } from "bun:test";
import {
  DESKTOP_ACTIONS,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
  DESKTOP_WINDOW_WORDS,
  desktopMessage,
  parseWindowId,
  sensitiveWord,
  windowIdOf,
} from "./desktop-control";

describe("desktop-control protocol", () => {
  test("messages are the spec's Chinese copy", () => {
    expect(desktopMessage("not_windows")).toBe(
      "这台设备不是 Windows，暂不支持桌面操作。",
    );
    expect(desktopMessage("no_window")).toBe(
      "找不到这个窗口，请重新列出窗口。",
    );
    expect(desktopMessage("stale")).toBe("界面已变化，请重新读取窗口。");
    expect(desktopMessage("elevated")).toBe(
      "这个窗口需要管理员权限，员工无法操作。",
    );
    expect(desktopMessage("start_failed", "boom")).toBe(
      "桌面助手启动失败：boom",
    );
    expect(desktopMessage("timeout", "15")).toBe(
      "桌面助手没有在 15 秒内完成这一步。",
    );
    expect(desktopMessage("session0")).toBe(
      "设备端运行在没有桌面的后台会话里，看不到窗口。请在已登录的桌面上运行设备端。",
    );
    expect(desktopMessage("sensitive", "银行")).toContain("银行");
    expect(desktopMessage("sensitive", "银行")).toBe(
      "这个窗口的标题刚刚变成含「银行」，需要先获得批准才能读取。请重新列出窗口后再试。",
    );
    expect(desktopMessage("unsupported")).toBe(
      "设备端目前只能列出和读取窗口，不能执行这个桌面动作。",
    );
    expect(desktopMessage("failed", "boom")).toBe("桌面操作没有成功：boom");
  });

  test("only the two read actions exist", () => {
    expect([...DESKTOP_ACTIONS].sort()).toEqual([
      "desktop.snapshot",
      "desktop.windows",
    ]);
  });

  test("the limits are the plan's numbers", () => {
    expect(DESKTOP_LIMITS).toEqual({
      treeMaxDepth: 12,
      treeMaxNodes: 800,
      requestTimeoutMs: 15_000,
      startTimeoutMs: 30_000,
      helperIdleMs: 600_000,
      screenshotMaxEdge: 1280,
      nameMax: 120,
      valueMax: 200,
      titleMax: 200,
      windowsMax: 50,
      snapshotsKept: 16,
      walkBudgetMs: 12_000,
    });
  });

  test("sensitiveWord finds 银行 in 招商银行 - Google Chrome and nothing in 无标题 - 记事本", () => {
    expect(DESKTOP_WINDOW_WORDS).toEqual(["密码", "银行", "支付"]);
    expect(
      sensitiveWord("招商银行 - Google Chrome", DESKTOP_WINDOW_WORDS),
    ).toBe("银行");
    expect(
      sensitiveWord("无标题 - 记事本", DESKTOP_WINDOW_WORDS),
    ).toBeUndefined();
    expect(sensitiveWord("My PASSWORD manager", ["password"])).toBe("password");
    expect(sensitiveWord("anything", [])).toBeUndefined();
  });

  test("DESKTOP_REF accepts a1b2c3-4:17 and refuses 4:17, a1b2c3-0:1, A1B2C3-4:17", () => {
    expect(DESKTOP_REF.test("a1b2c3-4:17")).toBe(true);
    expect(DESKTOP_REF.test("4:17")).toBe(false);
    expect(DESKTOP_REF.test("a1b2c3-0:1")).toBe(false);
    expect(DESKTOP_REF.test("A1B2C3-4:17")).toBe(false);
  });

  test("window ids round-trip and refuse junk", () => {
    expect(windowIdOf("132456", 77)).toBe("w132456-77");
    expect(DESKTOP_WINDOW_ID.test("w132456-77")).toBe(true);
    expect(parseWindowId(windowIdOf("132456", 77))).toEqual({
      hwnd: "132456",
      pid: 77,
    });
    for (const junk of ["w0-1", "w12-0", "12-7", "w12-7 ", 7]) {
      expect(parseWindowId(junk)).toBeUndefined();
    }
  });

  test("a negative window handle, as a 64-bit process writes it, round-trips too", () => {
    const id = windowIdOf("-2147483000", 77);
    expect(id).toBe("w-2147483000-77");
    expect(DESKTOP_WINDOW_ID.test(id)).toBe(true);
    expect(parseWindowId(id)).toEqual({ hwnd: "-2147483000", pid: 77 });
    for (const junk of [
      "w-0-1",
      "w--12-7",
      "w-12--7",
      "w-12-0",
      "w-12",
      "w+12-7",
    ])
      expect(parseWindowId(junk)).toBeUndefined();
  });
});
