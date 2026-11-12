import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdError,
  AgentDesktopError,
  agentDesktopEnv,
  createAgentDesktopCli,
  FORBIDDEN_AD_ARGS,
} from "../src/desktop/agent-desktop";
import { DesktopHelperError } from "../src/desktop/host";

const FAKE = join(import.meta.dir, "fixtures", "fake-agent-desktop.ts");
const ERRORS = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "agent-desktop", "errors.json"),
    "utf8",
  ),
);

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

type Script = {
  platform?: string;
  commands?: Record<string, Record<string, unknown>>;
};

function setup(
  script: Script = {},
  extra: Partial<Parameters<typeof createAgentDesktopCli>[0]> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ad-cli-"));
  const stateDir = join(root, "state");
  const logPath = join(root, "log.jsonl");
  writeFileSync(logPath, "");
  // The fake runs under `bun`; the CLI's own env allow-list does not pass FAKE_AD_*, so they ride in here.
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
    stateDir,
    spawn,
    ...extra,
  });
  cleanup.push(async () => {
    await cli.close();
    rmSync(root, { recursive: true, force: true });
  });
  const log = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            args: string[];
            stdin?: string;
            env: Record<string, string>;
            startedAt: number;
            pid: number;
            childPid?: number;
            prevAlive: number[];
          },
      );
  return { cli, stateDir, root, log };
}

type Failure = {
  name: string;
  code: string;
  message: string;
  sent?: boolean;
  exitCode?: number;
  notDelivered?: boolean;
  detail?: string;
};
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (e: unknown) => e as Failure,
  );

