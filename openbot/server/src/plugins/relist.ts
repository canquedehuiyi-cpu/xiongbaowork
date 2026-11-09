/**
 * 启动时，把升级上来的部署里的 broker 应用重新列到这一版的清单读法（上游 #1185）。
 *
 * 启动不等它：列清单要问 broker，离线的启动也必须能启动。应用落后期间，存下的动作照常可用、按原来
 * 的方式询问；这里按退避表的间隔重试，每一档都会走到，直到每个应用都列完，不需要谁去按「刷新
 * 工具」。退避推进到最长一档之后，每一轮的失败才开始计数：同一个应用在最长一档上连续失败 3 次
 * （`RELIST_ATTEMPTS`），store 本进程里就不再试它、也不再把它算作落后，没有别的落后应用时这个
 * 循环就停了。按默认的退避表，约 18 分钟后才放弃。见 `plugins/store.ts` 的
 * `relistOutdatedBrokeredApps`。
 *
 * 不刷屏：同一个应用第一次落后时报一次，之后的重试不再报；整轮抛错也只报一次。
 */

/** 还有应用落后时，每次重试前等多久。最后一个一直重复。 */
export const RELIST_RETRY_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000,
]);

/** 排一次等待，和取消它。默认是真的定时器；测试换成假时钟。 */
export type RelistTimers = {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: RelistTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 回答一个停止重试的函数。 */
export function startBrokeredRelist(
  store: {
    relistOutdatedBrokeredApps(options: {
      countFailures: boolean;
    }): Promise<string[]>;
  },
  retryMs: readonly number[] = RELIST_RETRY_MS,
  timers: RelistTimers = realTimers,
): () => void {
  let timer: unknown;
  let stopped = false;
  let warnedThrow = false;
  const warnedApps = new Set<string>();

  const attempt = async (retry: number) => {
    if (stopped) return;
    let behind: string[];
    try {
      // 第 `retry` 次尝试之前等的是 `retryMs[retry - 1]`（封顶在最后一档）：
      // 等过最长一档之后的尝试才计入放弃的次数。
      behind = await store.relistOutdatedBrokeredApps({
        countFailures: retry >= retryMs.length,
      });
    } catch (error) {
      behind = ["(all)"];
      if (!warnedThrow)
        console.warn(
          `[plugins] 升级后重新列出 Composio 应用的工具失败（${error instanceof Error ? error.message : String(error)}），会继续重试。`,
        );
      warnedThrow = true;
    }
    if (behind.length === 0 || stopped) return;
    const fresh = behind.filter((id) => id !== "(all)" && !warnedApps.has(id));
    if (fresh.length > 0) {
      console.warn(
        `[plugins] ${fresh.join(", ")} 升级后没能重新列出工具，它的动作仍按原来的方式询问，会继续重试。`,
      );
      for (const id of fresh) warnedApps.add(id);
    }
    const delay = retryMs[Math.min(retry, retryMs.length - 1)] ?? 300_000;
    timer = timers.set(() => void attempt(retry + 1), delay);
  };

  // 下一轮事件循环才开始，调用方立刻返回。
  timer = timers.set(() => void attempt(0), 0);
  return () => {
    stopped = true;
    if (timer !== undefined) timers.clear(timer);
  };
}
