import { expect, test } from "bun:test";
import { TURN_LIMITS, turnTimeoutFor } from "../src/limits";

/*
 * 期五 B2: a working turn (a board card's, an unattended one, a subagent's) may run 25 minutes; a
 * light one (a check-in, a patrol) keeps five. Two constants, so neither borrows the other's clock.
 */

test("the light turn keeps five minutes and the working turn gets twenty-five", () => {
  expect(TURN_LIMITS.turnTimeoutMs).toBe(5 * 60_000);
  expect(TURN_LIMITS.workTurnTimeoutMs).toBe(25 * 60_000);
});

test("each kind of headless turn gets its own clock", () => {
  expect(turnTimeoutFor("board")).toBe(25 * 60_000);
  expect(turnTimeoutFor("unattended")).toBe(25 * 60_000);
  expect(turnTimeoutFor("subagent")).toBe(25 * 60_000);
  expect(turnTimeoutFor("check-in")).toBe(5 * 60_000);
  expect(turnTimeoutFor("patrol")).toBe(5 * 60_000);
});
