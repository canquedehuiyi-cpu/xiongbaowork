import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  DESKTOP_LIMITS,
  DESKTOP_REF,
  type DesktopPlatform,
  desktopMessage,
} from "../../shared/desktop-control";
import {
  type AgentDesktopReader,
  createAgentDesktopReader,
  flattenTree,
  readFailure,
} from "../src/desktop/ad-read";
import {
  type AgentDesktopCli,
  createAgentDesktopCli,
} from "../src/desktop/agent-desktop";
import { DesktopHelperError } from "../src/desktop/host";

const FAKE = join(import.meta.dir, "fixtures", "fake-agent-desktop.ts");
const SAMPLES = join(import.meta.dir, "fixtures", "agent-desktop");
const PLATFORMS: DesktopPlatform[] = ["macos", "windows", "linux"];

const sample = (platform: string, key: string) =>
  JSON.parse(readFileSync(join(SAMPLES, `${platform}.json`), "utf8"))[key];

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

type Command = Record<string, unknown>;
type Script = { platform?: string; commands?: Record<string, Command> };

/** A reader on the real CLI layer, driving the fake binary; `script` may be changed between calls. */
function setup(
  platform: DesktopPlatform,
  commands: Record<string, Command> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ad-read-"));
  const logPath = join(root, "log.jsonl");
  writeFileSync(logPath, "");
  const script: Script = {
    platform,
    commands: {
      "list-windows": { sample: "list-windows" },
      "list-displays": { sample: "list-displays" },
      snapshot: { sample: "snapshot" },
      screenshot: { sample: "screenshot" },
      status: { sample: "status" },
      ...commands,
    },
  };
  const spawn = ((cmd: string[], options: { env?: Record<string, string> }) =>
    Bun.spawn(["bun", FAKE, ...cmd.slice(1)], {
      ...options,
      env: {
        ...options.env,
        FAKE_AD_SCRIPT: JSON.stringify(script),
        FAKE_AD_LOG: logPath,
      },
    } as never)) as unknown as typeof Bun.spawn;
  const cli = createAgentDesktopCli({
    binary: "agent-desktop",
    stateDir: join(root, "state"),
    spawn,
  });
  cleanup.push(async () => {
    await cli.close();
    rmSync(root, { recursive: true, force: true });
  });
  const reader = createAgentDesktopReader({ cli, platform });
  const log = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { args: string[] }).args);
  const set = (name: string, command: Command) => {
    script.commands = { ...script.commands, [name]: command };
  };
  return { cli, reader, log, set, script };
}

type Failure = {
  name: string;
  code: string;
  message: string;
  outcomeUnknown?: unknown;
};
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (e: unknown) => e as Failure,
  );

const ok = (command: string, data: unknown) => ({
  envelope: { version: "2.6", ok: true, command, data },
});
const err = (command: string, code: string, extra: Command = {}) => ({
  envelope: {
    version: "2.6",
    ok: false,
    command,
    error: {
      code,
      message: `${code} happened at /home/someone/private/file.txt`,
      disposition: { delivery: "not_delivered", retry: "safe" },
      ...extra,
    },
  },
  exitCode: 1,
});

/** The first listed window of a reader that answers the platform's own samples. */
async function firstWindow(reader: AgentDesktopReader) {
  const { windows } = await reader.windows();
  const window = windows[0];
  if (!window) throw new Error("no window listed");
  return window;
}

/** A fake CLI object for cases the binary cannot produce (a timeout, an abort). */
function fakeCli(run: AgentDesktopCli["run"]): AgentDesktopCli {
  return {
    run,
    ensureReady: async () => {},
    wipeState: async () => {},
    close: async () => {},
  };
}

