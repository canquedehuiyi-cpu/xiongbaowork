/*
 * 微信里「延期 时间」的时间（计划 2026-11-16-im-channels-wechat Task 7）：按这个人的时区（作息设置里的时区）
 * 读中文常用说法。纯函数，不碰库。
 *
 *  - 「明早10点」「明天下午3点」「今晚8点」「2小时后」「15:00」……交给交付闭环读预计时间的 `readDueTime`，
 *    和员工说的预计时间是同一套读法（同样不收已经过了的、30 天以后的）。
 *  - 星期几：「周五」「星期五上午10点」「礼拜天」「下周一」「本周三」。没说几点按这个人作息的收工时间
 *    （`endOfDay`，没有时 18:00）；只写了「N点」没说上午下午、N 在 1–7 时按下午（「周五3点」是 15:00，和
 *    `readDueTime` 对「3点」的推断一致）；
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

/** 「3点」「三点半」这样说出来、没说上午下午的钟点，1–7 点时返回 true（按下午读）。「7:30」照 24 小时制。 */
const SMALL_HOURS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
};
function readsAsAfternoon(clock: string): boolean {
  const said = /^(\d{1,2}|[一二两三四五六七])\s*点/u.exec(clock);
  if (!said?.[1]) return false;
  const hour = SMALL_HOURS[said[1]] ?? Number(said[1]);
  return hour >= 1 && hour <= 7;
}

/** "HH:MM" 读成钟点；读不出时 null。 */
function hourMinute(text: string | null | undefined) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text?.trim() ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) return null;
  // 「24:00」（一天结束）只在代码里出现：当作 23:59。
  return hour === 24 ? { hour: 23, minute: 59 } : { hour, minute };
}

export function readLaterTime(
  text: string,
  now: Date,
  timeZone: string,
  options: {
    /** 这个人作息的收工时间 "HH:MM"：只说了星期几时按它。 */
    endOfDay?: string | null;
  } = {},
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
  const said = (weekday[3] ?? "").trim();
  const clock = readsAsAfternoon(said) ? `下午${said}` : said;
  const end = hourMinute(options.endOfDay) ?? { hour: DEFAULT_HOUR, minute: 0 };
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
      const at = wallClock(timeZone, date, end.hour, end.minute);
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
