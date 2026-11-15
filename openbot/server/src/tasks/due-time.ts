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

const DAY = 24 * 60 * MINUTE;

/**
 * The instant a wall-clock time in a zone names (the day and hour may overflow; `Date.UTC` carries
 * them). A time the clocks skipped -- inside a daylight-saving jump -- is the first moment after the
 * jump; a time they passed twice is the first of the two.
 */
function wallClock(
  timeZone: string,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): Date {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const before = offsetAt(asUtc - DAY, timeZone);
  const after = offsetAt(asUtc + DAY, timeZone);
  for (const offset of before === after ? [before] : [before, after]) {
    const instant = asUtc - offset;
    if (offsetAt(instant, timeZone) === offset) return new Date(instant);
  }
  // Skipped: find the jump between the two readings, to the minute.
  let low = Math.min(asUtc - before, asUtc - after);
  let high = Math.max(asUtc - before, asUtc - after);
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
    if (offsetAt(middle, timeZone) === after) high = middle;
    else low = middle;
  }
  return new Date(high);
}

/** 「15:00」「15点30分」「八点半」「3点」 as an hour and a minute, unchecked; undefined otherwise. */
function clockReading(
  text: string,
):
  | { hour: number | undefined; minute: number | undefined; spoken: boolean }
  | undefined {
  const colon = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (colon)
    return { hour: Number(colon[1]), minute: Number(colon[2]), spoken: false };
  const spoken = new RegExp(
    `^${NUMBER}\\s*点\\s*(?:(半)|${NUMBER}\\s*分?)?\\s*钟?$`,
  ).exec(text);
  if (!spoken) return undefined;
  return {
    hour: numberOf(spoken[1] ?? ""),
    minute: spoken[2] ? 30 : spoken[3] ? numberOf(spoken[3]) : 0,
    spoken: true,
  };
}

/** 「今天」「明早」「后天」 and their days ahead. */
const DAY_WORDS: [RegExp, number][] = [
  [/^(?:今天|今日|今早|今晚|today)/i, 0],
  [/^(?:明天|明日|明早|明晚|tomorrow)/i, 1],
  [/^(?:后天)/, 2],
];
type Period = "am" | "noon" | "afternoon" | "night";
/** 「上午」「下午」「晚上」…: what a 12-hour clock reading means. */
const PERIODS: [RegExp, Period][] = [
  [/^(?:上午|早上|早晨|早|凌晨)/, "am"],
  [/^(?:中午)/, "noon"],
  [/^(?:下午|傍晚)/, "afternoon"],
  [/^(?:晚上|夜里|夜间|半夜|深夜|晚)/, "night"],
];

/** A 12-hour reading in its period, on the 24-hour clock of the day it was said for (may pass 24). */
function inPeriod(hour: number, period: Period | undefined): number {
  switch (period) {
    case "am":
      return hour === 12 ? 0 : hour;
    case "noon":
      return hour < 11 ? hour + 12 : hour;
    case "afternoon":
      return hour < 12 ? hour + 12 : hour;
    case "night":
      // 「晚上十二点」 is that night's midnight; 「夜里一点」 the small hours after it.
      if (hour === 12) return 24;
      if (hour < 6) return hour + 24;
      return hour < 12 ? hour + 12 : hour;
    default:
      return hour;
  }
}

/** Why a due time could not be taken. */
export type DueRefusal = "unreadable" | "past" | "too_far";

/** What `text` says the due time is, or why it says none. */
export type DueReading = { at: Date } | { at: null; why: DueRefusal };

