/*
 * 交付闭环核对器（`server/src/tasks/delivery-checker.ts`）的两段等待，和由它们得出的逾期宽限。服务器的
 * 核对器、「此刻算不算逾期」的口径（`server/src/tasks/overdue.ts`）和浏览器的看板
 * （`app/src/lib/tasks/delivery.ts`）都从这里取，两端不会各写一份。
 */

const MINUTE = 60_000;

/** 一张卡开始等员工接下、或到了预计时间之后，过多久催员工。 */
export const NUDGE_AFTER_MS = 5 * MINUTE;

/** 第一次该催的时刻之后，过多久提醒你（已接下的卡这时记为逾期）。 */
export const NOTIFY_AFTER_NUDGE_MS = 30 * MINUTE;

/**
 * 已接下、还在员工手上的卡，过了预计时间多久记为逾期：先催，再提醒（核对器 `scheduleOf` 的 `noticeAt`）。
 * 准许延期或改到更晚的预计时间以后，新时间过了同样的宽限才重新算逾期。
 */
export const OVERDUE_AFTER_DUE_MS = NUDGE_AFTER_MS + NOTIFY_AFTER_NUDGE_MS;
