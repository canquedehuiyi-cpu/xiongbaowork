import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/** How long one end-of-turn notice stands in for the turns that end right after it (期九·五). */
describe("XIONGBAO_TURN_NOTICE_WINDOW_SECONDS", () => {
  const name = "XIONGBAO_TURN_NOTICE_WINDOW_SECONDS";
  const configWith = (value?: string) =>
    loadConfig(testEnvironment(value === undefined ? {} : { [name]: value }));

  test("is a minute when it is not set, and when it is empty", () => {
    expect(configWith().turnNoticeWindowMs).toBe(60_000);
    expect(configWith("").turnNoticeWindowMs).toBe(60_000);
  });

  test("is the number of seconds it says, and 0 says every turn", () => {
    expect(configWith("120").turnNoticeWindowMs).toBe(120_000);
    expect(configWith("0").turnNoticeWindowMs).toBe(0);
    expect(configWith("86400").turnNoticeWindowMs).toBe(86_400_000);
  });

  test("refuses anything else rather than quietly turning the merging off or making it swallow a day", () => {
    for (const value of ["-1", "1.5", "1m", "sixty", "86401", "1e3"])
      expect(() => configWith(value)).toThrow(name);
  });
});
