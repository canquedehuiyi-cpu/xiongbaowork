import { useCallback, useSyncExternalStore } from "react";

/**
 * 对话侧栏的收起状态，按对话记在浏览器里（键：单聊是线程 id，群组是频道 id）。
 *
 * - 每一块（环境、目标、上下文、输出内容）单独收起或展开；整栏能收成 56px 图标条。
 * - 读不到（没存过、存坏了、浏览器不让读）时四块都展开。
 * - 整栏：这个对话里点过就照点过的样子；没点过时桌面宽度不足 1200px 默认收起，否则展开。
 *
 * 同一个对话的顶栏按钮和侧栏本身读的是同一份（模块里的仓库，`useSyncExternalStore`），一处点了两处
 * 一起变。没有人在看某个对话时丢掉它的缓存，下次挂上时重新从浏览器里读。
 */

export const SIDEBAR_SECTIONS = [
  "environment",
  "goal",
  "context",
  "outputs",
] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

/** 桌面宽度不足这个数（px）时，没点过的对话侧栏默认收成图标条。 */
export const NARROW_DESKTOP_WIDTH = 1200;

const STORAGE_PREFIX = "xiongbao-conversation-sidebar:";

/** 存在浏览器里的：整栏点过才有 `collapsed`；`closed` 是收起的块。 */
type Stored = { collapsed?: boolean; closed: SidebarSection[] };

type Snapshot = {
  stored: Stored;
  collapsed: boolean;
  closed: readonly SidebarSection[];
};

const snapshots = new Map<string, Snapshot>();
const listeners = new Map<string, Set<() => void>>();

function isSection(value: unknown): value is SidebarSection {
  return (SIDEBAR_SECTIONS as readonly unknown[]).includes(value);
}

function readStored(key: string): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return { closed: [] };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { closed: [] };
    const { collapsed, closed } = value as Record<string, unknown>;
    return {
      ...(typeof collapsed === "boolean" ? { collapsed } : {}),
      closed: Array.isArray(closed) ? closed.filter(isSection) : [],
    };
  } catch {
    return { closed: [] };
  }
}

function narrowDesktop(): boolean {
  return typeof window !== "undefined" && window.innerWidth > 0
    ? window.innerWidth < NARROW_DESKTOP_WIDTH
    : false;
}

function snapshotOf(stored: Stored): Snapshot {
  return {
    stored,
    collapsed: stored.collapsed ?? narrowDesktop(),
    closed: stored.closed,
  };
}

function snapshot(key: string): Snapshot {
  let found = snapshots.get(key);
  if (!found) {
    found = snapshotOf(readStored(key));
    snapshots.set(key, found);
  }
  return found;
}

function subscribe(key: string, listener: () => void) {
  let forKey = listeners.get(key);
  if (!forKey) {
    forKey = new Set();
    listeners.set(key, forKey);
  }
  forKey.add(listener);
  return () => {
    forKey.delete(listener);
    // 最后一个人走了才丢缓存；等这一轮提交做完，重新订阅（换了个组件、严格模式）的不算走。
    queueMicrotask(() => {
      if (forKey.size > 0 || listeners.get(key) !== forKey) return;
      listeners.delete(key);
      snapshots.delete(key);
    });
  };
}

function update(
  key: string,
  change: (stored: Stored, now: Snapshot) => Stored,
) {
  const now = snapshot(key);
  const stored = change(now.stored, now);
  snapshots.set(key, snapshotOf(stored));
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(stored));
  } catch {
    // 浏览器不让存（隐私模式之类）：这次照样收起，下次回来是默认的样子。
  }
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

export type SidebarCollapse = {
  section(name: SidebarSection): { open: boolean; toggle(): void };
  whole: { collapsed: boolean; toggle(): void };
  /** 从图标条点进某一块：整栏展开，那一块也展开。 */
  reveal(name: SidebarSection): void;
};

export function useSidebarCollapse(key: string): SidebarCollapse {
  const subscribeKey = useCallback(
    (listener: () => void) => subscribe(key, listener),
    [key],
  );
  const read = useCallback(() => snapshot(key), [key]);
  const state = useSyncExternalStore(subscribeKey, read, read);
  return {
    section: (name) => ({
      open: !state.closed.includes(name),
      toggle: () =>
        update(key, (stored) => ({
          ...stored,
          closed: stored.closed.includes(name)
            ? stored.closed.filter((closed) => closed !== name)
            : [...stored.closed, name],
        })),
    }),
    whole: {
      collapsed: state.collapsed,
      toggle: () =>
        update(key, (stored, now) => ({
          ...stored,
          collapsed: !now.collapsed,
        })),
    },
    reveal: (name) =>
      update(key, (stored) => ({
        collapsed: false,
        closed: stored.closed.filter((closed) => closed !== name),
      })),
  };
}
