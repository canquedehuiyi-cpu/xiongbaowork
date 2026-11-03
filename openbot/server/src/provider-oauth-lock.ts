import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export class CredentialLockUnavailable extends Error {}

// Both writers keep this directory and inode permanently. Never remove a held lock:
// another opener could then lock a different inode. Empty legacy directories work too.
export async function lockProviderCredentials(
  file: string,
): Promise<() => Promise<void>> {
  try {
    const directory = `${file}.lock`;
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    });
    const info = await lstat(directory);
    // Legacy native mkdir could leave 0755; only its owner can change entries.
    // The stable lock file itself must still be 0600.
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o022) !== 0)
    )
      throw new Error("The credential lock directory is not private.");
    const path = join(directory, "owner.lock");
    return process.platform === "win32"
      ? await windowsLock(path)
      : await unixLock(path);
  } catch (error) {
    throw new CredentialLockUnavailable(
      "The model credential store is busy or unavailable.",
      { cause: error },
    );
  }
}

async function unixLock(path: string): Promise<() => Promise<void>> {
  const ffi = await import("bun:ffi");
  const mac = process.platform === "darwin";
  const library = ffi.dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [mac ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
  });
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: unknown) => {
    library.close();
    throw error;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new Error("Invalid credential lock file.");
    const deadline = Date.now() + 5000;
    while (library.symbols.flock(handle.fd, 2 | 4) !== 0) {
      // LOCK_EX | LOCK_NB
      const address = library.symbols[mac ? "__error" : "__errno_location"]();
      if (
        !address ||
        ffi.read.i32(address) !== (mac ? 35 : 11) ||
        Date.now() >= deadline
      )
        throw new Error("Could not acquire credential lock.");
      await Bun.sleep(25);
    }
    return async () => {
      // Closing releases flock even if this process is killed before explicit cleanup.
      try {
        await handle.close();
      } finally {
        library.close();
      }
    };
  } catch (error) {
    try {
      await handle.close();
    } finally {
      library.close();
    }
    throw error;
  }
}

// Bun 1.3 has no Windows ARM64 FFI. Windows PowerShell ships with the OS and
// owns the same share-mode lock as Rust. EOF on this pipe also releases it when
// the Bun parent dies. The path is environment data, never interpolated code.
const windowsLockScript = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OpenBotCredentialLock {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out TagInfo info, uint size);
  [StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attributes; public uint Tag; }
  public static SafeFileHandle Open(string path) {
    var file = CreateFileW(path, 0xC0000000, 0, IntPtr.Zero, 4, 0x00200000, IntPtr.Zero);
    if (file.IsInvalid) { int error = Marshal.GetLastWin32Error(); file.Dispose(); throw new Win32Exception(error); }
    TagInfo info;
    if (!GetFileInformationByHandleEx(file, 9, out info, 8) || (info.Attributes & 0x410) != 0) {
      file.Dispose(); throw new InvalidOperationException("Invalid credential lock file.");
    }
    return file;
  }
}
'@
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
$deadline=[DateTime]::UtcNow.AddSeconds(5)
$file=$null
while ($null -eq $file) {
  try { $file=[OpenBotCredentialLock]::Open($env:OPENBOT_CREDENTIAL_LOCK) }
  catch {
    $cause=$_.Exception.GetBaseException()
    if ($cause -isnot [System.ComponentModel.Win32Exception] -or $cause.NativeErrorCode -ne 32 -or [DateTime]::UtcNow -ge $deadline) { exit 1 }
    Start-Sleep -Milliseconds 25
  }
}
try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null }
finally { $file.Dispose() }
`;

async function windowsLock(path: string): Promise<() => Promise<void>> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENBOT_CREDENTIAL_LOCK: path,
  };
  delete env.PSModulePath;
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsLockScript,
    ],
    {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    },
  );
  return holdLockHelper(child);
}

/** The helper process as {@link holdLockHelper} drives it: a Bun subprocess with piped stdio. */
export interface LockHelper {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stdin: { end(): unknown };
  readonly exited: Promise<number>;
  kill(): void;
}

/**
 * How long the helper may take, in two parts. Starting is a fresh Windows PowerShell plus the
 * Add-Type compile of its CreateFileW wrapper, which on a cold machine alone can take longer than a
 * lock ever should, so it has its own bound and ends at the helper's `ready` line. The lock then
 * gets `lockMs` from `ready`; the helper itself stops retrying a held lock 5 s after `ready`.
 */
export const LOCK_HELPER_TIMING = { startupMs: 60_000, lockMs: 15_000 };

/**
 * Waits for the helper's `ready` and then `locked` lines, killing it if either bound passes or it
 * says anything else. Answers the release: end its stdin, and it closes the handle and exits 0.
 */
export async function holdLockHelper(
  child: LockHelper,
  timing: { startupMs: number; lockMs: number } = LOCK_HELPER_TIMING,
): Promise<() => Promise<void>> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let expired: "startup" | "lock" | undefined;
  let timeout = setTimeout(() => {
    expired = "startup";
    child.kill();
  }, timing.startupMs);
  try {
    let message = "";
    let ready = false;
    for (;;) {
      const lines = message
        .split("\n")
        .slice(0, -1)
        .map((line) => line.trim());
      if (lines.length > 0 && lines[0] !== "ready")
        throw new Error("Invalid credential lock response.");
      if (lines.length > 0 && !ready) {
        ready = true;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          expired = "lock";
          child.kill();
        }, timing.lockMs);
      }
      if (lines.length > 1) {
        if (lines.length > 2 || lines[1] !== "locked")
          throw new Error("Invalid credential lock response.");
        break;
      }
      const { value, done } = await reader.read();
      if (done) {
        if (expired === "startup") {
          console.error(
            JSON.stringify({
              type: "credential-lock-helper-not-started",
              note: "Windows PowerShell did not start the credential lock helper in time; the helper was stopped.",
              startupMs: timing.startupMs,
            }),
          );
          throw new Error(
            `The credential lock helper did not start within ${timing.startupMs} ms.`,
          );
        }
        throw new Error(
          expired === "lock"
            ? `Could not acquire credential lock within ${timing.lockMs} ms.`
            : "Could not acquire credential lock.",
        );
      }
      message += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  return async () => {
    child.stdin.end();
    if ((await child.exited) !== 0)
      throw new Error("Could not release credential lock.");
  };
}