describe("agent-desktop reader: windows", () => {
  test("windows: each platform's sample lists windows with a<16 hex> ids, titles cut to 200, display index from bounds", async () => {
    for (const platform of PLATFORMS) {
      const { reader } = setup(platform);
      const result = await reader.windows();
      expect(result.platform).toBe(platform);
      const raw = sample(platform, "list-windows").data as Array<{
        accessible?: boolean;
        title: string;
        app_name: string;
        is_focused: boolean;
      }>;
      const accessible = raw.filter((w) => w.accessible !== false);
      expect(result.windows.map((w) => w.title)).toEqual(
        accessible.map((w) => w.title),
      );
      for (const [i, w] of result.windows.entries()) {
        expect(w.windowId).toMatch(/^a[0-9a-f]{16}$/);
        expect(w.process).toBe(accessible[i]!.app_name);
        expect(w.focused).toBe(accessible[i]!.is_focused);
        expect(w.minimized).toBe(false);
        expect(w.display).toBe(0);
        expect(w.bounds).toBeDefined();
      }
      expect(new Set(result.windows.map((w) => w.windowId)).size).toBe(
        result.windows.length,
      );
    }

    // Two displays side by side; titles over 200 are cut; at most 50 windows.
    const many = Array.from({ length: 60 }, (_, i) => ({
      accessible: true,
      app_name: "a".repeat(250),
      bounds: { x: i === 0 ? 1500 : 10, y: 10, width: 100, height: 100 },
      id: `w-${i + 1}`,
      is_focused: false,
      minimized: i === 1,
      pid: 100 + i,
      process_instance: "x",
      title: "t".repeat(250),
      visible: true,
    }));
    const { reader } = setup("windows", {
      "list-windows": ok("list-windows", many),
      "list-displays": ok("list-displays", [
        {
          id: "m1",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          is_primary: true,
          scale: 1,
        },
        {
          id: "m2",
          bounds: { x: 1280, y: 0, width: 1920, height: 1080 },
          is_primary: false,
          scale: 1,
        },
      ]),
    });
    const { windows } = await reader.windows();
    expect(windows).toHaveLength(DESKTOP_LIMITS.windowsMax);
    expect(windows[0]!.title).toHaveLength(200);
    expect(windows[0]!.process).toHaveLength(200);
    expect(windows[0]!.display).toBe(1);
    expect(windows[1]!.display).toBe(0);
    expect(windows[1]!.minimized).toBe(true);
    expect(windows[0]!.bounds).toEqual({
      x: 1500,
      y: 10,
      width: 100,
      height: 100,
    });
  });

  test("the same window keeps its id across listings; a new reader gives a new id and refuses the old one as 找不到这个窗口", async () => {
    const first = setup("macos");
    const a = await firstWindow(first.reader);
    const b = await firstWindow(first.reader);
    expect(b.windowId).toBe(a.windowId);
    expect(first.reader.adWindow(a.windowId)).toEqual({
      adWindowId: "w-43",
      pid: 1731,
    });

    const second = setup("macos");
    const c = await firstWindow(second.reader);
    expect(c.windowId).not.toBe(a.windowId);
    expect(second.reader.prefix).not.toBe(first.reader.prefix);
    expect(second.reader.prefix).toMatch(/^[0-9a-f]{6}$/);
    expect(second.reader.adWindow(a.windowId)).toBeUndefined();
    const error = await rejected(
      second.reader.snapshot({ windowId: a.windowId }),
    );
    expect(error.code).toBe("no_window");
    expect(error.message).toBe("找不到这个窗口，请重新列出窗口。");
    expect(second.log().filter((args) => args[0] === "snapshot")).toEqual([]);
  });

  test("linux with an empty window list and no bus is linux_bus", async () => {
    const denied = {
      ...sample("linux", "status").data,
      permissions: {
        accessibility: {
          state: "denied",
          suggestion: "No D-Bus session bus is reachable.",
        },
        automation: { state: "not_required" },
        screen_recording: { state: "not_required" },
      },
      supported_surfaces: [],
    };
    const empty = setup("linux", {
      "list-windows": ok("list-windows", []),
      status: ok("status", denied),
    });
    const error = await rejected(empty.reader.windows());
    expect(error.code).toBe("linux_bus");
    expect(error.message).toBe(desktopMessage("linux_bus"));
    expect(empty.log().map((a) => a[0])).toContain("status");

    // What the CLI really answers without a bus: PLATFORM_NOT_SUPPORTED from list-windows.
    const noBus = setup("linux", {
      "list-windows": err("list-windows", "PLATFORM_NOT_SUPPORTED", {
        message:
          "The AT-SPI accessibility bus is not available in this session",
      }),
      status: ok("status", denied),
    });
    expect((await rejected(noBus.reader.windows())).code).toBe("linux_bus");

    // An empty list with the bus up is just an empty desktop.
    const quiet = setup("linux", { "list-windows": ok("list-windows", []) });
    expect(await quiet.reader.windows()).toEqual({
      platform: "linux",
      windows: [],
    });
  });
});

