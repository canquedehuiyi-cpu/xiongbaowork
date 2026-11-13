import { describe, expect, test } from "bun:test";
import { auditCapabilities } from "./audit-toolrefs";
import { buildReasonRefs } from "./emit-package";
import {
  annotateSkillsYaml,
} from "./annotate-package";

/** A shell command inside a fenced block — the strongest tier-1 citation. */
const SHELL_BODY = [
  "## 步骤",
  "",
  "```bash",
  "git init -q t && cd t",
  "```",
  "",
].join("\n");

const PLAIN_BODY = "打开面板，把标题改成一行以内，不要复述命令输出。";

describe("buildReasonRefs", () => {
  test("full findings produce no reason fields", () => {
    const [finding] = auditCapabilities(
      [{ slug: "clean", instructions: PLAIN_BODY, hasBundledReferences: true }],
      new Set(),
    );
    expect(buildReasonRefs(finding)).toEqual([]);
  });

  test("blocked findings name the rule and quote the best hit", () => {
    const [finding] = auditCapabilities(
      [{ slug: "shell", instructions: SHELL_BODY, hasBundledReferences: true }],
      new Set(),
    );
    const refs = buildReasonRefs(finding);
    expect(finding.level).toBe("blocked");
    expect(refs).toHaveLength(1);
    expect(refs[0].ruleId).toBe("shell-command-prose");
    expect(refs[0].text).toContain("shell 命令");
    expect(refs[0].text).toContain("git init");
  });
});

describe("annotateSkillsYaml", () => {
  function skillsYaml(entries: string): string {
    return `# 官方技能目录。\nskills:\n${entries}`;
  }

  test("blocked rows gain reason/reason_ref under runnable; full rows stay clean", () => {
    const raw = skillsYaml(
      [
        "  - slug: shelly",
        "    title: 壳",
        "    summary: 需要 shell。",
        "    instructions: |-",
        ...SHELL_BODY.split("\n").map((line) => `      ${line}`),
        "    tools: []",
        "    _porting:",
        "      source: xiongbao-package",
        "      runnable: blocked",
        "      dropped: []",
        "      refs_bytes: 0",
        "  - slug: tidy",
        "    title: 净",
        "    summary: 不需要 shell。",
        "    instructions: >-",
        "      打开面板，改标题。",
        "    tools: []",
        "    _porting:",
        "      source: xiongbao-package",
        "      runnable: full",
        "      dropped: []",
        "      refs_bytes: 0",
      ].join("\n"),
    );
    const annotated = annotateSkillsYaml(raw, new Set(["github"]));
    expect(annotated).toContain("      runnable: blocked\n      reason: shell-command-prose");
    expect(annotated).toMatch(/reason_ref: ".*git init/);
    // the full row keeps its shape — no reason lines, no churn
    expect(annotated).toContain("      runnable: full\n      dropped: []");
    // idempotent: annotating the annotation changes nothing
    expect(annotateSkillsYaml(annotated, new Set(["github"]))).toBe(annotated);
  });

  test("a body edited after its last audit refuses to annotate", () => {
    const raw = skillsYaml(
      [
        "  - slug: shelly",
        "    title: 壳",
        "    summary: 需要 shell。",
        "    instructions: >-",
        `      ${PLAIN_BODY}`,
        "    tools: []",
        "    _porting:",
        "      runnable: blocked",
        "      dropped: []",
      ].join("\n"),
    );
    expect(() => annotateSkillsYaml(raw, new Set())).toThrow(/重放审计/);
  });

  test("re-running over its own output is byte-identical (no churn on comments)", () => {
    const raw = skillsYaml(
      [
        "  # licence note that a parse-and-restringify would drop",
        "  - slug: shelly",
        "    title: 壳",
        "    summary: 需要 shell。",
        "    instructions: |-",
        ...SHELL_BODY.split("\n").map((line) => `      ${line}`),
        "    tools: []",
        "    _porting:",
        "      runnable: blocked",
        "      dropped: []",
      ].join("\n"),
    );
    const first = annotateSkillsYaml(raw, new Set());
    const second = annotateSkillsYaml(first, new Set());
    expect(second).toBe(first);
    expect(first).toContain("# licence note that a parse-and-restringify would drop");
  });
});
