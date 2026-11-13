import { expect, test } from "bun:test";
import type { AllowEntry } from "../../scripts/brand/guard/allowlist";
import { baseRef } from "../../scripts/brand/guard/new-lines";
import {
  loadRatchetInput,
  type RatchetInput,
  ratchetBase,
  ratchetProblems,
} from "../../scripts/brand/guard/ratchet";

const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({
  file: "server/src/a.ts",
  text: '"openbot",',
  reason: "peer-protocol: x",
  category: "peer-protocol",
  plan: "keep",
  ...over,
});

const input = (over: Partial<RatchetInput> = {}): RatchetInput => ({
  base: [entry()],
  head: [entry()],
  baseBudget: [{ rule: "identifier", scope: "server/src", lines: 5 }],
  headBudget: [{ rule: "identifier", scope: "server/src", lines: 5 }],
  baseWords: { "docs.json": ["a", "prefix:b"] },
  headWords: { "docs.json": ["a", "prefix:b"] },
  syncPr: false,
  inUpstream: () => true,
  ...over,
});

test("nothing changed: nothing reported", () => {
  expect(ratchetProblems(input())).toEqual([]);
});

test("a new entry is reported", () => {
  const problems = ratchetProblems(
    input({ head: [entry(), entry({ text: '"openbot",' })] }),
  );
  expect(problems.join("\n")).toContain("条数");
});

test("a changed category is not a new entry", () => {
  expect(
    ratchetProblems(
      input({ head: [entry({ category: "persisted-data", plan: "rewrite" })] }),
    ),
  ).toEqual([]);
});

test("an entry moved to another file is not reported", () => {
  expect(
    ratchetProblems(input({ head: [entry({ file: "server/src/b.ts" })] })),
  ).toEqual([]);
});

test("an entry whose text got shorter is not reported", () => {
  expect(
    ratchetProblems(input({ head: [entry({ text: '"openbot"' })] })),
  ).toEqual([]);
});

test("an entry with text the base never had is reported", () => {
  const problems = ratchetProblems(
    input({ head: [entry({ text: '"copilotkit-new"' })] }),
  );
  expect(problems.join("\n")).toContain("copilotkit-new");
});

test("a budget row that grows is reported", () => {
  const problems = ratchetProblems(
    input({
      headBudget: [{ rule: "identifier", scope: "server/src", lines: 6 }],
    }),
  );
  expect(problems.join("\n")).toContain("identifier");
  expect(
    ratchetProblems(
      input({
        headBudget: [{ rule: "identifier", scope: "server/src", lines: 4 }],
      }),
    ),
  ).toEqual([]);
});

test("a new budget row is reported", () => {
  const problems = ratchetProblems(
    input({
      headBudget: [
        { rule: "identifier", scope: "server/src", lines: 5 },
        { rule: "env-name", scope: "server/src", lines: 1 },
      ],
    }),
  );
  expect(problems.join("\n")).toContain("env-name");
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

test("a sync PR may add an entry of the six categories that the upstream has", () => {
  expect(
    ratchetProblems(
      input({
        syncPr: true,
        head: [entry(), entry({ file: "server/src/new.ts", text: '"peer-x"' })],
        inUpstream: () => true,
      }),
    ),
  ).toEqual([]);
});

test("a sync PR may not add an operator-visible entry, nor one the upstream lacks", () => {
  const added = entry({
    file: "server/src/new.ts",
    text: '"peer-x"',
    category: "operator-visible",
    plan: "rewrite",
  });
  expect(
    ratchetProblems(input({ syncPr: true, head: [entry(), added] })).join("\n"),
  ).toContain("operator-visible");
  expect(
    ratchetProblems(
      input({
        syncPr: true,
        head: [entry(), { ...added, category: "peer-protocol", plan: "keep" }],
        inUpstream: () => false,
      }),
    ).join("\n"),
  ).toContain("同步点");
});

test("a sync PR may grow the budget; the growth is printed, not failed", () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    expect(
      ratchetProblems(
        input({
          syncPr: true,
          headBudget: [{ rule: "identifier", scope: "server/src", lines: 9 }],
        }),
      ),
    ).toEqual([]);
  } finally {
    console.log = log;
  }
  expect(printed.join("\n")).toContain("identifier");
});

test("this branch does not grow any allowlist, budget or word list", () => {
  const { base, head } = baseRef(process.env);
  const real = loadRatchetInput(ratchetBase(base, head));
  expect(ratchetProblems(real)).toEqual([]);
});
