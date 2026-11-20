import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/** The deployment switch for a browser chat's computer tools to be run by the server (期九·一). */
describe("XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS", () => {
  const name = "XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS";
  const configWith = (value?: string) =>
    loadConfig(testEnvironment(value === undefined ? {} : { [name]: value }));

  test("is on when it is not set, and when it is empty (期九·六)", () => {
    expect(configWith().chatServerComputerTools).toBe(true);
    expect(configWith("").chatServerComputerTools).toBe(true);
  });

  test("is on only for `on`, and off for `off`", () => {
    expect(configWith("on").chatServerComputerTools).toBe(true);
    expect(configWith("ON").chatServerComputerTools).toBe(true);
    expect(configWith("off").chatServerComputerTools).toBe(false);
  });

  test("refuses anything else rather than staying off without saying so", () => {
    expect(() => configWith("true")).toThrow(name);
    expect(() => configWith("1")).toThrow(name);
  });
});
