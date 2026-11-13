import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  COMPAT_COMMENT,
  compatProblems,
  treeCompatProblems,
} from "../../scripts/brand/guard/compat-comments";

/*
 * The compat windows written as source comments (see compat-comments.ts), held to their `removeIn`
 * the way brand-expiry holds the allowlist's entries to theirs.
 *
 * The examples are built from parts so this file does not spell a window itself; the tree check
 * skips tests anyway, but a reader grepping for live windows should not land here.
 */
const TAG = "legacy-compat";
const window = (introducedIn: string, removeIn: string, rest = "") =>
  `// ${TAG}：introducedIn ${introducedIn}，removeIn ${removeIn}${rest}`;

describe("the comment format", () => {
  test("full- and half-width colons and commas both fit, with or without a note", () => {
    for (const line of [
      window("0.2.11", "0.2.13"),
      window("0.2.11", "0.2.13", "，Task 20/21：covers botId"),
      `// ${TAG}: introducedIn 0.2.11, removeIn 0.2.13`,
      `/* ${TAG}：introducedIn 0.2.11，removeIn 0.2.13 */`,
    ])
      expect(COMPAT_COMMENT.test(line)).toBe(true);
  });
});

describe("judging one file", () => {
  test("an expired window is reported, with the file and line", () => {
    const source = ["const a = 1;", window("0.2.9", "0.2.11")].join("\n");
    expect(compatProblems("a.ts", source, "0.2.11")).toEqual([
      "这个旧名到期了，删掉兼容代码和这条注释：a.ts:2（removeIn 0.2.11，当前 0.2.11）",
    ]);
    expect(compatProblems("a.ts", source, "0.3.0")).toHaveLength(1);
  });

  test("a window still open is not reported", () => {
    expect(
      compatProblems("a.ts", window("0.2.11", "0.2.13"), "0.2.10"),
    ).toEqual([]);
    expect(
      compatProblems("a.ts", window("0.2.11", "0.2.13"), "0.2.12"),
    ).toEqual([]);
  });

  test("a malformed window is reported, never skipped", () => {
    for (const line of [
      `// ${TAG}：introducedIn 0.2.11`,
      `// ${TAG}：removeIn 0.2.13，introducedIn 0.2.11`,
      `// ${TAG}：introducedIn 0.2，removeIn 0.2.13`,
      `// ${TAG}：introducedIn <N>，removeIn <N+2>`,
      `// ${TAG}: x`,
      `// ${TAG} introducedIn 0.2.11，removeIn 0.2.13`,
      `// ${TAG}，removeIn 0.2.13`,
    ]) {
      const problems = compatProblems("b.ts", line, "0.2.10");
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("格式不对");
      expect(problems[0]).toContain("b.ts:1");
    }
  });

  test("prose that only names the category is not a window", () => {
    expect(
      compatProblems(
        "d.ts",
        `// deleted when its ${TAG} entry expires`,
        "0.2.10",
      ),
    ).toEqual([]);
  });

  test("removeIn not after introducedIn is reported", () => {
    expect(
      compatProblems("c.ts", window("0.2.13", "0.2.11"), "0.2.10")[0],
    ).toContain("removeIn 0.2.11 必须晚于 introducedIn 0.2.13");
  });
});

describe("the tree", () => {
  // The current version, read as brand-expiry reads it.
  const { version } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  test("the internal headers' window is recorded where they are read", () => {
    const source = readFileSync(
      new URL("../../agent-computer/src/wire-headers.ts", import.meta.url),
      "utf8",
    );
    const line = source.split("\n").find((l) => COMPAT_COMMENT.test(l));
    expect(line).toBeDefined();
    expect(COMPAT_COMMENT.exec(line as string)?.slice(1)).toEqual([
      "0.2.11",
      "0.2.13",
    ]);
    for (const name of ["botId", "personId", "computerToken", "egress"])
      expect(line).toContain(name);
  });

  test("no legacy-compat comment is past its window or malformed", () => {
    expect(treeCompatProblems(version)).toEqual([]);
  });
});
