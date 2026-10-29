import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The production entry loads the full server before reaching role-writer readiness.
setDefaultTimeout(30_000);
const serverRoot = fileURLToPath(new URL("..", import.meta.url));

function envFileArgument(envPath: string): string {
  const relativePath = relative(serverRoot, envPath).split(sep).join("/");
  return `--env-file=${relativePath}`;
}

async function runProductionEntry(withRoleWriter: boolean) {
  let databaseConnections = 0;
  // Observe a real transport attempt, then close it. This is no PostgreSQL
  // protocol implementation and returns no role/UID facts or readiness success.
  const boundary = createServer((socket) => {
    databaseConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    boundary.once("error", reject);
    boundary.listen(0, "127.0.0.1", resolve);
  });
  const port = (boundary.address() as AddressInfo).port;
  let proofDir: string | undefined;
  try {
    proofDir = await mkdtemp(`${tmpdir()}${sep}openbot-loader-boundary-`);
    const envPath = `${proofDir}${sep}synthetic.env`;
    await writeFile(
      envPath,
      [
        `DATABASE_URL=postgres://application_fixture:synthetic@127.0.0.1:${port}/openbot`,
        ...(withRoleWriter
          ? [`ROLE_WRITER_DATABASE_URL=postgres://writer_fixture:synthetic@127.0.0.1:${port}/openbot`]
          : []),
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
      cmd: [process.execPath, envFileArgument(envPath), "src/production-entry.ts"],
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
      return { stdout, stderr, exitCode, databaseConnections };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      boundary.close((error) => (error ? reject(error) : resolve())),
    );
    if (proofDir) await rm(proofDir, { recursive: true, force: true });
  }
}

describe("production server loader boundary", () => {
  test("the production entry attempts the configured database transport before role-writer readiness refuses", async () => {
    const result = await runProductionEntry(true);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).not.toBe(0);
    expect(output).not.toContain("require() async module");
    expect(output).not.toContain("OPENBOT_SERVER_LOADER_SMOKE");
    expect(result.databaseConnections).toBeGreaterThan(0);
    expect(output).toContain("Startup or cleanup failed or is unconfirmed.");
    expect(output).not.toContain("Role writer initialization failed.");
    expect(output).not.toContain("ROLE_WRITER_DATABASE_URL is required");
    // Identity bootstrap must not overtake the earlier readiness boundary.
    expect(output).not.toContain("Failed query: insert into");
  });

  test("missing dedicated role-writer configuration refuses before any database connection", async () => {
    const result = await runProductionEntry(false);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).not.toBe(0);
    expect(output).not.toContain("require() async module");
    expect(output).not.toContain("OPENBOT_SERVER_LOADER_SMOKE");
    expect(output).toContain("ROLE_WRITER_DATABASE_URL is required");
    expect(result.databaseConnections).toBe(0);
    expect(output).not.toContain("Failed query: insert into");
  });
});