/** The reason a due time was not taken, in a sentence for the coworker. */
export function dueRefusalText(why: DueRefusal): string {
  switch (why) {
    case "past":
      return "这个时间已经过了";
    case "too_far":
      return `这个时间在 ${MOST_DAYS} 天以后`;
    default:
      return "没认出是几点";
  }
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * The moment `text` names, said at `now` in `timeZone`, or why it names none.
 *
 * - A relative duration (「40 分钟」「2 小时」「半小时」「3 天」, and the English units): from `now`,
 *   at most 30 days ahead (a longer one is cut to 30 days).
 * - A clock time (「15:00」「15点30分」「下午三点」「晚上八点半」「晚上12点」), with an optional day
 *   word (「今天」「明早」「明天下午」「后天」). Without a day word, a time already past today is
 *   tomorrow's: 「15:00」 said at 16:00 is tomorrow at 15:00 -- except a spoken 「N点」 with no
 *   morning or afternoon whose afternoon reading is still ahead today: 「3点」 said at 14:00 is 15:00.
 * - An ISO-8601 moment; without an offset it is read on the person's clock.
 *
 * A moment (not a duration) already past, or more than 30 days off, is refused: a due time nobody
 * could meet, or one the checker would never reach, is not taken.
 */
export function readDueTime(
  text: string,
  now: Date,
  timeZone: string,
): DueReading {
  const unreadable = { at: null, why: "unreadable" } as const;
  let rest = text
    .trim()
    .replace(/：/g, ":")
    .replace(/^(?:预计|大约|大概|约|在|于|by|in|within)\s*/i, "")
    .replace(/\s*(?:之前|以前|之内|以内|之后|以后|内|后|左右|前)$/, "")
    .trim();
  if (!rest) return unreadable;
  const moment = (at: Date): DueReading =>
    at.getTime() <= now.getTime()
      ? { at: null, why: "past" }
      : at.getTime() > now.getTime() + LONGEST
        ? { at: null, why: "too_far" }
        : { at };

  const iso = ISO.exec(rest);
  if (iso) {
    if (iso[6]) {
      const instant = Date.parse(rest.replace(" ", "T"));
      return Number.isNaN(instant) ? unreadable : moment(new Date(instant));
    }
    // No offset: the person's own clock, as a person writing it means it.
    const [year, month, day, hour, minute] = iso.slice(1, 6).map(Number);
    if (
      !year ||
      !month ||
      month > 12 ||
      !day ||
      day > 31 ||
      hour === undefined ||
      hour > 23 ||
      minute === undefined ||
      minute > 59
    )
      return unreadable;
    return moment(wallClock(timeZone, { year, month, day }, hour, minute));
  }

  if (/^半(?:个)?(?:小时|钟头)$/.test(rest))
    return { at: new Date(now.getTime() + 30 * MINUTE) };
  const relative = new RegExp(
    `^${NUMBER}\\s*(?:个)?\\s*([a-zA-Z\\u4e00-\\u9fff]+)$`,
  ).exec(rest);
  if (relative) {
    const amount = numberOf(relative[1] ?? "");
    const unit = UNITS.find(([pattern]) =>
      pattern.test((relative[2] ?? "").replace(/^个/, "")),
    );
    if (amount !== undefined && unit) {
      if (!(amount > 0)) return unreadable;
      const span = Math.min(amount * unit[1] * MINUTE, LONGEST);
      return { at: new Date(now.getTime() + Math.round(span)) };
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
  let period: Period | undefined;
  for (const [pattern, which] of PERIODS) {
    const match = pattern.exec(rest);
    if (!match) continue;
    period = which;
    rest = rest.slice(match[0].length).trim();
    break;
  }

  const reading = clockReading(rest);
  if (!reading) return unreadable;
  const { hour: said, minute, spoken } = reading;
  if (
    said === undefined ||
    minute === undefined ||
    !Number.isInteger(said) ||
    !Number.isInteger(minute) ||
    said > 23 ||
    minute > 59
  )
    return unreadable;
  // 「下午15点」 is already on the 24-hour clock.
  return readAs24(said > 12 ? said : inPeriod(said, period));

  function readAs24(hour: number): DueReading {
    const today = localParts(now, timeZone);
    const on = (days: number, at = hour) =>
      wallClock(
        timeZone,
        { year: today.year, month: today.month, day: today.day + days },
        at,
        minute as number,
      );
    if (daysAhead !== undefined) return moment(on(daysAhead));
    const todays = on(0);
    if (todays.getTime() > now.getTime()) return { at: todays };
    // 「3点」 said at 14:00 means this afternoon, not three tomorrow morning.
    if (spoken && period === undefined && hour >= 1 && hour < 12) {
      const afternoon = on(0, hour + 12);
      if (afternoon.getTime() > now.getTime()) return { at: afternoon };
    }
    return { at: on(1) };
  }
}

/** The moment `text` names, or null when it names none (see {@link readDueTime}). */
export function parseDueTime(
  text: string,
  now: Date,
  timeZone: string,
): Date | null {
  return readDueTime(text, now, timeZone).at;
}