describe("agent-desktop reader: snapshot", () => {
  test("snapshot flattens the nested tree depth-first with refs <snapshotId>:<index>", async () => {
    const { reader, log } = setup("macos");
    const window = await firstWindow(reader);
    const snap = await reader.snapshot({ windowId: window.windowId });
    expect(snap.platform).toBe("macos");
    expect(snap.snapshotId).toBe(`${reader.prefix}-1`);
    expect(snap.truncated).toBe(false);
    expect(snap.window.windowId).toBe(window.windowId);
    expect(snap.window.title).toBe("sample.txt");
    expect(
      snap.elements
        .slice(0, 5)
        .map(({ type, name, depth }) => ({ type, name, depth })),
    ).toEqual([
      { type: "window", name: "sample.txt", depth: 0 },
      { type: "scrollarea", name: "", depth: 1 },
      { type: "textfield", name: "", depth: 2 },
      { type: "scrollbar", name: "", depth: 2 },
      { type: "scrollbar", name: "", depth: 2 },
    ]);
    expect(snap.elements).toHaveLength(9);
    for (const [i, e] of snap.elements.entries()) {
      expect(e.ref).toBe(`${snap.snapshotId}:${i}`);
      expect(e.ref).toMatch(DESKTOP_REF);
    }
    expect(snap.elements[2]!.value).toBe("hello\n");
    expect(snap.elements[3]!.disabled).toBe(true);
    expect(snap.elements[5]).toEqual({
      ref: `${snap.snapshotId}:5`,
      type: "button",
      name: "Close",
      depth: 1,
    });
    expect(log().find((a) => a[0] === "snapshot")).toEqual([
      "snapshot",
      "--window-id",
      "w-43",
      "--compact",
      "--max-depth",
      "12",
      "--timeout-ms",
      "10000",
    ]);
    // Reading from a control roots the next read at its agent-desktop ref.
    const again = await reader.snapshot({
      windowId: window.windowId,
      from: snap.elements[1]!.ref,
    });
    expect(again.snapshotId).toBe(`${reader.prefix}-2`);
    expect(log().filter((a) => a[0] === "snapshot")[1]).toEqual([
      "snapshot",
      "--root",
      "@s1h53ygbhq22wz:e1",
      "--compact",
      "--max-depth",
      "12",
      "--timeout-ms",
      "10000",
    ]);
  });

  test("flattenTree cuts names, values and the node count, and an incomplete tree is truncated", () => {
    const tree = {
      role: "window",
      name: "n".repeat(300),
      children: Array.from({ length: 900 }, (_, i) => ({
        role: "button",
        name: `b${i}`,
        value: "v".repeat(300),
        ref_id: `@sx:e${i + 1}`,
      })),
    };
    const flat = flattenTree(tree, "abcdef-1", DESKTOP_LIMITS);
    expect(flat.truncated).toBe(true);
    expect(flat.elements).toHaveLength(DESKTOP_LIMITS.treeMaxNodes);
    expect(flat.adRefs).toHaveLength(DESKTOP_LIMITS.treeMaxNodes);
    expect(flat.elements[0]!.name).toHaveLength(DESKTOP_LIMITS.nameMax);
    expect(flat.adRefs[0]).toBeUndefined();
    expect(flat.adRefs[1]).toBe("@sx:e1");
    expect(flat.elements[1]!.value).toHaveLength(DESKTOP_LIMITS.valueMax);
    expect(flattenTree(null, "abcdef-1", DESKTOP_LIMITS)).toEqual({
      elements: [],
      adRefs: [],
      truncated: false,
    });
  });

  test("upstream complete: false is truncated", async () => {
    const data = { ...sample("macos", "snapshot").data, complete: false };
    const { reader } = setup("macos", { snapshot: ok("snapshot", data) });
    const window = await firstWindow(reader);
    expect(
      (await reader.snapshot({ windowId: window.windowId })).truncated,
    ).toBe(true);
  });

  test("a password field never carries a value, on every platform's sample", async () => {
    for (const platform of PLATFORMS) {
      const data = structuredClone(sample(platform, "snapshot-password").data);
      // Whatever upstream sends for a secure field is dropped.
      const plant = (node: Record<string, unknown>) => {
        if (Array.isArray(node.states) && node.states.includes("secure"))
          node.value = "secret123";
        for (const child of (node.children as Record<string, unknown>[]) ?? [])
          plant(child);
      };
      plant(data.tree);
      const { reader } = setup(platform, { snapshot: ok("snapshot", data) });
      const window = await firstWindow(reader);
      const snap = await reader.snapshot({ windowId: window.windowId });
      const passwords = snap.elements.filter((e) => e.password);
      expect(passwords).toHaveLength(1);
      expect(passwords[0]!.type).toBe("textfield");
      expect("value" in passwords[0]!).toBe(false);
      expect(JSON.stringify(snap)).not.toContain("secret123");
      const resolved = reader.resolveRef(passwords[0]!.ref);
      if (typeof resolved === "string") throw new Error(resolved);
      expect(resolved.control.password).toBe(true);
    }
  });

  test("singleLine follows the role Task 1 recorded", async () => {
    const byName = async (platform: DesktopPlatform, key: string) => {
      const { reader } = setup(platform, {
        snapshot: ok("snapshot", sample(platform, key).data),
      });
      const window = await firstWindow(reader);
      const snap = await reader.snapshot({ windowId: window.windowId });
      return { snap, reader };
    };
    // macOS: the multi-line box sits in a scrollarea; the single-line one does not.
    const mac = await byName("macos", "snapshot-password");
    const single = mac.snap.elements.find((e) => e.name === "Single line")!;
    const multi = mac.snap.elements.find((e) => e.name === "Multi line")!;
    expect(single.singleLine).toBe(true);
    expect(multi.singleLine).toBeUndefined();
    const resolved = mac.reader.resolveRef(single.ref);
    if (typeof resolved === "string") throw new Error(resolved);
    expect(resolved.control).toEqual({
      type: "textfield",
      name: "Single line",
      singleLine: true,
    });
    // Only text fields are ever single-line.
    expect(
      mac.snap.elements.find((e) => e.name === "Send")!.singleLine,
    ).toBeUndefined();
    // Windows cannot tell them apart: both count as single-line, so a newline asks first.
    const win = await byName("windows", "snapshot-password");
    expect(
      win.snap.elements.find((e) => e.name === "Multi line")!.singleLine,
    ).toBe(true);
    // Linux: zenity's entry is single-line, gedit's body (in a scrollarea) is not.
    const entry = await byName("linux", "snapshot");
    expect(
      entry.snap.elements.find((e) => e.type === "textfield")!.singleLine,
    ).toBe(true);
    const editor = await byName("linux", "snapshot-editor");
    const body = editor.snap.elements.filter((e) => e.type === "textfield");
    expect(body.length).toBeGreaterThan(0);
    expect(body.some((e) => e.singleLine === undefined)).toBe(true);
  });

  test("only the latest snapshot of a window resolves; an older one, another reader's and a static node do not", async () => {
    const { reader } = setup("macos", {
      snapshot: ok("snapshot", sample("macos", "snapshot-password").data),
    });
    const window = await firstWindow(reader);
    const older = await reader.snapshot({ windowId: window.windowId });
    const latest = await reader.snapshot({ windowId: window.windowId });
    const send = latest.elements.find((e) => e.name === "Send")!;
    const statik = latest.elements.find((e) => e.type === "statictext")!;

    const other = setup("macos", {
      snapshot: ok("snapshot", sample("macos", "snapshot-password").data),
    });
    const otherWindow = await firstWindow(other.reader);
    const foreign = await other.reader.snapshot({
      windowId: otherWindow.windowId,
    });

    expect(reader.resolveRef(send.ref)).toEqual({
      adRef: "@s37cvd8pszfcox:e6",
      windowId: window.windowId,
      adWindowId: "w-43",
      control: { type: "button", name: "Send" },
    });
    expect(
      reader.resolveRef(older.elements.find((e) => e.name === "Send")!.ref),
    ).toBe("stale");
    expect(
      reader.resolveRef(foreign.elements.find((e) => e.name === "Send")!.ref),
    ).toBe("stale");
    expect(reader.resolveRef(statik.ref)).toBe("not_actionable");
    // Malformed refs and indexes past the end are stale too.
    expect(reader.resolveRef("nonsense")).toBe("stale");
    expect(reader.resolveRef(`${latest.snapshotId}:999`)).toBe("stale");

    // A read rooted at an older snapshot's ref is refused as stale, before any command.
    const error = await rejected(
      reader.snapshot({
        windowId: window.windowId,
        from: older.elements[1]!.ref,
      }),
    );
    expect(error.code).toBe("stale");
    expect(error.message).toBe("界面已变化，请重新读取窗口。");
    const foreignFrom = await rejected(
      reader.snapshot({
        windowId: window.windowId,
        from: foreign.elements[1]!.ref,
      }),
    );
    expect(foreignFrom.code).toBe("stale");
  });

  test("invalidate(windowId) makes that window's refs stale and leaves the others", async () => {
    const { reader } = setup("macos");
    const { windows } = await reader.windows();
    expect(windows.length).toBeGreaterThanOrEqual(2);
    const [w1, w2] = windows as [(typeof windows)[0], (typeof windows)[0]];
    const s1 = await reader.snapshot({ windowId: w1.windowId });
    const s2 = await reader.snapshot({ windowId: w2.windowId });
    const r1 = s1.elements[2]!.ref;
    const r2 = s2.elements[2]!.ref;
    expect(typeof reader.resolveRef(r1)).toBe("object");
    expect(typeof reader.resolveRef(r2)).toBe("object");
    reader.invalidate(w1.windowId);
    expect(reader.resolveRef(r1)).toBe("stale");
    expect(typeof reader.resolveRef(r2)).toBe("object");
    reader.invalidate();
    expect(reader.resolveRef(r2)).toBe("stale");
    // The window ids themselves stay valid.
    expect(reader.adWindow(w1.windowId)).toBeDefined();
  });

  test("only the latest 16 windows keep a snapshot", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      accessible: true,
      app_name: "app",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      id: `w-${i + 1}`,
      is_focused: false,
      pid: 500 + i,
      process_instance: "x",
      title: `win ${i}`,
      visible: true,
    }));
    const { reader } = setup("macos", {
      "list-windows": ok("list-windows", many),
    });
    const { windows } = await reader.windows();
    const refs: string[] = [];
    for (const w of windows.slice(0, 17)) {
      const snap = await reader.snapshot({ windowId: w.windowId });
      refs.push(snap.elements[2]!.ref);
    }
    expect(reader.resolveRef(refs[0]!)).toBe("stale");
    for (const ref of refs.slice(1))
      expect(typeof reader.resolveRef(ref)).toBe("object");
  }, 20_000);

  test("a title that turned sensitive is refused before any snapshot command runs", async () => {
    const { reader, log, set } = setup("macos");
    const window = await firstWindow(reader);
    const turned = sample("macos", "list-windows").data.map(
      (w: { id: string }) =>
        w.id === "w-43" ? { ...w, title: "Bank login" } : w,
    );
    set("list-windows", ok("list-windows", turned));
    const error = await rejected(
      reader.snapshot({ windowId: window.windowId, screenshot: true }),
    );
    expect(error.code).toBe("sensitive");
    expect(error.message).toBe(desktopMessage("sensitive", "bank"));
    expect(
      log().filter((a) => a[0] === "snapshot" || a[0] === "screenshot"),
    ).toEqual([]);

    // With the owner's approval it reads.
    const snap = await reader.snapshot({
      windowId: window.windowId,
      allowSensitive: true,
    });
    expect(snap.window.title).toBe("Bank login");

    // A read rooted at a control of the earlier snapshot is refused the same way, before any command.
    const before = log().filter(
      (a) => a[0] === "snapshot" || a[0] === "screenshot",
    ).length;
    const fromError = await rejected(
      reader.snapshot({
        windowId: window.windowId,
        from: snap.elements[1]!.ref,
        screenshot: true,
      }),
    );
    expect(fromError.code).toBe("sensitive");
    expect(fromError.message).toBe(desktopMessage("sensitive", "bank"));
    expect(
      log().filter((a) => a[0] === "snapshot" || a[0] === "screenshot"),
    ).toHaveLength(before);

    // A window that is gone from the live list is no_window, still before any snapshot.
    set("list-windows", ok("list-windows", []));
    expect(
      (await rejected(reader.snapshot({ windowId: window.windowId }))).code,
    ).toBe("no_window");
  });

  test("a screenshot is attached, scaled to 1280, or explained", async () => {
    // The sample's 1x1 picture comes back as is.
    const plain = setup("windows");
    const w = await firstWindow(plain.reader);
    const snap = await plain.reader.snapshot({
      windowId: w.windowId,
      screenshot: true,
    });
    expect(snap.image).toEqual({
      base64: sample("windows", "screenshot").data.data,
      width: 1,
      height: 1,
    });
    expect(plain.log().find((a) => a[0] === "screenshot")).toEqual([
      "screenshot",
      "--window-id",
      "w-66058",
    ]);

    // A wide picture is scaled down.
    const wide = rgbaPng(2560, 100);
    const big = setup("windows", {
      screenshot: ok("screenshot", {
        data: Buffer.from(wide).toString("base64"),
        format: "png",
        width: 2560,
        height: 100,
        scale_factor: 1,
      }),
    });
    const bw = await firstWindow(big.reader);
    const bigSnap = await big.reader.snapshot({
      windowId: bw.windowId,
      screenshot: true,
    });
    expect(bigSnap.image?.width).toBe(1280);
    expect(bigSnap.image?.height).toBe(50);

    // A picture the scaler cannot read: the tree comes back without it.
    const odd = setup("windows", {
      screenshot: ok("screenshot", {
        data: Buffer.from("not a png").toString("base64"),
        format: "png",
        width: 3,
        height: 3,
        scale_factor: 1,
      }),
    });
    const ow = await firstWindow(odd.reader);
    const oddSnap = await odd.reader.snapshot({
      windowId: ow.windowId,
      screenshot: true,
    });
    expect(oddSnap.image).toBeUndefined();
    expect(oddSnap.imageError).toBe("这张截图的格式无法缩小，没有附上。");
    expect(oddSnap.elements.length).toBeGreaterThan(0);

    // No screen-recording permission: the tree comes back without a picture.
    const denied = setup("macos", { screenshot: { error: "PERM_DENIED" } });
    const dw = await firstWindow(denied.reader);
    const deniedSnap = await denied.reader.snapshot({
      windowId: dw.windowId,
      screenshot: true,
    });
    expect(deniedSnap.image).toBeUndefined();
    expect(deniedSnap.imageError).toBe("没有屏幕录制权限，截不到图。");
    expect(deniedSnap.elements.length).toBeGreaterThan(0);

    // No picture is taken unless asked for.
    const none = setup("linux");
    const nw = await firstWindow(none.reader);
    const noneSnap = await none.reader.snapshot({ windowId: nw.windowId });
    expect(noneSnap.image).toBeUndefined();
    expect(noneSnap.imageError).toBeUndefined();
    expect(none.log().filter((a) => a[0] === "screenshot")).toEqual([]);
  });
});

