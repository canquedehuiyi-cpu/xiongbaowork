/**
 * The desktop-control protocol the runner and the server share (docs/specs/2026-11-07-desktop-control.md,
 * Phase 1; docs/specs/2026-11-12-desktop-write-agent-desktop.md, Phase 2).
 *
 * Two read actions, `desktop.windows` and `desktop.snapshot`, and three session actions
 * (`desktop.session_start`, `desktop.session_status`, `desktop.session_end`, plan Task 13): the
 * device owns the desktop session, so the server hands it a token and asks it what is current. A
 * write action joins this set only with the spec revision that brings it.
 *
 * The Chinese copy is the spec's §5 and the plan's design decision 8, word for word. The server
 * shows it to the owner and the model as it stands.
 */

export const DESKTOP_ACTION_PREFIX = "desktop.";

/** Every desktop action a runner accepts. Anything else under the prefix is refused as unsupported. */
export const DESKTOP_ACTIONS: ReadonlySet<string> = new Set([
  "desktop.windows",
  "desktop.snapshot",
  "desktop.session_start",
  "desktop.session_status",
  "desktop.session_end",
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
  /** One agent-desktop command, from spawn to its envelope. */
  adCommandTimeoutMs: 20_000,
  /** One agent-desktop `snapshot`. */
  adSnapshotTimeoutMs: 10_000,
  /** agent-desktop's state directory is wiped after this long without a command. */
  adIdleWipeMs: 600_000,
  /** Window ids the runner keeps a mapping for; the oldest is dropped beyond this. */
  windowIdsKept: 200,
  /** A desktop session ends after this long without a write. */
  sessionIdleMs: 900_000,
  /** And after this long in all, however busy. */
  sessionMaxMs: 3_600_000,
  /** How long the runner waits for the device to pause its mouse check before a `--headed` step. */
  headedAckMs: 1_000,
  /** How long a new session waits for the device's banner, stop key and mouse check to be up. */
  sessionReadyMs: 2_000,
} as const;

/** The agent-desktop release the runner is built against; any other version is refused. */
export const AGENT_DESKTOP_VERSION = "1.2.0";

export type DesktopEngine = "legacy" | "agent-desktop";
export type DesktopPlatform = "windows" | "macos" | "linux";

/** The desktop platform for a Node `process.platform`, or nothing for a system with no desktop engine. */
export function desktopPlatformOf(
  nodePlatform: string,
): DesktopPlatform | undefined {
  switch (nodePlatform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

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
  | "unsupported_platform"
  | "mac_permission"
  | "linux_bus"
  | "policy_denied"
  | "ambiguous"
  | "not_actionable"
  | "stopped"
  | "session_expired"
  | "no_session"
  | "no_control_channel"
  | "headed_unconfirmed"
  | "read_only_linux"
  | "read_only_windows"
  | "guard_unready"
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
    case "unsupported_platform":
      return "这台设备的系统不支持桌面操作。";
    case "mac_permission":
      return "这台 Mac 还没有允许设备端操作界面，请在设备端的『桌面操作』里开启。";
    case "linux_bus":
      return "这台 Linux 电脑没有开启无障碍总线（AT-SPI），看不到窗口。请在系统设置里打开辅助功能后重新登录。";
    case "policy_denied":
      return "这个控件不支持直接操作，请换一种方式（例如用快捷键）。";
    case "ambiguous":
      return "这个控件没有可识别的名字，无法确定要操作哪一个。";
    case "not_actionable":
      return "这个控件不能直接操作，请换一个控件或用快捷键。";
    case "stopped":
      return "用户已停止桌面操作，需要重新获得授权。";
    case "session_expired":
      return "桌面会话已结束（15 分钟没有操作或已满 60 分钟），需要重新获得授权。";
    case "no_session":
      return "没有进行中的桌面会话，需要重新获得授权。";
    case "no_control_channel":
      return "只有在设备端应用里运行时才能操作桌面（需要提示条和停止键）。";
    case "headed_unconfirmed":
      return "设备端没有确认暂停『动鼠标即停』，为安全起见没有执行这一步。";
    case "read_only_linux":
      return "这台 Linux 电脑目前只能查看，不能操作界面。";
    case "read_only_windows":
      return "这台 Windows 电脑暂时只能查看，操作界面的功能还在验收。";
    case "guard_unready":
      return "设备端没能显示提示条或注册停止键，为安全起见没有开始操作。";
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
 * A window id: the phase-1 `w<window handle in decimal>-<process id>` or the agent-desktop engine's
 * `a<16 hex>`. The handle is signed: a 64-bit process sign-extends a window handle, so one with its
 * top bit set reads as negative (`w-2147483000-77`).
 */
export const DESKTOP_WINDOW_ID =
  /^(?:w-?[1-9]\d{0,19}-[1-9]\d{0,9}|a[0-9a-f]{16})$/;

/** The phase-1 form alone; `parseWindowId` splits only this one. */
const LEGACY_WINDOW_ID = /^w-?[1-9]\d{0,19}-[1-9]\d{0,9}$/;

export function isAgentWindowId(id: string): boolean {
  return typeof id === "string" && /^a[0-9a-f]{16}$/.test(id);
}

export function windowIdOf(hwnd: string, pid: number): string {
  return `w${hwnd}-${pid}`;
}

export function parseWindowId(
  id: unknown,
): { hwnd: string; pid: number } | undefined {
  if (typeof id !== "string" || !LEGACY_WINDOW_ID.test(id)) return undefined;
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
  /** The display it is on, as an index into list-displays (0 is the primary); agent-desktop engine only. */
  display?: number;
  bounds?: { x: number; y: number; width: number; height: number };
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
  /** A single-line text box (as opposed to a multi-line one). */
  singleLine?: true;
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
