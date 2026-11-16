import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AllowEntry,
  entryProblems,
} from "../../scripts/brand/guard/allowlist";

const REPO = new URL("../..", import.meta.url).pathname;
const ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(new URL("./brand-leak-allowlist.json", import.meta.url), "utf8"),
);

const good: AllowEntry = {
  file: "a.ts",
  text: "openbot",
  reason: "third-party-name: x",
  category: "third-party-name",
  plan: "keep",
};

describe("allowlist fields", () => {
  test("every entry has a category and a plan the category allows", () => {
    expect(ALLOWLIST.flatMap(entryProblems)).toEqual([]);
  });

  test("no entry still claims readMigrated where the file never calls it", () => {
    const liars = ALLOWLIST.filter(
      (entry) =>
        entry.reason.includes("readMigrated") &&
        !readFileSync(join(REPO, entry.file), "utf8").includes("readMigrated("),
    ).map((entry) => `${entry.file}: ${entry.text}`);
    expect(liars).toEqual([]);
  });

  test("entryProblems accepts a well-formed entry", () => {
    expect(entryProblems(good)).toEqual([]);
  });

  test("entryProblems names each fault", () => {
    const text = (entry: AllowEntry) => entryProblems(entry).join("\n");
    expect(
      text({ ...good, category: "nope" as AllowEntry["category"] }),
    ).toContain("category");
    expect(text({ ...good, plan: "rewrite" })).toContain("plan");
    expect(
      text({ ...good, category: "legacy-compat", plan: "remove" }),
    ).toContain("introducedIn");
    expect(
      text({
        ...good,
        category: "legacy-compat",
        plan: "remove",
        introducedIn: "0.2",
        removeIn: "0.2.11",
      }),
    ).toContain("X.Y.Z");
    expect(
      text({
        ...good,
        category: "persisted-data",
        plan: "rewrite",
        reason: "persisted-identifier: stored key",
      }),
    ).toContain("L1-");
    expect(
      entryProblems({
        ...good,
        category: "persisted-data",
        plan: "rewrite",
        reason: "persisted-identifier: stored key, L1-3",
      }),
    ).toEqual([]);
  });
});
