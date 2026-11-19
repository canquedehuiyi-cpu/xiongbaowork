/*
 * A stand-in for the agent-desktop CLI. Run with `bun`. It serves the real samples measured on CI
 * (tests/fixtures/agent-desktop/<platform>.json and errors.json).
 *
 * FAKE_AD_SCRIPT is JSON: { platform?: "linux" | "macos" | "windows" (default linux),
 *   commands?: { "<command>": { sample?: "<key in the platform file>", error?: "<key in errors.json>",
 *     envelope?: <any JSON, answered as is>, raw?: "<text, answered as is>", exitCode?: number,
 *     write?: { delivery: string, error?: string },
 *     delayMs?: number, spawnChild?: true, holdPipe?: true } } }.
 * A command run with --headed first looks for an entry named "--headed <command>", then "<command>".
 * `holdPipe` leaves a grandchild holding this process's stdout open after it exits.
 * `write` answers a write action's envelope: with `error`, an `ok:false` envelope with that code and
 * `disposition.delivery`; without, an `ok:true` one whose disposition carries that `delivery`.
 * A write command (click, type, set-value, clear, press) with no entry answers success,
 * `delivered_verified`, the shape measured on CI; `focus-window` answers `{ focused: { is_focused } }`.
 * `version` answers the platform's own `version` sample unless the script says otherwise; any other
 * command with no entry answers `{"version":"2.6","ok":true,"command":"<cmd>","data":{}}`.
 *
 * FAKE_AD_LOG (when set) gets one JSON line per start: { args, stdin (base64, read only when the
 * arguments carry --stdin), env (the AGENT_DESKTOP_* and FAKE_AD_* variables), startedAt, pid,
 * childPid? }. The command is the first argument that is not --headed.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const script = JSON.parse(process.env.FAKE_AD_SCRIPT ?? "{}");
const platform: string = script.platform ?? "linux";
const command = args.find((a) => a !== "--headed") ?? "";
const headed = args.includes("--headed");
const entry =
  (headed ? script.commands?.[`--headed ${command}`] : undefined) ??
  script.commands?.[command] ??
  {};
const startedAt = Date.now();

const dir = join(import.meta.dir, "agent-desktop");
const samples = () =>
  JSON.parse(readFileSync(join(dir, `${platform}.json`), "utf8"));
const errors = () => JSON.parse(readFileSync(join(dir, "errors.json"), "utf8"));

let stdin: string | undefined;
if (args.includes("--stdin")) {
  stdin = Buffer.from(await Bun.stdin.arrayBuffer()).toString("base64");
}

let childPid: number | undefined;
if (entry.holdPipe) {
  const child = spawn("bun", ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "inherit", "ignore"],
  });
  childPid = child.pid;
  child.unref();
}
if (entry.spawnChild) {
  const child = spawn("bun", ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  childPid = child.pid;
}

/** Running, not merely an unreaped zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

if (process.env.FAKE_AD_LOG) {
  // Which earlier fakes (and their children) are still running as this one starts.
  const prevAlive: number[] = [];
  // Another fake may still be appending its line: read only lines that already end in a newline.
  const logText = existsSync(process.env.FAKE_AD_LOG)
    ? readFileSync(process.env.FAKE_AD_LOG, "utf8")
    : "";
  if (logText)
    for (const line of logText
      .slice(0, logText.lastIndexOf("\n") + 1)
      .split("\n")) {
      if (!line) continue;
      const earlier = JSON.parse(line);
      for (const pid of [earlier.pid, earlier.childPid])
        if (typeof pid === "number" && alive(pid)) prevAlive.push(pid);
    }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      (k.startsWith("AGENT_DESKTOP_") || k.startsWith("FAKE_AD_")) &&
      v !== undefined
    )
      env[k] = v;
  appendFileSync(
    process.env.FAKE_AD_LOG,
    `${JSON.stringify({ args, stdin, env, startedAt, pid: process.pid, childPid, prevAlive })}\n`,
  );
}

if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));

const WRITE_COMMANDS = new Set([
  "click",
  "type",
  "set-value",
  "clear",
  "press",
]);

/** A write action's envelope (FACTS.md, "写动作成功信封"). */
function writeEnvelope(delivery: string, code?: string): unknown {
  const disposition = {
    delivery,
    retry: delivery === "not_delivered" ? "safe" : "unsafe",
  };
  if (code !== undefined)
    return {
      version: "2.6",
      ok: false,
      command,
      error: { code, message: `${code} (scripted)`, disposition },
    };
  return {
    version: "2.6",
    ok: true,
    command,
    data: {
      action: command,
      details: {
        verification_scope: "element_value",
        application_commit: "not_verified",
      },
      disposition,
      post_state: {},
      steps: [],
    },
  };
}

let out: string;
let exitCode: number = entry.exitCode ?? 0;
if (entry.raw !== undefined) out = entry.raw;
else if (entry.write !== undefined) {
  out = JSON.stringify(writeEnvelope(entry.write.delivery, entry.write.error));
  if (entry.write.error !== undefined && entry.exitCode === undefined)
    exitCode = 1;
} else if (entry.envelope !== undefined) out = JSON.stringify(entry.envelope);
else if (entry.error !== undefined) {
  out = JSON.stringify(errors()[entry.error]);
  if (entry.exitCode === undefined) exitCode = 1;
} else if (entry.sample !== undefined || command === "version")
  out = JSON.stringify(samples()[entry.sample ?? "version"]);
else if (WRITE_COMMANDS.has(command))
  out = JSON.stringify(writeEnvelope("delivered_verified"));
else if (command === "focus-window")
  out = JSON.stringify({
    version: "2.6",
    ok: true,
    command,
    data: {
      focused: { id: args[args.indexOf("--window-id") + 1], is_focused: true },
    },
  });
else out = JSON.stringify({ version: "2.6", ok: true, command, data: {} });

process.stdout.write(`${out}\n`);
process.exit(exitCode);
