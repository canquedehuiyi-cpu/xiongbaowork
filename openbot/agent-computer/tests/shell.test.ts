import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandShell,
  createShell,
  environmentForCommand,
  plainPowerShellStderr,
  resetWindowsCodePageCache,
  windowsCodePage,
  windowsOutputDecoder,
} from "../src/shell";

/**
 * What a command on the computer is allowed to see.
 *
 * The case that matters is a secret that already sits on the process: KEY_ENCRYPTION_KEY in the
 * one-container image, COMPUTER_TOKEN under Compose. Spreading `process.env` into the child makes
 * `env` print them. These tests build the map a spawn would receive, then run a real command against
 * it, so a refactor that only updates the helper cannot go green while the child still inherits.
 */

const workspaceHome = "/workspace/sales";

const secrets = {
  KEY_ENCRYPTION_KEY: "deployment-key",
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1/openbot",
  OPENAI_API_KEY: "sk-secret",
  COMPUTER_TOKEN: "computer-token",
  INTELLIGENCE_API_KEY: "cpk-secret",
} as const;

const allowed = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  HTTP_PROXY: "http://proxy.internal:8080",
  http_proxy: "http://proxy.internal:8080",
  HTTPS_PROXY: "http://proxy.internal:8080",
} as const;

function source(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { ...secrets, ...allowed, HOME: "/root", ...extra };
}

