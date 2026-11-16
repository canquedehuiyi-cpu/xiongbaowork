/*
 * 微信里「延期 时间」的时间（计划 2026-11-16-im-channels-wechat Task 7）：按这个人的时区（作息设置里的时区）
 * 读中文常用说法。纯函数，不碰库。
 *
 *  - 「明早10点」「明天下午3点」「今晚8点」「2小时后」「15:00」……交给交付闭环读预计时间的 `readDueTime`，
 *    和员工说的预计时间是同一套读法（同样不收已经过了的、30 天以后的）。
 *  - 星期几：「周五」「星期五上午10点」「礼拜天」「下周一」「本周三」。没说几点按那天 18:00（下班前）；
 *    「周X」是最近的那个周X，今天就是周X 而那个点已经过了就是下周的；「下周X」是下一周（周一起算）的周X；
 *    「本周X / 这周X」是这一周的周X，已经过了就不收。
 *  - 前面的「到」「至」去掉：「延期到明早10点」。
 *
 * 读不出就返回 `unreadable`，调用方回一句示例让人重说，什么都不改。
 */
import {
  type DueReading,
  localParts,
  readDueTime,
  wallClock,
} from "../../tasks/due-time";

const WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
};

/** 没说几点时按那天几点。 */
const DEFAULT_HOUR = 18;
const MOST_DAYS = 30;

const ON_WEEKDAY =
  /^(本周|这周|这个星期|这星期|下周|下个?星期|下个?礼拜|周|星期|礼拜)([一二三四五六日天1-7])(.*)$/su;

export function readLaterTime(
  text: string,
  now: Date,
  timeZone: string,
): DueReading {
  const rest = text
    .normalize("NFKC")
    .trim()
    .replace(/^(?:到|至)\s*/u, "")
    .trim();
  const unreadable = { at: null, why: "unreadable" } as const;
  if (!rest) return unreadable;
  const weekday = ON_WEEKDAY.exec(rest);
  if (!weekday) return readDueTime(rest, now, timeZone);

  const which = weekday[1] ?? "";
  const target = WEEKDAY[weekday[2] ?? ""];
  const clock = (weekday[3] ?? "").trim();
  if (!target) return unreadable;
  const today = localParts(now, timeZone);
  // 今天是周几，周一 = 1 … 周日 = 7（按这个人的日历）。
  const todayIndex =
    new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() || 7;
  const nextWeek = which.startsWith("下");
  const thisWeek = /^(?:本周|这)/u.test(which);
  const first = nextWeek
    ? 7 - todayIndex + target
    : thisWeek
      ? target - todayIndex
      : (target - todayIndex + 7) % 7;

  const on = (days: number): DueReading => {
    const date = {
      year: today.year,
      month: today.month,
      day: today.day + days,
    };
    if (!clock) {
      const at = wallClock(timeZone, date, DEFAULT_HOUR, 0);
      return at.getTime() > now.getTime() ? { at } : { at: null, why: "past" };
    }
    // 那天的几点：从那天零点起读「今天…」，读法和 `readDueTime` 一样（「上午10点」「晚上8点」「15:00」）。
    const midnight = wallClock(timeZone, date, 0, 0);
    const reading = readDueTime(`今天${clock}`, midnight, timeZone);
    if (!reading.at) return reading;
    return reading.at.getTime() > now.getTime()
      ? reading
      : { at: null, why: "past" };
  };

  if (first < 0) return { at: null, why: "past" };
  const reading = on(first);
  // 「周X」说的是今天、而那个点已经过了：下周的周X。
  if (!reading.at && reading.why === "past" && !nextWeek && !thisWeek)
    return first + 7 <= MOST_DAYS ? on(first + 7) : reading;
  return reading;
}
