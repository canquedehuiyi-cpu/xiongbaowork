/*
 * A stand-in for the agent-desktop CLI. Run with `bun`. It serves the real samples measured on CI
 * (tests/fixtures/agent-desktop/<platform>.json and errors.json).
 *
 * FAKE_AD_SCRIPT is JSON: { platform?: "linux" | "macos" | "windows" (default linux),
 *   commands?: { "<command>": { sample?: "<key in the platform file>", error?: "<key in errors.json>",
 *     envelope?: <any JSON, answered as is>, raw?: "<text, answered as is>", exitCode?: number,
 *     delayMs?: number, spawnChild?: true } } }.
 * `version` answers the platform's own `version` sample unless the script says otherwise; a command
 * with no entry answers `{"version":"2.6","ok":true,"command":"<cmd>","data":{}}`.
 *
 * FAKE_AD_LOG (when set) gets one JSON line per start: { args, stdin (base64, read only when the
 * arguments carry --stdin), env (the AGENT_DESKTOP_* and FAKE_AD_* variables), startedAt, pid,
 * childPid? }. The command is the first argument that is not --headed.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const script = JSON.parse(process.env.FAKE_AD_SCRIPT ?? "{}");
const platform: string = script.platform ?? "linux";
const command = args.find((a) => a !== "--headed") ?? "";
const entry = script.commands?.[command] ?? {};
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
if (entry.spawnChild) {
  const child = spawn("bun", ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  childPid = child.pid;
}

if (process.env.FAKE_AD_LOG) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      (k.startsWith("AGENT_DESKTOP_") || k.startsWith("FAKE_AD_")) &&
      v !== undefined
    )
      env[k] = v;
  appendFileSync(
    process.env.FAKE_AD_LOG,
    `${JSON.stringify({ args, stdin, env, startedAt, pid: process.pid, childPid })}\n`,
  );
}

if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));

let out: string;
let exitCode: number = entry.exitCode ?? 0;
if (entry.raw !== undefined) out = entry.raw;
else if (entry.envelope !== undefined) out = JSON.stringify(entry.envelope);
else if (entry.error !== undefined) {
  out = JSON.stringify(errors()[entry.error]);
  if (entry.exitCode === undefined) exitCode = 1;
} else if (entry.sample !== undefined || command === "version")
  out = JSON.stringify(samples()[entry.sample ?? "version"]);
else out = JSON.stringify({ version: "2.6", ok: true, command, data: {} });

process.stdout.write(`${out}\n`);
process.exit(exitCode);
