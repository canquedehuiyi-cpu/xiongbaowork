import { describe, expect, test } from "bun:test";
import { auditCapabilities } from "./audit-toolrefs";
import {
  ENVIRONMENT_FACTS_HEADING,
  UNMAPPED_TOOL_NAMES,
  rewriteInstructions,
} from "./rewrite-toolrefs";

const connectorIds = new Set<string>(["docs"]);

/** Audit one body through the same path the emitters use. */
function auditOne(slug: string, instructions: string) {
  return auditCapabilities(
    [{ slug, instructions, hasBundledReferences: true }],
    connectorIds,
  )[0].level;
}

describe("rewriteInstructions", () => {
  test("a blocked body keeps its verdict: the shell calls survive verbatim", () => {
    const body = [
      "# Deploy guide",
      "",
      "```bash",
      "python3 run.py --selftest",
      "```",
      "",
      "Run `Bash(npm install)` first.",
    ].join("\n");
    const result = rewriteInstructions(
      { slug: "deploy", instructions: body },
      "blocked",
    );
    expect(result.level).toBe("blocked");
    expect(result.changed).toBe(true);
    // 环境事实段在正文里，原 shell 调用原样保留（降级说明，不是抹除）
    expect(result.instructions).toContain("python3 run.py --selftest");
    expect(result.instructions).toContain("Bash(npm install)");
    expect(result.instructions).toContain(ENVIRONMENT_FACTS_HEADING);
    // 重审计档位不变：插入散文不构成括号形态，也不构成命令词 + shell 特征
    expect(auditOne("deploy", result.instructions)).toBe("blocked");
    expect(result.rewrittenToolCalls).toBe(0);
  });

  test("mapped file-tool calls are rewritten and the verdict rises to full", () => {
    const body = [
      "# Docs fetcher",
      "",
      'Read("references/api.md") and then Write("out/summary.md").',
      "",
      "Edit the draft with MultiEdit(...) before shipping.",
    ].join("\n");
    const result = rewriteInstructions(
      { slug: "docs-fetcher", instructions: body },
      "degraded",
    );
    expect(result.level).toBe("degraded");
    // Read + Write + MultiEdit 三处括号形态；"Edit the draft" 是散文不带括号，不命中
    expect(result.rewrittenToolCalls).toBe(3);
    expect(result.instructions).toContain(
      'computer_read_file("references/api.md")',
    );
    expect(result.instructions).toContain(
      'computer_write_file("out/summary.md")',
    );
    expect(result.instructions).toContain(
      "computer_write_file(...) before shipping",
    );
    // 改写完成后 file-tool-call 规则不再命中 → 审计升 full（改写层完成度的标志位）
    expect(auditOne("docs-fetcher", result.instructions)).toBe("full");
  });

  test("unmapped tools (Task/Glob/Grep/WebFetch) stay and keep the verdict degraded", () => {
    const body = [
      "# Research helper",
      "",
      'Read("notes.md") first.',
      "",
      "Then Task(subagent, explore the repo) and Glob(**/*.ts).",
    ].join("\n");
    const result = rewriteInstructions(
      { slug: "research", instructions: body },
      "degraded",
    );
    expect(result.rewrittenToolCalls).toBe(1);
    expect(result.instructions).toContain('computer_read_file("notes.md")');
    expect(result.instructions).toContain("Task(subagent, explore the repo)");
    expect(result.instructions).toContain("Glob(**/*.ts)");
    expect(result.unmappedMentioned.sort()).toEqual(["Glob", "Task"]);
    expect(auditOne("research", result.instructions)).toBe("degraded");
  });

  test("a full body is returned untouched", () => {
    const body = "# Greeting\n\nSay hello to the user.\n";
    const result = rewriteInstructions(
      { slug: "greeting", instructions: body },
      "full",
    );
    expect(result.changed).toBe(false);
    expect(result.instructions).toBe(body);
  });

  test("rewriting is idempotent: a second pass changes nothing", () => {
    const body = [
      "# Docs fetcher",
      "",
      'Read("references/api.md") and then Write("out/summary.md").',
    ].join("\n");
    const once = rewriteInstructions(
      { slug: "docs-fetcher", instructions: body },
      "degraded",
    );
    const twice = rewriteInstructions(
      { slug: "docs-fetcher", instructions: once.instructions },
      "degraded",
    );
    expect(twice.changed).toBe(false);
    expect(twice.instructions).toBe(once.instructions);
  });

  test("the facts block names every unmapped tool the body still mentions", () => {
    const body = "# Helper\n\nWebFetch(url) when you need the page.\n";
    const result = rewriteInstructions(
      { slug: "helper", instructions: body },
      "degraded",
    );
    expect(result.instructions).toContain("WebFetch");
    for (const name of UNMAPPED_TOOL_NAMES) {
      expect(result.instructions).toContain(name);
    }
  });
});
