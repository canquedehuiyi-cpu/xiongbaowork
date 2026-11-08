/**
 * The runner as a desktop shell would ship it: one `bun build --compile` binary (F2 stage 0).
 *
 * Not a mock of the runner. The binary is built from `src/index.ts` into a temporary directory and
 * started as a separate process, from an empty launch directory, against a deployment made of the
 * server's own runner pieces — `createRunnerRoutes` for `/api/runner/register`, `runnerOpen`,
 * `runnerMessage` and `runnerClose` behind `/api/runner/ws`, and `createDeviceChannel` to send it
 * work. Only the device store is in memory, because Postgres is not what this proves.
 *
 * What it proves, each against the compiled binary:
 *   - `--data-dir X`: a new machine pairs with a UUID v4 id, runs `files.write` and `files.list`, and
 *     every file it writes is under X. The launch directory, HOME and TMPDIR stay empty.
 *   - `OPENBOT_RUNNER_DATA_DIR`: a state file written before stage 0, with a `hostname-xxxxxxxx` id,
 *     connects without pairing again, keeps its id, and is not rewritten.
 *   - neither: the files land in the launch directory, where every runner has kept them so far.
 *
 * `chromium-bidi` is left external because `playwright-core` names it in a `require` it only makes
 * for WebDriver BiDi browsers, and the package is not installed (it is an optional peer). The runner
 * drives Chrome, Edge or Chromium over CDP, which never reaches that `require`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  createDeviceChannel,
  type DeviceChannel,
} from "../../server/src/devices/channel";
import { createRunnerRoutes } from "../../server/src/devices/routes";
import {
  type RunnerSocketData,
  runnerClose,
  runnerMessage,
  runnerOpen,
} from "../../server/src/devices/socket";
import type {
  DeviceOwner,
  DeviceRecord,
  DeviceStore,
} from "../../server/src/devices/store";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TENANT = "tenant-package-test";
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

/** The parts of the device store the register route and the socket handlers call, kept in memory. */
function memoryDeviceStore() {
  const codes = new Map<string, string>();
  const devices = new Map<
    string,
    DeviceRecord & { tenantId: string; tokenHash: string }
  >();
  const hash = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  const byToken = (token: string) =>
    [...devices.values()].find((device) => device.tokenHash === hash(token));
  const ownerOf = (
    device: DeviceRecord & { tenantId: string; tokenHash: string },
  ): DeviceOwner => ({
    id: device.id,
    tenantId: device.tenantId,
    deviceId: device.deviceId,
    credentialVersion: device.tokenHash,
  });

  const store: DeviceStore = {
    async mintPairCode(tenantId) {
      const code = randomBytes(4).toString("hex").toUpperCase();
      codes.set(code, tenantId);
      return { code, expiresAt: new Date(Date.now() + 600_000) };
    },
    async redeemPairCode(input) {
      const tenantId = codes.get(input.code);
      if (!tenantId) return null;
      codes.delete(input.code);
      const token = `obot_dev_${randomBytes(24).toString("hex")}`;
      const device = {
        id: crypto.randomUUID(),
        tenantId,
        deviceId: input.deviceId,
        name: input.name,
        platform: input.platform,
        lastSeenAt: null,
        online: false,
        // The read-only folders the machine offers (F1 stage 2); a fresh pairing offers none.
        roots: [],
        // The local apps (MCP) it offers; a fresh pairing offers none.
        apps: [],
        tokenHash: hash(token),
      };
      devices.set(`${tenantId}/${input.deviceId}`, device);
      return { token, device };
    },
    async list(tenantId) {
      return [...devices.values()].filter((d) => d.tenantId === tenantId);
    },
    async tenantForCode(code) {
      return codes.get(code) ?? null;
    },
    async deviceForToken(token) {
      const device = byToken(token);
      return device ? ownerOf(device) : null;
    },
    async isCurrent(owner) {
      const device = devices.get(`${owner.tenantId}/${owner.deviceId}`);
      return device?.tokenHash === owner.credentialVersion;
    },
    async isRegistered(target, credentialVersion) {
      const device = devices.get(`${target.tenantId}/${target.deviceId}`);
      return Boolean(
        device &&
          (!credentialVersion || device.tokenHash === credentialVersion),
      );
    },
    async heartbeat(tenantId, deviceId) {
      const device = devices.get(`${tenantId}/${deviceId}`);
      if (device) device.lastSeenAt = new Date();
    },
    // Enabling an app writes it on the device record; this probe enables none.
    async rememberApp() {},
    async remove(tenantId, id) {
      for (const [key, device] of devices) {
        if (device.tenantId === tenantId && device.id === id) {
          devices.delete(key);
          return true;
        }
      }
      return false;
    },
  };
  return { store, devices };
}

