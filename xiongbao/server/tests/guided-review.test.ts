import { describe, expect, test } from "bun:test";
import {
  chapterOf,
  guidedReview,
  isCodeChange,
  REVIEW_CHAPTER_IDS,
  REVIEW_CHAPTERS,
  type ReviewChapterId,
} from "../src/approvals/guided-review";

describe("the chapter a path falls in", () => {
  const table: [string, ReviewChapterId][] = [
    ["server/src/approvals/service.ts", "core"],
    ["app/src/components/inbox.tsx", "core"],
    ["lib/parser.py", "core"],
    ["server/tests/service.test.ts", "impact"],
    ["app/tests/inbox.test.tsx", "impact"],
    ["src/button.spec.ts", "impact"],
    ["docs/configuration.md", "impact"],
    ["README.md", "impact"],
    ["server/drizzle/0081_notes.sql", "impact"],
    ["package.json", "glue"],
    ["bun.lock", "glue"],
    ["server/tsconfig.json", "glue"],
    ["vite.config.ts", "glue"],
    [".github/workflows/ci.yml", "glue"],
    ["server/src/approvals/index.ts", "glue"],
    ["scripts/ci/run-tests.sh", "glue"],
    ["types/api.d.ts", "glue"],
    ["assets/logo.png", "glue"],
    ["requirements.txt", "glue"],
    ["tools/requirements-dev.txt", "glue"],
    ["go.mod", "glue"],
    ["notes.txt", "impact"],
    ["src/doc/parser.ts", "core"],
    ["server\\tests\\helper.ts", "impact"],
    ["docs\\a.ts", "impact"],
  ];
  for (const [path, chapter] of table)
    test(`${path} is ${chapter}`, () => {
      expect(chapterOf(path)).toBe(chapter);
    });

  test("backslashes, a leading ./ and capitals do not change the answer", () => {
    expect(chapterOf(".\\Server\\Src\\Main.ts")).toBe("core");
    expect(chapterOf("./Docs/Guide.MD")).toBe("impact");
  });

  test("a test is impact although it is source, a config script is glue although it is source", () => {
    expect(chapterOf("src/a/__tests__/x.ts")).toBe("impact");
    expect(chapterOf("webpack.config.js")).toBe("glue");
  });
});

describe("guided review of a change", () => {
  const files = [
    "package.json",
    "server/src/a.ts",
    "server/tests/a.test.ts",
    "server/src/b.ts",
    "docs/a.md",
    "server/src/index.ts",
  ];

  test("three chapters in reading order, each with one sentence", () => {
    const review = guidedReview(files);
    expect(review?.map((chapter) => chapter.id)).toEqual([
      ...REVIEW_CHAPTER_IDS,
    ]);
    expect(review?.map((chapter) => chapter.title)).toEqual([
      "核心改动",
      "影响",
      "胶水代码",
    ]);
    for (const chapter of review ?? []) {
      expect(chapter.summary).toBe(REVIEW_CHAPTERS[chapter.id].summary);
      expect(chapter.summary.split("。").filter(Boolean)).toHaveLength(1);
    }
  });

  test("every file lands in exactly one chapter, in the order given", () => {
    const review = guidedReview(files);
    expect(review?.map((chapter) => chapter.files)).toEqual([
      ["server/src/a.ts", "server/src/b.ts"],
      ["server/tests/a.test.ts", "docs/a.md"],
      ["package.json", "server/src/index.ts"],
    ]);
  });

  test("repeated and blank paths are dropped", () => {
    const review = guidedReview(["a.ts", " a.ts ", "", "a.ts"]);
    expect(review?.[0]?.files).toEqual(["a.ts"]);
  });

  test("the same file under another case or separator is listed once", () => {
    const review = guidedReview(["a/B.ts", "a\\b.ts", "A/b.ts"]);
    expect(review?.[0]?.files).toEqual(["a/B.ts"]);
  });

  test("a change with no source file is not a code change", () => {
    expect(guidedReview(["docs/a.md", "report.xlsx"])).toBeNull();
    expect(guidedReview([])).toBeNull();
    expect(isCodeChange(["x.ts"])).toBe(true);
  });
});
