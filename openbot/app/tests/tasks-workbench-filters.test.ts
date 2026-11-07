import { describe, expect, test } from "bun:test";
import {
  boardEmptySentence,
  boardQuery,
  boardSearch,
  executorOptions,
  LANES,
  sourceLabelOf,
  statusLabelOf,
  TRIGGERS,
  whoAddress,
  whoValue,
} from "@/routes/_authed/_app/tasks";

/**
 * A1 moved the whole filter set into the address, so the address is the thing worth pinning. Every
 * case below is a link somebody could paste into chat: the coercions are what a stale or hand-edited
 * URL meets, and the defaults are what a bare /tasks has to answer with.
 *
 * The mapping onto the wire (machineId to deviceId, crew to executors, executor and group as
 * themselves, 触发方式 to a source list) is
 * `boardQuery`, which is what the page itself sends — one source of truth about the request format,
 * so the round trip below is the page's own and not a copy of it.
 */
const EMPTY = {
  machineId: "",
  crew: "",
  executor: "",
  group: "",
  status: "",
  q: "",
  period: "month",
  view: "list",
  source: "",
} as const;

describe("boardSearch", () => {
  test("a bare address means the whole workspace, over a month, as a list", () => {
    expect(boardSearch({})).toEqual(EMPTY);
  });

  test("the text fields keep strings and drop everything else", () => {
    const TEXT_KEYS = [
      "machineId",
      "crew",
      "executor",
      "group",
      "status",
      "q",
    ] as const;
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

  test("触发方式 is a closed set of the screen's three choices", () => {
    for (const ok of ["chat", "autonomous", "handoff"] as const) {
      expect(boardSearch({ source: ok }).source).toBe(ok);
    }
    // The server's own words are not the address's: `routine` alone is half of 自主工作, not a choice.
    for (const bad of ["routine", "group_run", "", 3, null, "CHAT"]) {
      expect(boardSearch({ source: bad }).source).toBe("");
    }
  });

  test("all the axes survive together rather than one replacing another", () => {
    const shared: ReturnType<typeof boardSearch> = {
      machineId: "d-1",
      crew: "增长群组",
      executor: "agent-a",
      group: "group-1",
      status: "needs_action",
      q: "周报",
      period: "all",
      view: "lanes",
      source: "autonomous",
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
    const both = { machineId: "d-1", crew: "增长群组" };
    expect(boardSearch({ ...both, crew: "" })).toEqual({
      ...EMPTY,
      machineId: "d-1",
    });
    expect(boardSearch({ ...both, machineId: "" })).toEqual({
      ...EMPTY,
      crew: "增长群组",
    });
  });
});

/**
 * Spec A4 and C2 on the wire: what the address asks the server for, through the page's own builder.
 * The address is parsed first, as the route does, so each case is a pasted link end to end.
 */
describe("boardQuery", () => {
  const wire = (search: Record<string, unknown>) =>
    boardQuery(boardSearch(search));

  test("a bare address asks for the month and nothing else", () => {
    expect(wire({})).toEqual({ list: "period=month", scope: "period=month" });
  });

  test("自主工作 is routine and responsibility — the 无人值守 filter — on both reads", () => {
    const { list, scope } = wire({ source: "autonomous" });
    expect(new URLSearchParams(list).get("source")).toBe(
      "routine,responsibility",
    );
    // The stat bar counts inside the same 触发方式, like it does for a crew or a machine.
    expect(new URLSearchParams(scope).get("source")).toBe(
      "routine,responsibility",
    );
  });

  test("对话触发 and 交接 name their own sources, and no choice names none", () => {
    expect(
      new URLSearchParams(wire({ source: "chat" }).list).get("source"),
    ).toBe("chat");
    expect(
      new URLSearchParams(wire({ source: "handoff" }).list).get("source"),
    ).toBe("handoff,group_run");
    expect(new URLSearchParams(wire({}).list).has("source")).toBe(false);
    // A stale or hand-edited value is no filter, not a request the server would answer with nothing.
    expect(
      new URLSearchParams(wire({ source: "routine" }).list).has("source"),
    ).toBe(false);
  });

  test("a Waker or a Group rides as executors; status and words stay off the stat bar's read", () => {
    const { list, scope } = wire({
      machineId: "d-1",
      crew: "agent-a,agent-b",
      status: "failed",
      q: "周报",
      period: "week",
      source: "handoff",
    });
    const asked = new URLSearchParams(list);
    expect(asked.get("deviceId")).toBe("d-1");
    expect(asked.get("executors")).toBe("agent-a,agent-b");
    expect(asked.get("status")).toBe("failed");
    expect(asked.get("q")).toBe("周报");
    expect(asked.get("period")).toBe("week");
    expect(asked.get("source")).toBe("handoff,group_run");
    const counted = new URLSearchParams(scope);
    expect(counted.has("status")).toBe(false);
    expect(counted.has("q")).toBe(false);
    expect(counted.get("executors")).toBe("agent-a,agent-b");
    expect(counted.get("source")).toBe("handoff,group_run");
  });

  test("a coworker chosen in the dropdown rides as executor, whole, on both reads", () => {
    // A package coworker's id may contain a comma: as `executors=` the server would split it in two.
    const { list, scope } = wire({ executor: "pkg,agent" });
    for (const read of [list, scope]) {
      const asked = new URLSearchParams(read);
      expect(asked.get("executor")).toBe("pkg,agent");
      expect(asked.has("executors")).toBe(false);
    }
  });

  test("a crew chosen in the dropdown rides as group, by its id, on both reads", () => {
    // By id rather than roster, so the server can include the crew's run cards (no executor on them).
    const { list, scope } = wire({ group: "group-1" });
    for (const read of [list, scope]) {
      const asked = new URLSearchParams(read);
      expect(asked.get("group")).toBe("group-1");
      expect(asked.has("executors")).toBe(false);
    }
  });

  test("ended is the screen's own filter and is never sent as a status", () => {
    expect(
      new URLSearchParams(wire({ status: "ended" }).list).has("status"),
    ).toBe(false);
  });

  test("every trigger choice is spelled in the spec's words", () => {
    expect(TRIGGERS.map((entry) => entry.label)).toEqual([
      "对话触发",
      "自主工作（无人值守）",
      "交接",
    ]);
  });

  test("a 触发方式 that emptied the list is named as a filter, not as an empty workspace", () => {
    expect(
      boardEmptySentence({
        machineId: "",
        crew: "",
        status: "",
        q: "",
        source: "autonomous",
      }),
    ).toBe("没有符合当前筛选条件的任务。");
  });
});

describe("the Waker/Group dropdown (A4)", () => {
  test("a coworker is offered by id and a crew by its own id, empty crews included", () => {
    const options = executorOptions(
      [
        { id: "agent-a", name: "阿开" },
        { id: "pkg,agent", name: "包里的员工" },
      ],
      [
        { id: "group-1", name: "编程群组" },
        // No members today, but its runs are still its work.
        { id: "group-empty", name: "空组" },
      ],
    );
    expect(options).toEqual([
      { kind: "waker", value: "waker:agent-a", label: "阿开" },
      { kind: "waker", value: "waker:pkg,agent", label: "包里的员工" },
      { kind: "group", value: "group:group-1", label: "群组 · 编程群组" },
      { kind: "group", value: "group:group-empty", label: "群组 · 空组" },
    ]);
  });

  test("a choice writes one who-axis and clears the other two, and reads back as the same choice", () => {
    expect(whoAddress("waker:pkg,agent")).toEqual({
      crew: "",
      executor: "pkg,agent",
      group: "",
    });
    expect(whoAddress("group:group-1")).toEqual({
      crew: "",
      executor: "",
      group: "group-1",
    });
    // 全部 clears all three, including a roster a /wakers link left.
    expect(whoAddress("")).toEqual({ crew: "", executor: "", group: "" });
    for (const value of ["waker:pkg,agent", "group:group-1", "crew:a,b"]) {
      expect(whoValue(boardSearch(whoAddress(value)))).toBe(value);
    }
    // A /wakers link's roster is still shown as the filter it is.
    expect(whoValue(boardSearch({ crew: "agent-a,agent-b" }))).toBe(
      "crew:agent-a,agent-b",
    );
  });
});

/**
 * Spec A3's words on a card. These replace the labels the board used to print (对话/例行/职责/组团 for a
 * source, 已完成/失败 for the two ways work ends), which is the change this story makes.
 */
describe("the card's labels (A3, C2, I2, A5)", () => {
  test("sources read 对话触发 / 自主工作 / 交接", () => {
    expect(sourceLabelOf({ source: "chat" })).toEqual({
      label: "对话触发",
      detail: null,
    });
    expect(sourceLabelOf({ source: "handoff" })).toEqual({
      label: "交接",
      detail: null,
    });
    // I2: a crew's step is registered as a hand-off.
    expect(sourceLabelOf({ source: "group_run" })).toEqual({
      label: "交接",
      detail: null,
    });
  });

  test("自主工作 says which kind, from the trigger when it is recorded and the source when not", () => {
    expect(sourceLabelOf({ source: "routine" })).toEqual({
      label: "自主工作",
      detail: "例行",
    });
    expect(
      sourceLabelOf({ source: "responsibility", triggerSource: null }),
    ).toEqual({
      label: "自主工作",
      detail: "职责",
    });
    expect(
      sourceLabelOf({ source: "routine", triggerSource: "proactive" }),
    ).toEqual({
      label: "自主工作",
      detail: "巡检",
    });
    expect(
      sourceLabelOf({ source: "routine", triggerSource: "automation" }),
    ).toEqual({ label: "自主工作", detail: "自动任务" });
    // The server stores an automation's trigger with its kind (`automation:<kind>`) and a wake-up
    // follow-up as `wake_up` (C2); both read as their own kind, not the lane's fallback.
    expect(
      sourceLabelOf({
        source: "routine",
        triggerSource: "automation:schedule",
      }),
    ).toEqual({ label: "自主工作", detail: "自动任务" });
    expect(
      sourceLabelOf({ source: "routine", triggerSource: "wake_up" }),
    ).toEqual({ label: "自主工作", detail: "唤醒跟进" });
    // A trigger this release does not know keeps the source's own answer.
    expect(
      sourceLabelOf({ source: "routine", triggerSource: "webhook" }),
    ).toEqual({
      label: "自主工作",
      detail: "例行",
    });
    // A trigger on a non-autonomous card adds nothing.
    expect(
      sourceLabelOf({ source: "chat", triggerSource: "proactive" }),
    ).toEqual({
      label: "对话触发",
      detail: null,
    });
  });

  test("an unknown source keeps its own value rather than going blank", () => {
    expect(sourceLabelOf({ source: "carrier" })).toEqual({
      label: "carrier",
      detail: null,
    });
  });

  test("statuses read 进行中 / 需要操作 / 已结束-已完成 / 已结束-失败", () => {
    expect(statusLabelOf({ status: "running" })).toBe("进行中");
    expect(statusLabelOf({ status: "needs_action" })).toBe("需要操作");
    expect(statusLabelOf({ status: "done" })).toBe("已结束-已完成");
    expect(statusLabelOf({ status: "failed" })).toBe("已结束-失败");
    // Filed away or not, a failure reads the same: P1's archived wording is the spec's wording.
    expect(
      statusLabelOf({ status: "failed", archivedAt: new Date().toISOString() }),
    ).toBe("已结束-失败");
  });

  test("the lanes are 进行中 / 需要操作 / 已结束", () => {
    expect(LANES.map((lane) => lane.label)).toEqual([
      "进行中",
      "需要操作",
      "已结束",
    ]);
  });
});