describe("what a command inherits", () => {
  test("Windows retains native command lookup without inheriting deployment secrets", () => {
    const env = environmentForCommand(
      {
        Path: "C:\\Tools",
        SystemRoot: "C:\\Windows",
        PATHEXT: ".EXE;.CMD",
        ...secrets,
      },
      "C:\\work",
      "win32",
    );
    expect(env.PATH).toBe("C:\\Tools");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.USERPROFILE).toBe("C:\\work");
    expect(env.KEY_ENCRYPTION_KEY).toBeUndefined();
  });
  test("Windows keeps the machine's name and program folders, not the user's profile folders", () => {
    const env = environmentForCommand(
      {
        Path: "C:\\Tools",
        SystemRoot: "C:\\Windows",
        COMPUTERNAME: "STUDIO-PC",
        USERNAME: "feng",
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        APPDATA: "C:\\Users\\feng\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\feng\\AppData\\Local",
        ...secrets,
      },
      "C:\\work",
      "win32",
    );
    expect(env.COMPUTERNAME).toBe("STUDIO-PC");
    expect(env.USERNAME).toBe("feng");
    expect(env.ProgramFiles).toBe("C:\\Program Files");
    expect(env["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    expect(env.APPDATA).toBeUndefined();
    expect(env.LOCALAPPDATA).toBeUndefined();
    expect(env.KEY_ENCRYPTION_KEY).toBeUndefined();
  });
  test("Windows selects a native shell without profiles and preserves literal command text", () => {
    const shell = commandShell("Write-Output '熊宝'; exit 7", "win32", {
      SystemRoot: "C:\\Windows",
    });
    expect(shell.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(shell.args).toContain("-NoProfile");
    expect(
      Buffer.from(shell.args.at(-1) ?? "", "base64").toString("utf16le"),
    ).toContain("Write-Output '熊宝'; exit 7");
    // Progress records would otherwise reach stderr as CLIXML and read as an error.
    expect(
      Buffer.from(shell.args.at(-1) ?? "", "base64").toString("utf16le"),
    ).toStartWith("$ProgressPreference = 'SilentlyContinue';");
    expect(commandShell("echo hi", "linux", {}).executable).toBe("/bin/bash");
  });
  test("Windows leaves the console code page to native programs and writes its own output as UTF-8", () => {
    const script = Buffer.from(
      commandShell("hostname", "win32", { SystemRoot: "C:\\Windows" }).args.at(
        -1,
      ) ?? "",
      "base64",
    ).toString("utf16le");
    // Setting it to UTF-8 made PowerShell decode hostname.exe's GBK as UTF-8: U+FFFD, seen on a device.
    expect(script).not.toContain("[Console]::OutputEncoding =");
    expect(script).toContain("[Console]::SetOut($openbotOut)");
    expect(script).toContain("[Console]::SetError($openbotErr)");
    expect(script.indexOf("SetError")).toBeLessThan(script.indexOf("hostname"));
  });
  test("PATH, locale, terminal and proxy variables pass", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env.PATH).toBe(allowed.PATH);
    expect(env.LANG).toBe(allowed.LANG);
    expect(env.LC_ALL).toBe(allowed.LC_ALL);
    expect(env.TERM).toBe(allowed.TERM);
    expect(env.HTTP_PROXY).toBe(allowed.HTTP_PROXY);
    expect(env.http_proxy).toBe(allowed.http_proxy);
    expect(env.HTTPS_PROXY).toBe(allowed.HTTPS_PROXY);
  });

  test("a secret sitting in the process environment does not", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env).not.toHaveProperty("KEY_ENCRYPTION_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("COMPUTER_TOKEN");
    expect(env).not.toHaveProperty("INTELLIGENCE_API_KEY");
    expect(JSON.stringify(env)).not.toContain("deployment-key");
    expect(JSON.stringify(env)).not.toContain("sk-secret");
  });

  test("HOME is the workspace, not the process's home", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env.HOME).toBe(workspaceHome);
  });

  test("COMPUTER_SHELL_ENV names extras, read as names", () => {
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "JAVA_HOME, GOPATH",
        JAVA_HOME: "/opt/java",
        GOPATH: "/opt/go",
      }),
      workspaceHome,
    );
    expect(env.JAVA_HOME).toBe("/opt/java");
    expect(env.GOPATH).toBe("/opt/go");
    expect(env).not.toHaveProperty("COMPUTER_SHELL_ENV");
  });

  test("naming a secret in COMPUTER_SHELL_ENV is an operator's decision", () => {
    const env = environmentForCommand(
      source({ COMPUTER_SHELL_ENV: "KEY_ENCRYPTION_KEY" }),
      workspaceHome,
    );
    expect(env.KEY_ENCRYPTION_KEY).toBe(secrets.KEY_ENCRYPTION_KEY);
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("a name that is not a name is not read as one", () => {
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "JAVA_HOME,KEY_ENCRYPTION_KEY;rm,FOO=bar",
        JAVA_HOME: "/opt/java",
      }),
      workspaceHome,
    );
    expect(env.JAVA_HOME).toBe("/opt/java");
    expect(env).not.toHaveProperty("KEY_ENCRYPTION_KEY");
    expect(env).not.toHaveProperty("FOO");
  });

  test("HOME cannot be redirected through COMPUTER_SHELL_ENV", () => {
    const env = environmentForCommand(
      source({ COMPUTER_SHELL_ENV: "HOME", HOME: "/root" }),
      workspaceHome,
    );
    expect(env.HOME).toBe(workspaceHome);
  });

  test("a proxy URL's userinfo does not pass", () => {
    const env = environmentForCommand(
      source({
        HTTP_PROXY: "http://bot:s3cret@proxy.internal:8080",
        HTTPS_PROXY: "https://bot:p%40ss@proxy.internal:8443",
      }),
      workspaceHome,
    );
    expect(env.HTTP_PROXY).toBe("http://proxy.internal:8080");
    expect(env.HTTPS_PROXY).toBe("https://proxy.internal:8443");
    expect(JSON.stringify(env)).not.toContain("s3cret");
    expect(JSON.stringify(env)).not.toContain("p%40ss");
    expect(JSON.stringify(env)).not.toContain("p@ss");
  });

  test("a proxy password with a bare % is still stripped, and does not stop the command", () => {
    // Decoding `p%zz` threw a URIError past the redaction, so building the environment failed
    // and every command with it. It must not fail, and it must not fall back to passing the password.
    const env = environmentForCommand(
      source({
        HTTP_PROXY: "http://bot:p%zz@proxy.internal:8080",
        HTTPS_PROXY: "bot:p%zz@proxy.internal:8443",
      }),
      workspaceHome,
    );
    expect(env.HTTP_PROXY).toBe("http://proxy.internal:8080");
    expect(env.HTTPS_PROXY).toBe("proxy.internal:8443");
    expect(JSON.stringify(env)).not.toContain("p%zz");
  });

  test("a proxy URL's userinfo does not pass when it was written without a scheme", () => {
    // `HTTPS_PROXY=bot:s3cret@proxy.internal:8443` is a shape curl and wget accept. `new URL` reads
    // it as the scheme `bot:` and a path, so the redaction above found no userinfo to strip and the
    // password reached the Bot's shell, where `env` prints it.
    const env = environmentForCommand(
      source({
        HTTP_PROXY: "bot:s3cret@proxy.internal:8080",
        HTTPS_PROXY: "bot:p%40ss@proxy.internal:8443",
      }),
      workspaceHome,
    );
    expect(env.HTTP_PROXY).toBe("proxy.internal:8080");
    expect(env.HTTPS_PROXY).toBe("proxy.internal:8443");
    expect(JSON.stringify(env)).not.toContain("s3cret");
    expect(JSON.stringify(env)).not.toContain("p%40ss");
    expect(JSON.stringify(env)).not.toContain("p@ss");
  });

  test("a proxy without userinfo is left alone", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env.HTTP_PROXY).toBe(allowed.HTTP_PROXY);
  });

  test("naming a credentialed proxy in COMPUTER_SHELL_ENV is an operator's decision", () => {
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "HTTP_PROXY",
        HTTP_PROXY: "http://bot:s3cret@proxy.internal:8080",
      }),
      workspaceHome,
    );
    expect(env.HTTP_PROXY).toBe("http://bot:s3cret@proxy.internal:8080");
  });
});

