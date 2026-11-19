import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkDocs,
  codeBlocks,
  exportedSymbols,
  markdownProblems,
} from "./check-docs";
import { FIXTURES_DIR, GOLD_DIR } from "./lib";
import {
  cleanup,
  emptyDir,
  failed,
  solved,
  untouched,
  write,
} from "./test-support";

afterAll(cleanup);
const gold = readFileSync(join(GOLD_DIR, "docs", "README.md"), "utf8");

test("the fixture's exports are read from index.ts, types included", () => {
  expect(exportedSymbols(join(FIXTURES_DIR, "docs", "src"))).toEqual([
    "DEFAULT_ELLIPSIS",
    "TruncateOptions",
    "slugify",
    "toCamelCase",
    "toKebabCase",
    "truncate",
    "wordCount",
  ]);
});

test("the standard answer passes every check", async () => {
  const outcome = await checkDocs(solved("docs"));
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
});

test("an empty directory and the untouched fixture fail", async () => {
  expect((await checkDocs(emptyDir())).passed).toBe(false);
  const outcome = await checkDocs(untouched("docs"));
  expect(failed(outcome)).toEqual([
    "每个导出的符号都在文档里出现",
    "代码块能用 bun build 编译",
  ]);
});

test("an example importing something the library does not export fails to build", async () => {
  const dir = solved("docs");
  write(
    dir,
    "README.md",
    gold.replace(
      'import { wordCount } from "tiny-text";',
      'import { wordCount, countWords } from "tiny-text";\ncountWords("x");',
    ),
  );
  const outcome = await checkDocs(dir);
  expect(failed(outcome)).toEqual(["代码块能用 bun build 编译"]);
});

test("a missing symbol, broken markdown and an edited src all fail", async () => {
  const dir = solved("docs");
  write(
    dir,
    "README.md",
    `${gold.replace("### wordCount(text)", "###wordCount")}\n\`\`\`ts\nconst x = 1;\n`,
  );
  write(dir, "src/count.ts", "export const changed = true;\n");
  expect(failed(await checkDocs(dir))).toEqual([
    "src/ 和 package.json 没被改",
    "Markdown 没有格式错误",
  ]);
  const without = solved("docs");
  write(without, "README.md", gold.replaceAll("wordCount", "countThem"));
  expect(failed(await checkDocs(without))).toContain(
    "每个导出的符号都在文档里出现",
  );
});

test("markdown problems and code blocks are found", () => {
  expect(
    markdownProblems("#Title\n| a | b |\n| - | - | - |\n[]()\n```ts\n"),
  ).toHaveLength(4);
  expect(markdownProblems(gold)).toEqual([]);
  expect(codeBlocks(gold)).toHaveLength(4);
});