describe("agent-desktop reader: timeouts and invalidation", () => {
  /** A fake CLI whose every `snapshot` waits until the test lets it answer. */
  function gatedReader() {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const waiting: Array<() => void> = [];
    let onWaiting: (() => void) | undefined;
    const reader = createAgentDesktopReader({
      platform: "macos",
      cli: fakeCli(async (args, opts) => {
        calls.push({ args: [...args], timeoutMs: opts?.timeoutMs });
        if (args[0] === "list-windows")
          return sample("macos", "list-windows").data;
        if (args[0] === "list-displays")
          return sample("macos", "list-displays").data;
        if (args[0] === "snapshot") {
          await new Promise<void>((r) => {
            waiting.push(r);
            onWaiting?.();
          });
          return sample("macos", "snapshot").data;
        }
        return {};
      }),
    });
    /** Resolves once a snapshot command is waiting on the gate. */
    const snapshotRunning = () =>
      waiting.length > 0
        ? Promise.resolve()
        : new Promise<void>((r) => {
            onWaiting = r;
          });
    const release = () => waiting.shift()?.();
    /** Runs one snapshot straight through. */
    const read = async (windowId: string) => {
      const p = reader.snapshot({ windowId });
      await snapshotRunning();
      release();
      return p;
    };
    return { reader, calls, snapshotRunning, release, read };
  }

  test("the snapshot command gets the CLI's 20 s budget while agent-desktop keeps its own 10 s", async () => {
    const { reader, calls, read } = gatedReader();
    const window = await firstWindow(reader);
    await read(window.windowId);
    const snapshot = calls.find((c) => c.args[0] === "snapshot")!;
    expect(snapshot.timeoutMs).toBe(DESKTOP_LIMITS.adCommandTimeoutMs);
    expect(snapshot.timeoutMs).toBe(20_000);
    expect(snapshot.args.slice(-2)).toEqual(["--timeout-ms", "10000"]);
    // Other commands keep the CLI's default.
    for (const c of calls.filter((c) => c.args[0] !== "snapshot"))
      expect(c.timeoutMs).toBeUndefined();
  });

  test("a snapshot whose window is invalidated while it runs returns, but its refs are stale", async () => {
    for (const invalidateAll of [false, true]) {
      const { reader, snapshotRunning, release, read } = gatedReader();
      const { windows } = await reader.windows();
      const [target, other] = windows as [
        (typeof windows)[0],
        (typeof windows)[0],
      ];
      const otherSnap = await read(other.windowId);
      // Invalidated while agent-desktop is still reading the tree.
      const pending = reader.snapshot({ windowId: target.windowId });
      await snapshotRunning();
      reader.invalidate(invalidateAll ? undefined : target.windowId);
      release();
      const snap = await pending;
      expect(snap.elements.length).toBeGreaterThan(0);
      expect(reader.resolveRef(snap.elements[2]!.ref)).toBe("stale");
      expect(typeof reader.resolveRef(otherSnap.elements[2]!.ref)).toBe(
        invalidateAll ? "string" : "object",
      );
      // The next snapshot, started after the invalidation, resolves again.
      const fresh = await read(target.windowId);
      expect(typeof reader.resolveRef(fresh.elements[2]!.ref)).toBe("object");
    }
  });

  test("invalidating another window while a snapshot runs leaves its refs alone", async () => {
    const { reader, snapshotRunning, release } = gatedReader();
    const { windows } = await reader.windows();
    const [target, other] = windows as [
      (typeof windows)[0],
      (typeof windows)[0],
    ];
    const pending = reader.snapshot({ windowId: target.windowId });
    await snapshotRunning();
    reader.invalidate(other.windowId);
    release();
    const snap = await pending;
    expect(typeof reader.resolveRef(snap.elements[2]!.ref)).toBe("object");
  });
});

