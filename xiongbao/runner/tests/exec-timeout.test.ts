import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerExecutor } from "../src/execute";
import { createRootRegistry } from "../src/roots";

/*
 * 期五 B1: the `timeoutMs` a command frame carries reaches the shell on this machine, in the workspace
 * and in a project's folder alike; without one the shell's own two minutes apply.
 */

const scratch = mkdtempSync(join(tmpdir(), "runner-exec-timeout-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type ShellOutput = { timedOut: boolean; exitCode: number; elapsedMs: number };

function executor() {
  const dataDir = join(scratch, `data-${Math.random().toString(36).slice(2)}`);
  const workspace = join(dataDir, "runner-workspace");
  const project = join(dataDir, "..", `project-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(project, { recursive: true });
  const registry = createRootRegistry({ dataDir, privatePaths: [dataDir] });
  const root = registry.add("项目", project, "write");
  return {
    execute: createRunnerExecutor(workspace, undefined, registry),
    root,
  };
}

test.skipIf(process.platform === "win32")(
  "a command given one second is stopped at one second, in the workspace and in a project",
  async () => {
    const { execute, root } = executor();
    for (const payload of [
      { command: "sleep 5", timeoutMs: 1_000 },
      { command: "sleep 5", timeoutMs: 1_000, root: root.ref, writable: true },
    ]) {
      const outcome = await execute({ action: "exec", payload });
      expect(outcome.ok).toBe(true);
      const output = (outcome as { output: ShellOutput }).output;
      expect(output.timedOut).toBe(true);
      expect(output.elapsedMs).toBeLessThan(4_500);
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "a command with no timeoutMs runs under the default and finishes",
  async () => {
    const { execute } = executor();
    const outcome = await execute({
      action: "exec",
      payload: { command: "sleep 1.2 && echo done" },
    });
    const output = (outcome as { output: ShellOutput & { stdout: string } })
      .output;
    expect(output.timedOut).toBe(false);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("done");
  },
  15_000,
);
