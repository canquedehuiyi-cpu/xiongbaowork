import { describe, expect, test } from "bun:test";
import {
  claimsTested,
  isRerunnable,
  NO_RERUN_PREFIX,
  numbersOf,
  outputsAgree,
  RERUN_DRIFT,
  RERUN_MAX,
  RERUN_TIMEOUT_MS,
  TESTED_CLAIM_WORDS,
} from "./rerun";

describe("复跑的固定数值", () => {
  test("每条 120 秒、至多 3 条、偏差 0.1、「无法复跑：」开头", () => {
    expect(RERUN_MAX).toBe(3);
    expect(RERUN_TIMEOUT_MS).toBe(120_000);
    expect(RERUN_DRIFT).toBe(0.1);
    expect(NO_RERUN_PREFIX).toBe("无法复跑：");
    expect([...TESTED_CLAIM_WORDS]).toEqual([
      "测试",
      "测过",
      "跑过",
      "运行过",
      "跑通",
      "通过",
      "校验过",
      "验证过",
      "passed",
      "tests pass",
      "pytest",
      "jest",
      "vitest",
    ]);
  });
});

describe("claimsTested", () => {
  test("说跑过、通过的算声称测过", () => {
    expect(claimsTested(["跑过 bun test，全部通过"])).toBe(true);
    expect(claimsTested(["改好了", "pytest 全绿"])).toBe(true);
    expect(claimsTested(["All tests PASSED"])).toBe(true);
  });

  test("只是提到「测试报告」这种名词，不算声称测过（Review Focus 1）", () => {
    expect(claimsTested(["这份测试报告的格式已统一"])).toBe(false);
  });

  test("没有任何测过类说法的不算", () => {
    expect(claimsTested(["表格已按要求排版"])).toBe(false);
    expect(claimsTested([])).toBe(false);
  });
});

describe("isRerunnable", () => {
  test("测试、校验类命令可以复跑", () => {
    expect(isRerunnable("bun test tests/a.test.ts").ok).toBe(true);
    expect(isRerunnable("pytest -q").ok).toBe(true);
    expect(isRerunnable("cd app && bun test 2>&1 | tail -20").ok).toBe(true);
    expect(isRerunnable("bun test 2>/dev/null").ok).toBe(true);
  });

  test("改动类命令不复跑", () => {
    for (const bad of [
      "bun test > out.txt",
      "bun test >> out.txt",
      "make install",
      "make deploy",
      "make release",
      "git commit -am x && bun test",
      "git push && bun test",
      "rm -rf dist && bun run build",
      "curl -X POST https://x/test",
      "curl -XPUT https://x/check",
      "curl -d a=1 https://x/check",
      "curl --data a=1 https://x/check",
      "npm publish",
      "bun publish --dry-run && bun test",
      "docker push x",
      "kubectl apply -f k.yaml",
      "kubectl delete -f k.yaml && make check",
      "sed -i s/a/b/ f && bun test",
      "bun test | tee log",
    ]) {
      const verdict = isRerunnable(bad);
      expect({ bad, ok: verdict.ok }).toEqual({ bad, ok: false });
      if (!verdict.ok) expect(verdict.why.length).toBeGreaterThan(0);
    }
  });

  test("不是核对类的命令不复跑", () => {
    const verdict = isRerunnable("ls -la");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("核对");
  });
});

describe("numbersOf", () => {
  test("去掉耗时、日期、时刻，留下结果数字（Review Focus 3）", () => {
    expect(
      numbersOf(
        "Ran 12 tests in 0.53s\n12 passed in 1.20s at 2026-11-25 10:31:07",
      ),
    ).toEqual([12, 12]);
  });

  test("各种时间单位都去掉", () => {
    expect(numbersOf("3 ok 15ms 2 sec 4 秒 1分 7 min 2h")).toEqual([3]);
    expect(numbersOf("耗时 9:05 共 -4 项，比例 0.25")).toEqual([-4, 0.25]);
  });
});

describe("outputsAgree", () => {
  test("偏差在 10% 以内算一致", () => {
    expect(
      outputsAgree(
        { exitCode: 0, output: "rows: 100" },
        { exitCode: 0, output: "rows: 105" },
      ),
    ).toEqual({ agree: true });
    expect(
      outputsAgree(
        { exitCode: 0, output: "rows: 0" },
        { exitCode: 0, output: "rows: 0" },
      ),
    ).toEqual({ agree: true });
  });

  test("偏差超过 10% 不一致", () => {
    const verdict = outputsAgree(
      { exitCode: 0, output: "rows: 100" },
      { exitCode: 0, output: "rows: 111" },
    );
    expect(verdict.agree).toBe(false);
    if (!verdict.agree) expect(verdict.why).toContain("100");
  });

  test("偏差按原来那次的数字算", () => {
    const at = (before: string, after: string) =>
      outputsAgree(
        { exitCode: 0, output: before },
        { exitCode: 0, output: after },
      ).agree;
    expect(at("rows: 100", "rows: 90")).toBe(true);
    expect(at("rows: 100", "rows: 89")).toBe(false);
    expect(at("rows: 0", "rows: 1")).toBe(false);
  });

  test("退出码从 0 变成非 0 不一致", () => {
    expect(
      outputsAgree({ exitCode: 0, output: "ok" }, { exitCode: 1, output: "ok" })
        .agree,
    ).toBe(false);
  });

  test("数字个数不同不一致", () => {
    expect(
      outputsAgree(
        { exitCode: 0, output: "a 1 b 2" },
        { exitCode: 0, output: "a 1" },
      ).agree,
    ).toBe(false);
  });

  test("耗时不同但结果相同算一致（Review Focus 3）", () => {
    expect(
      outputsAgree(
        { exitCode: 0, output: "Ran 12 tests in 0.53s\n12 passed in 1.20s" },
        { exitCode: 0, output: "Ran 12 tests in 4.10s\n12 passed in 9.88s" },
      ),
    ).toEqual({ agree: true });
  });

  test("基准被截断时只比两边都有的前几个数字", () => {
    expect(
      outputsAgree(
        { exitCode: 0, output: "a 1 b 2" },
        { exitCode: 0, output: "a 1 b 2 c 3 d 4" },
        true,
      ),
    ).toEqual({ agree: true });
    expect(
      outputsAgree(
        { exitCode: 0, output: "a 1 b 2" },
        { exitCode: 0, output: "a 1 b 9 c 3" },
        true,
      ).agree,
    ).toBe(false);
  });
});
