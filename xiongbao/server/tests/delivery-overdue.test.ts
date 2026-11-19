import { expect, test } from "bun:test";
import { OVERDUE_AFTER_DUE_MS } from "../src/tasks/delivery-checker";
import { isOverdueNow } from "../src/tasks/overdue";

const MINUTE = 60_000;
const now = new Date("2026-11-16T03:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);

test("the grace is the checker's: due + nudge (5 min) + reminder (30 min)", () => {
  expect(OVERDUE_AFTER_DUE_MS).toBe(35 * MINUTE);
});

test("a card moved to a later due time is not overdue 10 minutes past it, and is 36 minutes past it", () => {
  const recorded = ago(120);
  expect(
    isOverdueNow(
      { status: "running", overdueAt: recorded, dueAt: ago(10) },
      now,
    ),
  ).toBe(false);
  expect(
    isOverdueNow(
      { status: "running", overdueAt: recorded, dueAt: ago(36) },
      now,
    ),
  ).toBe(true);
  expect(
    isOverdueNow(
      { status: "needs_action", overdueAt: recorded, dueAt: ago(35) },
      now,
    ),
  ).toBe(true);
});

test("no due time, handed in, or never recorded overdue", () => {
  expect(
    isOverdueNow({ status: "running", overdueAt: ago(5), dueAt: null }, now),
  ).toBe(true);
  expect(
    isOverdueNow(
      { status: "awaiting_review", overdueAt: ago(5), dueAt: ago(60) },
      now,
    ),
  ).toBe(false);
  expect(
    isOverdueNow({ status: "running", overdueAt: null, dueAt: ago(60) }, now),
  ).toBe(false);
});
