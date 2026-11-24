import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/** 审批箱批注的试点开关：默认关，浏览器经 /api/capabilities 得知。 */
describe("XIONGBAO_PILOT_INBOX_NOTES", () => {
  const name = "XIONGBAO_PILOT_INBOX_NOTES";
  const configWith = (value?: string) =>
    loadConfig(testEnvironment(value === undefined ? {} : { [name]: value }));

  test("is off when it is not set, and when it is empty", () => {
    expect(configWith().pilotInboxNotes).toBe(false);
    expect(configWith("").pilotInboxNotes).toBe(false);
  });

  test("is on only for `on`, and off for `off`", () => {
    expect(configWith("on").pilotInboxNotes).toBe(true);
    expect(configWith("ON").pilotInboxNotes).toBe(true);
    expect(configWith("off").pilotInboxNotes).toBe(false);
  });

  test("refuses anything else rather than staying off without saying so", () => {
    expect(() => configWith("true")).toThrow(name);
    expect(() => configWith("1")).toThrow(name);
  });

  test("the browser hears nothing of it by default, and is told when it is on", async () => {
    const read = async (value?: string) => {
      const response = await createApp(configWith(value)).request(
        "/api/capabilities",
      );
      return (await response.json()) as { inboxNotes?: boolean };
    };
    expect("inboxNotes" in (await read())).toBe(false);
    expect("inboxNotes" in (await read("off"))).toBe(false);
    expect((await read("on")).inboxNotes).toBe(true);
  });
});
