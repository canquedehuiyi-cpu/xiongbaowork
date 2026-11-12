/**
 * The desktop-control protocol the runner and the server share (docs/specs/2026-11-07-desktop-control.md,
 * Phase 1; docs/specs/2026-11-12-desktop-write-agent-desktop.md, Phase 2).
 *
 * Two read actions, `desktop.windows` and `desktop.snapshot`; three session actions
 * (`desktop.session_start`, `desktop.session_status`, `desktop.session_end`, plan Task 13): the
 * device owns the desktop session, so the server hands it a token and asks it what is current; and
 * four write actions inside a session (`desktop.click`, `desktop.type`, `desktop.key`,
 * `desktop.focus`, plan Task 21). A further write joins this set only with the task that brings it.
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
  "desktop.click",
  "desktop.type",
  "desktop.key",
  "desktop.focus",
]);

/** The write actions among them: each runs inside the device's desktop session (`DesktopWritePayload`). */
export const DESKTOP_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "desktop.click",
  "desktop.type",
  "desktop.key",
  "desktop.focus",
]);

/**
 * What every desktop write carries. `session` is the token the server minted; `approved` says the
 * owner approved this very step; `actionWords` is the team's list (blank or empty means the default,
 * `desktopActionWordsOf`); `approvedTitle` is the window title the owner saw on the card, when the
 * step was asked about. The device reads the coworker from the transport, never from `botId` here.
 */
export type DesktopWriteCommon = {
  session: string;
  botId: string;
  actorId: string;
  approved: boolean;
  actionWords: string[];
  approvedTitle?: string;
};
/** One write's payload: click `{ ref }`, type `{ ref, text, mode }`, key `{ windowId, keys }`, focus `{ windowId }`. */
export type DesktopWritePayload = DesktopWriteCommon &
  (
    | { ref: string }
    | { ref: string; text: string; mode: "replace" | "append" }
    | { windowId: string; keys: string }
    | { windowId: string }
  );

/** A write that went through. `note` tells the model the window may have changed. */
export type DesktopWriteOutput = {
  /** A real pointer or keyboard was used (`--headed`, or a key press). */
  physical: boolean;
  durationMs: number;
  delivery: "verified" | "unverified";
  window: { windowId: string; title: string; process: string };
  control?: { type: string; name: string };
  note: string;
};

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
  /** The longest text one desktop write may type, in UTF-8 bytes; longer is refused at the server. */
  textMaxBytes: 9_000,
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
  | "system_keys"
  | "needs_approval"
  | "password_field"
  | "not_foreground"
  | "outcome_unknown"
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
    case "system_keys":
      return `这个组合键（${detail ?? ""}）是系统级的，员工不能按。`;
    case "needs_approval":
      return `这一步需要先获得批准（${detail ?? ""}）。请重新读取窗口后再试。`;
    case "password_field":
      return "这是密码框，员工不能往里输入。请用 computer_request_secret 让主人自己输入。";
    case "not_foreground":
      return "这个窗口不在前台，请先用 computer_desktop_focus 把它切到前台。";
    case "outcome_unknown":
      return "不确定这一步是否已经生效，请先重新读取窗口确认。";
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
 * The words that make clicking a control ask every time (spec §3, plan design decision 11). A team
 * may replace them with its own list (`approval_team_settings.desktop_action_words`); an empty list
 * there means these.
 */
export const DEFAULT_DESKTOP_ACTION_WORDS: readonly string[] = [
  "发送",
  "删除",
  "付款",
  "支付",
  "提交",
  "确认支付",
  "转账",
  "购买",
  "下单",
  "发布",
  "撤回",
  "注销",
  "send",
  "delete",
  "pay",
  "submit",
  "purchase",
];

const ASCII_WORD = /^[\x20-\x7e]+$/;

/**
 * The first of `words` that `text` holds, for a desktop write (design decision 11): a word with any
 * non-ASCII character (Chinese) matches as a substring; a plain ASCII word matches only as a whole
 * word, ignoring case, so `pay` is in `Pay now` and not in `Display`. Blank words never match.
 */
export function desktopWordHit(
  text: string,
  words: readonly string[],
): string | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  const lower = text.toLowerCase();
  return words.find((word) => {
    if (typeof word !== "string" || word.trim() === "") return false;
    const needle = word.toLowerCase();
    if (!ASCII_WORD.test(word)) return lower.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lower);
  });
}

/**
 * The first of `DESKTOP_WINDOW_WORDS` a window's title holds, for a desktop write (design decision 11
 * as revised by the coordinator): a substring match, as phase 1 reads windows, or a whole-word match,
 * whichever hits. A window title errs towards asking (`1Password`, `Online-Banking`); only a control's
 * action words keep the whole-word reading alone. The device checks with this same function.
 */
export function desktopWindowWordHit(title: string): string | undefined {
  if (typeof title !== "string") return undefined;
  return (
    sensitiveWord(title, DESKTOP_WINDOW_WORDS) ??
    desktopWordHit(title, DESKTOP_WINDOW_WORDS)
  );
}

/**
 * The action words in force: the team's list without blank words, or the default when nothing is
 * left of it. A blank word is dropped rather than read as matching every control or none.
 */
export function desktopActionWordsOf(
  team: readonly string[] | undefined,
): readonly string[] {
  const words = (team ?? []).filter(
    (word) => typeof word === "string" && word.trim() !== "",
  );
  return words.length > 0 ? words : DEFAULT_DESKTOP_ACTION_WORDS;
}

