/*
 * 一段时长怎么说给人听（WP-3.2 S1a 提升为共享纯函数）。
 *
 * `spentOf` 原先是 `subtask-step.tsx` 的模块私有函数：子任务完成态的「耗时 X」用它说。总 run 的
 * 实时耗时条也要说同一种话，两处各写一套就会同一个时长说出两样——所以只提升，不改词。
 */

/** 一次运行跑了多久：不足一秒给到毫秒，不足一分钟给到 0.1 秒，再长按分和秒说。 */
export function spentOf(ms: number): string {
  if (ms < 1_000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

/**
 * 状态行末尾的耗时后缀：「已跑 2 分 15 秒」。
 *
 * 不足一秒不显数字（防抖，也免画一个一闪而过的 `0 毫秒`）；没量出来、量成负数或无穷的一个字也不说。
 * 起点是半路接上时观测的（`observed`）就说「已进行」——量的是我们看到它跑了多久，不是它真实的年龄，
 * 限定词就是这条诚实口径（见 `lib/channels/run-stage.ts`）。
 */
export function elapsedSuffix(
  ms: number | undefined,
  observed: boolean | undefined,
): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1_000) return undefined;
  return `${observed ? "已进行" : "已跑"} ${spentOf(ms)}`;
}