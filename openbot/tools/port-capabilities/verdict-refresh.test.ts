/**
 * Tests for the verdict refresh mode (`bun run port:verdict-refresh`).
 *
 * The gap these pin: the pipeline could not be re-run against a source tree whose checksums still match
 * the package, so nine `full → degraded` verdicts existed only in code while the shipped package kept
 * advertising those skills as fully runnable. Rebuilding from source was not an option (source drifted),
 * and hand-editing YAML is not a mechanism. This mode recomputes the verdicts from the package's own
 * recorded evidence — `_porting.dropped` plus the `assets:` list P1 actually shipped — and rewrites only
 * the verdict lines, so the badge and the files agree without pretending a source tree exists.
 *
 * Three invariants matter more than the happy path:
 *   1. Only verdict lines move. Everything else in the file must stay byte-identical, or this becomes a
 *      reformatter that quietly rewrites 109 entries.
 *   2. Only `full` is ever lowered. A `blocked` row carries a licence reason; overwriting it would erase
 *      the only record of why the skill may not ship.
 *   3. A declared asset that is not on disk is an error, not a downgrade — the package must not claim
 *      files it does not have.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  applyVerdictsToManifestYaml,
  applyVerdictsToSkillsYaml,
  computeRefreshVerdicts,
  HOST_SPECIFIC_RULE_ID,
  MISSING_ASSET_RULE_ID,
  main,
  refreshPackageVerdicts,
  VerdictRefreshError,
} from "./verdict-refresh";

const SKILLS_FIXTURE = `skills:
  - slug: clean-skill
    title: 干净技能
    summary: 正文只读入包的附件
    instructions: |-
      # Clean

      先读 \`references/kept.md\`。
    tools: []
    assets:
      - references/kept.md
    _porting:
      source: workbuddy skill-marketplace:clean-skill@1.0.0
      license: unspecified
      runnable: full
      dropped:
        - references/
      refs_bytes: 12
  - slug: cites-missing-dir
    title: 引用未入包目录
    summary: 正文让人去读 specialists/
    instructions: |-
      # 评审

      对照 \`specialists/api-contract.md\` 看接口。
    tools: []
    _porting:
      source: workbuddy skill-marketplace:cites-missing-dir@1.0.0
      license: unspecified
      runnable: full
      dropped:
        - specialists/
      refs_bytes: 4096
  - slug: already-blocked
    title: 已阻断
    summary: 无脚本通道
    instructions: |-
      # Blocked

      先读 \`specialists/security.md\` 再跑脚本。
    tools: []
    _porting:
      source: workbuddy skill-marketplace:already-blocked@1.0.0
      license: unspecified
      runnable: blocked
      reason: executable-scripts
      reason_ref: "正文引用 scripts/ 下的可执行文件"
      dropped:
        - scripts/
        - specialists/
      refs_bytes: 99
  - slug: already-degraded
    title: 已部分可用
    summary: 审计已判 degraded，理由来自另一条规则
    instructions: |-
      # Degraded

      参见 \`notes/design.md\`。
    tools: []
    _porting:
      source: workbuddy skill-marketplace:already-degraded@1.0.0
      license: unspecified
      runnable: degraded
      reason: shell-commands
      reason_ref: "正文给出可执行的 shell 命令"
      dropped:
        - notes/
      refs_bytes: 33
  - slug: workbuddy-market-export
    title: 市场导出
    summary: 宿主专属
    instructions: |-
      # Export

      调用 WorkBuddy 市场的免鉴权整包接口。
    tools: []
    _porting:
      source: workbuddy skill-marketplace:workbuddy-market-export@unspecified
      license: unspecified
      runnable: full
      dropped: []
      refs_bytes: 0
`;

const MANIFEST_FIXTURE = `- kind: agent
  slug: general-assistant
  runnable: full
- kind: skill
  slug: clean-skill
  runnable: full
- kind: skill
  slug: cites-missing-dir
  runnable: full
- kind: skill
  slug: workbuddy-market-export
  runnable: full
`;

function skillsRowsOf(text: string): Record<string, unknown>[] {
  return (parseYaml(text) as { skills: Record<string, unknown>[] }).skills;
}

/** One skill's text block, from its `- slug:` line up to the next skill's. */
function blockOf(text: string, slug: string): string {
  const start = text.indexOf(`  - slug: ${slug}\n`);
  if (start < 0) throw new Error(`fixture 里没有 ${slug}`);
  const next = text.indexOf("\n  - slug: ", start + 1);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

function verdictsOf(text: string) {
  return computeRefreshVerdicts({ skills: skillsRowsOf(text) });
}

describe("computeRefreshVerdicts", () => {
  test("正文引用未入包目录的 full 技能降为 degraded，理由与证据同向", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    const verdict = verdicts.get("cites-missing-dir");
    expect(verdict).toBeDefined();
    expect(verdict?.runnable).toBe("degraded");
    expect(verdict?.reason).toBe(MISSING_ASSET_RULE_ID);
    expect(verdict?.reasonRef).toContain("specialists");
  });

  test("P0 的 references/ 历史记录被已入包的 assets 取代，不降级", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    expect(verdicts.has("clean-skill")).toBe(false);
  });

  test("blocked 不动：它引用的目录确实没入包，但许可理由必须留在原处", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    expect(verdicts.has("already-blocked")).toBe(false);
    const patched = applyVerdictsToSkillsYaml(SKILLS_FIXTURE, verdicts);
    expect(patched).toContain(
      "      runnable: blocked\n      reason: executable-scripts\n",
    );
  });

  test("已是 degraded 的不重复降：审计给的理由不被本规则顶掉", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    expect(verdicts.has("already-degraded")).toBe(false);
    const patched = applyVerdictsToSkillsYaml(SKILLS_FIXTURE, verdicts);
    expect(blockOf(patched, "already-degraded")).toBe(
      blockOf(SKILLS_FIXTURE, "already-degraded"),
    );
    expect(patched).toContain("      reason: shell-commands\n");
  });

  test("宿主专属技能改判 blocked，理由为 host-specific-skill", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    const verdict = verdicts.get("workbuddy-market-export");
    expect(verdict?.runnable).toBe("blocked");
    expect(verdict?.reason).toBe(HOST_SPECIFIC_RULE_ID);
    expect(verdict?.reasonRef).not.toBe("");
  });

  test("声明的附件在磁盘上不存在 → 抛错，不许自称有", () => {
    expect(() =>
      computeRefreshVerdicts({
        skills: skillsRowsOf(SKILLS_FIXTURE),
        assetExists: () => false,
      }),
    ).toThrow(VerdictRefreshError);
  });

  test("声明的附件都在磁盘上 → 不抛错", () => {
    expect(() =>
      computeRefreshVerdicts({
        skills: skillsRowsOf(SKILLS_FIXTURE),
        assetExists: () => true,
      }),
    ).not.toThrow();
  });
});