describe("the command that actually runs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-shell-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("env in the child does not list a secret from the parent", async () => {
    const result = await createShell(root, source()).run({
      command: "printenv",
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain(`HOME=${root}`);
    expect(result.stdout).toContain(`HTTP_PROXY=${allowed.HTTP_PROXY}`);
    expect(result.stdout).not.toContain("KEY_ENCRYPTION_KEY");
    expect(result.stdout).not.toContain("deployment-key");
    expect(result.stdout).not.toContain("sk-secret");
    expect(result.stdout).not.toContain("computer-token");
  });

  test("a name in COMPUTER_SHELL_ENV is in the child", async () => {
    const result = await createShell(
      root,
      source({ COMPUTER_SHELL_ENV: "JAVA_HOME", JAVA_HOME: "/opt/java" }),
    ).run({ command: "printenv JAVA_HOME" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/opt/java");
  });
  test("a package install is not left waiting for a prompt", async () => {
    // apt-get reads DEBIAN_FRONTEND. Interactive, it stops for an answer nobody is there to give,
    // and the command reaches its timeout looking like a broken package rather than a question.
    const result = await createShell(root, source()).run({
      command: "printenv DEBIAN_FRONTEND",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("noninteractive");
  });

  test("env in the child does not list a proxy password", async () => {
    const result = await createShell(
      root,
      source({ HTTP_PROXY: "http://bot:s3cret@proxy.internal:8080" }),
    ).run({ command: "printenv HTTP_PROXY" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("http://proxy.internal:8080");
    expect(result.stdout).not.toContain("s3cret");
  });

  test("an operator can still choose the frontend themselves", async () => {
    const result = await createShell(
      root,
      source({
        COMPUTER_SHELL_ENV: "DEBIAN_FRONTEND",
        DEBIAN_FRONTEND: "teletype",
      }),
    ).run({ command: "printenv DEBIAN_FRONTEND" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("teletype");
  });
  test("a file the Bot left behind does not run before its command", async () => {
    // computer_write_file lets a Bot write anywhere in its workspace, and HOME is the workspace. A
    // login shell would source this first, so a later command would run Bot-authored code while the
    // audit row recorded only the command that was asked for.
    await Bun.write(
      join(root, ".bash_profile"),
      'echo "profile ran"\nexport MARKER=hijacked\n',
    );

    const result = await createShell(root, source()).run({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
      command: 'echo "[${MARKER:-clean}]"',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("profile ran");
    expect(result.stdout.trim()).toBe("[clean]");
  });
  test("BASH_ENV is not in the map a command receives", () => {
    /*
     * The one startup file a non-interactive shell still reads. `bash -c` sources no login files, but
     * it does expand BASH_ENV and run what it names, on bash 3.2 and 5.2 alike. Nothing else closes
     * that path: it is closed only by BASH_ENV not being in the map, so it is asserted here rather
     * than assumed. Same for the option variables bash reads from its environment.
     */
    const env = environmentForCommand(
      source({
        BASH_ENV: "/workspace/profile.sh",
        SHELLOPTS: "xtrace",
        BASHOPTS: "expand_aliases",
        CDPATH: "/workspace",
        GLOBIGNORE: "*",
      }),
      workspaceHome,
    );

    expect(env.BASH_ENV).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.BASHOPTS).toBeUndefined();
    expect(env.CDPATH).toBeUndefined();
    expect(env.GLOBIGNORE).toBeUndefined();
  });

  test("COMPUTER_SHELL_ENV cannot hand back an execution hook", () => {
    /*
     * The rest of that setting is an operator's decision to make. This is not: BASH_ENV names a file
     * bash runs before the command, so passing it would reopen the hole `-c` closed, with the
     * reasoning for `-c` sitting a few lines above looking satisfied. Refused rather than omitted, so
     * the boundary does not depend on nobody adding a `BASH_*` convenience later.
     */
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "BASH_ENV,LD_PRELOAD,ENV,SHELLOPTS,JAVA_HOME",
        BASH_ENV: "/workspace/hook.sh",
        LD_PRELOAD: "/workspace/hook.so",
        ENV: "/workspace/hook.sh",
        SHELLOPTS: "xtrace",
        JAVA_HOME: "/opt/java",
      }),
      workspaceHome,
    );

    expect(env.BASH_ENV).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.ENV).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    // A name that only carries information still passes, so the refusal is targeted rather than a
    // second allow list nobody can extend.
    expect(env.JAVA_HOME).toBe("/opt/java");
  });
});

describe("what a command cannot do to the computer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-shell-limits-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a command that backgrounds a process is still stopped", async () => {
    /*
     * `child.kill` signals bash alone. The sleep and the cat below hold the pipes bash inherited, so
     * `close` never fires and the awaited promise never settles: the command outlives its own limit
     * and the caller waits for something else to give up. Killing the process group ends all of it.
     */
    const started = Date.now();
    const result = await createShell(root, source()).run({
      command: "sleep 30 | cat",
      timeoutMs: 1_500,
    });

    expect(result.timedOut).toBe(true);
    // Settles on its own limit rather than hanging until something upstream times out.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test("a noisy command does not grow without limit", async () => {
    // The clamp ran only after close, so this allocated until the process that owns the browser died.
    const result = await createShell(root, source()).run({
      command: "head -c 3000000 /dev/zero | tr '\\0' 'a'",
      timeoutMs: 20_000,
    });

    expect(result.truncated).toBe(true);
    // Held to the kept size and a margin, not to the three megabytes the command produced.
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(200 * 1024);
  }, 30_000);

  test("a timeout of zero is not a command killed before it runs", async () => {
    // Only Math.min was applied, so this fired setTimeout immediately and reported a timeout for a
    // command that never had a chance to start.
    const result = await createShell(root, source()).run({
      command: 'echo "ran"',
      timeoutMs: 0,
    });

    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("ran");
  }, 15_000);

  test("a Stop that landed before the command started still stops it", async () => {
    /*
     * An abort listener added to an already-aborted signal never fires, so the Stop was only honoured
     * when it arrived after the child spawned. This is the ordinary race: the surface aborts, the
     * server aborts the request it made to this computer, and Bun aborts this one in turn, which can
     * happen before `run` reaches the spawn. The command then ran to its own limit instead of being
     * stopped, and the person was told nothing until it finished.
     */
    const started = Date.now();
    const result = await createShell(root, source()).run({
      command: "sleep 30",
      timeoutMs: 20_000,
      signal: AbortSignal.abort(),
    });

    // Ends on the Stop rather than running out the command or its own limit.
    expect(Date.now() - started).toBeLessThan(10_000);
    // A Stop is not a timeout, and must not be reported as one.
    expect(result.timedOut).toBe(false);
  }, 20_000);

  test("a Stop that lands mid-command still stops it", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const started = Date.now();

    try {
      const result = await createShell(root, source()).run({
        command: "sleep 30",
        timeoutMs: 20_000,
        signal: controller.signal,
      });

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.timedOut).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  }, 20_000);

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "a timeout of %s falls back to the default instead of killing the command at once",
    async (_name, timeoutMs) => {
      // Math.max(NaN, 1000) is NaN, and setTimeout(NaN) fires immediately: the command was reported
      // as timed out before it did anything. The HTTP layer rejects these with a 400; the shell
      // itself falls back to the default so a direct caller gets a run, not a lie.
      const result = await createShell(root, source()).run({
        command: 'echo "ran"',
        timeoutMs,
      });

      expect(result.timedOut).toBe(false);
      expect(result.stdout.trim()).toBe("ran");
    },
    15_000,
  );
});

