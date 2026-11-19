/**
 * Tests for the attachment reachability audit.
 *
 * The defect these pin: a skill was shipped as `runnable: full` while its body told the reader to open
 * files that the assembly step had refused to ship. The badge said "works as advertised"; the reader
 * would find nothing there and either fail or, worse, invent a substitute the user believes is real.
 *
 * Two different "dropped" shapes reach the analyser and they do NOT mean the same thing:
 *   - `references/` — the P0 pipeline did not carry the directory, but P1 inlines `references/**` into
 *     the package. When assets were shipped, this entry is superseded and must not raise an alarm.
 *   - any other `<dir>/` — P1 never carries it, so the whole directory is genuinely absent.
 *   - `references/<file>（…KB…）` — P1 looked and refused that one file (over the 24KB cap, or binary).
 */

import { describe, expect, test } from "bun:test";

import {
  applyMissingAssetDowngrade,
  findMissingAssetReferences,
  formatMissingAssetEvidence,
  MISSING_ASSET_RULE_ID,
} from "./asset-reachability";

/** Body text that references `path`, wrapped in prose the way a real SKILL.md would. */
function bodyReferencing(...paths: string[]): string {
  return [
    "# Skill",
    "",
    "Read the following before you start:",
    ...paths.map((path) => `- \`${path}\` — background`),
    "",
  ].join("\n");
}

describe("findMissingAssetReferences", () => {
  test("a non-references directory the pipeline never carried is a real gap when the body points into it", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("specialists/security.md", "specialists/red-team.md"),
      dropped: ["specialists/"],
      assets: [],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].target).toBe("specialists");
    expect(missing[0].kind).toBe("directory");
    expect(missing[0].samples).toEqual([
      "specialists/red-team.md",
      "specialists/security.md",
    ]);
  });

  test("a dropped directory the body never points into is not a gap", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("references/kept.md"),
      dropped: ["scripts/"],
      assets: ["references/kept.md"],
    });
    expect(missing).toEqual([]);
  });

  test("a bare references/ entry is superseded once P1 shipped assets", () => {
    // The P0 record says "references/ not carried"; P1 then inlined it. The old entry is history, not
    // a gap — treating it as one would downgrade every skill that has references at all.
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("references/audit.md", "references/adapt.md"),
      dropped: ["references/"],
      assets: ["references/audit.md", "references/adapt.md"],
    });
    expect(missing).toEqual([]);
  });

  test("a bare references/ entry stays a gap when P1 shipped nothing", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("references/audit.md"),
      dropped: ["references/"],
      assets: [],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].target).toBe("references");
    expect(missing[0].kind).toBe("directory");
  });

  test("a single refused file under references/ is a gap only for that file", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("references/voltagent.md", "references/airbnb.md"),
      dropped: ["references/", "references/voltagent.md（25.7KB，超过单文件 24KB 入仓上限）"],
      assets: ["references/airbnb.md"],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].kind).toBe("file");
    expect(missing[0].target).toBe("references/voltagent.md");
    expect(missing[0].samples).toEqual(["references/voltagent.md"]);
  });

  test("a refused file the body never names is not a gap", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("references/airbnb.md"),
      dropped: ["references/playbook.md（24.1KB，超过单文件 24KB 入仓上限）"],
      assets: ["references/airbnb.md"],
    });
    expect(missing).toEqual([]);
  });

  test("nested paths under a dropped directory are captured whole", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("assets/themes/dark.css"),
      dropped: ["assets/"],
      assets: ["references/x.md"],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].samples).toEqual(["assets/themes/dark.css"]);
  });

  test("a path that merely contains the directory name is not a reference to it", () => {
    // `myassets/x.md` must not be read as a hit for `assets/`.
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("myassets/theme.css"),
      dropped: ["assets/"],
      assets: [],
    });
    expect(missing).toEqual([]);
  });

  test("repeated mentions collapse to one sample and the order is stable", () => {
    const instructions = [
      "`specialists/security.md` first",
      "again `specialists/security.md`",
      "and `specialists/red-team.md`",
    ].join("\n");
    const missing = findMissingAssetReferences({
      instructions,
      dropped: ["specialists/"],
      assets: [],
    });
    // Sorted, not first-seen order: the report must be byte-stable across runs.
    expect(missing[0].samples).toEqual([
      "specialists/red-team.md",
      "specialists/security.md",
    ]);
  });

  test("a directory name containing a dot is matched literally, not as a wildcard", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("v1x2/a.md", "v1.2/a.md"),
      dropped: ["v1.2/"],
      assets: [],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].samples).toEqual(["v1.2/a.md"]);
  });

  test("reasons in the dropped strings do not leak into the reported target", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("references/playbook.md"),
      dropped: ["references/playbook.md（24.1KB，超过单文件 24KB 入仓上限）"],
      assets: [],
    });
    expect(missing[0].target).toBe("references/playbook.md");
    expect(missing[0].target).not.toContain("（");
  });

  test("both gap shapes can coexist, directories first", () => {
    const missing = findMissingAssetReferences({
      instructions: bodyReferencing("templates/qa-report-template.md", "references/voltagent.md"),
      dropped: ["templates/", "references/voltagent.md（25.7KB，超过单文件 24KB 入仓上限）"],
      assets: ["references/airbnb.md"],
    });
    expect(missing.map((item) => item.kind)).toEqual(["directory", "file"]);
    expect(missing.map((item) => item.target)).toEqual([
      "templates",
      "references/voltagent.md",
    ]);
  });

  test("an empty body or an empty dropped list yields nothing", () => {
    expect(
      findMissingAssetReferences({ instructions: "", dropped: ["assets/"], assets: [] }),
    ).toEqual([]);
    expect(
      findMissingAssetReferences({ instructions: bodyReferencing("assets/a.html"), dropped: [], assets: [] }),
    ).toEqual([]);
  });
});

