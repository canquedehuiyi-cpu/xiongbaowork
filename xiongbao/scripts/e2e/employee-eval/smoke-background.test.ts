import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_SMOKE, SMOKE, selectSmoke } from "./smoke";
import {
  corpusFiles,
  runWordfreqVerify,
  WORDFREQ_PROMPT,
  wordfreqFiles,
} from "./smoke-background";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** 夹具落地，再叠上一份员工的产物（路径 → 内容）。 */
function workspace(solution: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wordfreq-test-"));
  made.push(dir);
  for (const [path, contents] of Object.entries({
    ...wordfreqFiles(),
    ...solution,
  })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

const PROGRAM = (
  lowercase: boolean,
) => `import { readdirSync, readFileSync, writeFileSync } from "node:fs";

export function words(text: string): string[] {
  return (${lowercase ? "text.toLowerCase()" : "text"}.match(/[a-z]+/g) ?? []);
}

export function top(texts: string[], stop: Set<string>, n = 10): [string, number][] {
  const counts = new Map<string, number>();
  for (const text of texts)
    for (const word of words(text))
      if (!stop.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n);
}

if (import.meta.main) {
  const texts = readdirSync("corpus")
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((name) => readFileSync("corpus/" + name, "utf8"));
  const stop = new Set(readFileSync("stopwords.txt", "utf8").split("\\n").filter(Boolean));
  const best = top(texts, stop);
  writeFileSync("counts.json", JSON.stringify(best));
  writeFileSync(
    "report.md",
    ["| 名次 | 单词 | 次数 |", "| --- | --- | --- |", ...best.map(([w, n], i) => "| " + (i + 1) + " | " + w + " | " + n + " |")].join("\\n") + "\\n",
  );
}
`;

const TESTS = `import { expect, test } from "bun:test";
import { top, words } from "./wordfreq";

test("words splits on anything that is not a letter", () => {
  expect(words("well-known, Tree!")).toEqual(["well", "known", "tree"]);
});
test("stop words are not counted", () => {
  expect(top(["the cat the dog"], new Set(["the"]))).toEqual([["cat", 1], ["dog", 1]]);
});
test("equal counts are ordered alphabetically", () => {
  expect(top(["b a b a"], new Set())).toEqual([["a", 2], ["b", 2]]);
});
`;

const GOLD = (lowercase = true) => ({
  "wordfreq.ts": PROGRAM(lowercase),
  "wordfreq.test.ts": TESTS,
});

test("the corpus is the same every time and has six files with words to count", () => {
  expect(corpusFiles()).toEqual(corpusFiles());
  expect(Object.keys(corpusFiles())).toHaveLength(6);
  expect(Object.keys(wordfreqFiles())).toContain("stopwords.txt");
  for (const text of Object.values(corpusFiles()))
    expect((text.match(/[A-Za-z]+/g) ?? []).length).toBeGreaterThan(150);
  expect(WORDFREQ_PROMPT).toContain("{dir}");
});

test("the verification script passes a correct solution and says why it fails a wrong one", () => {
  const right = runWordfreqVerify(workspace(GOLD()));
  expect(right).toEqual({ ok: true, detail: "校验脚本退出 0" });

  // The corpus the employee leaves behind is not trusted: the original is put back before the run.
  const tampered = workspace({
    ...GOLD(),
    "corpus/part1.txt": "nothing here\n",
  });
  expect(runWordfreqVerify(tampered).ok).toBe(true);

  // Nothing done: no program and no tests.
  const empty = runWordfreqVerify(workspace({}));
  expect(empty.ok).toBe(false);
  expect(empty.detail).toContain("wordfreq.ts is missing");
  expect(empty.detail).toContain("no test file");

  // Forgetting to lower-case gives other counts: the program runs and its answer is wrong.
  const wrong = runWordfreqVerify(workspace(GOLD(false)));
  expect(wrong.ok).toBe(false);
  expect(wrong.detail).toContain("counts.json is not the expected top 10");

  // A program that passes but with fewer than three tests.
  const thin = runWordfreqVerify(
    workspace({
      ...GOLD(),
      "wordfreq.test.ts": `import { expect, test } from "bun:test";
import { words } from "./wordfreq";
test("one", () => expect(words("A b")).toEqual(["a", "b"]));
`,
    }),
  );
  expect(thin.ok).toBe(false);
  expect(thin.detail).toContain("fewer than 3 tests");

  // A report that is not a table of the top ten in order.
  const report = runWordfreqVerify(
    workspace({
      ...GOLD(),
      "wordfreq.ts": PROGRAM(true).replace(
        /writeFileSync\(\s*"report\.md"[\s\S]*?\);\n\}/,
        'writeFileSync("report.md", "no table\\n");\n}',
      ),
    }),
  );
  expect(report.ok).toBe(false);
  expect(report.detail).toContain("report.md has no line");
}, 120_000);

test("the background scenarios are picked by name or as a group and stay out of the daily six", () => {
  expect(BACKGROUND_SMOKE.map((scenario) => scenario.name)).toEqual([
    "disconnect",
    "reconnect",
  ]);
  expect(BACKGROUND_SMOKE.map((scenario) => scenario.background)).toEqual([
    "disconnect",
    "reconnect",
  ]);
  expect(SMOKE.some((scenario) => scenario.background)).toBe(false);
  expect(selectSmoke("all")).toEqual(SMOKE);
  expect(selectSmoke("background").map((scenario) => scenario.name)).toEqual([
    "disconnect",
    "reconnect",
  ]);
  expect(selectSmoke("reconnect").map((scenario) => scenario.name)).toEqual([
    "reconnect",
  ]);
  expect(
    selectSmoke("plan, background").map((scenario) => scenario.name),
  ).toEqual(["plan", "disconnect", "reconnect"]);
  expect(selectSmoke("all,background")).toHaveLength(SMOKE.length + 2);
  expect(() => selectSmoke("nope")).toThrow("background");
  // They take the scenario's own limit, long enough for the 12-minute poll.
  for (const scenario of BACKGROUND_SMOKE) {
    expect(scenario.minutes).toBeGreaterThanOrEqual(13);
    expect(scenario.requires).toEqual([]);
    expect(scenario.prompt).toContain("{dir}");
  }
});
