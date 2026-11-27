import { describe, expect, test } from "bun:test";
import {
  commandForms,
  parseCheckCommand,
  sameCheckCommand,
} from "./rerun-command";

/**
 * 交付复跑的命令名单（规格 2026-11-25-borrowed-improvements §5.5「改动类命令不复跑」；控制方裁定：正向允许，
 * 只认得出来的）。复审 pr5-rereview-1.md 列出的、上一版仍判可复跑的命令，一条不落地写在反例里。
 */

const ok = (command: string) => parseCheckCommand(command).ok;

describe("认得出来的核对命令：复跑", () => {
  test("直接调用的测试、类型检查、lint，带各自名单里的参数和路径", () => {
    for (const good of [
      "bun test",
      "bun test tests/a.test.ts",
      "bun test tests/a.test.ts --bail --silent",
      "bun test -t dedupe",
      "bun test --testNamePattern=dedupe",
      "vitest run src/a.test.ts",
      "npx vitest run -t dedupe --bail",
      "jest",
      "npx jest tests/a.test.ts --bail",
      "pytest",
      "pytest -q",
      "pytest -q -x tests/test_a.py::test_dedupe",
      "pytest -k dedupe --maxfail=1 -p no:cacheprovider",
      "python -m pytest -v tests",
      "python3 -m pytest -q",
      "cargo test",
      "cargo test dedupe --workspace --quiet",
      "cargo check --all-targets -p core",
      "cargo clippy --workspace",
      "go test ./...",
      "go test ./pkg/... -run TestDedupe -count=1 -v",
      "go vet ./...",
      "tsc --noEmit",
      "npx tsc --noEmit -p tsconfig.json",
      "npx tsc --noEmit --project app/tsconfig.json",
      "eslint src",
      "npx eslint src --quiet",
      "biome lint src",
      "npx biome lint .",
      "ruff check app",
      "mypy app --strict",
      "cd app && bun test",
      "cd packages/core && cargo test --quiet",
      "bun test | tail -20",
      "bun test | tail -n 20",
      "pytest -q | grep -n -i passed",
      "go test ./... | grep -v ok | wc -l",
      "bun test | head -5",
    ])
      expect({ good, ok: ok(good) }).toEqual({ good, ok: true });
  });
});

