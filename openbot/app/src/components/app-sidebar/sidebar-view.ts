import { readStored } from "@/lib/storage-migrate";

/**
 * Which list the sidebar shows: upstream's 会话 (every conversation, newest first), or 熊宝 v0.2.7's
 * 员工 / 群组 roster, where a 单聊 is reached from its employee and every group chat is a row in the single 群组 section.
 * 会话 is the default; the choice is remembered per browser.
 */
export type SidebarView = "chats" | "wakers" | "groups";

const VIEW_STORAGE_KEY = "xiongbao-sidebar-view";

/** Said on `window` when something outside the sidebar asks it to show another list. */
const VIEW_EVENT = "xiongbao:sidebar-view";

export function readView(): SidebarView {
  try {
    const stored = readStored(VIEW_STORAGE_KEY);
    return stored === "wakers" || stored === "groups" ? stored : "chats";
  } catch {
    return "chats";
  }
}

export function writeView(view: SidebarView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // A browser that refuses storage still switches; it just opens on 会话 next time.
  }
}

/**
 * Switches the sidebar to `view` from anywhere in the app, and remembers it as a click on the switch
 * would: the 「去员工列表」 a new person is shown where there is nothing yet (召唤员工).
 */
export function showSidebarView(view: SidebarView) {
  writeView(view);
  window.dispatchEvent(
    new CustomEvent<SidebarView>(VIEW_EVENT, { detail: view }),
  );
}

/** Calls `listener` whenever {@link showSidebarView} is asked for a list; answers the unsubscribe. */
export function onSidebarView(listener: (view: SidebarView) => void) {
  const handle = (event: Event) =>
    listener((event as CustomEvent<SidebarView>).detail);
  window.addEventListener(VIEW_EVENT, handle);
  return () => window.removeEventListener(VIEW_EVENT, handle);
}