describe("Windows PowerShell's stderr as text", () => {
  // Exactly as a paired Windows 11 device returned it, beside a successful `Get-Date`.
  const firstUse =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>正在准备首次使用模块。</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>';

  test("a progress record alone is not an error, so nothing is left", () => {
    expect(plainPowerShellStderr(firstUse)).toBe("");
  });

  test("error lines keep their words, with escapes and entities decoded", () => {
    const stderr =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>x</AV></PR></MS></Obj><S S="Error">找不到路径“C:\\熊宝”，因为该路径不存在。_x000D__x000A_</S><S S="Error">a &lt;b&gt; &amp; &quot;c&quot;_x000D__x000A_</S></Objs>';
    expect(plainPowerShellStderr(stderr)).toBe(
      '找不到路径“C:\\熊宝”，因为该路径不存在。\r\na <b> & "c"\r\n',
    );
  });

  test("text before the header stays, and plain stderr is untouched", () => {
    expect(plainPowerShellStderr(`native warning\n${firstUse}`)).toBe(
      "native warning\n",
    );
    expect(plainPowerShellStderr("plain error\n")).toBe("plain error\n");
  });

  test("anything it does not recognise comes back exactly as it was", () => {
    const cut = firstUse.slice(0, 120);
    expect(plainPowerShellStderr(cut)).toBe(cut);
    const unknown = '#< CLIXML\r\n<Objs><Obj S="information"><X/></Obj></Objs>';
    expect(plainPowerShellStderr(unknown)).toBe(unknown);
  });
});

