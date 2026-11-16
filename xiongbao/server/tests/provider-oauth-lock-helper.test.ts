import { expect, test } from "bun:test";
import { holdLockHelper, LOCK_HELPER_TIMING } from "../src/provider-oauth-lock";

/*
 * The Windows credential lock is held by a PowerShell helper (src/provider-oauth-lock.ts). Its
 * protocol is driven here by stand-in helpers, so it runs on any platform: `ready` once started,
 * `locked` once it holds the handle, then it waits for stdin to close. The real helper runs on the
 * windows-latest job through the desktop cross-writer test.
 */
function helper(script: string) {
  return Bun.spawn([process.execPath, "-e", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
}

const holds = (startDelayMs: number, lockDelayMs: number) =>
  helper(`
    await Bun.sleep(${startDelayMs});
    console.log("ready");
    await Bun.sleep(${lockDelayMs});
    console.log("locked");
    await Bun.stdin.text();
  `);

test("production keeps a long startup bound and the lock bound from ready", () => {
  expect(LOCK_HELPER_TIMING).toEqual({ startupMs: 60_000, lockMs: 15_000 });
});

test("a slow start does not spend the lock's time: the lock bound counts from ready", async () => {
  // Starting takes longer than the whole lock bound, as PowerShell plus Add-Type can on a cold machine.
  const child = holds(600, 0);
  const release = await holdLockHelper(child, {
    startupMs: 5_000,
    lockMs: 300,
  });
  expect(child.exitCode).toBeNull();
  await release();
  expect(await child.exited).toBe(0);
});

test("a helper that never becomes ready is stopped and says so", async () => {
  const child = helper("await Bun.sleep(60_000);");
  const started = performance.now();
  await expect(
    holdLockHelper(child, { startupMs: 300, lockMs: 5_000 }),
  ).rejects.toThrow("The credential lock helper did not start within 300 ms.");
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(child.killed).toBe(true);
  expect(child.signalCode).not.toBeNull();
});

test("a helper that is ready but cannot lock in time is stopped", async () => {
  const child = holds(0, 60_000);
  await expect(
    holdLockHelper(child, { startupMs: 5_000, lockMs: 300 }),
  ).rejects.toThrow("Could not acquire credential lock within 300 ms.");
  expect(child.killed).toBe(true);
});

test("a helper that gives up on a held lock is a refusal", async () => {
  // As the PowerShell helper does after 5 s of a sharing violation: exit 1 without `locked`.
  const child = helper('console.log("ready"); process.exit(1);');
  await expect(holdLockHelper(child)).rejects.toThrow(
    "Could not acquire credential lock.",
  );
});

test("anything but ready, then locked, is refused and the helper stopped", async () => {
  for (const script of [
    'console.log("locked"); await Bun.stdin.text();',
    'console.log("ready"); console.log("maybe"); await Bun.stdin.text();',
  ]) {
    const child = helper(script);
    await expect(holdLockHelper(child)).rejects.toThrow(
      "Invalid credential lock response.",
    );
    expect(child.killed).toBe(true);
  }
});

test("a release the helper does not confirm is an error", async () => {
  const child = helper(
    'console.log("ready"); console.log("locked"); await Bun.stdin.text(); process.exit(3);',
  );
  const release = await holdLockHelper(child);
  await expect(release()).rejects.toThrow("Could not release credential lock.");
});
