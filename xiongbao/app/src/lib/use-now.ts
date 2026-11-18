import { useEffect, useState } from "react";

/**
 * 现在几点了，每秒问一次——只在该问的时候问（WP-3.2 S1a）。
 *
 * 总 run 的实时耗时要一个会走的钟：起点由 `run-stage.ts` 的追踪器记（注入时钟、可测），这里只负责
 * 让画面上的「已跑 X」每秒往前走一格。`active` 为 false（没有在飞的轮）就停表，不挂定时器；
 * 重新活跃时先对一次表再走，免得停表期间攒下的旧读数先上屏。
 */
export function useNow(active: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}