import { expect, test } from "bun:test";
import {
  annotateDiff,
  buildReport,
  type DelegatePreview,
  ReportError,
} from "./delegate-lib";

const preview: DelegatePreview = {
  mode: "range",
  from: "main",
  to: "topic",
  merge_base: "abc",
  reviewable_files: [
    { path: "a.ts", status: "modified" },
    { path: "b.ts", status: "added" },
  ],
};

test("annotateDiff numbers new-file lines and leaves removed lines unnumbered", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -3,3 +10,3 @@ fn",
    " keep",
    "-gone",
    "+added",
    " tail",
    "\\ No newline at end of file",
  ].join("\n");
  const lines = annotateDiff(diff).split("\n");
  expect(lines.slice(0, 4)).toEqual(diff.split("\n").slice(0, 4));
  expect(lines[4]).toBe("   10  keep");
  expect(lines[5]).toBe("      -gone");
  expect(lines[6]).toBe("   11 +added");
  expect(lines[7]).toBe("   12  tail");
  expect(lines[8]).toBe("\\ No newline at end of file");
});

test("annotateDiff restarts the numbering at each hunk and each file", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "@@ -1 +1 @@",
    "+one",
    "@@ -20 +30 @@",
    "+two",
    "diff --git a/b.ts b/b.ts",
    "new file mode 100644",
    "@@ -0,0 +1 @@",
    "+three",
  ].join("\n");
  const out = annotateDiff(diff);
  expect(out).toContain("    1 +one");
  expect(out).toContain("   30 +two");
  expect(out).toContain("    1 +three");
  expect(out).toContain("new file mode 100644");
});

test("buildReport counts coverage over the previewed files", () => {
  const report = buildReport({
    preview,
    comments: [
      {
        path: "a.ts",
        content: "bug",
        start_line: 3,
        end_line: 4,
        severity: "high",
      },
    ],
    skipped: [{ path: "b.ts", reason: "too large to read in one pass" }],
  });
  expect(report.mode).toBe("delegation");
  expect(report.summary).toEqual({
    total_files: 2,
    reviewed_files: 1,
    skipped_files: 1,
    coverage_rate: 0.5,
    comments: 1,
  });
  expect(report.range).toEqual({
    from: "main",
    to: "topic",
    merge_base: "abc",
  });
});

test("buildReport refuses a comment on a file the preview did not select", () => {
  expect(() =>
    buildReport({ preview, comments: [{ path: "c.ts", content: "x" }] }),
  ).toThrow(ReportError);
});

test("buildReport accepts an outside_diff comment on an unselected file only", () => {
  const report = buildReport({
    preview,
    comments: [{ path: "c.ts", content: "x", outside_diff: true }],
  });
  expect(report.comments[0]?.outside_diff).toBe(true);
  expect(() =>
    buildReport({
      preview,
      comments: [{ path: "a.ts", content: "x", outside_diff: true }],
    }),
  ).toThrow(ReportError);
});

test("buildReport refuses bad fields and skips without a reason", () => {
  const bad = (comment: Record<string, unknown>) => () =>
    buildReport({
      preview,
      comments: [{ path: "a.ts", content: "x", ...comment } as never],
    });
  expect(bad({ severity: "blocker" })).toThrow(ReportError);
  expect(bad({ category: "vibes" })).toThrow(ReportError);
  expect(bad({ start_line: 0 })).toThrow(ReportError);
  expect(bad({ start_line: 5, end_line: 4 })).toThrow(ReportError);
  expect(bad({ content: "  " })).toThrow(ReportError);
  expect(() =>
    buildReport({
      preview,
      comments: [],
      skipped: [{ path: "a.ts", reason: " " }],
    }),
  ).toThrow(ReportError);
  expect(() =>
    buildReport({
      preview,
      comments: [],
      skipped: [{ path: "z.ts", reason: "r" }],
    }),
  ).toThrow(ReportError);
});

test("an empty preview is fully covered", () => {
  const report = buildReport({
    preview: { ...preview, reviewable_files: [] },
    comments: [],
  });
  expect(report.summary.coverage_rate).toBe(1);
});
