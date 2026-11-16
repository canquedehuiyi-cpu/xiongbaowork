import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  DesktopElement,
  DesktopWindow,
} from "../../shared/desktop-control";
import {
  compareDesktopEngines,
  type DesktopActions,
  type EngineComparison,
  formatEngineComparison,
} from "../src/desktop/actions";
import type { ActionOutcome } from "../src/execute";
import { parseDesktopCompare, runDesktopCompare } from "../src/index";

/*
 * Task 28: `xiongbao-runner --desktop-compare` reads the same windows through both engines and says
 * which named, operable controls the old PowerShell reader sees that agent-desktop does not.
 */

type Fake = {
  windows: DesktopWindow[] | string;
  /** Per windowId: the controls, or the error the engine answers with. */
  trees: Record<string, Array<[string, string]> | string | Error>;
};

/** A fake engine: `desktop.windows` and `desktop.snapshot` only, as the comparison uses them. */
function engine(fake: Fake): DesktopActions & { calls: string[] } {
  const calls: string[] = [];
  const act = async (
    action: string,
    body: Record<string, unknown>,
  ): Promise<ActionOutcome> => {
    if (action === "desktop.windows") {
      calls.push("windows");
      return typeof fake.windows === "string"
        ? { ok: false, error: fake.windows }
        : { ok: true, output: { platform: "windows", windows: fake.windows } };
    }
    if (action === "desktop.snapshot") {
      const windowId = String(body.windowId);
      calls.push(`snapshot ${windowId}`);
      // The comparison never asks past the sensitive-title check, nor for a picture.
      expect(body.allowSensitive).toBeUndefined();
      expect(body.screenshot).toBeUndefined();
      const tree = fake.trees[windowId];
      if (tree instanceof Error) throw tree;
      if (typeof tree === "string") return { ok: false, error: tree };
      if (!tree) return { ok: false, error: "no such window" };
      const elements: DesktopElement[] = tree.map(([type, name], index) => ({
        ref: `abc123-1:${index}`,
        type,
        name,
        depth: index === 0 ? 0 : 1,
      }));
      return {
        ok: true,
        output: {
          snapshotId: "abc123-1",
          window: fake.windows[0],
          truncated: false,
          elements,
        },
      };
    }
    throw new Error(`unexpected ${action}`);
  };
  return Object.assign(act, { calls, close: async () => {} });
}

const win = (
  windowId: string,
  title: string,
  process: string,
): DesktopWindow => ({
  windowId,
  title,
  process,
  focused: false,
  minimized: false,
});

const LEGACY_NOTEPAD: Array<[string, string]> = [
  ["Window", "熊宝员工.txt - 记事本"],
  ["Document", "文本编辑器"],
  ["MenuItem", "文件"],
  ["Button", "保存"],
  ["CheckBox", "自动换行"],
  ["Edit", "查找内容"],
  // No name: nothing to look for on the other side.
  ["Button", ""],
  // Not an operable type: never reported missing.
  ["Text", "状态栏"],
  ["Pane", "只在旧读取器里"],
];

const AD_NOTEPAD: Array<[string, string]> = [
  ["window", "熊宝员工.txt - 记事本"],
  ["document", "文本编辑器"],
  ["menuitem", "文件"],
  ["checkbox", "自动换行"],
  // Same name, another type: found by name.
  ["textfield", "查找内容"],
];

