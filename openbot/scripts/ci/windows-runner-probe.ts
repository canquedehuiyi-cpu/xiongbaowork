import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
import { createAppHost } from "../../runner/src/app-host.ts";
import { createAppRegistry } from "../../runner/src/apps.ts";

const root = process.argv[2];
if (!root || process.platform !== "win32")
  throw new Error("Pass the disposable Windows workspace.");
mkdirSync(root, { recursive: true });
const marker = join(root, "probe-started.txt");
if (existsSync(marker))
  throw new Error("Use a fresh disposable workspace for each run.");
writeFileSync(marker, "Windows runner acceptance\n", { flag: "wx" });
const execute = createRunnerExecutor(root);
const assert = (ok: unknown, label: string, seen?: unknown) => {
  // Say what came back, so a red probe names its cause instead of only its check.
  if (!ok)
    throw new Error(
      seen === undefined ? label : `${label}: ${JSON.stringify(seen)}`,
    );
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
  result,
);
const unicode = await execute({
  action: "exec",
  payload: { command: "Write-Output '熊宝员工'" },
});
assert(
  String(successfulOutput(unicode).stdout).includes("熊宝员工"),
  "Unicode output is preserved",
  unicode,
);
// Native programs print in the machine's OEM code page (GBK on a Chinese Windows). The console has to
// keep that code page for PowerShell to decode them, while PowerShell's own text still leaves as UTF-8.
const codePageOutcome = await execute({
  action: "exec",
  payload: { command: "[Console]::OutputEncoding.CodePage" },
});
const codePage = Number(
  String(successfulOutput(codePageOutcome).stdout).trim(),
);
assert(
  Number.isSafeInteger(codePage) && codePage !== 65001,
  "the console keeps the machine's own code page",
  codePageOutcome,
);
const inCodePage: Record<number, { bytes: number[]; text: string }> = {
  437: { bytes: [0x81], text: "ü" },
  850: { bytes: [0x81], text: "ü" },
  936: { bytes: [0xd0, 0xdc], text: "熊" },
};
const sample = inCodePage[codePage];
if (sample) {
  const nodeExe = (process.argv[3] ?? "node.exe").replace(/'/g, "''");
  const write = `process.stdout.write(Buffer.from([${sample.bytes.join(",")}]))`;
  for (const [label, command] of [
    ["captured", `(& '${nodeExe}' -e "${write}") -join ''`],
    ["direct", `& '${nodeExe}' -e "${write}"`],
  ] as const) {
    const native = await execute({ action: "exec", payload: { command } });
    assert(
      String(successfulOutput(native).stdout).includes(sample.text),
      `a native program's code-page output arrives as text (${label})`,
      native,
    );
  }
} else {
  console.log(
    JSON.stringify({ check: "native code-page output", skipped: codePage }),
  );
}
const progress = await execute({
  action: "exec",
  payload: {
    command:
      "$ProgressPreference = 'Continue'; Write-Progress -Activity 'probe' -Status 'step'; Write-Output 'after-progress'",
  },
});
assert(
  String(successfulOutput(progress).stdout).includes("after-progress") &&
    !String(successfulOutput(progress).stderr).includes("CLIXML"),
  "progress records never reach stderr as CLIXML",
  progress,
);
const failure = await execute({
  action: "exec",
  payload: { command: "Write-Error '熊宝错误'" },
});
assert(
  String(successfulOutput(failure).stderr).includes("熊宝错误") &&
    !String(successfulOutput(failure).stderr).includes("<Objs") &&
    successfulOutput(failure).exitCode !== 0,
  "an error reaches stderr as readable text",
  failure,
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
// How long the tree may take to start: a fresh PowerShell, then node, then node's child. A cold
// PowerShell start alone has taken 11-12 s on windows-latest (see the Unicode and secrets checks of
// a green run), so the old fixed 8 s wait failed a healthy runner. Each command's own timeout is
// longer than any start seen, and the wait below ends early if the command settles first.
const startMs = 20000;
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
            payload: { command, timeoutMs: startMs * 2 },
          },
          (frame) => {
            frameResult = frame;
          },
        )
      : secretShell.run({
          command,
          // The timeout case must not fire before the tree it is meant to kill has started.
          timeoutMs: mode === "timeout" ? startMs : startMs * 2,
          signal: controller.signal,
        });
  // A command that ends before writing its pid file will never write it: stop waiting and say
  // what it returned, instead of waiting out the deadline and naming only the check.
  let settled: { value: unknown } | undefined;
  const watched = running.then(
    (value) => {
      settled = { value };
      return value;
    },
    (error: unknown) => {
      settled = { value: String(error) };
      throw error;
    },
  );
  const begun = Date.now();
  while (!existsSync(pidFile) && !settled && Date.now() - begun < startMs * 2)
    await Bun.sleep(25);
  assert(
    existsSync(pidFile),
    mode + ": real child tree started",
    settled ?? { waitedMs: Date.now() - begun },
  );
  console.log(JSON.stringify({ mode, treeStartedMs: Date.now() - begun }));
  if (mode === "abort") controller.abort();
  if (mode === "protocol")
    await dispatch("local/device", { type: "cancel", key: mode }, () => {});
  const outcome = await watched;
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
// Local MCP apps (device MCP bridge): a stdio app started directly, and one started through a `.cmd`
// shim, which is how `npx` and `bunx` really start on Windows and so must go through cmd.exe.
const appsDir = join(root, "apps-data");
mkdirSync(appsDir, { recursive: true });
const fixture = resolve(
  import.meta.dir,
  "../../runner/tests/fixtures/fake-mcp-stdio.ts",
);
const shim = join(appsDir, "fake-mcp.cmd");
writeFileSync(shim, `@"${process.execPath}" "${fixture}" %*\r\n`);
const appRegistry = createAppRegistry({ dataDir: appsDir });
const direct = appRegistry.add({
  kind: "stdio",
  name: "direct",
  command: process.execPath,
  args: [fixture],
  env: {},
});
const shimmed = appRegistry.add({
  kind: "stdio",
  name: "shim",
  command: shim,
  args: [],
  env: {},
});
// The real `npx` case: a bare name found on PATH, whose shim finds its own script beside it through
// `%~dp0` (as npx.cmd finds node_modules\npm\bin\npx-cli.js), started from another folder. cmd.exe
// reads `%~dp0` as the current folder for a quoted name it looked up itself, so this only works when
// the runner hands cmd the shim's absolute path.
const pathBin = join(root, "path bin 熊宝");
mkdirSync(join(pathBin, "lib"), { recursive: true });
copyFileSync(fixture, join(pathBin, "lib", "fake-mcp-stdio.ts"));
writeFileSync(
  join(pathBin, "xb-probe-npx.cmd"),
  `@"${process.execPath}" "%~dp0lib\\fake-mcp-stdio.ts" %*\r\n`,
);
// The parent's own spelling, so the child gets one PATH variable, not `Path` and `PATH`.
const pathKey =
  Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
  "Path";
