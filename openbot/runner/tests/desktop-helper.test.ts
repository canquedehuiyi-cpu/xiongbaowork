import { afterEach, describe, expect, test } from "bun:test";
import {
  createDesktopHost,
  DesktopHelperError,
  HELPER_OPS,
  HELPER_SOURCE,
  type HelperLaunchSpec,
  helperLaunchSpec,
} from "../src/desktop/host";

/*
 * The C# helper and how it is launched (plan docs/plans/2026-11-08-desktop-control.md, Task 3). The
 * helper itself only runs on Windows (the WIN1 probe compiles and drives it); here its source is
 * checked for the read-only and C# 5 rules, and the host's launch spec, allow-list and ensure().
 */

const FAKE = `${import.meta.dir}/fixtures/fake-desktop-helper.ts`;

type Host = ReturnType<typeof createDesktopHost>;
const hosts: Host[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function host(spec: () => HelperLaunchSpec) {
  const spawns = { count: 0 };
  const created = createDesktopHost({
    spec: () => {
      spawns.count += 1;
      return spec();
    },
  });
  hosts.push(created);
  return { host: created, spawns };
}

const fake = (mode: string) => (): HelperLaunchSpec => ({
  command: process.execPath,
  args: [FAKE],
  env: { FAKE_DESKTOP_MODE: mode },
});

/** A helper written inline: `bun -e <script>`. */
const inline = (script: string) => (): HelperLaunchSpec => ({
  command: process.execPath,
  args: ["-e", script],
});

/**
 * The only native functions helper.cs may call (the brief's list), by their real entry point.
 * `GetWindowLong` is user32's `GetWindowLongW`.
 */
const READ_ONLY_WIN32 = [
  "EnumWindows",
  "IsWindow",
  "IsWindowVisible",
  "GetWindowTextLengthW",
  "GetWindowTextW",
  "GetWindowThreadProcessId",
  "GetWindow",
  "GetWindowLongW",
  "IsIconic",
  "GetForegroundWindow",
  "GetWindowRect",
  "PrintWindow",
  "SetProcessDPIAware",
  "DwmGetWindowAttribute",
  "OpenProcess",
  "OpenProcessToken",
  "GetTokenInformation",
  "GetSidSubAuthority",
  "GetSidSubAuthorityCount",
  "CloseHandle",
] as const;

const NATIVE_LIBRARIES = new Set([
  "user32.dll",
  "kernel32.dll",
  "advapi32.dll",
  "dwmapi.dll",
]);

/**
 * Every P/Invoke in a C# source: the entry point each one really binds (its EntryPoint, else its
 * method name), and whatever about them cannot be checked. A problem: an EntryPoint that is not one
 * plain string literal (a name built with `+`, a constant, an ordinal like "#123"), a library outside
 * the four above, and any `DllImport` or `extern` this parser did not account for.
 */
function pinvokes(source: string): { entries: string[]; problems: string[] } {
  const entries: string[] = [];
  const problems: string[] = [];
  const declaration =
    /\[\s*DllImport\s*\(([^()\]]*)\)\s*\]\s*((?:(?:private|public|internal|protected|static|extern|unsafe)\s+)+)[\w.<>[\]]+\s+(\w+)\s*\(/g;
  let found = 0;
  for (const match of source.matchAll(declaration)) {
    found += 1;
    const [, args = "", modifiers = "", method = ""] = match;
    if (!/\bextern\b/.test(modifiers)) problems.push(`${method}: not extern`);
    const library = /^\s*"([^"]*)"\s*(?:,|$)/.exec(args)?.[1];
    if (!library || !NATIVE_LIBRARIES.has(library.toLowerCase()))
      problems.push(`${method}: library ${args}`);
    const entryPoint = /\bEntryPoint\s*=\s*([^,]*)/.exec(args);
    if (entryPoint) {
      const literal = /^\s*"([A-Za-z_]\w*)"\s*$/.exec(entryPoint[1] ?? "");
      if (!literal?.[1])
        problems.push(`${method}: EntryPoint ${entryPoint[1]}`);
      else entries.push(literal[1]);
    } else entries.push(method);
  }
  const imports = source.match(/DllImport/g)?.length ?? 0;
  const externs = source.match(/\bextern\b/g)?.length ?? 0;
  if (imports !== found) problems.push(`${imports} DllImport, ${found} parsed`);
  if (externs !== found) problems.push(`${externs} extern, ${found} parsed`);
  return { entries, problems };
}

