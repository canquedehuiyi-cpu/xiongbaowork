/**
 * `--verify` 的空类别语义（Codex 审查意见 #498 之 3）。
 *
 * 修复前：agents.yaml 或 skills.yaml 任一为空就报问题，于是“只带专家”或“只带技能”的合法包
 * 会被验证拒绝。修复后：只拒绝三类能力条目（agents / skills / connectors）全部为空的包。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyOutDir } from "./verify-out-dir";
import { auditRulesSha256 } from "./mapping";

const root = mkdtempSync(join(tmpdir(), "port-capabilities-verify-"));
const CHECKSUM = "ab".repeat(32);

/** 写入一个输出目录的全部七个文件。字段传 null 表示该文件不写。 */
function writeOutDir(files: Record<string, string | null>): string {
  const dir = join(root, Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) {
      writeFileSync(join(dir, name), content, "utf8");
    }
  }
  return dir;
}

const EMPTY_AGENTS = "agents: []\n";
const EMPTY_TEAMS = "teams: []\n";
const EMPTY_CONNECTORS = "connectors: []\n";
const SKILLS_ONLY = `skills:
  - slug: only-skill
    title: 只有技能
    summary: 只带技能的合法包。
    instructions: 做事的步骤。
    tools: []
    _porting:
      runnable: full
      source: "workbuddy user-skill:only-skill"
      source_url: "WORKBUDDY_HOME/skills/only-skill/SKILL.md"
      checksum_sha256: ${CHECKSUM}
`;
const SKILL_MANIFEST_ROW = `- kind: skill
  slug: only-skill
  slug_source: raw
  source: "workbuddy user-skill:only-skill"
  source_url: "WORKBUDDY_HOME/skills/only-skill/SKILL.md"
  source_version: "(unspecified)"
  fetched_at: 2026-09-01T00:00:00.000Z
  checksum_sha256: ${CHECKSUM}
  license: "(unspecified)"
  redistributable: false
  attribution: "(unspecified)"
  runnable: full
  dropped: []
`;

/** 三个 YAML 都为空、清单也为空：三类全空才是唯一该拒绝的形态。 */
function allEmptyFiles(): Record<string, string> {
  return {
    "agents.yaml": EMPTY_AGENTS,
    "skills.yaml": "skills: []\n",
    "teams.yaml": EMPTY_TEAMS,
    "connectors.yaml": EMPTY_CONNECTORS,
    "capability-manifest.yaml": "[]\n",
    "slug-conflicts.md": "",
    "tool-ref-audit.md": "",
  };
}

describe("verifyOutDir 的空类别语义", () => {
  test("只带技能（agents 与 connectors 均为空）的合法包验证通过", () => {
    const dir = writeOutDir({
      "agents.yaml": EMPTY_AGENTS,
      "skills.yaml": SKILLS_ONLY,
      "teams.yaml": EMPTY_TEAMS,
      "connectors.yaml": EMPTY_CONNECTORS,
      // P2 契约：capability-manifest.yaml 首行与 tool-ref-audit.md 头部都要带 §6.4.1 stamp（fail-closed）。
      "capability-manifest.yaml": `# audit_rules_sha256: ${auditRulesSha256()}\n${SKILL_MANIFEST_ROW}`,
      "slug-conflicts.md": "",
      "tool-ref-audit.md": `audit_rules_sha256: ${auditRulesSha256()}\n`,
    });
    expect(verifyOutDir(dir)).toEqual([]);
  });

  test("三类条目全空是问题，且问题说明指向『全空』而不是『某一类为空』", () => {
    const dir = writeOutDir(allEmptyFiles());
    const problems = verifyOutDir(dir);
    expect(problems.some((problem) => problem.detail.includes("全空"))).toBe(
      true,
    );
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