describe("Windows command output, a line at a time", () => {
  const gbk熊宝 = [0xd0, 0xdc, 0xb1, 0xa6];
  const utf8 = (text: string) => new TextEncoder().encode(text);

  test("PowerShell's UTF-8 lines and a native program's GBK lines both arrive as text", () => {
    const decoder = windowsOutputDecoder(936);
    const bytes = new Uint8Array([
      ...utf8("ABC中文\r\n"),
      ...gbk熊宝,
      0x0d,
      0x0a,
      ...utf8("尾"),
    ]);
    expect(decoder.write(bytes) + decoder.end()).toBe("ABC中文\r\n熊宝\r\n尾");
  });

  test("a multi-byte character split across chunks is not misread", () => {
    const decoder = windowsOutputDecoder(936);
    const bytes = utf8("熊宝员工\n");
    let text = "";
    for (const byte of bytes) text += decoder.write(new Uint8Array([byte]));
    expect(text + decoder.end()).toBe("熊宝员工\n");
    const native = windowsOutputDecoder(936);
    expect(
      native.write(new Uint8Array(gbk熊宝.slice(0, 1))) +
        native.write(new Uint8Array([...gbk熊宝.slice(1), 0x0a])),
    ).toBe("熊宝\n");
  });

  test("the Western OEM code pages decode without a TextDecoder label", () => {
    const decoder = windowsOutputDecoder(437);
    expect(decoder.write(new Uint8Array([0x81, 0x0a]))).toBe("ü\n");
    expect(windowsOutputDecoder(850).write(new Uint8Array([0x9b, 0x0a]))).toBe(
      "ø\n",
    );
  });

  test("an unknown code page still yields text, never throws", () => {
    const decoder = windowsOutputDecoder(undefined);
    expect(decoder.write(new Uint8Array([0xd0, 0x0a]))).toBe("\uFFFD\n");
    expect(windowsOutputDecoder(65001).end()).toBe("");
  });
});

/**
 * The machine code page is what lets a native program's OEM-code-page bytes decode as text. A
 * failed or timed-out first query (a cold runner starting PowerShell slowly) must not be cached
 * as "unknown" for the life of the process, or every later command mis-decodes.
 */
