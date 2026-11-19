import { z } from "zod";

/**
 * How often a routine made on the Routines page runs.
 *
 * The common schedules other assistants offer in their own Scheduled screens: every day, every
 * weekday, one day a week, one day a month, every hour. Anything stranger ("every other Tuesday")
 * is a conversation with the Bot, which writes any five-field schedule through the same store.
 */
export const REPEATS = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hourly",
] as const;

export type Repeat = (typeof REPEATS)[number];

/** What each choice reads as in the picker. */
export const REPEAT_LABEL: Record<Repeat, string> = {
  daily: "每天",
  weekdays: "每个工作日",
  weekly: "每周",
  monthly: "每月",
  hourly: "每小时",
};

/** Sunday first, as cron counts them: the index is the day-of-week field. */
export const WEEKDAY_LABEL = [
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
] as const;

/**
 * The days of the month offered. Up to the 28th, so the routine runs in every month: a cron pinned
 * to the 31st skips the seven months that have no 31st, and says nothing about it.
 */
export const MONTH_DAYS = Array.from({ length: 28 }, (_, index) =>
  String(index + 1),
);

/** "A new conversation", in the Posts in picker. Not a channel id, so it cannot collide with one. */
export const NEW_CONVERSATION = "new";

/**
 * 「自动（由系统找对话）」：不指定对话，建的时候不传 `channelId`，由服务端找这个人和这位员工共有的那段对话
 * （有不止一段时服务端会拒绝并说明）。熊宝保留「定时任务不指定对话也能建」（上游 #1406 改成必填，没有收）。
 * Not a channel id either.
 */
export const AUTO_CONVERSATION = "auto";

export const routineFormSchema = z.object({
  agentId: z.string().min(1, "选一位员工。"),
  instruction: z.string().trim().min(1, "说说员工要做什么。"),
  title: z.string().trim().max(100, "名称不要超过 100 个字。"),
  repeat: z.enum(REPEATS),
  /** `HH:MM`, 24-hour, as `<input type="time">` writes it. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "选一个时间。"),
  weekday: z.string().regex(/^[0-6]$/),
  monthDay: z.string().regex(/^([1-9]|1\d|2[0-8])$/),
  /** A channel id, {@link NEW_CONVERSATION}, or {@link AUTO_CONVERSATION}. */
  channelId: z.string().min(1, "选好发到哪里。"),
});

export type RoutineFormValues = z.infer<typeof routineFormSchema>;

type Schedule = Pick<
  RoutineFormValues,
  "repeat" | "time" | "weekday" | "monthDay"
>;

function hourAndMinute(time: string): [number, number] {
  const [hour, minute] = time.split(":").map((part) => Number(part));
  return [hour ?? 9, minute ?? 0];
}

/**
 * The five cron fields for a schedule picked on the page.
 *
 * Built from the picker's own choices and never parsed back: the list reads the schedule in words
 * from the server, which describes every routine the same way whoever made it.
 */
export function cronFrom(schedule: Schedule): string {
  const [hour, minute] = hourAndMinute(schedule.time);
  switch (schedule.repeat) {
    case "hourly":
      return "0 * * * *";
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${schedule.weekday}`;
    case "monthly":
      return `${minute} ${hour} ${schedule.monthDay} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

/** "09:00", on the person's own clock (24-hour, as the rest of 熊宝 writes times). */
export function clockTime(time: string): string {
  const [hour, minute] = hourAndMinute(time);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The picked schedule as a sentence, shown under the picker so the person reads back what they
 * chose: "每个工作日 09:00".
 */
export function scheduleSentence(schedule: Schedule): string {
  const at = clockTime(schedule.time);
  switch (schedule.repeat) {
    case "hourly":
      return "每小时整点";
    case "weekdays":
      return `每个工作日 ${at}`;
    case "weekly":
      return `每${WEEKDAY_LABEL[Number(schedule.weekday)] ?? "周一"} ${at}`;
    case "monthly":
      return `每月 ${Number(schedule.monthDay)} 日 ${at}`;
    default:
      return `每天 ${at}`;
  }
}

/** The person's own time zone, as their browser says it. UTC when it says nothing. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