describe("applyVerdictsToSkillsYaml", () => {
  test("只改目标行档位并紧随其后插入 reason/reason_ref，其余字节不变", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    const patched = applyVerdictsToSkillsYaml(SKILLS_FIXTURE, verdicts);

    // 未被点名的技能块必须逐字节原样。
    expect(blockOf(patched, "clean-skill")).toBe(
      blockOf(SKILLS_FIXTURE, "clean-skill"),
    );
    expect(blockOf(patched, "already-blocked")).toBe(
      blockOf(SKILLS_FIXTURE, "already-blocked"),
    );

    // 被点名的块：一行改 + 两行插入，其余行原地不动。
    const srcLines = blockOf(SKILLS_FIXTURE, "cites-missing-dir").split("\n");
    const outLines = blockOf(patched, "cites-missing-dir").split("\n");
    expect(outLines.length).toBe(srcLines.length + 2);
    const at = srcLines.indexOf("      runnable: full");
    expect(at).toBeGreaterThan(0);
    expect(outLines[at]).toBe("      runnable: degraded");
    expect(outLines[at + 1]).toBe("      reason: missing-asset-references");
    expect(outLines[at + 2].startsWith("      reason_ref: ")).toBe(true);
    expect(outLines[at + 2]).toContain("specialists");
    const stripped = [...outLines.slice(0, at + 1), ...outLines.slice(at + 3)];
    expect(stripped).toEqual(
      srcLines.map((line, index) =>
        index === at ? "      runnable: degraded" : line,
      ),
    );

    // 整个文件只有两个技能块发生变化。
    const changedBlocks = [
      "clean-skill",
      "cites-missing-dir",
      "already-blocked",
      "already-degraded",
      "workbuddy-market-export",
    ].filter(
      (slug) => blockOf(patched, slug) !== blockOf(SKILLS_FIXTURE, slug),
    );
    expect(changedBlocks).toEqual([
      "cites-missing-dir",
      "workbuddy-market-export",
    ]);
  });

  test("改完仍是可解析的 YAML，档位与理由都可读回", () => {
    const patched = applyVerdictsToSkillsYaml(
      SKILLS_FIXTURE,
      verdictsOf(SKILLS_FIXTURE),
    );
    const rows = skillsRowsOf(patched);
    const byslug = new Map(rows.map((row) => [String(row.slug), row]));
    const missing = byslug.get("cites-missing-dir") as Record<string, unknown>;
    const porting = missing._porting as Record<string, unknown>;
    expect(porting.runnable).toBe("degraded");
    expect(porting.reason).toBe(MISSING_ASSET_RULE_ID);
    expect(String(porting.reason_ref)).toContain("specialists");

    const exported = byslug.get("workbuddy-market-export") as Record<
      string,
      unknown
    >;
    const exportedPorting = exported._porting as Record<string, unknown>;
    expect(exportedPorting.runnable).toBe("blocked");
    expect(exportedPorting.reason).toBe(HOST_SPECIFIC_RULE_ID);
  });

  test("幂等：再应用一次字节不变", () => {
    const verdicts = verdictsOf(SKILLS_FIXTURE);
    const once = applyVerdictsToSkillsYaml(SKILLS_FIXTURE, verdicts);
    const twice = applyVerdictsToSkillsYaml(once, verdictsOf(once));
    expect(twice).toBe(once);
  });

  test("空表原样返回", () => {
    expect(applyVerdictsToSkillsYaml(SKILLS_FIXTURE, new Map())).toBe(
      SKILLS_FIXTURE,
    );
  });

  test("要改的 slug 不在文件里 → 抛错，而不是静默跳过", () => {
    const verdicts = new Map([
      [
        "not-in-file",
        {
          slug: "not-in-file",
          runnable: "degraded" as const,
          reason: MISSING_ASSET_RULE_ID,
          reasonRef: "证据",
        },
      ],
    ]);
    expect(() => applyVerdictsToSkillsYaml(SKILLS_FIXTURE, verdicts)).toThrow(
      VerdictRefreshError,
    );
  });
});

