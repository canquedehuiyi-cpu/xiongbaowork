/**
 * The time a coworker says it will deliver by (spec 2026-11-15-delivery-loop §4, `accept_task`'s and
 * `request_extension`'s `due_at`), read the way a person says it -- 「40 分钟」「2 小时」「15:00」
 * 「下午三点」「明早 10 点」 -- in the person's time zone.
 *
 * Read narrowly on purpose. A time this does not recognise is null, and the caller treats it as no
 * time given (checked two hours after acceptance) and says so to the coworker, rather than guessing a
 * moment the card is then held to.
 */

const MINUTE = 60_000;
/** The furthest a relative duration reaches: a promise further out is not a delivery time. */
const MOST_DAYS = 30;
const LONGEST = MOST_DAYS * 24 * 60 * MINUTE;

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** A number written in digits or in Chinese up to 99 (「四十」「二十五」「十」), or undefined. */
function numberOf(text: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return undefined;
  const ten = text.indexOf("十");
  if (ten < 0) return text.length === 1 ? DIGITS[text] : undefined;
  if (text.indexOf("十", ten + 1) >= 0) return undefined;
  const tens = ten === 0 ? 1 : DIGITS[text.slice(0, ten)];
  const ones = ten === text.length - 1 ? 0 : DIGITS[text.slice(ten + 1)];
  if (tens === undefined || ones === undefined) return undefined;
  if (text.slice(0, ten).length > 1 || text.slice(ten + 1).length > 1)
    return undefined;
  return tens * 10 + ones;
}

const NUMBER = "(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十]+)";

/** Units of a relative duration, in minutes. */
const UNITS: [RegExp, number][] = [
  [/^(?:分钟|分|min|mins|minute|minutes|m)$/i, 1],
  [/^(?:个小时|小时|个钟头|钟头|h|hr|hrs|hour|hours)$/i, 60],
  [/^(?:天|日|day|days|d)$/i, 24 * 60],
];

/** The local calendar day and time of an instant in a zone. */
function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const local = localParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time in a zone names (the day may overflow; `Date.UTC` carries it). */
function wallClock(
  timeZone: string,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): Date {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let instant = asUtc - offsetAt(asUtc, timeZone);
  // Once more, for a day the offset changes on.
  instant = asUtc - offsetAt(instant, timeZone);
  return new Date(instant);
}

/** 「15:00」「15点30分」「八点半」「3点」 as an hour and a minute, unchecked; undefined otherwise. */
function clockReading(
  text: string,
): { hour: number | undefined; minute: number | undefined } | undefined {
  const colon = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (colon) return { hour: Number(colon[1]), minute: Number(colon[2]) };
  const spoken = new RegExp(
    `^${NUMBER}\\s*点\\s*(?:(半)|${NUMBER}\\s*分?)?\\s*钟?$`,
  ).exec(text);
  if (!spoken) return undefined;
  return {
    hour: numberOf(spoken[1] ?? ""),
    minute: spoken[2] ? 30 : spoken[3] ? numberOf(spoken[3]) : 0,
  };
}

/** 「今天」「明早」「后天」 and their days ahead. */
const DAY_WORDS: [RegExp, number][] = [
  [/^(?:今天|今日|今早|今晚|today)/i, 0],
  [/^(?:明天|明日|明早|明晚|tomorrow)/i, 1],
  [/^(?:后天)/, 2],
];
/** 「上午」「下午」…: what a 12-hour clock reading means. */
const PERIODS: [RegExp, "am" | "noon" | "pm"][] = [
  [/^(?:上午|早上|早晨|早|凌晨)/, "am"],
  [/^(?:中午)/, "noon"],
  [/^(?:下午|傍晚|晚上|晚)/, "pm"],
];

/**
 * The moment `text` names, said at `now` in `timeZone`, or null when it names none.
 *
 * - A relative duration (「40 分钟」「2 小时」「半小时」「3 天」, and the English units): from `now`,
 *   at most 30 days ahead.
 * - A clock time (「15:00」「15点30分」「下午三点」「晚上八点半」), with an optional day word
 *   (「今天」「明早」「明天下午」「后天」). Without a day word, a time already past today is
 *   tomorrow's: 「15:00」 said at 16:00 is tomorrow at 15:00. With one, it is that day's, past or not.
 * - A full ISO-8601 moment with its offset.
 */
export function parseDueTime(
  text: string,
  now: Date,
  timeZone: string,
): Date | null {
  let rest = text
    .trim()
    .replace(/：/g, ":")
    .replace(/^(?:预计|大约|大概|约|在|于|by|in|within)\s*/i, "")
    .replace(/(?:之内|以内|内|后|左右|前)$/, "")
    .trim();
  if (!rest) return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rest)) {
    const instant = Date.parse(rest);
    return Number.isNaN(instant) ? null : new Date(instant);
  }

  if (/^半(?:个)?(?:小时|钟头)$/.test(rest))
    return new Date(now.getTime() + 30 * MINUTE);
  const relative = new RegExp(
    `^${NUMBER}\\s*(?:个)?\\s*([a-zA-Z\\u4e00-\\u9fff]+)$`,
  ).exec(rest);
  if (relative) {
    const amount = numberOf(relative[1] ?? "");
    const unit = UNITS.find(([pattern]) =>
      pattern.test((relative[2] ?? "").replace(/^个/, "")),
    );
    if (amount !== undefined && unit) {
      if (!(amount > 0)) return null;
      const span = Math.min(amount * unit[1] * MINUTE, LONGEST);
      return new Date(now.getTime() + Math.round(span));
    }
  }

  let daysAhead: number | undefined;
  for (const [pattern, days] of DAY_WORDS) {
    const match = pattern.exec(rest);
    if (!match) continue;
    daysAhead = days;
    // 「明早」「今晚」 carry a period too: keep it for the reading below.
    const word = match[0];
    rest =
      (/早$/.test(word) ? "早" : /晚$/.test(word) ? "晚" : "") +
      rest.slice(word.length).trim();
    break;
  }
  let period: "am" | "noon" | "pm" | undefined;
  for (const [pattern, which] of PERIODS) {
    const match = pattern.exec(rest);
    if (!match) continue;
    period = which;
    rest = rest.slice(match[0].length).trim();
    break;
  }

  const reading = clockReading(rest);
  if (!reading) return null;
  let { hour } = reading;
  const { minute } = reading;
  if (
    hour === undefined ||
    minute === undefined ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour > 23 ||
    minute > 59
  )
    return null;
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "noon" && hour < 11) hour += 12;
  if (period === "am" && hour === 12) hour = 0;

  const today = localParts(now, timeZone);
  const on = (days: number) =>
    wallClock(
      timeZone,
      { year: today.year, month: today.month, day: today.day + days },
      hour,
      minute,
    );
  if (daysAhead !== undefined) return on(daysAhead);
  const todays = on(0);
  return todays.getTime() > now.getTime() ? todays : on(1);
}
