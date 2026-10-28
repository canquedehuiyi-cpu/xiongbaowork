import { describe, expect, test } from "bun:test";
import { boardSearch } from "@/routes/_authed/_app/tasks";

/**
 * A1 moved the whole filter set into the address, so the address is the thing worth pinning. Every
 * case below is a link somebody could paste into chat: the coercions are what a stale or hand-edited
 * URL meets, and the defaults are what a bare /tasks has to answer with.
 *
 * The mapping onto the wire (machineId to deviceId, crew to executors) is decided inside the page
 * component and stays covered by the board-level suites. No export was invented to make it unit
 * testable, because a second source of truth about the request format would be worse than a gap.
 */
const EMPTY = {
  machineId: "",
  crew: "",
  status: "",
  q: "",
  period: "month",
  view: "list",
} as const;

describe("boardSearch", () => {
  test("a bare address means the whole workspace, over a month, as a list", () => {
    expect(boardSearch({})).toEqual(EMPTY);
  });

  test("the four text fields keep strings and drop everything else", () => {
    const TEXT_KEYS = ["machineId", "crew", "status", "q"] as const;
    for (const key of TEXT_KEYS) {
      expect(boardSearch({ [key]: "a-value" })[key]).toBe("a-value");
      for (const junk of [undefined, null, 7, true, {}, []]) {
        expect(boardSearch({ [key]: junk })[key]).toBe("");
      }
    }
  });

  test("period is a closed set and an unknown value is not an error", () => {
    for (const ok of ["week", "month", "all"] as const) {
      expect(boardSearch({ period: ok }).period).toBe(ok);
    }
    for (const bad of ["quarter", "", 2026, undefined, "MONTH"]) {
      expect(boardSearch({ period: bad }).period).toBe("month");
    }
  });

  test("view is a closed set and an unknown value falls back to the list", () => {
    expect(boardSearch({ view: "lanes" }).view).toBe("lanes");
    for (const bad of ["cards", "", null, "LIST"]) {
      expect(boardSearch({ view: bad }).view).toBe("list");
    }
  });

  test("all six axes survive together rather than one replacing another", () => {
    const shared: ReturnType<typeof boardSearch> = {
      machineId: "d-1",
      crew: "增长小组",
      status: "needs_action",
      q: "周报",
      period: "all",
      view: "lanes",
    };
    expect(boardSearch(shared)).toEqual(shared);
  });

  test("an already parsed address parses again to the same answer", () => {
    const once = boardSearch({
      machineId: "d-1",
      status: "failed",
      period: "week",
    });
    expect(boardSearch(once)).toEqual(once);
  });

  test("clearing one axis leaves the other shared axis alone", () => {
    const both = { machineId: "d-1", crew: "增长小组" };
    expect(boardSearch({ ...both, crew: "" })).toEqual({
      ...EMPTY,
      machineId: "d-1",
    });
    expect(boardSearch({ ...both, machineId: "" })).toEqual({
      ...EMPTY,
      crew: "增长小组",
    });
  });
});