let root = "";
let binary = "";
let server: ReturnType<typeof Bun.serve<RunnerSocketData>> | undefined;
let base = "";
let channel: DeviceChannel;
let memory: ReturnType<typeof memoryDeviceStore>;
const children: Bun.Subprocess[] = [];
/** The server's side of every open runner socket, so a test can drop one. */
const sockets = new Set<ServerWebSocket<RunnerSocketData>>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openbot-runner-package-"));
  binary = join(root, "openbot-runner");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      ENTRY,
      "--external",
      "chromium-bidi",
      "--external",
      "chromium-bidi/*",
      "--outfile",
      binary,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const code = await build.exited;
  if (code !== 0) {
    throw new Error(
      `bun build --compile failed (${code}):\n${await new Response(build.stdout).text()}\n${await new Response(build.stderr).text()}`,
    );
  }

  memory = memoryDeviceStore();
  const { store } = memory;
  channel = createDeviceChannel({
    authorize: (target, version) => store.isRegistered(target, version),
  });
  const routes = createRunnerRoutes(store);
  server = Bun.serve<RunnerSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
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
        sockets.add(ws);
        void runnerOpen(ws, store, channel).catch(() => ws.close(1008));
      },
      message: (ws, value) => {
        void runnerMessage(ws, store, channel, value).catch(() =>
          ws.close(1008),
        );
      },
      close: (ws) => {
        sockets.delete(ws);
        runnerClose(ws, channel);
      },
    },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  server?.stop(true);
  // The binary is ~100MB: it does not outlive the run.
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A fresh, empty directory under this run's root. */
function emptyDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The compiled runner, started from `cwd` with an environment of its own.
 *
 * Nothing is inherited, and PATH holds only the system directories: no Bun and no repository on it,
 * so a binary that still needed either would fail here rather than on somebody's laptop.
 */
