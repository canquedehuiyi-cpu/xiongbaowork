import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CredentialLockUnavailable,
  lockProviderCredentials,
} from "../../src/provider-oauth-lock";

// Runs the exact production Bun and Rust lock helpers in both directions.
const native = process.argv[2];
if (!native) throw new Error("Native lock-owner executable is required.");
const root = await mkdtemp(join(tmpdir(), "openbot-cross-writer-"));
const file = join(root, "model-oauth.json");
const children: ReturnType<typeof holder>[] = [];
function holder(command: string[]) {
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let acquired = false;
  // Both owners say `waiting` right before their attempt and `locked` once they hold the lock.
  // `waiting` has its own, longer bound: a cold start is not a held lock.
  let markWaiting: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  const ready = (async () => {
    const reader = child.stdout.getReader();
    let timeout = setTimeout(() => child.kill(), 60000);
    let sawWaiting = false;
    try {
      let output = "";
      for (;;) {
        const lines = output.split("\n").slice(0, -1).map((line) => line.trim());
        if (lines[0] !== undefined && lines[0] !== "waiting")
          throw new Error(`Unexpected readiness: ${output}`);
        if (lines.length >= 1 && !sawWaiting) {
          sawWaiting = true;
          markWaiting();
          clearTimeout(timeout);
          timeout = setTimeout(() => child.kill(), 15000);
        }
        if (lines.length >= 2) {
          if (lines[1] !== "locked" || lines.length > 2)
            throw new Error(`Unexpected readiness: ${output}`);
          break;
        }
        const { done, value } = await reader.read();
        if (done)
          throw new Error(
            `Lock owner exited: ${await new Response(child.stderr).text()}`,
          );
        output += new TextDecoder().decode(value);
      }
      acquired = true;
    } finally {
      reader.releaseLock();
      clearTimeout(timeout);
    }
  })();
  // An owner that fails before `waiting` rejects this too, rather than leaving it pending.
  return {
    child,
    ready,
    waiting: Promise.race([waiting, ready]),
    acquired: () => acquired,
  };
}
try {
  const nativeFirst = holder([native, file]);
  children.push(nativeFirst);
  await nativeFirst.ready;
  const started = performance.now();
  try {
    const unexpectedRelease = await lockProviderCredentials(file);
    await unexpectedRelease();
    throw new Error("Bun entered a live native lock.");
  } catch (error) {
    if (!(error instanceof CredentialLockUnavailable)) throw error;
  }
  const blockedMs = performance.now() - started;
  if (blockedMs < 4900)
    throw new Error(
      `Lock failure preceded the acquisition timeout: ${blockedMs}ms`,
    );
  if (nativeFirst.child.exitCode !== null)
    throw new Error(
      "Native owner exited before the blocked attempt completed.",
    );
  nativeFirst.child.kill("SIGKILL");
  await nativeFirst.child.exited;
  const release = await lockProviderCredentials(file);
  await release();
  console.log(
    `PASS native owner excludes Bun for the full timeout (${Math.round(blockedMs)}ms); killing native permits Bun acquisition`,
  );

  const bunFirst = holder([
    process.execPath,
    fileURLToPath(new URL("./provider-oauth-lock-owner.ts", import.meta.url)),
    file,
  ]);
  children.push(bunFirst);
  await bunFirst.ready;
  const pendingNative = holder([native, file]);
  children.push(pendingNative);
  await pendingNative.waiting;
  await Bun.sleep(200);
  if (pendingNative.acquired())
    throw new Error("Native entered a live Bun lock.");
  bunFirst.child.kill("SIGKILL");
  await bunFirst.child.exited;
  await pendingNative.ready;
  pendingNative.child.stdin.end();
  if ((await pendingNative.child.exited) !== 0)
    throw new Error("Native release failed.");
  console.log(
    "PASS Bun owner excludes native; killing Bun releases its PowerShell/OS handle",
  );
} finally {
  for (const { child } of children) {
    child.kill();
    await child.exited;
  }
  await rm(root, { recursive: true, force: true });
}