describe("applyMissingAssetDowngrade", () => {
  const gap = [
    {
      target: "assets",
      kind: "directory" as const,
      samples: ["assets/template.html"],
    },
  ];

  test("full drops to degraded when the body points at nothing that ships", () => {
    expect(applyMissingAssetDowngrade("full", gap)).toBe("degraded");
  });

  test("full stays full when every reference resolves", () => {
    expect(applyMissingAssetDowngrade("full", [])).toBe("full");
  });

  test("a verdict already worse than degraded is never softened or raised", () => {
    // blocked outranks degraded; a missing asset must not silently improve the verdict.
    expect(applyMissingAssetDowngrade("blocked", gap)).toBe("blocked");
    expect(applyMissingAssetDowngrade("degraded", gap)).toBe("degraded");
  });

  test("the rule id is the stable token the reason field records", () => {
    expect(MISSING_ASSET_RULE_ID).toBe("missing-asset-references");
  });
});

describe("formatMissingAssetEvidence", () => {
  test("a whole directory reads as one fact, with the count spelled out", () => {
    const text = formatMissingAssetEvidence([
      {
        target: "specialists",
        kind: "directory",
        samples: [
          "specialists/api-contract.md",
          "specialists/data-migration.md",
          "specialists/maintainability.md",
          "specialists/performance.md",
        ],
      },
    ]);
    expect(text).toContain("目录 specialists");
    expect(text).toContain("未入包");
    expect(text).toContain("等 4 个");
  });

  test("three or fewer samples are listed without a count suffix", () => {
    const text = formatMissingAssetEvidence([
      { target: "assets", kind: "directory", samples: ["assets/template.html"] },
    ]);
    expect(text).toContain("assets/template.html");
    expect(text).not.toContain("等 ");
  });

  test("files and directories are labelled differently", () => {
    const text = formatMissingAssetEvidence([
      { target: "assets", kind: "directory", samples: ["assets/a.html"] },
      { target: "references/b.md", kind: "file", samples: ["references/b.md"] },
    ]);
    expect(text).toContain("目录 assets");
    expect(text).toContain("文件 references/b.md");
    expect(text).toContain("；");
  });

  test("no gaps formats to the empty string", () => {
    expect(formatMissingAssetEvidence([])).toBe("");
  });
});
