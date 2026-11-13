#!/usr/bin/env bun
/**
 * The compiled runner sidecar starts a real browser on a machine that never saw the build tree.
 *
 *   bun scripts/ci/sidecar-browser-probe.ts --binary PATH --executable CHROME [--hide DIR]
 *
 * WHY THIS EXISTS. `bun build --compile` writes each bundled module's `__dirname` into the binary as
 * the build machine's absolute path. Anything that reads a file relative to it at run time works on
 * the build machine, where that path still exists, and fails on every user's machine, where it does
 * not. playwright-core did exactly that for its own `package.json` and `browsers.json` (fixed by
 * `patches/playwright-core@*.patch`), and the G5 probe could not see it because it runs in the
 * checkout. This probe runs the sidecar the way a user gets it: copied out of the checkout, started
 * from an empty directory with a bare environment, and with `--hide`, with the checkout itself
 * covered by an empty tmpfs in a private mount namespace, so no path under it can be read at all.
 *
 * WHAT IT DOES. The server's own runner routes and device channel (the device store in memory, as
 * in `runner/tests/runner-package.test.ts`) pair the sidecar, then send it one `navigate` to a page
 * this probe serves on 127.0.0.1. The runner's real launcher starts the named browser (headless, the
 * product's sandbox left on), and the page's title has to come back. Prints
 * `SIDECAR_BROWSER_PROBE_PASS` and exits 0 only then.
 *
 * `--hide` is Linux only and needs root for the mount namespace: as root it is used directly,
 * otherwise through `sudo -n`. The sidecar itself never runs as root (Chrome refuses its sandbox
 * there): it runs as the calling user, or as `nobody` when the caller is root.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createDeviceChannel } from "../../server/src/devices/channel";
import { createRunnerRoutes } from "../../server/src/devices/routes";
import {
  type RunnerSocketData,
  runnerClose,
  runnerMessage,
  runnerOpen,
} from "../../server/src/devices/socket";
import { memoryDeviceStore } from "../../runner/tests/fixtures/memory-device-store";

const args = process.argv.slice(2);
function arg(name: string): string {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? "" : (args[index + 1] ?? "").trim();
}

const binaryArg = arg("binary");
const executable = arg("executable");
const hideArg = arg("hide");
if (!binaryArg || !executable) {
  console.error(
    "usage: bun scripts/ci/sidecar-browser-probe.ts --binary PATH --executable CHROME [--hide DIR]",
  );
  process.exit(2);
}
if (hideArg && process.platform !== "linux") {
  console.error("--hide needs a Linux mount namespace.");
  process.exit(2);
}

const TENANT = "sidecar-probe-tenant";
const IDENTITY = { tenantId: TENANT, botId: "sidecar-probe-bot" };
const TITLE = "Sidecar browser probe";
const hide = hideArg ? realpathSync(resolve(hideArg)) : "";

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Everything the sidecar touches lives here, outside the checkout.
const root = realpathSync(
  mkdtempSync(join(tmpdir(), "sidecar-browser-probe-")),
);
if (hide && inside(hide, root)) {
  throw new Error(`The probe's directory ${root} is inside --hide ${hide}.`);
}
const binary = join(root, "bin", basename(binaryArg));
const launch = join(root, "launch");
const home = join(root, "home");
const tmp = join(root, "tmp");
const dataDir = join(root, "data");
for (const dir of [join(root, "bin"), launch, home, tmp]) mkdirSync(dir);
copyFileSync(binaryArg, binary);
chmodSync(binary, 0o755);

const callerUid = process.getuid?.() ?? -1;
// The user the sidecar runs as under --hide; never root.
const runAs =
  callerUid === 0
    ? { uid: 65534, gid: 65534 }
    : { uid: callerUid, gid: process.getgid?.() ?? callerUid };
if (hide && callerUid === 0) {
  for (const dir of [root, join(root, "bin"), launch, home, tmp]) {
    chownSync(dir, runAs.uid, runAs.gid);
  }
}

const memory = memoryDeviceStore();
const { store } = memory;
const channel = createDeviceChannel({
  authorize: (target, version) => store.isRegistered(target, version),
});
const routes = createRunnerRoutes(store);
const server = Bun.serve<RunnerSocketData>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/page") {
      return new Response(
        `<!doctype html><title>${TITLE}</title><p>served to the sidecar</p>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.pathname === "/api/runner/ws") {
      const owner = await store.deviceForToken(
        url.searchParams.get("token") ?? "",
      );
      if (!owner) return new Response("Not a device", { status: 401 });
      if (server.upgrade(request, { data: { runner: owner } })) return;
      return new Response("Upgrade required", { status: 400 });
    }
    if (url.pathname.startsWith("/api/runner/")) {
      return routes.request(url.pathname.slice("/api/runner".length), {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open: (ws) => {
      void runnerOpen(ws, store, channel).catch(() => ws.close(1008));
    },
    message: (ws, value) => {
      void runnerMessage(ws, store, channel, value).catch(() => ws.close(1008));
    },
    close: (ws) => runnerClose(ws, channel),
  },
});
const base = `http://127.0.0.1:${server.port}`;

const { code } = await store.mintPairCode(TENANT);
const runnerArgs = [
  "--server",
  base,
  "--pair",
  code,
  "--data-dir",
  dataDir,
  "--name",
  "sidecar-probe",
  "--browser-executable",
  executable,
  "--browser-headless",
  "true",
  "--browser-private-hosts",
  "true",
];
const env = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  TMPDIR: tmp,
};

/**
 * The command that starts the sidecar. With --hide: a private mount namespace in which `hide` is an
 * empty tmpfs (checked before anything starts), then the sidecar as `runAs` with only `env`.
 */
