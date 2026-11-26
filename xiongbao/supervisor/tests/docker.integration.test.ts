import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

// Root tests can load names.ts before this file. A fresh process is necessary for the supervisor's
// import-time namespace, and prevents these Dockerode tests from sharing a deployment's resources.
const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
async function available() {
  if (!existsSync(socket)) return false;
  try {
    const { default: Docker } = await import("dockerode");
    await new Docker({ socketPath: socket }).ping();
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!(await available()))(
  "supervisor Docker lifecycle in an isolated namespace (nineteen cases)",
  async () => {
    const namespace = `supervisor-test-${crypto.randomUUID()}`;
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        `${import.meta.dir}/fixtures/docker-lifecycle.ts`,
      ],
      {
        env: {
          ...process.env,
          DOCKER_SOCKET: socket,
          COMPUTER_NAMESPACE: namespace,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) console.error(stdout, stderr);
    expect(status).toBe(0);
    const prefix = "SUPERVISOR_FIXTURE ";
    const summaryLine = stdout
      .split("\n")
      .find((line) => line.startsWith(prefix));
    if (!summaryLine)
      throw new Error(`Missing fixture result: ${stdout} ${stderr}`);
    const summary = JSON.parse(summaryLine.slice(prefix.length));
    expect(summary.completedCases).toBe(19);
    expect(summary.cleanup).toBe("complete");
    // Do not echo nested Bun summaries: scripts/test-ci.ts counts the outer suite's summary.
    console.log(summaryLine);
    console.log(
      `Supervisor Docker cases: ${JSON.stringify(stderr.split("\n").filter((line) => line.startsWith("(pass)") || line.includes("expect() calls")))}`,
    );
  },
  630_000,
);

/**
 * Whether this host holds anything under either default namespace, which the namespace fixture would count. A
 * developer's machine running a real stack does; the fixture is then skipped rather than reading their computers.
 */
async function hostHasDefaultNamespaceComputers(): Promise<boolean> {
  const { default: Docker } = await import("dockerode");
  const { legacyLabel, namespaceForHost, OWNER_LABEL } = await import(
    "../src/names"
  );
  const docker = new Docker({ socketPath: socket });
  const labelled: (Record<string, string> | undefined)[] = [];
  for (const owner of [OWNER_LABEL, legacyLabel(OWNER_LABEL)]) {
    const filters = { label: [`${owner}=true`] };
    for (const container of await docker.listContainers({ all: true, filters }))
      labelled.push(container.Labels);
    for (const volume of (await docker.listVolumes({ filters })).Volumes ?? [])
      labelled.push(volume.Labels ?? undefined);
  }
  const { earlier, current } = namespaceForHost(labelled);
  return earlier + current > 0;
}

/*
 * A deployment that sets no COMPUTER_NAMESPACE settles it from the host, so a host upgraded from before v0.2.16 keeps
 * its computers and their volumes.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
test.skipIf(!(await available()) || (await hostHasDefaultNamespaceComputers()))(
  "the namespace of a deployment that sets none follows the host (three cases)",
  async () => {
    const { COMPUTER_NAMESPACE: _unset, ...environment } = process.env;
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        `${import.meta.dir}/fixtures/namespace-default.ts`,
      ],
      {
        env: { ...environment, DOCKER_SOCKET: socket },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) console.error(stdout, stderr);
    expect(status).toBe(0);
    const prefix = "NAMESPACE_FIXTURE ";
    const summaryLine = stdout
      .split("\n")
      .find((line) => line.startsWith(prefix));
    if (!summaryLine)
      throw new Error(`Missing fixture result: ${stdout} ${stderr}`);
    const summary = JSON.parse(summaryLine.slice(prefix.length));
    expect(summary.completedCases).toBe(3);
    expect(summary.cleanup).toBe("complete");
  },
  120_000,
);