describe("applyVerdictsToManifestYaml", () => {
  test("只改 skills.yaml 与 manifest 都有的那一行 runnable", () => {
    const patched = applyVerdictsToManifestYaml(
      MANIFEST_FIXTURE,
      verdictsOf(SKILLS_FIXTURE),
    );
    expect(patched).toContain(
      "- kind: skill\n  slug: cites-missing-dir\n  runnable: degraded\n",
    );
    expect(patched).toContain(
      "- kind: skill\n  slug: clean-skill\n  runnable: full\n",
    );
    // agent 行不参与技能档位
    expect(patched).toContain(
      "- kind: agent\n  slug: general-assistant\n  runnable: full\n",
    );
    expect(
      patched.split("\n").filter((line) => line.includes("runnable:")),
    ).toHaveLength(4);
  });

  test("幂等", () => {
    const once = applyVerdictsToManifestYaml(
      MANIFEST_FIXTURE,
      verdictsOf(SKILLS_FIXTURE),
    );
    expect(
      applyVerdictsToManifestYaml(
        once,
        verdictsOf(
          applyVerdictsToSkillsYaml(SKILLS_FIXTURE, verdictsOf(SKILLS_FIXTURE)),
        ),
      ),
    ).toBe(once);
  });
});

/** A throwaway package directory holding the two files the refresh reads. */
function tempPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), "verdict-refresh-"));
  writeFileSync(join(dir, "skills.yaml"), SKILLS_FIXTURE, "utf8");
  writeFileSync(
    join(dir, "capability-manifest.yaml"),
    MANIFEST_FIXTURE,
    "utf8",
  );
  // clean-skill declares references/kept.md; the package must actually hold it.
  mkdirSync(join(dir, "skills", "clean-skill", "references"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "skills", "clean-skill", "references", "kept.md"),
    "# kept\n",
    "utf8",
  );
  return dir;
}

describe("refreshPackageVerdicts", () => {
  test("--check 在包与重算不一致时列出待改项且不写文件", () => {
    const dir = tempPackage();
    const result = refreshPackageVerdicts({ packageDir: dir, write: false });
    expect(result.pending.map((verdict) => verdict.slug).sort()).toEqual([
      "cites-missing-dir",
      "workbuddy-market-export",
    ]);
    expect(result.changed).toEqual([]);
  });

  test("写入后两份文件的档位一致，且 --check 变干净", () => {
    const dir = tempPackage();
    const result = refreshPackageVerdicts({ packageDir: dir, write: true });
    expect(result.changed).toHaveLength(2);
    expect(
      refreshPackageVerdicts({ packageDir: dir, write: false }).pending,
    ).toEqual([]);
    // 第二次写入不再产生变更（幂等）
    expect(
      refreshPackageVerdicts({ packageDir: dir, write: true }).changed,
    ).toEqual([]);
  });

  test("声明的附件不存在时拒绝运行", () => {
    const dir = tempPackage();
    writeFileSync(
      join(dir, "skills.yaml"),
      SKILLS_FIXTURE.replace(
        "      - references/kept.md",
        "      - references/kept.md\n      - references/vanished.md",
      ),
      "utf8",
    );
    expect(() =>
      refreshPackageVerdicts({ packageDir: dir, write: false }),
    ).toThrow(VerdictRefreshError);
  });
});

describe("main", () => {
  test("--package 缺失 → 用法错误", () => {
    expect(main([])).toBe(2);
  });

  test("--check 不一致 → 退出码 1", () => {
    const dir = tempPackage();
    expect(main(["--package", dir, "--check"])).toBe(1);
  });

  test("写入后 --check → 退出码 0", () => {
    const dir = tempPackage();
    expect(main(["--package", dir])).toBe(0);
    expect(main(["--package", dir, "--check"])).toBe(0);
  });
});
