import type { UnifiedEntry } from "@/lib/autonomous/unified";

/*
 * 工作台首页的今日口径（聊天工作台规格「今日 / 今晚的口径」），全按浏览器本地时区：
 *
 * - 今日完成：今天 0 点以来做完的任务。任务看板（`/api/tasks`）没有完成时间，所以按规格退一步，用
 *   「今天更新、状态是做完了」判断，不加字段。做完了是两个状态：员工做完、等你查收（`awaiting_review`，
 *   服务端 `projector.finished` 写的），和你查收或归档后的已完成（`done`）。失败不算。
 *   - 只数本人的员工做完的（和「在岗员工」是同一群人）：团队版的看板读得到整个工作区的卡，别人员工做完的
 *     不算进这个人的今日完成，两个数才对得上。
 *   - 归档了的卡（`archivedAt` 有值）不算：归档会把 `updatedAt` 刷成归档那一刻，算进来就会在归档时冒出
 *     一条「X 完成了「…」」。
 * - 今晚定时任务：现在到下一个早上 06:00 之间要跑的自主工作项（`nextRunAt`）。
 */

/** 任务看板一张卡里这里用得到的几项（`/api/tasks` 的形状）。 */
export type TodayTask = {
  id: string;
  title: string;
  executorAgentId: string | null;
  status: string;
  updatedAt: string;
  /** 归档的时间；没归档（或归档后又动过）是 null，老服务端不带。 */
  archivedAt?: string | null;
};

/** 算「做完了」的任务状态。 */
export const COMPLETED_STATUSES: readonly string[] = [
  "awaiting_review",
  "done",
];

/** 今晚到早上几点为止。 */
const TONIGHT_ENDS_AT_HOUR = 6;

/** 今日动态最多几条。 */
export const FEED_LIMIT = 10;

/** 本地时区今天 0 点。 */
export function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 今晚到哪一刻为止：下一个本地早上 06:00（凌晨时是当天的 06:00）。 */
export function tonightEnds(now: Date): Date {
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    TONIGHT_ENDS_AT_HOUR,
  );
  if (now.getTime() >= end.getTime()) end.setDate(end.getDate() + 1);
  return end;
}

const timeOf = (value: string | null | undefined) =>
  value ? Date.parse(value) : Number.NaN;

/** 本人的员工（`employees`）今天做完、没归档的任务，最近的在前。 */
function completedToday<T extends TodayTask>(
  tasks: readonly T[],
  employees: readonly string[],
  now: Date,
) {
  const since = startOfToday(now).getTime();
  const own = new Set(employees);
  return tasks
    .filter(
      (task) =>
        task.executorAgentId !== null &&
        own.has(task.executorAgentId) &&
        !task.archivedAt &&
        COMPLETED_STATUSES.includes(task.status) &&
        timeOf(task.updatedAt) >= since,
    )
    .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
}

export type TodayStats = {
  onDuty: number;
  doneToday: number;
  waitingOnYou: number;
  tonight: number;
};

/**
 * 工作台的四个数：在岗员工（本人的员工数）、今日完成（这些员工今天做完的）、等你确认（审批收件箱里等你
 * 的）、今晚定时任务。`employees` 是本人员工的 id。每个数只管把给它的东西数对；哪个来源没读到，由页面
 * 决定不画那个数。
 */
export function todayStats(input: {
  tasks: readonly TodayTask[];
  waiting: number;
  autonomous: readonly Pick<UnifiedEntry, "nextRunAt">[];
  employees: readonly string[];
  now: Date;
}): TodayStats {
  const from = input.now.getTime();
  const until = tonightEnds(input.now).getTime();
  return {
    onDuty: input.employees.length,
    doneToday: completedToday(input.tasks, input.employees, input.now).length,
    waitingOnYou: input.waiting,
    tonight: input.autonomous.filter((entry) => {
      const next = timeOf(entry.nextRunAt);
      return next >= from && next < until;
    }).length,
  };
}

/**
 * 今日动态：本人的员工（`employees`）今天做完的任务，口径和「今日完成」一样，按时间倒序，最多
 * `FEED_LIMIT` 条。
 */
export function todayFeed<T extends TodayTask>(
  tasks: readonly T[],
  employees: readonly string[],
  now: Date,
): T[] {
  return completedToday(tasks, employees, now).slice(0, FEED_LIMIT);
}

/** 按本地时间问好：5–11 点早上好，12–17 点下午好，其余晚上好。 */
export function greetingFor(now: Date): "早上好" | "下午好" | "晚上好" {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "早上好";
  if (hour >= 12 && hour < 18) return "下午好";
  return "晚上好";
}

/** 时间写成本地的 `HH:MM`。 */
export function clockOf(value: string): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
