/**
 * 每位员工每天最多做几次背景小活（自动抽记忆、做完复盘）。超了就静默跳过，不报错、不记日志：这两件事
 * 丢一次没有后果，只是不多花一次模型调用。
 *
 * 计数在进程里，按 UTC 日历天，不在库里：它防的是花钱，不是正确性，重启后多给几次、多个副本各算各的，都
 * 无害；为它单开一张表（本地学习有 `local_learning_runs`，那是因为它要记结果给人看）不值得。
 * 只留当天的计数，换天就清掉昨天的。
 */

/** 读 `name` 这个环境变量：正整数就是上限，否则用 `fallback`。 */
export function dailyLimitOf(
  name: string,
  fallback: number,
  environment: Record<string, string | undefined> = process.env,
): number {
  const value = Number(environment[name]);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

export function createDailyLimiter(options: {
  /** 每次问时读：改了环境变量不用重启。 */
  limit: () => number;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  let day = "";
  const counts = new Map<string, number>();
  return {
    /** 记一次并返回 true；这一天这把钥匙的次数用完了就返回 false，不记。 */
    take(key: string): boolean {
      const today = now().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        counts.clear();
      }
      const used = counts.get(key) ?? 0;
      if (used >= options.limit()) return false;
      counts.set(key, used + 1);
      return true;
    },
  };
}

/** 复盘：每位员工每天默认最多 6 次。 */
export const RETRO_PER_DAY_DEFAULT = 6;
/** 自动抽记忆：每位员工每天默认最多 40 次。 */
export const MEMORY_EXTRACT_PER_DAY_DEFAULT = 40;
