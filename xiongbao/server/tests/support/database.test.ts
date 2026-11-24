import { describe, expect, test } from "bun:test";
import { testDatabaseUrlFrom } from "./database";

describe("TEST_DATABASE_URL", () => {
  test("requires an explicit test database URL", () => {
    expect(() => testDatabaseUrlFrom({})).toThrow(/TEST_DATABASE_URL/);
  });

  test.each(["openbot", "xiongbao"])(
    "refuses the live development database %s even when DATABASE_URL names a test one",
    (name) => {
      expect(() =>
        testDatabaseUrlFrom({
          TEST_DATABASE_URL: `postgres://openbot:openbot@localhost:5432/${name}`,
          DATABASE_URL:
            "postgres://openbot:openbot@localhost:5432/openbot_test",
        }),
      ).toThrow(`live development database (${name})`);
    },
  );

  test("does not read DATABASE_URL as a fallback", () => {
    expect(() =>
      testDatabaseUrlFrom({
        DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot_test",
      }),
    ).toThrow(/TEST_DATABASE_URL/);
  });

  test("accepts a dedicated test database", () => {
    expect(
      testDatabaseUrlFrom({
        TEST_DATABASE_URL:
          "postgres://openbot:openbot@localhost:5432/openbot_test",
      }),
    ).toBe("postgres://openbot:openbot@localhost:5432/openbot_test");
  });
});
