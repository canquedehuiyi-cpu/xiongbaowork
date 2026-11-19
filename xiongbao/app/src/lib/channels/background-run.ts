import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { readCompat, writeCompat } from "@/lib/storage-compat";
import { useNow } from "@/lib/use-now";
import type { ChannelWork } from "./queries";

/*
 * 「后台进行中 · 已跑 X 分钟」（期九·四）：一轮在服务器上跑着的时候，侧栏里这段对话、对话顶部都这样说。
 *
 * 部署开了「电脑工具由服务器执行」之后，一轮从头到尾都在服务器上跑，关掉页面它照样跑完。所以「跑了多久」不能
 * 只数这个页面看到的：关掉再打开，页面是新的，只有服务器知道这一轮什么时候开的。起点按这个顺序取：
 *   1. 服务器说的（名册里的 `turn`，`since` 是这一轮开跑的时刻）：换个标签页、换台设备都一样；
 *   2. 这个页面自己发出这一轮的时刻（`beginTurn`）：服务器的那条要等这一轮写下第一批事件才有；
 *   3. 页面半路接上时看见的起点（`observeRun`）：只是观测时刻，不是真正的起点，最差的一个。
 *
 * 不是服务器在跑（部署没开、或还没读到部署能力）就一概不说：关掉开关，界面和以前一样。
 */

/**
 * 页面自己发出的一轮，跑满这么久才说「后台进行中」。一句三秒的回答不是后台的活，每发一条消息都闪一下只会
 * 让这一行变成噪音；服务器说的那一条（`turn`）本来就是写了几批事件的轮，不受这个限制。
 */
export const BACKGROUND_AFTER_MS = 20_000;

/** 第一次在后台跑时，回答下方的那一行。 */
export const BACKGROUND_HINT = "可以关掉页面，跑完会通知你";

/** 那一行出现过的记号：本机记住，只出现一次。 */
const HINT_MARK = "xiongbao:background-hint-shown";

/** 「后台进行中 · 已跑 X 分钟」；不到一分钟不写 0。 */
export function backgroundRunWords(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  return minutes < 1
    ? "后台进行中 · 已跑不到 1 分钟"
    : `后台进行中 · 已跑 ${minutes} 分钟`;
}

export { hasServerTurn, serverTurnSince, TURN_POLL_MS } from "./server-turn";

import { serverTurnSince } from "./server-turn";

/**
 * 这个页面记着的起点，一段对话一份。放在模块里而不是组件里：发出这一轮的对话页关掉之后，这一轮还在跑，侧栏
 * 还要接着说，直到它自己说「完了」（`endTurn`，和告诉名册「忙完了」是同一个时刻）。
 */
type Starts = { said: number | null; seen: number | null };
const starts = new Map<string, Starts>();
const listeners = new Set<() => void>();

const startOf = (channelId: string): number | null => {
  const held = starts.get(channelId);
  return held ? (held.said ?? held.seen) : null;
};

function change(channelId: string, patch: Partial<Starts>) {
  const next = { said: null, seen: null, ...starts.get(channelId), ...patch };
  if (next.said === null && next.seen === null) starts.delete(channelId);
  else starts.set(channelId, next);
  for (const listener of listeners) listener();
}

/** 这个页面发出了这一轮。 */
export function beginTurn(channelId: string, at: number = Date.now()): void {
  change(channelId, { said: at, seen: null });
}

/** 这个页面发出的这一轮完了（或没发出去）。 */
export function endTurn(channelId: string): void {
  change(channelId, { said: null, seen: null });
}

/** 半路接上一轮、看见它在跑：`at` 是看见的时刻；没有在跑了就给 null。 */
export function observeRun(channelId: string, at: number | null): void {
  if (startOf(channelId) === null && at === null) return;
  change(channelId, { seen: at });
}

/** 测试用：把记着的都清掉。 */
export function resetBackgroundRuns(): void {
  starts.clear();
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** 部署是不是让服务器跑聊天里的电脑工具。没读到、读不到都当没开。 */
export function useServerRuns(): boolean {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return capabilities.data?.chatServerComputerTools === true;
}

export type BackgroundRun = {
  /** 起点，毫秒时间戳。 */
  since: number;
  elapsedMs: number;
  /** 「后台进行中 · 已跑 X 分钟」。 */
  words: string;
};

/**
 * 这段对话现在有没有一轮在后台跑，跑了多久。每秒走一格，没有轮在跑时不挂定时器。
 *
 * `channel` 是名册里的行或对话页读到的那条：只用它的 `id` 和 `work`。
 */
export function useBackgroundRun(
  channel: { id: string; work?: readonly ChannelWork[] } | undefined,
): BackgroundRun | null {
  const serverRuns = useServerRuns();
  const local = useSyncExternalStore(
    subscribe,
    () => (channel ? startOf(channel.id) : null),
    () => null,
  );
  const server = serverRuns && channel ? serverTurnSince(channel.work) : null;
  const since = serverRuns ? (server ?? local) : null;
  const now = useNow(since !== null);
  if (since === null) return null;
  const elapsedMs = Math.max(0, now - since);
  if (server === null && elapsedMs < BACKGROUND_AFTER_MS) return null;
  return { since, elapsedMs, words: backgroundRunWords(elapsedMs) };
}

/** 那一行出现过没有：本机记着，存储不让用时只在这个页面里记着。 */
let hintShownHere = false;
function hintWasShown(): boolean {
  if (hintShownHere) return true;
  try {
    return readCompat(HINT_MARK) !== null;
  } catch {
    return false;
  }
}

/** 记下它出现过了。 */
function markHintShown(): void {
  hintShownHere = true;
  try {
    writeCompat(HINT_MARK, new Date().toISOString());
  } catch {
    // 页面里的记号照样管用。
  }
}

/**
 * 测试用：当作没见过那一行。`stored: false` 只忘掉这个页面里记着的，机器上的记号留着——刷新页面就是这样。
 */
export function forgetBackgroundHint({ stored = true } = {}) {
  hintShownHere = false;
  if (!stored) return;
  try {
    window.localStorage.removeItem(HINT_MARK);
  } catch {}
}

/**
 * 回答下方那一行提示要不要现在画：第一次在后台跑时出现，这一轮跑着的时候一直在，之后再也不出现。
 * 出现的那一刻就记下，所以哪怕马上刷新页面，也不会再画第二次。
 */
export function useBackgroundHint(active: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (hintWasShown()) return;
    markHintShown();
    setShown(true);
  }, [active]);
  return active && shown;
}
