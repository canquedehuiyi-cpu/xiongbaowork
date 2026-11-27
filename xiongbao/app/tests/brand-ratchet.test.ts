import { expect, test } from "bun:test";
import {
  baseAllowlist,
  baseRef,
  loadRatchetInput,
  type RatchetInput,
  ratchetProblems,
} from "../../scripts/brand/guard/ratchet";
import type { AllowEntry } from "../../scripts/brand/guard/scan";
import { OLD_PRODUCT_LOWER } from "../../scripts/brand/guard/words";

const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({
  file: "server/src/a.ts",
  text: `"${OLD_PRODUCT_LOWER}-theme",`,
  reason: "x",
  category: "kept",
  ...over,
});

const input = (over: Partial<RatchetInput> = {}): RatchetInput => ({
  base: [entry()],
  head: [entry()],
  baseWords: { "docs.json": ["a", "prefix:b"] },
  headWords: { "docs.json": ["a", "prefix:b"] },
  ...over,
});

test("nothing changed: nothing reported", () => {
  expect(ratchetProblems(input())).toEqual([]);
});

test("a new entry is reported", () => {
  const problems = ratchetProblems(
    input({ head: [entry(), entry({ text: `"${OLD_PRODUCT_LOWER}",` })] }),
  );
  expect(problems.join("\n")).toContain("条数");
});

test("an entry moved to another file, or with a changed category, is not new", () => {
  expect(
    ratchetProblems(
      input({
        head: [entry({ file: "server/src/b.ts", category: "dependency" })],
      }),
    ),
  ).toEqual([]);
});

test("an entry with text the base never had is reported", () => {
  expect(
    ratchetProblems(input({ head: [entry({ text: OLD_PRODUCT_LOWER })] })).join(
      "\n",
    ),
  ).toContain("text");
});

test("only surrounding punctuation may be dropped from a text", () => {
  expect(
    ratchetProblems(
      input({ head: [entry({ text: `${OLD_PRODUCT_LOWER}-theme` })] }),
    ),
  ).toEqual([]);
});

test("a base from before the single rule is no baseline", () => {
  const before = JSON.stringify([{ ...entry(), category: "persisted-data" }]);
  expect(baseAllowlist(before)).toBeUndefined();
  expect(baseAllowlist(JSON.stringify([entry()]))).toEqual([entry()]);
  expect(baseAllowlist(undefined)).toBeUndefined();
  expect(
    ratchetProblems(input({ base: undefined, head: [entry(), entry()] })),
  ).toEqual([]);
});

test("a word list that grows is reported", () => {
  const problems = ratchetProblems(
    input({ headWords: { "docs.json": ["a", "prefix:b", "c"] } }),
  );
  expect(problems.join("\n")).toContain("docs.json");
});

test("a word list with no base is a baseline only for the listed names", () => {
  expect(
    ratchetProblems(
      input({
        baseWords: {},
        headWords: { "docs.json": ["a"], "web.json": ["w"] },
      }),
    ),
  ).toEqual([]);
  expect(
    ratchetProblems(
      input({ baseWords: {}, headWords: { "other.json": ["a"] } }),
    ).join("\n"),
  ).toContain("other.json");
});

test("baseRef reads the replay variables first, then the event", () => {
  expect(baseRef({ BRAND_BASE: "b", BRAND_HEAD: "h" })).toEqual({
    base: "b",
    head: "h",
  });
  expect(baseRef({ GITHUB_EVENT_NAME: "push" })).toEqual({
    base: "HEAD^1",
    head: "HEAD",
  });
});

test("this branch does not grow the allowlist or any word list", () => {
  const { base } = baseRef(process.env);
  expect(ratchetProblems(loadRatchetInput(base))).toEqual([]);
});
