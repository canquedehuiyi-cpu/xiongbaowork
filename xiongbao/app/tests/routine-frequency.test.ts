import { expect, test } from "bun:test";
import { cronFor, parseClock, WEEKDAYS } from "@/lib/routines/frequency";

/**
 * The new-routine form's one translation: what a person picks into the cron the store keeps (spec C4).
 *
 * Pure on purpose -- the floor and the ceiling are the server's to refuse, so the only thing worth
 * pinning here is that 每周三 08:30 does not quietly become Thursday or 8:03.
 */
test("each preset reads as the cron a person would have written by hand", () => {
  expect(cronFor({ kind: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
  expect(cronFor({ kind: "weekly", weekday: 3, hour: 8, minute: 30 })).toBe(
    "30 8 * * 3",
  );
  expect(cronFor({ kind: "weekly", weekday: 0, hour: 22, minute: 5 })).toBe(
    "5 22 * * 0",
  );
  expect(cronFor({ kind: "hourly", every: 4 })).toBe("0 */4 * * *");
  expect(cronFor({ kind: "hourly", every: 1 })).toBe("0 * * * *");
});

test("an advanced expression is passed through, with its spacing tidied and nothing else", () => {
  expect(cronFor({ kind: "cron", expression: "  30   8 * *  1-5 " })).toBe(
    "30 8 * * 1-5",
  );
});

test("a clock either reads as a time of day or as nothing", () => {
  expect(parseClock("09:05")).toEqual({ hour: 9, minute: 5 });
  expect(parseClock("7:30")).toEqual({ hour: 7, minute: 30 });
  expect(parseClock("24:00")).toBeNull();
  expect(parseClock("12:60")).toBeNull();
  expect(parseClock("")).toBeNull();
});

test("the week starts on Monday and still covers all seven cron days", () => {
  expect(WEEKDAYS[0]?.label).toBe("周一");
  expect(WEEKDAYS.map((day) => day.value).sort()).toEqual([
    0, 1, 2, 3, 4, 5, 6,
  ]);
});