describe("agent-desktop reader: errors", () => {
  const cases: Array<{
    name: string;
    platform: DesktopPlatform;
    snapshot: Command;
    code: string;
    message: string;
  }> = [
    {
      name: "WINDOW_NOT_FOUND",
      platform: "windows",
      snapshot: { error: "WINDOW_NOT_FOUND" },
      code: "no_window",
      message: "找不到这个窗口，请重新列出窗口。",
    },
    {
      name: "APP_NOT_FOUND",
      platform: "linux",
      snapshot: err("snapshot", "APP_NOT_FOUND"),
      code: "no_window",
      message: "找不到这个窗口，请重新列出窗口。",
    },
    {
      name: "STALE_REF",
      platform: "macos",
      snapshot: { error: "STALE_REF" },
      code: "stale",
      message: "界面已变化，请重新读取窗口。",
    },
    {
      name: "SNAPSHOT_NOT_FOUND",
      platform: "windows",
      snapshot: { error: "SNAPSHOT_NOT_FOUND" },
      code: "stale",
      message: "界面已变化，请重新读取窗口。",
    },
    {
      name: "ELEMENT_NOT_FOUND",
      platform: "macos",
      snapshot: err("snapshot", "ELEMENT_NOT_FOUND"),
      code: "stale",
      message: "界面已变化，请重新读取窗口。",
    },
    {
      name: "PERM_DENIED on macOS",
      platform: "macos",
      snapshot: err("snapshot", "PERM_DENIED"),
      code: "mac_permission",
      message: desktopMessage("mac_permission"),
    },
    {
      name: "PERM_DENIED with E_ACCESSDENIED on Windows",
      platform: "windows",
      snapshot: { error: "PERM_DENIED" },
      code: "elevated",
      message: "这个窗口需要管理员权限，员工无法操作。",
    },
    {
      name: "PERM_DENIED with 0x80070005 on Windows",
      platform: "windows",
      snapshot: err("snapshot", "PERM_DENIED", {
        platform_detail: "HRESULT 0x80070005",
      }),
      code: "elevated",
      message: "这个窗口需要管理员权限，员工无法操作。",
    },
    {
      name: "AMBIGUOUS_TARGET",
      platform: "linux",
      snapshot: { error: "AMBIGUOUS_TARGET" },
      code: "ambiguous",
      message: desktopMessage("ambiguous"),
    },
    {
      name: "POLICY_DENIED",
      platform: "windows",
      snapshot: { error: "POLICY_DENIED" },
      code: "policy_denied",
      message: desktopMessage("policy_denied"),
    },
    {
      name: "ACTION_NOT_SUPPORTED",
      platform: "macos",
      snapshot: err("snapshot", "ACTION_NOT_SUPPORTED"),
      code: "policy_denied",
      message: desktopMessage("policy_denied"),
    },
    {
      name: "anything else",
      platform: "windows",
      snapshot: err("snapshot", "INTERNAL"),
      code: "failed",
      message: "桌面操作没有成功：INTERNAL：INTERNAL happened at <路径>",
    },
    {
      name: "PERM_DENIED without an access-denied detail on Windows",
      platform: "windows",
      snapshot: err("snapshot", "PERM_DENIED"),
      code: "failed",
      message: "桌面操作没有成功：PERM_DENIED：PERM_DENIED happened at <路径>",
    },
  ];

  test("errors map to the Chinese copy", async () => {
    for (const c of cases) {
      const { reader } = setup(c.platform, { snapshot: c.snapshot });
      const window = await firstWindow(reader);
      const error = await rejected(
        reader.snapshot({ windowId: window.windowId }),
      );
      expect({
        name: c.name,
        code: error.code,
        message: error.message,
      }).toEqual({
        name: c.name,
        code: c.code,
        message: c.message,
      });
      expect(error).toBeInstanceOf(DesktopHelperError);
      expect(readFailure(error)).toEqual({ ok: false, error: c.message });
    }
    // A listing fails the same way.
    const { reader } = setup("windows", {
      "list-windows": { error: "POLICY_DENIED" },
    });
    expect((await rejected(reader.windows())).code).toBe("policy_denied");
  }, 20_000);

  test("no read outcome is outcomeUnknown", async () => {
    const failures: unknown[] = [];
    for (const c of cases) {
      const { reader } = setup(c.platform, { snapshot: c.snapshot });
      const window = await firstWindow(reader);
      failures.push(
        await rejected(reader.snapshot({ windowId: window.windowId })),
      );
    }
    // The CLI timed out after it had started the command.
    const timeout = new DesktopHelperError(
      "timeout",
      desktopMessage("timeout", "10"),
      true,
    );
    const timingOut = createAgentDesktopReader({
      platform: "macos",
      cli: fakeCli(async (args) => {
        if (args[0] === "list-windows")
          return sample("macos", "list-windows").data;
        if (args[0] === "list-displays")
          return sample("macos", "list-displays").data;
        throw timeout;
      }),
    });
    const tw = await firstWindow(timingOut);
    failures.push(
      await rejected(timingOut.snapshot({ windowId: tw.windowId })),
    );
    // Stopped while the snapshot ran.
    const abort = Object.assign(new Error("aborted"), {
      name: "AbortError",
      sent: true,
    });
    const aborting = createAgentDesktopReader({
      platform: "macos",
      cli: fakeCli(async (args) => {
        if (args[0] === "list-windows")
          return sample("macos", "list-windows").data;
        if (args[0] === "list-displays")
          return sample("macos", "list-displays").data;
        throw abort;
      }),
    });
    const aw = await firstWindow(aborting);
    failures.push(await rejected(aborting.snapshot({ windowId: aw.windowId })));
    failures.push(new Error("something unexpected"));

    for (const failure of failures) {
      expect((failure as Failure).outcomeUnknown).toBeUndefined();
      const outcome = readFailure(failure);
      expect(outcome.ok).toBe(false);
      expect("outcomeUnknown" in outcome).toBe(false);
    }
    expect(readFailure(timeout)).toEqual({
      ok: false,
      error: desktopMessage("timeout", "10"),
    });
    expect(readFailure(abort)).toEqual({
      ok: false,
      error: "已在设备上停止。",
    });
    expect(readFailure(new Error("x"))).toEqual({
      ok: false,
      error: desktopMessage("failed"),
    });
  }, 20_000);
});

/** An 8-bit RGBA PNG of one colour, for the screenshot path. */
function rgbaPng(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4)).fill(200);
  for (let y = 0; y < height; y++) raw[y * (1 + width * 4)] = 0;
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}
