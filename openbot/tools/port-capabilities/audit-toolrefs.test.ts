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
import { AUDIT_RULE_TABLE, auditRule, auditRulesSha256, SEVERITY_ORDER } from "./mapping";
import { sanitizeLocalUserPaths } from "./normalize";

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
    expect(auditRule("shell-tool-call").pattern).toBeDefined();
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
    expect(finding.hits.map((hit) => hit.ruleId)).toContain("shell-tool-call");
  });

  test("a shell command line blocks the capability", () => {
    expect(judge("先执行 bash scripts/collect.sh 收集数据").level).toBe("blocked");
    expect(judge("run python3 tools/report.py first").level).toBe("blocked");
    expect(judge("then node build.mjs").level).toBe("blocked");
  });

  test("a heredoc blocks with or without the leading dash", () => {
    // The dash is not what makes it a heredoc: `python - <<'EOF'` and `python3 <<'EOF'` both feed stdin.
    // An earlier version of this rule only caught the first, so the second ran as "full".
    for (const body of ["python - <<'EOF'", "python3 <<'EOF'", "sh <<-END"]) {
      expect(judge(body).level).toBe("blocked");
    }
  });

  test("a flag, a path-shaped argument and a shell operator each suffice on their own", () => {
    // One case per feature of rule B, so a future loosening has to break a named test.
    expect(judge("run node --version").level).toBe("blocked"); // flag
    expect(judge("python run.py").level).toBe("blocked"); // file-shaped argument
    expect(judge("bash <<< x | grep y && echo done").level).toBe("blocked"); // operator
    expect(judge("bash -c 'ls'").level).toBe("blocked"); // flag with a quoted body
  });

  test("a command word alone is not a dependency: prohibitions and prose stay full", () => {
    // The false positive that cost a real agent its verdict: "Do NOT run bash commands" is a prohibition,
    // and `\w` used to accept `c` as its argument. `node junction` and `Bash (shell)` are the other two.
    expect(judge("Do NOT run bash commands to create directories").level).toBe("full");
    expect(judge("### 3. 接上 node_modules —— 用 node junction，不要用 mklink").level).toBe("full");
    expect(judge("不要直接执行 python 脚本，先读文档").level).toBe("full");
  });

  test("an unambiguous command name counts, an English word that happens to be one does not", () => {
    // The P1 widening of the word list. `git bundle create` is the real dependency of the git-repair
    // skill and used to be reachable only through a nearby sentence about it.
    expect(judge("git bundle create backup.bundle --all").level).toBe("blocked");
    expect(judge("所以用 docker build -t img . 重打包").level).toBe("blocked");
    // `make`, `go` and `run` were kept out of the list for exactly these two sentences.
    expect(judge("make sure to check /path before you start").level).toBe("full");
    expect(judge("go to C:/Users/x and open it").level).toBe("full");
  });

  test("a redirect does not reach across a line break", () => {
    // `\s` includes `\n`, so `>\s*\S` read the `>` that closes a prose placeholder as a redirect onto the
    // first word of the *next* line. This exact two-line shape blocked a real agent (`Branch: <git branch>`).
    expect(judge("Branch: <git branch>\nResult: ok").level).toBe("full");
    expect(judge("Branch: <git branch>").level).toBe("full");
    // A redirect on one line still counts.
    expect(judge("node build.js > out.txt").level).toBe("blocked");
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
    expect(ids).toContain("shell-tool-call");
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
    expect(finding.hits.filter((hit) => hit.ruleId === "shell-tool-call")).toHaveLength(1);
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

describe("audit_rules_sha256", () => {
  test("is stable across calls and independent of the rule array's order", () => {
    // Reordering the table is a semantically empty edit; if it moved the hash, every unrelated commit
    // would look like a rule change.
    const reversed = [...AUDIT_RULE_TABLE].reverse();
    expect(auditRulesSha256(reversed)).toBe(auditRulesSha256());
    expect(auditRulesSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when a severity rank changes, because that rewrites every verdict", () => {
    // The one order-sensitive input. If this could not be detected, the hash would report "same rules"
    // while all 89 `runnable` values flipped.
    const flipped = { ...SEVERITY_ORDER, full: SEVERITY_ORDER.blocked, blocked: SEVERITY_ORDER.full };
    expect(auditRulesSha256(undefined, flipped)).not.toBe(auditRulesSha256());
  });

  test("changes when a rule's pattern or level changes", () => {
    const retuned = AUDIT_RULE_TABLE.map((rule) =>
      rule.id === "shell-command-prose" ? { ...rule, level: "degraded" as const } : rule,
    );
    expect(auditRulesSha256(retuned)).not.toBe(auditRulesSha256());
  });
});

describe("redaction does not change what the audit decides", () => {
  // The port redacts the author's home directory before writing `instructions`, and the audit runs over
  // the same text. This pins the property QA measured over the whole corpus: replacing a path segment with
  // `<user>` must never move a verdict, otherwise a "clean" row could be clean only because it was cleaned.
  const bodies = [
    "run bash scripts/x.sh under C:/Users/alice/proj",
    "Bash(npm install) then Write(C:/Users/alice/a.json)",
    "python - <<'EOF' from /c/Users/alice/x",
    "no command here, just C:\\Users\\alice\\notes.txt",
  ];

  for (const body of bodies) {
    test(`level is unchanged for: ${body.slice(0, 34)}`, () => {
      const redacted = sanitizeLocalUserPaths(body);
      expect(redacted.hits).toBeGreaterThan(0);
      const before = auditCapability({ slug: "x", instructions: body, hasBundledReferences: false }, NO_CONNECTORS);
      const after = auditCapability({ slug: "x", instructions: redacted.text, hasBundledReferences: false }, NO_CONNECTORS);
      expect(after.level).toBe(before.level);
      expect(after.hits.map((hit) => hit.ruleId)).toEqual(before.hits.map((hit) => hit.ruleId));
    });
  }

  test("the `<user>` placeholder we emit is not a shell redirect", () => {
    // Regression: `<user>` closes with `>`, which the prose rule read as `> file`. A body could therefore
    // gain a hit only because the port redacted it — the verdict would be caused by our own output.
    const findings = judge("Write(C:/Users/<user>/a.json)");
    expect(findings.hits.some((hit) => hit.ruleId === "shell-command-prose")).toBe(false);
    expect(findings.level).toBe(judge("Write(C:/Users/alice/a.json)").level);
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

describe("excerptAt", () => {
  test("starts at the match, so the cell shows the substring that tripped the rule", () => {
    // The reviewer needs to see the command as the first thing in the cell, not hunt for it 40 characters
    // into a truncated line.
    const finding = judge("然后 `node scripts/build.js --all` 生成产物");
    const hit = finding.hits.find((item) => item.ruleId === "shell-command-prose");
    expect(hit?.sample.startsWith("node scripts/build.js --all")).toBe(true);
  });

  test("keeps a real command recognisable, heredoc included", () => {
    const finding = judge("python - <<'EOF'");
    expect(finding.hits[0].sample).toBe("python - <<'EOF'");
  });
});
