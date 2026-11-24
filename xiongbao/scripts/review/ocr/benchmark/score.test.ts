import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  combine,
  commentsOf,
  type Gold,
  type GoldPr,
  matchesOf,
  normalizePath,
  scoreReport,
} from "./score";

const pr: GoldPr = {
  id: "pr-x",
  number: 1,
  title: "t",
  range: { from: "a", to: "b", fixedBy: [] },
  items: [
    {
      id: "X-I1",
      severity: "important",
      summary: "stream outlives revocation",
      locations: [
        { file: "src/forward.ts", start: 100, end: 110, inDiff: true },
      ],
      keywords: ["stream", "撤销"],
    },
    {
      id: "X-C1",
      severity: "critical",
      summary: "reply row lacks the list",
      locations: [{ file: "src/group.ts", start: 50, end: 52, inDiff: false }],
      keywords: ["reply row", "回复行"],
    },
    {
      id: "X-M1",
      severity: "minor",
      summary: "limit key",
      locations: [
        { file: "src/forward.ts", start: 300, end: 300, inDiff: true },
      ],
      keywords: ["rate limit"],
    },
  ],
};

const comment = (over: Record<string, unknown>) => ({
  path: "src/forward.ts",
  content: "the stream keeps flowing after the grant is revoked",
  start_line: 105,
  end_line: 105,
  ...over,
});

test("a comment inside the gold range with a theme word is a hit", () => {
  const scored = scoreReport({ comments: [comment({})] }, pr, 10);
  expect(scored.items.find((item) => item.id === "X-I1")?.found).toBe(true);
  expect(scored.precision).toEqual({ matched: 1, total: 1, rate: 1 });
});

test("the line tolerance is inclusive at ten lines and ends at eleven", () => {
  const at = (line: number) =>
    scoreReport(
      { comments: [comment({ start_line: line, end_line: line })] },
      pr,
      10,
    ).items[0]?.found;
  expect(at(120)).toBe(true); // gold ends at 110, ten lines past it
  expect(at(121)).toBe(false);
  expect(at(90)).toBe(true); // gold starts at 100, ten lines before it
  expect(at(89)).toBe(false);
});

test("a range that only touches the tolerance band still matches", () => {
  const scored = scoreReport(
    { comments: [comment({ start_line: 121, end_line: 140 })] },
    pr,
    10,
  );
  expect(scored.items[0]?.found).toBe(false);
  const near = scoreReport(
    { comments: [comment({ start_line: 115, end_line: 140 })] },
    pr,
    10,
  );
  expect(near.items[0]?.found).toBe(true);
});

test("the wrong file, or no theme word, is not a hit and the comment is unmatched", () => {
  const scored = scoreReport(
    {
      comments: [
        comment({ path: "src/other.ts" }),
        comment({ content: "naming could be better" }),
      ],
    },
    pr,
    10,
  );
  expect(scored.items[0]?.found).toBe(false);
  expect(scored.precision).toEqual({ matched: 0, total: 2, rate: 0 });
  expect(scored.unmatched.map((one) => one.index)).toEqual([0, 1]);
  expect(scored.misses).toEqual(["X-I1", "X-C1"]);
});

test("a comment with no line is a file-level comment and passes the line test", () => {
  const scored = scoreReport(
    { comments: [{ path: "src/forward.ts", content: "stream is never cut" }] },
    pr,
    10,
  );
  expect(scored.items[0]?.found).toBe(true);
  expect(scored.unmatched).toEqual([]);
});

test("theme words match case-insensitively and in Chinese", () => {
  const scored = scoreReport(
    {
      comments: [
        comment({ content: "STREAM 不受撤销约束" }),
        { path: "src/group.ts", start_line: 51, content: "出错分支没带回复行" },
      ],
    },
    pr,
    10,
  );
  expect(scored.recall).toEqual({ found: 2, total: 2, rate: 1 });
});

test("a minor-only match is not a false positive and does not count toward recall", () => {
  const scored = scoreReport(
    {
      comments: [
        {
          path: "src/forward.ts",
          start_line: 300,
          content: "one rate limit key for everyone",
        },
      ],
    },
    pr,
    10,
  );
  expect(scored.recall).toEqual({ found: 0, total: 2, rate: 0 });
  expect(scored.minorRecall).toEqual({ found: 1, total: 1, rate: 1 });
  expect(scored.precision.rate).toBe(1);
  expect(scored.strictPrecision).toEqual({ matched: 0, total: 1, rate: 0 });
  expect(scored.unmatched).toEqual([]);
});

test("recall in the diff leaves out items whose every location is outside it", () => {
  const scored = scoreReport({ comments: [comment({})] }, pr, 10);
  expect(scored.recall).toEqual({ found: 1, total: 2, rate: 0.5 });
  expect(scored.recallInDiff).toEqual({ found: 1, total: 1, rate: 1 });
});

test("an empty report finds nothing and has no precision", () => {
  const scored = scoreReport({ comments: [] }, pr, 10);
  expect(scored.recall.rate).toBe(0);
  expect(scored.precision.rate).toBeNull();
  expect(scored.misses).toEqual(["X-I1", "X-C1"]);
});

const second: GoldPr["items"][number] = {
  id: "X-I2",
  severity: "important",
  summary: "same place, another theme",
  locations: [{ file: "src/forward.ts", start: 104, end: 106, inDiff: true }],
  keywords: ["revoked"],
};
const withSecond: GoldPr = {
  ...pr,
  items: [pr.items[0] as GoldPr["items"][number], second],
};

