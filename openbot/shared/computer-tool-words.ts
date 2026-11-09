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
  "Run a bash shell command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. Use the tools already installed first; if you need a new one, install it inside your workspace with npm install (without -g) or bun add. Do not use sudo: you cannot install system packages, so if a task needs one, say so rather than retrying.";
