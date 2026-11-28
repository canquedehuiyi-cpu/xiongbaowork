import { describe, expect, test } from "bun:test";
import { outputDir, parseArgs } from "./parity/capture-args";

describe("parity capture 参数", () => {
  test("默认：缩放 1，受众只有 admin", () => {
    const options = parseArgs([]);
    expect(options.scale).toBe(1);
    expect(options.audiences).toEqual(["admin"]);
  });

  test("--scale 2 生效", () => {
    expect(parseArgs(["--scale", "2"]).scale).toBe(2);
  });

  test("--audience all 展开成三种受众", () => {
    expect(parseArgs(["--audience", "all"]).audiences).toEqual([
      "admin",
      "member",
      "personal",
    ]);
    expect(parseArgs(["--audience", "member"]).audiences).toEqual(["member"]);
  });

  test("非法受众与非法缩放给出明确报错", () => {
    expect(() => parseArgs(["--audience", "root"])).toThrow(/--audience/);
    expect(() => parseArgs(["--scale", "0"])).toThrow(/--scale/);
    expect(() => parseArgs(["--scale", "abc"])).toThrow(/--scale/);
  });

  test("输出路径含受众一级", () => {
    expect(outputDir("/out", "member", "data", "light", "390x844")).toBe(
      "/out/member/data/light/390x844",
    );
  });
});
