import { describe, expect, test } from "bun:test";
import {
  classifyDesktopKeys,
  DEFAULT_DESKTOP_ACTION_WORDS,
  DESKTOP_ACTIONS,
  DESKTOP_APP_NAME,
  DESKTOP_APPROVAL_WORDS,
  DESKTOP_KEYS,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_SELF_PROCESSES,
  DESKTOP_SELF_WINDOW_REASON,
  DESKTOP_TERMINAL_PROCESSES,
  DESKTOP_TEXT_ROLES,
  DESKTOP_WINDOW_ID,
  DESKTOP_WINDOW_WORDS,
  type DesktopWritePayload,
  type DesktopWriteRequest,
  desktopActionWordHit,
  desktopActionWordsOf,
  desktopActivationKey,
  desktopMessage,
  desktopPlatformOf,
  desktopSelfOrTerminalProcess,
  desktopSelfWindowReason,
  desktopTextNeedsApproval,
  desktopWindowWordHit,
  desktopWindowWordHits,
  desktopWordHit,
  desktopWordHits,
  isAgentWindowId,
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

  test("the read, session and write actions exist, nothing else", () => {
    expect([...DESKTOP_ACTIONS].sort()).toEqual([
      "desktop.click",
      "desktop.clipboard_read",
      "desktop.clipboard_write",
      "desktop.focus",
      "desktop.key",
      "desktop.launch",
      "desktop.session_end",
      "desktop.session_start",
      "desktop.session_status",
      "desktop.snapshot",
      "desktop.type",
      "desktop.wait",
      "desktop.windows",
    ]);
  });

  test("DESKTOP_ACTIONS is exactly the thirteen actions: three reads, three session actions, seven writes", () => {
    expect([...DESKTOP_ACTIONS]).toEqual([
      "desktop.windows",
      "desktop.snapshot",
      "desktop.session_start",
      "desktop.session_status",
      "desktop.session_end",
      "desktop.click",
      "desktop.type",
      "desktop.key",
      "desktop.focus",
      "desktop.wait",
      "desktop.launch",
      "desktop.clipboard_read",
      "desktop.clipboard_write",
    ]);
  });

  test("outcome_unknown carries the spec's copy", () => {
    expect(desktopMessage("outcome_unknown")).toBe(
      "不确定这一步是否已经生效，请先重新读取窗口确认。",
    );
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
      adCommandTimeoutMs: 20_000,
      adSnapshotTimeoutMs: 10_000,
      adIdleWipeMs: 600_000,
      windowIdsKept: 200,
      sessionIdleMs: 900_000,
      sessionMaxMs: 3_600_000,
      headedAckMs: 1_000,
      sessionReadyMs: 2_000,
      textMaxBytes: 9_000,
      clipboardReadMaxChars: 8_000,
      waitMaxSec: 30,
    });
  });

  test("sensitiveWord finds 银行 in 招商银行 - Google Chrome and nothing in 无标题 - 记事本", () => {
    expect(DESKTOP_WINDOW_WORDS).toEqual([
      "密码",
      "银行",
      "支付",
      "password",
      "bank",
      "paypal",
    ]);
    for (const title of [
      "1Password - Vault",
      "Bank of America - Chrome",
      "PayPal: Log in",
    ])
      expect(sensitiveWord(title, DESKTOP_WINDOW_WORDS)).toBeDefined();
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

  test("new codes carry the spec's copy", () => {
    expect(desktopMessage("unsupported_platform")).toBe(
      "这台设备的系统不支持桌面操作。",
    );
    expect(desktopMessage("mac_permission")).toBe(
      "这台 Mac 还没有允许设备端操作界面，请在设备端的『桌面操作』里开启。",
    );
    expect(desktopMessage("linux_bus")).toBe(
      "这台 Linux 电脑没有开启无障碍总线（AT-SPI），看不到窗口。请在系统设置里打开辅助功能后重新登录。",
    );
    expect(desktopMessage("policy_denied")).toBe(
      "这个控件不支持直接操作，请换一种方式（例如用快捷键）。",
    );
    expect(desktopMessage("ambiguous")).toBe(
      "这个控件没有可识别的名字，无法确定要操作哪一个。",
    );
    expect(desktopMessage("not_actionable")).toBe(
      "这个控件不能直接操作，请换一个控件或用快捷键。",
    );
  });

  test("window ids: the legacy and the agent-desktop forms both pass, junk does not", () => {
    expect(DESKTOP_WINDOW_ID.test("a0123456789abcdef")).toBe(true);
    expect(isAgentWindowId("a0123456789abcdef")).toBe(true);
    expect(isAgentWindowId("w132456-77")).toBe(false);
    expect(DESKTOP_WINDOW_ID.test("w132456-77")).toBe(true);
    for (const junk of ["a0123456789abcde", "A0123456789ABCDEF", "w0-1"]) {
      expect(DESKTOP_WINDOW_ID.test(junk)).toBe(false);
      expect(isAgentWindowId(junk)).toBe(false);
    }
    // An agent id is not a legacy `w<hwnd>-<pid>`.
    expect(parseWindowId("a0123456789abcdef")).toBeUndefined();
  });

  test("the session codes carry the plan's and the spec's copy", () => {
    const copy: Array<[Parameters<typeof desktopMessage>[0], string]> = [
      ["stopped", "用户已停止桌面操作，需要重新获得授权。"],
      [
        "session_expired",
        "桌面会话已结束（15 分钟没有操作或已满 60 分钟），需要重新获得授权。",
      ],
      ["no_session", "没有进行中的桌面会话，需要重新获得授权。"],
      [
        "no_control_channel",
        "只有在设备端应用里运行时才能操作桌面（需要提示条和停止键）。",
      ],
      [
        "headed_unconfirmed",
        "设备端没有确认暂停『动鼠标即停』，为安全起见没有执行这一步。",
      ],
      ["read_only_linux", "这台 Linux 电脑目前只能查看，不能操作界面。"],
      [
        "read_only_windows",
        "这台 Windows 电脑暂时只能查看，操作界面的功能还在验收。",
      ],
      [
        "guard_unready",
        "设备端没能显示提示条或注册停止键，为安全起见没有开始操作。",
      ],
    ];
    for (const [code, text] of copy) expect(desktopMessage(code)).toBe(text);
  });

  test("the per-action codes carry the plan's copy", () => {
    expect(desktopMessage("system_keys", "win+r")).toBe(
      "这个组合键（win+r）是系统级的，员工不能按。",
    );
    expect(desktopMessage("needs_approval", "控件名含「发送」")).toBe(
      "这一步需要先获得批准（控件名含「发送」）。请重新读取窗口后再试。",
    );
    expect(desktopMessage("password_field")).toBe(
      "这是密码框，员工不能往里输入。请用 computer_request_secret 让主人自己输入。",
    );
    expect(desktopMessage("not_foreground")).toBe(
      "这个窗口不在前台，请先用 computer_desktop_focus 把它切到前台。",
    );
  });

  test("classifyDesktopKeys: system, close, submit, plain, and junk", () => {
    for (const keys of [
      "win+r",
      "WIN+R",
      "ctrl+win+r",
      "cmd+space",
      "ctrl+alt+delete",
    ])
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind: "system",
      });
    expect(classifyDesktopKeys("alt+f4")).toEqual({
      kind: "close",
      normalized: "alt+f4",
      force: true,
    });
    expect(classifyDesktopKeys("cmd+w")).toEqual({
      kind: "close",
      normalized: "cmd+w",
      force: false,
    });
    for (const keys of ["enter", "ctrl+enter", "cmd+return"])
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind: "submit",
      });
    for (const keys of ["shift+enter", "ctrl+s", "pagedown"])
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind: "plain",
      });
    for (const keys of ["ctrl+alt+shift+cmd+x", "ctrl+", "f13"]) {
      expect({ keys, out: classifyDesktopKeys(keys) }).toEqual({
        keys,
        out: undefined,
      });
      expect({ keys, ok: DESKTOP_KEYS.test(keys) }).toEqual({
        keys,
        ok: false,
      });
    }
  });

  test("classifyDesktopKeys normalises case, order and the win aliases", () => {
    expect(classifyDesktopKeys("WIN+R")?.normalized).toBe("win+r");
    expect(classifyDesktopKeys("Super+R")?.normalized).toBe("win+r");
    expect(classifyDesktopKeys("meta+d")?.kind).toBe("system");
    expect(classifyDesktopKeys("shift+ctrl+s")?.normalized).toBe(
      "ctrl+shift+s",
    );
    expect(classifyDesktopKeys("cmd+q")).toEqual({
      kind: "close",
      normalized: "cmd+q",
      force: true,
    });
    // Only alt+f4 and cmd+q are ever forced, not a superset of them.
    expect(classifyDesktopKeys("ctrl+alt+f4")).toEqual({
      kind: "close",
      normalized: "ctrl+alt+f4",
      force: false,
    });
    // agent-desktop reads meta as Command on a Mac: a combination with win is also read as cmd.
    for (const [keys, kind] of [
      ["meta+q", "close"],
      ["win+w", "close"],
      ["win+enter", "submit"],
      ["meta+space", "system"],
      ["ctrl+shift+esc", "system"],
    ] as const)
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind,
      });
    // Read as cmd, but never forced: only alt+f4 and cmd+q as typed.
    expect(classifyDesktopKeys("meta+q")?.force).toBe(false);
    // A doubled modifier is junk.
    expect(classifyDesktopKeys("ctrl+ctrl+x")).toBeUndefined();
    for (const keys of ["win+r", "ctrl+enter", "pagedown", "shift+tab"])
      expect({ keys, ok: DESKTOP_KEYS.test(keys) }).toEqual({ keys, ok: true });
  });

  test("the coordinator's further system keys, and more modifiers on them", () => {
    for (const keys of [
      "cmd+alt+escape",
      "cmd+alt+esc",
      "win+tab",
      "alt+space",
      "ctrl+escape",
      "ctrl+esc",
      "ctrl+alt+space",
      "shift+win+tab",
    ])
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind: "system",
      });
    // Their neighbours stay plain.
    for (const keys of ["escape", "tab", "space", "alt+escape", "ctrl+tab"])
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind: "plain",
      });
  });

  test("window titles match by substring or by whole word, whichever is stricter", () => {
    for (const [title, word] of [
      ["1Password", "password"],
      ["Passwords", "password"],
      ["Chase Online Banking", "bank"],
      ["Online-Banking", "bank"],
      ["Embankment notes", "bank"],
      ["招商银行", "银行"],
      ["PayPal - Checkout", "paypal"],
    ])
      expect({ title, hit: desktopWindowWordHit(title) }).toEqual({
        title,
        hit: word,
      });
    for (const title of ["无标题 - 记事本", "Display settings", ""])
      expect({ title, hit: desktopWindowWordHit(title) }).toEqual({
        title,
        hit: undefined,
      });
  });

  test("a team's action words drop blank words, and an empty list is the default", () => {
    expect(desktopActionWordsOf(undefined)).toBe(DEFAULT_DESKTOP_ACTION_WORDS);
    expect(desktopActionWordsOf([])).toBe(DEFAULT_DESKTOP_ACTION_WORDS);
    expect(desktopActionWordsOf(["", "  ", "\t"])).toBe(
      DEFAULT_DESKTOP_ACTION_WORDS,
    );
    expect(desktopActionWordsOf(["归档", " ", ""])).toEqual(["归档"]);
  });

  test("desktopWordHit: Chinese by substring, ASCII by whole word", () => {
    expect(desktopWordHit("发送(S)", DEFAULT_DESKTOP_ACTION_WORDS)).toBe(
      "发送",
    );
    expect(
      desktopWordHit("Display", DEFAULT_DESKTOP_ACTION_WORDS),
    ).toBeUndefined();
    expect(desktopWordHit("Pay now", DEFAULT_DESKTOP_ACTION_WORDS)).toBe("pay");
    expect(desktopWordHit("DELETE", DEFAULT_DESKTOP_ACTION_WORDS)).toBe(
      "delete",
    );
    expect(
      desktopWordHit("确定", DEFAULT_DESKTOP_ACTION_WORDS),
    ).toBeUndefined();
    expect(desktopWordHit("anything", ["", " "])).toBeUndefined();
  });

  test("the default action words are the spec's seventeen", () => {
    expect([...DEFAULT_DESKTOP_ACTION_WORDS]).toEqual([
      "发送",
      "删除",
      "付款",
      "支付",
      "提交",
      "确认支付",
      "转账",
      "购买",
      "下单",
      "发布",
      "撤回",
      "注销",
      "send",
      "delete",
      "pay",
      "submit",
      "purchase",
    ]);
  });

  test("desktopPlatformOf maps win32, darwin, linux and nothing else", () => {
    expect(desktopPlatformOf("win32")).toBe("windows");
    expect(desktopPlatformOf("darwin")).toBe("macos");
    expect(desktopPlatformOf("linux")).toBe("linux");
    for (const other of ["freebsd", "aix", "", "Windows"])
      expect(desktopPlatformOf(other)).toBeUndefined();
  });

  test("desktopActivationKey: space alone or with shift only", () => {
    for (const keys of ["space", "SPACE", "shift+space", "Shift+Space"])
      expect({ keys, hit: desktopActivationKey(keys) }).toEqual({
        keys,
        hit: true,
      });
    for (const keys of [
      "ctrl+space",
      "alt+space",
      "cmd+space",
      "shift+ctrl+space",
      "enter",
      "tab",
      "s",
      "space+",
      "",
    ])
      expect({ keys, hit: desktopActivationKey(keys) }).toEqual({
        keys,
        hit: false,
      });
  });

  test("desktopTextNeedsApproval: C0, DEL, NEL, LS and PS; CR and LF only in a multi-line box", () => {
    for (const text of ["", "plain 熊宝 ✓", "a b", " ", "\u0086"])
      for (const multiline of [false, true])
        expect(desktopTextNeedsApproval(text, multiline)).toBe(false);
    for (const text of ["a\nb", "a\rb", "a\r\nb"]) {
      expect(desktopTextNeedsApproval(text, false)).toBe(true);
      expect(desktopTextNeedsApproval(text, true)).toBe(false);
    }
    for (const text of [
      "\u0000",
      "a\tb",
      "\u000b",
      "\u000c",
      "\u001f",
      "\u007f",
      "\u0085",
      " ",
      " ",
    ])
      for (const multiline of [false, true])
        expect({
          text,
          multiline,
          hit: desktopTextNeedsApproval(text, multiline),
        }).toEqual({
          text,
          multiline,
          hit: true,
        });
  });

  test("DESKTOP_APP_NAME takes an app's name and nothing that is a path or a flag", () => {
    for (const app of [
      "notepad",
      "Safari",
      "TextEdit",
      "calc.exe",
      "Microsoft Edge",
      "微信",
      "Visual Studio Code (Insiders)",
      "a".repeat(64),
    ])
      expect({ app, ok: DESKTOP_APP_NAME.test(app) }).toEqual({
        app,
        ok: true,
      });
    for (const app of [
      "",
      "/bin/sh",
      "-x",
      "--help",
      "../a",
      ".hidden",
      "a/b",
      "C:\\Windows\\notepad.exe",
      "a;b",
      "a\nb",
      " notepad",
      "a".repeat(65),
      "notepad -x",
      "notepad --arg",
      "a - b",
      "a\t-x",
    ])
      expect({ app, ok: DESKTOP_APP_NAME.test(app) }).toEqual({
        app,
        ok: false,
      });
  });

  test("a desktop write's payload is typed by its action", () => {
    const common = {
      session: "t",
      botId: "b",
      actorId: "a",
      approved: false,
      actionWords: [],
    };
    const click: DesktopWritePayload<"desktop.click"> = { ...common, ref: "r" };
    const read: DesktopWriteRequest = {
      action: "desktop.clipboard_read",
      payload: { ...common, approved: true },
    };
    const unapproved: DesktopWriteRequest = {
      action: "desktop.clipboard_read",
      // @ts-expect-error a clipboard read is sent only once approved
      payload: common,
    };
    // @ts-expect-error a click names its control
    const noRef: DesktopWritePayload<"desktop.click"> = common;
    const noRefRequest: DesktopWriteRequest = {
      action: "desktop.click",
      // @ts-expect-error a click names its control, whatever else could carry no target
      payload: common,
    };
    const noApp: DesktopWriteRequest = {
      action: "desktop.launch",
      // @ts-expect-error a launch names its app
      payload: { ...common, text: "x" },
    };
    expect([click, read, unapproved, noRef, noRefRequest, noApp]).toHaveLength(
      6,
    );
  });

  test("the text roles a desktop type may write into", () => {
    expect([...DESKTOP_TEXT_ROLES]).toEqual([
      "textfield",
      "textarea",
      "searchfield",
      "combobox",
    ]);
  });
});

