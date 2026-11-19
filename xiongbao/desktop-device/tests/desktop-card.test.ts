/**
 * The 「桌面操作」 card and the 「关于」 notices (ui/desktop.js), without a window: what each platform
 * shows, which shell commands the buttons call, how the card polls, and how a notice is read when it is
 * opened. The device-shell CI job installs no packages, so there is no DOM library here: the card's
 * rules are plain functions and `main.js` draws them, as with `folders.js`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDesktopCard,
  describeDesktop,
  LINUX_BUS,
  noticeNames,
  openSettings,
  POLL_MS,
  readNotice,
  restartApp,
  wireNotice,
} from "../ui/desktop.js";

const root = join(import.meta.dir, "..");

type Call = [string, Record<string, unknown> | undefined];

function fakeInvoke(reply: (command: string) => unknown) {
  const calls: Call[] = [];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    const value = reply(command);
    if (value instanceof Error) throw value.message;
    return value;
  };
  return { calls, invoke };
}

/** Timers the test turns by hand. */
function fakeTimers() {
  const live = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  return {
    live,
    setInterval: (run: () => void, ms: number) => {
      live.set(next, { run, ms });
      return next++;
    },
    clearInterval: (id: number) => {
      live.delete(id);
    },
    tick() {
      for (const { run } of [...live.values()]) run();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const mac = {
  platform: "macos",
  accessibility: "granted",
  screenRecording: "denied",
  atSpi: null,
};

test("macOS shows both rows and a 去开启 button only for the one not allowed", async () => {
  const card = describeDesktop(mac);
  expect(card.title).toBe("桌面操作");
  expect(card.rows).toEqual([
    {
      label: "辅助功能（读界面和动手都要）",
      status: "已允许",
      allowed: true,
      action: null,
    },
    {
      label: "屏幕录制（只有截图要，不给也能用）",
      status: "未允许",
      allowed: false,
      action: { text: "去开启", kind: "screen" },
    },
  ]);
  expect(card.guide).toEqual({
    image: "mac-accessibility.svg",
    text: "找到熊宝数字员工设备端，打开开关",
  });
  expect(card.restart).toEqual({
    text: "开启后仍显示未允许时，",
    button: "重新打开设备端",
  });

  const neither = describeDesktop({
    ...mac,
    accessibility: "denied",
    screenRecording: "unknown",
  });
  expect(neither.rows.map((row) => row.action?.kind ?? null)).toEqual([
    "accessibility",
    "screen",
  ]);
  expect(neither.rows.map((row) => row.status)).toEqual(["未允许", "未允许"]);

  // Both allowed: no button and no guide, but the restart sentence stays at the bottom.
  const both = describeDesktop({ ...mac, screenRecording: "granted" });
  expect(both.rows.every((row) => row.action === null)).toBeTrue();
  expect(both.guide).toBeNull();
  expect(both.restart).not.toBeNull();

  // The buttons call the shell's commands, and a refusal is shown as it is.
  const { calls, invoke } = fakeInvoke((command) =>
    command === "open_desktop_settings" ? null : new Error("no"),
  );
  expect(await openSettings("screen", invoke)).toEqual({});
  expect(await restartApp(invoke)).toEqual({ error: "no" });
  expect(calls).toEqual([
    ["open_desktop_settings", { kind: "screen" }],
    ["restart_app", undefined],
  ]);
});

test("Windows needs no grant", () => {
  const card = describeDesktop({
    platform: "windows",
    accessibility: "not_required",
    screenRecording: "not_required",
    atSpi: null,
  });
  expect(card).toMatchObject({
    title: "桌面操作",
    rows: [],
    note: "Windows 不需要授权。",
    guide: null,
    restart: null,
  });
});

test("Linux without a bus shows the AT-SPI hint", () => {
  expect(LINUX_BUS).toBe(
    "这台 Linux 电脑没有开启无障碍总线（AT-SPI），看不到窗口。请在系统设置里打开辅助功能后重新登录。",
  );
  const card = describeDesktop({
    platform: "linux",
    accessibility: "denied",
    screenRecording: "not_required",
    atSpi: false,
  });
  expect(card.title).toBe("桌面操作（试用，只能查看）");
  expect(card.note).toBe(LINUX_BUS);
  expect(card.rows).toEqual([]);
  expect(card.guide).toBeNull();
  expect(card.restart).toBeNull();

  const withBus = describeDesktop({
    platform: "linux",
    accessibility: "granted",
    screenRecording: "not_required",
    atSpi: true,
  });
  expect(withBus.title).toBe("桌面操作（试用，只能查看）");
  expect(withBus.note).not.toBe(LINUX_BUS);
});

test("the card polls every 3 seconds while visible and stops when hidden", async () => {
  expect(POLL_MS).toBe(3000);
  const timers = fakeTimers();
  const { calls, invoke } = fakeInvoke(() => mac);
  const drawn: unknown[] = [];
  const card = createDesktopCard({
    invoke,
    draw: (described: unknown) => drawn.push(described),
    timers,
  });

  // Hidden: nothing is asked.
  await settle();
  expect(calls).toHaveLength(0);
  expect(timers.live.size).toBe(0);

  card.setVisible(true);
  await settle();
  expect(calls).toEqual([["desktop_permissions", undefined]]);
  expect([...timers.live.values()].map(({ ms }) => ms)).toEqual([3000]);
  expect(drawn.at(-1)).toEqual(describeDesktop(mac));

  // Shown again while shown: still one timer.
  card.setVisible(true);
  expect(timers.live.size).toBe(1);

  timers.tick();
  await settle();
  timers.tick();
  await settle();
  expect(calls).toHaveLength(3);

  card.setVisible(false);
  expect(timers.live.size).toBe(0);
  timers.tick();
  await settle();
  expect(calls).toHaveLength(3);
});

test("a slow answer is not asked for again on top of itself, and a failure is shown", async () => {
  const timers = fakeTimers();
  let answer: (value: unknown) => void = () => {};
  const calls: string[] = [];
  const drawn: Array<{ error?: string }> = [];
  const card = createDesktopCard({
    invoke: (command: string) => {
      calls.push(command);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
    draw: (described: { error?: string }) => drawn.push(described),
    timers,
  });
  card.setVisible(true);
  timers.tick();
  timers.tick();
  expect(calls).toHaveLength(1);
  answer(mac);
  await settle();
  timers.tick();
  expect(calls).toHaveLength(2);

  const failing = createDesktopCard({
    invoke: async () => {
      throw "桌面助手 5 秒内没有回答。";
    },
    draw: (described: { error?: string }) => drawn.push(described),
    timers: fakeTimers(),
  });
  failing.setVisible(true);
  await settle();
  expect(drawn.at(-1)?.error).toBe("桌面助手 5 秒内没有回答。");
});

test("opening a notice reads its files once into its <pre>", async () => {
  expect(
    noticeNames(
      "licenses/agent-desktop/LICENSE licenses/agent-desktop/COPYRIGHT",
    ),
  ).toEqual([
    "licenses/agent-desktop/LICENSE",
    "licenses/agent-desktop/COPYRIGHT",
  ]);

  const { calls, invoke } = fakeInvoke((command) =>
    command === "read_bundled_text" ? "text" : null,
  );
  expect(
    await readNotice(
      ["licenses/agent-desktop/LICENSE", "licenses/agent-desktop/COPYRIGHT"],
      invoke,
    ),
  ).toEqual({ text: "text\n\ntext" });
  expect(calls).toEqual([
    ["read_bundled_text", { name: "licenses/agent-desktop/LICENSE" }],
    ["read_bundled_text", { name: "licenses/agent-desktop/COPYRIGHT" }],
  ]);

  // A <details> stand-in: what wireNotice touches.
  let onToggle: () => unknown = () => {};
  const pre = { textContent: "" };
  const details = {
    open: false,
    dataset: { notice: "NOTICE" },
    querySelector: (selector: string) => (selector === "pre" ? pre : null),
    addEventListener: (type: string, listener: () => unknown) => {
      if (type === "toggle") onToggle = listener;
    },
  };
  const reads = fakeInvoke(() => "Copyright 熊宝");
  wireNotice(details, reads.invoke);
  await onToggle();
  expect(reads.calls).toHaveLength(0);
  details.open = true;
  await onToggle();
  expect(pre.textContent).toBe("Copyright 熊宝");
  details.open = false;
  await onToggle();
  details.open = true;
  await onToggle();
  expect(reads.calls).toEqual([["read_bundled_text", { name: "NOTICE" }]]);

  const refused = fakeInvoke(() => new Error("找不到 NOTICE"));
  expect(await readNotice(["NOTICE"], refused.invoke)).toEqual({
    error: "找不到 NOTICE",
  });
});

test("the 关于 section has the five notices, each one the bundle ships", () => {
  const html = readFileSync(join(root, "ui", "index.html"), "utf8");
  const about = /<section id="about"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const notices = [
    ...about.matchAll(
      /<details data-notice="([^"]+)">\s*<summary>([^<]+)<\/summary>/g,
    ),
  ].map((m) => [m[2], noticeNames(m[1])]);
  expect(notices).toEqual([
    ["本软件许可", ["LICENSE"]],
    ["NOTICE", ["NOTICE"]],
    ["第三方许可", ["THIRD-PARTY-NOTICES.md"]],
    [
      "agent-desktop 许可",
      ["licenses/agent-desktop/LICENSE", "licenses/agent-desktop/COPYRIGHT"],
    ],
    ["agent-desktop 的第三方许可", ["licenses/agent-desktop/THIRD-PARTY.md"]],
  ]);
  const bundle = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.bundle.conf.json"), "utf8"),
  );
  const shipped = Object.values(bundle.bundle.resources);
  for (const [, names] of notices) {
    for (const name of names) expect(shipped).toContain(name);
  }
});

test("the card's section, its picture and its script are in the page", () => {
  const html = readFileSync(join(root, "ui", "index.html"), "utf8");
  expect(html).toContain('<section id="desktop"');
  const svg = readFileSync(join(root, "ui", "mac-accessibility.svg"), "utf8");
  expect(svg).toContain("<svg");
  expect(svg).toContain("辅助功能");
  expect(svg).toContain("熊宝数字员工 设备端");
});
