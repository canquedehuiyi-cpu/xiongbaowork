import { describe, expect, test } from "bun:test";
import {
  archivesOnDrop,
  attentionGroups,
  LANES,
  laneOf,
} from "@/routes/_authed/_app/tasks";

/**
 * Ticket 020's C3 and spec A7, at the two places the board decides where a card lives.
 *
 * The board is a partition, not a set of overlapping views — a status listed in two lanes would print
 * the same card twice, side by side, in one screen. That is the invariant worth pinning, because it is
 * easy to break by adding a status to a lane and forgetting to take it out of another, and the symptom
 * (a duplicate card) is the kind a reviewer spots in a browser rather than in a diff.
 *
 * No DOM here on purpose: `laneOf` and `attentionGroups` are the whole decision, so the decision gets
 * tested without standing up the router — which is what the screen-level files have to pay.
 */
const STATUSES = [
  "running",
  "needs_action",
  "awaiting_review",
  "done",
  "failed",
] as const;

describe("the board's lanes", () => {
  test("a failure is asked for attention, and is not left among the finished", () => {
    // C3: the card still reads `failed` — 已结束-失败 — but it lands where a person looks.
    expect(laneOf("failed")).toEqual(["attention"]);
    expect(laneOf("failed")).not.toContain("finished");
  });

  test("a suspended card and one awaiting review are both attention", () => {
    expect(laneOf("needs_action")).toEqual(["attention"]);
    // I3: a parent parked on a step's approval belongs here too.
    expect(laneOf("awaiting_review")).toEqual(["attention"]);
  });

  test("every status the board knows lands in exactly one lane", () => {
    const misplaced = STATUSES.map((status) => ({
      status,
      lanes: laneOf(status),
    })).filter(({ lanes }) => lanes.length !== 1);
    expect(misplaced).toEqual([]);
  });

  test("no status is claimed by two lanes", () => {
    const claimed = LANES.flatMap((lane) =>
      lane.statuses.map((status) => `${status} in ${lane.key}`),
    );
    expect(
      claimed.filter((entry, index) => claimed.indexOf(entry) !== index),
    ).toEqual([]);
    for (const lane of LANES) {
      expect(new Set(lane.statuses).size).toBe(lane.statuses.length);
    }
  });
});

describe("the attention region's two tabs (A7)", () => {
  /**
   * Only the status is read here, so a fixture is one field and a cast. Copying the board's whole
   * `Task` shape would tie this to columns the grouping does not care about, and the first added
   * column would break an assertion about where a card is asked for.
   */
  const cards = (...statuses: string[]) =>
    statuses.map(
      (status) => ({ status }) as Parameters<typeof attentionGroups>[0][number],
    );

  test("a circuit-broken routine is asked for, not left to be found", () => {
    const groups = attentionGroups(cards("failed"));
    expect(groups.needsYou.map((task) => task.status)).toEqual(["failed"]);
    expect(groups.review).toEqual([]);
  });

  test("an approval and a review request are different asks", () => {
    expect(attentionGroups(cards("needs_action")).needsYou.length).toBe(1);
    expect(attentionGroups(cards("needs_action")).review).toEqual([]);
    expect(attentionGroups(cards("awaiting_review")).review.length).toBe(1);
    // 查收结果 is not "needs you": the work is done, and nobody is blocked on a decision.
    expect(attentionGroups(cards("awaiting_review")).needsYou).toEqual([]);
  });

  test("nothing running and nothing done is asked for", () => {
    expect(attentionGroups(cards("running", "done"))).toEqual({
      needsYou: [],
      review: [],
    });
  });

  test("the two tabs never both claim the same card", () => {
    const groups = attentionGroups(
      cards(
        "running",
        "needs_action",
        "awaiting_review",
        "done",
        "failed",
        "needs_action",
      ),
    );
    // Four of the six are asked for, each exactly once, in one tab or the other.
    expect([...groups.needsYou, ...groups.review]).toHaveLength(4);
    expect(groups.needsYou.map((task) => task.status).sort()).toEqual([
      "failed",
      "needs_action",
      "needs_action",
    ]);
    expect(groups.review.map((task) => task.status)).toEqual([
      "awaiting_review",
    ]);
    const ids = [...groups.needsYou, ...groups.review];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("dragging a card (A5 / D7)", () => {
  test("only into 已结束, and only from a state the archive accepts", () => {
    // The original check asked whether the card's status belonged to the target lane; 已结束 holds
    // only `done`, so neither archivable status ever passed and every drag did nothing.
    expect(archivesOnDrop("finished", "awaiting_review")).toBe(true);
    expect(archivesOnDrop("finished", "failed")).toBe(true);
    for (const status of ["running", "needs_action", "done"]) {
      expect(archivesOnDrop("finished", status)).toBe(false);
    }
  });

  test("no other lane is a drop target, in any direction", () => {
    for (const lane of LANES.filter((entry) => entry.key !== "finished")) {
      for (const status of STATUSES) {
        expect(archivesOnDrop(lane.key, status)).toBe(false);
      }
    }
  });
});
