import { expect, test } from "bun:test";
import {
  INSTALLED_LIMIT,
  installedNames,
  readInstalledWindows,
  UNINSTALL_SCRIPT,
} from "../src/discover-installed";

/*
 * The programs installed on a Windows machine, from the registry's Uninstall keys, as a list of
 * names. Read through PowerShell with UTF-8 JSON output so 中文 names arrive intact; the reader is
 * injected here so every branch runs on Linux.
 */

test("drops system components, child updates, KB patches and update release types", () => {
  expect(
    installedNames([
      { DisplayName: "Microsoft Visual C++ 2015 Runtime", SystemComponent: 1 },
      { DisplayName: "Office 子组件", ParentKeyName: "Office16.PROPLUS" },
      { DisplayName: "Security Update for Windows (KB5034441)" },
      { DisplayName: "Hotfix kb123456 for Something" },
      { DisplayName: "Some Patch", ReleaseType: "Update" },
      { DisplayName: "Some Hotfix", ReleaseType: "Hotfix" },
      { DisplayName: "Some Security", ReleaseType: "Security Update" },
      { DisplayName: "Some Rollup", ReleaseType: "Update Rollup" },
      // Kept: not a system component, an empty parent, a KB-like word that is not a KB number.
      { DisplayName: "Figma", SystemComponent: 0, ParentKeyName: "" },
      { DisplayName: "KB12 Tool", ReleaseType: "Product" },
      { DisplayName: "Visual Studio Code", ParentKeyName: null },
      { DisplayName: 42 },
      { DisplayName: "   " },
      {},
    ]),
  ).toEqual(["Figma", "KB12 Tool", "Visual Studio Code"]);
});

test("dedupes case-insensitively, keeps 中文 names intact, sorts and caps at 200", () => {
  expect(
    installedNames([
      { DisplayName: "  微信  " },
      { DisplayName: "zoom" },
      { DisplayName: "Zoom" },
      { DisplayName: "WPS Office" },
      { DisplayName: "微信" },
      { DisplayName: "Apple" },
    ]),
  ).toEqual(
    ["微信", "zoom", "WPS Office", "Apple"].sort((a, b) =>
      a.localeCompare(b, "zh-CN"),
    ),
  );
  const many = Array.from({ length: 450 }, (_, i) => ({
    DisplayName: `App ${String(i).padStart(3, "0")}`,
  }));
  const names = installedNames(many);
  expect(INSTALLED_LIMIT).toBe(200);
  expect(names).toHaveLength(200);
  expect(names[0]).toBe("App 000");
  expect(names[199]).toBe("App 199");
});

test("readInstalledWindows accepts one object or an array; a failed, timed-out or non-JSON run gives []", async () => {
  const calls: { command: string; args: string[]; timeoutMs: number }[] = [];
  const fake =
    (result: { code: number | null; stdout: string } | Error) =>
    async (command: string, args: string[], timeoutMs: number) => {
      calls.push({ command, args, timeoutMs });
      if (result instanceof Error) throw result;
      return result;
    };

  expect(
    await readInstalledWindows(
      fake({
        code: 0,
        stdout:
          '[{"DisplayName":"微信","SystemComponent":null},{"DisplayName":"Figma"}]\r\n',
      }),
    ),
  ).toEqual([
    { DisplayName: "微信", SystemComponent: null },
    { DisplayName: "Figma" },
  ]);
  expect(calls[0]?.command).toBe("powershell.exe");
  expect(calls[0]?.args).toEqual([
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    UNINSTALL_SCRIPT,
  ]);
  expect(calls[0]?.timeoutMs).toBe(15_000);

  // One key: ConvertTo-Json prints an object, not an array.
  expect(
    await readInstalledWindows(
      fake({ code: 0, stdout: '{"DisplayName":"Only One"}' }),
    ),
  ).toEqual([{ DisplayName: "Only One" }]);
  // Nothing installed: ConvertTo-Json prints nothing.
  expect(await readInstalledWindows(fake({ code: 0, stdout: "" }))).toEqual([]);
  expect(
    await readInstalledWindows(
      fake({ code: 1, stdout: '[{"DisplayName":"x"}]' }),
    ),
  ).toEqual([]);
  // Killed at the timeout: no exit code.
  expect(
    await readInstalledWindows(
      fake({ code: null, stdout: '[{"DisplayName":"x"' }),
    ),
  ).toEqual([]);
  expect(
    await readInstalledWindows(
      fake({ code: 0, stdout: "Get-ItemProperty : 拒绝访问" }),
    ),
  ).toEqual([]);
  expect(await readInstalledWindows(fake({ code: 0, stdout: "42" }))).toEqual(
    [],
  );
  expect(
    await readInstalledWindows(
      fake({ code: 0, stdout: '[1, "a", null, {"DisplayName":"b"}]' }),
    ),
  ).toEqual([{ DisplayName: "b" }]);
  expect(await readInstalledWindows(fake(new Error("ENOENT")))).toEqual([]);
});

test("the script reads both HKLM views and HKCU and sets UTF-8 output", () => {
  expect(UNINSTALL_SCRIPT).toContain(
    "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  );
  expect(UNINSTALL_SCRIPT).toContain(
    "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  );
  expect(UNINSTALL_SCRIPT).toContain(
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  );
  expect(UNINSTALL_SCRIPT).toContain(
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  );
  // The encoding is set before anything is printed.
  expect(UNINSTALL_SCRIPT.indexOf("UTF8Encoding")).toBeLessThan(
    UNINSTALL_SCRIPT.indexOf("Get-ItemProperty"),
  );
  expect(UNINSTALL_SCRIPT).toContain("-ErrorAction SilentlyContinue");
  expect(UNINSTALL_SCRIPT).toContain(
    "Select-Object DisplayName, SystemComponent, ParentKeyName, ReleaseType",
  );
  expect(UNINSTALL_SCRIPT).toContain("ConvertTo-Json -Compress");
});
