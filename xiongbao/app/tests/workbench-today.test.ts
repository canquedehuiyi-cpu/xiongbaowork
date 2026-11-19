import { describe, expect, test } from "bun:test";
import {
  greetingFor,
  type TodayTask,
  todayFeed,
  todayStats,
  tonightEnds,
} from "@/lib/workbench/today";

/*
 * 工作台首页的今日口径（聊天工作台 Task 10）：全按浏览器本地时区。日期都用本地时间的构造函数写，所以
 * 不管跑测试的机器在哪个时区，零点和早上 6 点都落在同一处。
 */

/** 本地时间 2026-11-<day> hh:mm。 */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute);

let serial = 0;
function task(overrides: Partial<TodayTask>): TodayTask {
  serial += 1;
  return {
    id: `t${serial}`,
    title: `任务 ${serial}`,
    executorAgentId: "a1",
    status: "done",
    updatedAt: at(14, 10).toISOString(),
    ...overrides,
  };
}

const stats = (
  input: Partial<Parameters<typeof todayStats>[0]> & { now: Date },
) =>
  todayStats({
    tasks: [],
    waiting: 0,
    autonomous: [],
    // 默认本人有一位员工 a1（`task()` 默认是它做的）。
    employees: ["a1"],
    ...input,
  });

describe("todayStats", () => {
  test("在岗员工、等你确认原样带过来", () => {
    const result = stats({
      employees: ["a1", "a2", "a3", "a4", "a5"],
      waiting: 2,
      now: at(14, 15),
    });
    expect(result.onDuty).toBe(5);
    expect(result.waitingOnYou).toBe(2);
  });

  test("今日完成：今天更新、状态是做完了的（待查收、已完成）才算", () => {
    const now = at(14, 15);
    const result = stats({
      now,
      tasks: [
        task({ status: "done", updatedAt: at(14, 9).toISOString() }),
        // 员工做完、等你查收，也是今天做完的。
        task({
          status: "awaiting_review",
          updatedAt: at(14, 11).toISOString(),
        }),
        task({ status: "running", updatedAt: at(14, 12).toISOString() }),
        task({ status: "failed", updatedAt: at(14, 12).toISOString() }),
        task({ status: "needs_action", updatedAt: at(14, 12).toISOString() }),
        // 昨天做完的不算。
        task({ status: "done", updatedAt: at(13, 22).toISOString() }),
      ],
    });
    expect(result.doneToday).toBe(2);
  });

  test("今日完成跨零点：23:59 完成的算昨天，00:00 完成的算今天", () => {
    const now = at(14, 0, 30);
    const result = stats({
      now,
      tasks: [
        task({ updatedAt: at(13, 23, 59).toISOString() }),
        task({ updatedAt: at(14, 0, 0).toISOString() }),
      ],
    });
    expect(result.doneToday).toBe(1);
  });

  test("今日完成只数本人的员工做完的，和「在岗员工」是同一群人", () => {
    const result = stats({
      now: at(14, 15),
      employees: ["a1", "a2"],
      tasks: [
        task({ executorAgentId: "a1" }),
        task({ executorAgentId: "a2" }),
        // 工作区里别人的员工做完的、没有执行员工的，都不算进这个人的今日完成。
        task({ executorAgentId: "teammate-bot" }),
        task({ executorAgentId: null }),
      ],
    });
    expect(result.onDuty).toBe(2);
    expect(result.doneToday).toBe(2);
  });

  test("今日完成不算归档了的卡（归档会把更新时间刷成归档那一刻）", () => {
    const result = stats({
      now: at(14, 15),
      tasks: [
        task({ id: "kept", updatedAt: at(14, 9).toISOString() }),
        task({
          id: "filed",
          updatedAt: at(14, 14).toISOString(),
          archivedAt: at(14, 14).toISOString(),
        }),
        // 没归档（服务端给 null）和老服务端不带这一项的，照常算。
        task({ id: "open", archivedAt: null }),
      ],
    });
    expect(result.doneToday).toBe(2);
  });

  test("今晚定时任务：现在到次日 06:00 之间要跑的才算", () => {
    const now = at(14, 20);
    const result = stats({
      now,
      autonomous: [
        { nextRunAt: at(14, 21).toISOString() },
        { nextRunAt: at(15, 5, 59).toISOString() },
        // 06:00 整点不算今晚。
        { nextRunAt: at(15, 6).toISOString() },
        { nextRunAt: at(15, 9).toISOString() },
        // 已经过去的、没排上的都不算。
        { nextRunAt: at(14, 19).toISOString() },
        { nextRunAt: null },
        { nextRunAt: "不是时间" },
      ],
    });
    expect(result.tonight).toBe(2);
  });

  test("今晚定时任务跨零点：凌晨时今晚到当天 06:00 为止", () => {
    const now = at(15, 1);
    const result = stats({
      now,
      autonomous: [
        { nextRunAt: at(15, 2).toISOString() },
        { nextRunAt: at(15, 7).toISOString() },
        { nextRunAt: at(16, 2).toISOString() },
      ],
    });
    expect(result.tonight).toBe(1);
  });
});