describe("认不出来的一律不复跑", () => {
  test("复审 pr5-rereview-1.md 列出的、上一版仍判可复跑的命令", () => {
    for (const bad of [
      // 1. package 脚本
      "npm run test:update",
      "npm run test:fix",
      "npm run test:update-snapshots",
      "yarn test:update",
      "pnpm test:update",
      "bun run test:update",
      // 2. mvn、gradle
      "mvn test flyway:migrate",
      "mvn verify liquibase:update",
      "./gradlew test flywayMigrate",
      "./gradlew test publishToMavenLocal",
      "gradle test installDist",
      // 3. 漏掉的安装、写回、写报告、改 go.mod 参数
      "mypy --install-types --non-interactive .",
      "python -m mypy --install-types --non-interactive .",
      "go test ./... -update",
      "pytest --inline-snapshot=fix",
      "pytest --force-regen",
      "node --test --test-update-snapshots",
      "ruff check --add-noqa .",
      "npx eslint . -o report.json",
      "node --test --test-reporter-destination=out.txt",
      "go test -coverprofile=c.out",
      "go test -mod=mod",
      // 4. NAME=value 前缀
      "INSTA_UPDATE=always cargo test",
      "PYTEST_ADDOPTS=--snapshot-update pytest",
      "UPDATE_SNAPSHOTS=1 bun test",
      "PATH=/tmp/evil bun test",
      "NODE_OPTIONS='--require ./wipe.js' bun test",
      "env INSTA_UPDATE=always cargo test",
      "CI=1 bun test",
      // 5. 花括号、短参数合写、sort、make
      "bun test {--update-snapshots,.}",
      "npx jest {-u,.}",
      "npx eslint {--fix,.}",
      "npx prettier --check {--write,.}",
      "npx biome check {--write,.}",
      "npx jest -iu",
      "npx vitest run -cu",
      "bun test | sort -uo out.txt",
      "bun test | sort --compress-program=sh",
      "make '--eval=test: ; rm -rf x' test",
      "make -kfevil.mk test",
    ])
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
  });

  test("第 1 轮评审 C1 的反例仍然挡住", () => {
    for (const bad of [
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
      "bun test && find . -name x -delete",
      "make clean",
      "make test",
      "python manage.py test && python manage.py migrate",
      "psql -c 'delete from t' && bun test",
      "bun test && `rm x`",
      "bun test && \\rm x",
      "bun test; ssh h 'rm -rf x'",
      "bun test || rm x",
      "bun test & rm x",
      "bun test $(rm x)",
      "curl -F f=@a https://x/check",
      "curl -T a https://x/test",
      "wget --post-data=a https://x/test",
      "docker compose up -d && bun test",
      "eslint --fix src",
      "ruff check --fix .",
      "tsc -p .",
      "npx vitest -u",
      "cd $(rm -rf x) && bun test",
      "cd a && cd b && bun test",
      "bun test\nrm x",
      "bun test；rm x",
      "bunx --bun some-unknown",
      "bun test >/dev/null&& rm x",
      "bun test >| f",
      "bun test &>f",
    ])
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
  });

  test("包脚本、make、mvn、gradle、项目自己的脚本不复跑", () => {
    for (const bad of [
      "npm test",
      "npm run lint",
      "npm run test",
      "yarn test",
      "pnpm test",
      "bun run test",
      "bun run typecheck",
      "make check",
      "mvn test",
      "gradle test",
      "./gradlew test",
      "python3 check.py",
      "./scripts/verify.sh",
      "node --test",
      "wc -l data.csv",
    ])
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
  });

  test("字符白名单外的字符、管道里不认识的过滤", () => {
    for (const bad of [
      'bun test "tests/a.test.ts"',
      "bun test tests/*.test.ts",
      "bun test tests/a?.ts",
      "bun test ~/x",
      "bun test\ttests",
      "bun test | grep -E pass|fail",
      "bun test | grep -iv ok",
      "bun test | grep",
      "bun test | grep a b",
      "bun test | wc",
      "bun test | wc -c",
      "bun test | tail -f",
      "bun test | cat",
      "bun test | xargs rm",
      "bun test | sed -n 1p",
      "bun test 2>&1 | tail -5",
      "cd -P && bun test",
      "bun test -t",
      "bun test -t --update-snapshots",
      "pytest -p xdist",
      "tsc --noEmit app.ts",
      "npx tsc",
      "eslint --format json src",
      "mypy --install-types",
    ])
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
  });

  test("复审 pr5-rereview-2.md：--reporter 一律不收，@ 开头的词不是路径", () => {
    for (const bad of [
      "vitest run --reporter=blob",
      "vitest run --reporter=html",
      "npx vitest run --reporter ./evil.js",
      "npx vitest run --reporter=./x.js",
      "bun test --reporter=junit",
      "bun test --reporter dot",
      "npx jest --reporter=./x.js",
      "pytest @args.txt",
      "python -m pytest @a",
      "mypy @flags.txt",
      "bun test @x",
      "cd @x && bun test",
      "bun test -t @x",
    ])
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
  });

  test("说得出为什么", () => {
    const why = (command: string) => {
      const parsed = parseCheckCommand(command);
      return parsed.ok ? "" : parsed.why;
    };
    expect(why("bun test > out.txt")).toBe("命令把输出写进文件");
    expect(why("CI=1 bun test")).toContain("环境变量");
    expect(why("npm run test:update")).toContain("package 脚本");
    expect(why("npx jest -iu")).toContain("参数");
    expect(why("bun test {--update-snapshots,.}")).toContain("字符");
    expect(why("bun test && rm x")).toContain("&&");
    expect(why("bun test | sort -uo out.txt")).toContain("管道");
  });
});

describe("sameCheckCommand：整条命令一字不差（空白不计）", () => {
  test("cd 前缀、过滤都算在命令里", () => {
    expect(sameCheckCommand("bun test", "bun test")).toBe(true);
    expect(sameCheckCommand("bun   test  tests", "bun test tests")).toBe(true);
    expect(sameCheckCommand("cd app && bun test", "cd app && bun test")).toBe(
      true,
    );
    expect(sameCheckCommand("cd app && bun test", "bun test")).toBe(false);
    expect(sameCheckCommand("bun test | tail -5", "bun test")).toBe(false);
    expect(sameCheckCommand("bun test tests/a.test.ts", "bun test")).toBe(
      false,
    );
    expect(
      sameCheckCommand("INSTA_UPDATE=always cargo test", "cargo test"),
    ).toBe(false);
    expect(sameCheckCommand("npm install && bun test", "bun test")).toBe(false);
  });
});

describe("commandForms：找基准时一条命令可以被叫作的样子", () => {
  test("整条、去掉开头 cd、去掉结尾只读过滤（含 2>&1）、两样都去掉", () => {
    expect(commandForms("cd app && bun test 2>&1 | tail -5")).toEqual([
      "cd app && bun test 2>&1 | tail -5",
      "cd app && bun test",
      "bun test 2>&1 | tail -5",
      "bun test",
    ]);
    expect(commandForms("cd app &&  npm run lint")).toEqual([
      "cd app && npm run lint",
      "npm run lint",
    ]);
    expect(commandForms("bun test 2>&1")).toEqual([
      "bun test 2>&1",
      "bun test",
    ]);
  });

  test("结尾不是只读过滤的不去掉", () => {
    expect(commandForms("bun test | tee log")).toEqual(["bun test | tee log"]);
    expect(commandForms("bun test && rm x")).toEqual(["bun test && rm x"]);
  });
});