/*
 * The final whole-branch review (final-fix-brief.md): C1, I1, I3 and M2. Every one only asks more.
 */
describe("desktop-control: the final review's fixes", () => {
  test("C1: the device app, the runner, the desktop client and terminals are told apart by process", () => {
    // The packaged names: desktop-device/src-tauri/tauri.conf.json (productName, mainBinaryName),
    // sidecar.rs (SIDECAR, LEGACY_SIDECAR), desktop/src-tauri (productName, the Cargo bin).
    expect([...DESKTOP_SELF_PROCESSES]).toEqual([
      "xiongbao-device",
      "熊宝数字员工 设备端",
      "xiongbao-runner",
      "openbot-runner",
      "openbot-desktop",
      "XiongBao",
    ]);
    expect([...DESKTOP_TERMINAL_PROCESSES]).toEqual([
      "Terminal",
      "iTerm2",
      "cmd.exe",
      "powershell.exe",
      "pwsh.exe",
      "WindowsTerminal.exe",
      "conhost.exe",
      "gnome-terminal",
      "gnome-terminal-server",
      "konsole",
      "xterm",
      // Round 2 (Important-3): the Chinese macOS name, more terminals, and the 15-character name
      // /proc/<pid>/comm keeps for gnome-terminal-server.
      "终端",
      "Warp",
      "Ghostty",
      "Alacritty",
      "kitty",
      "WezTerm",
      "Tabby",
      "Hyper",
      "xfce4-terminal",
      "tilix",
      "terminator",
      "mintty",
      "OpenConsole.exe",
      "gnome-terminal-",
      // Their Linux process names where the app's is not one: WezTerm's and Warp's.
      "wezterm-gui",
      "warp-terminal",
    ]);
    for (const process of [
      ...DESKTOP_SELF_PROCESSES,
      ...DESKTOP_TERMINAL_PROCESSES,
      "xiongbao-device.exe",
      "XIONGBAO-RUNNER.EXE",
      "openbot-desktop.exe",
      "XiongBao.app",
      "/Applications/XiongBao.app",
      "C:\\Program Files\\Xiongbao Device\\xiongbao-device.exe",
      "/opt/xiongbao-device/xiongbao-runner",
      "POWERSHELL.EXE",
      "cmd",
      " Terminal ",
      "WindowsTerminal",
    ])
      expect({ process, hit: desktopSelfOrTerminalProcess(process) }).toEqual({
        process,
        hit: true,
      });
    for (const process of [
      "notepad.exe",
      "TextEdit",
      "WeChat",
      "Google Chrome",
      "terminal-notes",
      "my-xterm-theme",
      "",
      "   ",
    ])
      expect({ process, hit: desktopSelfOrTerminalProcess(process) }).toEqual({
        process,
        hit: false,
      });
    expect(desktopSelfOrTerminalProcess(undefined as unknown as string)).toBe(
      false,
    );
  });

  test("C1: the product's names count as window words when given, on top of the sensitive words", () => {
    const self = ["熊宝数字员工", "熊宝", "XiongBao Work"];
    expect(desktopWindowWordHit("待审批 - 熊宝数字员工 - Google Chrome")).toBe(
      undefined,
    );
    expect(
      desktopWindowWordHit("待审批 - 熊宝数字员工 - Google Chrome", self),
    ).toBe("熊宝数字员工");
    expect(desktopWindowWordHit("熊宝", self)).toBe("熊宝");
    expect(desktopWindowWordHit("Approvals · xiongbao work", self)).toBe(
      "XiongBao Work",
    );
    // The sensitive words come first; blank names never match.
    expect(desktopWindowWordHit("网上银行 - 熊宝", self)).toBe("银行");
    expect(desktopWindowWordHit("无标题 - 记事本", ["", "  ", "\u200b"])).toBe(
      undefined,
    );
    expect(desktopWindowWordHits("网上银行 - 熊宝数字员工", self)).toEqual([
      "银行",
      "熊宝数字员工",
      "熊宝",
    ]);
    expect(desktopWindowWordHits("无标题 - 记事本", self)).toEqual([]);
    expect(desktopSelfWindowReason("熊宝")).toBe(
      "这是熊宝自己的界面或命令行窗口，操作前需要你先确认",
    );
    expect(DESKTOP_SELF_WINDOW_REASON).toBe(desktopSelfWindowReason("熊宝"));
  });

  test("C1: approving and refusing are action words whatever the team's list", () => {
    expect([...DESKTOP_APPROVAL_WORDS]).toEqual([
      "批准",
      "允许",
      "同意",
      "拒绝",
      "approve",
      "allow",
      "deny",
      "reject",
    ]);
    for (const [name, word] of [
      ["允许一次", "允许"],
      ["批准", "批准"],
      ["同意并继续", "同意"],
      ["拒绝", "拒绝"],
      ["Allow once", "allow"],
      ["Approve", "approve"],
      ["Deny", "deny"],
      ["Reject all", "reject"],
    ])
      for (const team of [undefined, ["zzz"], ["归档"]])
        expect({
          name,
          team,
          hit: desktopActionWordHit(name, desktopActionWordsOf(team)),
        }).toEqual({ name, team, hit: word });
    // The team's own words first; whole words for ASCII as before.
    expect(desktopActionWordHit("发送", ["发送"])).toBe("发送");
    expect(desktopActionWordHit("Allowance", ["zzz"])).toBeUndefined();
    expect(desktopActionWordHit("保存词表", ["zzz"])).toBeUndefined();
    expect(desktopWordHits("拒绝并删除", ["删除", "发送"])).toEqual(["删除"]);
    expect(
      desktopWordHits("删除 send", [...DEFAULT_DESKTOP_ACTION_WORDS]),
    ).toEqual(["删除", "send"]);
  });

  test("M2: a zero-width character, a full-width letter or a space does not hide a word", () => {
    const words = DEFAULT_DESKTOP_ACTION_WORDS;
    for (const [name, word] of [
      ["删\u200b除", "删除"],
      ["删 除", "删除"],
      ["删\u3000除", "删除"],
      ["付\u200d款", "付款"],
      ["ｓｅｎｄ", "send"],
      ["Ｓｅｎｄ now", "send"],
      ["se\u00adnd", "send"],
      ["确认 支付", "支付"],
    ])
      expect({ name, hit: desktopWordHit(name, words) }).toEqual({
        name,
        hit: word,
      });
    // Whole words for ASCII still: no word is made by joining two.
    for (const name of ["Display", "Displ\u200bay", "Ｄｉｓｐｌａｙ"])
      expect({ name, hit: desktopWordHit(name, words) }).toEqual({
        name,
        hit: undefined,
      });
    for (const [title, word] of [
      ["网上银\u200b行", "银行"],
      ["密 码", "密码"],
      ["ＰａｙＰａｌ", "paypal"],
      ["pass\u200bword", "password"],
    ])
      expect({ title, hit: desktopWindowWordHit(title) }).toEqual({
        title,
        hit: word,
      });
    expect(sensitiveWord("网上银\u200b行", ["银行"])).toBe("银行");
    // A word that is only a space or an invisible character still never matches anything.
    expect(desktopWordHit("a b", [" ", "\u200b"])).toBeUndefined();
    // Matching only: what is shown is left as it is.
    expect(desktopWordHit("删\u200b除", ["删除"])).toBe("删除");
  });

  test("I3: deleting at once is asked about, like closing a program, with more modifiers too", () => {
    for (const keys of [
      "shift+delete",
      "Shift+Delete",
      "shift+forwarddelete",
      "cmd+backspace",
      "cmd+alt+backspace",
      "ctrl+shift+delete",
      "cmd+shift+backspace",
      "meta+backspace",
    ])
      expect({ keys, out: classifyDesktopKeys(keys) }).toEqual({
        keys,
        out: expect.objectContaining({ kind: "delete", force: false }),
      });
    expect(classifyDesktopKeys("shift+delete")?.normalized).toBe(
      "shift+delete",
    );
    for (const keys of [
      "delete",
      "backspace",
      "ctrl+backspace",
      "alt+backspace",
      "shift+backspace",
    ])
      expect({ keys, kind: classifyDesktopKeys(keys)?.kind }).toEqual({
        keys,
        kind: "plain",
      });
  });

  test("I3: alt with a letter or a digit may press a button on Windows and Linux, not on a Mac", () => {
    for (const platform of ["windows", "linux"] as const) {
      for (const keys of ["alt+s", "ALT+S", "alt+y", "alt+1", "alt+shift+s"])
        expect({
          platform,
          keys,
          hit: desktopActivationKey(keys, platform),
        }).toEqual({
          platform,
          keys,
          hit: true,
        });
      for (const keys of [
        "alt+f4",
        "alt+tab",
        "alt+enter",
        "ctrl+alt+s",
        "alt+-",
        "s",
      ])
        expect({
          platform,
          keys,
          hit: desktopActivationKey(keys, platform),
        }).toEqual({
          platform,
          keys,
          hit: false,
        });
      // Space as before.
      expect(desktopActivationKey("space", platform)).toBe(true);
    }
    for (const keys of ["alt+s", "alt+1"]) {
      expect(desktopActivationKey(keys, "macos")).toBe(false);
      // No platform: as before, Space alone or with Shift only.
      expect(desktopActivationKey(keys)).toBe(false);
    }
    expect(desktopActivationKey("shift+space", "macos")).toBe(true);
  });
});

