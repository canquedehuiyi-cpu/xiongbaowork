import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
  DESKTOP_WINDOW_WORDS,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
} from "../../shared/desktop-control";
import { LOCAL_TOOL_DESCRIPTIONS } from "../../shared/local-tools";
import { createDesktopActions, desktopEngineFor } from "../src/desktop/actions";
import type { AgentDesktopReader } from "../src/desktop/ad-read";
import {
  createDesktopHost,
  DesktopHelperError,
  type HelperLaunchSpec,
} from "../src/desktop/host";
import { createRunnerExecutor } from "../src/execute";

/* desktop.windows and desktop.snapshot over the fake helper (Task 4). Read only: nothing else under
   `desktop.` ever reaches the helper. */

const FAKE = join(import.meta.dir, "fixtures", "fake-desktop-helper.ts");
const DIR = mkdtempSync(join(tmpdir(), "desktop-actions-"));
let logs = 0;
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Actions = ReturnType<typeof createDesktopActions>;
type Out = Awaited<ReturnType<Actions>>;

function setup(
  env: Record<string, string> = {},
  options: { mode?: string; timeoutMs?: number } = {},
) {
  const log = join(DIR, `requests-${++logs}.log`);
  const spec = (): HelperLaunchSpec => ({
    command: process.execPath,
    args: [FAKE],
    // The crash mode dies on its first input line, so give it one.
    ...(options.mode === "crash" ? { preamble: "Add-Type" } : {}),
    env: {
      FAKE_DESKTOP_MODE: options.mode ?? "ok",
      FAKE_DESKTOP_LOG: log,
      ...env,
    },
  });
  const host = createDesktopHost({
    spec,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const actions = createDesktopActions({ platform: "win32", host });
  closers.push(() => actions.close());
  const requests = (): Record<string, unknown>[] => {
    try {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((text) => JSON.parse(text));
    } catch {
      return [];
    }
  };
  return { actions, host, log, requests };
}

function output<T>(outcome: Out): T {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error}`);
  return outcome.output as T;
}

function snapshot(actions: Actions, body: Record<string, unknown> = {}) {
  return actions("desktop.snapshot", { windowId: "w4242-77", ...body });
}

function noUnknown(outcome: Out) {
  expect(outcome.ok).toBe(false);
  expect("outcomeUnknown" in outcome).toBe(false);
}

/** A host whose every call throws `error`, for errors the fake helper cannot be made to produce. */
function throwingActions(error: unknown, prefix?: string): Actions {
  const host = {
    prefix,
    running: false,
    ensure: async () => {
      throw error;
    },
    nextSnapshotId: () => `${prefix ?? "abcdef"}-1`,
    request: async () => {
      throw error;
    },
    close: async () => {},
  } as unknown as ReturnType<typeof createDesktopHost>;
  return createDesktopActions({ platform: "win32", host });
}

describe("desktop actions", () => {
  test("on an unsupported platform every desktop action refuses with unsupported_platform and starts nothing", async () => {
    const actions = createDesktopActions({
      platform: "freebsd",
      host: createDesktopHost({
        spec: () => {
          throw new Error("must not start a helper");
        },
      }),
    });
    const expected: Out = {
      ok: false,
      error: desktopMessage("unsupported_platform"),
    };
    expect(await actions("desktop.windows", {})).toEqual(expected);
    expect(await actions("desktop.snapshot", { windowId: "w4242-77" })).toEqual(
      expected,
    );
    expect(await actions("desktop.click", {})).toEqual(expected);
    expect(desktopMessage("unsupported_platform")).toBe(
      "这台设备的系统不支持桌面操作。",
    );
    const asked = createDesktopActions({
      platform: "freebsd",
      engine: "agent-desktop",
      reader: fakeReader({
        windows: () => {
          throw new Error("must not read");
        },
      }),
    });
    expect(await asked("desktop.windows", {})).toEqual(expected);
  });

  test("desktop.click and every other desktop action are unsupported and never reach the helper", async () => {
    const { actions, host, log } = setup();
    for (const action of [
      "desktop.click",
      "desktop.type",
      "desktop.launch",
      "desktop.whatever",
    ]) {
      const outcome = await actions(action, { windowId: "w4242-77" });
      expect(outcome).toEqual({
        ok: false,
        error: desktopMessage("unsupported"),
      });
    }
    expect(host.running).toBe(false);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });

  test("desktop.windows maps the helper's list to windowIds", async () => {
    const { actions, requests } = setup();
    const { windows } = output<{ windows: DesktopWindow[] }>(
      await actions("desktop.windows", {}),
    );
    expect(windows.map((window) => window.windowId)).toEqual([
      "w4242-77",
      "w5151-88",
    ]);
    for (const window of windows)
      expect(window.windowId).toMatch(DESKTOP_WINDOW_ID);
    expect(windows[0]).toEqual({
      windowId: "w4242-77",
      title: "无标题 - 记事本",
      process: "notepad",
      focused: false,
      minimized: false,
    });
    expect(requests()[0]).toMatchObject({ op: "windows", max: 50 });
  });

  test("desktop.snapshot numbers controls as <snapshotId>:<index> under this helper's prefix", async () => {
    const { actions, host } = setup();
    const result = output<DesktopSnapshot>(await snapshot(actions));
    expect(result.snapshotId.startsWith(`${host.prefix}-`)).toBe(true);
    expect(result.window.windowId).toBe("w4242-77");
    expect(result.truncated).toBe(false);
    expect(result.elements).toHaveLength(3);
    result.elements.forEach((element, index) => {
      expect(element.ref).toMatch(DESKTOP_REF);
      expect(element.ref).toBe(`${result.snapshotId}:${index}`);
    });
    expect(result.elements[1]).toMatchObject({
      type: "Edit",
      name: "文本编辑器",
      value: "熊宝员工",
      depth: 1,
    });
    expect(result.image).toBeUndefined();
  });

  test("a password control never carries a value, even if the helper sent one", async () => {
    const { actions } = setup();
    const result = output<DesktopSnapshot>(await snapshot(actions));
    const password = result.elements[2];
    expect(password?.password).toBe(true);
    expect(password && "value" in password).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  test("names, values and titles are cut to 120, 200 and 200 characters", async () => {
    const { actions } = setup({ FAKE_DESKTOP_LONG: "1" });
    const listed = output<{ windows: DesktopWindow[] }>(
      await actions("desktop.windows", {}),
    );
    expect(listed.windows[0]?.title).toHaveLength(200);
    const result = output<DesktopSnapshot>(await snapshot(actions));
    expect(result.window.title).toHaveLength(200);
    expect(result.elements[0]?.name).toHaveLength(120);
    expect(result.elements[1]?.name).toHaveLength(120);
    expect(result.elements[1]?.value).toHaveLength(200);
  });

  test("a ref minted by an earlier helper process is refused as stale without starting a helper", async () => {
    const { actions, host, requests } = setup();
    const first = output<DesktopSnapshot>(await snapshot(actions));
    await actions.close();
    expect(host.running).toBe(false);
    const before = requests().length;
    const outcome = await snapshot(actions, { from: first.elements[1]?.ref });
    expect(outcome).toEqual({ ok: false, error: desktopMessage("stale") });
    expect(host.running).toBe(false);
    expect(requests()).toHaveLength(before);
    noUnknown(outcome);
  });

  test("a ref that is not a ref is stale and starts nothing", async () => {
    const { actions, host } = setup();
    const outcome = await snapshot(actions, { from: "not-a-ref" });
    expect(outcome).toEqual({ ok: false, error: desktopMessage("stale") });
    expect(host.running).toBe(false);
  });

  test("a ref from an older snapshot of the same helper is refused as stale", async () => {
    const { actions } = setup();
    const first = output<DesktopSnapshot>(await snapshot(actions));
    output<DesktopSnapshot>(await snapshot(actions));
    const outcome = await snapshot(actions, { from: first.elements[1]?.ref });
    expect(outcome).toEqual({ ok: false, error: desktopMessage("stale") });
    noUnknown(outcome);
  });

  test("a malformed windowId is 找不到这个窗口 and nothing is sent", async () => {
    const { actions, host, requests } = setup();
    for (const windowId of [
      "bogus",
      "",
      42,
      undefined,
      "w0-1",
      "w4242-77; x",
    ]) {
      const outcome = await actions("desktop.snapshot", { windowId });
      expect(outcome).toEqual({
        ok: false,
        error: desktopMessage("no_window"),
      });
    }
    expect(desktopMessage("no_window")).toContain("找不到这个窗口");
    expect(host.running).toBe(false);
    expect(requests()).toEqual([]);
  });

  test("refuseWords is DESKTOP_WINDOW_WORDS unless allowSensitive is true", async () => {
    const { actions, requests } = setup();
    output<DesktopSnapshot>(await snapshot(actions, { screenshot: true }));
    output<DesktopSnapshot>(
      await snapshot(actions, { allowSensitive: true, screenshot: true }),
    );
    output<DesktopSnapshot>(await snapshot(actions, { allowSensitive: "yes" }));
    const sent = requests();
    expect(sent.map((request) => [request.op, request.refuseWords])).toEqual([
      ["tree", [...DESKTOP_WINDOW_WORDS]],
      ["screenshot", [...DESKTOP_WINDOW_WORDS]],
      ["tree", []],
      ["screenshot", []],
      ["tree", [...DESKTOP_WINDOW_WORDS]],
    ]);
    expect(sent[0]).toMatchObject({
      op: "tree",
      hwnd: "4242",
      pid: 77,
      maxDepth: 12,
      maxNodes: 800,
      nameMax: 120,
      valueMax: 200,
      budgetMs: 12_000,
    });
    expect(sent[1]).toMatchObject({ op: "screenshot", maxEdge: 1280 });
  });

  test("a title that became sensitive is refused with the sensitive copy", async () => {
    const { actions } = setup();
    const refused = await actions("desktop.snapshot", {
      windowId: "w5151-88",
    });
    expect(refused).toEqual({
      ok: false,
      error: desktopMessage("sensitive", "银行"),
    });
    noUnknown(refused);
    const allowed = output<DesktopSnapshot>(
      await actions("desktop.snapshot", {
        windowId: "w5151-88",
        allowSensitive: true,
      }),
    );
    expect(allowed.window.windowId).toBe("w5151-88");
  });

  test("screenshot: true adds the image; a minimized window gives imageError and still the tree", async () => {
    const shot = setup();
    const withImage = output<DesktopSnapshot>(
      await snapshot(shot.actions, { screenshot: true }),
    );
    expect(withImage.image).toMatchObject({ width: 1, height: 1 });
    expect(withImage.image?.base64.startsWith("iVBOR")).toBe(true);
    expect(withImage.imageError).toBeUndefined();
    // The tree is read before the picture is taken.
    expect(shot.requests().map((request) => request.op)).toEqual([
      "tree",
      "screenshot",
    ]);

    const minimized = setup({ FAKE_DESKTOP_SHOT: "minimized" });
    const result = output<DesktopSnapshot>(
      await snapshot(minimized.actions, { screenshot: true }),
    );
    expect(result.image).toBeUndefined();
    expect(result.imageError).toBe("窗口已最小化，截不到图。");
    expect(result.elements).toHaveLength(3);

    const hidden = output<DesktopSnapshot>(
      await throwingShot("not_visible").actions("desktop.snapshot", {
        windowId: "w4242-77",
        screenshot: true,
      }),
    );
    expect(hidden.imageError).toBe(
      "这个窗口截不到图（可能被遮挡或使用了硬件加速），请先把它切到前台。",
    );
    expect(hidden.elements).toHaveLength(1);

    const other = output<DesktopSnapshot>(
      await throwingShot("whatever").actions("desktop.snapshot", {
        windowId: "w4242-77",
        screenshot: true,
      }),
    );
    expect(other.imageError).toBe(desktopMessage("failed", "whatever"));
  });

  test("helper errors become the Chinese copy", async () => {
    const slow = setup(
      { FAKE_DESKTOP_DELAY_MS: "3000" },
      { mode: "slow", timeoutMs: 200 },
    );
    const timeout = await slow.actions("desktop.windows", {});
    expect(timeout).toEqual({
      ok: false,
      error: desktopMessage("timeout", "0.2"),
    });
    noUnknown(timeout);

    const crash = setup({}, { mode: "crash" });
    const startFailed = await crash.actions("desktop.windows", {});
    expect(startFailed.ok).toBe(false);
    if (!startFailed.ok) {
      expect(startFailed.error).toContain("桌面助手启动失败：");
      expect(startFailed.error).toContain("编译错误");
    }
    noUnknown(startFailed);

    const session0 = setup({}, { mode: "session0" });
    const dark = await session0.actions("desktop.windows", {});
    expect(dark).toEqual({ ok: false, error: desktopMessage("session0") });
    expect(desktopMessage("session0")).toBe(
      "设备端运行在没有桌面的后台会话里，看不到窗口。请在已登录的桌面上运行设备端。",
    );
    noUnknown(dark);

    const gone = setup();
    const missing = await gone.actions("desktop.snapshot", {
      windowId: "w999-1",
    });
    expect(missing).toEqual({ ok: false, error: desktopMessage("no_window") });
    noUnknown(missing);

    const failed = await throwingActions(
      new DesktopHelperError("failed", "boom", true),
    )("desktop.windows", {});
    expect(failed).toEqual({
      ok: false,
      error: desktopMessage("failed", "boom"),
    });
    const elevated = await throwingActions(
      new DesktopHelperError("elevated", "x", true),
    )("desktop.windows", {});
    expect(elevated).toEqual({ ok: false, error: desktopMessage("elevated") });
    const aborted = await throwingActions(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    )("desktop.windows", {});
    expect(aborted).toEqual({ ok: false, error: "已在设备上停止。" });
    noUnknown(aborted);
    const odd = await throwingActions(new Error("???"))("desktop.windows", {});
    noUnknown(odd);
  });

  test("start_failed detail carries no path or user name", async () => {
    const saved = { USERNAME: process.env.USERNAME, USER: process.env.USER };
    process.env.USERNAME = "zhangsan";
    process.env.USER = "zhangsan";
    try {
      const tail = [
        "At C:\\Users\\zhangsan\\AppData\\Local\\Temp\\helper 1.ps1:3 char:1",
        "Add-Type : cannot open \\\\server\\share\\x.cs",
        "see /home/zhangsan/.cache/openbot/helper.cs and /tmp/x.log",
        "C:\\Users\\张三\\桌面\\a.txt ZhangSan",
      ].join("\n");
      const actions = throwingActions(
        new DesktopHelperError("start_failed", "x", false, tail),
      );
      for (const outcome of [
        await actions("desktop.windows", {}),
        await actions("desktop.snapshot", { windowId: "w4242-77" }),
      ]) {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) continue;
        expect(outcome.error).toContain("桌面助手启动失败：");
        for (const leak of [
          "zhangsan",
          "ZhangSan",
          "张三",
          "Users",
          "AppData",
          "server",
          "\\",
          "/home",
          "/tmp",
          "helper.cs",
        ])
          expect(outcome.error).not.toContain(leak);
        expect(outcome.error).toContain("Add-Type");
        noUnknown(outcome);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("no desktop outcome is ever outcomeUnknown", async () => {
    const { actions } = setup();
    const controller = new AbortController();
    controller.abort();
    const outcomes: Out[] = [
      await actions("desktop.click", {}),
      await actions("desktop.snapshot", { windowId: "nope" }),
      await actions("desktop.snapshot", { windowId: "w4242-77", from: "x" }),
      await actions("desktop.snapshot", { windowId: "w5151-88" }),
      await actions("desktop.snapshot", { windowId: "w999-1" }),
      await actions("desktop.windows", {}, controller.signal),
      await createDesktopActions({ platform: "linux" })("desktop.windows", {}),
    ];
    for (const outcome of outcomes) noUnknown(outcome);
  });

  test("the executor routes desktop.* to extras.desktop and closeDesktop closes it", async () => {
    const { actions, host } = setup();
    const workspace = mkdtempSync(join(DIR, "ws-"));
    const execute = createRunnerExecutor(
      workspace,
      undefined,
      undefined,
      undefined,
      undefined,
      { desktop: actions },
    );
    const listed = await execute({
      action: "desktop.windows",
      payload: { tenantId: "t", botId: "b" },
    });
    expect(listed.ok).toBe(true);
    expect(host.running).toBe(true);
    const click = await execute({ action: "desktop.click", payload: {} });
    expect(click).toEqual({ ok: false, error: desktopMessage("unsupported") });
    await execute.closeDesktop();
    expect(host.running).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "without extras the executor answers desktop actions itself",
    async () => {
      const workspace = mkdtempSync(join(DIR, "ws-"));
      const execute = createRunnerExecutor(workspace);
      const outcome = await execute({ action: "desktop.windows", payload: {} });
      expect(outcome).toEqual({
        ok: false,
        error: "这台设备不是 Windows，暂不支持桌面操作。",
      });
      await execute.closeDesktop();
    },
  );
});

/** Actions over a host whose tree works but whose screenshot fails with `failed` / `message`. */
function throwingShot(message: string) {
  const host = {
    prefix: "abcdef",
    running: true,
    ensure: async () => {},
    nextSnapshotId: () => "abcdef-1",
    request: async (op: { op: string }) => {
      if (op.op === "tree")
        return {
          window: {
            hwnd: "4242",
            pid: 77,
            title: "t",
            process: "notepad",
            focused: false,
            minimized: false,
          },
          truncated: false,
          elements: [{ type: "Window", name: "t", depth: 0 }],
        };
      throw new DesktopHelperError("failed", message, true);
    },
    close: async () => {},
  } as unknown as ReturnType<typeof createDesktopHost>;
  return { actions: createDesktopActions({ platform: "win32", host }) };
}

/** A reader that answers from `impl` and fails the test on anything it was not given. */
function fakeReader(
  impl: Partial<{
    windows: AgentDesktopReader["windows"];
    snapshot: AgentDesktopReader["snapshot"];
  }> = {},
): AgentDesktopReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    prefix: "abc123",
    calls,
    async windows(signal) {
      calls.push("windows");
      if (!impl.windows) throw new Error("unexpected windows");
      return impl.windows(signal);
    },
    async snapshot(body, signal) {
      calls.push(`snapshot ${JSON.stringify(body)}`);
      if (!impl.snapshot) throw new Error("unexpected snapshot");
      return impl.snapshot(body, signal);
    },
    resolveRef: () => "stale",
    adWindow: () => undefined,
    invalidate: () => {},
  };
}

describe("desktop engines (agent-desktop on macOS and Linux)", () => {
  const listed: DesktopWindow[] = [
    {
      windowId: "a0123456789abcdef",
      title: "Untitled - TextEdit",
      process: "TextEdit",
      focused: true,
      minimized: false,
    },
  ];

  test("darwin and linux read through agent-desktop", async () => {
    for (const [node, platform] of [
      ["darwin", "macos"],
      ["linux", "linux"],
    ] as const) {
      const reader = fakeReader({
        windows: async () => ({ platform, windows: listed }),
        snapshot: async (body) => ({
          platform,
          snapshotId: "abc123-1",
          window: listed[0] as DesktopWindow,
          truncated: false,
          elements: [
            {
              ref: "abc123-1:0",
              type: "window",
              name: body.windowId,
              depth: 0,
            },
          ],
        }),
      });
      const actions = createDesktopActions({
        platform: node,
        engine: "agent-desktop",
        reader,
        // The PowerShell reader is never started on these systems.
        host: createDesktopHost({
          spec: () => {
            throw new Error("must not start a helper");
          },
        }),
      });
      closers.push(() => actions.close());
      expect(await actions("desktop.windows", {})).toEqual({
        ok: true,
        output: { platform, windows: listed },
      });
      const snap = await actions("desktop.snapshot", {
        windowId: "a0123456789abcdef",
        from: "abc123-0:2",
        screenshot: true,
        allowSensitive: "yes",
      });
      expect(snap).toEqual({
        ok: true,
        output: {
          platform,
          snapshotId: "abc123-1",
          window: listed[0],
          truncated: false,
          elements: [
            {
              ref: "abc123-1:0",
              type: "window",
              name: "a0123456789abcdef",
              depth: 0,
            },
          ],
        },
      });
      // Only a literal true asks for a picture or past the sensitive-title check.
      expect(reader.calls).toEqual([
        "windows",
        `snapshot ${JSON.stringify({
          windowId: "a0123456789abcdef",
          from: "abc123-0:2",
          screenshot: true,
          allowSensitive: false,
        })}`,
      ]);
      expect(await actions("desktop.click", {})).toEqual({
        ok: false,
        error: desktopMessage("unsupported"),
      });
      expect(reader.calls).toHaveLength(2);
    }
  });

  test("a macOS listing names the platform", async () => {
    const actions = createDesktopActions({
      platform: "darwin",
      engine: "agent-desktop",
      reader: fakeReader({
        windows: async () => ({ platform: "macos", windows: listed }),
      }),
    });
    const outcome = await actions("desktop.windows", {});
    expect(
      outcome.ok && (outcome.output as { platform: string }).platform,
    ).toBe("macos");
  });

  test("the PowerShell reader's listing names the platform too", async () => {
    const { actions } = setup();
    const result = output<{ platform: string; windows: DesktopWindow[] }>(
      await actions("desktop.windows", {}),
    );
    expect(result.platform).toBe("windows");
  });

  test("agent-desktop read errors are the reader's Chinese copy, once, and never outcomeUnknown", async () => {
    const cases: Array<[unknown, string]> = [
      [
        new DesktopHelperError("no_window", desktopMessage("no_window"), false),
        desktopMessage("no_window"),
      ],
      [
        new DesktopHelperError(
          "mac_permission",
          desktopMessage("mac_permission"),
          false,
        ),
        desktopMessage("mac_permission"),
      ],
      [
        new DesktopHelperError(
          "timeout",
          desktopMessage("timeout", "20"),
          true,
        ),
        desktopMessage("timeout", "20"),
      ],
      [
        Object.assign(new Error("aborted"), { name: "AbortError" }),
        "已在设备上停止。",
      ],
      [new Error("???"), desktopMessage("failed")],
    ];
    for (const [error, copy] of cases) {
      const actions = createDesktopActions({
        platform: "linux",
        engine: "agent-desktop",
        reader: fakeReader({
          windows: async () => {
            throw error;
          },
          snapshot: async () => {
            throw error;
          },
        }),
      });
      for (const outcome of [
        await actions("desktop.windows", {}),
        await actions("desktop.snapshot", { windowId: "a0123456789abcdef" }),
      ]) {
        expect(outcome).toEqual({ ok: false, error: copy });
        noUnknown(outcome);
      }
    }
  });

  test("the default reader runs the helper it is given, and close empties its state directory", async () => {
    const root = mkdtempSync(join(DIR, "ad-"));
    const stateDir = join(root, "agent-desktop-state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "leftover.json"), "{}");
    const actions = createDesktopActions({
      platform: "linux",
      engine: "agent-desktop",
      helper: join(root, "no-such-agent-desktop"),
      stateDir,
    });
    const outcome = await actions("desktop.windows", {});
    expect(outcome).toEqual({
      ok: false,
      error: desktopMessage("start_failed", "没有找到 agent-desktop"),
    });
    noUnknown(outcome);
    await actions.close();
    expect(readdirSync(stateDir)).toEqual([]);
  });

  test("close wipes a leftover state directory even when no desktop action ever ran", async () => {
    for (const engine of ["agent-desktop", "legacy"] as const) {
      const root = mkdtempSync(join(DIR, "ad-left-"));
      const stateDir = join(root, "agent-desktop-state");
      mkdirSync(join(stateDir, "snapshots"), { recursive: true });
      writeFileSync(join(stateDir, "snapshots", "leftover.json"), "{}");
      const actions = createDesktopActions({
        platform: "linux",
        engine,
        helper: join(root, "no-such-agent-desktop"),
        stateDir,
      });
      await actions.close();
      expect(existsSync(stateDir)).toBe(false);
      // Nothing to wipe is not an error.
      await actions.close();
    }
  });

  test("agent-desktop without a helper to run fails to start, and never outcomeUnknown", async () => {
    const actions = createDesktopActions({
      platform: "darwin",
      engine: "agent-desktop",
    });
    const outcome = await actions("desktop.windows", {});
    expect(outcome).toEqual({
      ok: false,
      error: desktopMessage("start_failed", "没有找到 agent-desktop"),
    });
    noUnknown(outcome);
  });

  test("win32 stays on the PowerShell reader unless OPENBOT_DESKTOP_ENGINE is agent-desktop", () => {
    expect(desktopEngineFor("win32", undefined)).toBe("legacy");
    expect(desktopEngineFor("win32", "legacy")).toBe("legacy");
    expect(desktopEngineFor("win32", "agent-desktop")).toBe("agent-desktop");
    expect(desktopEngineFor("darwin", undefined)).toBe("agent-desktop");
    expect(desktopEngineFor("linux", undefined)).toBe("agent-desktop");
    // macOS and Linux only have agent-desktop.
    expect(desktopEngineFor("darwin", "legacy")).toBe("agent-desktop");
    expect(desktopEngineFor("linux", "legacy")).toBe("agent-desktop");
    expect(desktopEngineFor("freebsd", undefined)).toBeUndefined();
    expect(desktopEngineFor("freebsd", "agent-desktop")).toBeUndefined();
  });

  test("win32 with agent-desktop asked for reads through it, as windows", async () => {
    const actions = createDesktopActions({
      platform: "win32",
      engine: "agent-desktop",
      reader: fakeReader({
        windows: async () => ({ platform: "windows", windows: listed }),
      }),
      host: createDesktopHost({
        spec: () => {
          throw new Error("must not start the PowerShell helper");
        },
      }),
    });
    expect(await actions("desktop.windows", {})).toEqual({
      ok: true,
      output: { platform: "windows", windows: listed },
    });
  });

  test("the read tools are described for Windows, macOS and Linux", () => {
    const windows = LOCAL_TOOL_DESCRIPTIONS.computer_desktop_windows;
    const snapshot = LOCAL_TOOL_DESCRIPTIONS.computer_desktop_snapshot;
    expect(windows).toContain(
      "on the person's own paired computer (Windows, macOS, or Linux as a trial):",
    );
    expect(windows).toContain("The result names the platform.");
    expect(snapshot).toContain(
      "Read one window on the person's own paired computer as a tree",
    );
    expect(snapshot).toContain("Read-only");
    for (const text of [windows, snapshot])
      expect(text).not.toContain("paired Windows computer");
  });
});