/*
 * KEYS (design decision 10). Lower case after normalising, joined by `+`: up to three modifiers
 * (`ctrl`, `alt`, `shift`, `cmd`, `win`; `meta` and `super` are `win`) and one key. The runner turns
 * these names into agent-desktop's own.
 */
const MODIFIER_NAMES = "ctrl|alt|shift|cmd|win|meta|super";
const KEY_NAMES =
  "[a-z0-9]|[-=\\[\\];',./`\\\\]|f[1-9]|f1[0-2]|enter|return|escape|esc|tab|space|backspace|delete|forwarddelete|insert|home|end|pageup|pagedown|up|down|left|right|comma|period|slash|semicolon|quote|leftbracket|rightbracket|backslash|minus|equal|grave";

/** A key combination's syntax, either case: what a desktop key tool accepts at all. */
export const DESKTOP_KEYS = new RegExp(
  `^(?:(?:${MODIFIER_NAMES})\\+){0,3}(?:${KEY_NAMES})$`,
  "i",
);

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "cmd", "win"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];
const MODIFIER_ALIAS: Record<string, Modifier> = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  cmd: "cmd",
  win: "win",
  meta: "win",
  super: "win",
};
const KEY_ALIAS: Record<string, string> = { return: "enter", esc: "escape" };

/** Refused outright with `system_keys`, and so is any of these with more modifiers held. */
const SYSTEM_KEYS = [
  "win+r",
  "win+l",
  "win+d",
  "win+x",
  "win+e",
  "alt+tab",
  "ctrl+shift+escape",
  "ctrl+alt+delete",
  "cmd+space",
  "ctrl+cmd+q",
  "cmd+shift+q",
  "cmd+alt+shift+q",
  // Added by the coordinator's ruling (they only ever refuse more): force quit, task view, the window
  // menu, the start menu.
  "cmd+alt+escape",
  "win+tab",
  "alt+space",
  "ctrl+escape",
];
/** Closing a program: asked every time, like deleting; with more modifiers held too. */
const CLOSE_KEYS = ["alt+f4", "ctrl+f4", "cmd+q", "cmd+w", "ctrl+w"];
/** The only two sent with `--force`, once approved, and only exactly these. */
const FORCED_KEYS: ReadonlySet<string> = new Set(["alt+f4", "cmd+q"]);

export type DesktopKeyClass = {
  kind: "system" | "close" | "submit" | "plain";
  normalized: string;
  force: boolean;
};

type ParsedKeys = { modifiers: ReadonlySet<Modifier>; key: string };

function parseKeys(keys: string): ParsedKeys | undefined {
  if (typeof keys !== "string" || !DESKTOP_KEYS.test(keys)) return undefined;
  const parts = keys.toLowerCase().split("+");
  const last = parts.pop() as string;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIAS[part] as Modifier;
    if (modifiers.has(modifier)) return undefined;
    modifiers.add(modifier);
  }
  return { modifiers, key: KEY_ALIAS[last] ?? last };
}

function normalise(parsed: ParsedKeys): string {
  return [
    ...MODIFIER_ORDER.filter((modifier) => parsed.modifiers.has(modifier)),
    parsed.key,
  ].join("+");
}

/** Whether `parsed` is `combo` with any further modifiers held. */
function holds(parsed: ParsedKeys, combo: string): boolean {
  const want = parseKeys(combo) as ParsedKeys;
  if (want.key !== parsed.key) return false;
  for (const modifier of want.modifiers)
    if (!parsed.modifiers.has(modifier)) return false;
  return true;
}

function kindOf(parsed: ParsedKeys): DesktopKeyClass["kind"] {
  if (SYSTEM_KEYS.some((combo) => holds(parsed, combo))) return "system";
  if (CLOSE_KEYS.some((combo) => holds(parsed, combo))) return "close";
  if (
    parsed.key === "enter" &&
    (parsed.modifiers.size === 0 ||
      ["ctrl", "cmd", "alt"].some((modifier) =>
        parsed.modifiers.has(modifier as Modifier),
      ))
  )
    return "submit";
  return "plain";
}

const KIND_RANK: Record<DesktopKeyClass["kind"], number> = {
  plain: 0,
  submit: 1,
  close: 2,
  system: 3,
};

/**
 * What pressing `keys` is (design decision 10): `system` (refused, never asked), `close` (asked;
 * `force` only for exactly `alt+f4` and `cmd+q`), `submit` (Enter alone or with ctrl, cmd or alt;
 * shift+Enter is a new line) or `plain`. Undefined when `keys` is not a combination at all.
 *
 * agent-desktop reads `meta` as the Command key on a Mac, so a combination holding `win` is also
 * read as if it held `cmd`, and the stricter reading wins: `meta+q` is closing a program there.
 */
export function classifyDesktopKeys(keys: string): DesktopKeyClass | undefined {
  const parsed = parseKeys(keys);
  if (!parsed) return undefined;
  const normalized = normalise(parsed);
  let kind = kindOf(parsed);
  if (parsed.modifiers.has("win")) {
    const asCmd = new Set(parsed.modifiers);
    asCmd.delete("win");
    asCmd.add("cmd");
    const other = kindOf({ modifiers: asCmd, key: parsed.key });
    if (KIND_RANK[other] > KIND_RANK[kind]) kind = other;
  }
  return {
    kind,
    normalized,
    force: kind === "close" && FORCED_KEYS.has(normalized),
  };
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
