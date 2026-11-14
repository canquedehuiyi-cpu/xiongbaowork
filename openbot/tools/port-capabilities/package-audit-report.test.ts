/**
 * Tests for the package-side audit report (`bun run port:audit-report`).
 *
 * The gap these pin: `tool-ref-audit.md` was written once, at the moment the package was assembled, and
 * then never again. By the time it was caught it listed 60 of 109 skills, said `full 26 / degraded 0 /
 * blocked 34`, and had two rows that disagreed with the package in the *dangerous* direction — the package
 * advertised a skill as fully runnable that its own body says needs a shell. A report that covers half the
 * corpus is worse than no report: a reader takes silence for "nothing to report".
 *
 * The invariants, in the order they matter:
 *   1. Every capability the package ships appears exactly once, at exactly the level the package records.
 *      `skills.yaml`'s `_porting.runnable` and the manifest are the promise; the report restates it.
 *   2. The package may not be more optimistic than the rule table. Recorded `full` + rescanned `degraded`
 *      is an error, not something to render — that combination is the lie this file exists to prevent.
 *   3. The checked-in report equals what the renderer produces. Hand edits and stale snapshots both fail,
 *      which is the point: refreshing is one command (`bun run port:audit-report`), not a proofread.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  buildPackageReport,
  main,
  PackageReportError,
  renderPackageAuditReport,
  REPORT_FILE,
} from "./package-audit-report";

const REPO = join(import.meta.dir, "..", "..");
const EXAMPLE_PACKAGE = join(REPO, "examples", "xiongbao");

/** A package small enough to read: one clean skill, one rule-blocked, one ledger-downgraded, one agent. */
const SKILLS = `skills:
  - slug: clean-skill
    title: 干净技能
    summary: 正文只读入包的附件
    instructions: |-
      # Clean

      先读 \`references/kept.md\`。
    _porting:
      runnable: full
      dropped: []
  - slug: rule-blocked
    title: 要 shell 的技能
    summary: 正文给出可执行命令
    instructions: |-
      # Blocked

      \`\`\`bash
      bash scripts/deploy.sh prod
      \`\`\`
    _porting:
      runnable: blocked
      reason: shell-command-prose
      reason_ref: "正文给出可执行的 shell 命令（带实参/heredoc/管道）；openbot 员工没有本地运行时。 ← \\"bash scripts/deploy.sh prod\\""
      dropped:
        - scripts/
  - slug: ledger-downgraded
    title: 账本判降级
    summary: 目录在、文件缺——规则表的布尔看不见
    instructions: |-
      # Ledger

      对照 \`references/issue-taxonomy.md\` 分类。
    _porting:
      runnable: degraded
      reason: missing-asset-references
      reason_ref: 文件 references/issue-taxonomy.md 未入包，正文引用 references/issue-taxonomy.md
      dropped: []
`;

const AGENTS = `agents:
  - id: seed-agent
    name: 种子员工
    system_prompt: 你是一个种子员工，只做对话。
`;

const SPLIT_AGENT = `id: split-agent
name: 拆分员工
system_prompt: |-
  # 拆分

  跑 \`bash scripts/render.sh\` 出图。
`;

const MANIFEST = `- kind: agent
  slug: seed-agent
  runnable: full
- kind: agent
  slug: split-agent
  runnable: blocked
- kind: skill
  slug: clean-skill
  runnable: full
- kind: skill
  slug: rule-blocked
  runnable: blocked
- kind: skill
  slug: ledger-downgraded
  runnable: degraded
`;

