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
  sameCheckCommand,
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
  test("测试、类型检查、lint 的只读形式、统计数可以复跑", () => {
    for (const good of [
      "bun test tests/a.test.ts",
      "pytest -q",
      "cd app && bun test 2>&1 | tail -20",
      "bun test 2>/dev/null",
      "CI=1 npm test",
      "npm run test:unit -- --runInBand",
      "pnpm typecheck",
      "bunx tsc --noEmit -p .",
      "npx jest tests/a.test.ts | grep -E 'passed|failed'",
      "bunx biome check src",
      "npx eslint src",
      "npx prettier --check .",
      "python3 -m pytest tests -x 2>&1 | tail -5",
      "python manage.py test app.tests",
      "ruff check .",
      "go test ./...",
      "go vet ./...",
      "cargo test --release",
      "make test",
      "wc -l data.csv",
      "grep -c done log.txt",
      "diff -u a.txt b.txt",
      "git diff --stat",
      "cd 'my app' && \"bun\" test | sort -u | head -3",
    ]) {
      const verdict = isRerunnable(good);
      expect({ good, verdict }).toEqual({ good, verdict: { ok: true } });
    }
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
      // 评审 C1 实测漏过的：写回、装软件、删除、改库、绕过、联网写入、起服务。
      "bunx biome check --write .",
      "prettier --check . --write",
      "jest -u",
      "bun test --update-snapshots",
      "pytest --snapshot-update",
      "npm install && npm test",
      "pip install -r r.txt && pytest",
      "cargo test && cargo install --path .",
      "git clean -fdx && bun test",
      "git stash && bun test",
      "bun test && find . -name '*.tmp' -delete",
      "make clean",
      "bun test && rmdir x",
      "bun test && truncate -s0 a",
      "python manage.py test && python manage.py migrate",
      "python manage.py migrate",
      "psql -c 'delete from t' && bun test",
      "bun test && `rm x`",
      "bun test && \\rm x",
      "bun test; ssh h 'rm -rf x'",
      "bun test || rm x",
      "bun test & rm x",
      "bun test $(rm x)",
      'echo "$(rm x)" | bun test',
      "curl -F f=@a https://x/check",
      "curl -T a https://x/test",
      "curl --json '{}' https://x/test",
      "wget --post-data=a https://x/test",
      "docker compose up -d && bun test",
      "find . -name '*.ts' -delete",
      "eslint --fix src",
      "ruff check --fix .",
      "black .",
      "tsc -p .",
      "npm run lint",
      "npm run build",
      "make test install",
      "bun test | sort -o out.txt",
      "bun test | sed -n 1p",
      "bun test | xargs rm",
      "bun test 2> err.txt",
      "bun test < input.txt",
      "cd app && cd .. && bun test",
      "(cd app && bun test)",
      "bun test\nrm x",
      "python3 check.py",
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

describe("sameCheckCommand", () => {
  test("整条命令按同一规则解析：同一个核对、写了的 cd 和过滤也要对上", () => {
    expect(sameCheckCommand("bun test", "bun test")).toBe(true);
    expect(
      sameCheckCommand("cd app && bun test 2>&1 | tail -20", "bun test"),
    ).toBe(true);
    expect(sameCheckCommand("cd app && bun test", "cd app && bun test")).toBe(
      true,
    );
    expect(sameCheckCommand('bun   "test"', "bun test")).toBe(true);
    // 子串不算：多带了参数的是另一条命令。
    expect(sameCheckCommand("bun test tests/a.test.ts", "bun test")).toBe(
      false,
    );
    expect(sameCheckCommand("cd web && bun test", "cd app && bun test")).toBe(
      false,
    );
    expect(sameCheckCommand("bun test | tail -5", "bun test | tail -20")).toBe(
      false,
    );
    // 原命令不可复跑，就对不上：不会因为里面「含有」声明的命令被选作基准。
    expect(sameCheckCommand("npm install && bun test", "bun test")).toBe(false);
    expect(sameCheckCommand("git clean -fdx && bun test", "bun test")).toBe(
      false,
    );
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