describe("desktop-control: the product's own processes are its packaged names", () => {
  test("C1: the device app's binary, product name and sidecars, and the desktop client's, are all listed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const read = (path: string) =>
      readFileSync(join(import.meta.dir, "..", path), "utf8");
    const device = JSON.parse(read("desktop-device/src-tauri/tauri.conf.json"));
    const deviceLinux = JSON.parse(
      read("desktop-device/src-tauri/tauri.linux.conf.json"),
    );
    const sidecar = read("desktop-device/src-tauri/src/sidecar.rs");
    const client = JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
    const clientCargo = read("desktop/src-tauri/Cargo.toml");
    const constant = (name: string) =>
      new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(sidecar)?.[1];
    const bin = /\[\[bin\]\]\s*name = "([^"]+)"/.exec(clientCargo)?.[1];
    for (const name of [
      device.mainBinaryName,
      device.productName,
      deviceLinux.productName,
      constant("SIDECAR"),
      constant("LEGACY_SIDECAR"),
      client.productName,
      bin,
    ])
      expect({
        name,
        listed: desktopSelfOrTerminalProcess(String(name)),
      }).toEqual({
        name,
        listed: true,
      });
  });
});

describe("desktop-control: the final review, round 2", () => {
  test("Important-3: more terminals, by their names as listed", () => {
    for (const process of [
      "终端",
      "Warp",
      "ghostty",
      "alacritty",
      "kitty",
      "wezterm-gui",
      "WezTerm",
      "Tabby",
      "Hyper",
      "xfce4-terminal",
      "tilix",
      "terminator",
      "mintty.exe",
      "OpenConsole.exe",
      "gnome-terminal-",
      "gnome-terminal-server",
      "warp-terminal",
    ])
      expect({ process, hit: desktopSelfOrTerminalProcess(process) }).toEqual({
        process,
        hit: true,
      });
    for (const process of ["kitty-notes", "Hyperion", "终端机", "Warpinator"])
      expect({ process, hit: desktopSelfOrTerminalProcess(process) }).toEqual({
        process,
        hit: false,
      });
  });

  test("Minor-3: a product name of one character is ignored; an ASCII one matches only as a whole word", () => {
    expect(desktopWindowWordHits("甲 - Chrome", ["甲"])).toEqual([]);
    expect(desktopWindowWordHits("甲乙 - Chrome", ["甲", "甲乙"])).toEqual([
      "甲乙",
    ]);
    expect(desktopWindowWordHits("Jiangsu notes", ["Jia"])).toEqual([]);
    expect(desktopWindowWordHits("Approvals - Jia", ["Jia"])).toEqual(["Jia"]);
    expect(
      desktopWindowWordHits("XiongBao Workspace", ["XiongBao Work"]),
    ).toEqual([]);
    expect(
      desktopWindowWordHits("Approvals · XiongBao Work", ["XiongBao Work"]),
    ).toEqual(["XiongBao Work"]);
    // The sensitive words keep their substring reading.
    expect(desktopWindowWordHits("1Password", [])).toEqual(["password"]);
  });
});
