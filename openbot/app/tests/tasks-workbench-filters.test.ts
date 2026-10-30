import { describe, expect, test } from "bun:test";
import { boardSearch, boardScope, boardRoster, boardRequest, boardReadKey, SOURCE_LABEL } from "@/routes/_authed/_app/tasks";

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
  executor: "",
  groupId: "",
  source: "",
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
    const TEXT_KEYS = ["machineId", "crew", "executor", "groupId", "source", "status", "q"] as const;
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
      executor: "a",
      groupId: "g",
      source: "routine",
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

describe("A4 independent catalog scopes and actual request builders", () => {
  const agents = [{ id: "a" }, { id: "b" }];
  const group = (members: string[]) => [{
    id: "g", name: "group", description: null,
    members: members.map((agentId, position) => ({ agentId, position })),
  }];
  test("source vocabulary is the exact task_source enum, not triggerSource", () => {
    expect(Object.keys(SOURCE_LABEL)).toEqual(["chat", "routine", "responsibility", "handoff", "group_run"]);
    expect(boardScope(boardSearch({ source: "timer" }), agents, []).ready).toBe(false);
    expect(boardSearch({ source: 1 }).source).toBe("");
    expect(boardSearch({ status: "future" }).status).toBe("future");
  });
  test("executor, group members and old crew intersect without losing an axis", () => {
    const address = boardSearch({ executor: "a", groupId: "g", crew: "b,a", source: "routine",
      status: "failed", q: "weekly", machineId: "d", period: "all" });
    const scope = boardScope(address, agents, group(["a", "b"]));
    expect(scope).toEqual({ ready: true, error: null, executors: "a,b" });
    const list = new URL(boardRequest(address, scope.executors), "https://example.invalid");
    expect(Object.fromEntries(list.searchParams)).toEqual({
      period: "all", status: "failed", q: "weekly", deviceId: "d", executor: "a",
      source: "routine", executors: "a,b",
    });
    const summary = new URL(boardRequest(address, scope.executors, true), "https://example.invalid");
    expect(summary.searchParams.has("status")).toBe(false);
    expect(summary.searchParams.has("q")).toBe(false);
    for (const key of ["executor", "source", "executors", "deviceId", "period"])
      expect(summary.searchParams.get(key)).toBe(list.searchParams.get(key));
    expect(list.searchParams.getAll("executors")).toHaveLength(1);
  });
  test("empty group and empty intersection explicitly request no executors", () => {
    for (const [crew, members] of [["", []], ["b", ["a"]]] as [string, string[]][]) {
      const address = boardSearch({ groupId: "g", crew });
      const scope = boardScope(address, agents, group(members));
      expect(scope).toEqual({ ready: true, error: null, executors: "" });
      expect(new URL(boardRequest(address, scope.executors), "https://example.invalid")
        .searchParams.get("executors")).toBe("");
    }
  });
  test("missing, invisible, pending and failed catalogs cannot become an all-tenant request", () => {
    const address = boardSearch({ groupId: "g" });
    expect(boardScope(address, undefined, undefined).ready).toBe(false);
    expect(boardScope(address, agents, []).error).not.toBeNull();
    expect(boardScope(address, agents, group(["hidden"])).ready).toBe(false);
    expect(boardScope(address, agents, group(["a"]), true).ready).toBe(false);
    expect(boardScope(boardSearch({ executor: "hidden" }), agents, []).ready).toBe(false);
  });
  test("group membership changes the cache identity; old URLs retain exact old keys", () => {
    const address = boardSearch({ groupId: "g" });
    const a = boardScope(address, agents, group(["a"]));
    const b = boardScope(address, agents, group(["b"]));
    expect(boardReadKey(address, a.executors)).not.toEqual(boardReadKey(address, b.executors));
    expect(boardReadKey(address, a.executors, true)).not.toEqual(boardReadKey(address, b.executors, true));
    const old = boardSearch({ crew: "b,a", status: "failed", q: "x", period: "week", machineId: "d" });
    expect(boardReadKey(old, old.crew)).toEqual(["tasks", "week", "failed", "x", "d", "b,a"]);
    expect(boardReadKey(old, old.crew, true)).toEqual(["tasks-summary", "week", "d", "b,a"]);
  });
  test("every axis survives parsing, clearing another axis and refresh", () => {
    const all = boardSearch({ executor: "a", groupId: "g", source: "routine", crew: "a,b",
      status: "ended", q: "x", machineId: "d", period: "week", view: "lanes" });
    for (const key of ["executor", "groupId", "source", "crew", "status", "q", "machineId"] as const) {
      const cleared = boardSearch({ ...all, [key]: "" });
      expect(cleared).toEqual({ ...all, [key]: "" });
      expect(boardSearch(cleared)).toEqual(cleared);
    }
  });
});

describe("R3 active and paused catalogs are preference partitions, not new authority", () => {
  const yes = (data: { id: string }[]) => ({ data, isError: false });
  const pending = { data: undefined, isError: false };
  const failed = { data: [{ id: "stale" }], isError: true };
  test("either successful partition can supply an ID despite the unrelated partition failing", () => {
    expect(boardRoster(["a"], yes([{ id: "a" }]), failed))
      .toEqual({ data: [{ id: "a" }], options: [{ id: "a" }], error: false });
    expect(boardRoster(["p"], failed, yes([{ id: "p" }])))
      .toEqual({ data: [{ id: "p" }], options: [{ id: "p" }], error: false });
  });
  test("mixed groups retain paused IDs and de-duplicate IDs present in both partitions", () => {
    const roster = boardRoster(["a", "p"], yes([{ id: "a" }]), yes([{ id: "a" }, { id: "p" }]));
    expect(roster.data).toEqual([{ id: "a" }, { id: "p" }]);
    const address = boardSearch({ groupId: "g", crew: "p,a" });
    const groups = [{ id: "g", name: "mixed", description: null,
      members: [{ agentId: "a", position: 0 }, { agentId: "p", position: 1 }] }];
    expect(boardScope(address, roster.data, groups, roster.error).executors).toBe("a,p");
  });
  test("absence needs both successful partitions; pending and failed reads are not absence", () => {
    expect(boardRoster(["p"], yes([]), pending).data).toBeUndefined();
    expect(boardRoster(["stale"], yes([]), failed).error).toBe(true);
    const missing = boardRoster(["missing"], yes([]), yes([]));
    expect(missing).toEqual({ data: [], options: [], error: false });
    expect(boardScope(boardSearch({ executor: "missing" }), missing.data, [], missing.error).error)
      .toBe("所选员工已失效或不可见，请清除此筛选。");
    const missingGroup = [{ id: "g", name: "missing", description: null,
      members: [{ agentId: "missing", position: 0 }] }];
    expect(boardScope(boardSearch({ groupId: "g" }), missing.data, missingGroup, missing.error).ready).toBe(false);
    expect(boardScope(boardSearch({ groupId: "g" }), missing.data, missingGroup, missing.error).error)
      .toBe("所选小组或其成员已失效或不可见，请清除此筛选。");
  });
  test("an empty group and a board without identity axes do not require catalog success", () => {
    expect(boardRoster([], failed, pending)).toEqual({ data: [], options: [], error: false });
    const empty = [{ id: "g", name: "empty", description: null, members: [] }];
    expect(boardScope(boardSearch({ groupId: "g" }), [], empty))
      .toEqual({ ready: true, error: null, executors: "" });
  });
});
