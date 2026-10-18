import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createRunnerExecutor,
  type ActionOutcome,
} from "../../runner/src/execute.ts";
import {
  createShell,
  type ShellResult,
} from "../../agent-computer/src/shell.ts";
import { createActionJournal } from "../../runner/src/journal.ts";
import { createRunnerDispatcher } from "../../runner/src/dispatch.ts";

const root = process.argv[2];
if (!root || process.platform !== "win32")
  throw new Error("Pass the disposable Windows workspace.");
mkdirSync(root, { recursive: true });
const marker = join(root, "probe-started.txt");
if (existsSync(marker))
  throw new Error("Use a fresh disposable workspace for each run.");
writeFileSync(marker, "Windows runner acceptance\n", { flag: "wx" });
const execute = createRunnerExecutor(root);
const assert = (ok: unknown, label: string) => {
  if (!ok) throw new Error(label);
  console.log(JSON.stringify({ check: label, passed: true }));
};
const successfulOutput = (outcome: ActionOutcome): Record<string, unknown> => {
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.output as Record<string, unknown>;
};
console.log(
  JSON.stringify({ runtime: "Bun " + Bun.version, platform: process.platform }),
);
const result = await execute({
  action: "exec",
  payload: { command: "echo runner-marker" },
});
assert(
  String(successfulOutput(result).stdout).includes("runner-marker") &&
    successfulOutput(result).exitCode === 0,
  "native command produces the marker",
);
const unicode = await execute({
  action: "exec",
  payload: { command: "Write-Output '熊宝员工'" },
});
assert(
  String(successfulOutput(unicode).stdout).includes("熊宝员工"),
  "Unicode output is preserved",
);
const code = await execute({ action: "exec", payload: { command: "exit 7" } });
assert(successfulOutput(code).exitCode === 7, "nonzero exit code is preserved");
assert(
  (
    await execute({
      action: "files.write",
      payload: { path: "native.txt", contents: "native-data" },
    })
  ).ok,
  "workspace write succeeds",
);
const read = await execute({
  action: "files.read",
  payload: { path: "native.txt" },
});
assert(
  successfulOutput(read).text === "native-data",
  "workspace read succeeds",
);
assert(
  !(
    await execute({
      action: "files.write",
      payload: { path: "../escape.txt", contents: "refuse" },
    })
  ).ok,
  "traversal is refused",
);
const secretShell = createShell(root, {
  ...process.env,
  KEY_ENCRYPTION_KEY: "synthetic-sentinel",
});
const secret = await secretShell.run({
  command: "Write-Output ('secret-present=' + [bool]$env:KEY_ENCRYPTION_KEY)",
});
assert(
  secret.stdout.includes("secret-present=False") &&
    !secret.stdout.includes("synthetic-sentinel"),
  "parent secrets are absent",
);
const unavailable = createShell(root, {
  ...process.env,
  SystemRoot: join(root, "no-windows-shell"),
});
await unavailable.run({ command: "echo no-shell" }).then(
  () => assert(false, "start failure must refuse"),
  (error) =>
    assert(
      String(error.message).includes("could not start"),
      "startup error is explicit",
    ),
);
const nodePath = process.argv[3] ?? "node.exe";
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
for (const mode of ["abort", "timeout", "protocol"]) {
  const parentFile = join(root, mode + "-parent.mjs");
  const childFile = join(root, mode + "-child.mjs");
  const pidFile = join(root, mode + "-pids.json");
  writeFileSync(childFile, "setInterval(() => {}, 100);");
  writeFileSync(
    parentFile,
    "import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,[" +
      JSON.stringify(childFile) +
      "],{stdio:'ignore',windowsHide:true}); writeFileSync(" +
      JSON.stringify(pidFile) +
      ",JSON.stringify([process.pid,child.pid])); setInterval(()=>{},100);",
  );
  const command = "& " + psQuote(nodePath) + " " + psQuote(parentFile);
  const controller = new AbortController();
  let frameResult: Record<string, unknown> | undefined;
  const journal = createActionJournal(join(root, mode + "-actions.sqlite"));
  const dispatch = createRunnerDispatcher(journal, execute);
  const running =
    mode === "protocol"
      ? dispatch(
          "local/device",
          {
            type: "action",
            id: mode,
            key: mode,
            action: "exec",
            payload: { command, timeoutMs: 20000 },
          },
          (frame) => {
            frameResult = frame;
          },
        )
      : secretShell.run({
          command,
          timeoutMs: mode === "timeout" ? 2000 : 20000,
          signal: controller.signal,
        });
  const deadline = Date.now() + 8000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(25);
  assert(existsSync(pidFile), mode + ": real child tree started");
  if (mode === "abort") controller.abort();
  if (mode === "protocol")
    await dispatch("local/device", { type: "cancel", key: mode }, () => {});
  const outcome = await running;
  if (mode === "timeout")
    assert((outcome as ShellResult).timedOut === true, "timeout is reported");
  if (mode === "abort")
    assert(
      (outcome as ShellResult).stopped === true &&
        !(outcome as ShellResult).timedOut,
      "Stop is reported separately from timeout",
    );
  if (mode === "protocol")
    assert(
      frameResult?.ok === false &&
        String(frameResult.error).includes("stopped"),
      "socket cancellation reaches the executor",
    );
  journal.close();
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
  for (const pid of pids) {
    assert(Number.isSafeInteger(pid) && pid > 0, "owned process id is valid");
    const alive = spawnSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if (Get-Process -Id " +
          pid +
          " -ErrorAction SilentlyContinue) { exit 1 }; exit 0",
      ],
      { windowsHide: true },
    );
    assert(alive.status === 0, mode + ": descendant " + pid + " is gone");
  }
}
console.log("WINDOWS_PROBE_PASS");
