import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentProbeDeps,
  discoverAgents,
  type ProbeResult,
  runProbe,
  whichPosix,
} from "../src/acp/discover";
import { ACP_MANIFEST, adapterLaunch } from "../src/acp/manifest";
import { createAppRegistry } from "../src/apps";
import {
  createDiscoverActions,
  DISCOVER_ACTIONS,
} from "../src/discover-actions";
import { launchSpec } from "../src/mcp-client";

/*
 * `agents.discover`: which of Codex, Claude Code and Hermes this machine has, whether their ACP
 * adapter can start and whether they are signed in. Only booleans and a version leave the device.
 */

const scratch = mkdtempSync(join(tmpdir(), "openbot-runner-agents-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const KEYS = ["acpReady", "harness", "installed", "signedIn", "version"];

type Answer = Partial<ProbeResult>;

/** A machine with the given commands on PATH, whose programs answer from `answers` by command line. */
function machine(
  onPath: string[],
  answers: Record<string, Answer>,
): AgentProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    which: (command) =>
      onPath.includes(command) ? `/usr/local/bin/${command}` : undefined,
    run: async (command, args) => {
      const line = [command.replace("/usr/local/bin/", ""), ...args].join(" ");
      calls.push(line);
      return {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...answers[line],
      };
    },
  };
}

test("reports installed, acpReady and signedIn null when status cannot be read", async () => {
  const deps = machine(["codex", "npx"], {
    "codex --version": { code: 0, stdout: "codex-cli 0.169.0\n" },
    // The status command hung and was stopped.
    "codex login status": { code: null, timedOut: true },
  });
  const { agents } = await discoverAgents(deps);
  expect(agents).toEqual([
    {
      harness: "codex",
      version: "0.169.0",
      installed: true,
      acpReady: true,
      signedIn: null,
    },
    {
      harness: "claude-code",
      version: null,
      installed: false,
      // The adapter brings its own Claude Code through npx.
      acpReady: true,
      signedIn: null,
    },
    {
      harness: "hermes",
      version: null,
      installed: false,
      acpReady: false,
      signedIn: null,
    },
  ]);
  // Nothing that is not installed was run.
  expect(deps.calls.sort()).toEqual(["codex --version", "codex login status"]);
});

test("reads signedIn from each CLI's own status command", async () => {
  const signedIn = machine(["codex", "claude", "hermes", "npx"], {
    "codex --version": { code: 0, stdout: "codex-cli 0.169.0" },
    "codex login status": { code: 0, stderr: "Logged in using ChatGPT\n" },
    "claude --version": { code: 0, stdout: "2.1.325 (Claude Code)\n" },
    "claude auth status": {
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    },
    "hermes --version": { code: 0, stdout: "Hermes Agent v0.14.2\n" },
    "hermes acp --check": { code: 0, stdout: "ACP ok\n" },
  });
  expect((await discoverAgents(signedIn)).agents).toEqual([
    {
      harness: "codex",
      version: "0.169.0",
      installed: true,
      acpReady: true,
      signedIn: true,
    },
    {
      harness: "claude-code",
      version: "2.1.325",
      installed: true,
      acpReady: true,
      signedIn: true,
    },
    {
      harness: "hermes",
      version: "0.14.2",
      installed: true,
      acpReady: true,
      // Hermes has no single signed-in state to read.
      signedIn: null,
    },
  ]);

  const signedOut = machine(["codex", "claude", "hermes"], {
    "codex --version": { code: 0, stdout: "codex-cli 0.169.0" },
    "codex login status": { code: 1, stderr: "Not logged in\n" },
    "claude --version": { code: 0, stdout: "2.1.325 (Claude Code)" },
    "claude auth status": {
      code: 1,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
    },
    "hermes --version": { code: 0, stdout: "Hermes Agent v0.14.2" },
    // The ACP extra is not installed.
    "hermes acp --check": { code: 1, stderr: "agent-client-protocol missing" },
  });
  expect(
    (await discoverAgents(signedOut)).agents.map((a) => [
      a.harness,
      a.acpReady,
      a.signedIn,
    ]),
  ).toEqual([
    // No npx on this machine: neither npm adapter can start.
    ["codex", false, false],
    ["claude-code", false, false],
    ["hermes", false, null],
  ]);
});