/** Write a throwaway package and return its directory. */
function packageWith(
  overrides: { manifest?: string; skills?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-report-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  // 目录在、文件缺：这是账本判降级、规则表判 full 的那个形状。
  mkdirSync(join(dir, "skills", "ledger-downgraded", "references"), {
    recursive: true,
  });
  // 目录在、文件也在：规则表因此判 full，账本也没有话说。
  mkdirSync(join(dir, "skills", "clean-skill", "references"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "skills", "clean-skill", "references", "kept.md"),
    "# kept\n",
    "utf8",
  );
  writeFileSync(join(dir, "skills.yaml"), overrides.skills ?? SKILLS, "utf8");
  writeFileSync(join(dir, "agents.yaml"), AGENTS, "utf8");
  writeFileSync(join(dir, "agents", "split-agent.yaml"), SPLIT_AGENT, "utf8");
  writeFileSync(
    join(dir, "capability-manifest.yaml"),
    overrides.manifest ?? MANIFEST,
    "utf8",
  );
  return dir;
}

/** 表里某一行（按首列 slug 找）；找不到返回 undefined。 */
function rowOf(report: string, slug: string): string | undefined {
  return report.split("\n").find((line) => line.startsWith(`| ${slug} |`));
}

describe("buildPackageReport", () => {
  test("档位一律取包内记录：账本降的不被规则表的 full 顶回去", () => {
    const report = buildPackageReport(packageWith());
    const levels = Object.fromEntries(
      [...report.skills, ...report.agents].map((finding) => [
        finding.slug,
        finding.level,
      ]),
    );
    expect(levels).toEqual({
      "clean-skill": "full",
      "rule-blocked": "blocked",
      "ledger-downgraded": "degraded",
      "seed-agent": "full",
      "split-agent": "blocked",
    });
  });

  test("账本降级那一行用 _porting.reason_ref 作证据，不留空引文", () => {
    const report = buildPackageReport(packageWith());
    const finding = report.skills.find(
      (row) => row.slug === "ledger-downgraded",
    );
    expect(finding?.hits).toHaveLength(1);
    expect(finding?.hits[0].ruleId).toBe("missing-asset-references");
    expect(finding?.hits[0].sample).toContain("references/issue-taxonomy.md");
    expect(finding?.hits[0].reason).toContain("文件级账本");
  });

  test("规则表判 blocked 的那行保留真命中（引文是真扫出来的，不是账本转述）", () => {
    const report = buildPackageReport(packageWith());
    const finding = report.skills.find((row) => row.slug === "rule-blocked");
    expect(finding?.level).toBe("blocked");
    const ruleIds = finding?.hits.map((hit) => hit.ruleId) ?? [];
    expect(ruleIds).toContain("shell-command-prose");
    expect(finding?.hits[0].sample).toContain("scripts/deploy.sh");
  });

  test("包比审计更乐观 → 抛错，不出一份好看的报告", () => {
    const dir = packageWith({
      manifest: MANIFEST.replace(
        "  slug: rule-blocked\n  runnable: blocked",
        "  slug: rule-blocked\n  runnable: full",
      ),
      skills: SKILLS.replace("      runnable: blocked", "      runnable: full"),
    });
    expect(() => buildPackageReport(dir)).toThrow(PackageReportError);
    expect(() => buildPackageReport(dir)).toThrow(/rule-blocked/);
  });

  test("记了降级却没写 reason/reason_ref → 抛错，不许静默编理由", () => {
    const dir = packageWith({
      skills: SKILLS.replace(
        "      reason: missing-asset-references\n      reason_ref: 文件 references/issue-taxonomy.md 未入包，正文引用 references/issue-taxonomy.md\n",
        "",
      ),
    });
    expect(() => buildPackageReport(dir)).toThrow(PackageReportError);
  });

  test("manifest 有 agent 但两处正文都没有 → 抛错", () => {
    const dir = packageWith({
      manifest: `${MANIFEST}- kind: agent\n  slug: ghost-agent\n  runnable: full\n`,
    });
    expect(() => buildPackageReport(dir)).toThrow(/ghost-agent/);
  });
});

describe("renderPackageAuditReport", () => {
  test("两段表都覆盖到，汇总行与逐条一致", () => {
    const report = renderPackageAuditReport(packageWith());
    expect(report).toContain("合计 3 条：full 1 / degraded 1 / blocked 1。");
    expect(report).toContain("合计 2 条：full 1 / degraded 0 / blocked 1。");
    for (const slug of [
      "clean-skill",
      "rule-blocked",
      "ledger-downgraded",
      "seed-agent",
      "split-agent",
    ]) {
      expect(rowOf(report, slug)).toBeDefined();
    }
    // full 行不许编命中，非 full 行不许写成无命中。
    expect(rowOf(report, "clean-skill")).toContain("| full | — | — | 无命中 |");
    expect(rowOf(report, "ledger-downgraded")).toContain(
      "missing-asset-references:",
    );
  });

  test("渲染是纯函数：同一份包两次渲染字节一致", () => {
    const dir = packageWith();
    expect(renderPackageAuditReport(dir)).toBe(renderPackageAuditReport(dir));
  });
});

describe("main", () => {
  test("--check 不一致退出 1，写盘后一致退出 0", () => {
    const dir = packageWith();
    writeFileSync(join(dir, REPORT_FILE), "旧报告\n", "utf8");
    expect(main(["--package", dir, "--check"])).toBe(1);
    expect(main(["--package", dir])).toBe(0);
    expect(main(["--package", dir, "--check"])).toBe(0);
  });

  test("缺 --package → 用法错误", () => {
    expect(main([])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 真实包的守卫：这份 checked-in 报告就是部署出去的那一份，不许与包内记录不符。
// ---------------------------------------------------------------------------

const EXAMPLE_REPORT = join(EXAMPLE_PACKAGE, REPORT_FILE);

describe("examples/xiongbao 的三面一致", () => {
  test("报告逐条覆盖 skills.yaml 的每个技能，档位与 _porting.runnable 一致", () => {
    const report = buildPackageReport(EXAMPLE_PACKAGE);
    const doc = parseYaml(
      readFileSync(join(EXAMPLE_PACKAGE, "skills.yaml"), "utf8"),
    ) as {
      skills: { slug: string; _porting?: { runnable?: string } }[];
    };
    const recorded = new Map(
      doc.skills.map((skill) => [skill.slug, skill._porting?.runnable]),
    );
    expect(report.skills.map((finding) => finding.slug).sort()).toEqual(
      [...recorded.keys()].sort(),
    );
    for (const finding of report.skills) {
      expect(`${finding.slug}=${finding.level}`).toBe(
        `${finding.slug}=${recorded.get(finding.slug)}`,
      );
    }
  });

  test("报告逐条覆盖 manifest 的每个员工，档位与 manifest 一致", () => {
    const report = buildPackageReport(EXAMPLE_PACKAGE);
    const rows = parseYaml(
      readFileSync(join(EXAMPLE_PACKAGE, "capability-manifest.yaml"), "utf8"),
    ) as { kind: string; slug: string; runnable: string }[];
    const recorded = new Map(
      rows
        .filter((row) => row.kind === "agent")
        .map((row) => [row.slug, row.runnable]),
    );
    expect(report.agents.map((finding) => finding.slug).sort()).toEqual(
      [...recorded.keys()].sort(),
    );
    for (const finding of report.agents) {
      expect(`${finding.slug}=${finding.level}`).toBe(
        `${finding.slug}=${recorded.get(finding.slug)}`,
      );
    }
  });

  test("manifest 的技能档位与 skills.yaml 同源，不许各说各话", () => {
    const doc = parseYaml(
      readFileSync(join(EXAMPLE_PACKAGE, "skills.yaml"), "utf8"),
    ) as {
      skills: { slug: string; _porting?: { runnable?: string } }[];
    };
    const rows = parseYaml(
      readFileSync(join(EXAMPLE_PACKAGE, "capability-manifest.yaml"), "utf8"),
    ) as { kind: string; slug: string; runnable: string }[];
    const manifest = new Map(
      rows
        .filter((row) => row.kind === "skill")
        .map((row) => [row.slug, row.runnable]),
    );
    for (const skill of doc.skills) {
      expect(`${skill.slug}:${manifest.get(skill.slug)}`).toBe(
        `${skill.slug}:${skill._porting?.runnable}`,
      );
    }
    expect(manifest.size).toBe(doc.skills.length);
  });

  test("checked-in 报告 ≡ 渲染器输出（陈旧快照或手改都会红）", () => {
    expect(readFileSync(EXAMPLE_REPORT, "utf8")).toBe(
      renderPackageAuditReport(EXAMPLE_PACKAGE),
    );
  });

  test("落位口径钉死：技能 62/11/36、员工 26/1/1", () => {
    const report = readFileSync(EXAMPLE_REPORT, "utf8");
    expect(report).toContain(
      "合计 109 条：full 62 / degraded 11 / blocked 36。",
    );
    expect(report).toContain("合计 28 条：full 26 / degraded 1 / blocked 1。");
  });

  test("docs/porting/tool-ref-audit.md 的汇总不许另说一套", () => {
    /*
     * 这份是人类读者的入口，之前它写 72/2/35（纯规则表口径），而包内是 64/9/36：读者拿到的
     * 是「18 条降级根本不存在」的版本。汇总数字必须与包一致，逐条表可以说"规则表看不见"。
     */
    const doc = readFileSync(
      join(REPO, "docs", "porting", "tool-ref-audit.md"),
      "utf8",
    );
    expect(doc).toContain("| skill | 62 | 11 | 36 | 109 |");
    expect(doc).toContain("| agent | 26 | 1 | 1 | 28 |");
  });
});
