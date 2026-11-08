import { spawn } from "node:child_process";

/**
 * The programs installed on this Windows machine, by name (app discovery, spec §2.3): to match the
 * built-in catalog against, and to tell the employee which software has no MCP of its own.
 *
 * WHY POWERSHELL AND NOT reg.exe. `reg query` prints in the OEM code page (GBK on a Chinese system),
 * so a name such as 微信 would reach the model as mojibake. PowerShell is told to write UTF-8 and
 * hands back JSON, which keeps every name exactly as the registry holds it.
 *
 * ONLY NAMES LEAVE. The keys also hold install folders and uninstall command lines; the script
 * selects four fields, and only `DisplayName` survives `installedNames`.
 */

export type UninstallEntry = {
  DisplayName?: unknown;
  SystemComponent?: unknown;
  ParentKeyName?: unknown;
  ReleaseType?: unknown;
};

/** Enough to recognise what is there without filling the employee's context. */
export const INSTALLED_LIMIT = 200;

const UNINSTALL_KEYS = [
  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
];

/**
 * The 64-bit and 32-bit machine-wide views and the owner's own installs, as compact UTF-8 JSON.
 *
 * `-ErrorAction SilentlyContinue` hides a non-terminating error (an installer that wrote a malformed
 * value: "Specified cast is not valid") but still leaves `$?` false, and `-Command` exits with the
 * last pipeline's `$?`: one bad key would fail a run that printed the whole list. Hence `exit 0`;
 * a run that really failed prints no JSON, which reads as [] all the same.
 */
export const UNINSTALL_SCRIPT: string = [
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  `Get-ItemProperty -Path ${UNINSTALL_KEYS.map((key) => `'${key}'`).join(", ")} -ErrorAction SilentlyContinue | Select-Object DisplayName, SystemComponent, ParentKeyName, ReleaseType | ConvertTo-Json -Compress`,
  "exit 0",
].join("; ");

const TIMEOUT_MS = 15_000;
/** Far more than any machine's list; a runaway output is cut rather than held. */
const OUTPUT_LIMIT = 8 * 1024 * 1024;

const UPDATE_RELEASE_TYPES = new Set([
  "Update",
  "Hotfix",
  "Security Update",
  "Update Rollup",
]);
const KB_NUMBER = /\bKB\d{6,8}\b/i;

/** The names worth showing: no system components, child entries or patches; deduped, sorted, capped. */
export function installedNames(entries: UninstallEntry[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry?.DisplayName !== "string") continue;
    const name = entry.DisplayName.trim();
    if (!name) continue;
    if (entry.SystemComponent === 1) continue;
    if (typeof entry.ParentKeyName === "string" && entry.ParentKeyName.trim())
      continue;
    if (KB_NUMBER.test(name)) continue;
    if (
      typeof entry.ReleaseType === "string" &&
      UPDATE_RELEASE_TYPES.has(entry.ReleaseType)
    )
      continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .slice(0, INSTALLED_LIMIT);
}

type Run = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>;

/** A hidden child, killed at the timeout (which leaves it without an exit code). */
const runHidden: Run = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
      });
    } catch {
      resolve({ code: null, stdout: "" });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on("error", () => resolve({ code: null, stdout: "" }));
    // Decoded once at the end, so a character split across chunks is not broken.
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }),
    );
  });

/** The Uninstall entries of all three keys, or [] when PowerShell fails, times out or prints no JSON. */
export async function readInstalledWindows(
  run: Run = runHidden,
): Promise<UninstallEntry[]> {
  let result: { code: number | null; stdout: string };
  try {
    result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        UNINSTALL_SCRIPT,
      ],
      TIMEOUT_MS,
    );
  } catch {
    return [];
  }
  // Killed at the timeout: whatever was printed is cut short. Any exit code otherwise: what was
  // printed is judged by whether it is JSON (a partial error still prints the full list).
  if (result.code === null) return [];
  const text = result.stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const isEntry = (value: unknown): value is UninstallEntry =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // One key prints an object rather than a one-item array.
  if (Array.isArray(parsed)) return parsed.filter(isEntry);
  return isEntry(parsed) ? [parsed] : [];
}
