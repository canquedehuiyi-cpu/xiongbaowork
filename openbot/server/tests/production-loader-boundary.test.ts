import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The budget this case actually needs, said out loud instead of left at the default.
 *
 * It boots the production entry as a child process and waits for it to reach the database boundary, so
 * what is being timed is Bun loading the whole server — measured at ~4.2s on this machine against bun's
 * 5s default. On the default it goes red whenever the host is busy and green when it is idle, which
 * measures the laptop rather than the code, and a red that comes and goes is how a real boundary failure
 * gets ignored. 30s keeps the only failure this file exists to catch — an entry that never reaches the
 * boundary — observable, without borrowing the machine's mood as a signal.
 */
setDefaultTimeout(30_000);

const serverRoot = fileURLToPath(new URL("..", import.meta.url));

function envFileArgument(envPath: string): string {
  const relativePath = relative(serverRoot, envPath).split(sep).join("/");
  return `--env-file=${relativePath}`;
}

async function runProductionEntry() {
  const proofDir = await mkdtemp(`${tmpdir()}${sep}openbot-loader-boundary-`);
  const envPath = `${proofDir}${sep}synthetic.env`;
  await writeFile(
    envPath,
    [
      "DATABASE_URL=postgres://openbot:openbot@127.0.0.1:1/openbot",
      "KEY_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "OPENBOT_SINGLE_USER=true",
      "MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:4200/ag-ui",
      "MANAGED_AGENT_TOKEN=synthetic-managed-token",
      "COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4300",
      "SUPERVISOR_TOKEN=synthetic-supervisor-token",
      "COMPUTER_TOKEN=synthetic-computer-token",
      "WORKER_SHARED_SECRET=synthetic-worker-secret",
      "AGENT_TOOL_TOKEN=synthetic-tool-token",
      "INTELLIGENCE_API_URL=http://127.0.0.1:59991",
      "INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:59992",
      "INTELLIGENCE_API_KEY=synthetic-intelligence-key",
      "TENANT_PACKAGE_DIR=../examples/fintech",
      "PORT=39999",
      "",
    ].join("\n"),
  );

  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      envFileArgument(envPath),
      "src/production-entry.ts",
    ],
    cwd: serverRoot,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot ?? "",
            WINDIR: process.env.WINDIR ?? "",
            TEMP: process.env.TEMP ?? "",
            TMP: process.env.TMP ?? "",
          }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
    await rm(proofDir, { recursive: true, force: true });
  }
}

describe("production server loader boundary", () => {
  test("the production-used server entry reaches the configured database boundary after preloading EventSource", async () => {
    const result = await runProductionEntry();
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).not.toContain("require() async module");
    expect(output).not.toContain("OPENBOT_SERVER_LOADER_SMOKE");
    expect(output).toContain("Failed query: insert into");
    expect(output).toMatch(
      /Connection closed|Failed to connect|ERR_POSTGRES_CONNECTION_REFUSED/,
    );
  });
});
