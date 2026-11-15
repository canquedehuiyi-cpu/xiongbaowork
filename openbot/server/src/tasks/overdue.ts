import {
  and,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { tasks } from "../db/schema";
import { OVERDUE_AFTER_DUE_MS } from "./delivery-checker";

/*
 * 「现在算不算逾期」的唯一口径（规格 2026-11-15-delivery-loop 第 3、8 节，控制方 Task 8 第 1 轮裁定）：
 * 核对器记过逾期（`overdue_at`，首次记为逾期的时间，交付后也保留，这里不清它），员工手上还没交、没结束，
 * 并且当前生效的预计时间已经过了核对器的宽限（`OVERDUE_AFTER_DUE_MS`，到期后 35 分钟，和核对器记逾期的
 * 时刻一样）——没有 `due_at`（没报、或换人后等新员工报）也算。准许延期或你把预计时间改到将来以后，新时间
 * 过了同样的宽限才重新算逾期；在那之前这张卡现在就不算逾期：不标红、不进「只看逾期」、不进清点和侧栏的逾期；流水里的逾期
 * 记录照旧。清点（`briefing.ts`）、看板的 `?overdue=1`（`routes.ts`）、对话侧栏（`threads/sidebar.ts`）
 * 都用这里，浏览器那边（`app/src/lib/tasks/delivery.ts` 的 `overdueMinutes`）照同一条写。
 */

/** 还在员工手上、没交没结束的状态。 */
export const OVERDUE_OPEN_STATUSES = ["running", "needs_action"] as const;

/** 一张卡此刻算不算逾期。 */
export function isOverdueNow(
  card: {
    status: string;
    overdueAt: Date | null;
    dueAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    card.overdueAt !== null &&
    (OVERDUE_OPEN_STATUSES as readonly string[]).includes(card.status) &&
    (card.dueAt === null ||
      now.getTime() >= card.dueAt.getTime() + OVERDUE_AFTER_DUE_MS)
  );
}

/** 同一条口径写成查询条件（看板的 `?overdue=1`）。 */
export function overdueNowCondition(now: Date): SQL {
  return and(
    isNotNull(tasks.overdueAt),
    inArray(tasks.status, [...OVERDUE_OPEN_STATUSES]),
    or(
      isNull(tasks.dueAt),
      lte(tasks.dueAt, new Date(now.getTime() - OVERDUE_AFTER_DUE_MS)),
    ),
  ) as SQL;
}
