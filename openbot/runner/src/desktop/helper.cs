// The desktop helper: READ ONLY (plan docs/plans/2026-11-08-desktop-control.md, Task 3).
//
// Compiled by Windows PowerShell 5.1's Add-Type (the .NET Framework 4.x compiler), so C# 5 only: no
// string interpolation, no null-conditional operator, no nameof, no expression-bodied members, and
// no LINQ (it would need System.Core). runner/src/desktop/host.ts feeds this source in base64 on one
// ASCII line and calls Helper.Run(), which then speaks the host's line-JSON protocol on raw UTF-8
// stdin and stdout, so Chinese survives a GBK console.
//
// Exactly three operations, all of them reads: list the visible top-level windows, read one
// window's UI Automation tree, and take one window's screenshot. Every other op is answered
// "unsupported op". Nothing in this file sends input, moves focus, installs a hook or starts a
// process, and the runner's tests keep it that way.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace XiongbaoDesktop
{
    public static class Helper
    {
        // ---- Win32, read-only calls only ----------------------------------------------------------

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLengthW(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hwnd, uint command);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
        private static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attribute, out int value, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private const uint GW_OWNER = 4;
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const int DWMWA_CLOAKED = 14;
        private const uint PW_RENDERFULLCONTENT = 2;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TOKEN_INTEGRITY_LEVEL = 25;
        private const int ERROR_ACCESS_DENIED = 5;

        // ---- Limits (shared/desktop-control.ts DESKTOP_LIMITS); the helper holds them on its own ----

        private const int TREE_MAX_DEPTH = 12;
        private const int TREE_MAX_NODES = 800;
        private const int SCREENSHOT_MAX_EDGE = 1280;
        private const int TITLE_MAX = 200;
        private const int SNAPSHOTS_KEPT = 16;
        private const int MESSAGE_MAX = 300;

        // ---- State --------------------------------------------------------------------------------

        private sealed class Snapshot
        {
            public string Id;
            public List<AutomationElement> Elements;
        }

        /// <summary>A request refused on purpose: answered with its code, the helper carries on.</summary>
        private sealed class Refusal : Exception
        {
            public readonly string Code;

            public Refusal(string code, string message) : base(message)
            {
                Code = code;
            }
        }

        private sealed class Target
        {
            public IntPtr Hwnd;
            public uint Pid;
            public string Key;
        }

        /// <summary>The latest snapshot of each window read, oldest window first in snapshotOrder.</summary>
        private static readonly Dictionary<string, Snapshot> snapshots = new Dictionary<string, Snapshot>(StringComparer.Ordinal);
        private static readonly List<string> snapshotOrder = new List<string>();
        private static int ownIntegrity = -1;

        // ---- Entry --------------------------------------------------------------------------------

        public static void Run()
        {
            try
            {
                SetProcessDPIAware();
            }
            catch (Exception)
            {
            }

            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

            Process self = Process.GetCurrentProcess();
            int session = self.SessionId;
            try
            {
                bool denied;
                ownIntegrity = Integrity((uint)self.Id, out denied);
            }
            catch (Exception)
            {
                ownIntegrity = -1;
            }

            Dictionary<string, object> ready = new Dictionary<string, object>();
            ready["ready"] = true;
            ready["pid"] = self.Id;
            ready["session"] = session;
            ready["interactive"] = Environment.UserInteractive && session != 0;
            // A newline first: whatever PowerShell may have written without one stays off the ready line.
            output.Write("\n" + json.Serialize(ready) + "\n");

            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            try
            {
                while (true)
                {
                    string line = input.ReadLine();
                    // stdin closed: the host is done. PowerShell then reads the same end and exits.
                    if (line == null) return;
                    if (line.Trim().Length == 0) continue;
                    output.Write(Answer(json, line) + "\n");
                }
            }
            catch (Exception e)
            {
                // The pipes broke. Exit here rather than return, so PowerShell never goes on to read
                // anything left on stdin as a command of its own.
                Console.Error.WriteLine("desktop helper stopped: " + Describe(e));
                Environment.Exit(1);
            }
        }

        private static string Answer(JavaScriptSerializer json, string line)
        {
            object id = null;
            Dictionary<string, object> reply;
            try
            {
                reply = Handle(json, line, out id);
            }
            catch (Exception e)
            {
                reply = Fail(id, "failed", Describe(e));
            }
            try
            {
                return json.Serialize(reply);
            }
            catch (Exception e)
            {
                return json.Serialize(Fail(id, "failed", Describe(e)));
            }
        }

        private static Dictionary<string, object> Handle(JavaScriptSerializer json, string line, out object id)
        {
            id = null;
            Dictionary<string, object> parsed;
            try
            {
                parsed = json.DeserializeObject(line) as Dictionary<string, object>;
            }
            catch (Exception e)
            {
                return Fail(null, "failed", Describe(e));
            }
            if (parsed == null) return Fail(null, "unsupported", "a request must be a JSON object");
            // Keys are read exactly as written: "Op" is not "op".
            Dictionary<string, object> request = new Dictionary<string, object>(parsed, StringComparer.Ordinal);
            object idValue;
            if (request.TryGetValue("id", out idValue)) id = idValue;

            // Before the op is read: a request with the same key twice, or two keys that differ only in
            // case, is refused whole, so no reader can be made to see an op other than the one checked.
            string clash = KeyClash(json, line);
            if (clash != null) return Fail(id, "unsupported", "duplicate or case-variant key: " + Clip(clash, 100));

            object opValue;
            request.TryGetValue("op", out opValue);
            string op = opValue as string;
            try
            {
                switch (op)
                {
                    case "windows":
                        return Ok(id, Windows(request));
                    case "tree":
                        return Ok(id, Tree(request));
                    case "screenshot":
                        return Ok(id, Screenshot(request));
                    default:
                        return Fail(id, "unsupported", "unsupported op: " + Clip(Convert.ToString(opValue, CultureInfo.InvariantCulture), 100));
                }
            }
            catch (Refusal r)
            {
                return Fail(id, r.Code, r.Message);
            }
            catch (ElementNotAvailableException e)
            {
                return Fail(id, request.ContainsKey("from") ? "stale" : "no_window", Describe(e));
            }
            catch (UnauthorizedAccessException e)
            {
                return Fail(id, "elevated", Describe(e));
            }
            catch (Exception e)
            {
                return Fail(id, "failed", Describe(e));
            }
        }

        /// <summary>
        /// The first top-level key of a JSON object that repeats another one, exactly or in a different
        /// case, after JSON escapes are decoded; null when every key is distinct.
        /// </summary>
        private static string KeyClash(JavaScriptSerializer json, string text)
        {
            Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            int depth = 0;
            bool expectKey = false;
            int i = 0;
            while (i < text.Length)
            {
                char c = text[i];
                if (c == '"')
                {
                    int start = i;
                    i++;
                    while (i < text.Length && text[i] != '"')
                    {
                        if (text[i] == '\\') i++;
                        i++;
                    }
                    i++;
                    if (depth == 1 && expectKey)
                    {
                        string key = json.Deserialize<string>(text.Substring(start, Math.Min(i, text.Length) - start));
                        if (key == null || seen.ContainsKey(key)) return key ?? "null";
                        seen[key] = true;
                        expectKey = false;
                    }
                    continue;
                }
                if (c == '{' || c == '[')
                {
                    depth++;
                    if (depth == 1 && c == '{') expectKey = true;
                }
                else if (c == '}' || c == ']')
                {
                    depth--;
                }
                else if (c == ',' && depth == 1)
                {
                    expectKey = true;
                }
                i++;
            }
            return null;
        }

        // ---- windows ------------------------------------------------------------------------------

        private static Dictionary<string, object> Windows(Dictionary<string, object> request)
        {
            int max = (int)Clamp(Number(request, "max", 50), 1, 1000);
            List<IntPtr> found = new List<IntPtr>();
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (Listed(hwnd)) found.Add(hwnd);
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);

            IntPtr foreground = GetForegroundWindow();
            List<object> windows = new List<object>();
            foreach (IntPtr hwnd in found)
            {
                if (windows.Count >= max) break;
                uint pid;
                if (GetWindowThreadProcessId(hwnd, out pid) == 0) continue;
                windows.Add(WindowInfo(hwnd, pid, foreground));
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["windows"] = windows;
            return result;
        }

        /// <summary>A window a person would call a window: visible, titled, unowned, not a tool window, not cloaked.</summary>
        private static bool Listed(IntPtr hwnd)
        {
            if (!IsWindowVisible(hwnd)) return false;
            if (GetWindowTextLengthW(hwnd) <= 0 || Title(hwnd).Length == 0) return false;
            if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return false;
            if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return false;
            int cloaked;
            if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false;
            return true;
        }

        private static Dictionary<string, object> WindowInfo(IntPtr hwnd, uint pid, IntPtr foreground)
        {
            Dictionary<string, object> info = new Dictionary<string, object>();
            info["hwnd"] = hwnd.ToInt64().ToString(CultureInfo.InvariantCulture);
            info["pid"] = (long)pid;
            info["title"] = Clip(Title(hwnd), TITLE_MAX);
            info["process"] = ProcessName(pid);
            info["focused"] = foreground == hwnd;
            info["minimized"] = IsIconic(hwnd);
            return info;
        }

        private static string Title(IntPtr hwnd)
        {
            int length = GetWindowTextLengthW(hwnd);
            if (length <= 0) return "";
            StringBuilder text = new StringBuilder(length + 1);
            GetWindowTextW(hwnd, text, text.Capacity);
            return text.ToString();
        }

        private static string ProcessName(uint pid)
        {
            try
            {
                using (Process process = Process.GetProcessById((int)pid))
                {
                    return process.ProcessName;
                }
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        // ---- The checks before anything is read ---------------------------------------------------

        /// <summary>
        /// The window the request names, if it is still there, visible and owned by the same process;
        /// not one running with more rights than this helper; and not one whose live title carries a
        /// refused word. Refused otherwise, before anything of it is read.
        /// </summary>
        private static Target Check(Dictionary<string, object> request)
        {
            object hwndValue;
            request.TryGetValue("hwnd", out hwndValue);
            string hwndText = hwndValue as string;
            long handle;
            if (hwndText == null || !long.TryParse(hwndText, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out handle) || handle == 0)
                throw new Refusal("no_window", "no such window");
            double pidNumber = Number(request, "pid", 0);
            if (pidNumber < 1 || pidNumber > uint.MaxValue || pidNumber != Math.Floor(pidNumber))
                throw new Refusal("no_window", "no such process");

            Target target = new Target();
            try
            {
                target.Hwnd = new IntPtr(handle);
            }
            catch (OverflowException)
            {
                throw new Refusal("no_window", "no such window");
            }
            target.Pid = (uint)pidNumber;
            target.Key = handle.ToString(CultureInfo.InvariantCulture) + "-" + target.Pid.ToString(CultureInfo.InvariantCulture);

            uint owner;
            if (!IsWindow(target.Hwnd) || !IsWindowVisible(target.Hwnd) || GetWindowThreadProcessId(target.Hwnd, out owner) == 0 || owner != target.Pid)
                throw new Refusal("no_window", "the window is gone or belongs to another process");

            bool denied;
            int level = Integrity(target.Pid, out denied);
            if (denied || (level >= 0 && ownIntegrity >= 0 && level > ownIntegrity))
                throw new Refusal("elevated", "the window's process runs with higher rights");

            string title = Title(target.Hwnd);
            object wordsValue;
            request.TryGetValue("refuseWords", out wordsValue);
            IEnumerable words = wordsValue as IEnumerable;
            if (words != null && !(wordsValue is string))
            {
                foreach (object item in words)
                {
                    string word = item as string;
                    if (!string.IsNullOrEmpty(word) && title.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0)
                        throw new Refusal("sensitive", Clip(word, 100));
                }
            }
            return target;
        }

        /// <summary>A process's mandatory integrity level (RID), or -1 when it cannot be read; `denied` when its token was refused.</summary>
        private static int Integrity(uint pid, out bool denied)
        {
            denied = false;
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero)
            {
                denied = Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
                return -1;
            }
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(process, TOKEN_QUERY, out token))
                {
                    denied = Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
                    token = IntPtr.Zero;
                    return -1;
                }
                int size;
                GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, IntPtr.Zero, 0, out size);
                if (size <= 0) return -1;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    if (!GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buffer, size, out size)) return -1;
                    IntPtr sid = Marshal.ReadIntPtr(buffer);
                    int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    if (count < 1) return -1;
                    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally
            {
                if (token != IntPtr.Zero) CloseHandle(token);
                CloseHandle(process);
            }
        }

        // ---- tree ---------------------------------------------------------------------------------

        private sealed class Walk
        {
            public TreeWalker Walker;
            public CacheRequest Cache;
            public int MaxDepth;
            public int MaxNodes;
            public int NameMax;
            public int ValueMax;
            public long BudgetMs;
            public Stopwatch Clock;
            public bool Truncated;
            public bool Stopped;
            public readonly List<AutomationElement> Elements = new List<AutomationElement>();
            public readonly List<object> Rows = new List<object>();

            private bool OutOfRoom()
            {
                if (Rows.Count >= MaxNodes || Clock.ElapsedMilliseconds > BudgetMs)
                {
                    Truncated = true;
                    Stopped = true;
                }
                return Stopped;
            }

            public void Visit(AutomationElement element, int depth)
            {
                if (OutOfRoom()) return;
                Elements.Add(element);
                Rows.Add(Row(element, depth));
                AutomationElement child;
                try
                {
                    child = Walker.GetFirstChild(element, Cache);
                }
                catch (ElementNotAvailableException)
                {
                    // It went away while being read: what was read of it stands.
                    return;
                }
                if (child != null && depth >= MaxDepth)
                {
                    Truncated = true;
                    return;
                }
                while (child != null)
                {
                    Visit(child, depth + 1);
                    if (Stopped) return;
                    try
                    {
                        child = Walker.GetNextSibling(child, Cache);
                    }
                    catch (ElementNotAvailableException)
                    {
                        return;
                    }
                }
            }

            private Dictionary<string, object> Row(AutomationElement element, int depth)
            {
                Dictionary<string, object> row = new Dictionary<string, object>();
                ControlType controlType = element.Cached.ControlType;
                string type = controlType == null ? "Unknown" : controlType.ProgrammaticName;
                if (type.StartsWith("ControlType.", StringComparison.Ordinal)) type = type.Substring("ControlType.".Length);
                row["type"] = type;
                row["name"] = Clip(element.Cached.Name ?? "", NameMax);
                row["depth"] = depth;
                if (!element.Cached.IsEnabled) row["disabled"] = true;
                if (element.Cached.IsPassword)
                {
                    // A password box: its value is never read.
                    row["password"] = true;
                    return row;
                }
                string value = null;
                try
                {
                    if (Flag(element, AutomationElement.IsValuePatternAvailableProperty))
                    {
                        value = element.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string;
                    }
                    else if ((type == "Document" || type == "Edit") && Flag(element, AutomationElement.IsTextPatternAvailableProperty))
                    {
                        object pattern;
                        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                            value = ((TextPattern)pattern).DocumentRange.GetText(ValueMax);
                    }
                }
                catch (Exception)
                {
                    value = null;
                }
                if (!string.IsNullOrEmpty(value))
                {
                    value = Clip(value, ValueMax);
                    if (value.Length > 0) row["value"] = value;
                }
                return row;
            }

            private static bool Flag(AutomationElement element, AutomationProperty property)
            {
                object value = element.GetCachedPropertyValue(property, true);
                return value is bool && (bool)value;
            }
        }

        private static Dictionary<string, object> Tree(Dictionary<string, object> request)
        {
            Target target = Check(request);
            object snapshotValue;
            request.TryGetValue("snapshot", out snapshotValue);
            string snapshotId = snapshotValue as string;
            if (string.IsNullOrEmpty(snapshotId)) throw new Refusal("failed", "a tree request needs a snapshot id");

            CacheRequest cache = new CacheRequest();
            cache.TreeScope = TreeScope.Element;
            cache.TreeFilter = Automation.ControlViewCondition;
            cache.Add(AutomationElement.NameProperty);
            cache.Add(AutomationElement.ControlTypeProperty);
            cache.Add(AutomationElement.IsEnabledProperty);
            cache.Add(AutomationElement.IsPasswordProperty);
            cache.Add(AutomationElement.IsValuePatternAvailableProperty);
            cache.Add(AutomationElement.IsTextPatternAvailableProperty);
            cache.Add(ValuePattern.ValueProperty);

            AutomationElement start;
            if (request.ContainsKey("from"))
            {
                AutomationElement saved = FromRef(target, request["from"] as string);
                start = saved.GetUpdatedCache(cache);
            }
            else
            {
                start = AutomationElement.FromHandle(target.Hwnd).GetUpdatedCache(cache);
            }

            Walk walk = new Walk();
            walk.Walker = TreeWalker.ControlViewWalker;
            walk.Cache = cache;
            walk.MaxDepth = (int)Clamp(Number(request, "maxDepth", TREE_MAX_DEPTH), 0, TREE_MAX_DEPTH);
            walk.MaxNodes = (int)Clamp(Number(request, "maxNodes", TREE_MAX_NODES), 1, TREE_MAX_NODES);
            walk.NameMax = (int)Clamp(Number(request, "nameMax", 120), 0, 2000);
            walk.ValueMax = (int)Clamp(Number(request, "valueMax", 200), 0, 2000);
            walk.BudgetMs = (long)Clamp(Number(request, "budgetMs", 12000), 100, 60000);
            walk.Clock = Stopwatch.StartNew();
            walk.Visit(start, 0);

            Save(target.Key, snapshotId, walk.Elements);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["window"] = WindowInfo(target.Hwnd, target.Pid, GetForegroundWindow());
            result["truncated"] = walk.Truncated;
            result["elements"] = walk.Rows;
            return result;
        }

        /// <summary>The element a ref names in this window's latest snapshot; stale for any other ref.</summary>
        private static AutomationElement FromRef(Target target, string reference)
        {
            if (reference == null) throw new Refusal("stale", "the ref is not text");
            int colon = reference.LastIndexOf(':');
            if (colon <= 0) throw new Refusal("stale", "the ref has no index");
            string snapshotId = reference.Substring(0, colon);
            int index;
            if (!int.TryParse(reference.Substring(colon + 1), NumberStyles.None, CultureInfo.InvariantCulture, out index))
                throw new Refusal("stale", "the ref's index is not a number");
            Snapshot latest;
            if (!snapshots.TryGetValue(target.Key, out latest) || latest.Id != snapshotId)
                throw new Refusal("stale", "the ref is not from this window's latest snapshot");
            if (index < 0 || index >= latest.Elements.Count)
                throw new Refusal("stale", "the ref's index is out of range");
            return latest.Elements[index];
        }

        private static void Save(string key, string snapshotId, List<AutomationElement> elements)
        {
            Snapshot snapshot = new Snapshot();
            snapshot.Id = snapshotId;
            snapshot.Elements = elements;
            snapshots[key] = snapshot;
            snapshotOrder.Remove(key);
            snapshotOrder.Add(key);
            while (snapshotOrder.Count > SNAPSHOTS_KEPT)
            {
                snapshots.Remove(snapshotOrder[0]);
                snapshotOrder.RemoveAt(0);
            }
        }

        // ---- screenshot ---------------------------------------------------------------------------

        private static Dictionary<string, object> Screenshot(Dictionary<string, object> request)
        {
            Target target = Check(request);
            IntPtr hwnd = target.Hwnd;
            int maxEdge = (int)Clamp(Number(request, "maxEdge", SCREENSHOT_MAX_EDGE), 16, SCREENSHOT_MAX_EDGE);
            if (IsIconic(hwnd)) throw new Refusal("failed", "minimized");

            // The visible frame (DWM's bounds leave out the invisible resize border), else the window rectangle.
            RECT outer;
            bool haveOuter = GetWindowRect(hwnd, out outer);
            RECT frame;
            bool haveFrame = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT))) == 0;
            if (!haveFrame)
            {
                if (!haveOuter) throw new Refusal("failed", "the window has no rectangle");
                frame = outer;
            }
            if (!haveOuter) outer = frame;
            int width = frame.Right - frame.Left;
            int height = frame.Bottom - frame.Top;
            if (width <= 0 || height <= 0) throw new Refusal("failed", "the window has an empty rectangle");

            Bitmap image = Printed(hwnd, outer, frame);
            if (image == null)
            {
                // Copying the screen could pick up whatever lies on top, so only the foreground window
                // is copied that way, and only what of it is on the primary display.
                if (GetForegroundWindow() != hwnd) throw new Refusal("failed", "not_visible");
                Rectangle area = Rectangle.Intersect(new Rectangle(frame.Left, frame.Top, width, height), System.Windows.Forms.Screen.PrimaryScreen.Bounds);
                if (area.Width <= 0 || area.Height <= 0) throw new Refusal("failed", "not_visible");
                image = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppRgb);
                using (Graphics graphics = Graphics.FromImage(image))
                {
                    graphics.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
                }
            }

            try
            {
                int longEdge = Math.Max(image.Width, image.Height);
                if (longEdge > maxEdge)
                {
                    double scale = (double)maxEdge / longEdge;
                    int scaledWidth = Math.Max(1, (int)Math.Round(image.Width * scale));
                    int scaledHeight = Math.Max(1, (int)Math.Round(image.Height * scale));
                    Bitmap scaled = new Bitmap(scaledWidth, scaledHeight, PixelFormat.Format32bppRgb);
                    using (Graphics graphics = Graphics.FromImage(scaled))
                    {
                        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        graphics.DrawImage(image, 0, 0, scaledWidth, scaledHeight);
                    }
                    image.Dispose();
                    image = scaled;
                }
                using (MemoryStream png = new MemoryStream())
                {
                    image.Save(png, ImageFormat.Png);
                    Dictionary<string, object> result = new Dictionary<string, object>();
                    result["base64"] = Convert.ToBase64String(png.ToArray());
                    result["width"] = image.Width;
                    result["height"] = image.Height;
                    return result;
                }
            }
            finally
            {
                image.Dispose();
            }
        }

        /// <summary>The window drawn by PrintWindow and cut to its frame; null when it drew nothing usable.</summary>
        private static Bitmap Printed(IntPtr hwnd, RECT outer, RECT frame)
        {
            int outerWidth = outer.Right - outer.Left;
            int outerHeight = outer.Bottom - outer.Top;
            if (outerWidth <= 0 || outerHeight <= 0) return null;
            Bitmap canvas = new Bitmap(outerWidth, outerHeight, PixelFormat.Format32bppRgb);
            bool drawn;
            using (Graphics graphics = Graphics.FromImage(canvas))
            {
                IntPtr hdc = graphics.GetHdc();
                try
                {
                    drawn = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
            }
            if (!drawn || AllBlack(canvas))
            {
                canvas.Dispose();
                return null;
            }
            Rectangle crop = Rectangle.Intersect(
                new Rectangle(frame.Left - outer.Left, frame.Top - outer.Top, frame.Right - frame.Left, frame.Bottom - frame.Top),
                new Rectangle(0, 0, outerWidth, outerHeight));
            if (crop.Width <= 0 || crop.Height <= 0 || (crop.Width == outerWidth && crop.Height == outerHeight)) return canvas;
            Bitmap cut = canvas.Clone(crop, PixelFormat.Format32bppRgb);
            canvas.Dispose();
            return cut;
        }

        /// <summary>A 16 x 16 grid of samples that are all the same black: PrintWindow drew nothing.</summary>
        private static bool AllBlack(Bitmap image)
        {
            for (int row = 0; row < 16; row++)
            {
                for (int column = 0; column < 16; column++)
                {
                    int x = Math.Min(image.Width - 1, (int)((column + 0.5) * image.Width / 16));
                    int y = Math.Min(image.Height - 1, (int)((row + 0.5) * image.Height / 16));
                    Color color = image.GetPixel(x, y);
                    if (color.R != 0 || color.G != 0 || color.B != 0) return false;
                }
            }
            return true;
        }

        // ---- Small things -------------------------------------------------------------------------

        private static Dictionary<string, object> Ok(object id, Dictionary<string, object> result)
        {
            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["id"] = id;
            reply["ok"] = true;
            reply["result"] = result;
            return reply;
        }

        private static Dictionary<string, object> Fail(object id, string code, string message)
        {
            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["id"] = id;
            reply["ok"] = false;
            reply["code"] = code;
            reply["message"] = Clip(message ?? "", MESSAGE_MAX);
            return reply;
        }

        private static string Describe(Exception e)
        {
            return Clip(e.GetType().Name + ": " + e.Message, MESSAGE_MAX);
        }

        /// <summary>At most `max` UTF-16 units, never ending inside a surrogate pair.</summary>
        private static string Clip(string text, int max)
        {
            if (text == null) return "";
            if (text.Length <= max) return text;
            int end = max;
            if (end > 0 && char.IsHighSurrogate(text[end - 1])) end--;
            return text.Substring(0, end);
        }

        /// <summary>A JSON number from the request, or `fallback` when the key is missing or not a number.</summary>
        private static double Number(Dictionary<string, object> request, string key, double fallback)
        {
            object value;
            if (!request.TryGetValue(key, out value) || value == null) return fallback;
            if (value is int || value is long || value is decimal || value is double)
            {
                double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return double.IsNaN(number) ? fallback : number;
            }
            return fallback;
        }

        private static double Clamp(double value, double low, double high)
        {
            return Math.Max(low, Math.Min(high, value));
        }
    }
}