function command(): string[] {
  if (!hide) return [binary, ...runnerArgs];
  const script = [
    'mount -t tmpfs -o size=1m,mode=0755 tmpfs "$0"',
    'if [ -n "$(ls -A "$0")" ]; then echo "probe: $0 is still visible" >&2; exit 97; fi',
    `exec setpriv --reuid=${runAs.uid} --regid=${runAs.gid} --clear-groups -- env -i ${Object.entries(
      env,
    )
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")} "$@"`,
  ].join("\n");
  const unshare = [
    "unshare",
    "--mount",
    "--propagation",
    "private",
    "--",
    "sh",
    "-c",
    script,
    hide,
    binary,
    ...runnerArgs,
  ];
  return callerUid === 0 ? unshare : ["sudo", "-n", ...unshare];
}

const report = (check: string, passed: boolean, detail = "") =>
  console.log(JSON.stringify({ check, passed, ...(detail ? { detail } : {}) }));

console.log(
  JSON.stringify({
    probe: "compiled sidecar, real browser",
    binary: binaryArg,
    copiedTo: binary,
    browser: executable,
    hidden: hide || null,
    runAs: hide ? runAs : null,
  }),
);
if (hide) {
  // The namespace itself, checked once on its own: an empty tmpfs where the checkout was.
  const check = spawnSync(
    callerUid === 0 ? "unshare" : "sudo",
    [
      ...(callerUid === 0 ? [] : ["-n", "unshare"]),
      "--mount",
      "--propagation",
      "private",
      "--",
      "sh",
      "-c",
      'mount -t tmpfs tmpfs "$0" && ls -A "$0" | wc -l',
      hide,
    ],
    { encoding: "utf8" },
  );
  const empty = check.status === 0 && check.stdout.trim() === "0";
  report(
    "the checkout is out of sight inside the namespace",
    empty,
    `${check.stdout}${check.stderr}`.trim(),
  );
  if (!empty) process.exit(1);
}

const child = Bun.spawn(command(), {
  cwd: launch,
  env: hide ? { PATH: process.env.PATH ?? "/usr/bin:/bin" } : env,
  stdout: "pipe",
  stderr: "pipe",
});
let printed = "";
const decoder = new TextDecoder();
async function collect(stream: ReadableStream<Uint8Array>) {
  for await (const chunk of stream) printed += decoder.decode(chunk);
}
const reading = Promise.all([collect(child.stdout), collect(child.stderr)]);

async function finish(passed: boolean): Promise<never> {
  if (child.exitCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await child.exited;
  clearTimeout(timer);
  await reading;
  server.stop(true);
  console.log("--- sidecar output ---");
  console.log(printed.trimEnd());
  console.log("--- end sidecar output ---");
  rmSync(root, { recursive: true, force: true });
  if (passed) console.log("SIDECAR_BROWSER_PROBE_PASS");
  process.exit(passed ? 0 : 1);
}

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (child.exitCode !== null) {
      report(what, false, `the sidecar exited (${child.exitCode}) first`);
      await finish(false);
    }
    if (Date.now() > deadline) {
      report(what, false, "timed out");
      await finish(false);
    }
    await Bun.sleep(100);
  }
  report(what, true);
}

const paired = () =>
  [...memory.devices.values()].find((d) => d.name === "sidecar-probe");
await waitFor(() => Boolean(paired()), "the sidecar pairs");
const target = { tenantId: TENANT, deviceId: paired()?.deviceId ?? "" };
await waitFor(() => channel.isReachable(target), "the sidecar connects");

try {
  const landed = await channel.dispatch<Record<string, unknown>>(
    target,
    "navigate",
    { ...IDENTITY, url: `${base}/page` },
    120_000,
    "sidecar-probe-navigate",
  );
  const passed = landed.url === `${base}/page` && landed.title === TITLE;
  report(
    "the sidecar starts the browser and the page's title comes back",
    passed,
    JSON.stringify({ url: landed.url, title: landed.title }),
  );
  await finish(passed);
} catch (error) {
  report(
    "the sidecar starts the browser and the page's title comes back",
    false,
    error instanceof Error ? error.message : String(error),
  );
  await finish(false);
}
