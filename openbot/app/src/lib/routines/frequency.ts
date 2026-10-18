/**
 * How often a routine fires, as the new-routine form asks it, and the cron the server stores.
 *
 * The presets are the shapes a person actually says ("每天早上 9 点", "每周一", "每 4 小时"); anything
 * else goes in the advanced box as a five-field cron. Nothing here checks the fifteen-minute floor or
 * the twenty-routine ceiling: the server's routine store enforces both on every create, and a second
 * copy here would be the one that drifts. Its refusal is shown in its own words.
 */
export type Frequency =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "hourly"; every: number }
  | { kind: "cron"; expression: string };

/** 0 = Sunday, the cron convention, in the order a Chinese week is read (Monday first). */
export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

/** The cron expression for a frequency. Whole numbers only; the form never offers anything else. */
export function cronFor(frequency: Frequency): string {
  switch (frequency.kind) {
    case "daily":
      return `${frequency.minute} ${frequency.hour} * * *`;
    case "weekly":
      return `${frequency.minute} ${frequency.hour} * * ${frequency.weekday}`;
    case "hourly":
      return frequency.every <= 1
        ? "0 * * * *"
        : `0 */${frequency.every} * * *`;
    case "cron":
      return frequency.expression.trim().replace(/\s+/g, " ");
  }
}

/** "09:05" from the form's time input, or null when it is not a time. */
export function parseClock(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