/**
 * Names that send input, move focus or windows, change a control, hook, start or end a process, reach
 * native code another way, or invoke by reflection. Matched with every space taken out of both
 * sides, so `p . Start ()` is `.Start(`.
 */
const BANNED = [
  // Input, hooks, focus, other windows.
  "SendInput",
  "keybd_event",
  "mouse_event",
  "SetCursorPos",
  "Cursor.Position",
  "BlockInput",
  "SetWindowsHookEx",
  "RegisterHotKey",
  "SetForegroundWindow",
  "SetActiveWindow",
  "SetFocus",
  "BringWindowToTop",
  "SwitchToThisWindow",
  "ShowWindow",
  "SetWindowPos",
  "MoveWindow",
  "SetWindowText",
  "AttachThreadInput",
  "PostMessage",
  "SendMessage",
  "SendKeys",
  "Clipboard",
  // WinForms that pops up, steals focus or clicks (the assembly is only for Screen.PrimaryScreen).
  ".Show(",
  "MessageBox",
  ".Focus(",
  ".Activate(",
  ".PerformClick(",
  // UI Automation that acts.
  "InvokePattern",
  "TogglePattern",
  "ExpandCollapsePattern",
  "SelectionItemPattern",
  "ScrollPattern",
  "ScrollItemPattern",
  "WindowPattern",
  "TransformPattern",
  "DockPattern",
  "VirtualizedItemPattern",
  "RangeValuePattern",
  ".SetValue(",
  ".SetFocus(",
  ".Select(",
  ".AddToSelection(",
  ".ScrollIntoView(",
  ".Invoke(",
  ".Close(",
  ".Expand(",
  ".Collapse(",
  ".Toggle(",
  "SetCurrentView",
  "MultipleViewPattern",
  // Processes.
  "Process.Start",
  "new Process",
  "ProcessStartInfo",
  "StartInfo",
  ".Start(",
  "ShellExecute",
  "CreateProcess",
  "WinExec",
  "CloseMainWindow",
  ".Kill(",
  // Native code or code chosen at run time.
  "GetDelegateForFunctionPointer",
  "LoadLibrary",
  "GetProcAddress",
  "ComImport",
  "GetTypeFromProgID",
  "GetTypeFromCLSID",
  "InvokeMember",
  "DynamicInvoke",
  "Activator",
  "Assembly.Load",
  "System.Reflection",
];

function bannedIn(source: string): string[] {
  const squeezed = source.replace(/\s+/g, "");
  return BANNED.filter((name) => squeezed.includes(name.replace(/\s+/g, "")));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  "-",
];