function startRunner(
  args: string[],
  options: { cwd: string; home: string; tmp: string; dataDirEnv?: string },
) {
  const child = Bun.spawn([binary, "--server", base, ...args], {
    cwd: options.cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: options.home,
      TMPDIR: options.tmp,
      ...(options.dataDirEnv
        ? { OPENBOT_RUNNER_DATA_DIR: options.dataDirEnv }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

/** Stop it the way a service manager does, and hand back what it printed. */
async function stopRunner(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  child.kill("SIGTERM");
  const code = await child.exited;
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
  return { code, output };
}

async function waitUntil(
  check: () => boolean,
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (child.exitCode !== null) {
      const { output } = await stopRunner(child);
      throw new Error(
        `The runner exited (${child.exitCode}) before ${what}:\n${output}`,
      );
    }
    if (Date.now() > deadline) {
      const { output } = await stopRunner(child);
      throw new Error(`Timed out waiting for ${what}:\n${output}`);
    }
    await Bun.sleep(50);
  }
}

test("compiled with --data-dir: a new device pairs as a UUID, lists its files, and writes only inside the data directory", async () => {
  const launch = emptyDir("a-launch");
  const home = emptyDir("a-home");
  const tmp = emptyDir("a-tmp");
  // Not created beforehand: the runner makes it.
  const dataDir = join(root, "a-data", "nested");
  const { code } = await memory.store.mintPairCode(TENANT);

  const child = startRunner(
    ["--pair", code, "--data-dir", dataDir, "--name", "package-test"],
    { cwd: launch, home, tmp },
  );
  const paired = () =>
    [...memory.devices.values()].find((d) => d.name === "package-test");
  await waitUntil(() => Boolean(paired()), child, "pairing");
  const deviceId = paired()?.deviceId ?? "";
  expect(deviceId).toMatch(UUID_V4);

  const target = { tenantId: TENANT, deviceId };
  await waitUntil(() => channel.isReachable(target), child, "the socket");
  await channel.dispatch(
    target,
    "files.write",
    { path: "notes/hello.txt", contents: "hello from the package test" },
    10_000,
    "package-write",
  );
  const listed = await channel.dispatch<{
    entries: { path: string }[];
  }>(target, "files.list", {}, 10_000, "package-list");
  expect(listed.entries.map((entry) => entry.path)).toContain(
    "notes/hello.txt",
  );

  const { code: exitCode, output } = await stopRunner(child);
  expect(exitCode, output).toBe(0);
  expect(output).toContain(`paired as ${deviceId}`);

  // Nothing outside the data directory.
  expect(readdirSync(launch)).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
  expect(readdirSync(tmp)).toEqual([]);
  // And inside it, only what the runner names: the credentials, the journal beside them, the workspace.
  const written = readdirSync(dataDir).sort();
  expect(written).toContain("runner-state.json");
  expect(written).toContain("runner-state.json.actions.sqlite");
  expect(written).toContain("runner-workspace");
  for (const entry of written) {
    expect(
      entry === "runner-workspace" || entry.startsWith("runner-state.json"),
      entry,
    ).toBeTrue();
  }
  expect(
    readFileSync(
      join(dataDir, "runner-workspace", "notes", "hello.txt"),
      "utf8",
    ),
  ).toBe("hello from the package test");
  const state = JSON.parse(
    readFileSync(join(dataDir, "runner-state.json"), "utf8"),
  );
  expect(Object.keys(state).sort()).toEqual(["deviceId", "server", "token"]);
  expect(state.deviceId).toBe(deviceId);
  expect(state.server).toBe(base);
  expect(statSync(join(dataDir, "runner-state.json")).mode & 0o777).toBe(0o600);
  expect(statSync(dataDir).mode & 0o777).toBe(0o700);
}, 60_000);

test("compiled with OPENBOT_RUNNER_DATA_DIR: a state file from before stage 0 connects unchanged with its old id", async () => {
  const launch = emptyDir("b-launch");
  const home = emptyDir("b-home");
  const tmp = emptyDir("b-tmp");
  const dataDir = emptyDir("b-data");
  const oldId = "old-laptop-1a2b3c4d";
  const { code } = await memory.store.mintPairCode(TENANT);
  const paired = await memory.store.redeemPairCode({
    code,
    deviceId: oldId,
    name: "old laptop",
    platform: "linux",
  });
  if (!paired) throw new Error("The fixture pairing failed.");
  // Byte for byte what `writeState` produced before this change.
  const before = `${JSON.stringify({ deviceId: oldId, token: paired.token, server: base }, null, 2)}\n`;
  writeFileSync(join(dataDir, "runner-state.json"), before, { mode: 0o600 });

  const child = startRunner([], {
    cwd: launch,
    home,
    tmp,
    dataDirEnv: dataDir,
  });
  const target = { tenantId: TENANT, deviceId: oldId };
  await waitUntil(() => channel.isReachable(target), child, "the socket");
  const listed = await channel.dispatch<{ entries: unknown[] }>(
    target,
    "files.list",
    {},
    10_000,
    "legacy-list",
  );
  expect(listed.entries).toEqual([]);

  const { code: exitCode, output } = await stopRunner(child);
  expect(exitCode, output).toBe(0);
  expect(output).toContain(`connected as ${oldId}`);
  expect(readFileSync(join(dataDir, "runner-state.json"), "utf8")).toBe(before);
  expect(readdirSync(launch)).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
}, 60_000);

test("compiled with neither: the runner keeps today's layout in the directory it was started in", async () => {
  const launch = emptyDir("c-launch");
  const home = emptyDir("c-home");
  const tmp = emptyDir("c-tmp");
  const { code } = await memory.store.mintPairCode(TENANT);

  const child = startRunner(["--pair", code, "--name", "default-layout"], {
    cwd: launch,
    home,
    tmp,
  });
  const paired = () =>
    [...memory.devices.values()].find((d) => d.name === "default-layout");
  await waitUntil(() => Boolean(paired()), child, "pairing");
  const target = { tenantId: TENANT, deviceId: paired()?.deviceId ?? "" };
  await waitUntil(() => channel.isReachable(target), child, "the socket");
  await channel.dispatch(target, "files.list", {}, 10_000, "default-list");

  const { code: exitCode, output } = await stopRunner(child);
  expect(exitCode, output).toBe(0);
  const written = readdirSync(launch);
  expect(written).toContain("runner-state.json");
  expect(written).toContain("runner-state.json.actions.sqlite");
  expect(written).toContain("runner-workspace");
  expect(
    JSON.parse(readFileSync(join(launch, "runner-state.json"), "utf8"))
      .deviceId,
  ).toMatch(UUID_V4);
}, 60_000);

/**
 * The compiled runner started once, to its end, with the same bare environment as `startRunner`
 * (plus `extraEnv`), and what it printed. Killed after 20 s, so a binary that waits instead of
 * answering fails here with what it printed rather than as the test's own timeout.
 */
async function runOnce(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
) {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 20_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) {
    throw new Error(
      `${args.join(" ")} did not finish within 20s:\n${stdout}${stderr}`,
    );
  }
  return { code, stdout, stderr };
}

// Device app discovery (sub-project 3) starts npm apps with the runner itself as `bun x`. These are
// the offline halves of that: Bun's own CLI answers under BUN_BE_BUN=1, and only then. The online
// half (`x --bun <package>`) is `scripts/ci/bunx-spike.ts`, which needs the npm registry.
test("BUN_BE_BUN=1 makes the compiled runner act as bun: --version and a script", async () => {
  const dir = emptyDir("e-be-bun");
  const script = join(dir, "marker.ts");
  // TypeScript on purpose: it is Bun's transpiler that runs it, not the runner's own entry point.
  writeFileSync(
    script,
    "const next: number = 41 + 1;\nconsole.log('BE_BUN_MARKER ' + next);\nconsole.log('EXEC_PATH ' + process.execPath);\n",
  );

  const version = await runOnce(["--version"], dir, { BUN_BE_BUN: "1" });
  expect(version.code, version.stderr).toBe(0);
  expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);

  const ran = await runOnce([script], dir, { BUN_BE_BUN: "1" });
  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("BE_BUN_MARKER 42");
  // And it is this binary doing it, not a Bun found somewhere on the machine.
  const execPath = ran.stdout.match(/^EXEC_PATH (.+)$/m)?.[1] ?? "";
  expect(realpathSync(execPath)).toBe(realpathSync(binary));

  // Without the variable the same binary is the runner: it reads both as its own (bad) arguments.
  const asRunner = await runOnce(["--version"], dir);
  expect(asRunner.code).toBe(2);
  expect(`${asRunner.stdout}${asRunner.stderr}`).toContain(
    "Pass --server with the http(s) address of your deployment.",
  );
  const scriptAsRunner = await runOnce([script], dir);
  expect(scriptAsRunner.code).toBe(2);
  expect(scriptAsRunner.stdout).not.toContain("BE_BUN_MARKER");
}, 60_000);

test("compiled: a dropped connection is reported as such and dialled again", async () => {
  const launch = emptyDir("d-launch");
  const home = emptyDir("d-home");
  const tmp = emptyDir("d-tmp");
  const dataDir = emptyDir("d-data");
  const { code } = await memory.store.mintPairCode(TENANT);

  const child = startRunner(
    ["--pair", code, "--data-dir", dataDir, "--name", "dropped"],
    { cwd: launch, home, tmp },
  );
  const paired = () =>
    [...memory.devices.values()].find((d) => d.name === "dropped");
  await waitUntil(() => Boolean(paired()), child, "pairing");
  const target = { tenantId: TENANT, deviceId: paired()?.deviceId ?? "" };
  await waitUntil(() => channel.isReachable(target), child, "the socket");

  // The deployment goes away under it, as a server restart does.
  for (const socket of sockets) socket.close(1001, "restarting");
  await waitUntil(() => !channel.isReachable(target), child, "the drop");
  await waitUntil(() => channel.isReachable(target), child, "the redial");

  const { code: exitCode, output } = await stopRunner(child);
  expect(exitCode, output).toBe(0);
  // The order a tray reads: up, down, up again.
  const lines = output
    .split("\n")
    .filter((line) => /^runner: (connected as|disconnected)/.test(line));
  expect(lines.slice(0, 3).map((line) => line.split(" ")[1])).toEqual([
    "connected",
    "disconnected",
    "connected",
  ]);
}, 60_000);