describe("windowsCodePage cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codepage-"));
    resetWindowsCodePageCache();
  });
  afterEach(async () => {
    resetWindowsCodePageCache();
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake "powershell": logs each call, prints `out`, exits with `code`. */
  async function fake(
    name: string,
    out: string,
    code: number,
  ): Promise<string> {
    const path = join(dir, name);
    await writeFile(
      path,
      `#!/bin/sh\necho call >> "${join(dir, `${name}.log`)}"\necho ${out}\nexit ${code}\n`,
    );
    await chmod(path, 0o755);
    return path;
  }
  const calls = async (name: string): Promise<number> =>
    (await readFile(join(dir, `${name}.log`), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean).length;

  test("a failed query is not cached; the next call asks again", async () => {
    const bad = await fake("bad", "oops", 1);
    const good = await fake("good", "437", 0);
    expect(await windowsCodePage(bad)).toBeUndefined();
    expect(await windowsCodePage(good)).toBe(437);
    expect(await calls("bad")).toBe(1);
    expect(await calls("good")).toBe(1);
  });

  test("a successful query is cached", async () => {
    const good = await fake("good", "437", 0);
    expect(await windowsCodePage(good)).toBe(437);
    expect(await windowsCodePage(good)).toBe(437);
    expect(await calls("good")).toBe(1);
  });

  test("concurrent callers share one in-flight query", async () => {
    const good = await fake("good", "437", 0);
    const [a, b] = await Promise.all([
      windowsCodePage(good),
      windowsCodePage(good),
    ]);
    expect([a, b]).toEqual([437, 437]);
    expect(await calls("good")).toBe(1);
  });
});

/**
 * An employee's command, run as its own Linux user through the root helper.
 *
 * The helper is replaced by a script that does what `xb-bot run` is contracted to do with its input:
 * it prints its arguments, reads `NAME=VALUE` lines up to the first empty line, then runs the rest of
 * stdin as the command. What it prints is what the real helper would have been given.
 */
describe("a command run as the employee's own user", () => {
  const KEY = "0123456789ab";
  let root: string;
  let launcher: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-shell-run-as-"));
    launcher = join(root, "fake-xb.sh");
    await writeFile(
      launcher,
      [
        "#!/bin/sh",
        'echo "$@"',
        'while IFS= read -r line; do [ -z "$line" ] && break; printf "ENV:%s\\n" "$line"; done',
        'exec sh -c "$(cat)"',
        "",
      ].join("\n"),
    );
    await chmod(launcher, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const shellFor = (env: NodeJS.ProcessEnv = source()) =>
    createShell(root, env, { runAs: { key: KEY, launcher: [launcher] } });

  test("the helper is asked to run as the employee, for the default limit in seconds", async () => {
    const result = await shellFor().run({ command: "echo hi" });
    expect(result.stdout).toContain(`run ${KEY} 120`);
    expect(result.stdout).toContain("hi");
    expect(result.exitCode).toBe(0);
  });

  test("the command's environment arrives on stdin, without the user's own identity", async () => {
    const result = await shellFor(
      source({
        COMPUTER_SHELL_ENV: "USER,LOGNAME,SHELL,TMPDIR,MULTI,KEPT",
        USER: "pwuser",
        LOGNAME: "pwuser",
        SHELL: "/bin/bash",
        TMPDIR: "/tmp",
        MULTI: "one\ntwo",
        KEPT: "yes",
      }),
    ).run({ command: "true" });
    expect(result.stdout).toContain("ENV:PATH=/usr/bin:/bin");
    expect(result.stdout).toContain("ENV:KEPT=yes");
    for (const name of ["HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "MULTI"])
      expect(result.stdout).not.toContain(`ENV:${name}=`);
    // Still the allow-list: a secret on the process does not reach the helper either.
    expect(result.stdout).not.toContain("deployment-key");
  });

  test("a command with newlines and quotes runs exactly as written", async () => {
    const result = await shellFor().run({
      command: `printf '%s\\n' "a b"\necho "it's"`,
    });
    expect(result.stdout).toContain("a b\nit's\n");
    expect(result.exitCode).toBe(0);
  });

  test("it starts in the employee's directory", async () => {
    const result = await shellFor().run({ command: "pwd" });
    expect(result.stdout).toContain(`${root}\n`);
  });

  test("a command past its limit is stopped and says so", async () => {
    const started = Date.now();
    const result = await shellFor().run({
      command: "sleep 30",
      timeoutMs: 1_000,
    });
    expect(result.stdout).toContain(`run ${KEY} 1`);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);

  test("a Stop reaches the command", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    try {
      const result = await shellFor().run({
        command: "sleep 30",
        timeoutMs: 20_000,
        signal: controller.signal,
      });
      expect(result.stopped).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      clearTimeout(timer);
    }
  }, 20_000);
});
