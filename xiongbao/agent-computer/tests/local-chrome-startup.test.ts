import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptLegacyLocalComputer,
  holdLocalComputerLock,
  localChromeConfiguration,
  requireAvailablePort,
  requireInstalledBrowser,
} from "../../scripts/start-local-chrome-computer";
import { browserExecutableCandidates } from "../src/installed-browser";

describe("starting the local computer", () => {
  test("requires the existing API token and never includes it in an error", () => {
    expect(() =>
      localChromeConfiguration({}, "darwin", "/Users/operator"),
    ).toThrow("COMPUTER_TOKEN");
  });

  test("isolates profiles and files from inherited paths", () => {
    const config = localChromeConfiguration(
      {
        COMPUTER_TOKEN: "test-token",
        XIONGBAO_LOCAL_COMPUTER_DIR: "/tmp/xiongbao-local-test",
        PROFILES_DIR:
          "/Users/operator/Library/Application Support/Google/Chrome",
        WORKSPACE_DIR: "/Users/operator",
      },
      "darwin",
      "/Users/operator",
    );
    expect(config.env.PROFILES_DIR).toBe("/tmp/xiongbao-local-test/profiles");
    expect(config.env.WORKSPACE_DIR).toBe("/tmp/xiongbao-local-test/workspace");
    expect(config.env.COMPUTER_BROWSER_BACKEND).toBe("local-chrome");
    expect(config.env.COMPUTER_BROWSER_MODE).toBe("headed");
    expect(config.env.COMPUTER_SANDBOX).toBe("on");
    expect(config.env.PORT).toBe("4101");
    expect(config.env.COMPUTER_TOKEN).toBe("test-token");
  });

  test("uses platform user data roots", () => {
    const env = { COMPUTER_TOKEN: "test-token" };
    expect(
      localChromeConfiguration(env, "darwin", "/Users/operator").root,
    ).toBe(
      "/Users/operator/Library/Application Support/XiongBao/local-computer",
    );
    expect(
      localChromeConfiguration(
        { ...env, XDG_DATA_HOME: "/data" },
        "linux",
        "/home/operator",
      ).root,
    ).toBe("/data/xiongbao/local-computer");
    expect(
      localChromeConfiguration(
        { ...env, LOCALAPPDATA: "C:\\Users\\Operator\\AppData\\Local" },
        "win32",
        "C:\\Users\\Operator",
      ).root,
    ).toBe("C:\\Users\\Operator\\AppData\\Local\\XiongBao\\local-computer");
  });

  /*
   * Where the default folder was before v0.2.16, which holds a person's browser profiles and files there.
   * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
   */
  test("names the default folder from before v0.2.16, and none for a folder the operator chose", () => {
    const env = { COMPUTER_TOKEN: "test-token" };
    expect(
      localChromeConfiguration(env, "darwin", "/Users/operator").legacyRoot,
    ).toBe(
      "/Users/operator/Library/Application Support/OpenBot/local-computer",
    );
    expect(
      localChromeConfiguration(
        { ...env, XDG_DATA_HOME: "/data" },
        "linux",
        "/home/operator",
      ).legacyRoot,
    ).toBe("/data/openbot/local-computer");
    expect(
      localChromeConfiguration(
        { ...env, LOCALAPPDATA: "C:\\Users\\Operator\\AppData\\Local" },
        "win32",
        "C:\\Users\\Operator",
      ).legacyRoot,
    ).toBe("C:\\Users\\Operator\\AppData\\Local\\OpenBot\\local-computer");
    expect(
      localChromeConfiguration(
        { ...env, XIONGBAO_LOCAL_COMPUTER_DIR: "/srv/computer" },
        "linux",
        "/home/operator",
      ).legacyRoot,
    ).toBeUndefined();
  });
  test("rejects a relative data directory, invalid port and an incompatible backend", () => {
    const env = { COMPUTER_TOKEN: "test-token" };
    expect(() =>
      localChromeConfiguration({
        ...env,
        XIONGBAO_LOCAL_COMPUTER_DIR: "profiles",
      }),
    ).toThrow("absolute");
    expect(() => localChromeConfiguration({ ...env, PORT: "0" })).toThrow(
      "PORT",
    );
    expect(() =>
      localChromeConfiguration({ ...env, COMPUTER_BROWSER_BACKEND: "managed" }),
    ).toThrow("COMPUTER_BROWSER_BACKEND");
    expect(() =>
      localChromeConfiguration({ ...env, COMPUTER_BROWSER_MODE: "headless" }),
    ).toThrow("headed");
  });

  test("missing token exits before starting the computer or creating data", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../scripts/start-local-chrome-computer.ts"),
      ],
      {
        env: { COMPUTER_TOKEN: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("COMPUTER_TOKEN is required");
  });

  // legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the data directory's setting before the rename
  test("a data directory named under the old setting is still the one it checks", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../scripts/start-local-chrome-computer.ts"),
      ],
      {
        env: {
          COMPUTER_TOKEN: "test-token",
          OPENBOT_LOCAL_COMPUTER_DIR: "relative",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(
      "XIONGBAO_LOCAL_COMPUTER_DIR must be an absolute path",
    );
  });

  test("missing Chrome and Edge fails clearly without launching a bundled browser", async () => {
    await expect(requireInstalledBrowser({}, "win32")).rejects.toThrow(
      "Neither Google Chrome nor Microsoft Edge was found",
    );
  });

  test("looks for Edge where Playwright's msedge channel launches it", () => {
    expect(browserExecutableCandidates("msedge", {}, "darwin")).toEqual([
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]);
    expect(browserExecutableCandidates("msedge", {}, "linux")).toEqual([
      "/opt/microsoft/msedge/msedge",
    ]);
    expect(
      browserExecutableCandidates(
        "msedge",
        { "PROGRAMFILES(X86)": "C:\\Program Files (x86)" },
        "win32",
      ),
    ).toEqual([
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });

  test("occupied loopback port fails instead of choosing another port", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      await expect(requireAvailablePort(address.port)).rejects.toThrow(
        `Cannot listen on 127.0.0.1:${address.port}`,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

/*
 * The default folder from before v0.2.16 is moved once, never overwrites anything and never loses what it holds.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
describe("the local computer's folder from before v0.2.16", () => {
  function home() {
    const data = mkdtempSync(join(tmpdir(), "xiongbao-local-computer-"));
    const config = localChromeConfiguration(
      { COMPUTER_TOKEN: "test-token", XDG_DATA_HOME: data },
      "linux",
      "/home/operator",
    );
    const legacy = config.legacyRoot as string;
    mkdirSync(join(legacy, "profiles", "bot-1"), { recursive: true });
    writeFileSync(join(legacy, "profiles", "bot-1", "Cookies"), "signed-in");
    return { data, config, legacy };
  }
  const quiet = <T>(work: () => Promise<T>) => {
    const { info, warn } = console;
    console.info = () => {};
    console.warn = () => {};
    return work().finally(() => {
      console.info = info;
      console.warn = warn;
    });
  };

  test("is moved to the new place with what it holds, once", async () => {
    const { data, config, legacy } = home();
    try {
      const adopted = await quiet(() =>
        adoptLegacyLocalComputer(config, "linux"),
      );
      expect(adopted.root).toBe(join(data, "xiongbao", "local-computer"));
      expect(adopted.env.PROFILES_DIR).toBe(join(adopted.root, "profiles"));
      expect(
        readFileSync(
          join(adopted.root, "profiles", "bot-1", "Cookies"),
          "utf8",
        ),
      ).toBe("signed-in");
      expect(existsSync(legacy)).toBe(false);
      // A second start finds nothing to move and changes nothing.
      const again = await quiet(() =>
        adoptLegacyLocalComputer(config, "linux"),
      );
      expect(again).toEqual(adopted);
      expect(
        readFileSync(join(again.root, "profiles", "bot-1", "Cookies"), "utf8"),
      ).toBe("signed-in");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("never replaces a folder already at the new place", async () => {
    const { data, config, legacy } = home();
    try {
      mkdirSync(join(config.root, "profiles"), { recursive: true });
      writeFileSync(join(config.root, "profiles", "kept"), "new");
      const adopted = await quiet(() =>
        adoptLegacyLocalComputer(config, "linux"),
      );
      expect(adopted.root).toBe(config.root);
      expect(readFileSync(join(config.root, "profiles", "kept"), "utf8")).toBe(
        "new",
      );
      expect(
        readFileSync(join(legacy, "profiles", "bot-1", "Cookies"), "utf8"),
      ).toBe("signed-in");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("a move that fails leaves it in place and this run uses it there", async () => {
    const { data, config, legacy } = home();
    try {
      const adopted = await quiet(() =>
        adoptLegacyLocalComputer(config, "linux", async () => {
          throw new Error("EBUSY: resource busy or locked");
        }),
      );
      expect(adopted.root).toBe(legacy);
      expect(adopted.env.PROFILES_DIR).toBe(join(legacy, "profiles"));
      expect(adopted.env.WORKSPACE_DIR).toBe(join(legacy, "workspace"));
      expect(
        readFileSync(join(legacy, "profiles", "bot-1", "Cookies"), "utf8"),
      ).toBe("signed-in");
      expect(existsSync(config.root)).toBe(false);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("a move that another start finished meanwhile uses the new place and never recreates the old one", async () => {
    const { data, config, legacy } = home();
    try {
      const adopted = await quiet(() =>
        adoptLegacyLocalComputer(config, "linux", async (from, to) => {
          renameSync(from, to);
          throw new Error("ENOENT: no such file or directory");
        }),
      );
      expect(adopted.root).toBe(config.root);
      expect(adopted.env.PROFILES_DIR).toBe(join(config.root, "profiles"));
      expect(existsSync(legacy)).toBe(false);
      expect(
        readFileSync(join(config.root, "profiles", "bot-1", "Cookies"), "utf8"),
      ).toBe("signed-in");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("a second helper refuses to start while the first holds the folder, before anything is moved", async () => {
    const { data, config, legacy } = home();
    try {
      const lock = `${config.root}.lock`;
      const release = await holdLocalComputerLock(
        lock,
        "linux",
        () => true,
        111,
      );
      await expect(
        holdLocalComputerLock(lock, "linux", (pid) => pid === 111, 222),
      ).rejects.toThrow("process 111");
      // The refused start moved nothing.
      expect(
        readFileSync(join(legacy, "profiles", "bot-1", "Cookies"), "utf8"),
      ).toBe("signed-in");
      expect(existsSync(config.root)).toBe(false);
      await release();
      expect(existsSync(lock)).toBe(false);
      // Released, the next one takes it.
      const next = await holdLocalComputerLock(lock, "linux", () => true, 222);
      expect(readFileSync(lock, "utf8").trim()).toBe("222");
      await next();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("a lock left by a helper that is gone is taken over", async () => {
    const { data, config } = home();
    try {
      const lock = `${config.root}.lock`;
      mkdirSync(join(data, "xiongbao"), { recursive: true });
      writeFileSync(lock, "999999\n");
      const release = await holdLocalComputerLock(
        lock,
        "linux",
        () => false,
        333,
      );
      expect(readFileSync(lock, "utf8").trim()).toBe("333");
      await release();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("a folder the operator named is left alone", async () => {
    const data = mkdtempSync(join(tmpdir(), "xiongbao-local-computer-"));
    try {
      const config = localChromeConfiguration(
        {
          COMPUTER_TOKEN: "test-token",
          XIONGBAO_LOCAL_COMPUTER_DIR: join(data, "mine"),
        },
        "linux",
        "/home/operator",
      );
      expect(await adoptLegacyLocalComputer(config, "linux")).toBe(config);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
