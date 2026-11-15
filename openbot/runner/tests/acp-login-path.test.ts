import { expect, test } from "bun:test";
import type { ProbeResult } from "../src/acp/discover";
import { runProbe } from "../src/acp/discover";
import {
  type LoginPathDeps,
  mergePaths,
  pathFromOutput,
  readLoginShellPath,
  withLoginPath,
} from "../src/acp/login-path";

/*
 * The owner's login-shell PATH, for finding and starting ACP agents when the app was opened from
 * Finder (macOS) with launchd's short PATH. Only the marked PATH line is believed; any failure
 * falls back to the inherited PATH.
 */

const START = "__XIONGBAO_PATH_START__";
const END = "__XIONGBAO_PATH_END__";

function shell(
  answer: Partial<ProbeResult>,
  over: Partial<LoginPathDeps> = {},
): LoginPathDeps & { calls: Array<[string, string[], number]> } {
  const calls: Array<[string, string[], number]> = [];
  return {
    calls,
    platform: "darwin",
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    run: async (command, args, timeoutMs) => {
      calls.push([command, args, timeoutMs]);
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...answer };
    },
    ...over,
  };
}

test("mergePaths puts the login entries first and drops duplicates and empty entries", () => {
  expect(
    mergePaths(
      "/opt/homebrew/bin:/usr/bin::/Users/o/.local/bin:/usr/bin",
      "/usr/bin:/bin:/opt/homebrew/bin:/sbin:",
    ),
  ).toBe("/opt/homebrew/bin:/usr/bin:/Users/o/.local/bin:/bin:/sbin");
  expect(mergePaths(undefined, "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(mergePaths("/a", undefined)).toBe("/a");
});

test("the login shell is asked once, bounded, and only the marked line is believed", async () => {
  const deps = shell({
    code: 0,
    // A chatty profile: a banner before, a fortune after.
    stdout: `Welcome back!\n${START}\n/opt/homebrew/bin:/usr/bin:/bin\n${END}\nHave a nice day /evil\n`,
  });
  expect(await readLoginShellPath(deps)).toBe(
    "/opt/homebrew/bin:/usr/bin:/bin",
  );
  expect(deps.calls).toHaveLength(1);
  const [command, args, timeoutMs] = deps.calls[0] ?? ["", [], 0];
  expect(command).toBe("/bin/zsh");
  expect(args[0]).toBe("-ilc");
  expect(args[1]).toContain("/usr/bin/printenv PATH");
  expect(timeoutMs).toBe(3000);

  const merged = await withLoginPath(deps);
  expect(merged.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(merged.SHELL).toBe("/bin/zsh");
});

test("odd output, a failure or a timeout falls back to the inherited PATH", async () => {
  const inherited = "/usr/bin:/bin:/usr/sbin:/sbin";
  for (const answer of [
    { code: null, timedOut: true },
    { code: 1, stdout: `${START}\n/opt/homebrew/bin\n${END}\n` },
    { code: 0, stdout: "/opt/homebrew/bin:/usr/bin\n" },
    { code: 0, stdout: `${START}\nrelative/bin:/usr/bin\n${END}\n` },
    { code: 0, stdout: `${START}\n/a\n/b\n${END}\n` },
    { code: 0, stdout: `${START}\n\n${END}\n` },
  ] satisfies Partial<ProbeResult>[]) {
    const deps = shell(answer);
    expect(await readLoginShellPath(deps)).toBe(undefined);
    expect((await withLoginPath(deps)).PATH).toBe(inherited);
  }
  const throwing = shell(
    {},
    { run: async () => Promise.reject(new Error("x")) },
  );
  expect((await withLoginPath(throwing)).PATH).toBe(inherited);
});

test("Windows is left alone; without $SHELL macOS asks zsh and Linux asks nobody", async () => {
  const marked = { code: 0, stdout: `${START}\n/usr/local/bin\n${END}\n` };
  const windows = shell(marked, {
    platform: "win32",
    env: { PATH: "C:\\Windows" },
  });
  expect(await withLoginPath(windows)).toEqual({ PATH: "C:\\Windows" });
  expect(windows.calls).toHaveLength(0);

  const mac = shell(marked, { env: { PATH: "/usr/bin" } });
  expect(await readLoginShellPath(mac)).toBe("/usr/local/bin");
  expect(mac.calls[0]?.[0]).toBe("/bin/zsh");

  const linux = shell(marked, { platform: "linux", env: { PATH: "/usr/bin" } });
  expect(await readLoginShellPath(linux)).toBe(undefined);
  expect(linux.calls).toHaveLength(0);

  // A relative $SHELL is not trusted either.
  const relative = shell(marked, {
    platform: "linux",
    env: { SHELL: "zsh", PATH: "/usr/bin" },
  });
  expect(await readLoginShellPath(relative)).toBe(undefined);
});

test("a login shell that hangs is stopped in time and the inherited PATH is used", async () => {
  const started = Date.now();
  const env = { SHELL: "/bin/sh", PATH: "/usr/bin:/bin" };
  const result = await withLoginPath({
    platform: "linux",
    env,
    timeoutMs: 300,
    // Stands in for a profile that waits forever.
    run: (_command, _args, timeoutMs) =>
      runProbe(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs,
      }),
  });
  expect(result).toBe(env);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("pathFromOutput wants the markers right around one line", () => {
  expect(pathFromOutput(`${START}\r\n/usr/bin\r\n${END}\r\n`)).toBe("/usr/bin");
  expect(pathFromOutput(`${END}\n/usr/bin\n${START}\n`)).toBe(undefined);
});
