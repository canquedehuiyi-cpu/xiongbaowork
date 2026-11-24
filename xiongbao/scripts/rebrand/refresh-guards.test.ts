import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAllowlist, refreshBudget } from "./refresh-guards";

const script = join(import.meta.dir, "refresh-guards.ts");
const realTests = join(import.meta.dir, "../../app/tests");

describe("refreshBudget", () => {
  const row = (rule: string, scope: string, lines: number) => ({
    rule,
    scope,
    lines,
  });

  test("某行变小就写成实际值，降到 0 的行删掉", () => {
    const { next, grew } = refreshBudget(
      [row("env-name", "server/src", 5), row("declaration", "app/src", 2)],
      [row("env-name", "server/src", 3)],
    );
    expect(grew).toEqual([]);
    expect(next).toEqual([row("env-name", "server/src", 3)]);
  });

  test("某行变大或冒出新行都算增长，列出并不写", () => {
    const { grew } = refreshBudget(
      [row("env-name", "server/src", 3)],
      [row("env-name", "server/src", 4), row("crypto-name", "app/src", 1)],
    );
    expect(grew).toEqual([
      "crypto-name/app/src: 0 -> 1",
      "env-name/server/src: 3 -> 4",
    ]);
  });

  test("文件改名后，旧行的范围跟着改名，不被当成新增", () => {
    const { next, grew } = refreshBudget(
      [row("env-name", "shared/openbot-browser.ts", 2)],
      [row("env-name", "shared/xiongbao-browser.ts", 2)],
    );
    expect(grew).toEqual([]);
    expect(next).toEqual([row("env-name", "shared/xiongbao-browser.ts", 2)]);
  });
});

describe("refreshBudget 同一份旧额度只领一次", () => {
  test("旧文件未改名、又新建了改名后同名的文件，合计增长要报", () => {
    const { grew } = refreshBudget(
      [{ rule: "env-name", scope: "shared/openbot-browser.ts", lines: 2 }],
      [
        { rule: "env-name", scope: "shared/openbot-browser.ts", lines: 2 },
        { rule: "env-name", scope: "shared/xiongbao-browser.ts", lines: 2 },
      ],
    );
    expect(grew).toEqual(["env-name/shared/xiongbao-browser.ts: 2 -> 4"]);
  });
});

describe("refreshAllowlist", () => {
  const entry = (file: string, text: string) => ({
    file,
    text,
    reason: "persisted-identifier: x",
  });

  test("路径套改名；文本在改名后的文件里已不存在的条目删除", () => {
    const present = new Map([
      ["shared/xiongbao-browser.ts", ['const a = "openbot-browser";']],
      ["app/src/keep.ts", ['const b = "openbot://open";']],
    ]);
    const has = (file: string, text: string) =>
      (present.get(file) ?? []).some((line) => line.includes(text));
    const { next, removed } = refreshAllowlist(
      [
        entry("shared/openbot-browser.ts", '"openbot-browser"'),
        entry("app/src/keep.ts", '"openbot://open"'),
        entry("app/src/gone.ts", "openbot.surface"),
      ],
      has,
    );
    expect(next.map((e) => e.file)).toEqual([
      "shared/xiongbao-browser.ts",
      "app/src/keep.ts",
    ]);
    expect(removed.map((e) => e.file)).toEqual(["app/src/gone.ts"]);
  });

  test("文件还没改名时按原路径认，条目原样保留", () => {
    const { next, renamed } = refreshAllowlist(
      [entry("shared/openbot-browser.ts", "openbot-browser")],
      (file) => file === "shared/openbot-browser.ts",
    );
    expect(next.map((e) => e.file)).toEqual(["shared/openbot-browser.ts"]);
    expect(renamed).toBe(0);
  });

  test("工具目录与跳过路径下的条目原样保留", () => {
    const { next } = refreshAllowlist(
      [
        entry("scripts/rebrand/x.ts", "openbot"),
        entry("server/drizzle/0001.sql", "openbot"),
      ],
      () => false,
    );
    expect(next.map((e) => e.file)).toEqual([
      "scripts/rebrand/x.ts",
      "server/drizzle/0001.sql",
    ]);
  });
});

describe("refresh-guards 命令行", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rebrand-guards-"));
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "brand-budget.json",
      "brand-leak-allowlist.json",
      "product-name-allowlist.json",
    ])
      copyFileSync(join(realTests, name), join(dir, name));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () =>
    Bun.spawnSync(["bun", script, "--tests-dir", dir], {
      cwd: import.meta.dir,
    });
  const readBudget = () =>
    JSON.parse(readFileSync(join(dir, "brand-budget.json"), "utf8")) as Array<{
      rule: string;
      scope: string;
      lines: number;
    }>;

  test("预算里有一行比实际大，就改成实际值（预算只许变小）", () => {
    const budget = readBudget();
    const original = budget[0]?.lines as number;
    (budget[0] as { lines: number }).lines = original + 7;
    writeFileSync(
      join(dir, "brand-budget.json"),
      `${JSON.stringify(budget, null, 2)}\n`,
    );
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(readBudget()[0]?.lines).toBe(original);
  });

  test("预算里有一行比实际小，就退出 1、列出该行并且不写文件", () => {
    const budget = readBudget();
    const original = budget[0]?.lines as number;
    (budget[0] as { lines: number }).lines = original - 1;
    const text = `${JSON.stringify(budget, null, 2)}\n`;
    writeFileSync(join(dir, "brand-budget.json"), text);
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `${budget[0]?.rule}/${budget[0]?.scope}`,
    );
    expect(readFileSync(join(dir, "brand-budget.json"), "utf8")).toBe(text);
  });

  test("白名单里文件已不存在的条目被删除，其余条目与排版不动", () => {
    const path = join(dir, "brand-leak-allowlist.json");
    const entries = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    writeFileSync(
      path,
      `${JSON.stringify(
        [
          ...entries,
          {
            file: "app/src/not-there.ts",
            text: "openbot",
            reason: "developer-only: 夹具",
            category: "developer-only",
            plan: "keep",
          },
        ],
        null,
        2,
      )}\n`,
    );
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(
      readFileSync(join(realTests, "brand-leak-allowlist.json"), "utf8"),
    );
  });

  test("护栏与实际一致时重复运行零改动", () => {
    const before = ["brand-budget.json", "brand-leak-allowlist.json"].map(
      (name) => readFileSync(join(dir, name), "utf8"),
    );
    expect(run().exitCode).toBe(0);
    const after = ["brand-budget.json", "brand-leak-allowlist.json"].map(
      (name) => readFileSync(join(dir, name), "utf8"),
    );
    expect(after).toEqual(before);
  });
});