test("never returns file contents, only booleans and version", async () => {
  const secrets = [
    "sk-proj-SECRET",
    "owner@example.com",
    "/home/owner/.claude",
    "/home/owner/.codex/config.toml",
    "Org of Owner",
  ];
  const deps = machine(["codex", "claude", "hermes", "npx"], {
    "codex --version": {
      code: 0,
      stdout:
        "codex-cli 0.169.0\nWARNING: reading /home/owner/.codex/config.toml\n",
    },
    "codex login status": {
      code: 0,
      stderr: "API key configured - sk-proj-SECRET\n",
    },
    "claude --version": { code: 0, stdout: "2.1.325 (Claude Code)" },
    "claude auth status": {
      code: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        email: "owner@example.com",
        orgName: "Org of Owner",
        configDirectory: "/home/owner/.claude",
      }),
    },
    "hermes --version": {
      code: 0,
      stdout: `Hermes Agent v0.14.2 (${"x".repeat(5000)})`,
    },
    "hermes acp --check": { code: 0, stdout: "owner@example.com" },
  });
  const direct = await discoverAgents(deps);
  const viaAction = await createDiscoverActions({
    dataDir: scratch,
    registry: createAppRegistry({ dataDir: scratch }),
    agents: deps,
  })("agents.discover", {});
  expect(viaAction).toEqual({ ok: true, output: direct });
  expect(Object.keys(direct)).toEqual(["agents"]);
  for (const agent of direct.agents) {
    expect(Object.keys(agent).sort()).toEqual(KEYS);
    expect(typeof agent.installed).toBe("boolean");
    expect(typeof agent.acpReady).toBe("boolean");
    expect([true, false, null]).toContain(agent.signedIn);
    expect(
      agent.version === null ||
        /^[0-9][0-9A-Za-z.+-]{0,39}$/.test(agent.version),
    ).toBe(true);
  }
  const text = JSON.stringify(direct);
  for (const secret of secrets) expect(text).not.toContain(secret);
});

test("agents.discover is one of the discovery actions", () => {
  expect(DISCOVER_ACTIONS.has("agents.discover")).toBe(true);
});

test("every manifest entry names its binary, adapter and ask mode", () => {
  expect(Object.keys(ACP_MANIFEST).sort()).toEqual([
    "claude-code",
    "codex",
    "hermes",
  ]);
  for (const entry of Object.values(ACP_MANIFEST)) {
    expect(entry.binary).toMatch(/^[a-z-]+$/);
    expect(entry.adapter.command.length).toBeGreaterThan(0);
    expect(Array.isArray(entry.askMode)).toBe(true);
  }
});

test("adapterLaunch carries the ask mode and the login PATH, and a Windows npx shim goes through cmd.exe", async () => {
  const sameEnv = async () => ({ ...process.env });
  const codex = await adapterLaunch("codex", "/work", {
    env: { OWN: "1" },
    processEnv: sameEnv,
  });
  expect(codex).toEqual({
    command: "npx",
    args: [...ACP_MANIFEST.codex.adapter.args, ...ACP_MANIFEST.codex.askMode],
    env: { OWN: "1", INITIAL_AGENT_MODE: "read-only" },
    cwd: "/work",
    sessionMode: "read-only",
  });
  expect(
    (await adapterLaunch("claude-code", "/work", { processEnv: sameEnv }))
      .sessionMode,
  ).toBe("default");
  expect(
    await adapterLaunch("hermes", "/work", { processEnv: sameEnv }),
  ).toMatchObject({ command: "hermes", args: ["acp"], sessionMode: "default" });
  // The login shell's PATH reaches the adapter's environment, where npx is looked up.
  const withLogin = await adapterLaunch("claude-code", "/work", {
    processEnv: async () => ({
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    }),
  });
  expect(withLogin.env.PATH?.startsWith("/opt/homebrew/bin:")).toBe(true);
  const npx = "C:\\Program Files\\nodejs\\npx.cmd";
  const spec = launchSpec(
    codex,
    "win32",
    { Path: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" },
    (path) => path.toLowerCase() === npx.toLowerCase(),
  );
  expect(spec.command).toBe("cmd.exe");
  expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(spec.args[3]).toContain(`"${npx}" "-y"`);
  expect(spec.windowsVerbatimArguments).toBe(true);
});

test("whichPosix finds the first executable on PATH and skips relative folders", () => {
  const executables = new Set(["/opt/b/codex", "/usr/bin/codex"]);
  const has = (path: string) => executables.has(path);
  expect(whichPosix("codex", { PATH: "bin:/opt/a:/opt/b:/usr/bin" }, has)).toBe(
    "/opt/b/codex",
  );
  expect(whichPosix("claude", { PATH: "/opt/b" }, has)).toBe(undefined);
  expect(whichPosix("/usr/bin/codex", {}, has)).toBe("/usr/bin/codex");
});

test("a probe that never exits is stopped in time", async () => {
  const started = Date.now();
  const result = await runProbe(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 300 },
  );
  expect(result.timedOut).toBe(true);
  expect(result.code).toBe(null);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("a probe's stdin is closed, so a CLI waiting for input reads nothing and goes on", async () => {
  const result = await runProbe(
    process.execPath,
    ["-e", 'const t = await Bun.stdin.text(); console.log("got:" + t.length)'],
    { timeoutMs: 5000 },
  );
  expect(result).toMatchObject({ code: 0, timedOut: false });
  expect(result.stdout.trim()).toBe("got:0");
});

test("a probe of a missing command answers instead of throwing", async () => {
  const result = await runProbe(join(scratch, "no-such-cli"), ["--version"], {
    timeoutMs: 2000,
  });
  expect(result).toMatchObject({ code: null, timedOut: false });
});