/** Running, not merely an unreaped zombie. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

describe("agent-desktop CLI layer", () => {
  test("the first call checks version 1.2.0 once; a wrong version is 桌面助手启动失败：版本不对", async () => {
    const good = setup();
    await good.cli.run(["list-windows"]);
    await good.cli.run(["list-windows"]);
    expect(good.log().map((e) => e.args[0])).toEqual([
      "version",
      "list-windows",
      "list-windows",
    ]);

    const bad = setup({
      commands: {
        version: {
          envelope: {
            version: "2.6",
            ok: true,
            command: "version",
            data: { os: "linux", target: "x86_64", version: "1.1.0" },
          },
        },
      },
    });
    const error = await rejected(bad.cli.ensureReady());
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect(error.code).toBe("start_failed");
    expect(error.message).toBe("桌面助手启动失败：版本不对：1.1.0");
    // A failure is not cached: the next call tries again, once.
    await bad.cli.ensureReady().catch(() => {});
    expect(bad.log().filter((e) => e.args[0] === "version")).toHaveLength(2);
  });

  test("a missing binary is 桌面助手启动失败：没有找到 agent-desktop and nothing is retried in a loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "ad-cli-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    let spawns = 0;
    const real = Bun.spawn;
    const cli = createAgentDesktopCli({
      binary: join(root, "no-such-binary"),
      stateDir: join(root, "state"),
      spawn: ((...a: unknown[]) => {
        spawns++;
        return (real as (...x: unknown[]) => unknown)(...a);
      }) as unknown as typeof Bun.spawn,
    });
    const error = await rejected(cli.run(["list-windows"]));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect(error.code).toBe("start_failed");
    expect(error.message).toBe("桌面助手启动失败：没有找到 agent-desktop");
    expect(spawns).toBe(1);
  });

  test("the child sees AGENT_DESKTOP_HOME = stateDir (0700) and no other AGENT_DESKTOP_* variable", async () => {
    const saved = {
      s: process.env.AGENT_DESKTOP_SESSION,
      a: process.env.AGENT_DESKTOP_AGENT_ID,
    };
    process.env.AGENT_DESKTOP_SESSION = "x";
    process.env.AGENT_DESKTOP_AGENT_ID = "y";
    cleanup.push(() => {
      for (const [k, v] of [
        ["AGENT_DESKTOP_SESSION", saved.s],
        ["AGENT_DESKTOP_AGENT_ID", saved.a],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const { cli, stateDir, log } = setup();
    await cli.run(["list-windows"]);
    for (const entry of log()) {
      const keys = Object.keys(entry.env).filter((k) =>
        k.startsWith("AGENT_DESKTOP_"),
      );
      expect(keys).toEqual(["AGENT_DESKTOP_HOME"]);
      expect(entry.env.AGENT_DESKTOP_HOME).toBe(stateDir);
    }
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(
      agentDesktopEnv(
        { PATH: "/bin", AGENT_DESKTOP_X: "1", SECRET: "s" },
        "/s",
      ),
    ).toEqual({ PATH: "/bin", AGENT_DESKTOP_HOME: "/s" });
  });

  test("an existing state directory with loose permissions is emptied and recreated 0700", async () => {
    const { cli, stateDir } = setup();
    await mkdir(join(stateDir, "snapshots"), { recursive: true, mode: 0o755 });
    writeFileSync(join(stateDir, "snapshots", "old"), "secret");
    await Bun.$`chmod 755 ${stateDir}`;
    await cli.ensureReady();
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(join(stateDir, "snapshots", "old")).exists()).toBe(
      false,
    );
  });

  test("forbidden arguments never start a process", async () => {
    const { cli, log } = setup();
    for (const f of FORBIDDEN_AD_ARGS) {
      await expect(cli.run([f])).rejects.toBeInstanceOf(DesktopHelperError);
    }
    await expect(cli.run(["mcp"])).rejects.toThrow();
    await expect(cli.run(["snapshot", "--trace", "x"])).rejects.toThrow();
    await expect(cli.run(["snapshot", "--trace=x"])).rejects.toThrow();
    expect(log()).toEqual([]);
  });

  test("--headed goes before the command, --force after, text only through stdin", async () => {
    const { cli, log } = setup();
    const text = "熊宝员工\r\n😀";
    await cli.run(["type", "@s:e1", "--stdin"], { stdin: text, headed: true });
    await cli.run(["press", "alt+f4"], { force: true });
    const entries = log().filter((e) => e.args[0] !== "version");
    expect(entries[0]?.args).toEqual(["--headed", "type", "@s:e1", "--stdin"]);
    expect(Buffer.from(entries[0]?.stdin ?? "", "base64")).toEqual(
      Buffer.from(text, "utf8"),
    );
    expect(entries[1]?.args).toEqual(["press", "alt+f4", "--force"]);
  });

  test("an error envelope becomes AgentDesktopError with code, notDelivered and detail", async () => {
    const unverified: {
      version: string;
      ok: boolean;
      command: string;
      error: AdError;
    } = {
      version: "2.6",
      ok: false,
      command: "click",
      error: {
        code: "ACTION_FAILED",
        message: "The click may or may not have landed",
        details: { kind: "no_effect" },
        disposition: { delivery: "delivered_unverified", retry: "unsafe" },
      },
    };
    const { cli } = setup({
      commands: {
        press: { error: "POLICY_DENIED" },
        click: { envelope: unverified, exitCode: 1 },
        scroll: {
          envelope: {
            version: "2.6",
            ok: false,
            command: "scroll",
            error: {
              code: "INTERNAL",
              message: "x",
              platform_detail: "0x80004005",
            },
          },
          exitCode: 1,
        },
      },
    });
    const denied = await rejected(cli.run(["press", "alt+f4"]));
    expect(denied).toBeInstanceOf(AgentDesktopError);
    expect(denied.code).toBe("POLICY_DENIED");
    expect(denied.exitCode).toBe(1);
    expect(denied.notDelivered).toBe(true);
    expect(denied.message).toBe(ERRORS.POLICY_DENIED.error.message);

    const maybe = await rejected(cli.run(["click", "@s:e1"]));
    expect(maybe.notDelivered).toBe(false);
    expect(maybe.detail).toBe("no_effect");

    const platform = await rejected(cli.run(["scroll"]));
    expect(platform.detail).toBe("0x80004005");
  });

  test("ok envelopes return data; garbage output and exit 2 are failed", async () => {
    const { cli } = setup({
      commands: {
        "list-windows": { sample: "list-windows" },
        status: { raw: "not json" },
        click: { exitCode: 2, raw: "usage: ..." },
      },
    });
    const data = (await cli.run(["list-windows"])) as unknown;
    expect(data).toBeDefined();
    const garbage = await rejected(cli.run(["status"]));
    expect(garbage).toBeInstanceOf(DesktopHelperError);
    expect(garbage.code).toBe("failed");
    const usage = await rejected(cli.run(["click"]));
    expect(usage.code).toBe("failed");
    expect(usage.message).toContain("INVALID_ARGS");
    expect(usage.sent).toBe(false);
  });

  test("commands never overlap", async () => {
    const { cli, log } = setup({
      commands: { "list-windows": { delayMs: 200 } },
    });
    await Promise.all([cli.run(["list-windows"]), cli.run(["list-windows"])]);
    const starts = log()
      .filter((e) => e.args[0] === "list-windows")
      .map((e) => e.startedAt);
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(200);
  });

  test("timeout kills the child tree and rejects with timeout", async () => {
    const { cli, log } = setup({
      commands: { "list-windows": { delayMs: 30_000, spawnChild: true } },
    });
    const error = await rejected(
      cli.run(["list-windows"], { timeoutMs: 1500 }),
    );
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect(error.code).toBe("timeout");
    expect(error.sent).toBe(true);
    const entry = log().find((e) => e.args[0] === "list-windows");
    expect(entry?.childPid).toBeNumber();
    await Bun.sleep(200);
    expect(alive(entry?.pid ?? 0)).toBe(false);
    expect(alive(entry?.childPid ?? 0)).toBe(false);
  });

  test("an abort rejects with AbortError and ends the child", async () => {
    const { cli, log } = setup({
      commands: { "list-windows": { delayMs: 30_000 } },
    });
    const controller = new AbortController();
    const pending = rejected(
      cli.run(["list-windows"], { signal: controller.signal }),
    );
    await Bun.sleep(1200);
    controller.abort();
    const error = await pending;
    expect(error.name).toBe("AbortError");
    expect(error.sent).toBe(true);
    await Bun.sleep(200);
    const entry = log().find((e) => e.args[0] === "list-windows");
    expect(alive(entry?.pid ?? 0)).toBe(false);
  });

  test("idle wipes the state directory and calls onIdleWipe", async () => {
    let wiped = 0;
    const { cli, stateDir } = setup(
      {},
      {
        idleWipeMs: 300,
        onIdleWipe: () => {
          wiped++;
        },
      },
    );
    await cli.run(["list-windows"]);
    writeFileSync(join(stateDir, "latest_snapshot_id"), "s1");
    await mkdir(join(stateDir, "snapshots", "s1"), { recursive: true });
    writeFileSync(join(stateDir, "snapshots", "s1", "refmap.json"), "{}");
    await Bun.sleep(900);
    expect(wiped).toBe(1);
    expect((await stat(stateDir)).isDirectory()).toBe(true);
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan(stateDir))).toEqual(
      [],
    );
    // No command since: nothing more to wipe, and the timer does not repeat.
    await Bun.sleep(500);
    expect(wiped).toBe(1);
  });

  test("on win32 the state directory is secured after it is created; elsewhere it is not", async () => {
    const calls: string[] = [];
    const win = setup(
      {},
      {
        platform: "win32",
        secureDir: async (dir) => {
          calls.push(dir);
        },
      },
    );
    await win.cli.ensureReady();
    expect(calls).toEqual([win.stateDir]);
    expect((await stat(win.stateDir)).isDirectory()).toBe(true);

    const other = setup(
      {},
      {
        platform: "linux",
        secureDir: async (dir) => {
          calls.push(dir);
        },
      },
    );
    await other.cli.ensureReady();
    expect(calls).toHaveLength(1);

    const failing = setup(
      {},
      {
        platform: "win32",
        secureDir: async () => {
          throw new Error("拒绝访问");
        },
      },
    );
    const error = await rejected(failing.cli.ensureReady());
    expect(error.code).toBe("start_failed");
    expect(error.message).toContain("无法保护状态目录的访问权限：拒绝访问");
  });

  test("a first run whose version check is aborted or times out never sent the command", async () => {
    const slow = { commands: { version: { delayMs: 30_000 } } };
    const a = setup(slow);
    const controller = new AbortController();
    const aborted = rejected(
      a.cli.run(["list-windows"], { signal: controller.signal }),
    );
    await Bun.sleep(1000);
    controller.abort();
    const abortedError = await aborted;
    expect(abortedError.name).toBe("AbortError");
    expect(abortedError.sent).toBe(false);

    const b = setup(slow);
    const timedOut = await rejected(
      b.cli.run(["list-windows"], { timeoutMs: 800 }),
    );
    expect(timedOut.code).toBe("timeout");
    expect(timedOut.sent).toBe(false);
    expect(b.log().map((e) => e.args[0])).toEqual(["version"]);

    const c = setup({ commands: { version: { raw: "not json" } } });
    expect((await rejected(c.cli.run(["list-windows"]))).sent).toBe(false);
    const d = setup({ commands: { version: { exitCode: 2, raw: "usage" } } });
    expect((await rejected(d.cli.run(["list-windows"]))).sent).toBe(false);
  });

  test("a command that follows a timeout starts only after the killed child is gone", async () => {
    const { cli, log } = setup({
      commands: { click: { delayMs: 30_000, spawnChild: true } },
    });
    const first = rejected(cli.run(["click", "@s:e1"], { timeoutMs: 800 }));
    const second = cli.run(["list-windows"]);
    expect((await first).code).toBe("timeout");
    await second;
    const entries = log();
    const started = entries.find((e) => e.args[0] === "list-windows");
    expect(started?.prevAlive).toEqual([]);
  });

  test("a child that will not exit blocks the queue instead of overlapping it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ad-cli-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const logPath = join(root, "log.jsonl");
    writeFileSync(logPath, "");
    const never = new Promise<number>(() => {});
    let starts = 0;
    const cli = createAgentDesktopCli({
      binary: "agent-desktop",
      stateDir: join(root, "state"),
      exitWaitMs: 300,
      spawn: ((cmd: string[], options: Record<string, unknown>) => {
        starts++;
        const child = Bun.spawn(["bun", FAKE, ...cmd.slice(1)], {
          ...options,
          env: {
            ...(options.env as object),
            FAKE_AD_LOG: logPath,
            FAKE_AD_SCRIPT: JSON.stringify({
              commands: { click: { delayMs: 30_000 } },
            }),
          },
        } as never);
        // The second start (the click) reports an exit that never comes.
        return starts === 2
          ? new Proxy(child, {
              get: (t, k) =>
                k === "exited" ? never : (Reflect.get(t, k) as unknown),
            })
          : child;
      }) as unknown as typeof Bun.spawn,
    });
    cleanup.push(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const first = await rejected(cli.run(["click"], { timeoutMs: 500 }));
    expect(first.code).toBe("timeout");
    const second = await rejected(cli.run(["list-windows"]));
    expect(second.code).toBe("failed");
    expect(second.message).toContain("上一条桌面命令没能结束");
    expect(second.sent).toBe(false);
    expect(starts).toBe(2);
  });

  test("an abort while a request waits in the queue rejects it at once and starts nothing", async () => {
    const { cli, log } = setup({
      commands: { "list-windows": { delayMs: 1500 } },
    });
    const first = cli.run(["list-windows"]);
    const controller = new AbortController();
    const queued = rejected(
      cli.run(["click", "@s:e1"], { signal: controller.signal }),
    );
    await Bun.sleep(300);
    const t0 = Date.now();
    controller.abort();
    const error = await queued;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(error.name).toBe("AbortError");
    expect(error.sent).toBe(false);
    await first;
    await cli.run(["status"]);
    expect(log().some((e) => e.args[0] === "click")).toBe(false);
  });

  test("ensureReady empties the state directory first; close empties it after the child exits", async () => {
    const { cli, stateDir } = setup();
    await mkdir(join(stateDir, "snapshots", "old"), { recursive: true });
    writeFileSync(join(stateDir, "snapshots", "old", "refmap.json"), "{}");
    await cli.ensureReady();
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan(stateDir))).toEqual(
      [],
    );
    writeFileSync(join(stateDir, "latest_snapshot_id"), "s1");
    await cli.close();
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan(stateDir))).toEqual(
      [],
    );
  });

  test("an idle timer that fires mid-command wipes only after it ends, and not after close", async () => {
    let wiped = 0;
    const { cli, stateDir } = setup(
      { commands: { status: { delayMs: 800 } } },
      {
        idleWipeMs: 300,
        onIdleWipe: () => {
          wiped++;
        },
      },
    );
    await cli.run(["list-windows"]);
    const slow = cli.run(["status"]);
    await Bun.sleep(100);
    writeFileSync(join(stateDir, "marker"), "x");
    await Bun.sleep(500); // the 300 ms timer has fired by now, mid-command
    expect(wiped).toBe(0);
    expect(await Bun.file(join(stateDir, "marker")).exists()).toBe(true);
    await slow;
    await Bun.sleep(700);
    expect(wiped).toBe(1);
    expect(await Bun.file(join(stateDir, "marker")).exists()).toBe(false);

    await cli.run(["list-windows"]);
    await cli.close();
    await Bun.sleep(700);
    expect(wiped).toBe(1);
  });
});
