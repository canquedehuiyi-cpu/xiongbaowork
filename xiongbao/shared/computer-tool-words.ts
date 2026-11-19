/**
 * What the model is told about where the computer tools act.
 *
 * The unattended run (`server/src/computer/headless-tools.ts`) and the web chat
 * (`app/src/lib/copilot/computer-tools.tsx`) both offer the shell and file tools, and the model reads
 * the description and nothing else about where a command lands. In device mode (`TENANT_RUNTIME=device`)
 * it lands on the person's own paired machine, which may run Windows; told "bash in your workspace,
 * use sudo apt-get", a 分身 on the first real paired Windows machine (2026-11-06) believed it was on
 * Linux. One copy here, so the two surfaces cannot drift.
 */

export type ComputerMachine = "workspace" | "device";

/** Where the file tools and the shell act, as a phrase that fits after "in". */
export function computerToolPlace(machine: ComputerMachine): string {
  return machine === "device"
    ? "your workspace folder on the person's own paired machine (not a container of yours)"
    : "your workspace";
}

/** The shell tool's description on a paired machine. */
export const DEVICE_RUN_COMMAND_DESCRIPTION = `Run a shell command on the person's own paired machine, in ${computerToolPlace("device")}: this is how you act on their computer when they ask. The machine may run Windows (PowerShell), macOS or Linux, so write the command for that system. Long output is truncated and long commands are stopped. A command that deletes recursively, formats a drive or names a file that may hold secrets waits for the person's approval; if refused say so rather than retrying.`;

/** The unattended run's shell description in a cloud container. */
export const WORKSPACE_RUN_COMMAND_DESCRIPTION =
  "Run a bash shell command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. Use the tools already installed first; if you need a new one, prefer installing it inside your workspace with npm install (without -g), bun add, or python3 -m venv .venv and then .venv/bin/pip install. If you are told you have no sudo permission, do not try to escalate; say so rather than retrying.";

/**
 * How long one command may run, in milliseconds (期五). The model may ask for up to the ceiling with
 * `timeoutMs`; more is cut to the ceiling rather than refused, and nothing asked is the default. The
 * same bounds the computer itself applies (`agent-computer/src/shell.ts`), so what the tool promises
 * is what the shell does.
 */
export const COMMAND_TIMEOUT_MS = {
  default: 120_000,
  min: 1_000,
  max: 600_000,
} as const;

/** The `timeoutMs` a command is sent with: the default when none was asked, else within the bounds. */
export function commandTimeoutMs(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested))
    return COMMAND_TIMEOUT_MS.default;
  return Math.min(
    Math.max(Math.round(requested), COMMAND_TIMEOUT_MS.min),
    COMMAND_TIMEOUT_MS.max,
  );
}

/** What the model is told about `timeoutMs`, on both surfaces. */
export const COMMAND_TIMEOUT_DESCRIPTION =
  "Optional. How long the command may run, in milliseconds. Defaults to 120000 (2 minutes); at most 600000 (10 minutes), and a larger value is cut to that. Ask for more for a long build, install or test run.";
