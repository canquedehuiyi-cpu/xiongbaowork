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
  runsAgree,
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

describe("isRerunnable（名单的全部用例见 rerun-command.test.ts）", () => {
  test("brief 的正例和反例", () => {
    expect(isRerunnable("bun test tests/a.test.ts").ok).toBe(true);
    expect(isRerunnable("pytest -q").ok).toBe(true);
    for (const bad of [
      "bun test > out.txt",
      "make install",
      "make deploy",
      "git commit -am x && bun test",
      "rm -rf dist && bun run build",
      "curl -X POST https://x/test",
      "curl -d a=1 https://x/check",
      "npm publish",
      "docker push x",
      "kubectl apply -f k.yaml",
      "sed -i s/a/b/ f && bun test",
      "bun test | tee log",
    ])
      expect({ bad, ok: isRerunnable(bad).ok }).toEqual({ bad, ok: false });
    const listing = isRerunnable("ls -la");
    expect(listing.ok).toBe(false);
    if (!listing.ok) expect(listing.why).toContain("核对");
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
});

describe("runsAgree：基准按截断方式对齐（评审 I2）", () => {
  const whole = (stdout: string, exitCode = 0) => ({
    exitCode,
    stdout,
    stderr: "",
  });
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `case ${from + i} ok`).join(
      "\n",
    );

  test("两边都完整：和 outputsAgree 一样", () => {
    expect(runsAgree(whole("12 passed"), whole("12 passed"))).toEqual({
      agree: true,
    });
    expect(runsAgree(whole("12 passed"), whole("8 passed"))).toMatchObject({
      agree: false,
    });
    expect(runsAgree(whole("ok"), whole("ok", 1))).toMatchObject({
      agree: false,
    });
  });

  test("只留尾的长输出（安静模式）：比尾部，省略标记里的行数不当数字", () => {
    const before = whole(
      `…（前面省略 488 行）…\n${lines(489, 500)}\n500 passed`,
    );
    expect(runsAgree(before, whole(`${lines(1, 500)}\n500 passed`))).toEqual({
      agree: true,
    });
    expect(
      runsAgree(before, whole(`${lines(1, 500)}\n420 passed`)),
    ).toMatchObject({ agree: false });
  });

  test("电脑截掉了前面（truncated）：丢掉被切开的第一行，比尾部", () => {
    const before = {
      ...whole(`7 ok\n${lines(10, 20)}\n20 passed`),
      truncated: true,
    };
    expect(runsAgree(before, whole(`${lines(1, 20)}\n20 passed`))).toEqual({
      agree: true,
    });
  });

  test("留头尾的长输出：开头比开头、结尾比结尾", () => {
    const before = whole(
      `start 1\nstart 2\n…（中间省略 300 行，约 9000 字节）…\n${lines(299, 300)}\n300 passed`,
    );
    const full = `start 1\nstart 2\n${lines(1, 300)}\n300 passed`;
    expect(runsAgree(before, whole(full))).toEqual({ agree: true });
    expect(
      runsAgree(before, whole(full.replace("start 2", "start 9"))),
    ).toMatchObject({ agree: false });
    expect(
      runsAgree(before, whole(full.replace("300 passed", "250 passed"))),
    ).toMatchObject({ agree: false });
  });

  test("对齐不了：记未复核，不判不一致", () => {
    // 复跑的输出比原来留下的头尾加起来还短。
    const before = whole(
      "a 1\na 2\n…（中间省略 300 行，约 9000 字节）…\nb 3\nb 4",
    );
    expect(runsAgree(before, whole("only 5"))).toHaveProperty("unaligned");
    // 两个省略标记：认不出截断方式。
    expect(
      runsAgree(
        whole("…（前面省略 3 行）…\n1\n…（中间省略 3 行，约 9 字节）…\n2"),
        whole("1 2"),
      ),
    ).toHaveProperty("unaligned");
  });
});
