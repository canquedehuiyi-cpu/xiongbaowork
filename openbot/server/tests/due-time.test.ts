import { describe, expect, test } from "bun:test";
import { parseDueTime } from "../src/tasks/due-time";

/**
 * 员工报的预计交付时间（spec 2026-11-15-delivery-loop 第 4 节）：相对时长、钟点、上下午、明早，按
 * 用户的时区换算成一个时刻。认不出的一律 null，由工具按「没报时间、接下后 2 小时核对」处理。
 */
const SHANGHAI = "Asia/Shanghai";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseDueTime", () => {
  // 上海时间 2026-11-15 10:00（UTC 02:00）。
  const morning = new Date("2026-11-15T02:00:00Z");
  const at = (iso: string) => new Date(iso).getTime();

  const cases: [string, number | null][] = [
    // 相对时长
    ["40 分钟", morning.getTime() + 40 * MINUTE],
    ["40分钟", morning.getTime() + 40 * MINUTE],
    ["四十分钟", morning.getTime() + 40 * MINUTE],
    ["2 小时", morning.getTime() + 2 * HOUR],
    ["两个小时", morning.getTime() + 2 * HOUR],
    ["半小时", morning.getTime() + 30 * MINUTE],
    ["1.5 小时", morning.getTime() + 90 * MINUTE],
    ["3 天", morning.getTime() + 3 * DAY],
    ["45 minutes", morning.getTime() + 45 * MINUTE],
    ["2 hours", morning.getTime() + 2 * HOUR],
    // 相对时长最多 30 天
    ["40 天", morning.getTime() + 30 * DAY],
    ["预计 40 分钟", morning.getTime() + 40 * MINUTE],
    // 钟点：今天还没到就是今天
    ["15:00", at("2026-11-15T07:00:00Z")],
    ["15：00", at("2026-11-15T07:00:00Z")],
    ["15点30分", at("2026-11-15T07:30:00Z")],
    ["下午三点", at("2026-11-15T07:00:00Z")],
    ["下午3点20", at("2026-11-15T07:20:00Z")],
    ["晚上八点半", at("2026-11-15T12:30:00Z")],
    ["中午12点", at("2026-11-15T04:00:00Z")],
    ["上午十一点", at("2026-11-15T03:00:00Z")],
    // 钟点：今天已经过了、又没说哪天，就是明天
    ["9:00", at("2026-11-16T01:00:00Z")],
    ["上午九点", at("2026-11-16T01:00:00Z")],
    // 说了哪天
    ["明早 10 点", at("2026-11-16T02:00:00Z")],
    ["明天下午3点", at("2026-11-16T07:00:00Z")],
    ["明晚 9 点", at("2026-11-16T13:00:00Z")],
    ["后天上午10点", at("2026-11-17T02:00:00Z")],
    // 说了今天，过去的时刻不往后挪
    ["今天 9 点", at("2026-11-15T01:00:00Z")],
    // 完整的时刻
    ["2026-11-15T15:00:00+08:00", at("2026-11-15T07:00:00Z")],
    // 认不出
    ["", null],
    ["尽快", null],
    ["明天", null],
    ["25:00", null],
    ["0 分钟", null],
  ];

  for (const [text, expected] of cases) {
    test(`「${text}」 in Asia/Shanghai`, () => {
      const parsed = parseDueTime(text, morning, SHANGHAI);
      expect(parsed?.getTime() ?? null).toBe(expected);
    });
  }

  test("a clock time already past at 16:00 rolls to tomorrow: 15:00 said at 16:00", () => {
    const afternoon = new Date("2026-11-15T08:00:00Z"); // 上海 16:00
    expect(parseDueTime("15:00", afternoon, SHANGHAI)?.toISOString()).toBe(
      "2026-11-16T07:00:00.000Z",
    );
    expect(parseDueTime("下午三点", afternoon, SHANGHAI)?.toISOString()).toBe(
      "2026-11-16T07:00:00.000Z",
    );
  });

  test("the local day is the person's, not UTC's", () => {
    // 上海已是 11-16 01:00，UTC 还在 11-15：「明早 10 点」是上海的 11-17 10:00。
    const lateNight = new Date("2026-11-15T17:00:00Z");
    expect(parseDueTime("明早 10 点", lateNight, SHANGHAI)?.toISOString()).toBe(
      "2026-11-17T02:00:00.000Z",
    );
    // 同一时刻的洛杉矶是 11-15 09:00：「15:00」是洛杉矶当天下午三点。
    expect(
      parseDueTime("15:00", lateNight, "America/Los_Angeles")?.toISOString(),
    ).toBe("2026-11-15T23:00:00.000Z");
  });
});
