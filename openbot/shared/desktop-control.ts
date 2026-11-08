/**
 * The desktop-viewing protocol the runner and the server share (docs/specs/2026-11-07-desktop-control.md,
 * Phase 1: read only).
 *
 * READ ONLY. There are exactly two actions, `desktop.windows` and `desktop.snapshot`. Nothing here
 * names a click, a keystroke, a launch or a focus change, and nothing should: a write action is a
 * later spec revision, not a new entry in this set.
 *
 * The Chinese copy is the spec's §5 and the plan's design decision 8, word for word. The server
 * shows it to the owner and the model as it stands.
 */

export const DESKTOP_ACTION_PREFIX = "desktop.";

/** Every desktop action a runner accepts. Anything else under the prefix is refused as unsupported. */
export const DESKTOP_ACTIONS: ReadonlySet<string> = new Set([
  "desktop.windows",
  "desktop.snapshot",
]);

export const DESKTOP_LIMITS = {
  /** UIA tree depth below the starting element. */
  treeMaxDepth: 12,
  treeMaxNodes: 800,
  /** One request to the helper, by default. */
  requestTimeoutMs: 15_000,
  /** Starting the helper, `Add-Type` compilation included, until its ready line. */
  startTimeoutMs: 30_000,
  /** The helper exits after this long without a request. */
  helperIdleMs: 600_000,
  /** Longest side of a window screenshot, in pixels (PNG). */
  screenshotMaxEdge: 1280,
  nameMax: 120,
  valueMax: 200,
  titleMax: 200,
  windowsMax: 50,
  /** Windows the helper keeps a latest snapshot for; the oldest is dropped beyond this. */
  snapshotsKept: 16,
  /** Time budget for one tree walk inside the helper; past it the walk stops and is `truncated`. */
  walkBudgetMs: 12_000,
} as const;

export type DesktopErrorCode =
  | "not_windows"
  | "no_window"
  | "stale"
  | "elevated"
  | "start_failed"
  | "timeout"
  | "session0"
  | "sensitive"
  | "unsupported"
  | "failed";

/** The Chinese text for a desktop failure. `detail` is the stderr tail, seconds, word or details. */
export function desktopMessage(
  code: DesktopErrorCode,
  detail?: string,
): string {
  switch (code) {
    case "not_windows":
      return "这台设备不是 Windows，暂不支持桌面操作。";
    case "no_window":
      return "找不到这个窗口，请重新列出窗口。";
    case "stale":
      return "界面已变化，请重新读取窗口。";
    case "elevated":
      return "这个窗口需要管理员权限，员工无法操作。";
    case "start_failed":
      return detail ? `桌面助手启动失败：${detail}` : "桌面助手启动失败。";
    case "timeout":
      return `桌面助手没有在 ${detail || String(DESKTOP_LIMITS.requestTimeoutMs / 1000)} 秒内完成这一步。`;
    case "session0":
      return "设备端运行在没有桌面的后台会话里，看不到窗口。请在已登录的桌面上运行设备端。";
    case "sensitive":
      return `这个窗口的标题刚刚变成含「${detail || "敏感词"}」，需要先获得批准才能读取。请重新列出窗口后再试。`;
    case "unsupported":
      return "设备端目前只能列出和读取窗口，不能执行这个桌面动作。";
    case "failed":
      return detail ? `桌面操作没有成功：${detail}` : "桌面操作没有成功。";
  }
}

/** Reading a window whose title has one of these needs the owner's approval first (spec §4.2). */
export const DESKTOP_WINDOW_WORDS: readonly string[] = [
  "密码",
  "银行",
  "支付",
  "password",
  "bank",
  "paypal",
];

/** The first of `words` that `text` contains, ignoring case; an empty word never matches. */
export function sensitiveWord(
  text: string,
  words: readonly string[],
): string | undefined {
  const haystack = text.toLowerCase();
  return words.find(
    (word) => word !== "" && haystack.includes(word.toLowerCase()),
  );
}

/**
 * A control's ref: `${snapshotId}:${index}`, where the snapshot id is `${prefix}-${n}` and the prefix
 * is six hex digits drawn afresh for every helper process. A ref minted by an earlier helper carries
 * a prefix that no longer matches and is refused as stale.
 */
export const DESKTOP_REF = /^[0-9a-f]{6}-[1-9]\d{0,8}:\d{1,4}$/;

/**
 * A window id: `w<window handle in decimal>-<process id>`. The handle is signed: a 64-bit process
 * sign-extends a window handle, so one with its top bit set reads as negative (`w-2147483000-77`).
 */
export const DESKTOP_WINDOW_ID = /^w-?[1-9]\d{0,19}-[1-9]\d{0,9}$/;

export function windowIdOf(hwnd: string, pid: number): string {
  return `w${hwnd}-${pid}`;
}

export function parseWindowId(
  id: unknown,
): { hwnd: string; pid: number } | undefined {
  if (typeof id !== "string" || !DESKTOP_WINDOW_ID.test(id)) return undefined;
  // The process id never has a sign, so the last dash is the separator.
  const dash = id.lastIndexOf("-");
  return { hwnd: id.slice(1, dash), pid: Number(id.slice(dash + 1)) };
}

export type DesktopWindow = {
  windowId: string;
  title: string;
  process: string;
  focused: boolean;
  minimized: boolean;
};

export type DesktopElement = {
  ref: string;
  type: string;
  name: string;
  depth: number;
  value?: string;
  disabled?: true;
  /** A password box: its value is never read. */
  password?: true;
};

export type DesktopImage = { base64: string; width: number; height: number };

/** What replaces a screenshot the approval store did not keep. */
export const DESKTOP_IMAGE_NOT_KEPT = "截图未保存，请重新读取窗口。";

/**
 * A snapshot as the approval store keeps it: the picture's bytes dropped (they can be megabytes, of
 * exactly the windows that needed approval), its size kept, and a note for whoever replays it.
 */
export function snapshotForStorage<
  T extends { image?: unknown; imageError?: string },
>(snapshot: T): T {
  const image = snapshot?.image as Partial<DesktopImage> | undefined;
  if (!image || typeof image !== "object") return snapshot;
  const { width, height } = image;
  return {
    ...snapshot,
    image: { width, height },
    imageError: snapshot.imageError ?? DESKTOP_IMAGE_NOT_KEPT,
  };
}

export type DesktopSnapshot = {
  snapshotId: string;
  window: DesktopWindow;
  truncated: boolean;
  elements: DesktopElement[];
  image?: DesktopImage;
  /** Why there is no image when one was asked for; the tree is returned all the same. */
  imageError?: string;
};
