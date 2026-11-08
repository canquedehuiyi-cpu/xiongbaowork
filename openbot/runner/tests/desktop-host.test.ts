import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopHost,
  DesktopHelperError,
  HELPER_OPS,
  type HelperLaunchSpec,
} from "../src/desktop/host";

const FAKE = join(import.meta.dir, "fixtures", "fake-desktop-helper.ts");
const LOGS = mkdtempSync(join(tmpdir(), "desktop-host-"));
let logs = 0;

afterAll(() => rmSync(LOGS, { recursive: true, force: true }));

/** A fresh file for FAKE_DESKTOP_LOG, and a reader for the request lines the helper received. */
function requestLog() {
  const path = join(LOGS, `requests-${++logs}.log`);
  const read = (): string[] => {
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { path, read };
}

type Host = ReturnType<typeof createDesktopHost>;
const hosts: Host[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

/** A host over the fake helper, counting how many times it was asked to start one. */
function fakeHost(
  mode: string,
  options: {
    env?: Record<string, string>;
    preamble?: string;
    idleMs?: number;
    startMs?: number;
    timeoutMs?: number;
    maxLineChars?: number;
  } = {},
) {
  const spawns = { count: 0 };
  const exits = { count: 0 };
  const spec = (): HelperLaunchSpec => {
    spawns.count += 1;
    return {
      command: process.execPath,
      args: [FAKE],
      env: { FAKE_DESKTOP_MODE: mode, ...options.env },
      ...(options.preamble === undefined ? {} : { preamble: options.preamble }),
    };
  };
  const host = createDesktopHost({
    spec,
    idleMs: options.idleMs,
    startMs: options.startMs,
    timeoutMs: options.timeoutMs,
    maxLineChars: options.maxLineChars,
    onExit: () => {
      exits.count += 1;
    },
  });
  hosts.push(host);
  return { host, spawns, exits };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

type Echo = { op: string; pid: number; maxInflight: number };

describe("desktop helper host", () => {
  test("lazy: nothing is spawned until the first request", async () => {
    const { host, spawns } = fakeHost("ok");
    await Bun.sleep(50);
    expect(spawns.count).toBe(0);
    expect(host.running).toBe(false);
    expect(host.prefix).toBeUndefined();

    const result = await host.request<{ windows: { title: string }[] }>({
      op: "windows",
      max: 50,
    });
    expect(result.windows.map((window) => window.title)).toEqual([
      "无标题 - 记事本",
      "招商银行 - Google Chrome",
    ]);
    expect(spawns.count).toBe(1);
    expect(host.running).toBe(true);
    expect(host.prefix).toMatch(/^[0-9a-f]{6}$/);
    expect(host.nextSnapshotId()).toBe(`${host.prefix}-1`);
    expect(host.nextSnapshotId()).toBe(`${host.prefix}-2`);

    // The same helper serves the next request.
    await host.request({ op: "tree" });
    expect(spawns.count).toBe(1);
  });

  test("only windows, tree and screenshot reach the helper; anything else is refused unsent", async () => {
    expect([...HELPER_OPS].sort()).toEqual(["screenshot", "tree", "windows"]);
    const { host, spawns } = fakeHost("ok");
    for (const op of ["click", "type", "key", "launch", "focus"]) {
      const error = await rejection(host.request({ op }));
      expect(error).toBeInstanceOf(DesktopHelperError);
      expect((error as DesktopHelperError).code).toBe("unsupported");
      expect((error as DesktopHelperError).sent).toBe(false);
    }
    for (const op of ["Windows", "tree ", "__proto__", "constructor", 7]) {
      const error = await rejection(
        host.request({ op } as unknown as { op: string }),
      );
      expect((error as DesktopHelperError).code).toBe("unsupported");
      expect((error as DesktopHelperError).sent).toBe(false);
    }
    expect(spawns.count).toBe(0);
    expect(host.running).toBe(false);
  });

  test("a request changed after the check is still written as checked: mutating it while it waits", async () => {
    const log = requestLog();
    const { host } = fakeHost("slow", {
      env: { FAKE_DESKTOP_DELAY_MS: "150", FAKE_DESKTOP_LOG: log.path },
    });
    // Queued behind a request in flight, then changed.
    const first = host.request<Echo>({ op: "tree" });
    const queued = { op: "screenshot" };
    const second = host.request<Echo>(queued);
    queued.op = "click";
    // Changed before its turn, while the first two are still to be answered.
    const third = { op: "tree" } as { op: string; [key: string]: unknown };
    const answer = host.request<Echo>(third);
    third.op = "click";
    third.fail = "stale";
    expect((await first).op).toBe("tree");
    expect((await second).op).toBe("screenshot");
    expect((await answer).op).toBe("tree");
    const sent = log.read().map((line) => JSON.parse(line).op);
    expect(sent).toEqual(["tree", "screenshot", "tree"]);
    expect(log.read().join("\n")).not.toContain("click");
  });

  test("a request changed after the check is still written as checked: a getter that answers twice", async () => {
    const log = requestLog();
    const { host } = fakeHost("ok", { env: { FAKE_DESKTOP_LOG: log.path } });
    let reads = 0;
    const tricky = {
      get op() {
        reads += 1;
        return reads === 1 ? "tree" : "click";
      },
    };
    const result = await host.request<Echo>(tricky);
    expect(result.op).toBe("tree");
    expect(reads).toBe(1);
    expect(log.read().map((line) => JSON.parse(line).op)).toEqual(["tree"]);
  });

  test("a request changed after the check is still written as checked: its own toJSON", async () => {
    const log = requestLog();
    const { host, spawns } = fakeHost("ok", {
      env: { FAKE_DESKTOP_LOG: log.path },
    });
    // What it serialises to is what is checked: click is refused, unsent, nothing started.
    const sneaky = {
      op: "tree",
      toJSON() {
        return { op: "click", id: 1 };
      },
    };
    const error = await rejection(host.request(sneaky));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("unsupported");
    expect((error as DesktopHelperError).sent).toBe(false);
    expect(spawns.count).toBe(0);

    // A caller's id is never written: the host numbers requests itself.
    const spoof = {
      op: "screenshot",
      toJSON() {
        return { op: "tree", id: 424242 };
      },
    };
    expect((await host.request<Echo>(spoof)).op).toBe("tree");
    const lines = log.read().map((line) => JSON.parse(line));
    expect(lines.map((line) => line.op)).toEqual(["tree"]);
    expect(lines[0].id).not.toBe(424242);
    expect(log.read().join("\n")).not.toContain("click");
  });

  test("a request that cannot be serialised is refused unsent", async () => {
    const { host, spawns } = fakeHost("ok");
    const circular: { op: string; self?: unknown } = { op: "tree" };
    circular.self = circular;
    for (const op of [circular, { op: "tree", big: 1n }]) {
      const error = await rejection(host.request(op));
      expect(error).toBeInstanceOf(DesktopHelperError);
      expect((error as DesktopHelperError).code).toBe("failed");
      expect((error as DesktopHelperError).sent).toBe(false);
    }
    expect(spawns.count).toBe(0);
  });

  test("changing HELPER_OPS, or the set a host was given, widens no host", async () => {
    const given = new Set(["tree"]);
    const { host: narrow } = fakeHost("ok");
    const custom = createDesktopHost({
      spec: () => ({ command: process.execPath, args: [FAKE] }),
      ops: given,
    });
    hosts.push(custom);
    (HELPER_OPS as Set<string>).add("click");
    given.add("click");
    try {
      for (const host of [narrow, custom]) {
        const error = await rejection(host.request({ op: "click" }));
        expect((error as DesktopHelperError).code).toBe("unsupported");
        expect((error as DesktopHelperError).sent).toBe(false);
      }
    } finally {
      (HELPER_OPS as Set<string>).delete("click");
    }
  });

  test("non-JSON lines before ready and between responses are ignored", async () => {
    const { host } = fakeHost("noise", { preamble: "$ProgressPreference='x'" });
    const first = await host.request<Echo>({ op: "tree" });
    const second = await host.request<Echo>({ op: "screenshot" });
    expect(first.op).toBe("tree");
    expect(second.op).toBe("screenshot");
  });

  test("a Chinese answer split mid-character arrives intact", async () => {
    const { host } = fakeHost("split");
    const result = await host.request<{ text: string }>({ op: "tree" });
    expect(result.text).toBe("熊宝员工");
  });

  test("requests are serial: two concurrent requests never overlap", async () => {
    const { host } = fakeHost("slow", {
      env: { FAKE_DESKTOP_DELAY_MS: "150" },
    });
    const results = await Promise.all([
      host.request<Echo>({ op: "tree" }),
      host.request<Echo>({ op: "screenshot" }),
      host.request<Echo>({ op: "tree" }),
    ]);
    expect(results.map((result) => result.maxInflight)).toEqual([1, 1, 1]);
    expect(results.map((result) => result.op)).toEqual([
      "tree",
      "screenshot",
      "tree",
    ]);
  });

  test("a helper's own error code comes back with sent true", async () => {
    const { host } = fakeHost("ok");
    const error = await rejection(host.request({ op: "tree", fail: "stale" }));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("stale");
    expect((error as DesktopHelperError).sent).toBe(true);
    expect((error as DesktopHelperError).message).toBe("fake failure");

    const unknown = await rejection(
      host.request({ op: "tree", fail: "exploded" }),
    );
    expect((unknown as DesktopHelperError).code).toBe("failed");
    // An error answer does not cost the helper.
    expect(host.running).toBe(true);
  });

  test("a line with the request's id but no ok is not an answer", async () => {
    const { host } = fakeHost("ok");
    const result = await host.request<Echo>({ op: "tree", echo: true });
    expect(result.op).toBe("tree");
    expect(result.pid).toBeGreaterThan(0);
  });

  test("a stdout line past the length limit ends the helper and fails the request", async () => {
    const { host, exits } = fakeHost("ok", { maxLineChars: 1000 });
    const { pid } = await host.request<Echo>({ op: "tree" });
    const error = await rejection(host.request({ op: "tree", flood: 5000 }));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("failed");
    expect((error as DesktopHelperError).sent).toBe(true);
    expect(host.running).toBe(false);
    expect(await until(() => !alive(pid))).toBe(true);
    expect(await until(() => exits.count === 1)).toBe(true);
  });

  test("a helper that exits mid-request rejects with failed and sent true", async () => {
    const { host } = fakeHost("ok");
    const error = await rejection(host.request({ op: "tree", exit: true }));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("failed");
    expect((error as DesktopHelperError).sent).toBe(true);
    expect(host.running).toBe(false);
    // The next request starts another.
    expect((await host.request<Echo>({ op: "tree" })).op).toBe("tree");
  });

  test("a helper that dies on start rejects with start_failed and the stderr tail", async () => {
    const { host } = fakeHost("crash", {
      preamble: "Add-Type -TypeDefinition x",
    });
    const error = await rejection(host.request({ op: "windows" }));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("start_failed");
    expect((error as DesktopHelperError).sent).toBe(false);
    expect((error as DesktopHelperError).stderrTail).toContain("编译错误");
    expect(host.running).toBe(false);
  });

  test("the stderr tail is at most 4096 bytes and never starts inside a character", async () => {
    const { host } = fakeHost("crash", {
      preamble: "Add-Type -TypeDefinition x",
      env: { FAKE_DESKTOP_STDERR_FILL: "5000" },
    });
    const error = await rejection(host.request({ op: "windows" }));
    const tail = (error as DesktopHelperError).stderrTail ?? "";
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(4000);
    expect(tail).not.toContain("\uFFFD");
    expect(tail.endsWith("Add-Type : 编译错误\n")).toBe(true);
  });

  test("no ready within startMs rejects with start_failed", async () => {
    const { host } = fakeHost("noready", { startMs: 300 });
    const started = Date.now();
    const error = await rejection(host.request({ op: "windows" }));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("start_failed");
    expect((error as DesktopHelperError).sent).toBe(false);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(host.running).toBe(false);
  });

  test("timeout kills the helper, rejects with timeout and sent true; the next request starts a new one with a new prefix", async () => {
    const { host, spawns } = fakeHost("slow", {
      env: { FAKE_DESKTOP_DELAY_MS: "300" },
    });
    const first = await host.request<Echo>({ op: "tree" });
    const prefix = host.prefix;
    expect(prefix).toMatch(/^[0-9a-f]{6}$/);

    const error = await rejection(
      host.request({ op: "tree" }, { timeoutMs: 100 }),
    );
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("timeout");
    expect((error as DesktopHelperError).sent).toBe(true);
    expect(host.running).toBe(false);
    expect(host.prefix).toBeUndefined();
    expect(await until(() => !alive(first.pid))).toBe(true);

    const next = await host.request<Echo>({ op: "tree" });
    expect(spawns.count).toBe(2);
    expect(next.pid).not.toBe(first.pid);
    expect(host.prefix).toMatch(/^[0-9a-f]{6}$/);
    expect(host.prefix).not.toBe(prefix);
    expect(host.nextSnapshotId()).toBe(`${host.prefix}-1`);
  });

  test("abort before the request was written rejects with sent false", async () => {
    // Already aborted: nothing starts.
    const { host, spawns, exits } = fakeHost("noready", { startMs: 5000 });
    const early = await rejection(
      host.request({ op: "windows" }, { signal: AbortSignal.abort() }),
    );
    expect((early as Error).name).toBe("AbortError");
    expect((early as { sent?: boolean }).sent).toBe(false);
    expect(spawns.count).toBe(0);

    // Aborted while the helper is still starting: the helper is ended too.
    const controller = new AbortController();
    const pending = rejection(
      host.request({ op: "windows" }, { signal: controller.signal }),
    );
    await Bun.sleep(150);
    expect(host.running).toBe(true);
    controller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
    expect((error as { sent?: boolean }).sent).toBe(false);
    expect(host.running).toBe(false);
    // Really gone, not just forgotten.
    expect(await until(() => exits.count === 1)).toBe(true);
    expect(spawns.count).toBe(1);
  });

  test("abort while waiting behind another request leaves that request alone", async () => {
    const { host } = fakeHost("slow", {
      env: { FAKE_DESKTOP_DELAY_MS: "200" },
    });
    const controller = new AbortController();
    const running = host.request<Echo>({ op: "tree" });
    const queued = rejection(
      host.request({ op: "screenshot" }, { signal: controller.signal }),
    );
    await Bun.sleep(50);
    controller.abort();
    const error = await queued;
    expect((error as Error).name).toBe("AbortError");
    expect((error as { sent?: boolean }).sent).toBe(false);
    expect((await running).op).toBe("tree");
    expect(host.running).toBe(true);
  });

  test("abort after the request was written ends the helper and says sent true", async () => {
    const { host } = fakeHost("slow", {
      env: { FAKE_DESKTOP_DELAY_MS: "2000" },
    });
    const controller = new AbortController();
    const pending = rejection(
      host.request({ op: "tree" }, { signal: controller.signal }),
    );
    await until(() => host.prefix !== undefined);
    await Bun.sleep(100);
    controller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
    expect((error as { sent?: boolean }).sent).toBe(true);
    expect(host.running).toBe(false);
  });

  test("session 0 refuses every request with session0", async () => {
    const { host, spawns, exits } = fakeHost("session0");
    for (let i = 0; i < 3; i++) {
      const error = await rejection(host.request({ op: "windows" }));
      expect(error).toBeInstanceOf(DesktopHelperError);
      expect((error as DesktopHelperError).code).toBe("session0");
      expect((error as DesktopHelperError).sent).toBe(false);
    }
    // Not restarted for each request: there is no desktop to find next time either.
    expect(spawns.count).toBe(1);
    expect(host.running).toBe(false);
    // The helper that had no desktop was ended, not left running.
    expect(await until(() => exits.count === 1)).toBe(true);
  });

  test("idle: the helper exits after idleMs", async () => {
    let exits = 0;
    const host = createDesktopHost({
      spec: () => ({
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_DESKTOP_MODE: "ok" },
      }),
      idleMs: 500,
      onExit: () => {
        exits += 1;
      },
    });
    hosts.push(host);
    const { pid } = await host.request<Echo>({ op: "tree" });
    expect(host.running).toBe(true);
    // Used again before it idles out: the clock starts over.
    await Bun.sleep(300);
    const again = await host.request<Echo>({ op: "tree" });
    // The same helper answered: it had not idled out in between.
    expect(again.pid).toBe(pid);
    await Bun.sleep(300);
    expect(host.running).toBe(true);
    expect(await until(() => !host.running, 2000)).toBe(true);
    expect(host.prefix).toBeUndefined();
    expect(await until(() => !alive(pid))).toBe(true);
    expect(await until(() => exits === 1)).toBe(true);
  });

  test("close ends the helper and waits for it", async () => {
    const { host } = fakeHost("ok");
    const { pid } = await host.request<Echo>({ op: "tree" });
    await host.close();
    expect(host.running).toBe(false);
    expect(alive(pid)).toBe(false);
  });
});
