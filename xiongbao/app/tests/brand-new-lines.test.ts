import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  addedLines,
  baseRef,
  diffAddedLines,
  forkIntroduced,
  newLineFindings,
  readSyncPoint,
  upstreamReader,
} from "../../scripts/brand/guard/new-lines";

const diffOf = (file: string, ...added: string[]) =>
  [
    `diff --git a/openbot/${file} b/openbot/${file}`,
    `--- a/openbot/${file}`,
    `+++ b/openbot/${file}`,
    `@@ -10,0 +11,${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join("\n");

test("added lines carry the file relative to openbot/ and their line numbers", () => {
  const diff = `${diffOf("server/src/x.ts", "a", "b")}\n${diffOf("app/src/y.ts", "c")}`;
  expect(addedLines(diff)).toEqual([
    { file: "server/src/x.ts", number: 11, line: "a" },
    { file: "server/src/x.ts", number: 12, line: "b" },
    { file: "app/src/y.ts", number: 11, line: "c" },
  ]);
  const deleted = [
    "diff --git a/openbot/server/src/gone.ts b/openbot/server/src/gone.ts",
    "--- a/openbot/server/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-x",
    "-y",
  ].join("\n");
  expect(addedLines(deleted)).toEqual([]);
});

test("a content line starting with ++ is not taken for a file header", () => {
  const diff = [
    diffOf("server/src/x.ts", "++ OpenBot", "b"),
    "diff --git a/openbot/app/src/y.ts b/openbot/app/src/y.ts",
    "+++ b/openbot/app/src/y.ts",
    "@@ -1,0 +2,1 @@",
    "+++ b/openbot/server/src/z.ts",
  ].join("\n");
  expect(addedLines(diff)).toEqual([
    { file: "server/src/x.ts", number: 11, line: "++ OpenBot" },
    { file: "server/src/x.ts", number: 12, line: "b" },
    { file: "app/src/y.ts", number: 2, line: "++ b/openbot/server/src/z.ts" },
  ]);
});

test("baseRef reads the replay variables first, then the event", () => {
  expect(baseRef({ BRAND_BASE: "abc^1", BRAND_HEAD: "abc" })).toEqual({
    base: "abc^1",
    head: "abc",
  });
  expect(baseRef({ GITHUB_EVENT_NAME: "push" })).toEqual({
    base: "HEAD^1",
    head: "HEAD",
  });
});

test("a fork comment naming OpenBot is reported", () => {
  const lines = addedLines(diffOf("server/src/x.ts", "// OpenBot does this"));
  expect(newLineFindings(lines).map((f) => f.file)).toEqual([
    "server/src/x.ts",
  ]);
});

test("an added line that an allowlist entry of the same file covers is not reported", () => {
  const allow = [{ file: "app/src/a.ts", text: '"openbot-theme"' }];
  const line = 'const KEY = "openbot-theme";';
  expect(
    newLineFindings(addedLines(diffOf("app/src/a.ts", line)), allow),
  ).toEqual([]);
  expect(
    newLineFindings(addedLines(diffOf("app/src/b.ts", line)), allow).map(
      (f) => f.file,
    ),
  ).toEqual(["app/src/b.ts"]);
});

test("a test file is not checked", () => {
  const lines = addedLines(
    diffOf("server/tests/x.test.ts", "// OpenBot does this"),
  );
  expect(newLineFindings(lines)).toEqual([]);
});

test("an upstream line that came with a sync is not reported", () => {
  const lines = addedLines(
    diffOf("server/src/x.ts", "  // OpenBot does this", "// OpenBot too"),
  );
  const upstream = (file: string) =>
    file === "server/src/x.ts" ? "a\n// OpenBot does this\nb" : undefined;
  expect(forkIntroduced(lines, upstream).map((l) => l.line)).toEqual([
    "// OpenBot too",
  ]);
  // A file the upstream does not have at all: everything in it is the fork's.
  expect(forkIntroduced(lines, () => undefined)).toHaveLength(2);
});

test("a missing sync commit fails with the file and the commit named", () => {
  const commit = "1".repeat(40);
  let message = "";
  try {
    upstreamReader({ commit, repository: "/nonexistent/upstream.git" });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("upstream-sync.json");
  expect(message).toContain(commit);
});

test("the sync point maps openbot/<p> to <p> in the upstream commit", () => {
  const sync = readSyncPoint();
  const upstream = upstreamReader(sync);
  expect(upstream("package.json")).toBeDefined();
  expect(upstream("no/such/file.ts")).toBeUndefined();
}, 120_000);

// Not skipped when the sync point cannot be fetched: that is a failure.
test("this branch adds no unexplained upstream name", () => {
  const { base, head } = baseRef(process.env);
  const upstream = upstreamReader(readSyncPoint());
  const lines = diffAddedLines(base, head);
  const allow = JSON.parse(
    readFileSync(
      new URL("./brand-leak-allowlist.json", import.meta.url),
      "utf8",
    ),
  ) as { file: string; text: string }[];
  const found = forkIntroduced(newLineFindings(lines, allow), upstream);
  expect(found).toEqual([]);
}, 120_000);