test("one comment is given to one item only, even when two items fit it", () => {
  const comments = commentsOf({ comments: [comment({})] });
  // Both X-I1 ("stream", lines 100-110) and X-I2 ("revoked", lines 104-106) fit this comment.
  const matches = matchesOf(comments, withSecond.items, 10);
  expect(matches).toHaveLength(1);
  const scored = scoreReport({ comments: [comment({})] }, withSecond, 10);
  expect(scored.recall).toEqual({ found: 1, total: 2, rate: 0.5 });
  expect(scored.precision).toEqual({ matched: 1, total: 1, rate: 1 });
  expect(scored.misses).toHaveLength(1);
});

test("the item whose lines the comment covers more of gets it", () => {
  // Both items fit the text. The comment covers all 11 lines of X-I1 but only 3 of X-I2.
  const wide = comment({ start_line: 100, end_line: 110 });
  const matches = matchesOf(
    commentsOf({ comments: [wide] }),
    withSecond.items,
    10,
  );
  expect(matches.map((one) => one.item)).toEqual(["X-I1"]);
});

test("equal overlap is decided by how many of the item's keywords the comment contains", () => {
  const items: GoldPr["items"] = [
    {
      id: "X-I1",
      severity: "important",
      summary: "a",
      locations: [
        { file: "src/forward.ts", start: 100, end: 110, inDiff: true },
      ],
      keywords: ["stream"],
    },
    {
      id: "X-I2",
      severity: "important",
      summary: "b",
      locations: [
        { file: "src/forward.ts", start: 100, end: 110, inDiff: true },
      ],
      keywords: ["stream", "revoked", "grant"],
    },
  ];
  const matches = matchesOf(commentsOf({ comments: [comment({})] }), items, 10);
  expect(matches.map((one) => one.item)).toEqual(["X-I2"]);
});

test("an item is claimed by one comment only; the other comment goes to another item or stays unmatched", () => {
  const scored = scoreReport(
    {
      comments: [
        comment({ start_line: 100, end_line: 110 }),
        comment({ start_line: 104, end_line: 106 }),
      ],
    },
    withSecond,
    10,
  );
  // The wide comment takes X-I1; the narrow one cannot also take X-I1 and goes to X-I2.
  expect(scored.items.map((one) => [one.id, one.by])).toEqual([
    ["X-I1", [0]],
    ["X-I2", [1]],
  ]);
  const onlyFirst = scoreReport(
    { comments: [comment({}), comment({})] },
    pr,
    10,
  );
  expect(onlyFirst.items[0]?.by).toEqual([0]);
  expect(onlyFirst.precision).toEqual({ matched: 1, total: 2, rate: 0.5 });
  expect(onlyFirst.unmatched.map((one) => one.index)).toEqual([1]);
});

test("commentsOf reads the delegation report and a native result with other field names", () => {
  expect(
    commentsOf({ comments: [{ path: "./a.ts", content: "x", start_line: 3 }] }),
  ).toEqual([
    { path: "a.ts", content: "x", start: 3, end: 3, outsideDiff: false },
  ]);
  expect(
    commentsOf({
      files: [{ comments: [{ file: "b/a.ts", message: "y", line: 7 }] }],
    }),
  ).toEqual([
    { path: "a.ts", content: "y", start: 7, end: 7, outsideDiff: false },
  ]);
  expect(commentsOf({ nothing: true })).toEqual([]);
  expect(
    commentsOf({ comments: [{ content: "no path" }, null, "text"] }),
  ).toEqual([]);
});

test("normalizePath drops a leading ./ or a/ b/", () => {
  expect(normalizePath("./x/y.ts")).toBe("x/y.ts");
  expect(normalizePath("a/x/y.ts")).toBe("x/y.ts");
  expect(normalizePath("b/x/y.ts")).toBe("x/y.ts");
  expect(normalizePath("app/x.ts")).toBe("app/x.ts");
});

test("combine adds PRs up by items and comments, not by averaging rates", () => {
  const first = scoreReport({ comments: [comment({})] }, pr, 10);
  const second = scoreReport({ comments: [] }, pr, 10);
  const total = combine([first, second]);
  expect(total.recall).toEqual({ found: 1, total: 4, rate: 0.25 });
  expect(total.precision).toEqual({ matched: 1, total: 1, rate: 1 });
});

test("the shipped gold set is well formed", () => {
  const gold = JSON.parse(
    readFileSync(new URL("gold.json", import.meta.url), "utf8"),
  ) as Gold;
  expect(gold.tolerance).toBe(10);
  expect(gold.prs.length).toBeGreaterThanOrEqual(3);
  const seen = new Set<string>();
  for (const one of gold.prs) {
    expect(one.items.length).toBeGreaterThan(0);
    expect(one.items.some((item) => item.severity !== "minor")).toBe(true);
    for (const item of one.items) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
      expect(item.keywords.length).toBeGreaterThan(0);
      expect(item.locations.length).toBeGreaterThan(0);
      for (const location of item.locations) {
        expect(location.file.startsWith("xiongbao/")).toBe(true);
        expect(location.start).toBeGreaterThan(0);
        expect(location.end).toBeGreaterThanOrEqual(location.start);
      }
    }
  }
});
