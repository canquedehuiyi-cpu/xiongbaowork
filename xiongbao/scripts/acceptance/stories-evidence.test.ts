import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkStories,
  type Facts,
  jobFor,
  loadFacts,
  parseStories,
  STORY_COUNT,
} from "./stories-evidence";

const PIN = "c905e0d3";
const HEADER = `**2026-11-18 整表刷新（\`main\` \`${PIN}\`）**\n`;
const TABLE_HEAD = [
  "| 故事 | 包 | 原始需求（摘要） | 集成分支状态 | 交付 PR | 门 | 证据（集成分支上的测试） | 验收状态 | 备注 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

const FACTS: Facts = {
  workspaces: new Set(["runner"]),
  serverManifest: new Set(["server/tests/a.test.ts"]),
  appManifest: new Set(["app/tests/b.test.tsx"]),
};

/** 造一行故事：只有证据列与验收状态是变量，其余照真表的形状。 */
function row(
  id: string,
  evidence: string,
  status = `accepted (main ${PIN})`,
  note = "",
): string {
  return `| ${id} | D05 | 需求 | implemented | 基线（main 上已有） | G3 | ${evidence} | ${status} | ${note} |`;
}

/** 77 行全绿的基线表，单条用例只改其中一处去造反例。 */
function table(rows: readonly string[]): string {
  return `${HEADER}\n${TABLE_HEAD}\n${rows.join("\n")}\n`;
}

function cleanRows(): string[] {
  return Array.from({ length: STORY_COUNT }, (_, i) =>
    row(`A${i + 1}`, "`server/tests/a.test.ts`<br>`app/tests/b.test.tsx`"),
  );
}

/** 77 行仍是 77 行，只把第 index 行的证据换掉——单条判据的用例不该被行数判据盖住。 */
function rowsWith(index: number, evidence: string): string[] {
  const rows = cleanRows();
  rows[index] = row(`A${index + 1}`, evidence);
  return rows;
}

const always = { exists: () => true };

describe("parseStories", () => {
  // F1 那种一行里塞了「路径 +（括号里的说明 + 另一条路径）」的写法，旧的正则会把整段当成一个 token。
  test("一段反引号里有说明与路径时，只取像路径的那几个", () => {
    const stories = parseStories(
      table([
        row(
          "F1",
          "`desktop-device/src-tauri`（`cargo test --locked`，`desktop-device/src-tauri/src/roots.rs`）<br>`app/tests/b.test.tsx`",
        ),
      ]),
    );
    expect(stories.rows).toHaveLength(1);
    expect(stories.rows[0]?.evidence).toEqual([
      "desktop-device/src-tauri",
      "desktop-device/src-tauri/src/roots.rs",
      "app/tests/b.test.tsx",
    ]);
  });

  test("接口路径与命令不会被当成证据文件", () => {
    const stories = parseStories(
      table([
        row(
          "A1",
          "`/api/routines`、`bun test app/tests/b.test.tsx`<br>`app/tests/b.test.tsx`",
        ),
      ]),
    );
    expect(stories.rows[0]?.evidence).toEqual(["app/tests/b.test.tsx"]);
  });

  test("同一行重复引用只算一次，跨行不合并", () => {
    const stories = parseStories(
      table([
        row("A1", "`app/tests/b.test.tsx`<br>`app/tests/b.test.tsx`"),
        row("A2", "`app/tests/b.test.tsx`"),
      ]),
    );
    expect(stories.rows[0]?.evidence).toEqual(["app/tests/b.test.tsx"]);
    expect(stories.rows[1]?.evidence).toEqual(["app/tests/b.test.tsx"]);
  });

  test("表头钉住的提交从「整表刷新」那句话里读", () => {
    expect(
      parseStories(table([row("A1", "`app/tests/b.test.tsx`")])).headerPin,
    ).toBe(PIN);
    expect(parseStories("# 没有表头\n").headerPin).toBeNull();
  });
});

describe("jobFor", () => {
  test("清单里有才是被跑到的：同一份证据，掉出清单就没人跑", () => {
    expect(jobFor("server/tests/a.test.ts", FACTS)).toBe("server-test");
    expect(jobFor("server/tests/gone.test.ts", FACTS)).toBeNull();
    expect(jobFor("app/tests/b.test.tsx", FACTS)).toBe("app-test");
    expect(jobFor("app/tests/gone.test.tsx", FACTS)).toBeNull();
  });

  test("设备端的 tests/ 与 src-tauri 走 device shell，不按 workspace 包名判", () => {
    expect(jobFor("desktop-device/tests/pairing.test.ts", FACTS)).toBe(
      "device shell tests",
    );
    expect(jobFor("desktop-device/src-tauri", FACTS)).toBe(
      "device shell tests (cargo test --locked)",
    );
    expect(jobFor("desktop-device/src-tauri/src/roots.rs", FACTS)).toBe(
      "device shell tests (cargo test --locked)",
    );
  });

  test("矩阵里没有的包，它的 tests/ 不算被跑到", () => {
    expect(jobFor("runner/tests/x.test.ts", FACTS)).toBe(
      "workspace tests (runner)",
    );
    expect(jobFor("nobody/tests/x.test.ts", FACTS)).toBeNull();
  });

  test("仓库根的 tests/、scripts/、e2e 与探针各有其作业", () => {
    expect(jobFor("tests/repo.test.ts", FACTS)).toBe(
      "repository tests (xiongbao/tests)",
    );
    expect(jobFor("scripts/ci/app-shards.test.mjs", FACTS)).toBe("static");
    expect(jobFor("scripts/acceptance/stories-evidence.test.ts", FACTS)).toBe(
      "repository tests (xiongbao/tests)",
    );
    expect(jobFor("scripts/e2e/wakerflow-lifecycle.ts", FACTS)).toBe(
      "e2e-wakerflow",
    );
    expect(jobFor("scripts/ci/windows-runner-probe.ts", FACTS)).toBe(
      "win1-windows",
    );
  });
});

describe("checkStories", () => {
  test("全绿的表没有问题", () => {
    const report = checkStories({
      markdown: table(cleanRows()),
      facts: FACTS,
      ...always,
    });
    expect(report.problems).toEqual([]);
    expect(report.refs).toBe(STORY_COUNT * 2);
    expect(report.files).toBe(2);
  });

  test("行数少一行就报 count：故事集合变了，验收表得跟着重核", () => {
    const report = checkStories({
      markdown: table(cleanRows().slice(1)),
      facts: FACTS,
      ...always,
    });
    expect(report.problems.map((p) => p.kind)).toEqual(["count"]);
  });

  test("某行钉的提交与表头不一致就报 pin", () => {
    const rows = cleanRows();
    rows[3] = row("A4", "`app/tests/b.test.tsx`", "accepted (main af18d06e)");
    const report = checkStories({
      markdown: table(rows),
      facts: FACTS,
      ...always,
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.story).toBe("A4");
    expect(report.problems[0]?.kind).toBe("pin");
  });

  test("状态写法认不出来也报 pin，而不是当成已验收放过", () => {
    const rows = cleanRows();
    rows[0] = row("A1", "`app/tests/b.test.tsx`", "integrated (pending main)");
    const report = checkStories({
      markdown: table(rows),
      facts: FACTS,
      ...always,
    });
    expect(report.problems.map((p) => p.kind)).toEqual(["pin"]);
  });

  test("证据文件不存在报 missing", () => {
    const report = checkStories({
      markdown: table(rowsWith(0, "`server/tests/gone.test.ts`")),
      facts: FACTS,
      exists: (ref) => ref !== "server/tests/gone.test.ts",
    });
    expect(report.problems.map((p) => p.kind)).toEqual(["missing"]);
  });

  test("证据掉出分片清单报 uncovered：作业只跑清单里的，文件在磁盘上也不算被验过", () => {
    const report = checkStories({
      markdown: table(rowsWith(0, "`server/tests/not-listed.test.ts`")),
      facts: FACTS,
      ...always,
    });
    expect(report.problems.map((p) => p.kind)).toEqual(["uncovered"]);
    expect(report.problems[0]?.detail).toContain(
      "server/tests/not-listed.test.ts",
    );
  });
});

describe("仓库里的真表", () => {
  const markdown = readFileSync(
    resolve(import.meta.dir, "../../../docs/acceptance/STORIES.md"),
    "utf8",
  );

  // 这条是守卫本身的意义所在：文档说「都核过」，就得有一条能重跑的命令把它变成能红的东西。
  test("77 行的证据全部存在、全部落到某个 CI 作业上、且钉住同一个提交", () => {
    const report = checkStories({ markdown, facts: loadFacts() });
    expect(report.problems).toEqual([]);
    expect(report.stories.rows).toHaveLength(STORY_COUNT);
    expect(report.stories.headerPin).not.toBeNull();
    // 数量不是判据，但掉一半就得问为什么——见文件头「上一版说 257、这一版数出 251」那段。
    expect(report.refs).toBeGreaterThan(200);
  });

  test("每行的验收状态都念得出同一个 sha", () => {
    const { headerPin, rows } = parseStories(markdown);
    const pins = new Set(rows.map((r) => r.pin));
    expect(pins).toEqual(new Set([headerPin]));
  });
});
