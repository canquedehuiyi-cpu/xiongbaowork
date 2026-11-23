import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

describe("content origin configuration", () => {
  const configWith = (overrides: Record<string, string | undefined>) =>
    loadConfig(testEnvironment(overrides));

  test("is empty when nothing is set, and when the values are empty", () => {
    expect(configWith({}).content).toEqual({});
    expect(
      configWith({
        XIONGBAO_CONTENT_PORT: "",
        XIONGBAO_CONTENT_DOMAIN: "",
      }).content,
    ).toEqual({});
  });

  test("accepts a port from 1024 to 65535", () => {
    expect(configWith({ XIONGBAO_CONTENT_PORT: "3773" }).content.port).toBe(
      3773,
    );
    expect(configWith({ XIONGBAO_CONTENT_PORT: "1024" }).content.port).toBe(
      1024,
    );
    expect(configWith({ XIONGBAO_CONTENT_PORT: "65535" }).content.port).toBe(
      65535,
    );
  });

  test("refuses a port outside the range or that is not a whole number", () => {
    for (const value of [
      "80",
      "1023",
      "65536",
      "3773.5",
      "30o1",
      "-1",
      "abc",
    ]) {
      expect(() => configWith({ XIONGBAO_CONTENT_PORT: value })).toThrow(
        "XIONGBAO_CONTENT_PORT",
      );
    }
  });

  test("refuses the port the API or the app already uses", () => {
    expect(() =>
      configWith({ XIONGBAO_CONTENT_PORT: "3001", SERVER_PORT: "3001" }),
    ).toThrow("XIONGBAO_CONTENT_PORT");
    expect(() =>
      configWith({ XIONGBAO_CONTENT_PORT: "4010", APP_PORT: "4010" }),
    ).toThrow("XIONGBAO_CONTENT_PORT");
    expect(() => configWith({ XIONGBAO_CONTENT_PORT: "3010" })).toThrow(
      "XIONGBAO_CONTENT_PORT",
    );
  });

  test("accepts a bare host name and refuses anything else", () => {
    expect(
      configWith({ XIONGBAO_CONTENT_DOMAIN: "content.example.com" }).content
        .domain,
    ).toBe("content.example.com");
    expect(
      configWith({ XIONGBAO_CONTENT_DOMAIN: "localhost" }).content.domain,
    ).toBe("localhost");
    for (const value of [
      "https://a.com",
      "a.com:8080",
      "a.com/path",
      "*.a.com",
      "A.com",
      "a b.com",
      ".a.com",
      "a.com.",
      "a..com",
      "-a.com",
      "a_b.com",
    ]) {
      expect(() => configWith({ XIONGBAO_CONTENT_DOMAIN: value })).toThrow(
        "XIONGBAO_CONTENT_DOMAIN",
      );
    }
  });

  test("keeps both when both are set; the domain decides the mode", () => {
    const content = configWith({
      XIONGBAO_CONTENT_PORT: "3773",
      XIONGBAO_CONTENT_DOMAIN: "content.example.com",
    }).content;
    expect(content).toEqual({ port: 3773, domain: "content.example.com" });
  });
});
