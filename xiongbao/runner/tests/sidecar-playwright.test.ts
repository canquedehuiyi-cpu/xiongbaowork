/**
 * playwright-core compiled into one file, run after the directory it was compiled from is gone.
 *
 * `bun build --compile` writes each bundled module's `__dirname` into the binary as the absolute path
 * it had on the build machine. playwright-core loaded its own `package.json` and `browsers.json` with
 * a `require` of a path joined onto that `__dirname`, which the bundler cannot see into, so the
 * sidecar read both files from the build tree at run time. On the build machine (and in CI, and in
 * `runner-package.test.ts`) the tree is there and everything works; on a user's machine `import
 * ("playwright-core")` threw `Cannot find module '<build path>/package.json'` and no browser could
 * start. `patches/playwright-core@*.patch` turns those `require`s into static relative ones, which
 * the bundler inlines.
 *
 * The runner itself cannot be compiled from a directory this test then deletes, so this compiles a
 * small entry beside a COPY of the installed playwright-core, with the sidecar's own flags
 * (`compileArgs`), deletes the copy, and runs the binary from somewhere else. A binary that still
 * reads anything from its build directory fails here on every platform, with no privileges needed.
 * `scripts/ci/sidecar-browser-probe.ts` is the end-to-end half: the real sidecar, with the whole
 * checkout hidden, in CI.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileArgs } from "../../desktop-device/scripts/build-sidecar";

const windows = process.platform === "win32";
const HOST = "host";

/** The entry compiled beside the copy: the same dynamic import and launch call the runner makes. */
const PROBE = `
const { chromium } = await import("playwright-core");
const [executablePath, profileDir] = process.argv.slice(2);
try {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    timeout: 60_000,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setContent("<title>compiled and moved</title>");
  console.log("PAGE_TITLE " + (await page.title()));
  await context.close();
} catch (error) {
  console.log("LAUNCH_ERROR " + (error instanceof Error ? error.message : String(error)));
  process.exit(3);
}
`;

/** A Chrome or Chromium on this machine, if there is one; the first half of this file needs none. */
function findBrowser(): string | undefined {
  const named = process.env.XIONGBAO_TEST_BROWSER?.trim();
  if (named) return named;
  const candidates = [
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((path) => existsSync(path));
}

let root = "";
let build = "";
let binary = "";
let run = "";

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sidecar-playwright-")));
  build = join(root, "build");
  run = join(root, "run");
  mkdirSync(run);
  binary = join(run, windows ? "probe.exe" : "probe");

  // The installed package, patch and all, exactly as `bun install` left it.
  const installed = dirname(
    realpathSync(
      createRequire(import.meta.url).resolve("playwright-core/package.json"),
    ),
  );
  cpSync(installed, join(build, "node_modules", "playwright-core"), {
    recursive: true,
  });
  const entry = join(build, "probe.ts");
  writeFileSync(entry, PROBE);

  const compile = Bun.spawn(
    [process.execPath, ...compileArgs(HOST, HOST, binary, entry)],
    { cwd: build, stdout: "pipe", stderr: "pipe" },
  );
  const code = await compile.exited;
  if (code !== 0) {
    throw new Error(
      `bun build --compile failed (${code}):\n${await new Response(compile.stdout).text()}\n${await new Response(compile.stderr).text()}`,
    );
  }
  // From here on the build directory does not exist, as on every machine but the one that built it.
  rmSync(build, { recursive: true, force: true });
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function runProbe(executablePath: string, profile: string) {
  const env: Record<string, string> = {
    PATH: windows ? (process.env.PATH ?? "") : "/usr/bin:/bin",
    HOME: run,
    TMPDIR: run,
  };
  if (windows) {
    for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "LOCALAPPDATA"]) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    env.TEMP = run;
    env.TMP = run;
    env.USERPROFILE = run;
  }
  const child = Bun.spawn([binary, executablePath, profile], {
    cwd: run,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  return { code, output: `${stdout}${stderr}` };
}

test("the build directory is gone before the binary runs", () => {
  expect(existsSync(build)).toBe(false);
  expect(existsSync(binary)).toBe(true);
});

test("compiled and moved: playwright-core loads and reaches the browser launch without its build directory", async () => {
  // No browser is needed to prove the package loaded: a missing executable is refused by
  // playwright-core's own launch code, which is past every file it used to read from the build tree.
  const missing = join(
    run,
    windows ? "no-such-browser.exe" : "no-such-browser",
  );
  const { code, output } = await runProbe(
    missing,
    join(run, "profile-missing"),
  );
  expect(output).not.toContain("Cannot find module");
  expect(code, output).toBe(3);
  expect(output).toContain("LAUNCH_ERROR");
  expect(output).toContain(
    `Failed to launch chromium because executable doesn't exist at ${missing}`,
  );
}, 120_000);

const browser = findBrowser();

test.skipIf(!browser)(
  "compiled and moved: a real headless browser starts and renders a page",
  async () => {
    const { code, output } = await runProbe(
      browser ?? "",
      join(run, "profile-real"),
    );
    expect(output).not.toContain("Cannot find module");
    expect(code, output).toBe(0);
    expect(output).toContain("PAGE_TITLE compiled and moved");
  },
  120_000,
);
