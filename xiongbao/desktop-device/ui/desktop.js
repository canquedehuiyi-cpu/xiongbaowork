/**
 * The 「桌面操作」 card and the 「关于」 notices, with nothing that needs a window, so
 * `tests/desktop-card.test.ts` can check them under Bun. `main.js` draws them on the page.
 *
 * The card says whether this computer lets the device app read and operate other programs' windows.
 * The shell (`src-tauri/src/desktop_permissions.rs`) asks the bundled agent-desktop: on macOS for the
 * two grants (accessibility, needed to read and to act; screen recording, needed only for
 * screenshots), on Linux whether the accessibility bus (AT-SPI) answers. Windows needs no grant.
 * While the card is visible it asks again every 3 seconds, so a switch turned on in System Settings
 * shows up without anybody pressing anything.
 */

/** How often the card asks again while it is visible. */
export const POLL_MS = 3000;

/** Linux without an accessibility bus (design decision 13, `linux_bus`). */
export const LINUX_BUS =
  "这台 Linux 电脑没有开启无障碍总线（AT-SPI），看不到窗口。请在系统设置里打开辅助功能后重新登录。";

const TITLE = "桌面操作";

/** A state agent-desktop reported that needs nothing more from the person at this computer. */
function allowed(state) {
  return state === "granted" || state === "not_required";
}

/**
 * @param {string} label
 * @param {string | undefined} state
 * @param {"accessibility" | "screen"} kind
 */
function row(label, state, kind) {
  const ok = allowed(state);
  return {
    label,
    status: ok ? "已允许" : "未允许",
    allowed: ok,
    action: ok ? null : { text: "去开启", kind },
  };
}

/**
 * What the card shows for the shell's `desktop_permissions` answer.
 *
 * @param {{ platform: string, accessibility?: string, screenRecording?: string, atSpi?: boolean | null }} view
 */
export function describeDesktop(view) {
  if (view.platform === "macos") {
    const rows = [
      row("辅助功能（读界面和动手都要）", view.accessibility, "accessibility"),
      row("屏幕录制（只有截图要，不给也能用）", view.screenRecording, "screen"),
    ];
    return {
      title: TITLE,
      rows,
      note: null,
      guide: rows.every((r) => r.allowed)
        ? null
        : {
            image: "mac-accessibility.svg",
            text: "找到熊宝数字员工设备端，打开开关",
          },
      // macOS often applies a new grant only to a process started after it.
      restart: { text: "开启后仍显示未允许时，", button: "重新打开设备端" },
    };
  }
  if (view.platform === "linux") {
    return {
      title: `${TITLE}（试用，只能查看）`,
      rows: [],
      note:
        view.atSpi === false
          ? LINUX_BUS
          : view.atSpi === true
            ? "无障碍总线（AT-SPI）已开启，可以查看这台电脑上的窗口。"
            : null,
      guide: null,
      restart: null,
    };
  }
  return {
    title: TITLE,
    rows: [],
    note: view.platform === "windows" ? "Windows 不需要授权。" : null,
    guide: null,
    restart: null,
  };
}

/**
 * Open the System Settings pane for one grant (macOS only; the shell refuses elsewhere).
 *
 * @param {"accessibility" | "screen"} kind
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 * @returns {Promise<{ error?: string }>}
 */
export async function openSettings(kind, invoke) {
  try {
    await invoke("open_desktop_settings", { kind });
    return {};
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Start the device app again, for a grant macOS applies only to a new process.
 *
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 * @returns {Promise<{ error?: string }>}
 */
export async function restartApp(invoke) {
  try {
    await invoke("restart_app");
    return {};
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * The card: asks the shell when it becomes visible and every `POLL_MS` while it stays visible, never
 * twice at once, and hands each answer (or `{ error }`) to `draw`.
 *
 * @param {{
 *   invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
 *   draw: (described: ReturnType<typeof describeDesktop> | { error: string }) => void,
 *   timers?: { setInterval: (run: () => void, ms: number) => unknown, clearInterval: (id: any) => void },
 * }} options
 */
export function createDesktopCard({ invoke, draw, timers = globalThis }) {
  let timer = null;
  let asking = false;

  async function refresh() {
    if (asking) return;
    asking = true;
    try {
      const view = await invoke("desktop_permissions");
      // Hidden meanwhile: nobody is looking, and the next showing asks again.
      if (timer !== null) draw(describeDesktop(/** @type {any} */ (view)));
    } catch (error) {
      if (timer !== null) draw({ error: String(error) });
    } finally {
      asking = false;
    }
  }

  return {
    refresh,
    /** @param {boolean} visible */
    setVisible(visible) {
      if (visible && timer === null) {
        timer = timers.setInterval(() => void refresh(), POLL_MS);
        void refresh();
      } else if (!visible && timer !== null) {
        timers.clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * The bundled files a 「关于」 entry shows, from its `data-notice` (names separated by spaces).
 *
 * @param {string | undefined} attribute
 */
export function noticeNames(attribute) {
  return (attribute ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Read bundled notices through the shell, which reads only its own list of them, one after another.
 *
 * @param {string[]} names
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 * @returns {Promise<{ text: string } | { error: string }>}
 */
export async function readNotice(names, invoke) {
  const texts = [];
  try {
    for (const name of names) {
      texts.push(String(await invoke("read_bundled_text", { name })));
    }
  } catch (error) {
    return { error: String(error) };
  }
  return { text: texts.join("\n\n") };
}

/**
 * Fill a 「关于」 `<details>`'s `<pre>` the first time it is opened. Text only: a notice is never
 * markup. A failed read is shown, and tried again on the next opening.
 *
 * @param {{ open: boolean, dataset: { notice?: string }, querySelector: (s: string) => any, addEventListener: (type: string, listener: () => unknown) => void }} details
 * @param {(command: string, args?: Record<string, unknown>) => Promise<unknown>} invoke
 */
export function wireNotice(details, invoke) {
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const pre = details.querySelector("pre");
    const result = await readNotice(
      noticeNames(details.dataset.notice),
      invoke,
    );
    if ("error" in result) {
      loaded = false;
      if (pre) pre.textContent = result.error;
    } else if (pre) {
      pre.textContent = result.text;
    }
  });
}