describe("compareDesktopEngines", () => {
  test("one engine short of a Save button: missingInAgentDesktop is exactly that", async () => {
    const legacy = engine({
      windows: [win("w100-7", "熊宝员工.txt - 记事本", "notepad")],
      trees: { "w100-7": LEGACY_NOTEPAD },
    });
    const agentDesktop = engine({
      windows: [
        win("a0123456789abcdef", "熊宝员工.txt - 记事本", "Notepad.exe"),
      ],
      trees: { a0123456789abcdef: AD_NOTEPAD },
    });
    const rows = await compareDesktopEngines({ legacy, agentDesktop });
    expect(rows).toEqual([
      {
        title: "熊宝员工.txt - 记事本",
        process: "notepad",
        legacy: {
          count: 9,
          names: [
            "熊宝员工.txt - 记事本",
            "文本编辑器",
            "文件",
            "保存",
            "自动换行",
            "查找内容",
            "状态栏",
            "只在旧读取器里",
          ],
        },
        agentDesktop: {
          count: 5,
          names: [
            "熊宝员工.txt - 记事本",
            "文本编辑器",
            "文件",
            "自动换行",
            "查找内容",
          ],
        },
        missingInAgentDesktop: ["保存"],
      },
    ] satisfies EngineComparison[]);
    expect(legacy.calls).toEqual(["windows", "snapshot w100-7"]);
    expect(agentDesktop.calls).toEqual([
      "windows",
      "snapshot a0123456789abcdef",
    ]);
  });

  test("a side that fails is { error } and the other side is read as usual", async () => {
    const legacy = engine({
      windows: [
        win("w1-1", "记事本", "notepad"),
        win("w2-2", "计算器", "calc"),
        win("w3-3", "设置", "SystemSettings"),
      ],
      trees: {
        "w1-1": [["Button", "保存"]],
        "w2-2": "读取失败：超时",
        "w3-3": new Error("helper crashed"),
      },
    });
    const agentDesktop = engine({
      windows: [
        win("a1", "记事本", "notepad.exe"),
        win("a2", "计算器", "calc.exe"),
        win("a3", "设置", "SystemSettings.exe"),
      ],
      trees: {
        a1: "这个窗口读不到",
        a2: [["button", "等于"]],
        a3: [["button", "返回"]],
      },
    });
    const rows = await compareDesktopEngines({ legacy, agentDesktop });
    expect(rows).toEqual([
      {
        title: "记事本",
        process: "notepad",
        legacy: { count: 1, names: ["保存"] },
        agentDesktop: { error: "这个窗口读不到" },
        missingInAgentDesktop: [],
      },
      {
        title: "计算器",
        process: "calc",
        legacy: { error: "读取失败：超时" },
        agentDesktop: { count: 1, names: ["等于"] },
        missingInAgentDesktop: [],
      },
      {
        title: "设置",
        process: "SystemSettings",
        legacy: { error: "helper crashed" },
        agentDesktop: { count: 1, names: ["返回"] },
        missingInAgentDesktop: [],
      },
    ]);
  });

  test("an engine that cannot list windows is { error } on every row; the other side's list is used", async () => {
    const legacy = engine({
      windows: "这台电脑不是 Windows，没有旧读取器。",
      trees: {},
    });
    const agentDesktop = engine({
      windows: [win("a1", "文本编辑", "TextEdit")],
      trees: { a1: [["textarea", "正文"]] },
    });
    expect(await compareDesktopEngines({ legacy, agentDesktop })).toEqual([
      {
        title: "文本编辑",
        process: "TextEdit",
        legacy: { error: "这台电脑不是 Windows，没有旧读取器。" },
        agentDesktop: { count: 1, names: ["正文"] },
        missingInAgentDesktop: [],
      },
    ]);
    expect(legacy.calls).toEqual(["windows"]);

    const both = await compareDesktopEngines({
      legacy,
      agentDesktop: engine({ windows: "没有找到 agent-desktop", trees: {} }),
    });
    expect(both).toEqual([
      {
        title: "",
        process: "",
        legacy: { error: "这台电脑不是 Windows，没有旧读取器。" },
        agentDesktop: { error: "没有找到 agent-desktop" },
        missingInAgentDesktop: [],
      },
    ]);
  });

  test("a window only one engine lists says so on the other side", async () => {
    const legacy = engine({
      windows: [win("w1-1", "只有旧的", "a"), win("w2-2", "两边都有", "b")],
      trees: { "w1-1": [["Button", "确定"]], "w2-2": [["Button", "好"]] },
    });
    const agentDesktop = engine({
      windows: [win("a2", "两边都有", "b.exe")],
      trees: { a2: [["button", "好"]] },
    });
    const rows = await compareDesktopEngines({ legacy, agentDesktop });
    expect(rows.map((row) => row.agentDesktop)).toEqual([
      { error: "agent-desktop 没有列出这个窗口。" },
      { count: 1, names: ["好"] },
    ]);
    expect(agentDesktop.calls).toEqual(["windows", "snapshot a2"]);
  });

  test("the same title twice is paired in order, and only the first ten windows are read", async () => {
    const many = (prefix: string, process: string) =>
      Array.from({ length: 12 }, (_, at) =>
        win(`${prefix}${at}`, at < 2 ? "同名" : `窗口 ${at}`, process),
      );
    const trees = (prefix: string, type: string) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, at) => [
          `${prefix}${at}`,
          [[type, `控件 ${at}`]] as Array<[string, string]>,
        ]),
      );
    const legacy = engine({
      windows: many("w", "app"),
      trees: trees("w", "Button"),
    });
    const agentDesktop = engine({
      windows: many("a", "APP.EXE"),
      trees: trees("a", "button"),
    });
    const rows = await compareDesktopEngines({ legacy, agentDesktop });
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.missingInAgentDesktop.length === 0)).toBe(
      true,
    );
    expect(legacy.calls).toHaveLength(11);
    expect(agentDesktop.calls.slice(0, 3)).toEqual([
      "windows",
      "snapshot a0",
      "snapshot a1",
    ]);
    expect(
      await compareDesktopEngines({ legacy, agentDesktop, maxWindows: 3 }),
    ).toHaveLength(3);
  });
});

