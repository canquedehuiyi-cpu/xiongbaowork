import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/** 看板实时推送的试点开关：默认关，浏览器经 /api/capabilities 得知。 */
describe("XIONGBAO_PILOT_BOARD_PUSH", () => {
  const name = "XIONGBAO_PILOT_BOARD_PUSH";
  const configWith = (value?: string) =>
    loadConfig(testEnvironment(value === undefined ? {} : { [name]: value }));

  test("is off when it is not set, and when it is empty", () => {
    expect(configWith().pilotBoardPush).toBe(false);
    expect(configWith("").pilotBoardPush).toBe(false);
  });

  test("is on only for `on`, and off for `off`", () => {
    expect(configWith("on").pilotBoardPush).toBe(true);
    expect(configWith("ON").pilotBoardPush).toBe(true);
    expect(configWith("off").pilotBoardPush).toBe(false);
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
      return (await response.json()) as { boardPush?: boolean };
    };
    expect("boardPush" in (await read())).toBe(false);
    expect("boardPush" in (await read("off"))).toBe(false);
    expect((await read("on")).boardPush).toBe(true);
  });
});