describe("tonightEnds", () => {
  test("早上 6 点以后，今晚到次日 06:00", () => {
    expect(tonightEnds(at(14, 6))).toEqual(at(15, 6));
    expect(tonightEnds(at(14, 23, 59))).toEqual(at(15, 6));
  });

  test("早上 6 点以前，今晚到当天 06:00", () => {
    expect(tonightEnds(at(15, 0))).toEqual(at(15, 6));
    expect(tonightEnds(at(15, 5, 59))).toEqual(at(15, 6));
  });
});

describe("todayFeed", () => {
  test("今天做完的任务按时间倒序，最多 10 条", () => {
    const now = at(14, 20);
    const tasks = [
      ...Array.from({ length: 12 }, (_, index) =>
        task({
          id: `done-${index}`,
          updatedAt: at(14, 8 + index).toISOString(),
        }),
      ),
      task({ id: "running", status: "running" }),
      task({ id: "yesterday", updatedAt: at(13, 23).toISOString() }),
    ];
    const feed = todayFeed(tasks, ["a1"], now);
    expect(feed.map((item) => item.id)).toEqual([
      "done-11",
      "done-10",
      "done-9",
      "done-8",
      "done-7",
      "done-6",
      "done-5",
      "done-4",
      "done-3",
      "done-2",
    ]);
  });

  test("口径和今日完成一样：别人的员工做完的、归档了的都不进今日动态", () => {
    const feed = todayFeed(
      [
        task({ id: "mine", executorAgentId: "a1" }),
        task({ id: "theirs", executorAgentId: "teammate-bot" }),
        task({ id: "nobody", executorAgentId: null }),
        task({
          id: "filed",
          executorAgentId: "a1",
          updatedAt: at(14, 19).toISOString(),
          archivedAt: at(14, 19).toISOString(),
        }),
      ],
      ["a1"],
      at(14, 20),
    );
    expect(feed.map((item) => item.id)).toEqual(["mine"]);
  });

  test("跨零点：昨天 23:59 的不进今日动态", () => {
    const feed = todayFeed(
      [
        task({ id: "late", updatedAt: at(13, 23, 59).toISOString() }),
        task({ id: "early", updatedAt: at(14, 0, 1).toISOString() }),
      ],
      ["a1"],
      at(14, 0, 5),
    );
    expect(feed.map((item) => item.id)).toEqual(["early"]);
  });
});

describe("greetingFor", () => {
  test.each([
    [5, "早上好"],
    [11, "早上好"],
    [12, "下午好"],
    [17, "下午好"],
    [18, "晚上好"],
    [23, "晚上好"],
    [0, "晚上好"],
    [4, "晚上好"],
  ] as const)("%i 点是「%s」", (hour, expected) => {
    expect(greetingFor(at(14, hour, 30))).toBe(expected);
  });
});