describe("desktop helper launch", () => {
  test("helperLaunchSpec on win32 runs Windows PowerShell 5.1 reading the script from stdin", () => {
    const spec = helperLaunchSpec("class X {}", "win32", {
      SystemRoot: "D:\\Win",
    });
    expect(spec.command).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spec.args).toEqual(ARGS);
    // SYSTEMROOT, then C:\Windows, as commandShell finds it.
    expect(
      helperLaunchSpec("class X {}", "win32", { SYSTEMROOT: "E:\\W" }).command,
    ).toBe("E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(helperLaunchSpec("class X {}", "win32", {}).command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  test("the preamble is one ASCII line that decodes back to the source, Chinese included", () => {
    const source = "// 熊宝员工\nclass X {}";
    const { preamble } = helperLaunchSpec(source, "win32", {});
    if (preamble === undefined) throw new Error("no preamble");
    expect(preamble).toMatch(/^[\x20-\x7e]+$/);
    const base64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(preamble);
    expect(base64).not.toBeNull();
    expect(Buffer.from(base64?.[1] ?? "", "base64").toString("utf8")).toBe(
      source,
    );
    expect(preamble.startsWith("$ProgressPreference='SilentlyContinue'")).toBe(
      true,
    );
    expect(preamble.endsWith("[XiongbaoDesktop.Helper]::Run()")).toBe(true);
    expect(preamble).toContain(
      "-ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase,System.Windows.Forms,System.Drawing,System.Web.Extensions",
    );
    // Add-Type's compile errors leave as UTF-8, readable on a Chinese (GBK) Windows.
    const setError = preamble.indexOf("[Console]::SetError(");
    expect(setError).toBeGreaterThan(-1);
    expect(setError).toBeLessThan(preamble.indexOf("Add-Type"));
  });

  test("helperLaunchSpec refuses a non-Windows platform", () => {
    for (const platform of ["linux", "darwin"]) {
      let caught: unknown;
      try {
        helperLaunchSpec("class X {}", platform, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DesktopHelperError);
      expect((caught as DesktopHelperError).code).toBe("not_windows");
    }
  });
});

describe("helper.cs source", () => {
  test("helper.cs answers exactly windows, tree and screenshot", () => {
    const cases = [...HELPER_SOURCE.matchAll(/case "(\w+)":/g)].map(
      (match) => match[1],
    );
    expect(cases.sort()).toEqual(["screenshot", "tree", "windows"]);
    expect([...HELPER_OPS].sort()).toEqual(["screenshot", "tree", "windows"]);
    expect(HELPER_SOURCE).toContain("unsupported op: ");
  });

  test("helper.cs declares no input, focus, hook or process-launch API", () => {
    // Whitespace is no way around it: `.SetValue (` is `.SetValue(`.
    expect(bannedIn(HELPER_SOURCE)).toEqual([]);
  });

  test("helper.cs P/Invokes exactly the 20 read-only Win32 functions, by literal name", () => {
    const { entries, problems } = pinvokes(HELPER_SOURCE);
    expect(problems).toEqual([]);
    expect([...new Set(entries)].sort()).toEqual([...READ_ONLY_WIN32].sort());
  });

  test("the source guard catches what a hard-coded name list would miss", () => {
    const decl = (attribute: string, method = "Harmless") =>
      `[${attribute}]\nprivate static extern bool ${method}(IntPtr h);`;
    // A name built at compile time, an ordinal, an import outside the allow-list, a library outside
    // the four, an extern without DllImport: each is a problem or a stray entry point.
    expect(
      pinvokes(decl('DllImport("user32.dll", EntryPoint = "Send" + "Input")'))
        .problems.length,
    ).toBeGreaterThan(0);
    expect(
      pinvokes(decl('DllImport("user32.dll", EntryPoint = "#123")')).problems
        .length,
    ).toBeGreaterThan(0);
    expect(
      pinvokes(decl('DllImport("shell32.dll")', "ShellExecuteW")).problems
        .length,
    ).toBeGreaterThan(0);
    expect(
      pinvokes(decl('DllImport("user32.dll")', "BlockInput")).entries,
    ).toEqual(["BlockInput"]);
    expect(
      pinvokes("private static extern bool Sneaky(IntPtr h);").problems.length,
    ).toBeGreaterThan(0);
    expect(
      bannedIn(
        "var p = new Process (); p.StartInfo.FileName = x; p . Start ();",
      ),
    ).toEqual(expect.arrayContaining(["new Process", "StartInfo", ".Start("]));
    expect(
      bannedIn("element.GetCurrentPattern(ValuePattern.Pattern) .SetValue (v)"),
    ).toEqual([".SetValue("]);
    expect(
      bannedIn(
        "Marshal.GetDelegateForFunctionPointer(GetProcAddress(LoadLibrary(x), y))",
      ).sort(),
    ).toEqual(
      ["GetDelegateForFunctionPointer", "GetProcAddress", "LoadLibrary"].sort(),
    );
    expect(
      bannedIn(
        "form . Show (); MessageBox.Show(x); b.PerformClick(); w.Activate(); c.Focus(); e.Expand(); e.Collapse(); e.Toggle(); v.SetCurrentView(1)",
      ),
    ).toEqual(
      expect.arrayContaining([
        ".Show(",
        "MessageBox",
        ".PerformClick(",
        ".Activate(",
        ".Focus(",
        ".Expand(",
        ".Collapse(",
        ".Toggle(",
        "SetCurrentView",
      ]),
    );
  });

  test("helper.cs stays within C# 5", () => {
    for (const newer of ['$"', "?.", "nameof(", "using System.Linq"])
      expect({ newer, found: HELPER_SOURCE.includes(newer) }).toEqual({
        newer,
        found: false,
      });
  });

  test("helper.cs reads keys case-sensitively and refuses duplicate or case-variant keys", () => {
    // The request dictionary is ordinal, and every top-level key is checked against the others
    // ignoring case before the op is read, so a smuggled "Op" can never be taken for the op.
    expect(HELPER_SOURCE).toContain("StringComparer.Ordinal)");
    expect(HELPER_SOURCE).toContain("StringComparer.OrdinalIgnoreCase");
    expect(HELPER_SOURCE).toContain("duplicate or case-variant key: ");
  });
});

describe("desktop host allow-list and ensure", () => {
  test("the host refuses an op outside HELPER_OPS without starting a helper", async () => {
    const { host: desk, spawns } = host(fake("ok"));
    const error = await rejection(desk.request({ op: "click" }));
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("unsupported");
    expect((error as DesktopHelperError).sent).toBe(false);
    expect(desk.running).toBe(false);
    expect(spawns.count).toBe(0);
  });

  test("the host refuses a case variant of op or id, unsent, without starting a helper", async () => {
    const { host: desk, spawns } = host(fake("ok"));
    for (const request of [
      { op: "tree", Op: "click" },
      { op: "tree", OP: "click" },
      { op: "tree", oP: "click" },
      { op: "tree", ID: 7 },
      { op: "tree", Id: 7 },
      { op: "tree", iD: 7 },
    ]) {
      const error = await rejection(desk.request(request));
      expect(error).toBeInstanceOf(DesktopHelperError);
      expect((error as DesktopHelperError).code).toBe("unsupported");
      expect((error as DesktopHelperError).sent).toBe(false);
    }
    expect(spawns.count).toBe(0);
    expect(desk.running).toBe(false);
  });

  test("an op that cannot be turned into text is refused, never thrown", async () => {
    const { host: desk, spawns } = host(fake("ok"));
    // After the JSON round trip, an own toString and valueOf that are not functions make String() throw.
    const odd = { op: { toString: 1, valueOf: 1 } } as unknown as {
      op: string;
    };
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = desk.request(odd);
    }).not.toThrow();
    const error = await rejection(pending ?? Promise.resolve());
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("unsupported");
    expect((error as DesktopHelperError).message).toStartWith(
      "unsupported op: ",
    );
    expect(spawns.count).toBe(0);
  });

  test("ensure starts the helper once and exposes its prefix", async () => {
    const { host: desk, spawns } = host(fake("ok"));
    expect(desk.prefix).toBeUndefined();
    await desk.ensure();
    const prefix = desk.prefix;
    expect(prefix).toMatch(/^[0-9a-f]{6}$/);
    expect(desk.nextSnapshotId()).toBe(`${prefix}-1`);
    expect(desk.nextSnapshotId()).toBe(`${prefix}-2`);
    await desk.ensure();
    expect(desk.prefix).toBe(prefix);
    expect(spawns.count).toBe(1);
    // A request after ensure() runs on the same helper.
    await desk.request({ op: "tree" });
    expect(desk.prefix).toBe(prefix);
    expect(spawns.count).toBe(1);
  });

  test("ensure refuses a helper in session 0 as session0", async () => {
    const { host: desk } = host(fake("session0"));
    const error = await rejection(desk.ensure());
    expect(error).toBeInstanceOf(DesktopHelperError);
    expect((error as DesktopHelperError).code).toBe("session0");
    expect(desk.prefix).toBeUndefined();
  });

  test("ensure honours an abort while the helper starts", async () => {
    const { host: desk } = host(fake("noready"));
    const controller = new AbortController();
    const waiting = desk.ensure({ signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const error = await rejection(waiting);
    expect((error as Error).name).toBe("AbortError");
    expect(desk.running).toBe(false);
  });

  test("a ready line glued to a prompt without a newline is still read", async () => {
    const script = `
      process.stdout.write("PS C:\\\\> " + JSON.stringify({ ready: true, pid: process.pid, session: 1, interactive: true }) + "\\n");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.startsWith("{")) continue;
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { op: request.op } }) + "\\n");
        }
      });
    `;
    const { host: desk } = host(inline(script));
    const answer = await desk.request<{ op: string }>({ op: "windows" });
    expect(answer.op).toBe("windows");
  });

  test("a long CLIXML stderr is cut at an element, so its tail still reads as text", async () => {
    // Add-Type's errors, as Windows PowerShell serialises a redirected stderr: well past what the host
    // keeps, so the header is far behind the cut.
    const script = `
      let out = "#< CLIXML\\r\\n<Objs Version=\\"1.1.0.1\\" xmlns=\\"http://schemas.microsoft.com/powershell/2004/04\\">";
      for (let n = 0; n < 4000; n++) out += '<S S="Error">编译错误 第' + n + '行_x000D__x000A_</S>';
      out += "</Objs>";
      process.stderr.write(out, () => process.exit(1));
    `;
    const { host: desk } = host(inline(script));
    const error = await rejection(desk.request({ op: "windows" }));
    expect((error as DesktopHelperError).code).toBe("start_failed");
    const tail = (error as DesktopHelperError).stderrTail ?? "";
    expect(tail).toContain("编译错误 第3999行");
    expect(tail).not.toContain("<S S=");
    expect(tail).not.toContain("_x000D_");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
  });
});