describe("the --desktop-compare table", () => {
  test("prints titles, both counts and what agent-desktop is missing, in Chinese", () => {
    const text = formatEngineComparison([
      {
        title: "熊宝员工.txt - 记事本",
        process: "notepad",
        legacy: { count: 9, names: [] },
        agentDesktop: { count: 5, names: [] },
        missingInAgentDesktop: ["保存", "打开"],
      },
      {
        title: "a | b\nc",
        process: "calc",
        legacy: { error: "读取失败" },
        agentDesktop: { count: 1, names: [] },
        missingInAgentDesktop: [],
      },
      {
        title: "设置",
        process: "x",
        legacy: { count: 2, names: [] },
        agentDesktop: { count: 2, names: [] },
        missingInAgentDesktop: [],
      },
    ]);
    expect(text.split("\n")).toEqual([
      "两个桌面引擎读取同一批窗口的对比（共 3 个窗口）",
      "序号 | 窗口标题 | 程序 | 旧读取器控件数 | agent-desktop 控件数 | agent-desktop 缺少的有名字的可操作控件",
      "1 | 熊宝员工.txt - 记事本 | notepad | 9 | 5 | 保存、打开",
      "2 | a ｜ b c | calc | 出错：读取失败 | 1 | （有一边出错，无法比较）",
      "3 | 设置 | x | 2 | 2 | 无",
    ]);
    expect(formatEngineComparison([])).toBe("没有可读的窗口。");
  });

  test("--desktop-compare takes only --desktop-helper", () => {
    expect(parseDesktopCompare(["--server", "https://x"], {}, "/here")).toBe(
      null,
    );
    expect(parseDesktopCompare(["--desktop-compare"], {}, "/here")).toEqual({
      helper: expect.stringMatching(/agent-desktop(\.exe)?$/),
    });
    expect(
      parseDesktopCompare(
        ["--desktop-compare", "--desktop-helper", "bin/agent-desktop"],
        { OPENBOT_DESKTOP_HELPER: "/elsewhere/agent-desktop" },
        "/here",
      ),
    ).toEqual({ helper: resolve("/here", "bin/agent-desktop") });
    expect(
      parseDesktopCompare(
        ["--desktop-compare"],
        { OPENBOT_DESKTOP_HELPER: "/elsewhere/agent-desktop" },
        "/here",
      ),
    ).toEqual({ helper: resolve("/here", "/elsewhere/agent-desktop") });
    expect(
      parseDesktopCompare(
        ["--desktop-compare", "--desktop-helper"],
        {},
        "/here",
      ),
    ).toBe("--desktop-helper needs a path.");
    expect(
      parseDesktopCompare(
        ["--desktop-compare", "--server", "https://x"],
        {},
        "/here",
      ),
    ).toBe("--desktop-compare takes only --desktop-helper PATH.");
  });

  test.skipIf(process.platform === "win32")(
    "a run without the old reader or agent-desktop prints why, and leaves nothing behind",
    async () => {
      const scratch = () =>
        readdirSync(tmpdir()).filter((name) =>
          name.startsWith("xiongbao-desktop-compare-"),
        );
      const before = scratch();
      const printed: string[] = [];
      const code = await runDesktopCompare(
        { helper: "/nonexistent/agent-desktop" },
        (line) => printed.push(line),
      );
      expect(code).toBe(0);
      const lines = printed.join("\n").split("\n");
      expect(lines.slice(0, 2)).toEqual([
        "两个桌面引擎读取同一批窗口的对比（共 1 个窗口）",
        "序号 | 窗口标题 | 程序 | 旧读取器控件数 | agent-desktop 控件数 | agent-desktop 缺少的有名字的可操作控件",
      ]);
      expect(lines[2]).toStartWith("1 | （无标题） |  | 出错：");
      expect(lines[2]).toEndWith("| （有一边出错，无法比较）");
      expect(scratch()).toEqual(before);
    },
  );
});
