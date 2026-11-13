import { expect, test } from "bun:test";
import {
  type AllowEntry,
  entryProblems,
} from "../../scripts/brand/guard/allowlist";
import {
  baseRef,
  type Git,
  type SyncPoint,
  verifySyncPoint,
} from "../../scripts/brand/guard/new-lines";
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

test("an entry text may not be empty or free of a brand word", () => {
  const ok = entry({ reason: "peer-protocol: x" });
  expect(entryProblems(ok)).toEqual([]);
  expect(entryProblems({ ...ok, text: "" }).join("\n")).toContain("empty");
  expect(entryProblems({ ...ok, text: "o" }).join("\n")).toContain("brand");
});

test("a text shrunk to nothing or to a bare word is reported", () => {
  const base = [entry({ text: '"openbot-theme",' })];
  for (const text of ["", "o", '"openbot"', "openbot"])
    expect(
      ratchetProblems(input({ base, head: [entry({ text })] })).join("\n"),
    ).toContain("text");
});

test("only surrounding punctuation may be dropped from a text", () => {
  const base = [entry({ text: '"openbot-theme",' })];
  expect(
    ratchetProblems(
      input({ base, head: [entry({ text: '"openbot-theme"' })] }),
    ),
  ).toEqual([]);
  expect(
    ratchetProblems(input({ base, head: [entry({ text: "openbot-theme" })] })),
  ).toEqual([]);
  // A bare word is fine when the base had exactly that, punctuation aside.
  expect(
    ratchetProblems(
      input({
        base: [entry({ text: '"openbot",' })],
        head: [entry({ text: "openbot" })],
      }),
    ),
  ).toEqual([]);
});

const OLD: SyncPoint = {
  commit: "a".repeat(40),
  repository: "https://up/x.git",
};
const NEW: SyncPoint = { commit: "b".repeat(40), repository: OLD.repository };
const recorder = (fail: (args: string[]) => boolean) => {
  const calls: string[][] = [];
  const git: Git = (args) => {
    calls.push(args);
    if (fail(args)) throw new Error("git failed");
    return "";
  };
  return { git, calls };
};

test("an unchanged sync point is no sync PR and needs no git", () => {
  const { git, calls } = recorder(() => true);
  expect(verifySyncPoint(OLD, OLD, git)).toBe(false);
  expect(verifySyncPoint(undefined, OLD, git)).toBe(false);
  expect(calls).toEqual([]);
});

test("a sync point from the upstream and descended from the old one is a sync PR", () => {
  const { git, calls } = recorder(() => false);
  expect(verifySyncPoint(OLD, NEW, git)).toBe(true);
  const fetch = calls.find((c) => c.includes("fetch"));
  expect(fetch).toContain(OLD.repository);
  expect(fetch).toContain(NEW.commit);
});

test("a commit the upstream cannot give is untrusted, not a plain PR", () => {
  const { git } = recorder((args) => args.includes("fetch"));
  expect(() => verifySyncPoint(OLD, NEW, git)).toThrow("同步点不可信");
});

test("a commit that does not descend from the old one is untrusted", () => {
  const { git } = recorder((args) => args.includes("--is-ancestor"));
  expect(() => verifySyncPoint(OLD, NEW, git)).toThrow("同步点不可信");
});

test("a changed repository is untrusted", () => {
  const { git } = recorder(() => false);
  expect(() =>
    verifySyncPoint(OLD, { ...OLD, repository: "https://evil/x.git" }, git),
  ).toThrow("同步点不可信");
  expect(() =>
    verifySyncPoint(OLD, { ...NEW, repository: "https://evil/x.git" }, git),
  ).toThrow("同步点不可信");
});