const onPath = appRegistry.add({
  kind: "stdio",
  name: "path shim",
  command: "xb-probe-npx",
  args: [],
  env: { [pathKey]: `${pathBin};${process.env[pathKey] ?? ""}` },
  cwd: appsDir,
});
const missing = appRegistry.add({
  kind: "stdio",
  name: "missing",
  command: "xb-probe-not-installed",
  args: [],
  env: {},
});
const appExecute = createRunnerExecutor(
  root,
  undefined,
  undefined,
  undefined,
  createAppHost(appRegistry),
);
const notFound = await appExecute({
  action: "apps.tools",
  payload: { app: missing.ref },
});
assert(
  !notFound.ok &&
    notFound.error.includes("找不到命令 xb-probe-not-installed") &&
    !notFound.outcomeUnknown,
  "a command not on PATH fails to start with a clear reason",
  notFound,
);
for (const [label, entry] of [
  ["direct", direct],
  ["cmd shim", shimmed],
  ["cmd shim found on PATH, %~dp0 from another folder", onPath],
] as const) {
  const tools = await appExecute({
    action: "apps.tools",
    payload: { app: entry.ref },
  });
  assert(
    (
      successfulOutput(tools).tools as { name: string }[]
    )
      .map((tool) => tool.name)
      .join(",") === "echo,write_note,wipe",
    `apps.tools lists the fake server's tools (${label})`,
    tools,
  );
}
const echoed = await appExecute({
  action: "apps.call",
  payload: { app: direct.ref, tool: "echo", args: { text: "熊宝-echo" } },
});
assert(
  JSON.stringify(successfulOutput(echoed)).includes("熊宝-echo"),
  "apps.call echo returns the text",
  echoed,
);
await appExecute.closeApps();
console.log("WINDOWS_PROBE_PASS");
