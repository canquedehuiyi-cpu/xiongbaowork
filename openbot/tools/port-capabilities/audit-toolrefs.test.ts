/**
 * The auditor decides whether a ported instruction body can still run, so every test here is one line
 * lifted from a real body plus the verdict it must produce.
 *
 * Two behaviours matter more than the individual patterns and are asserted explicitly:
 *
 *   - the verdict is the *worst* rule that fires, not the first or the last;
 *   - `references/` is only a defect when the files are genuinely absent, because the alternative would
 *     mark 20 of the 43 skills on this machine broken for pointing at a directory they do ship.
 */
import { describe, expect, test } from "bun:test";

import { auditCapability, auditCapabilities, countByLevel, shortenSample } from "./audit-toolrefs";
import { AUDIT_RULE_TABLE, auditRule, SEVERITY_ORDER } from "./mapping";

const NO_CONNECTORS: ReadonlySet<string> = new Set<string>();

/** Judge a body with no connectors available. */
function judge(instructions: string, hasBundledReferences = false) {
  return auditCapability({ slug: "demo", instructions, hasBundledReferences }, NO_CONNECTORS);
}

describe("rule table", () => {
  test("every rule has a unique id and a severity", () => {
    const ids = AUDIT_RULE_TABLE.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of AUDIT_RULE_TABLE) {
      expect(SEVERITY_ORDER[rule.level]).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });

  test("a pattern rule carries a pattern and the mcp rule does not", () => {
    expect(auditRule("bash-call").pattern).toBeDefined();
    expect(auditRule("unknown-mcp-server").pattern).toBeUndefined();
  });

  test("looking up an unknown rule fails loudly", () => {
    expect(() => auditRule("not-a-rule")).toThrow(/unknown audit rule/);
  });
});

describe("blocked rules", () => {
  test("a Bash(...) call blocks the capability", () => {
    const finding = judge("Run Bash(git status) to see the tree.");
    expect(finding.level).toBe("blocked");
    expect(finding.hits.map((hit) => hit.ruleId)).toContain("bash-call");
  });

  test("a shell command line blocks the capability", () => {
    expect(judge("先执行 bash scripts/collect.sh 收集数据").level).toBe("blocked");
    expect(judge("run python3 tools/report.py first").level).toBe("blocked");
    expect(judge("then node build.mjs").level).toBe("blocked");
  });

  test("a bare ```bash fence is not by itself a shell command", () => {
    // The fence is formatting. Eight of the 43 skills on this machine open a fence and never put a
    // command after it, and treating the fence as an execution request would misreport them.
    const finding = judge("Example:\n\n```bash\n# your shell here\n```\n");
    expect(finding.level).toBe("full");
  });

  test("a command on the line after a fence is reported with the command line, not the fence", () => {
    const finding = judge("Steps:\n\n```bash\nnode scripts/build.js --all\n```\n");
    expect(finding.level).toBe("blocked");
    const samples = finding.hits.map((hit) => hit.sample);
    expect(samples).toContain("node scripts/build.js --all");
    expect(samples).not.toContain("```bash");
  });

  test("a reference to a file under scripts/ blocks the capability", () => {
    const finding = judge("调用 scripts/collect.py 得到结果");
    expect(finding.level).toBe("blocked");
    expect(finding.hits.map((hit) => hit.ruleId)).toContain("executable-scripts");
  });

  test("a word that merely ends in scripts is not a scripts/ reference", () => {
    expect(judge("See subscripts/x.md for details.").level).toBe("full");
  });

  test("an mcp__server__tool reference to a server that does not ship blocks the capability", () => {
    const finding = judge("Call mcp__linear__create_issue with the title.");
    expect(finding.level).toBe("blocked");
    expect(finding.hits[0].sample).toBe("mcp__linear__create_issue");
  });

  test("the same reference is fine once the server is in connectors.yaml", () => {
    const connectors: ReadonlySet<string> = new Set(["linear"]);
    const finding = auditCapability(
      { slug: "demo", instructions: "Call mcp__linear__create_issue with the title.", hasBundledReferences: false },
      connectors,
    );
    expect(finding.level).toBe("full");
  });
});

describe("degraded rules", () => {
  test("file-tool calls degrade the capability", () => {
    for (const call of ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch"]) {
      const finding = judge(`First, ${call}(path) then continue.`);
      expect(finding.level).toBe("degraded");
      expect(finding.hits.map((hit) => hit.ruleId)).toContain("file-tool-call");
    }
  });

  test("a Task(...) subagent call degrades the capability", () => {
    const finding = judge("Dispatch with Task(reviewer).");
    expect(finding.level).toBe("degraded");
    expect(finding.hits.map((hit) => hit.ruleId)).toContain("subagent-task");
  });

  test("a references/ mention degrades only when the files are not shipped", () => {
    expect(judge("Read references/deep-dive.md").level).toBe("degraded");
    expect(judge("Read references/deep-dive.md", true).level).toBe("full");
  });

  test("prose that happens to contain a tool name without a call is not a hit", () => {
    expect(judge("Ask the user to Read the file themselves.").level).toBe("full");
  });
});

describe("verdict aggregation", () => {
  test("the worst rule wins regardless of order", () => {
    const mixed = judge("Read(config) first, then Bash(make all).");
    expect(mixed.level).toBe("blocked");
    const ids = mixed.hits.map((hit) => hit.ruleId);
    expect(ids).toContain("file-tool-call");
    expect(ids).toContain("bash-call");
  });

  test("hits are ordered worst first", () => {
    const finding = judge("Read(a) then Bash(b)");
    const levels = finding.hits.map((hit) => hit.level);
    expect(levels).toEqual([...levels].sort((a, b) => SEVERITY_ORDER[b] - SEVERITY_ORDER[a]));
  });

  test("a body with no rule hits is full and carries no hits", () => {
    const finding = judge("Explain the trade-off and ask one clarifying question.");
    expect(finding).toEqual({ slug: "demo", level: "full", hits: [] });
  });

  test("repeated identical matches are reported once", () => {
    const finding = judge("Run Bash(a). Then run Bash(a) again.");
    expect(finding.hits.filter((hit) => hit.ruleId === "bash-call")).toHaveLength(1);
  });

  test("auditCapabilities preserves input order and countByLevel sums the levels", () => {
    const findings = auditCapabilities(
      [
        { slug: "one", instructions: "Just talk.", hasBundledReferences: false },
        { slug: "two", instructions: "Read(x)", hasBundledReferences: false },
        { slug: "three", instructions: "Bash(y)", hasBundledReferences: false },
      ],
      NO_CONNECTORS,
    );
    expect(findings.map((finding) => finding.slug)).toEqual(["one", "two", "three"]);
    expect(countByLevel(findings)).toEqual({ full: 1, degraded: 1, blocked: 1 });
  });
});

describe("shortenSample", () => {
  test("collapses whitespace, drops table-breaking pipes, and cuts at 60 characters", () => {
    expect(shortenSample("a\n  b\tc")).toBe("a b c");
    expect(shortenSample("a|b")).toBe("a/b");
    const long = shortenSample("x".repeat(200));
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
  });
});
